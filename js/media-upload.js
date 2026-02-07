/**
 * ClawCondos Media Upload Module
 * Handles image and audio uploads for chat
 *
 * Architecture:
 * - MediaUploader: Core upload logic
 * - MediaPreview: UI for showing pending attachments
 * - Integrates with chat input via events
 */

const MediaUpload = (() => {
  // ═══════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════
  const CONFIG = {
    uploadEndpoint: '/media-upload/upload',
    maxFileSize: 20 * 1024 * 1024, // 20MB (matches server)
    maxFiles: 5,
    allowedTypes: {
      image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
      audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4']
    }
  };

  // ═══════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════
  let pendingFiles = []; // { id, file, previewUrl, status: 'pending'|'uploading'|'done'|'error', uploadedUrl, progress }
  let dropOverlayVisible = false;

  // ═══════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  }

  function generateId() {
    return `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function getFileType(mimeType, fileName = '') {
    // Some browser APIs (MediaRecorder) include codec params in the mime type,
    // e.g. "audio/webm;codecs=opus". Normalize before matching.
    const baseMime = String(mimeType || '').split(';')[0].trim();

    if (baseMime && CONFIG.allowedTypes.image.includes(baseMime)) return 'image';
    if (baseMime && CONFIG.allowedTypes.audio.includes(baseMime)) return 'audio';

    // Some clipboard pastes (esp. screenshots) yield a File with empty type.
    // Fall back to extension sniffing.
    const lower = String(fileName || '').toLowerCase();
    if (lower.match(/\.(png|jpg|jpeg|gif|webp)$/)) return 'image';
    if (lower.match(/\.(mp3|wav|ogg|webm|m4a|mp4)$/)) return 'audio';

    return null;
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function validateFile(file) {
    const fileType = getFileType(file.type, file.name);
    if (!fileType) {
      return { valid: false, error: `Unsupported file type: ${file.type || file.name || 'unknown'}` };
    }
    if (file.size > CONFIG.maxFileSize) {
      return { valid: false, error: `File too large: ${formatFileSize(file.size)} (max ${formatFileSize(CONFIG.maxFileSize)})` };
    }
    if (pendingFiles.length >= CONFIG.maxFiles) {
      return { valid: false, error: `Maximum ${CONFIG.maxFiles} files allowed` };
    }
    return { valid: true, fileType };
  }

  // ═══════════════════════════════════════════════════════════════
  // FILE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  function addFile(file) {
    const validation = validateFile(file);
    if (!validation.valid) {
      showError(validation.error);
      return null;
    }

    const id = generateId();
    const previewUrl = validation.fileType === 'image' ? URL.createObjectURL(file) : null;

    const fileEntry = {
      id,
      file,
      fileType: validation.fileType,
      previewUrl,
      status: 'pending',
      uploadedUrl: null,
      progress: 0
    };

    pendingFiles.push(fileEntry);
    renderPreview();
    emit('filesChanged', { files: pendingFiles });

    return fileEntry;
  }

  // Back-compat: older callers expect addFiles([...])
  function addFiles(files = []) {
    const out = [];
    for (const f of (files || [])) {
      const entry = addFile(f);
      if (entry) out.push(entry);
    }
    return out;
  }

  function removeFile(id) {
    const idx = pendingFiles.findIndex(f => f.id === id);
    if (idx !== -1) {
      const file = pendingFiles[idx];
      if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
      pendingFiles.splice(idx, 1);
      renderPreview();
      emit('filesChanged', { files: pendingFiles });
    }
  }

  function clearFiles() {
    pendingFiles.forEach(f => {
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    });
    pendingFiles = [];
    renderPreview();
    emit('filesChanged', { files: pendingFiles });
  }

  function hasPendingFiles() {
    return pendingFiles.length > 0;
  }

  function getPendingFiles() {
    return [...pendingFiles];
  }

  // ═══════════════════════════════════════════════════════════════
  // UPLOAD
  // ═══════════════════════════════════════════════════════════════
  async function uploadFile(fileEntry, sessionKey) {
    fileEntry.status = 'uploading';
    fileEntry.progress = 0;
    renderPreview();

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();

      formData.append('file', fileEntry.file);
      formData.append('sessionKey', sessionKey || 'unknown');

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          fileEntry.progress = Math.round((e.loaded / e.total) * 100);
          renderPreview();
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const response = JSON.parse(xhr.responseText);
            if (response.ok) {
              fileEntry.status = 'done';
              fileEntry.uploadedUrl = response.url;
              fileEntry.progress = 100;
              renderPreview();
              resolve(response);
            } else {
              throw new Error(response.error || 'Upload failed');
            }
          } catch (e) {
            fileEntry.status = 'error';
            renderPreview();
            reject(new Error('Invalid server response'));
          }
        } else {
          fileEntry.status = 'error';
          renderPreview();
          reject(new Error(`Upload failed: ${xhr.status}`));
        }
      });

      xhr.addEventListener('error', () => {
        fileEntry.status = 'error';
        renderPreview();
        reject(new Error('Network error'));
      });

      xhr.open('POST', CONFIG.uploadEndpoint);
      xhr.send(formData);
    });
  }

  // Convert ArrayBuffer/Uint8Array to base64 (browser-safe)
  function bytesToBase64(bytes) {
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    return bytesToBase64(new Uint8Array(buf));
  }

  /**
   * Build OpenClaw-native chat.send attachments.
   * Returns: [{ mimeType, fileName, content: <base64> }]
   */
  async function buildGatewayAttachments() {
    const out = [];
    for (const f of pendingFiles) {
      if (f.status !== 'pending') continue;
      try {
        const b64 = await fileToBase64(f.file);
        out.push({
          type: f.fileType,
          mimeType: f.file.type,
          fileName: f.file.name,
          content: b64,
        });
      } catch (err) {
        f.status = 'error';
        renderPreview();
        throw err;
      }
    }
    return out;
  }

  // Legacy upload methods kept for now but unused
  async function uploadAllPending(sessionKey) {
    const toUpload = pendingFiles.filter(f => f.status === 'pending');
    const results = [];

    for (const fileEntry of toUpload) {
      try {
        const result = await uploadFile(fileEntry, sessionKey);
        results.push({ id: fileEntry.id, success: true, ...result });
      } catch (err) {
        results.push({ id: fileEntry.id, success: false, error: err.message });
      }
    }

    return results;
  }

  function getUploadedUrls() {
    return pendingFiles
      .filter(f => f.status === 'done' && f.uploadedUrl)
      .map(f => ({
        url: f.uploadedUrl,
        type: f.fileType,
        name: f.file.name
      }));
  }

  // ═══════════════════════════════════════════════════════════════
  // UI RENDERING
  // ═══════════════════════════════════════════════════════════════
  // Multiple mounts can render the same pendingFiles into different preview containers.
  const mounts = []; // { viewEl, inputEl, fileInputEl, previewEl, dropOverlayEl, dropVisible }

  function renderPreview() {
    for (const m of mounts) {
      const container = m.previewEl;
      if (!container) continue;

      if (pendingFiles.length === 0) {
        container.innerHTML = '';
        continue;
      }

      container.innerHTML = pendingFiles.map(f => {
        const isImage = f.fileType === 'image';
        const statusClass = f.status;
        const progressBar = f.status === 'uploading'
          ? `<div class="media-progress"><div class="media-progress-bar" style="width: ${f.progress}%"></div></div>`
          : '';

        if (isImage && f.previewUrl) {
          return `
            <div class="media-preview-item ${statusClass}" data-id="${f.id}">
              <img src="${f.previewUrl}" alt="${escapeHtml(f.file.name)}">
              <button class="media-remove-btn" onclick="MediaUpload.removeFile('${f.id}')" title="Remove">×</button>
              ${progressBar}
              ${f.status === 'error' ? '<div class="media-error">!</div>' : ''}
            </div>
          `;
        }

        const icon = f.fileType === 'audio' ? '🎵' : '📎';
        return `
          <div class="media-preview-item audio ${statusClass}" data-id="${f.id}">
            <div class="media-audio-icon">${icon}</div>
            <div class="media-audio-name">${escapeHtml(f.file.name)}</div>
            <button class="media-remove-btn" onclick="MediaUpload.removeFile('${f.id}')" title="Remove">×</button>
            ${progressBar}
            ${f.status === 'error' ? '<div class="media-error">!</div>' : ''}
          </div>
        `;
      }).join('');
    }
  }

  function showDropOverlay(overlayEl, show) {
    if (overlayEl) overlayEl.classList.toggle('visible', show);
  }

  function showError(message) {
    // Use existing notification system or console
    if (window.showNotification) {
      window.showNotification(message, 'error');
    } else {
      console.error('[MediaUpload]', message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENT HANDLERS
  // ═══════════════════════════════════════════════════════════════
  function handleFileSelect(event) {
    const files = event.target.files;
    if (!files) return;

    for (const file of files) {
      addFile(file);
    }

    // Reset input so same file can be selected again
    event.target.value = '';
  }

  function mount({ viewId, inputId, fileInputId, previewContainerId, dropOverlayId }) {
    const viewEl = document.getElementById(viewId);
    const inputEl = document.getElementById(inputId);
    const fileInputEl = document.getElementById(fileInputId);
    const previewEl = document.getElementById(previewContainerId);
    const dropOverlayEl = document.getElementById(dropOverlayId);

    if (!viewEl || !inputEl || !fileInputEl || !previewEl || !dropOverlayEl) {
      console.warn('[MediaUpload] mount missing elements', { viewId, inputId, fileInputId, previewContainerId, dropOverlayId });
      return false;
    }

    // dedupe
    if (mounts.find(m => m.viewEl === viewEl && m.inputEl === inputEl)) {
      renderPreview();
      return true;
    }

    const m = { viewEl, inputEl, fileInputEl, previewEl, dropOverlayEl };
    mounts.push(m);

    // drag & drop
    viewEl.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showDropOverlay(dropOverlayEl, true);
    });

    viewEl.addEventListener('dragleave', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX;
      const y = event.clientY;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        showDropOverlay(dropOverlayEl, false);
      }
    });

    viewEl.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showDropOverlay(dropOverlayEl, false);
      const files = event.dataTransfer?.files;
      if (!files) return;
      for (const file of files) addFile(file);
    });

    // paste
    inputEl.addEventListener('paste', handlePaste);

    // file input
    fileInputEl.addEventListener('change', handleFileSelect);

    renderPreview();
    return true;
  }

  function handlePaste(event) {
    const items = event.clipboardData?.items;
    if (!items) return;

    let attached = false;

    for (const item of items) {
      if (item.kind !== 'file') continue;

      const file = item.getAsFile();
      if (!file) continue;

      const mime = (item.type || file.type || '').trim();
      const nameGuess = (file.name || (mime.startsWith('image/') ? 'clipboard.png' : (mime.startsWith('audio/') ? 'clipboard.webm' : ''))).trim();

      // Some browsers provide a File with empty type/name for clipboard images.
      // Re-wrap it into a new File with a sensible name/type so validation succeeds.
      let fixedFile = file;
      if ((!file.type && mime) || (!file.name && nameGuess)) {
        try {
          fixedFile = new File([file], nameGuess || file.name || 'clipboard', { type: mime || file.type || '' });
        } catch {
          // ignore; fallback to original file
        }
      }

      if (getFileType(fixedFile.type, fixedFile.name)) {
        const entry = addFile(fixedFile);
        if (entry) attached = true;
      }
    }

    // If we attached at least one file from clipboard, prevent the default paste into textarea.
    if (attached) event.preventDefault();
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENT EMITTER
  // ═══════════════════════════════════════════════════════════════
  const listeners = {};

  function on(event, callback) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(callback);
  }

  function off(event, callback) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter(cb => cb !== callback);
  }

  function emit(event, data) {
    if (!listeners[event]) return;
    listeners[event].forEach(cb => cb(data));
  }

  // ═══════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════
  function init() {
    // Default mount for main chat composer.
    // The composer is mounted dynamically, so these elements may not exist at DOMContentLoaded.
    // Retry a few times until the app mounts the composer.
    let attempts = 0;
    const maxAttempts = 30; // ~3s @ 100ms

    const tryMount = () => {
      attempts++;
      const ok = mount({
        viewId: 'chatView',
        inputId: 'chatInput',
        fileInputId: 'mediaFileInput',
        previewContainerId: 'mediaPreviewContainer',
        dropOverlayId: 'dropOverlay',
      });
      if (ok) return;
      if (attempts < maxAttempts) setTimeout(tryMount, 100);
    };

    tryMount();
    console.log('[MediaUpload] Initialized');
  }

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════
  return {
    init,
    addFile,
    addFiles,
    removeFile,
    clearFiles,
    hasPendingFiles,
    getPendingFiles,
    buildGatewayAttachments,
    uploadAllPending,
    getUploadedUrls,
    showDropOverlay,
    mount,
    on,
    off,
    // Expose config for debugging
    get config() { return { ...CONFIG }; }
  };
})();

// Expose on window (top-level const isn't attached to window in modern browsers)
try { window.MediaUpload = MediaUpload; } catch {}

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => MediaUpload.init());
} else {
  MediaUpload.init();
}
