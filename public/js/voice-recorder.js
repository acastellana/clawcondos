/**
 * ClawCondos Voice Recorder (in-browser)
 * 
 * Uses MediaRecorder + getUserMedia.
 * Output format: audio/webm;codecs=opus (preferred), falls back to audio/webm.
 * 
 * Integration:
 * - Adds recorded audio as a File into MediaUpload.addFile()
 * - UI: toggled mic button + timer + optional level meter
 */

const VoiceRecorder = (() => {
  const CONFIG = {
    preferredMimeTypes: [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg'
    ],
    maxDurationMs: 5 * 60 * 1000, // 5 minutes safety
  };

  let mediaStream = null;
  let mediaRecorder = null;
  let chunks = [];
  let startedAt = 0;
  let timerInterval = null;
  let autoStopTimeout = null;

  // Meter
  let audioContext = null;
  let analyser = null;
  let meterRaf = null;

  function $(id) {
    return document.getElementById(id);
  }

  // Support multiple composers via mount({ btnId, timerId, hintId?, meterId? }).
  // Only one recording can run at a time, so we track the *active* mount per recording.
  const mounts = new Map(); // btnId -> mount config
  let activeMount = null; // { btnId, timerId, hintId, meterId, meterLevelId }

  function pickMimeType() {
    if (!window.MediaRecorder) return null;
    for (const t of CONFIG.preferredMimeTypes) {
      try {
        if (MediaRecorder.isTypeSupported(t)) return t;
      } catch {}
    }
    return '';
  }

  function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function el(id) {
    return activeMount?.[id] ? $(activeMount[id]) : $(id);
  }

  function setUIRecording(isRecording) {
    const btn = el('btnId') || $('voiceRecordBtn');
    const timer = el('timerId') || $('voiceTimer');
    const hint = el('hintId') || $('voiceHint');
    const meter = el('meterId') || $('voiceMeter');

    if (btn) {
      btn.classList.toggle('recording', isRecording);
      btn.setAttribute('aria-pressed', isRecording ? 'true' : 'false');
      btn.title = isRecording ? 'Stop recording' : 'Record voice';
    }

    if (timer) {
      timer.classList.toggle('visible', isRecording);
    }

    if (meter) {
      meter.classList.toggle('visible', isRecording);
    }

    if (hint) {
      hint.classList.toggle('visible', isRecording);
    }
  }

  function showError(message) {
    if (window.showNotification) {
      window.showNotification(message, 'error');
    } else {
      console.error('[VoiceRecorder]', message);
    }
  }

  function updateTimer() {
    const timer = el('timerId') || $('voiceTimer');
    if (!timer) return;
    const elapsed = Date.now() - startedAt;
    timer.textContent = formatTime(elapsed);
  }

  async function ensureStream() {
    if (mediaStream) return mediaStream;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Audio recording not supported in this browser');
    }

    // Note: requires HTTPS (or localhost). Tailscale HTTPS is fine.
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
    });

    return mediaStream;
  }

  function startMeter(stream) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        if (!analyser) return;
        analyser.getByteTimeDomainData(data);

        // crude RMS
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        const level = Math.min(1, rms * 2.2);

        const meter = (activeMount?.meterLevelId ? $(activeMount.meterLevelId) : $('voiceMeterLevel'));
        if (meter) meter.style.width = `${Math.round(level * 100)}%`;

        meterRaf = requestAnimationFrame(tick);
      };

      tick();
    } catch {
      // meter is optional
    }
  }

  async function start() {
    if (mediaRecorder?.state === 'recording') return;
    if (!activeMount) {
      // Fallback: if start() was called programmatically without a mount click,
      // default UI bindings to the primary composer.
      activeMount = { btnId: 'voiceRecordBtn', timerId: 'voiceTimer', hintId: 'voiceHint', meterId: 'voiceMeter', meterLevelId: 'voiceMeterLevel' };
    }

    const stream = await ensureStream();
    const mimeType = pickMimeType();

    chunks = [];
    startedAt = Date.now();

    try {
      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (err) {
      throw new Error(`Failed to start recorder: ${err.message || err}`);
    }

    mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });

    mediaRecorder.addEventListener('stop', () => {
      cleanupAfterStop();
    });

    mediaRecorder.addEventListener('error', (e) => {
      showError(e.error?.message || 'Recorder error');
    });

    // Start
    mediaRecorder.start(250); // request chunks every 250ms

    setUIRecording(true);
    updateTimer();
    timerInterval = setInterval(updateTimer, 200);

    autoStopTimeout = setTimeout(() => {
      stop();
    }, CONFIG.maxDurationMs);

    startMeter(stream);
  }

  function cleanupAfterStop() {
    setUIRecording(false);

    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }

    if (autoStopTimeout) {
      clearTimeout(autoStopTimeout);
      autoStopTimeout = null;
    }

    if (meterRaf) {
      cancelAnimationFrame(meterRaf);
      meterRaf = null;
    }

    if (audioContext) {
      try { audioContext.close(); } catch {}
      audioContext = null;
      analyser = null;
    }

    const meter = (activeMount?.meterLevelId ? $(activeMount.meterLevelId) : $('voiceMeterLevel'));
    if (meter) meter.style.width = '0%';

    // Convert chunks to file and add to MediaUpload
    if (!chunks.length) {
      showError('Recording produced no audio');
      return;
    }

    const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
    const ext = (blob.type.includes('ogg') ? 'ogg' : 'webm');
    const filename = `voice-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;

    const file = new File([blob], filename, { type: blob.type });

    if (typeof MediaUpload !== 'undefined' && MediaUpload.addFile) {
      MediaUpload.addFile(file);
    } else {
      showError('MediaUpload module not available');
    }

    chunks = [];

    // Reset active mount after each recording so the next click sets it explicitly.
    activeMount = null;
  }

  function stop() {
    if (!mediaRecorder) return;
    if (mediaRecorder.state !== 'recording') return;

    try {
      mediaRecorder.stop();
    } catch (err) {
      showError(err.message || 'Failed to stop recording');
      cleanupAfterStop();
    }
  }

  async function toggle() {
    try {
      if (mediaRecorder?.state === 'recording') {
        stop();
      } else {
        await start();
      }
    } catch (err) {
      showError(err.message || String(err));
      setUIRecording(false);
    }
  }

  function destroyStream() {
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) {
        try { track.stop(); } catch {}
      }
      mediaStream = null;
    }
  }

  function mount(opts = {}) {
    const cfg = {
      btnId: opts.btnId || 'voiceRecordBtn',
      timerId: opts.timerId || 'voiceTimer',
      hintId: opts.hintId || 'voiceHint',
      meterId: opts.meterId || 'voiceMeter',
      meterLevelId: opts.meterLevelId || 'voiceMeterLevel',
    };

    const btn = $(cfg.btnId);
    if (!btn) return;

    // avoid double-binding
    if (btn.dataset.voiceBound) {
      mounts.set(cfg.btnId, cfg);
      return;
    }
    btn.dataset.voiceBound = '1';

    mounts.set(cfg.btnId, cfg);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      // Make this composer the active UI target for the duration of this recording.
      activeMount = cfg;
      toggle();
    });

    console.log('[VoiceRecorder] Mounted', cfg);
  }

  function init() {
    // default mount for the primary chat composer
    mount({ btnId: 'voiceRecordBtn', timerId: 'voiceTimer' });

    // Safety: stop recording when changing session
    if (window.state && typeof window.selectSession === 'function') {
      // no reliable hook; leave as-is
    }

    // Stop when page is hidden
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && mediaRecorder?.state === 'recording') {
        stop();
      }
    });

    window.addEventListener('beforeunload', () => {
      try { stop(); } catch {}
      destroyStream();
    });

    console.log('[VoiceRecorder] Initialized');
  }

  return {
    init,
    mount,
    start,
    stop,
    toggle,
    destroyStream,
  };
})();

// Expose on window (top-level const isn't attached to window in modern browsers)
try { window.VoiceRecorder = VoiceRecorder; } catch {}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => VoiceRecorder.init());
} else {
  VoiceRecorder.init();
}
