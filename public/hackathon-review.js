const state = {
  submissions: [],
  repoSignals: new Map(),
  transcripts: new Map(),
  judging: new Map(),
  recommendations: new Map(),
  rubric: [],
  selectedId: null,
  activeTracks: new Set(),
  search: '',
  sort: 'genlayer',
  genlayerFilter: 'all',
};

const els = {
  projectList: document.getElementById('projectList'),
  trackFilters: document.getElementById('trackFilters'),
  search: document.getElementById('search'),
  sort: document.getElementById('sort'),
  genlayerFilter: document.getElementById('genlayerFilter'),
  clearTracks: document.getElementById('clearTracks'),
  statProjects: document.getElementById('statProjects'),
  statTranscripts: document.getElementById('statTranscripts'),
  statRepos: document.getElementById('statRepos'),
  detailEmpty: document.getElementById('detailEmpty'),
  detailView: document.getElementById('detailView'),
  detailId: document.getElementById('detailId'),
  detailTitle: document.getElementById('detailTitle'),
  detailTotal: document.getElementById('detailTotal'),
  detailTracks: document.getElementById('detailTracks'),
  detailSummary: document.getElementById('detailSummary'),
  detailJudgeNotes: document.getElementById('detailJudgeNotes'),
  scoreBars: document.getElementById('scoreBars'),
  repoSignals: document.getElementById('repoSignals'),
  transcriptMeta: document.getElementById('transcriptMeta'),
  transcriptPreview: document.getElementById('transcriptPreview'),
  polishSignals: document.getElementById('polishSignals'),
  riskFlags: document.getElementById('riskFlags'),
  linkDora: document.getElementById('linkDora'),
  linkDemo: document.getElementById('linkDemo'),
  linkGitHub: document.getElementById('linkGitHub'),
  nextBtn: document.getElementById('nextBtn'),
  prevBtn: document.getElementById('prevBtn'),
};

async function loadData() {
  const [submissions, repoSignals, transcripts, rubric, summaries, judging, recommendations] = await Promise.all([
    fetch('/hackathon-review.submissions.json?v=20260322c').then(r => r.json()),
    fetch('/hackathon-review.repo-signals.json?v=20260322c').then(r => r.ok ? r.json() : []),
    fetch('/hackathon-review.video-transcripts.json?v=20260322c').then(r => r.ok ? r.json() : []),
    fetch('/hackathon-review.scoring-rubric.json?v=20260322c').then(r => r.ok ? r.json() : { dimensions: [] }),
    fetch('/hackathon-review.project-summaries.json?v=20260322c').then(r => r.ok ? r.json() : []),
    fetch('/hackathon-review.genlayer-judging-table.json?v=20260322c').then(r => r.ok ? r.json() : []),
    fetch('/hackathon-review.genlayer-recommendations.json?v=20260322c').then(r => r.ok ? r.json() : []),
  ]);
  state.submissions = submissions.map(s => ({ ...s, summary: '', judgeNotes: [] }));
  const summariesMap = new Map(summaries.map(x => [x.id, x]));
  state.judging = new Map(judging.map(x => [x.id, x]));
  state.recommendations = new Map(recommendations.map(x => [x.id, x]));
  state.submissions = state.submissions.map(s => ({
    ...s,
    summary: summariesMap.get(s.id)?.summary || 'Summary pending / generated from available repo and transcript signals.',
    judgeNotes: summariesMap.get(s.id)?.judgeNotes || [],
    scorecard: summariesMap.get(s.id)?.scorecard || {},
    totalScore: summariesMap.get(s.id)?.totalScore ?? computeFallbackScore(s.id),
    genlayer: state.judging.get(s.id) || null,
    recommendation: state.recommendations.get(s.id) || null,
  }));
  state.repoSignals = new Map(repoSignals.map(r => [r.id, r]));
  state.transcripts = new Map(transcripts.map(t => [t.id, t]));
  state.rubric = rubric.dimensions || [];
  renderFilters();
  renderStats();
  renderList();
  select(state.submissions[0]?.id || null);
}

function computeFallbackScore(id) {
  const repo = state.repoSignals.get?.(id);
  if (!repo) return 0;
  let score = 0;
  if (repo.repoExists) score += 20;
  if (repo.hasReadme) score += 10;
  if (repo.hasLicense) score += 5;
  if (repo.hasTestsHeuristic) score += 10;
  if (repo.hasCIHeuristic) score += 5;
  if (repo.homepage) score += 5;
  return Math.min(100, score);
}

function allTracks() {
  return [...new Set(state.submissions.flatMap(s => s.tracks || []))].sort();
}

function renderFilters() {
  els.trackFilters.innerHTML = '';
  for (const track of allTracks()) {
    const btn = document.createElement('button');
    btn.className = `track-chip ${state.activeTracks.has(track) ? 'active' : ''}`;
    btn.textContent = track;
    btn.onclick = () => {
      state.activeTracks.has(track) ? state.activeTracks.delete(track) : state.activeTracks.add(track);
      renderFilters(); renderList();
    };
    els.trackFilters.appendChild(btn);
  }
}

function filtered() {
  let items = [...state.submissions];
  if (state.search) {
    const q = state.search.toLowerCase();
    items = items.filter(s => s.projectName.toLowerCase().includes(q) || (s.tracks || []).some(t => t.toLowerCase().includes(q)));
  }
  if (state.activeTracks.size) {
    items = items.filter(s => (s.tracks || []).some(t => state.activeTracks.has(t)));
  }
  if (state.genlayerFilter !== 'all') {
    items = items.filter(s => {
      const g = s.genlayer || {};
      return g.genlayerCategory === state.genlayerFilter || g.seriousGenLayerProject === state.genlayerFilter;
    });
  }
  items.sort((a, b) => {
    if (state.sort === 'name') return a.projectName.localeCompare(b.projectName);
    if (state.sort === 'updated') return (state.repoSignals.get(b.id)?.lastUpdate || '').localeCompare(state.repoSignals.get(a.id)?.lastUpdate || '');
    if (state.sort === 'demo') return (state.transcripts.get(b.id)?.transcriptStatus === 'ok') - (state.transcripts.get(a.id)?.transcriptStatus === 'ok');
    if (state.sort === 'genlayer') {
      const ar = a.recommendation?.rank ?? 999;
      const br = b.recommendation?.rank ?? 999;
      if (ar !== br) return ar - br;
      return (b.totalScore || 0) - (a.totalScore || 0);
    }
    return (b.totalScore || 0) - (a.totalScore || 0);
  });
  return items;
}

function renderStats() {
  els.statProjects.textContent = state.submissions.length;
  els.statTranscripts.textContent = [...state.transcripts.values()].filter(t => t.transcriptStatus === 'ok').length;
  els.statRepos.textContent = [...state.repoSignals.values()].filter(r => r.repoExists).length;
}

function renderList() {
  const items = filtered();
  els.projectList.innerHTML = '';
  for (const item of items) {
    const repo = state.repoSignals.get(item.id);
    const tr = state.transcripts.get(item.id);
    const el = document.createElement('button');
    el.className = `project-item ${state.selectedId === item.id ? 'active' : ''}`;
    el.innerHTML = `
      <div class="project-topline">
        <div>
          <div class="project-name">${item.id}. ${item.projectName}</div>
        </div>
        <div class="project-score">${Math.round(item.totalScore || 0)}</div>
      </div>
      <div class="project-meta">
        <span>${item.recommendation ? '#' + item.recommendation.rank : '—'}</span>
        <span>${item.genlayer?.genlayerCategory || 'genlayer ?'}</span>
        <span>${repo?.primaryLanguage || 'lang ?'}</span>
        <span>${repo?.repoExists ? 'repo ✓' : 'repo ?'}</span>
        <span>${tr?.transcriptStatus === 'ok' ? 'transcript ✓' : 'transcript —'}</span>
      </div>`;
    el.onclick = () => select(item.id);
    els.projectList.appendChild(el);
  }
}

function select(id) {
  state.selectedId = id;
  renderList();
  const item = state.submissions.find(s => s.id === id);
  if (!item) return;
  const repo = state.repoSignals.get(id) || {};
  const transcript = state.transcripts.get(id) || {};
  els.detailEmpty.classList.add('hidden');
  els.detailView.classList.remove('hidden');
  els.detailId.textContent = `Project #${item.id}`;
  els.detailTitle.textContent = item.projectName;
  els.detailTotal.textContent = Math.round(item.totalScore || 0);
  els.detailTracks.innerHTML = '';
  if (item.recommendation) {
    const tag = document.createElement('span');
    tag.textContent = `Rank: #${item.recommendation.rank} (${item.recommendation.tier})`;
    els.detailTracks.appendChild(tag);
  }
  if (item.genlayer) {
    ['GenLayer: ' + item.genlayer.genlayerCategory, 'Role: ' + item.genlayer.role, 'Confidence: ' + item.genlayer.confidence, 'Serious: ' + item.genlayer.seriousGenLayerProject].forEach(text => {
      const tag = document.createElement('span');
      tag.textContent = text;
      els.detailTracks.appendChild(tag);
    });
  }
  (item.tracks || []).forEach(track => {
    const tag = document.createElement('span');
    tag.textContent = track;
    els.detailTracks.appendChild(tag);
  });
  els.detailSummary.textContent = item.summary;
  els.detailJudgeNotes.innerHTML = '';
  const notes = item.judgeNotes?.length ? item.judgeNotes : buildJudgeNotes(item, repo, transcript);
  notes.forEach(note => {
    const li = document.createElement('li');
    li.textContent = note;
    els.detailJudgeNotes.appendChild(li);
  });
  els.linkDora.href = item.dorahacksUrl;
  els.linkDemo.href = item.demoUrl;
  els.linkGitHub.href = item.githubUrl;
  renderScores(item, repo, transcript);
  renderRepoSignals(repo);
  renderTranscript(transcript);
  renderBullets(els.polishSignals, repo.polishSignals || ['No obvious polish signals captured yet.']);
  renderBullets(els.riskFlags, repo.riskFlags || ['No obvious risk flags captured yet.']);
}

function buildJudgeNotes(item, repo, transcript) {
  const notes = [];
  if (item.recommendation) {
    notes.push(`GenLayer recommendation rank: #${item.recommendation.rank} (${item.recommendation.tier}).`);
    notes.push(`Why it ranks here: ${item.recommendation.rationale}`);
  }
  if (item.genlayer) {
    notes.push(`GenLayer category: ${item.genlayer.genlayerCategory}.`);
    notes.push(`GenLayer role: ${item.genlayer.role}.`);
    notes.push(`Confidence: ${item.genlayer.confidence}. Serious GenLayer project: ${item.genlayer.seriousGenLayerProject}.`);
  }
  if (repo.repoExists) notes.push(`Repo detected; primary language: ${repo.primaryLanguage || 'unknown'}.`);
  else notes.push('Repo not confirmed via automation.');
  if (transcript.transcriptStatus === 'ok') notes.push('Transcript available for quick skim.');
  else notes.push(`Transcript status: ${transcript.transcriptStatus || 'unknown'}.`);
  if ((item.notes || []).length) notes.push(`Imported note: ${item.notes.join(', ')}.`);
  return notes;
}

function renderScores(item, repo, transcript) {
  els.scoreBars.innerHTML = '';
  const card = item.scorecard || {};
  const dimensions = state.rubric.length ? state.rubric : [
    { key: 'problem_clarity', label: 'Problem clarity', weight: 15 },
    { key: 'demo_explainability', label: 'Demo explainability', weight: 15 },
    { key: 'technical_depth', label: 'Technical depth', weight: 20 },
    { key: 'product_completeness', label: 'Product completeness', weight: 15 },
    { key: 'code_quality', label: 'Code quality', weight: 15 },
    { key: 'innovation', label: 'Innovation', weight: 10 },
    { key: 'genlayer_fit', label: 'GenLayer fit', weight: 10 },
  ];
  for (const dim of dimensions) {
    const val = card[dim.key] ?? heuristicDimension(dim.key, repo, transcript);
    const row = document.createElement('div');
    row.className = 'score-row';
    row.innerHTML = `<div>${dim.label}</div><div class="score-track"><div class="score-fill" style="width:${val * 10}%"></div></div><div>${val.toFixed(1)}</div>`;
    els.scoreBars.appendChild(row);
  }
}

function heuristicDimension(key, repo, transcript) {
  const base = {
    problem_clarity: transcript.title ? 6.8 : 5.5,
    demo_explainability: transcript.transcriptStatus === 'ok' ? 7.0 : 5.0,
    technical_depth: repo.repoExists ? 6.8 : 3.5,
    product_completeness: repo.homepage ? 7.2 : 5.8,
    code_quality: (repo.hasReadme ? 2 : 0) + (repo.hasTestsHeuristic ? 2 : 0) + (repo.hasLicense ? 1 : 0) + 4,
    innovation: 6.0,
    genlayer_fit: 6.5,
  };
  return Math.max(0, Math.min(10, base[key] ?? 5.0));
}

function renderRepoSignals(repo) {
  els.repoSignals.innerHTML = '';
  const pairs = {
    'Repo exists': repo.repoExists ? 'yes' : 'no',
    'Language': repo.primaryLanguage || '—',
    'Updated': repo.lastUpdate ? new Date(repo.lastUpdate).toLocaleDateString() : '—',
    'README': yesNo(repo.hasReadme),
    'License': yesNo(repo.hasLicense),
    'Tests': yesNo(repo.hasTestsHeuristic),
    'Docs': yesNo(repo.hasDocsHeuristic),
    'CI': yesNo(repo.hasCIHeuristic),
    'Stars': repo.stars ?? '—',
    'Forks': repo.forks ?? '—',
  };
  Object.entries(pairs).forEach(([k, v]) => {
    const dt = document.createElement('div');
    dt.innerHTML = `<dt>${k}</dt><dd>${v}</dd>`;
    els.repoSignals.appendChild(dt);
  });
}

function renderTranscript(transcript) {
  els.transcriptMeta.innerHTML = `
    <div><strong>Status:</strong> ${transcript.transcriptStatus || '—'}</div>
    <div><strong>Platform:</strong> ${transcript.platform || '—'}</div>
    <div><strong>Title:</strong> ${transcript.title || '—'}</div>
    <div><strong>Duration:</strong> ${transcript.durationSeconds ? Math.round(transcript.durationSeconds / 60) + ' min' : '—'}</div>`;
  els.transcriptPreview.textContent = (transcript.transcriptText || transcript.summarySeed || 'Transcript unavailable yet.').slice(0, 2200);
}

function renderBullets(target, items) {
  target.innerHTML = '';
  items.forEach(item => {
    const li = document.createElement('li');
    li.textContent = item;
    target.appendChild(li);
  });
}

function yesNo(v) {
  return v === true ? 'yes' : v === false ? 'no' : '—';
}

els.search.addEventListener('input', e => { state.search = e.target.value.trim(); renderList(); });
els.sort.addEventListener('change', e => { state.sort = e.target.value; renderList(); });
els.genlayerFilter.addEventListener('change', e => { state.genlayerFilter = e.target.value; renderList(); });
els.clearTracks.addEventListener('click', () => { state.activeTracks.clear(); renderFilters(); renderList(); });
els.nextBtn.addEventListener('click', () => stepSelection(1));
els.prevBtn.addEventListener('click', () => stepSelection(-1));
document.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') stepSelection(1);
  if (e.key === 'ArrowUp') stepSelection(-1);
});

function stepSelection(delta) {
  const items = filtered();
  const idx = items.findIndex(x => x.id === state.selectedId);
  const next = items[idx + delta] || items[idx] || items[0];
  if (next) select(next.id);
}

loadData().catch(err => {
  console.error(err);
  els.detailEmpty.innerHTML = `<p>Data failed to load. ${err.message}</p>`;
});
