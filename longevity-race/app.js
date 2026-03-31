/* ==========================================================================
   THE LONGEVITY RACE — APP.JS
   API-driven version with live recalculation
   ========================================================================== */

// Global state
let compounds = [];
let failedCompounds = [];
let pipelineCompounds = [];
let effectChartInstance = null;
let translationChartInstance = null;

// ============================================================================
// INITIALIZE — load from API
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  initRecalcButton();
  initScrollAnimations();
});

async function loadData() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    applyData(data);
  } catch (e) {
    console.error('Failed to load data:', e);
    showToast('Failed to load data: ' + e.message, 'error');
  }
}

function applyData(data) {
  compounds = data.compounds || [];
  failedCompounds = data.failedCompounds || [];
  pipelineCompounds = data.pipelineCompounds || [];

  // Update last-updated indicator
  if (data.lastUpdated) {
    const d = new Date(data.lastUpdated);
    const formatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    document.getElementById('statusText').textContent = 'UPDATED ' + formatted.toUpperCase();
  }

  renderScoreboard(compounds);

  // Re-render pipeline (clear first)
  const pipelineGrid = document.getElementById('pipelineGrid');
  if (pipelineGrid) pipelineGrid.innerHTML = '';
  renderPipeline();

  // Re-render failed (clear first)
  const failedGrid = document.getElementById('failedGrid');
  if (failedGrid) failedGrid.innerHTML = '';
  renderFailed();

  // Destroy and re-init charts
  if (effectChartInstance) { effectChartInstance.destroy(); effectChartInstance = null; }
  if (translationChartInstance) { translationChartInstance.destroy(); translationChartInstance = null; }
  initEffectChart();
  initTranslationChart();

  initSearch();
  initFilters();
  initSorting();
  initFailedToggle();
  animateMetrics();
}

// ============================================================================
// RECALCULATE BUTTON
// ============================================================================

function initRecalcButton() {
  const btn = document.getElementById('recalcBtn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;

    btn.disabled = true;
    btn.classList.add('spinning');
    document.getElementById('recalcLabel').textContent = 'Recalculating...';
    document.getElementById('statusText').textContent = 'UPDATING...';

    try {
      const res = await fetch('/api/recalculate', { method: 'POST' });
      const result = await res.json();

      if (!res.ok) throw new Error(result.error || 'HTTP ' + res.status);

      applyData(result.data);

      const trialN = result.trialChanges?.length || 0;
      const scoreN = result.scoreChanges?.length || 0;
      showToast(`✓ Updated — ${trialN} trial changes, ${scoreN} score changes`, 'success');
    } catch (e) {
      console.error('Recalculate error:', e);
      showToast('Recalculation failed: ' + e.message, 'error');
      document.getElementById('statusText').textContent = 'UPDATE FAILED';
    } finally {
      btn.disabled = false;
      btn.classList.remove('spinning');
      document.getElementById('recalcLabel').textContent = 'Recalculate';
    }
  });
}

// ============================================================================
// TOAST
// ============================================================================

function showToast(msg, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// ============================================================================
// SCOREBOARD TABLE
// ============================================================================

function renderScoreboard(data) {
  const tbody = document.getElementById('scoreboardBody');
  tbody.innerHTML = '';

  data.forEach((c, i) => {
    // Main row
    const tr = document.createElement('tr');
    tr.dataset.index = c.rank;
    tr.innerHTML = `
      <td class="rank-cell ${c.rank <= 3 ? 'top3' : ''}">${String(c.rank).padStart(2, '0')}</td>
      <td class="compound-name">${c.name}</td>
      <td class="score-cell">
        <div class="score-bar-wrapper">
          <div class="score-bar-track">
            <div class="score-bar-fill ${c.score >= 70 ? '' : c.score >= 45 ? 'mid' : 'low'}" style="width: 0%" data-width="${c.score}%"></div>
          </div>
          <span class="score-value">${c.score}</span>
        </div>
      </td>
      <td><span class="itp-badge itp-${c.itp}">${itpShort(c.itp)}</span></td>
      <td class="${lifespanClass(c.maleLifespan)}">${c.maleLifespan}</td>
      <td class="${lifespanClass(c.femaleLifespan)}">${c.femaleLifespan}</td>
      <td class="trials-count ${c.trials > 0 ? 'has-trials' : 'no-trials'}">${c.trials}</td>
      <td>${phaseHTML(c.phaseNum, c.phase)}</td>
      <td><button class="expand-btn" data-target="detail-${c.rank}">▸</button></td>
    `;

    // Detail row
    const detailTr = document.createElement('tr');
    detailTr.className = 'detail-row';
    detailTr.id = `detail-${c.rank}`;
    detailTr.innerHTML = `
      <td colspan="9">
        <div class="detail-content">
          <div>
            <dt>MAX LIFESPAN</dt>
            <dd>${c.maxLifespan}</dd>
            <dt>ITP RESULT DETAIL</dt>
            <dd>${c.itpLabel}</dd>
          </div>
          <div>
            <dt>KEY TRIAL</dt>
            <dd>${c.keyTrial}</dd>
            <dt>NOTES</dt>
            <dd>${c.notes}</dd>
          </div>
        </div>
      </td>
    `;

    tbody.appendChild(tr);
    tbody.appendChild(detailTr);
  });

  // Animate score bars
  requestAnimationFrame(() => {
    setTimeout(() => {
      document.querySelectorAll('.score-bar-fill').forEach(bar => {
        bar.style.width = bar.dataset.width;
      });
    }, 300);
  });

  // Expand/collapse handlers
  tbody.querySelectorAll('.expand-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDetail(btn);
    });
  });

  tbody.querySelectorAll('tr[data-index]').forEach(row => {
    row.addEventListener('click', () => {
      const btn = row.querySelector('.expand-btn');
      if (btn) toggleDetail(btn);
    });
  });
}

function toggleDetail(btn) {
  const targetId = btn.dataset.target;
  const detailRow = document.getElementById(targetId);
  const isOpen = detailRow.classList.contains('visible');

  // Close all
  document.querySelectorAll('.detail-row.visible').forEach(r => r.classList.remove('visible'));
  document.querySelectorAll('.expand-btn.open').forEach(b => b.classList.remove('open'));
  document.querySelectorAll('tr.expanded').forEach(r => r.classList.remove('expanded'));

  if (!isOpen) {
    detailRow.classList.add('visible');
    btn.classList.add('open');
    btn.closest('tr').classList.add('expanded');
  }
}

function itpShort(itp) {
  const map = {
    positive: 'POSITIVE',
    negative: 'NEGATIVE',
    not_tested: 'NOT TESTED',
    mixed: 'MIXED'
  };
  return map[itp] || itp;
}

function lifespanClass(val) {
  if (!val || val === 'N/A' || val === 'NS') return 'lifespan-ns';
  if (val.includes('-') && !val.includes('+')) return 'lifespan-negative';
  if (val.startsWith('+')) return 'lifespan-positive';
  if (val.includes('Ext.')) return 'lifespan-ns';
  return 'lifespan-ns';
}

function phaseHTML(phaseNum, phaseText) {
  const total = 4;
  let filled = Math.floor(phaseNum);
  if (phaseNum === 2.5) filled = 2;
  let html = '<div class="phase-indicator"><div class="phase-dots">';
  for (let i = 1; i <= total; i++) {
    if (i <= filled) html += '<div class="phase-dot filled"></div>';
    else if (i === filled + 1 && phaseNum % 1 !== 0) html += '<div class="phase-dot active"></div>';
    else html += '<div class="phase-dot"></div>';
  }
  html += `</div><span class="phase-text">${phaseText}</span></div>`;
  return html;
}

// ============================================================================
// SEARCH
// ============================================================================

function initSearch() {
  const input = document.getElementById('searchInput');
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    filterTable(q, getCurrentFilter());
  });
}

function getCurrentFilter() {
  const active = document.querySelector('.filter-btn.active');
  return active ? active.dataset.filter : 'all';
}

function filterTable(query, filter) {
  const rows = document.querySelectorAll('#scoreboardBody tr[data-index]');
  rows.forEach(row => {
    const idx = parseInt(row.dataset.index) - 1;
    const c = compounds.find(x => x.rank === parseInt(row.dataset.index));
    if (!c) return;

    let show = true;

    // Text filter
    if (query && !c.name.toLowerCase().includes(query) && !c.notes.toLowerCase().includes(query)) {
      show = false;
    }

    // Category filter
    if (filter === 'positive' && c.itp !== 'positive') show = false;
    if (filter === 'negative' && c.itp !== 'negative') show = false;
    if (filter === 'human' && c.trials === 0) show = false;

    row.style.display = show ? '' : 'none';
    const detailRow = document.getElementById(`detail-${c.rank}`);
    if (detailRow && !show) {
      detailRow.classList.remove('visible');
      const btn = row.querySelector('.expand-btn');
      if (btn) btn.classList.remove('open');
      row.classList.remove('expanded');
    }
  });
}

// ============================================================================
// FILTERS
// ============================================================================

function initFilters() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const q = document.getElementById('searchInput').value.toLowerCase().trim();
      filterTable(q, btn.dataset.filter);
    });
  });
}

// ============================================================================
// SORTING
// ============================================================================

function initSorting() {
  document.querySelectorAll('.scoreboard-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      const currentDir = th.classList.contains('sorted-asc') ? 'asc' : th.classList.contains('sorted-desc') ? 'desc' : 'none';
      const newDir = currentDir === 'asc' ? 'desc' : 'asc';

      // Clear other sort indicators
      document.querySelectorAll('.scoreboard-table th').forEach(h => {
        h.classList.remove('sorted-asc', 'sorted-desc');
      });
      th.classList.add(newDir === 'asc' ? 'sorted-asc' : 'sorted-desc');

      const sorted = [...compounds].sort((a, b) => {
        let va, vb;
        switch (key) {
          case 'rank': va = a.rank; vb = b.rank; break;
          case 'name': va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
          case 'score': va = a.score; vb = b.score; break;
          case 'itp':
            const order = { positive: 0, mixed: 1, not_tested: 2, negative: 3 };
            va = order[a.itp]; vb = order[b.itp]; break;
          case 'male': va = a.maleNum; vb = b.maleNum; break;
          case 'female': va = a.femaleNum; vb = b.femaleNum; break;
          case 'trials': va = a.trials; vb = b.trials; break;
          case 'phase': va = a.phaseNum; vb = b.phaseNum; break;
          default: return 0;
        }
        if (typeof va === 'string') return newDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        return newDir === 'asc' ? va - vb : vb - va;
      });

      renderScoreboard(sorted);
    });
  });
}

// ============================================================================
// EFFECT SIZE CHART
// ============================================================================

function initEffectChart() {
  const ctx = document.getElementById('effectChart').getContext('2d');

  const chartData = [...compounds]
    .filter(c => c.maleNum > 0)
    .sort((a, b) => b.maleNum - a.maleNum);

  effectChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: chartData.map(c => c.name),
      datasets: [{
        label: 'Best Male Lifespan Extension (%)',
        data: chartData.map(c => c.maleNum),
        backgroundColor: chartData.map(c =>
          c.trials > 0 ? 'rgba(6, 214, 160, 0.7)' : 'rgba(139, 92, 246, 0.5)'
        ),
        borderColor: chartData.map(c =>
          c.trials > 0 ? 'rgba(6, 214, 160, 1)' : 'rgba(139, 92, 246, 0.8)'
        ),
        borderWidth: 1,
        borderRadius: 2,
        barPercentage: 0.75,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: '#94a3b8',
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            generateLabels: function() {
              return [
                { text: 'Has Human Trials', fillStyle: 'rgba(6, 214, 160, 0.7)', strokeStyle: 'rgba(6, 214, 160, 1)', lineWidth: 1 },
                { text: 'No Human Trials', fillStyle: 'rgba(139, 92, 246, 0.5)', strokeStyle: 'rgba(139, 92, 246, 0.8)', lineWidth: 1 }
              ];
            }
          }
        },
        tooltip: {
          backgroundColor: '#111827',
          borderColor: '#1e293b',
          borderWidth: 1,
          titleFont: { family: "'Outfit', sans-serif", size: 13, weight: 600 },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
          titleColor: '#e2e8f0',
          bodyColor: '#94a3b8',
          callbacks: {
            label: function(context) {
              const c = chartData[context.dataIndex];
              return [`+${c.maleNum}% male lifespan`, `${c.trials} human trials`, `Score: ${c.score}`];
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(30, 41, 59, 0.4)' },
          ticks: {
            color: '#64748b',
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            callback: v => v + '%'
          },
          title: {
            display: true,
            text: 'Male Lifespan Extension (%)',
            color: '#64748b',
            font: { family: "'JetBrains Mono', monospace", size: 10 }
          }
        },
        y: {
          grid: { display: false },
          ticks: {
            color: '#94a3b8',
            font: { family: "'Outfit', sans-serif", size: 11 },
            padding: 8
          }
        }
      }
    }
  });

  // Set canvas height based on data
  document.getElementById('effectChart').parentElement.style.height = Math.max(400, chartData.length * 38) + 'px';
}

// ============================================================================
// TRANSLATION GAP CHART
// ============================================================================

function initTranslationChart() {
  const ctx = document.getElementById('translationChart').getContext('2d');

  const bubbleData = compounds.map(c => ({
    x: Math.max(c.maleNum, c.femaleNum, 0),
    y: c.phaseNum + (c.trials > 0 ? Math.min(c.trials / 40, 0.5) : 0),
    r: Math.max(c.score / 10, 3),
    label: c.name,
    itp: c.itp,
    trials: c.trials,
    score: c.score
  }));

  const colorMap = {
    positive: 'rgba(6, 214, 160, 0.55)',
    negative: 'rgba(239, 68, 68, 0.45)',
    not_tested: 'rgba(148, 163, 184, 0.35)',
    mixed: 'rgba(251, 191, 36, 0.45)'
  };

  const borderMap = {
    positive: 'rgba(6, 214, 160, 0.9)',
    negative: 'rgba(239, 68, 68, 0.7)',
    not_tested: 'rgba(148, 163, 184, 0.5)',
    mixed: 'rgba(251, 191, 36, 0.7)'
  };

  translationChartInstance = new Chart(ctx, {
    type: 'bubble',
    data: {
      datasets: [{
        label: 'Compounds',
        data: bubbleData,
        backgroundColor: bubbleData.map(d => colorMap[d.itp]),
        borderColor: bubbleData.map(d => borderMap[d.itp]),
        borderWidth: 1.5,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#111827',
          borderColor: '#1e293b',
          borderWidth: 1,
          titleFont: { family: "'Outfit', sans-serif", size: 13, weight: 600 },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
          titleColor: '#e2e8f0',
          bodyColor: '#94a3b8',
          callbacks: {
            title: function(items) {
              return bubbleData[items[0].dataIndex].label;
            },
            label: function(context) {
              const d = bubbleData[context.dataIndex];
              return [
                `Mouse Effect: +${d.x}%`,
                `Human Trials: ${d.trials}`,
                `Composite Score: ${d.score}`
              ];
            }
          }
        }
      },
      scales: {
        x: {
          title: {
            display: true,
            text: 'Best Mouse Lifespan Extension (%)',
            color: '#64748b',
            font: { family: "'JetBrains Mono', monospace", size: 10 }
          },
          grid: { color: 'rgba(30, 41, 59, 0.3)' },
          ticks: {
            color: '#64748b',
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            callback: v => v + '%'
          },
          min: -2,
          max: 42
        },
        y: {
          title: {
            display: true,
            text: 'Human Trial Progress',
            color: '#64748b',
            font: { family: "'JetBrains Mono', monospace", size: 10 }
          },
          grid: { color: 'rgba(30, 41, 59, 0.3)' },
          ticks: {
            color: '#64748b',
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            stepSize: 1,
            callback: function(v) {
              const labels = { 0: 'Preclinical', 1: 'Phase 1', 2: 'Phase 2', 3: 'Phase 3', 4: 'Phase 4' };
              return labels[Math.round(v)] || '';
            }
          },
          min: -0.5,
          max: 5
        }
      }
    },
    plugins: [{
      id: 'quadrantLabels',
      afterDraw: function(chart) {
        const { ctx, chartArea: { left, right, top, bottom } } = chart;
        const midX = (left + right) / 2;
        const midY = (top + bottom) / 2;

        ctx.save();
        ctx.font = "600 10px 'JetBrains Mono', monospace";
        ctx.textAlign = 'center';

        // Top-right: Gold standard
        ctx.fillStyle = 'rgba(6, 214, 160, 0.15)';
        ctx.fillText('STRONG MOUSE + HUMAN DATA', (midX + right) / 2, top + 16);

        // Top-left: Human only
        ctx.fillStyle = 'rgba(251, 191, 36, 0.15)';
        ctx.fillText('HUMAN TRIALS ONLY', (left + midX) / 2, top + 16);

        // Bottom-right: Mouse only
        ctx.fillStyle = 'rgba(139, 92, 246, 0.15)';
        ctx.fillText('MOUSE DATA ONLY', (midX + right) / 2, bottom - 6);

        ctx.restore();
      }
    }]
  });

  document.getElementById('translationChart').parentElement.style.height = '500px';
}

// ============================================================================
// PIPELINE
// ============================================================================

function renderPipeline() {
  const grid = document.getElementById('pipelineGrid');
  pipelineCompounds.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'pipeline-card';
    card.style.animationDelay = `${i * 0.05}s`;
    card.innerHTML = `
      <div class="pipeline-name">${c.name}</div>
      <div class="pipeline-status">IN PROGRESS</div>
      <div class="pipeline-note">${c.note}</div>
    `;
    grid.appendChild(card);
  });
}

// ============================================================================
// FAILED COMPOUNDS
// ============================================================================

function renderFailed() {
  const grid = document.getElementById('failedGrid');
  failedCompounds.forEach(c => {
    const item = document.createElement('div');
    item.className = 'failed-item';
    item.innerHTML = `
      <span class="failed-x">✕</span>
      <span class="failed-name">${c.name}</span>
      <span class="failed-note">${c.note}</span>
    `;
    grid.appendChild(item);
  });
}

function initFailedToggle() {
  const toggle = document.getElementById('failedToggle');
  const grid = document.getElementById('failedGrid');

  toggle.addEventListener('click', () => {
    const isExpanded = grid.classList.contains('expanded');
    grid.classList.toggle('expanded');
    grid.classList.toggle('collapsed');
    toggle.classList.toggle('open');
    toggle.innerHTML = isExpanded
      ? '<span class="toggle-icon">▸</span> Show 29 Failed Compounds'
      : '<span class="toggle-icon">▸</span> Hide Failed Compounds';
  });
}

// ============================================================================
// METRIC COUNTER ANIMATION
// ============================================================================

function animateMetrics() {
  const counters = document.querySelectorAll('.metric-value[data-target]');
  const duration = 2000;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const el = entry.target;
        const target = parseInt(el.dataset.target);
        const start = performance.now();

        function update(now) {
          const elapsed = now - start;
          const progress = Math.min(elapsed / duration, 1);
          const eased = 1 - Math.pow(1 - progress, 3);
          el.textContent = Math.round(target * eased);
          if (progress < 1) requestAnimationFrame(update);
        }

        requestAnimationFrame(update);
        observer.unobserve(el);
      }
    });
  }, { threshold: 0.5 });

  counters.forEach(c => observer.observe(c));
}

// ============================================================================
// SCROLL ANIMATIONS
// ============================================================================

function initScrollAnimations() {
  const sections = document.querySelectorAll('.section, .pipeline-card');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('section-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.05, rootMargin: '0px 0px -40px 0px' });

  sections.forEach(s => {
    s.classList.add('section-animate');
    observer.observe(s);
  });

  // Fallback: make everything visible after 2s in case observer doesn't fire
  setTimeout(() => {
    document.querySelectorAll('.section-animate').forEach(s => {
      s.classList.add('section-visible');
    });
  }, 2000);
}
