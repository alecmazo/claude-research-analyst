// ============================================================================
// DGA Research Analyst — Web UI
// ============================================================================

// ── Build version: bump this whenever a deployment has UI changes ─────────
// Forces a hard reload the first time a device loads the new version,
// evicting stale iOS PWA / Safari cache that ignores Cache-Control headers.
//
// LOOP GUARD: never reload more than once per session. If the URL already
// has ?_b= or we've recorded a reload attempt in sessionStorage, we just
// update localStorage and move on — an infinite reload is far worse than
// a stale UI for the user (it blocks login entirely). Next fresh session
// (new tab, hard quit) will retry the reload.
const DGA_BUILD = 'ui29-20260506';
;(function(){
  let alreadyTried = false;
  try {
    const u0 = new URL(window.location.href);
    if (u0.searchParams.get('_b')) alreadyTried = true;
  } catch (_) {}
  try {
    if (sessionStorage.getItem('_dga_reload_attempted') === '1') alreadyTried = true;
  } catch (_) {}

  try {
    const stored = localStorage.getItem('_dga_build');
    localStorage.setItem('_dga_build', DGA_BUILD);
    if (stored && stored !== DGA_BUILD && !alreadyTried) {
      try { sessionStorage.setItem('_dga_reload_attempted', '1'); } catch (_) {}
      const u = new URL(window.location.href);
      u.searchParams.set('_b', Date.now().toString());
      window.location.replace(u.toString());
      return;
    }
  } catch (_) {}

  // Async: ask the server what the current build is. If it differs from our
  // embedded constant AND we haven't already tried, hard reload once.
  try {
    fetch('/api/build', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!j || !j.build) return;
        try { localStorage.setItem('_dga_build', j.build); } catch (_) {}
        if (j.build === DGA_BUILD) return;
        if (alreadyTried) {
          console.log('[DGA] Build mismatch but reload guard active — local:', DGA_BUILD, 'server:', j.build);
          return;
        }
        console.log('[DGA] Build mismatch — local:', DGA_BUILD, 'server:', j.build);
        try { sessionStorage.setItem('_dga_reload_attempted', '1'); } catch (_) {}
        const u = new URL(window.location.href);
        u.searchParams.set('_b', Date.now().toString());
        window.location.replace(u.toString());
      })
      .catch(() => { /* offline — ignore */ });
  } catch (_) {}
})();

const API_BASE = window.location.origin;

// ---------- Auth ----------
const TOKEN_KEY = 'dga_auth_token';

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

function showLogin(errorMsg) {
  document.getElementById('login-overlay').classList.remove('hidden');
  const err = document.getElementById('login-error');
  if (err) err.textContent = errorMsg || '';
}
function hideLogin() {
  document.getElementById('login-overlay').classList.add('hidden');
}

async function login(password) {
  const resp = await fetch(`${API_BASE}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!resp.ok) throw new Error('Incorrect password');
  const { token } = await resp.json();
  setToken(token);
  hideLogin();
  boot();
}

// Wire up login form
document.getElementById('login-btn').addEventListener('click', handleLogin);
document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') handleLogin();
});

async function handleLogin() {
  const pw = document.getElementById('login-password').value;
  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  try {
    await login(pw);
  } catch {
    showLogin('Incorrect password — try again');
  } finally {
    btn.disabled = false;
  }
}

// ---------- API helpers ----------
async function apiGet(path) {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { 'x-auth-token': getToken() },
  });
  if (resp.status === 401) { clearToken(); showLogin('Session expired — please log in again'); throw new Error('Unauthorized'); }
  if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
  return resp.json();
}
async function apiPost(path, body) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': getToken() },
    body: JSON.stringify(body),
  });
  if (resp.status === 401) { clearToken(); showLogin('Session expired — please log in again'); throw new Error('Unauthorized'); }
  if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
  return resp.json();
}

const api = {
  health: () => apiGet('/health'),
  startAnalysis: (ticker, generate_gamma = false) =>
    apiPost('/api/analyze', { ticker, generate_gamma }),
  getJob: (id) => apiGet(`/api/jobs/${id}`),
  listReports: () => apiGet('/api/reports'),
  getReport: (ticker) => apiGet(`/api/report/${ticker}`),
  getQuote: (ticker) => apiGet(`/api/quote/${ticker}`),
  listStrategies: () => apiGet('/api/strategies'),
  clearCache: () => fetch(`${API_BASE}/api/cache`, {
    method: 'DELETE',
    headers: { 'x-auth-token': getToken() },
  }).then(r => r.ok ? r.json() : { count: 0 }),
  startPortfolio: (formData) => {
    formData.append('token', getToken());
    return fetch(`${API_BASE}/api/portfolio`, {
      method: 'POST',
      body: formData,
      headers: { 'x-auth-token': getToken() },
    }).then(async r => {
      if (r.status === 401) { clearToken(); showLogin('Session expired'); throw new Error('Unauthorized'); }
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      return r.json();
    });
  },
  getPortfolioJob: (id) => apiGet(`/api/portfolio/${id}`),
  portfolioDownloadUrl: (id) => `${API_BASE}/api/portfolio/${id}/download?token=${getToken()}`,
  getLastPortfolio: () => apiGet('/api/portfolio/last'),
  getPortfolioSummary: () => apiGet('/api/portfolio/summary'),
  // Watchlist
  getWatchlist: () => apiGet('/api/watchlist'),
  addWatchlistTicker: (t) => fetch(`${API_BASE}/api/watchlist/${t}`, {
    method: 'POST', headers: { 'x-auth-token': getToken() }
  }).then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e.detail || r.status); })),
  removeWatchlistTicker: (t) => fetch(`${API_BASE}/api/watchlist/${t}`, {
    method: 'DELETE', headers: { 'x-auth-token': getToken() }
  }).then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e.detail || r.status); })),
  // Scan
  startScan: () => fetch(`${API_BASE}/api/scan`, {
    method: 'POST', headers: { 'x-auth-token': getToken() }
  }).then(async r => {
    if (r.status === 401) { clearToken(); showLogin('Session expired'); throw new Error('Unauthorized'); }
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    return r.json();
  }),
  getScanJob: (id) => apiGet(`/api/scan/${id}`),
  getLatestScan: () => apiGet('/api/scan/latest'),
  // Intelligence
  startIntelligence: (sector) => apiPost('/api/intelligence', { sector }),
  getIntelligenceJob: (id) => apiGet(`/api/intelligence/${id}`),
  getLatestIntelligence: () => apiGet('/api/intelligence/latest'),
  // Daily Brief (Goldman-style PM morning note)
  startDailyBrief: () => apiPost('/api/daily-brief', {}),
  getDailyBriefJob: (id) => apiGet(`/api/daily-brief/${id}`),
  getLatestDailyBrief: () => apiGet('/api/daily-brief/latest'),
  // Paper Tracker
  createTracker: (body) => apiPost('/api/track', body),
  listTrackers: () => apiGet('/api/track'),
  getTracker: (id) => apiGet(`/api/track/${id}`),
  closeTracker: (id) => apiPost(`/api/track/${id}/close`, {}),
  deleteTracker: (id) => fetch(`${API_BASE}/api/track/${id}`, {
    method: 'DELETE', headers: { 'x-auth-token': getToken() }
  }).then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e.detail || r.status); })),
  getLiveBenchmark: () => apiGet('/api/track/live'),
  getLiveBenchmarkDetail: (snapshotId) => apiGet(
    '/api/track/live/detail' + (snapshotId ? `?snapshot_id=${encodeURIComponent(snapshotId)}` : '')
  ),
  listYtdSnapshots: () => apiGet('/api/track/live/snapshots'),
  deleteYtdSnapshot: (id) => fetch(`${API_BASE}/api/track/live/snapshots/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': getToken() },
  }).then(r => r.json()),
  setCurrentYtdSnapshot: (id) => fetch(
    `${API_BASE}/api/track/live/ytd/set-current/${encodeURIComponent(id)}`,
    { method: 'POST', headers: { 'x-auth-token': getToken() } }
  ).then(r => r.json()),
  emailYtdReport: (email, snapshotId) => fetch(`${API_BASE}/api/track/live/ytd/email`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': getToken() },
    body:    JSON.stringify({ email, snapshot_id: snapshotId || null }),
  }).then(async r => {
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${r.status}`);
    }
    return r.json();
  }),
};

// ---------- View switching ----------
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.target === id || (id === 'view-analysis' && t.dataset.target === 'view-home') || (id === 'view-report' && t.dataset.target === 'view-home'));
  });
  window.scrollTo(0, 0);
}

document.querySelectorAll('[data-target]').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    const t = el.dataset.target;
    showView(t);
    if (t === 'view-home') { loadReports(); loadLastPortfolioCard(); }
    if (t === 'view-portfolio') { rehydratePortfolioLastCard(); loadLiveBenchmark(); }
    if (t === 'view-intelligence') loadTrackers();
    if (t === 'view-settings') updateAppVersionCard();
    if (t === 'view-fund') openFundTab();
  });
});

// Wire up Force Refresh button (in Settings view)
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('force-refresh-btn');
  if (btn) btn.addEventListener('click', forceRefreshApp);
});

// ---------- Server status ----------
async function checkServer() {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('server-status-text');
  const host = document.getElementById('server-host');
  if (host) host.textContent = API_BASE;
  try {
    await api.health();
    dot.className = 'status-dot ok';
    if (txt) { txt.textContent = 'Online'; txt.style.color = 'var(--green)'; }
  } catch {
    dot.className = 'status-dot err';
    if (txt) { txt.textContent = 'Offline'; txt.style.color = 'var(--red)'; }
  }
}

// ---------- App version display + manual force-refresh ----------
async function updateAppVersionCard() {
  const loadedEl = document.getElementById('version-loaded');
  const serverEl = document.getElementById('version-server');
  const statusEl = document.getElementById('version-status');
  if (!loadedEl) return; // settings view not in DOM
  loadedEl.textContent = DGA_BUILD;
  try {
    const r = await fetch('/api/build?_t=' + Date.now(), { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    if (j && j.build) {
      serverEl.textContent = j.build;
      if (j.build === DGA_BUILD) {
        statusEl.textContent = '✓ Up to date';
        statusEl.style.color = 'var(--green, #16A34A)';
      } else {
        statusEl.textContent = '⚠ Update available — tap Force Refresh';
        statusEl.style.color = 'var(--gold, #C9A84C)';
      }
    } else {
      serverEl.textContent = 'unknown';
      statusEl.textContent = 'Could not reach server';
    }
  } catch {
    serverEl.textContent = 'offline';
    statusEl.textContent = 'Offline — cannot check';
  }
}

async function forceRefreshApp() {
  const btn = document.getElementById('force-refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Clearing cache…'; }
  try {
    // 1) Unregister any service workers (we don't use one, but be safe)
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister().catch(() => {})));
    }
    // 2) Drop every Cache Storage entry
    if (window.caches && caches.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k).catch(() => {})));
    }
    // 3) Wipe the build marker so we don't no-op on next load
    try { localStorage.removeItem('_dga_build'); } catch (_) {}
  } catch (_) { /* best-effort */ }
  // 4) Hard reload with a unique cache-bust query
  const u = new URL(window.location.href);
  u.searchParams.set('_b', String(Date.now()));
  // Use replace() so the back button doesn't take them to the stale URL
  window.location.replace(u.toString());
}

// loadReports is defined later in the file (with live-price injection).

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function formatDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ---------- Analyze flow ----------
const tickerInput = document.getElementById('ticker-input');
const analyzeBtn = document.getElementById('analyze-btn');

analyzeBtn.addEventListener('click', startAnalysis);
tickerInput.addEventListener('keypress', e => {
  if (e.key === 'Enter') startAnalysis();
});
tickerInput.addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
});

let currentJobId = null;
let pollTimer = null;

async function startAnalysis() {
  const ticker = tickerInput.value.trim().toUpperCase();
  if (!ticker) return;
  const generateGamma = document.getElementById('gamma-toggle').checked;
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = '…';
  try {
    const job = await api.startAnalysis(ticker, generateGamma);
    currentJobId = job.job_id;
    tickerInput.value = '';
    openAnalysis(ticker, job.job_id);
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = 'RUN';
  }
}

function openAnalysis(ticker, jobId) {
  document.getElementById('analysis-ticker').textContent = ticker;
  document.getElementById('analysis-title').textContent = ticker;
  document.getElementById('analysis-result').style.display = 'none';
  document.getElementById('analysis-error').style.display = 'none';
  document.getElementById('view-report-btn').style.display = 'none';
  setStepActive(0);
  showView('view-analysis');

  if (pollTimer) clearInterval(pollTimer);
  currentJobId = jobId;
  pollJob();
  pollTimer = setInterval(pollJob, 3000);
}

function setStepActive(idx) {
  document.querySelectorAll('#steps li').forEach(li => {
    const i = parseInt(li.dataset.step);
    li.classList.remove('active', 'done');
    if (i < idx) li.classList.add('done');
    else if (i === idx) li.classList.add('active');
  });
}

let simStep = 0;
async function pollJob() {
  if (!currentJobId) return;
  try {
    const job = await api.getJob(currentJobId);
    if (job.status === 'running') {
      // Cycle through sub-steps visually
      if (simStep < 3) { simStep++; setStepActive(simStep); }
    } else if (job.status === 'done') {
      clearInterval(pollTimer);
      setStepActive(4);
      document.querySelectorAll('#steps li').forEach(li => li.classList.add('done'));
      showResult(job.result);
    } else if (job.status === 'failed') {
      clearInterval(pollTimer);
      showError(job.error || 'Unknown error');
    }
  } catch (err) {
    clearInterval(pollTimer);
    showError(err.message);
  }
}

function showResult(result) {
  const box = document.getElementById('analysis-result');
  const rows = [];
  if (result.entity_name) rows.push(['Company', result.entity_name]);
  if (result.market_price != null) rows.push(['Price', `$${Number(result.market_price).toFixed(2)}`]);
  if (result.summary?.rating) rows.push(['Rating', result.summary.rating]);
  if (result.summary?.price_target) rows.push(['Price Target', `$${result.summary.price_target}`]);
  box.innerHTML = rows.map(([k, v]) => `<div class="row"><strong>${k}:</strong> ${v}</div>`).join('');
  box.style.display = 'block';

  const btn = document.getElementById('view-report-btn');
  btn.style.display = 'block';
  btn.onclick = () => openReport(document.getElementById('analysis-ticker').textContent);
}

function showError(msg) {
  const box = document.getElementById('analysis-error');
  box.textContent = msg;
  box.style.display = 'block';
}

// ---------- Report view ----------
async function openReport(ticker) {
  document.getElementById('report-ticker').textContent = ticker;
  document.getElementById('report-price').textContent = '';
  document.getElementById('report-generated').textContent = '';
  document.getElementById('report-content').textContent = 'Loading…';
  showView('view-report');

  document.getElementById('download-docx').onclick = () =>
    window.location.href = `${API_BASE}/api/download/${ticker}/docx?token=${getToken()}`;
  document.getElementById('download-pptx').onclick = () =>
    window.location.href = `${API_BASE}/api/download/${ticker}/pptx?token=${getToken()}`;

  try {
    const [report, quote] = await Promise.all([
      api.getReport(ticker),
      api.getQuote(ticker).catch(() => null),
    ]);
    if (quote?.price) {
      document.getElementById('report-price').textContent = `$${Number(quote.price).toFixed(2)}`;
    }
    document.getElementById('report-generated').textContent = `Generated ${formatDateTime(report.generated_at)}`;
    document.getElementById('report-content').innerHTML = marked.parse(report.report_md);
  } catch (err) {
    document.getElementById('report-content').textContent = 'Error: ' + err.message;
  }
}

// ============================================================================
// PORTFOLIO FLOW
// ============================================================================
const portfolioFileInput = document.getElementById('portfolio-file');
const portfolioFileInfo = document.getElementById('portfolio-file-info');
const portfolioRunBtn = document.getElementById('portfolio-run-btn');
const portfolioProgressCard = document.getElementById('portfolio-progress-card');
const portfolioStatusText = document.getElementById('portfolio-status-text');
const portfolioResultBox = document.getElementById('portfolio-result');
const portfolioErrorBox = document.getElementById('portfolio-error');
const portfolioDownloadBtn = document.getElementById('portfolio-download-btn');

let portfolioJobId = null;
let portfolioPollTimer = null;

if (portfolioFileInput) {
  portfolioFileInput.addEventListener('change', () => {
    const f = portfolioFileInput.files?.[0];
    if (f) {
      portfolioFileInfo.textContent = `📄 ${f.name} — ${(f.size / 1024).toFixed(1)} KB`;
      portfolioRunBtn.disabled = false;
    } else {
      portfolioFileInfo.textContent = '';
      portfolioRunBtn.disabled = true;
    }
  });
}

if (portfolioRunBtn) {
  portfolioRunBtn.addEventListener('click', async () => {
    const file = portfolioFileInput.files?.[0];
    if (!file) return;
    // Strategy selector removed from the UI — backend always returns all
    // three (current / pro / allin); 'current' is fine as the canonical primary.
    const strategy = 'current';
    const reuse = document.getElementById('portfolio-reuse').checked;
    const gamma = document.getElementById('portfolio-gamma').checked;

    const fd = new FormData();
    fd.append('file', file);
    fd.append('strategy', strategy);
    fd.append('reuse_existing', reuse ? 'true' : 'false');
    fd.append('generate_gamma', gamma ? 'true' : 'false');

    portfolioRunBtn.disabled = true;
    portfolioRunBtn.textContent = 'Starting…';
    portfolioProgressCard.style.display = 'block';
    portfolioStatusText.textContent = reuse ? 'Queued…' : 'Clearing cache…';
    portfolioResultBox.style.display = 'none';
    portfolioErrorBox.style.display = 'none';
    portfolioDownloadBtn.style.display = 'none';

    try {
      // If the user turned reuse OFF, wipe the server-side report cache first
      // so every ticker is re-analyzed against the newest data.
      if (!reuse) {
        try {
          const cleared = await api.clearCache();
          portfolioStatusText.textContent =
            `Cache cleared (${cleared.count || 0} report${cleared.count === 1 ? '' : 's'}) — queuing…`;
        } catch (e) {
          // Non-fatal: proceed even if the cache endpoint hiccups.
          console.warn('Cache clear failed before run:', e);
        }
      }
      const job = await api.startPortfolio(fd);
      portfolioJobId = job.job_id;
      if (portfolioPollTimer) clearInterval(portfolioPollTimer);
      pollPortfolio();
      portfolioPollTimer = setInterval(pollPortfolio, 4000);
    } catch (err) {
      portfolioErrorBox.textContent = err.message;
      portfolioErrorBox.style.display = 'block';
    } finally {
      portfolioRunBtn.disabled = false;
      portfolioRunBtn.textContent = 'RUN REBALANCE';
    }
  });
}

async function pollPortfolio() {
  if (!portfolioJobId) return;
  try {
    const job = await api.getPortfolioJob(portfolioJobId);
    if (job.status === 'queued' || job.status === 'running') {
      // Real progress (per-ticker counter + bar) when the backend supplies
      // it; legacy fallback otherwise so older servers still work.
      const p = job.progress;
      if (p) {
        const pct = Math.max(0, Math.min(1, Number(p.pct ?? 0)));
        const counter = p.ticker_total
          ? `${p.ticker_index || 0}/${p.ticker_total}`
          : '';
        const tallies = (p.ok?.length || p.failed?.length)
          ? `${p.ok?.length || 0} ok${p.failed?.length ? ` · ${p.failed.length} failed` : ''}`
          : '';
        portfolioStatusText.innerHTML = `
          <div class="ppt-progress">
            <div class="ppt-bar"><div class="ppt-bar-fill" style="width:${(pct * 100).toFixed(1)}%"></div></div>
            <div class="ppt-meta">
              <span class="ppt-label">${(p.label || 'Working…').replace(/[<>&]/g, '')}</span>
              ${counter ? `<span class="ppt-counter">${counter}</span>` : ''}
            </div>
            ${tallies ? `<div class="ppt-tallies">${tallies}</div>` : ''}
          </div>`;
      } else {
        portfolioStatusText.textContent =
          `${job.status === 'running' ? 'Analyzing' : 'Queued'} — ${job.n_tickers} tickers (${job.strategy})…`;
      }
    } else if (job.status === 'done') {
      clearInterval(portfolioPollTimer);
      portfolioStatusText.textContent = `✅ Done — ${job.n_tickers} tickers analyzed`;
      renderPortfolioResult(job.result);
      portfolioDownloadBtn.style.display = 'block';
      portfolioDownloadBtn.onclick = () =>
        window.location.href = api.portfolioDownloadUrl(portfolioJobId);
      // Persist for "Last portfolio run" card.
      persistPortfolioLast({
        job_id: portfolioJobId,
        n_tickers: job.n_tickers,
        strategy: job.strategy,
        completed_at: new Date().toISOString(),
        result: job.result,
      });
    } else if (job.status === 'failed') {
      clearInterval(portfolioPollTimer);
      portfolioStatusText.textContent = '❌ Failed';
      portfolioErrorBox.textContent = job.error || 'Unknown error';
      portfolioErrorBox.style.display = 'block';
      // Still render any partial results / per-ticker errors so the user can see what went wrong.
      if (job.result) renderPortfolioResult(job.result);
    }
  } catch (err) {
    clearInterval(portfolioPollTimer);
    portfolioErrorBox.textContent = err.message;
    portfolioErrorBox.style.display = 'block';
  }
}

// ---------- Last portfolio persistence ----------
const LAST_PORTFOLIO_KEY = 'dga_last_portfolio';

function persistPortfolioLast(payload) {
  try {
    localStorage.setItem(LAST_PORTFOLIO_KEY, JSON.stringify(payload));
  } catch { /* quota — ignore */ }
}
function readPortfolioLast() {
  try {
    const raw = localStorage.getItem(LAST_PORTFOLIO_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function rehydratePortfolioLastCard() {
  const card = document.getElementById('portfolio-last-card');
  if (!card) return;
  const last = readPortfolioLast();
  if (!last) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  document.getElementById('portfolio-last-date').textContent =
    `Ran ${formatDateTime(last.completed_at)} — ${last.n_tickers} tickers (${last.strategy})`;
  const body = document.getElementById('portfolio-last-result');
  body.innerHTML = buildPortfolioResultHtml(last.result);

  const dlBtn = document.getElementById('portfolio-last-download-btn');
  if (dlBtn) {
    if (last.job_id) {
      dlBtn.onclick = () => window.location.href = api.portfolioDownloadUrl(last.job_id);
      dlBtn.style.display = 'block';
    } else {
      dlBtn.style.display = 'none';
    }
  }
  const viewBtn = document.getElementById('portfolio-last-view-btn');
  if (viewBtn) viewBtn.onclick = openPortfolioSummary;
}

// ---------- Last portfolio card on Research page ----------
async function loadLastPortfolioCard() {
  const card = document.getElementById('last-portfolio-card');
  if (!card) return;
  try {
    const info = await api.getLastPortfolio();
    if (!info || !info.exists) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    document.getElementById('last-portfolio-date').textContent =
      `Last run ${formatDateTime(info.generated_at)}`;
    document.getElementById('last-portfolio-title').textContent =
      info.title || 'Portfolio Review';
    document.getElementById('view-last-portfolio-btn').onclick = openPortfolioSummary;
  } catch {
    card.style.display = 'none';
  }
}

async function openPortfolioSummary() {
  document.getElementById('portfolio-summary-generated').textContent = '';
  document.getElementById('portfolio-summary-content').textContent = 'Loading…';
  showView('view-portfolio-summary');
  try {
    const info = await api.getPortfolioSummary();
    if (info?.generated_at) {
      document.getElementById('portfolio-summary-generated').textContent =
        `Generated ${formatDateTime(info.generated_at)}`;
    }
    document.getElementById('portfolio-summary-content').innerHTML =
      marked.parse(info?.summary_md || '_No portfolio summary available yet._');
  } catch (err) {
    document.getElementById('portfolio-summary-content').textContent =
      'Error loading portfolio summary: ' + err.message;
  }
}

function buildPortfolioResultHtml(result) {
  if (!result) return '';
  const primary = result.primary_strategy;
  const order = [primary, ...Object.keys(result.strategies || {}).filter(k => k !== primary)];
  const blocks = order.map(k => {
    const s = (result.strategies || {})[k];
    if (!s) return '';
    const weights = Object.entries(s.weights || {})
      .sort(([, a], [, b]) => b - a)
      .map(([t, w]) => `<span class="pill">${t} <strong>${(w * 100).toFixed(1)}%</strong></span>`)
      .join('');
    const isPrimary = k === primary;
    return `
      <div class="strategy-result ${isPrimary ? 'primary' : ''}">
        <div class="strategy-result-head">
          <span class="strategy-result-title">${s.label}${isPrimary ? ' — Primary' : ''}</span>
          <span class="strategy-result-count">${s.held} positions</span>
        </div>
        <div class="strategy-result-pills">${weights || '<em>No positions</em>'}</div>
      </div>`;
  }).join('');

  let failedHtml = '';
  const failed = result.tickers_failed || [];
  if (failed.length > 0) {
    const rows = failed.map(f =>
      `<div class="failed-ticker-row"><strong>${f.ticker}</strong>: ${f.error || 'Unknown error'}</div>`
    ).join('');
    failedHtml = `
      <div class="failed-section">
        <div class="label" style="margin-top:14px;">FAILED TICKERS (${failed.length})</div>
        <div class="failed-ticker-list">${rows}</div>
      </div>`;
  }

  let emailHtml = '';
  const email = result.email;
  if (email && !email.skipped) {
    if (email.ok) {
      emailHtml = `<div class="email-status-ok">📧 Report emailed to ${email.sent_to || 'recipient'}</div>`;
    } else {
      const reason = email.error || 'Unknown error';
      emailHtml = `<div class="email-status-err">📧 Email not sent — ${reason}</div>`;
    }
  }

  return blocks + failedHtml + emailHtml;
}

function renderPortfolioResult(result, target) {
  const el = target || portfolioResultBox;
  if (!el) return;
  el.innerHTML = buildPortfolioResultHtml(result);
  el.style.display = 'block';
}

// Strategy selector was removed from the UI — every run produces all three
// (current / pro / allin) so there's nothing to load. Keep a no-op here in
// case any caller still references it.
async function loadStrategies() { /* no-op */ }

// ============================================================================
// REAL-TIME PRICES — inject live price tags into the Saved Reports list
// ============================================================================
async function injectReportPrices(reports) {
  if (!reports || !reports.length) return;
  // Fan out all quote fetches in parallel — non-blocking, best-effort.
  const fetches = reports.map(async r => {
    const priceEl  = document.getElementById(`price-tag-${r.ticker}`);
    const targetEl = document.getElementById(`target-tag-${r.ticker}`);
    if (!priceEl) return;
    try {
      const q = await api.getQuote(r.ticker);
      if (!q?.price) {
        priceEl.innerHTML = '<span class="rr-price-missing">—</span>';
        return;
      }
      const price = Number(q.price);
      const prev  = Number(q.previous_close);
      let pct = q?.pct_change ?? null;
      if (pct == null && prev > 0) pct = ((price - prev) / prev) * 100;

      let html = `<span class="rr-price">$${price.toFixed(2)}</span>`;
      if (pct != null) {
        const sign = pct >= 0 ? '+' : '';
        const cls  = pct > 0 ? 'up' : pct < 0 ? 'down' : '';
        html += `<span class="rr-pct ${cls}">${sign}${pct.toFixed(2)}%</span>`;
        priceEl.title = `${sign}${pct.toFixed(2)}% today`;
      }
      priceEl.innerHTML = html;

      // Recompute target upside against the live price so it's in sync
      // intraday (the server's stored upside_pct is from report-time close).
      if (r.price_target != null) {
        const tgt    = Number(r.price_target);
        const upside = price > 0 ? ((tgt - price) / price) * 100 : null;
        // Write back so sort-by-upside uses live value
        r._liveUpside = upside;
        if (targetEl) {
          let h = `<span class="rr-target-label">TGT</span>`;
          h    += `<span class="rr-target">$${tgt.toFixed(0)}</span>`;
          if (upside != null) {
            const sign = upside >= 0 ? '+' : '';
            const cls  = upside >= 0 ? 'up' : 'down';
            h += `<span class="rr-upside ${cls}">${sign}${upside.toFixed(1)}%</span>`;
            targetEl.title = `12M target $${tgt.toFixed(0)} = ${sign}${upside.toFixed(1)}% upside vs $${price.toFixed(2)}`;
          }
          targetEl.innerHTML = h;
        }
      }
    } catch { /* non-fatal */ }
  });
  await Promise.allSettled(fetches);
}

// ============================================================================
// WATCHLIST — manage the persistent ticker list for market scans
// ============================================================================
let _watchlist = [];

async function loadWatchlist() {
  try {
    const data = await api.getWatchlist();
    _watchlist = data.tickers || [];
  } catch {
    _watchlist = [];
  }
  renderWatchlistChips();
}

function renderWatchlistChips() {
  const container = document.getElementById('scan-watchlist-chips');
  if (!container) return;
  if (!_watchlist.length) {
    container.innerHTML = '<span class="scan-watchlist-empty">Add tickers to scan…</span>';
    return;
  }
  container.innerHTML = _watchlist.map(t => `
    <span class="watchlist-chip" data-ticker="${t}">
      ${t}
      <button class="watchlist-chip-remove" data-ticker="${t}" title="Remove">×</button>
    </span>
  `).join('');
  container.querySelectorAll('.watchlist-chip-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removeWatchlistTicker(btn.dataset.ticker);
    });
  });
}

async function addWatchlistTicker(ticker) {
  const t = ticker.trim().toUpperCase().replace(/[^A-Z.]/g, '');
  if (!t) return;
  try {
    const data = await api.addWatchlistTicker(t);
    _watchlist = data.tickers || [];
    renderWatchlistChips();
    renderScanPlaceholderRow(t);
  } catch (err) {
    console.warn('Could not add to watchlist:', err.message);
  }
}

async function removeWatchlistTicker(ticker) {
  try {
    const data = await api.removeWatchlistTicker(ticker);
    _watchlist = data.tickers || [];
    renderWatchlistChips();
    // Remove the result panel for this ticker if present.
    const panel = document.getElementById(`scan-panel-${ticker}`);
    if (panel) panel.remove();
  } catch (err) {
    console.warn('Could not remove from watchlist:', err.message);
  }
}

// Wire up the Add button and Enter key
document.getElementById('scan-add-btn')?.addEventListener('click', () => {
  const input = document.getElementById('scan-add-input');
  if (input?.value) { addWatchlistTicker(input.value); input.value = ''; }
});
document.getElementById('scan-add-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const input = e.target;
    if (input.value) { addWatchlistTicker(input.value); input.value = ''; }
  }
  // Force uppercase as you type
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z.]/g, '');
});
document.getElementById('scan-add-input')?.addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z.]/g, '');
});

// ============================================================================
// MARKET SCAN — run + display expandable per-ticker panels
// ============================================================================
let _scanJobId = null;
let _scanPollTimer = null;

document.getElementById('scan-run-btn')?.addEventListener('click', startScan);

async function startScan() {
  const btn = document.getElementById('scan-run-btn');
  if (!btn) return;
  if (!_watchlist.length) {
    alert('Add at least one ticker to the watchlist first.');
    return;
  }
  btn.disabled = true;
  btn.textContent = '⏳ Scanning…';
  btn.classList.add('scanning');

  // Pre-show loading spinners for each watchlist ticker.
  _watchlist.forEach(t => renderScanLoadingPanel(t));

  try {
    const job = await api.startScan();
    _scanJobId = job.job_id;
    if (_scanPollTimer) clearInterval(_scanPollTimer);
    _scanPollTimer = setInterval(() => pollScan(_scanJobId), 4000);
    pollScan(_scanJobId); // immediate first poll
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '⚡ Scan Now';
    btn.classList.remove('scanning');
    alert('Scan error: ' + err.message);
  }
}

async function pollScan(jobId) {
  if (!jobId) return;
  try {
    const job = await api.getScanJob(jobId);
    // Render any completed results (partial streaming)
    if (job.results) {
      for (const [ticker, result] of Object.entries(job.results)) {
        renderScanPanel(ticker, result);
      }
    }
    if (job.status === 'done' || job.status === 'failed') {
      clearInterval(_scanPollTimer);
      _scanPollTimer = null;
      const btn = document.getElementById('scan-run-btn');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '⚡ Scan Now';
        btn.classList.remove('scanning');
      }
      if (job.scanned_at) {
        const el = document.getElementById('scan-last-time');
        if (el) el.textContent = `Last scan: ${formatDateTime(job.scanned_at + 'Z')}`;
      }
    }
  } catch (err) {
    console.warn('Scan poll error:', err.message);
  }
}

async function loadLatestScan() {
  try {
    const data = await api.getLatestScan();
    if (!data?.exists || !data.results) return;
    for (const [ticker, result] of Object.entries(data.results)) {
      renderScanPanel(ticker, result);
    }
    if (data.scanned_at) {
      const el = document.getElementById('scan-last-time');
      if (el) el.textContent = `Last scan: ${formatDateTime(data.scanned_at + 'Z')}`;
    }
  } catch { /* first boot, no results yet */ }
}

// Inject a "loading…" placeholder panel before the scan result arrives.
function renderScanLoadingPanel(ticker) {
  const list = document.getElementById('scan-results-list');
  if (!list) return;
  let panel = document.getElementById(`scan-panel-${ticker}`);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = `scan-panel-${ticker}`;
    panel.className = 'scan-result-panel';
    list.appendChild(panel);
  }
  panel.innerHTML = `
    <div class="scan-result-header" onclick="toggleScanPanel('${ticker}')">
      <span class="scan-ticker-label">${ticker}</span>
      <div class="scan-price-info">
        <span class="scan-price-num">—</span>
      </div>
      <span class="scan-sentiment-badge UNKNOWN">SCANNING</span>
      <span class="scan-chevron">›</span>
    </div>
    <div class="scan-result-body">
      <div class="scan-result-loading">
        <span style="animation:pulse 1.2s ease-in-out infinite;display:inline-block;">📡</span>
        Fetching live data…
      </div>
    </div>`;
}

// Add an empty placeholder row for a newly-added ticker (no scan yet).
function renderScanPlaceholderRow(ticker) {
  const list = document.getElementById('scan-results-list');
  if (!list || document.getElementById(`scan-panel-${ticker}`)) return;
  const panel = document.createElement('div');
  panel.id = `scan-panel-${ticker}`;
  panel.className = 'scan-result-panel';
  panel.innerHTML = `
    <div class="scan-result-header" onclick="toggleScanPanel('${ticker}')">
      <span class="scan-ticker-label">${ticker}</span>
      <div class="scan-price-info"><span class="scan-price-num">—</span></div>
      <span class="scan-sentiment-badge UNKNOWN">—</span>
      <span class="scan-chevron">›</span>
    </div>
    <div class="scan-result-body">
      <p style="font-size:13px;color:var(--mid-gray);padding:12px 0;">
        Press ⚡ Scan Now to run a live news scan for ${ticker}.
      </p>
    </div>`;
  list.appendChild(panel);
}

// Render (or update) a completed scan result panel.
function renderScanPanel(ticker, result) {
  const list = document.getElementById('scan-results-list');
  if (!list) return;
  let panel = document.getElementById(`scan-panel-${ticker}`);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = `scan-panel-${ticker}`;
    panel.className = 'scan-result-panel';
    list.appendChild(panel);
  }

  const price  = result.price  ? `$${Number(result.price).toFixed(2)}` : '—';
  const prev   = result.previous_close;
  const pct    = result.pct_change;
  const sign   = (pct ?? 0) >= 0 ? '+' : '';
  const pctTxt = pct != null ? `${sign}${pct.toFixed(2)}%` : '';
  const pctCls = pct == null ? 'flat' : pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const sentiment = result.sentiment || 'UNKNOWN';
  const wasOpen = panel.classList.contains('open');

  // Apply sentiment class to panel for left-border colour
  panel.className = `scan-result-panel ${sentiment}`;

  // Full detail — open the scan detail view.
  const mdHtml = result.ok && result.markdown
    ? `<div class="report-content">${marked.parse(result.markdown)}</div>`
    : `<div class="scan-error-label">${result.error || 'No data'}</div>`;

  panel.innerHTML = `
    <div class="scan-result-header" onclick="toggleScanPanel('${ticker}')">
      <span class="scan-ticker-label">${ticker}</span>
      <div class="scan-price-info">
        <span class="scan-price-num">${price}</span>
        ${pctTxt ? `<span class="scan-price-chg ${pctCls}">${pctTxt}</span>` : ''}
      </div>
      <span class="scan-sentiment-badge ${sentiment}">${sentiment}</span>
      <span class="scan-chevron">›</span>
    </div>
    <div class="scan-result-body">${mdHtml}</div>`;

  if (wasOpen) panel.classList.add('open');
}

function toggleScanPanel(ticker) {
  const panel = document.getElementById(`scan-panel-${ticker}`);
  if (!panel) return;
  panel.classList.toggle('open');
}

// ============================================================================
// Reports — sortable by TGT/UPSIDE, live-price aware
// ============================================================================
let _reportsCache  = [];   // full reports array, mutated by injectReportPrices
let _reportsSortDir = 'desc'; // 'desc' = highest upside first

const _yr = new Date().getFullYear();
function _compactDate(iso) {
  try {
    const d = new Date(iso);
    const opts = d.getFullYear() === _yr
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: '2-digit' };
    return d.toLocaleDateString('en-US', opts);
  } catch { return ''; }
}

function _targetCellHtml(r) {
  if (r.price_target == null) return '<span class="rr-target-missing">—</span>';
  const tgt = Number(r.price_target);
  // prefer live upside written back by injectReportPrices
  const pct = r._liveUpside != null ? r._liveUpside
            : r.upside_pct  != null ? Number(r.upside_pct) : null;
  let html = `<span class="rr-target-label">TGT</span>`;
  html    += `<span class="rr-target">$${tgt.toFixed(0)}</span>`;
  if (pct != null) {
    const sign = pct >= 0 ? '+' : '';
    const cls  = pct >= 0 ? 'up' : 'down';
    html += `<span class="rr-upside ${cls}">${sign}${pct.toFixed(1)}%</span>`;
  }
  return html;
}

function _sortedReports(dir) {
  return [..._reportsCache].sort((a, b) => {
    // Use live upside if available, else stored upside_pct
    const ua = (a._liveUpside ?? (a.upside_pct != null ? Number(a.upside_pct) : null));
    const ub = (b._liveUpside ?? (b.upside_pct != null ? Number(b.upside_pct) : null));
    const va = ua != null ? ua : -Infinity;
    const vb = ub != null ? ub : -Infinity;
    return dir === 'desc' ? vb - va : va - vb;
  });
}

function _renderReportRows() {
  const list = document.getElementById('reports-list');
  if (!list) return;
  const sorted = _sortedReports(_reportsSortDir);
  const arrow  = _reportsSortDir === 'desc' ? ' ▼' : ' ▲';

  list.innerHTML = `
    <div class="reports-table">
      <div class="reports-col-header">
        <span>TICKER</span>
        <span class="rch-price">PRICE</span>
        <span class="rch-target rch-sortable" id="rch-upside-toggle" title="Click to sort">TGT / UPSIDE${arrow}</span>
      </div>
      ${sorted.map(r => `
        <div class="report-row" data-ticker="${r.ticker}">
          <div class="rr-ticker-cell">
            <div class="rr-ticker">${r.ticker}</div>
            <div class="rr-meta">
              ${r.has_docx ? '<span class="rr-pill rr-pill-doc" title="Word report available">DOC</span>' : ''}
              ${r.has_pptx ? '<span class="rr-pill rr-pill-ppt" title="Gamma deck available">PPT</span>' : ''}
              <span class="rr-date">${_compactDate(r.generated_at)}</span>
            </div>
          </div>
          <div class="rr-price-cell" id="price-tag-${r.ticker}">…</div>
          <div class="rr-target-cell" id="target-tag-${r.ticker}">${_targetCellHtml(r)}</div>
          <span class="rr-chev">›</span>
        </div>
      `).join('')}
    </div>
  `;

  list.querySelectorAll('.report-row').forEach(el => {
    el.addEventListener('click', () => openReport(el.dataset.ticker));
  });

  // Sort toggle on the column header
  const toggleEl = document.getElementById('rch-upside-toggle');
  if (toggleEl) {
    toggleEl.addEventListener('click', () => {
      _reportsSortDir = _reportsSortDir === 'desc' ? 'asc' : 'desc';
      _renderReportRows();
      // Re-fill already-fetched prices (DOM was rebuilt, cells are empty again)
      injectReportPrices(_reportsCache);
    });
  }
}

async function loadReports() {
  const list = document.getElementById('reports-list');
  try {
    _reportsCache = await api.listReports();
    if (!_reportsCache.length) {
      list.innerHTML = '<div class="empty">No reports yet. Run your first analysis above.</div>';
      const countEl = document.getElementById('reports-count');
      if (countEl) countEl.style.display = 'none';
      return;
    }
    const countEl = document.getElementById('reports-count');
    if (countEl) {
      countEl.textContent = _reportsCache.length;
      countEl.style.display = 'inline-block';
    }
    _reportsSortDir = 'desc'; // always start highest-first on fresh load
    _renderReportRows();
    // Kick off live price fetches; injectReportPrices writes _liveUpside back
    injectReportPrices(_reportsCache);
  } catch (err) {
    list.innerHTML = `<div class="empty">Could not load reports: ${err.message}</div>`;
  }
}

// ---------- Boot ----------
async function boot() {
  checkServer();
  loadReports();
  loadStrategies();
  loadLastPortfolioCard();
  rehydratePortfolioLastCard();
  loadWatchlist();
  loadLatestScan();
  initIntelligence();
  initTracker();
}

// On load: if we have a stored token, validate it; otherwise show login.
(async () => {
  if (getToken()) {
    try {
      await apiGet('/api/reports'); // lightweight auth check
      hideLogin();
      boot();
    } catch {
      showLogin();
    }
  } else {
    showLogin();
  }
})();

setInterval(checkServer, 30000);

// ============================================================================
// INTELLIGENCE — macro → sector → company idea generation
// ============================================================================

let _intelSector = 'Tech';
let _intelPollTimer = null;
let _briefPollTimer = null;

function initIntelligence() {
  // Sector pill wiring
  document.querySelectorAll('.intel-horizon-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.intel-horizon-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _intelSector = btn.dataset.sector || btn.dataset.days || 'Tech';
    });
  });

  // Run buttons
  document.getElementById('intel-run-btn')?.addEventListener('click', runIntelligence);
  document.getElementById('brief-run-btn')?.addEventListener('click', runDailyBrief);

  // Load latest persisted brief — show whichever is freshest
  loadLatestBriefs();
}

async function loadLatestBriefs() {
  try {
    const [intelRes, briefRes] = await Promise.allSettled([
      api.getLatestIntelligence(),
      api.getLatestDailyBrief(),
    ]);
    const intel = intelRes.status === 'fulfilled' && intelRes.value?.exists
      ? intelRes.value : null;
    const brief = briefRes.status === 'fulfilled' && briefRes.value?.exists
      ? briefRes.value : null;
    const intelDate = intel ? new Date(intel.generated_at).getTime() : 0;
    const briefDate = brief ? new Date(brief.generated_at).getTime() : 0;
    if (briefDate >= intelDate && brief?.markdown) {
      renderIntelResult(brief, 'brief');
    } else if (intel?.markdown) {
      renderIntelResult(intel, 'intel');
    }
  } catch { /* server offline — silent */ }
}

async function runIntelligence() {
  const btn = document.getElementById('intel-run-btn');
  const statusEl = document.getElementById('intel-status');
  const errEl = document.getElementById('intel-error');
  const briefBtn = document.getElementById('brief-run-btn');

  btn.disabled = true;
  if (briefBtn) briefBtn.disabled = true;
  btn.textContent = '⏳ Running…';
  statusEl.style.display = 'block';
  statusEl.textContent = 'Queued — starting shortly…';
  errEl.style.display = 'none';
  document.getElementById('intel-empty').style.display = 'none';

  clearInterval(_intelPollTimer);

  const reset = () => {
    btn.disabled = false;
    if (briefBtn) briefBtn.disabled = false;
    btn.textContent = '💡 Run Intelligence';
    statusEl.style.display = 'none';
  };

  try {
    const job = await api.startIntelligence(_intelSector);
    _intelPollTimer = setInterval(async () => {
      try {
        const j = await api.getIntelligenceJob(job.job_id);
        if (j.status === 'done') {
          clearInterval(_intelPollTimer);
          reset();
          if (j.result?.ok) renderIntelResult(j.result, 'intel');
          else showIntelError(j.result?.error || j.error || 'Unknown error');
        } else if (j.status === 'failed') {
          clearInterval(_intelPollTimer);
          reset();
          showIntelError(j.error || 'Intelligence run failed');
        } else {
          statusEl.textContent = j.status === 'running'
            ? 'Scanning X and web for market signals…'
            : 'Queued — starting shortly…';
        }
      } catch (err) {
        clearInterval(_intelPollTimer);
        reset();
        showIntelError(err.message);
      }
    }, 3000);
  } catch (err) {
    reset();
    showIntelError(err.message);
  }
}

async function runDailyBrief() {
  const btn = document.getElementById('brief-run-btn');
  const statusEl = document.getElementById('brief-status');
  const errEl = document.getElementById('intel-error');
  const intelBtn = document.getElementById('intel-run-btn');

  if (!btn) return;
  btn.disabled = true;
  if (intelBtn) intelBtn.disabled = true;
  btn.textContent = '⏳ Pulling overnight tape…';
  statusEl.style.display = 'block';
  statusEl.textContent = 'Queued — starting shortly…';
  errEl.style.display = 'none';
  document.getElementById('intel-empty').style.display = 'none';

  clearInterval(_briefPollTimer);

  const reset = () => {
    btn.disabled = false;
    if (intelBtn) intelBtn.disabled = false;
    btn.textContent = '📰 Generate Daily Brief';
    statusEl.style.display = 'none';
  };

  try {
    const job = await api.startDailyBrief();
    _briefPollTimer = setInterval(async () => {
      try {
        const j = await api.getDailyBriefJob(job.job_id);
        if (j.status === 'done') {
          clearInterval(_briefPollTimer);
          reset();
          if (j.result?.ok) renderIntelResult(j.result, 'brief');
          else showIntelError(j.result?.error || j.error || 'Unknown error');
        } else if (j.status === 'failed') {
          clearInterval(_briefPollTimer);
          reset();
          showIntelError(j.error || 'Daily brief failed');
        } else {
          statusEl.textContent = j.status === 'running'
            ? 'Scanning overnight tape, X, and headlines…'
            : 'Queued — starting shortly…';
        }
      } catch (err) {
        clearInterval(_briefPollTimer);
        reset();
        showIntelError(err.message);
      }
    }, 3000);
  } catch (err) {
    reset();
    showIntelError(err.message);
  }
}

function showIntelError(msg) {
  const el = document.getElementById('intel-error');
  el.style.display = 'block';
  el.textContent = `⚠ ${msg}`;
}

// Stash the latest brief so the "Track this brief" button knows what to lock in.
let _latestBrief = null;

function renderIntelResult(data, kind = 'intel') {
  _latestBrief = { ...data, kind };

  // Hide empty state
  document.getElementById('intel-empty').style.display = 'none';

  // Meta
  const card = document.getElementById('intel-result-card');
  card.style.display = 'block';

  // Badge styling — gold for daily brief, navy for strategic intelligence
  const badgeEl = document.getElementById('intel-kind-badge');
  if (badgeEl) {
    if (kind === 'brief') {
      badgeEl.textContent = '📰 DAILY BRIEF';
      badgeEl.classList.add('brief');
    } else {
      badgeEl.textContent = '⚡ LIVE BRIEF';
      badgeEl.classList.remove('brief');
    }
  }

  // Sub-label: sector for intel, today's date for brief
  document.getElementById('intel-days-label').textContent =
    kind === 'brief'
      ? (data.date_str || 'Today')
      : (data.sector || (data.days ? `${data.days}d` : 'Strategic'));
  document.getElementById('intel-generated-at').textContent =
    data.generated_at ? formatDate(data.generated_at) : '';

  // Ticker chips — each one navigates to the Research tab with that ticker
  const chipsWrap = document.getElementById('intel-tickers');
  const chipsEl   = document.getElementById('intel-ticker-chips');
  const tickers = data.tickers || [];
  if (tickers.length) {
    chipsEl.innerHTML = tickers.map(t =>
      `<button class="intel-chip" onclick="intelOpenTicker('${t}')">
        ${t}<span class="intel-chip-arrow"> →</span>
       </button>`
    ).join('');
    chipsWrap.style.display = 'block';
  } else {
    chipsWrap.style.display = 'none';
  }

  // Markdown body
  const mdEl = document.getElementById('intel-markdown');
  mdEl.innerHTML = data.markdown ? marked.parse(data.markdown) : '<p>No content.</p>';
}

function intelOpenTicker(ticker) {
  // Switch to Research tab and pre-fill the ticker input
  showView('view-home');
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.target === 'view-home');
  });
  const input = document.getElementById('ticker-input');
  if (input) {
    input.value = ticker.toUpperCase();
    input.focus();
  }
}

// ============================================================================
// PAPER PORTFOLIO TRACKER
// ============================================================================

let _trackerCache = [];
let _trackerExpandedId = null;

function initTracker() {
  // Load tracker and benchmark on Portfolio tab activation
  loadTrackers();
  loadLiveBenchmark();

  // "Track this brief" button on Intelligence view
  document.getElementById('intel-track-btn')?.addEventListener('click', openTrackModal);

  // Modal close handlers
  document.getElementById('track-modal-cancel')?.addEventListener('click', closeTrackModal);
  document.getElementById('track-modal-cancel-btn')?.addEventListener('click', closeTrackModal);
  document.getElementById('track-modal-lock-btn')?.addEventListener('click', submitTrack);
  document.getElementById('track-equal-btn')?.addEventListener('click', resetEqualWeights);

  // Detail card close
  document.getElementById('tracker-detail-close')?.addEventListener('click', closeTrackerDetail);
  document.getElementById('tracker-detail-close-portfolio')?.addEventListener('click', closeTrackerCurrent);
  document.getElementById('tracker-detail-delete')?.addEventListener('click', deleteTrackerCurrent);

  // Unified YTD: Modified Dietz return + per-stock attribution in one call
  document.getElementById('history-upload-btn')?.addEventListener('click', uploadAccountHistory);

  // Email the YTD report (only visible in live YTD detail mode)
  document.getElementById('tracker-email-btn')?.addEventListener('click', sendYtdEmail);

  // Pre-fill email field from previous use
  const lastEmail = localStorage.getItem('@dga_last_ytd_email') || '';
  const emailEl = document.getElementById('tracker-email-input');
  if (emailEl && lastEmail) emailEl.value = lastEmail;
}

// Track which snapshot is currently being viewed (null = current/latest live).
let _currentYtdSnapshotId = null;

// ── YTD snapshot history list ────────────────────────────────────────────
async function loadYtdSnapshots() {
  const card = document.getElementById('ytd-snapshots-card');
  const list = document.getElementById('ytd-snapshots-list');
  if (!card || !list) return;
  try {
    const [snapData, liveData] = await Promise.all([
      api.listYtdSnapshots(),
      api.getLiveBenchmark().catch(() => null),
    ]);
    const snaps = snapData?.snapshots || [];
    if (!snaps.length) { card.style.display = 'none'; return; }
    card.style.display = '';
    const currentId = liveData?.live_portfolio?.account_history?.id || null;
    list.innerHTML = snaps.map(s => _ytdSnapshotRowHtml(s, s.id === currentId)).join('');
    list.querySelectorAll('.ytd-snap-row').forEach(el => {
      el.addEventListener('click', async (ev) => {
        if (ev.target.closest('.ytd-snap-delete')) return;  // ignore delete clicks
        const snapId = el.dataset.id;
        // Promote this snapshot as the current run so the live benchmark
        // card and all downstream views reflect the selected run.
        try { await api.setCurrentYtdSnapshot(snapId); } catch (_) { /* non-fatal */ }
        // Reload live benchmark card (chips + account_history update)
        await loadLiveBenchmark();
        openLiveBenchmarkDetail(snapId);
      });
    });
    list.querySelectorAll('.ytd-snap-delete').forEach(el => {
      el.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const id = el.dataset.id;
        if (!confirm('Delete this snapshot? This cannot be undone.')) return;
        try {
          await api.deleteYtdSnapshot(id);
          await loadYtdSnapshots();
        } catch (e) { alert('Could not delete: ' + e.message); }
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="empty">Could not load: ${err.message}</div>`;
  }
}

function _ytdSnapshotRowHtml(s, isActive = false) {
  const md = s.md_return_pct ?? 0;
  const cls = md >= 0 ? 'green' : 'red';
  const sign = md >= 0 ? '+' : '';
  const dt = s.uploaded_at ? new Date(s.uploaded_at).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }) : '—';
  const usd0 = (v) => v == null ? '—' : (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', {maximumFractionDigits: 0});
  const activeBadge = isActive ? `<span class="ytd-snap-active-badge">active</span>` : '';
  return `<div class="ytd-snap-row${isActive ? ' ytd-snap-row--active' : ''}" data-id="${s.id}">
    <div class="ytd-snap-row-left">
      <div class="ytd-snap-date">${dt}${activeBadge}</div>
      <div class="ytd-snap-meta">
        ${usd0(s.begin_value)} → ${usd0(s.end_value)} ·
        ${s.positions_count} positions · ${s.trade_count} trades
      </div>
    </div>
    <div class="ytd-snap-row-right">
      <div class="ytd-snap-return ${cls}">${sign}${md.toFixed(2)}%</div>
      <button class="ytd-snap-delete" data-id="${s.id}" title="Delete snapshot">✕</button>
    </div>
  </div>`;
}

// ── Email YTD report ──────────────────────────────────────────────────────
async function sendYtdEmail() {
  const input = document.getElementById('tracker-email-input');
  const status = document.getElementById('tracker-email-status');
  const btn = document.getElementById('tracker-email-btn');
  const email = (input?.value || '').trim();
  if (!email || !email.includes('@')) {
    if (status) {
      status.textContent = 'Enter a valid email address.';
      status.className = 'tracker-email-status error';
    }
    return;
  }
  localStorage.setItem('@dga_last_ytd_email', email);

  btn.disabled = true;
  if (status) {
    status.textContent = 'Sending…';
    status.className = 'tracker-email-status pending';
  }
  try {
    const r = await api.emailYtdReport(email, _currentYtdSnapshotId);
    if (status) {
      status.textContent = `✓ Sent to ${r.sent_to || email} via ${r.transport || 'email'}.`;
      status.className = 'tracker-email-status ok';
    }
  } catch (err) {
    if (status) {
      status.textContent = `Error: ${err.message}`;
      status.className = 'tracker-email-status error';
    }
  } finally {
    btn.disabled = false;
  }
}

// ── Live benchmark card (clickable → YTD detail) ──────────────────────────
async function loadLiveBenchmark() {
  const wrap = document.getElementById('tracker-live-info');
  const card = document.getElementById('tracker-live-card');
  if (!wrap) return;

  try {
    const data = await api.getLiveBenchmark();
    const live = data?.live_portfolio;
    if (!live) {
      wrap.innerHTML = `<div class="tracker-live-empty">
        No live portfolio yet. Upload Fidelity CSVs in
        <strong>Fund → My Portfolio</strong> to set the benchmark.
      </div>`;
      card?.classList.remove('clickable');
      card?.removeAttribute('role');
      return;
    }

    const n = (live.holdings || []).length;
    const sorted = (live.holdings || [])
      .slice().sort((a, b) => b.weight - a.weight);
    const chipsHtml = sorted.map(h => {
      const mmClass = h.is_mm ? ' live-chip--cash' : '';
      const mmLabel = h.is_mm ? ' <span class="live-chip-mm">CASH</span>' : '';
      return `<span class="live-chip${mmClass}">
         <span class="live-chip-ticker">${h.ticker}</span>${mmLabel}
         <span class="live-chip-weight">${(h.weight * 100).toFixed(1)}%</span>
       </span>`;
    }).join('');

    const mdBadge = live.account_history
      ? `<span class="history-md-badge">MD</span>`
      : '';

    wrap.innerHTML = `
      <div class="tracker-live-line">
        <span class="tracker-live-key">ANCHOR DATE</span>
        <span class="tracker-live-value">${live.anchor_date || '—'}</span>
      </div>
      <div class="tracker-live-line">
        <span class="tracker-live-key">HOLDINGS</span>
        <span class="tracker-live-value">
          ${n} positions${mdBadge}
          <span class="live-drill-hint">View YTD detail →</span>
        </span>
      </div>
      <div class="live-chips-wrap">${chipsHtml}</div>`;
    // Make the entire card clickable (drill into YTD detail)
    card?.classList.add('clickable');
    card?.setAttribute('role', 'button');
    card.onclick = () => openLiveBenchmarkDetail();
  } catch {
    wrap.innerHTML = `<div class="tracker-live-empty">Could not load live benchmark.</div>`;
    card?.classList.remove('clickable');
    if (card) card.onclick = null;
  }
}

// ── Account history upload (Modified Dietz YTD) ───────────────────────────
// ── Unified YTD upload: Modified Dietz + per-stock attribution in one call ─
async function uploadAccountHistory() {
  const posInput   = document.getElementById('history-positions-file');
  const actInput   = document.getElementById('history-file');
  const perfInput  = document.getElementById('history-monthly-perf-file');
  const beginInput = document.getElementById('history-begin-value');
  const statusEl   = document.getElementById('history-upload-status');
  const resultBox  = document.getElementById('history-result-box');
  const btn        = document.getElementById('history-upload-btn');

  const posFile    = posInput?.files?.[0];
  const actFile    = actInput?.files?.[0];
  const perfFile   = perfInput?.files?.[0];   // optional
  const beginValue = parseFloat(beginInput?.value);

  if (!posFile)  { alert('Please select your Fidelity Positions CSV.'); return; }
  if (!actFile)  { alert('Please select your Fidelity Account History CSV.'); return; }
  // begin_value is optional when an Investment Income Balance CSV is supplied
  // (the CSV contains the Jan 1 starting balance in its first row)
  if ((!beginValue || beginValue <= 0) && !perfFile) {
    alert('Please enter your Jan 1 portfolio value, or upload an Investment Income Balance CSV (it contains the starting balance automatically).'); return;
  }

  btn.disabled = true;
  const perfMsg = perfFile ? ' + investment income balance' : '';
  if (statusEl) { statusEl.style.display = ''; statusEl.textContent = `Calculating YTD return + transaction attribution${perfMsg}…`; }
  if (resultBox) resultBox.style.display = 'none';

  try {
    const fd = new FormData();
    fd.append('positions_file', posFile);
    fd.append('activity_file',  actFile);
    // Only send begin_value when the user actually entered one
    if (beginValue && beginValue > 0) fd.append('begin_value', beginValue);
    fd.append('token', getToken());
    if (perfFile) fd.append('monthly_perf_file', perfFile);

    const res = await fetch(`${API_BASE}/api/track/live/ytd`, {
      method:  'POST',
      headers: { 'x-auth-token': getToken() },
      body:    fd,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    const data = await res.json();
    if (statusEl) statusEl.style.display = 'none';
    _renderUnifiedYtdResult(data);
    // Refresh the live benchmark card then auto-open the YTD detail view
    // so the user doesn't have to click the card to see results.
    await loadLiveBenchmark();
    openLiveBenchmarkDetail(data.snapshot_id || null);
  } catch (err) {
    if (statusEl) { statusEl.textContent = `Error: ${err.message}`; }
  } finally {
    btn.disabled = false;
  }
}

function _renderUnifiedYtdResult(data) {
  const box = document.getElementById('history-result-box');
  if (!box) return;

  const fmtUSD0 = (v) => {
    const abs = Math.abs(v ?? 0);
    return (v < 0 ? '−' : '') + '$' + Math.round(abs).toLocaleString('en-US', { maximumFractionDigits: 0 });
  };
  const fmtUSD2 = fmtUSD0;  // no cents on portfolio page
  const fmtPct  = (v, d=2) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
  const fmtSh   = (n) => n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const cls     = (v) => v == null ? '' : v >= 0 ? 'green' : 'red';
  const sign    = (v) => v == null ? '' : v >= 0 ? '+' : '';

  const md      = data.md_return_pct   ?? 0;
  const twrr    = data.twrr_return_pct ?? null;   // null = not computed yet
  const netFlow = data.net_flow        ?? 0;

  // ── Per-ticker attribution rows (clean, summarized) ──────────────────────
  const attribRows = (data.attribution || []).map(a => {
    // ── Missing Jan 1 price — fully sold, yfinance returned nothing ──────────
    if (a.price_missing) {
      const divChip = a.dividends_cash > 0
        ? `<span class="attr-chip div">div ${fmtUSD0(a.dividends_cash)}</span>` : '';
      const sellChip = a.total_sold_shares > 0
        ? `<span class="attr-chip sell">▼ ${fmtSh(a.total_sold_shares)} @ $${(a.total_sell_proceeds / a.total_sold_shares).toFixed(2)}</span>` : '';
      const activity = [sellChip, divChip].filter(Boolean).join(' ') || '<span class="attr-sub">—</span>';
      return `<tr class="attr-row-missing">
        <td class="attr-ticker">${a.ticker} <span class="attr-missing-badge" title="Jan 1 price unavailable — capital P&amp;L excluded from totals">?</span></td>
        <td class="attr-pos"><span class="attr-sub attr-missing-hint">Jan 1 price unavailable</span></td>
        <td class="attr-act">${activity}</td>
        <td class="attr-pos"><span class="attr-sub">fully sold</span></td>
        <td class="attr-num attr-muted" title="Capital gain unknown — only dividends shown">divs only</td>
        <td class="attr-num attr-muted">—</td>
      </tr>`;
    }

    // ── Money-market / cash row — interest-only, no shares reconstruction ──
    if (a.is_mm) {
      const divChip = a.dividends_cash > 0
        ? `<span class="attr-chip div">int ${fmtUSD0(a.dividends_cash)}</span>`
        : '<span class="attr-sub">—</span>';
      const endCell = a.end_value > 0
        ? `${fmtUSD0(a.end_value)}<br><span class="attr-sub">cash @ $1.00</span>`
        : '<span class="attr-sub">—</span>';
      return `<tr class="attr-row-mm">
        <td class="attr-ticker">${a.ticker} <span class="live-chip-mm">CASH</span></td>
        <td class="attr-pos"><span class="attr-sub">cash position</span></td>
        <td class="attr-act">${divChip}</td>
        <td class="attr-pos">${endCell}</td>
        <td class="attr-num ${cls(a.dollar_gain)}">${sign(a.dollar_gain)}${fmtUSD0(a.dollar_gain)}</td>
        <td class="attr-num attr-contrib ${cls(a.contribution_pct)}">${fmtPct(a.contribution_pct)}</td>
      </tr>`;
    }

    const sellChip = a.total_sold_shares > 0
      ? `<span class="attr-chip sell">▼ ${fmtSh(a.total_sold_shares)} @ $${(a.total_sell_proceeds / a.total_sold_shares).toFixed(2)}</span>` : '';
    const buyChip  = a.total_bought_shares > 0
      ? `<span class="attr-chip buy">▲ ${fmtSh(a.total_bought_shares)} @ $${(a.total_buy_cost / a.total_bought_shares).toFixed(2)}</span>` : '';
    const divChip  = a.dividends_cash > 0
      ? `<span class="attr-chip div">div ${fmtUSD0(a.dividends_cash)}</span>` : '';
    const activity = [sellChip, buyChip, divChip].filter(Boolean).join(' ') || '<span class="attr-sub">—</span>';

    const startCell = a.start_shares > 0
      ? `${fmtSh(a.start_shares)} sh<br><span class="attr-sub">@ $${a.jan1_price?.toFixed(2) ?? '—'} = ${fmtUSD0(a.start_value)}</span>`
      : `<span class="attr-sub">—</span>`;
    const endCell = a.end_shares > 0
      ? `${fmtSh(a.end_shares)} sh<br><span class="attr-sub">@ $${a.end_price?.toFixed(2) ?? '—'} = ${fmtUSD0(a.end_value)}</span>`
      : `<span class="attr-sub">fully sold</span>`;

    return `<tr>
      <td class="attr-ticker">${a.ticker}</td>
      <td class="attr-pos">${startCell}</td>
      <td class="attr-act">${activity}</td>
      <td class="attr-pos">${endCell}</td>
      <td class="attr-num ${cls(a.dollar_gain)}">${sign(a.dollar_gain)}${fmtUSD0(a.dollar_gain)}</td>
      <td class="attr-num attr-contrib ${cls(a.contribution_pct)}">${fmtPct(a.contribution_pct)}</td>
    </tr>`;
  }).join('');

  const totalGain = data.total_dollar_gain ?? 0;
  const totalPct  = data.explained_pct     ?? 0;

  // ── Flows table (always visible — user can verify each event) ────────────
  const flowRows = (data.flows || []).map(f => {
    const cls2 = f.amount >= 0 ? 'pos' : 'neg';
    return `<tr>
      <td class="flow-date">${f.date}</td>
      <td class="flow-action">${f.action}</td>
      <td class="flow-amt ${cls2}">${f.amount >= 0 ? '+' : '−'}$${Math.round(Math.abs(f.amount)).toLocaleString('en-US', {maximumFractionDigits:0})}</td>
    </tr>`;
  }).join('');
  // Show unique action types seen in the CSV (diagnostic — helps verify flow capture)
  const actionsDbg = (data.unique_actions || []).length
    ? `<div class="flows-actions-seen">All action types in CSV: ${(data.unique_actions || []).map(a => `<code>${a}</code>`).join(' · ')}</div>`
    : '';
  const flowCount = (data.flows || []).length;
  const flowsHtml = flowRows ? `
    <details class="flows-section">
      <summary class="flows-section-label">
        <span>CAPTURED CASH FLOWS <span class="flows-section-hint">${flowCount} event${flowCount === 1 ? '' : 's'} · click to expand/collapse</span></span>
        <span class="flows-collapse-arrow">▼</span>
      </summary>
      <table class="flows-table">
        <thead><tr><th>Date</th><th>Action</th><th>Amount</th></tr></thead>
        <tbody>${flowRows}</tbody>
      </table>
      ${actionsDbg}
    </details>` : `<div class="flows-section flows-section-empty">No external cash flows detected in activity CSV.${actionsDbg}</div>`;

  // ── Monthly chart ─────────────────────────────────────────────────────────
  const mc = data.monthly_chart;
  const chartDbg = data.monthly_chart_error ? `<div class="monthly-chart-error">⚠ chart: ${data.monthly_chart_error}</div>` : '';
  const chartAccuracy = (mc && mc.has_exact_perf) ? '' :
    `<span class="monthly-chart-hint monthly-chart-estimated" title="Month-end balances estimated from yfinance prices. Upload a Fidelity Investment Income Balance CSV for exact values.">⚠ balances estimated</span>`;
  const monthlyChartHtml = mc && mc.monthly && mc.monthly.length
    ? `<div class="monthly-chart-wrap">
         <div class="monthly-chart-header">
           <span class="section-label">YTD BY MONTH</span>
           <span style="display:flex;gap:8px;align-items:center">
             ${chartAccuracy}
             <span class="monthly-chart-hint">Hover a month for breakdown</span>
           </span>
         </div>
         <canvas id="monthly-ytd-canvas" width="1060" height="240" style="width:100%;height:240px"></canvas>
         <div id="monthly-hover-tooltip" class="monthly-tooltip" style="display:none"></div>
       </div>`
    : chartDbg;

  // ── TWRR stat box ─────────────────────────────────────────────────────────
  const hasExactPerf = data.has_monthly_perf ?? false;
  const twrrBadge    = hasExactPerf ? `<span class="twrr-exact-badge">exact</span>` : '';
  const twrrSub      = hasExactPerf ? 'Fidelity monthly CSV · exact match' : 'monthly chained · estimated balances';
  const twrrBox = twrr != null
    ? `<div class="ytd-stat ytd-stat-twrr">
        <div class="ytd-stat-label">TWRR${twrrBadge} <span class="twrr-note" title="Time-Weighted Rate of Return: chains monthly sub-period returns, isolating portfolio performance from the timing of your cash flows. This closely matches Fidelity's reported return.">ⓘ</span></div>
        <div class="ytd-stat-val ${cls(twrr)}">${sign(twrr)}${twrr.toFixed(2)}%</div>
        <div class="ytd-stat-sub">${twrrSub}</div>
      </div>`
    : '';

  box.style.display = '';
  box.innerHTML = `
    <div class="ytd-result-grid">
      <div class="ytd-stat hero">
        <div class="ytd-stat-label">MD Return</div>
        <div class="ytd-stat-val ${cls(md)}">${sign(md)}${md.toFixed(2)}%</div>
        <div class="ytd-stat-sub">Modified Dietz · dollar-weighted</div>
      </div>
      ${twrrBox}
      <div class="ytd-stat">
        <div class="ytd-stat-label">Jan 1 Value</div>
        <div class="ytd-stat-val">${fmtUSD0(data.begin_value)}</div>
      </div>
      <div class="ytd-stat">
        <div class="ytd-stat-label">Today's Value <span class="history-emv-badge">✓ from CSV</span></div>
        <div class="ytd-stat-val">${fmtUSD0(data.end_value)}</div>
      </div>
      <div class="ytd-stat">
        <div class="ytd-stat-label">Net Flows</div>
        <div class="ytd-stat-val ${cls(netFlow)}">${sign(netFlow)}${fmtUSD0(netFlow)}</div>
        <div class="ytd-stat-sub">${data.flow_count ?? 0} event${(data.flow_count ?? 0) === 1 ? '' : 's'}</div>
      </div>
      <div class="ytd-stat">
        <div class="ytd-stat-label">Trades</div>
        <div class="ytd-stat-val">${data.trade_count ?? 0}</div>
        <div class="ytd-stat-sub">${data.dividend_count ?? 0} dividends</div>
      </div>
    </div>
    ${flowsHtml}
    ${monthlyChartHtml}

    <details class="attr-section" open>
      <summary class="attr-section-summary">
        <span>PERFORMANCE ATTRIBUTION <span class="flows-section-hint">by holding · transaction-aware · click to collapse</span></span>
        <span class="flows-collapse-arrow">▼</span>
      </summary>
      <div class="attr-table-wrap">
        <table class="attr-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Jan 1</th>
              <th>YTD Activity</th>
              <th>Now</th>
              <th>$ P&amp;L</th>
              <th>% Contrib</th>
            </tr>
          </thead>
          <tbody>${attribRows}</tbody>
          <tfoot>
            <tr class="attr-total-row">
              <td colspan="4" style="text-align:right;font-weight:700;">TOTAL</td>
              <td class="attr-num ${cls(totalGain)}">${sign(totalGain)}${fmtUSD0(totalGain)}</td>
              <td class="attr-num attr-contrib ${cls(totalPct)}">${fmtPct(totalPct)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </details>`;

  // Render monthly chart after DOM is updated
  if (mc && mc.monthly && mc.monthly.length) {
    requestAnimationFrame(() => _drawMonthlyChart(mc));
  }
}

// ── Monthly YTD chart (Fidelity-style bar + balance line) ─────────────────
function _drawMonthlyChart(mc) {
  const canvas = document.getElementById('monthly-ytd-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const months = mc.monthly;
  if (!months || !months.length) return;

  const PAD = { top: 20, right: 60, bottom: 36, left: 70 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;

  // Scales
  const maxAbs = Math.max(...months.map(m => Math.abs(m.return_pct)), 0.5);
  const yScaleR = cH / 2 / (maxAbs * 1.15);   // bar scale (return %)
  const midY = PAD.top + cH / 2;               // zero line for bars

  const vals = months.map(m => m.end_value);
  vals.unshift(mc.begin_value);
  const minV = Math.min(...vals) * 0.98;
  const maxV = Math.max(...vals) * 1.02;
  const yScaleL = cH / (maxV - minV);          // balance line scale

  const barW   = cW / months.length * 0.55;
  const colW   = cW / months.length;

  // Background
  ctx.fillStyle = '#0e1e35';
  ctx.fillRect(0, 0, W, H);

  // Grid lines (horizontal, subtle)
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + (cH / 4) * i;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
  }

  // Zero line for bars
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD.left, midY); ctx.lineTo(W - PAD.right, midY); ctx.stroke();

  // Bars (monthly return %)
  months.forEach((m, i) => {
    const x    = PAD.left + colW * i + (colW - barW) / 2;
    const bH   = Math.abs(m.return_pct) * yScaleR;
    const y    = m.return_pct >= 0 ? midY - bH : midY;
    ctx.fillStyle = m.return_pct >= 0 ? 'rgba(34,197,94,0.85)' : 'rgba(239,68,68,0.85)';
    ctx.fillRect(x, y, barW, bH);
    // return % label inside bar
    if (bH > 18) {
      ctx.fillStyle = '#fff';
      ctx.font = '600 10px "SF Mono", monospace';
      ctx.textAlign = 'center';
      const label = (m.return_pct >= 0 ? '+' : '') + m.return_pct.toFixed(1) + '%';
      ctx.fillText(label, x + barW / 2, m.return_pct >= 0 ? y + 13 : y + bH - 4);
    }
  });

  // Balance line (gold)
  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const x0 = PAD.left;
  const y0 = PAD.top + cH - (mc.begin_value - minV) * yScaleL;
  ctx.moveTo(x0, y0);
  months.forEach((m, i) => {
    const x = PAD.left + colW * i + colW / 2;
    const y = PAD.top + cH - (m.end_value - minV) * yScaleL;
    ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Balance line dots
  ctx.fillStyle = '#d4af37';
  months.forEach((m, i) => {
    const x = PAD.left + colW * i + colW / 2;
    const y = PAD.top + cH - (m.end_value - minV) * yScaleL;
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
  });

  // Left Y-axis labels (balance)
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '10px "SF Mono", monospace';
  ctx.textAlign = 'right';
  const fmtM = v => '$' + (v / 1000000).toFixed(2) + 'M';
  const nTicks = 4;
  for (let i = 0; i <= nTicks; i++) {
    const v = minV + (maxV - minV) * i / nTicks;
    const y = PAD.top + cH - (v - minV) * yScaleL;
    ctx.fillText(fmtM(v), PAD.left - 6, y + 4);
  }

  // Right Y-axis labels (return %)
  ctx.textAlign = 'left';
  [-maxAbs, 0, maxAbs].forEach(pct => {
    const y = midY - pct * yScaleR;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText((pct >= 0 ? '+' : '') + pct.toFixed(0) + '%', W - PAD.right + 6, y + 4);
  });

  // X-axis month labels
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '600 11px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  months.forEach((m, i) => {
    const x = PAD.left + colW * i + colW / 2;
    ctx.fillText(m.label, x, H - 8);
  });

  // Store layout for hover
  canvas._monthLayout = { months, PAD, colW, W, H };

  // ── Shared hit-test helper ──────────────────────────────────────────────
  function _hitMonth(clientX, clientY) {
    const rect   = canvas.getBoundingClientRect();
    const scaleX = W / rect.width;
    const mx     = (clientX - rect.left) * scaleX;
    const layout = canvas._monthLayout;
    if (!layout) return null;
    const idx = Math.floor((mx - layout.PAD.left) / layout.colW);
    if (idx < 0 || idx >= layout.months.length) return null;
    return { mData: layout.months[idx], cx: clientX, cy: clientY, rect };
  }

  // ── Mouse hover (desktop) ────────────────────────────────────────────────
  canvas.onmousemove = (e) => {
    const hit = _hitMonth(e.clientX, e.clientY);
    if (!hit) { document.getElementById('monthly-hover-tooltip').style.display = 'none'; return; }
    _showMonthTooltip(hit.mData, hit.cx, hit.cy, hit.rect);
  };
  canvas.onmouseleave = () => {
    document.getElementById('monthly-hover-tooltip').style.display = 'none';
  };

  // ── Touch tap (mobile) ───────────────────────────────────────────────────
  canvas.ontouchstart = (e) => {
    e.preventDefault();
    const t = e.touches[0];
    const hit = _hitMonth(t.clientX, t.clientY);
    const tip = document.getElementById('monthly-hover-tooltip');
    if (!hit) { if (tip) tip.style.display = 'none'; return; }
    _showMonthTooltip(hit.mData, hit.cx, hit.cy, hit.rect);
  };
  canvas.ontouchend = (e) => {
    // Keep tooltip visible briefly so user can read it, then hide on next tap elsewhere
  };
  // Tap outside canvas hides tooltip on mobile
  document.addEventListener('touchstart', (e) => {
    if (e.target !== canvas) {
      const tip = document.getElementById('monthly-hover-tooltip');
      if (tip) tip.style.display = 'none';
    }
  }, { passive: true });
}

function _showMonthTooltip(m, cx, cy, canvasRect) {
  const tip = document.getElementById('monthly-hover-tooltip');
  if (!tip) return;

  const sign = v => v >= 0 ? '+' : '';
  const fmtD = v => `${sign(v)}$${Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0})}`;
  const fmtP = v => v == null ? '—' : `${sign(v)}${v.toFixed(2)}%`;
  const fmtDSign = (v, posClass='pos', negClass='neg') => {
    if (v == null) return `<span class="mtt-perf-val neu">—</span>`;
    const cls = v > 0 ? posClass : v < 0 ? negClass : 'neu';
    return `<span class="mtt-perf-val ${cls}">${fmtD(v)}</span>`;
  };

  const moversHtml = (m.movers || []).slice(0, 6).map(mv =>
    `<div class="mtt-row">
       <span class="mtt-tk">${mv.ticker}</span>
       <span class="mtt-ret ${mv.return_pct >= 0 ? 'pos' : 'neg'}">${fmtP(mv.return_pct)}</span>
       <span class="mtt-gain ${mv.dollar_gain >= 0 ? 'pos' : 'neg'}">${fmtD(mv.dollar_gain)}</span>
     </div>`
  ).join('');

  const tradesHtml = (m.trades || []).length
    ? `<div class="mtt-section-label">Trades</div>` +
      (m.trades || []).map(t =>
        `<div class="mtt-row"><span class="mtt-tk">${t.ticker}</span>
         <span class="attr-chip ${t.type === 'SELL' ? 'sell' : 'buy'}">${t.type === 'SELL' ? '▼' : '▲'} ${t.shares.toFixed(0)} @ $${t.price.toFixed(2)}</span></div>`
      ).join('')
    : '';

  const divsHtml = (m.dividends || []).length
    ? `<div class="mtt-section-label">Dividends</div>` +
      (m.dividends || []).map(d =>
        `<div class="mtt-row"><span class="mtt-tk">${d.ticker}</span><span class="pos">+$${d.amount.toFixed(0)}</span></div>`
      ).join('')
    : '';

  // Fidelity monthly performance breakdown (exact when perf CSV supplied)
  let perfDetailHtml = '';
  const pd = m.perf_detail;
  if (pd && m.exact) {
    const rows = [
      { key: 'Market change',  val: pd.market_change,  posClass: 'pos', negClass: 'neg' },
      { key: 'Dividends',      val: pd.dividends,      posClass: 'pos', negClass: 'neg' },
      { key: 'Interest',       val: pd.interest,       posClass: 'pos', negClass: 'neg' },
      { key: 'Deposits',       val: pd.deposits,       posClass: 'pos', negClass: 'neg' },
      { key: 'Withdrawals',    val: pd.withdrawals,    posClass: 'neg', negClass: 'neg' },
      { key: 'Advisory fees',  val: pd.advisory_fees,  posClass: 'neu', negClass: 'neg' },
      { key: 'Net flow',       val: pd.net_flow,       posClass: 'pos', negClass: 'neg' },
    ].filter(r => r.val != null && r.val !== 0);

    if (rows.length) {
      perfDetailHtml = `<div class="mtt-perf-detail">
        <div class="mtt-section-label" style="margin-bottom:3px">Fidelity Breakdown</div>
        ${rows.map(r => `<div class="mtt-perf-row"><span class="mtt-perf-key">${r.key}</span>${fmtDSign(r.val, r.posClass, r.negClass)}</div>`).join('')}
      </div>`;
    }
  }

  tip.innerHTML = `
    <div class="mtt-header">
      <span class="mtt-month">${m.label}</span>
      <span class="mtt-return ${m.return_pct >= 0 ? 'pos' : 'neg'}">${sign(m.return_pct)}${m.return_pct.toFixed(2)}%</span>
      <span class="mtt-value">$${m.end_value.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0})}</span>
    </div>
    ${perfDetailHtml}
    ${m.movers && m.movers.length ? '<div class="mtt-section-label">Top Movers</div>' + moversHtml : ''}
    ${tradesHtml}
    ${divsHtml}`;

  // Position tooltip
  tip.style.display = 'block';
  const tW = 260, tH = 300;
  let left = cx + 12;
  let top  = cy - 40;
  if (left + tW > window.innerWidth - 10) left = cx - tW - 12;
  if (top + tH > window.innerHeight - 10) top = window.innerHeight - tH - 10;
  tip.style.left = left + 'px';
  tip.style.top  = top + 'px';
}

// ── List load + render ─────────────────────────────────────────────────────
async function loadTrackers() {
  const list = document.getElementById('tracker-list');
  if (!list) return;
  list.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const data = await api.listTrackers();
    _trackerCache = data.portfolios || [];
    renderTrackerList();
  } catch (err) {
    list.innerHTML = `<div class="empty">Could not load: ${err.message}</div>`;
  }
}

function renderTrackerList() {
  const list = document.getElementById('tracker-list');
  if (!_trackerCache.length) {
    list.innerHTML = `<div class="empty">No paper portfolios yet. Generate an Intelligence brief, then tap <strong>📌 Track This Brief</strong> to lock in a portfolio.</div>`;
    return;
  }
  list.innerHTML = _trackerCache.map(p => trackerRowHtml(p)).join('');
  list.querySelectorAll('.tracker-row').forEach(el => {
    el.addEventListener('click', () => {
      // Navigate to Portfolio tab where the detail card lives
      showView('view-portfolio');
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.target === 'view-portfolio');
      });
      openTrackerDetail(el.dataset.id);
    });
  });
}

function trackerRowHtml(p) {
  const ret    = p.current_return_pct ?? 0;
  const vsSpy  = p.vs_spy_pct;
  const vsLive = p.vs_live_pct;
  const dd     = p.max_drawdown_pct ?? 0;
  const ms     = p.milestones || {};
  const fmtPct = (x) => x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
  const cls    = (x) => x == null ? 'flat' : x > 0 ? 'up' : x < 0 ? 'down' : 'flat';
  const status = p.status === 'closed' ? 'closed' : '';

  // Ticker chips — sorted server-side by weight desc
  const tickerChips = (p.holdings_summary || []).map(h =>
    `<span class="tracker-row-chip">${h.ticker}<span class="tracker-row-chip-w">${(h.weight * 100).toFixed(1)}%</span></span>`
  ).join('');

  return `
    <div class="tracker-row ${status}" data-id="${p.id}">
      <div class="tracker-row-top">
        <div>
          <div class="tracker-row-name">${escapeHtml(p.name)}</div>
          <div class="tracker-row-sub">
            <span>${p.n_tickers} tickers</span>
            <span class="dot">·</span>
            <span>Day ${p.days_tracked}</span>
            <span class="dot">·</span>
            <span>Locked ${p.entry_date}</span>
          </div>
        </div>
        <span class="tracker-status-pill ${status}">${(p.status || 'tracking').toUpperCase()}</span>
      </div>

      ${tickerChips ? `<div class="tracker-row-tickers">${tickerChips}</div>` : ''}

      <div class="tracker-metrics">
        <div class="tracker-metric">
          <div class="tracker-metric-key">RETURN</div>
          <div class="tracker-metric-val ${cls(ret)}">${fmtPct(ret)}</div>
        </div>
        <div class="tracker-metric">
          <div class="tracker-metric-key">VS SPY</div>
          <div class="tracker-metric-val ${cls(vsSpy)}">${fmtPct(vsSpy)}</div>
        </div>
        <div class="tracker-metric">
          <div class="tracker-metric-key">VS LIVE</div>
          <div class="tracker-metric-val ${cls(vsLive)}">${fmtPct(vsLive)}</div>
        </div>
        <div class="tracker-metric">
          <div class="tracker-metric-key">MAX DD</div>
          <div class="tracker-metric-val flat">-${(dd ?? 0).toFixed(2)}%</div>
        </div>
      </div>

      <div class="tracker-milestones">
        <span class="tracker-milestone ${ms.d30 ? 'reached' : ''}">30D</span>
        <span class="tracker-milestone ${ms.d60 ? 'reached' : ''}">60D</span>
        <span class="tracker-milestone ${ms.d90 ? 'reached' : ''}">90D</span>
      </div>
    </div>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ── Detail / chart ─────────────────────────────────────────────────────────
async function openTrackerDetail(id) {
  _trackerExpandedId = id;
  const card = document.getElementById('tracker-detail-card');
  card.dataset.mode = 'paper';
  card.style.display = 'block';
  document.getElementById('tracker-detail-name').textContent = 'Loading…';
  document.getElementById('tracker-detail-meta').textContent = '';
  document.getElementById('tracker-chart').innerHTML = '';
  const attrEl = document.getElementById('tracker-attribution');
  if (attrEl) attrEl.innerHTML = '';
  document.getElementById('tracker-holdings-table').innerHTML = '';
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const p = await api.getTracker(id);
    document.getElementById('tracker-detail-name').textContent = p.name;
    document.getElementById('tracker-detail-meta').textContent =
      `${p.n_tickers} tickers · Locked ${p.entry_date} · Day ${p.days_tracked} · ${p.status}`;
    applyDetailMode('paper');
    drawTrackerChart(p);
    drawTrackerAttribution(p);
    drawTrackerHoldings(p, 'paper');
  } catch (err) {
    document.getElementById('tracker-detail-name').textContent = 'Error';
    document.getElementById('tracker-detail-meta').textContent = err.message;
  }
}

// ── Live Benchmark YTD detail (clicked from the Live Benchmark card) ──────
async function openLiveBenchmarkDetail(snapshotId) {
  _trackerExpandedId = null;
  _currentYtdSnapshotId = snapshotId || null;
  const card = document.getElementById('tracker-detail-card');
  card.dataset.mode = 'live';
  card.style.display = 'block';
  document.getElementById('tracker-detail-name').textContent = 'Loading…';
  document.getElementById('tracker-detail-meta').textContent = '';
  document.getElementById('tracker-chart').innerHTML = '';
  const attrEl = document.getElementById('tracker-attribution');
  if (attrEl) attrEl.innerHTML = '';
  document.getElementById('tracker-holdings-table').innerHTML = '';
  // Reset email status when re-opening
  const emailStatus = document.getElementById('tracker-email-status');
  if (emailStatus) { emailStatus.textContent = ''; emailStatus.className = 'tracker-email-status'; }
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const p = await api.getLiveBenchmarkDetail(snapshotId);
    // If the response includes a snapshot id, remember it so the email
    // request points at exactly the same data the user is viewing.
    _currentYtdSnapshotId = p?.snapshot_id || snapshotId || null;
    if (!p?.ok) {
      document.getElementById('tracker-detail-name').textContent = 'Live YTD';
      document.getElementById('tracker-detail-meta').textContent = p?.error || 'Unavailable';
      return;
    }
    const ytdSign = (p.current_return_pct ?? 0) >= 0 ? '+' : '';
    const vsSpyStr = p.vs_spy_pct == null ? '—'
      : `${p.vs_spy_pct >= 0 ? '+' : ''}${p.vs_spy_pct.toFixed(2)}% vs SPY`;
    const mdTag = p.history_uploaded
      ? ` <span class="history-md-badge">MD</span>`
      : ` <span style="font-size:10px;color:#F59E0B;font-weight:600;">(snapshot est.)</span>`;
    // If MD is available, show snapshot alongside it for comparison
    const snapshotNote = p.history_uploaded && p.snapshot_return_pct != null
      ? `  ·  snapshot ${(p.snapshot_return_pct ?? 0) >= 0 ? '+' : ''}${(p.snapshot_return_pct ?? 0).toFixed(2)}%`
      : '';
    document.getElementById('tracker-detail-name').textContent = '📊 ' + p.name;
    document.getElementById('tracker-detail-meta').innerHTML =
      `${p.n_tickers} positions · Year-start ${p.year_start_date} · ` +
      `YTD ${ytdSign}${(p.current_return_pct ?? 0).toFixed(2)}%${mdTag} (${vsSpyStr})${snapshotNote}`;
    applyDetailMode('live');
    drawTrackerChart(p);
    drawTrackerAttribution(p);
    drawTrackerHoldings(p, 'live');
  } catch (err) {
    document.getElementById('tracker-detail-name').textContent = 'Error';
    document.getElementById('tracker-detail-meta').textContent = err.message;
  }
}

// Adjust labels / legend / actions based on which mode the detail card is in
function applyDetailMode(mode) {
  // Hide live-line and Stop/Delete actions when in live mode
  const isLive = mode === 'live';
  const card = document.getElementById('tracker-detail-card');

  // Detail label header and holdings header label
  const detailLabel = card.querySelector('.tracker-detail-header .label');
  if (detailLabel) {
    detailLabel.textContent = isLive ? 'LIVE PORTFOLIO · YTD DETAIL' : 'PAPER PORTFOLIO DETAIL';
  }

  // Hide / show legend dots — live mode has no live_series, paper has all three
  const legend = card.querySelector('.tracker-chart-legend');
  if (legend) {
    legend.innerHTML = isLive
      ? `<span class="tracker-legend-item"><span class="tracker-legend-dot gold"></span>Live YTD</span>
         <span class="tracker-legend-item"><span class="tracker-legend-dot blue"></span>SPY YTD</span>`
      : `<span class="tracker-legend-item"><span class="tracker-legend-dot gold"></span>Paper</span>
         <span class="tracker-legend-item"><span class="tracker-legend-dot blue"></span>SPY</span>
         <span class="tracker-legend-item"><span class="tracker-legend-dot green"></span>Live</span>`;
  }

  // Hide Stop Tracking / Delete buttons in live mode (it's not a paper portfolio)
  const actionRow = card.querySelector('.tracker-detail-actions');
  if (actionRow) actionRow.style.display = isLive ? 'none' : 'flex';

  // Email row only makes sense for live YTD (paper portfolios are different)
  const emailRow = document.getElementById('tracker-email-row');
  if (emailRow) emailRow.style.display = isLive ? '' : 'none';
}

function closeTrackerDetail() {
  document.getElementById('tracker-detail-card').style.display = 'none';
  _trackerExpandedId = null;
}

async function closeTrackerCurrent() {
  if (!_trackerExpandedId) return;
  if (!confirm('Stop tracking this paper portfolio? You can still view its history.')) return;
  await api.closeTracker(_trackerExpandedId);
  closeTrackerDetail();
  loadTrackers();
}

async function deleteTrackerCurrent() {
  if (!_trackerExpandedId) return;
  if (!confirm('Permanently delete this paper portfolio and all its history? This cannot be undone.')) return;
  await api.deleteTracker(_trackerExpandedId);
  closeTrackerDetail();
  loadTrackers();
}

// ── Chart (simple inline SVG, no library needed) ──────────────────────────
function drawTrackerChart(p) {
  const wrap = document.getElementById('tracker-chart');
  // Compact chart: half the original height, dark-panel aesthetic
  const W = 560, H = 130, padL = 40, padR = 12, padT = 10, padB = 24;

  const series = [
    { key: 'paper', label: 'Paper', color: '#C9A84C', grad: 'grad-paper', glow: 'glow-paper', data: p.series || [] },
    { key: 'spy',   label: 'SPY',   color: '#60A5FA', grad: 'grad-spy',   glow: 'glow-spy',   data: p.spy_series || [] },
    { key: 'live',  label: 'Live',  color: '#4ADE80', grad: 'grad-live',  glow: 'glow-live',  data: p.live_series || [] },
  ].filter(s => s.data.length > 0);

  if (!series.length) {
    wrap.innerHTML = `<div class="tracker-chart-empty">No data points yet — first daily snapshot lands after market close.</div>`;
    return;
  }

  // X axis: union of all dates, sorted
  const allDates = Array.from(new Set(series.flatMap(s => s.data.map(d => d.date)))).sort();

  // Need at least 2 distinct dates to draw a line — otherwise show "waiting" state.
  if (allDates.length < 2) {
    wrap.innerHTML = `<div class="tracker-chart-empty">
      📈 Chart populates as daily snapshots are recorded — one per market close.<br>
      <span class="tracker-chart-empty-sub">Locked today · ${allDates[0] || '—'}</span>
    </div>`;
    return;
  }

  const xIdx  = Object.fromEntries(allDates.map((d, i) => [d, i]));
  const xMax  = allDates.length - 1;

  // Y axis: min/max across all series values
  const allVals = series.flatMap(s => s.data.map(d => d.value));
  const yMin = Math.min(100, ...allVals);
  const yMax = Math.max(100, ...allVals);
  const yPad = (yMax - yMin) * 0.12 || 2;
  const Y0 = yMin - yPad, Y1 = yMax + yPad;

  const xPos = (i) => padL + (i / xMax) * (W - padL - padR);
  const yPos = (v) => padT + (1 - (v - Y0) / (Y1 - Y0)) * (H - padT - padB);

  // ── Smooth Catmull-Rom → cubic Bezier path generator ──────────────────────
  // Converts a list of [x,y] points into a smooth SVG path string.
  function smoothPath(pts) {
    if (pts.length < 2) return '';
    let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[Math.max(0, i - 2)];
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const p3 = pts[Math.min(pts.length - 1, i + 1)];
      const cp1x = (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1);
      const cp1y = (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1);
      const cp2x = (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1);
      const cp2y = (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1);
      d += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  }

  // ── Build gradient-filled area + glowing line for each series ─────────────
  const chartBottom = H - padB;
  const seriesSvg = series.map(s => {
    const pts = s.data.map(d => [xPos(xIdx[d.date]), yPos(d.value)]);
    const linePath = smoothPath(pts);
    // Area: follow the line, drop down to bottom, close back to start
    const areaPath = pts.length >= 2
      ? `${linePath} L ${pts[pts.length-1][0].toFixed(1)} ${chartBottom} L ${pts[0][0].toFixed(1)} ${chartBottom} Z`
      : '';
    return `
      <path d="${areaPath}" fill="url(#${s.grad})"/>
      <path d="${linePath}" fill="none" stroke="${s.color}" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round" filter="url(#${s.glow})"/>`;
  }).join('');

  // ── Subtle horizontal grid lines ──────────────────────────────────────────
  const gridLines = [0.25, 0.5, 0.75].map(t => {
    const v = Y0 + (Y1 - Y0) * t;
    const y = yPos(v).toFixed(1);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"
                  stroke="rgba(255,255,255,0.05)" stroke-width="0.8"/>`;
  }).join('');

  // ── Y-axis labels ─────────────────────────────────────────────────────────
  const yLabels = [Y0, (Y0 + Y1) / 2, Y1].map(v => {
    const ret = v - 100;
    const sign = ret >= 0 ? '+' : '';
    return `<text x="${padL - 5}" y="${(yPos(v) + 3).toFixed(1)}" text-anchor="end">${sign}${ret.toFixed(1)}%</text>`;
  }).join('');

  // ── X-axis date labels — first / mid / last ───────────────────────────────
  const labelIdx = Array.from(new Set([0, Math.floor(xMax / 2), xMax]));
  const xLabels = labelIdx
    .filter(i => i >= 0 && i < allDates.length)
    .map(i => `<text x="${xPos(i).toFixed(1)}" y="${H - 5}" text-anchor="middle">${allDates[i].slice(5)}</text>`)
    .join('');

  // ── Zero-return baseline (dashed) ─────────────────────────────────────────
  const baseY = yPos(100).toFixed(1);
  const baseLine = `<line x1="${padL}" y1="${baseY}" x2="${W - padR}" y2="${baseY}"
                          stroke="rgba(255,255,255,0.18)" stroke-dasharray="3,4" stroke-width="0.8"/>`;

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
         xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;overflow:visible;">
      <defs>
        <!-- Gradient area fills — each series gets a vertical fade -->
        <linearGradient id="grad-paper" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="#C9A84C" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="#C9A84C" stop-opacity="0.01"/>
        </linearGradient>
        <linearGradient id="grad-spy" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="#60A5FA" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="#60A5FA" stop-opacity="0.01"/>
        </linearGradient>
        <linearGradient id="grad-live" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="#4ADE80" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="#4ADE80" stop-opacity="0.01"/>
        </linearGradient>
        <!-- Soft glow filter — blurred copy behind line creates depth -->
        <filter id="glow-paper" x="-15%" y="-60%" width="130%" height="220%">
          <feGaussianBlur stdDeviation="1.8" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="glow-spy" x="-15%" y="-60%" width="130%" height="220%">
          <feGaussianBlur stdDeviation="1.8" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="glow-live" x="-15%" y="-60%" width="130%" height="220%">
          <feGaussianBlur stdDeviation="1.8" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <!-- Dark panel background -->
      <rect x="0" y="0" width="${W}" height="${H}" fill="#0B1B35" rx="0"/>
      ${gridLines}
      ${baseLine}
      ${seriesSvg}
      ${yLabels}
      ${xLabels}
    </svg>`;
}

// ── Performance Attribution: tornado chart of contributions ────────────────
function drawTrackerAttribution(p) {
  const wrap = document.getElementById('tracker-attribution');
  const holdings = p.holdings || [];
  const haveContrib = holdings.some(h => h.contribution_pct != null);
  if (!holdings.length || !haveContrib) {
    wrap.innerHTML = `<div class="tracker-chart-empty">Attribution available once prices are fetched.</div>`;
    return;
  }

  const W = 720;
  const rowH = 18;
  const labelW = 80;     // ticker label column
  const valW = 90;       // value label column
  const cx = labelW + (W - labelW - valW) / 2 + labelW * 0;  // we use a centered axis
  const barAreaW = W - labelW - valW - 8;
  const axisX = labelW + barAreaW / 2;   // center axis x-position

  const maxAbs = Math.max(...holdings.map(h => Math.abs(h.contribution_pct ?? 0)), 0.01);
  const maxBarHalf = barAreaW / 2 - 4;

  const total = (p.weighted_avg_return ?? 0);
  const totalSign = total >= 0 ? '+' : '';

  const H = rowH * holdings.length + 20;

  const rows = holdings.map((h, i) => {
    const y = i * rowH + 8;
    const val = h.contribution_pct ?? 0;
    const len = Math.abs(val) / maxAbs * maxBarHalf;
    const isPos = val >= 0;
    const fill = isPos ? '#16A34A' : '#DC2626';
    const barX = isPos ? axisX : axisX - len;
    const valLabel = `${isPos ? '+' : ''}${val.toFixed(2)}%`;
    const tickerColor = isPos ? '#0A1628' : '#0A1628';
    const retText = h.return_pct != null
      ? `${h.return_pct >= 0 ? '+' : ''}${h.return_pct.toFixed(1)}%`
      : '';

    return `
      <g>
        <text x="${labelW - 5}" y="${y + 12}" text-anchor="end"
              class="attr-ticker">${h.ticker}</text>
        <rect x="${barX}" y="${y + 4}" width="${len}" height="10"
              rx="2" fill="${fill}" fill-opacity="0.85"/>
        <text x="${isPos ? barX + len + 5 : barX - 5}"
              y="${y + 12}" text-anchor="${isPos ? 'start' : 'end'}"
              class="attr-value ${isPos ? 'attr-pos' : 'attr-neg'}">
          ${valLabel}
        </text>
        <text x="${labelW + 4}" y="${y + 12}" text-anchor="start"
              class="attr-return">${retText}</text>
      </g>`;
  }).join('');

  // Center axis
  const axis = `<line x1="${axisX}" y1="0" x2="${axisX}" y2="${H - 8}"
                      stroke="#C0C7D2" stroke-width="1"/>`;

  wrap.innerHTML = `
    <div class="tracker-attr-summary">
      <span class="tracker-attr-total ${total >= 0 ? 'pos' : 'neg'}">
        Portfolio: ${totalSign}${total.toFixed(2)}%
      </span>
      <span class="tracker-attr-hint">Each position's contribution = weight × return. Bars sum to portfolio total.</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet"
         xmlns="http://www.w3.org/2000/svg" class="tracker-attr-svg">
      ${axis}
      ${rows}
    </svg>`;
}

// ── Enriched holdings table ────────────────────────────────────────────────
function drawTrackerHoldings(p, mode = 'paper') {
  const t = document.getElementById('tracker-holdings-table');
  const holdings = p.holdings || [];
  if (!holdings.length) { t.innerHTML = ''; return; }
  const entryLabel = mode === 'live' ? 'Year Start' : 'Entry';

  const fmtPct = (x, signed = true) => {
    if (x == null) return '—';
    const sign = signed && x >= 0 ? '+' : '';
    return `${sign}${x.toFixed(2)}%`;
  };
  const cls = (x) => x == null ? '' : x > 0 ? 'pct-up' : x < 0 ? 'pct-down' : '';

  // Top 3 contributors / bottom 3 detractors get a star marker
  const top3 = new Set(
    holdings.slice().sort((a, b) => (b.contribution_pct ?? -1e9) - (a.contribution_pct ?? -1e9))
      .filter(h => (h.contribution_pct ?? 0) > 0).slice(0, 3).map(h => h.ticker)
  );
  const bot3 = new Set(
    holdings.slice().sort((a, b) => (a.contribution_pct ?? 1e9) - (b.contribution_pct ?? 1e9))
      .filter(h => (h.contribution_pct ?? 0) < 0).slice(0, 3).map(h => h.ticker)
  );

  const rows = holdings.map(h => {
    const tag = top3.has(h.ticker) ? '<span class="row-tag winner">★</span>'
              : bot3.has(h.ticker) ? '<span class="row-tag loser">▼</span>'
              : '';
    return `<tr>
      <td class="ticker-cell">${tag}${h.ticker}</td>
      <td class="num-cell">${(h.weight * 100).toFixed(1)}%</td>
      <td class="num-cell">${h.entry_price != null ? '$' + Number(h.entry_price).toFixed(2) : '—'}</td>
      <td class="num-cell">${h.current_price != null ? '$' + Number(h.current_price).toFixed(2) : '—'}</td>
      <td class="num-cell ${cls(h.return_pct)}">${fmtPct(h.return_pct)}</td>
      <td class="num-cell ${cls(h.contribution_pct)}">${fmtPct(h.contribution_pct)}</td>
      <td class="num-cell ${cls(h.vs_avg_pct)}">${fmtPct(h.vs_avg_pct)}</td>
    </tr>`;
  }).join('');

  t.innerHTML = `
    <thead><tr>
      <th>Ticker</th>
      <th>Weight</th>
      <th>${entryLabel}</th>
      <th>Current</th>
      <th>Return</th>
      <th title="Weight × Return — what this position contributed to the portfolio's total return">Contrib</th>
      <th title="This position's return minus the portfolio's weighted average return">vs Avg</th>
    </tr></thead>
    <tbody>${rows}</tbody>`;
}

// ── Track-this-brief modal ─────────────────────────────────────────────────
function openTrackModal() {
  if (!_latestBrief?.tickers?.length) {
    alert('No tickers in the current brief. Generate a brief first.');
    return;
  }
  // Default name
  const days = _latestBrief.days || 30;
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  document.getElementById('track-name-input').value = `Brief — ${today}, ${days}D`;

  // Equal weights to start
  const tickers = _latestBrief.tickers.slice(0, 20);  // clamp at 20
  const eq = Math.floor(100 / tickers.length);
  const remainder = 100 - eq * tickers.length;
  const weights = tickers.map((t, i) => i === 0 ? eq + remainder : eq);
  renderTrackWeights(tickers, weights);

  document.getElementById('track-modal-error').style.display = 'none';
  document.getElementById('track-modal').style.display = 'flex';
}

function closeTrackModal() {
  document.getElementById('track-modal').style.display = 'none';
}

function renderTrackWeights(tickers, weights) {
  const list = document.getElementById('track-weights-list');
  list.innerHTML = tickers.map((t, i) => `
    <div class="track-weight-row" data-ticker="${t}">
      <span class="track-weight-ticker">${t}</span>
      <input type="number" class="track-weight-input" value="${weights[i]}" min="0" max="100" step="1">
      <span class="track-weight-pct">%</span>
      <button class="track-weight-remove" title="Remove">×</button>
    </div>`).join('');
  // Wire input change
  list.querySelectorAll('.track-weight-input').forEach(inp => {
    inp.addEventListener('input', updateTrackTotal);
  });
  // Wire remove
  list.querySelectorAll('.track-weight-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.target.closest('.track-weight-row').remove();
      updateTrackTotal();
    });
  });
  updateTrackTotal();
}

function updateTrackTotal() {
  let total = 0;
  document.querySelectorAll('.track-weight-input').forEach(inp => {
    total += parseFloat(inp.value) || 0;
  });
  const el = document.getElementById('track-total');
  el.textContent = `${total.toFixed(0)}%`;
  el.className = 'track-total';
  if (Math.abs(total - 100) < 0.5) el.classList.add('good');
  else el.classList.add('bad');
}

function resetEqualWeights() {
  const rows = document.querySelectorAll('.track-weight-row');
  if (!rows.length) return;
  const eq = Math.floor(100 / rows.length);
  const remainder = 100 - eq * rows.length;
  rows.forEach((row, i) => {
    const inp = row.querySelector('.track-weight-input');
    inp.value = i === 0 ? eq + remainder : eq;
  });
  updateTrackTotal();
}

async function submitTrack() {
  const name = document.getElementById('track-name-input').value.trim();
  const errEl = document.getElementById('track-modal-error');
  errEl.style.display = 'none';

  const holdings = [];
  let total = 0;
  document.querySelectorAll('.track-weight-row').forEach(row => {
    const ticker = row.dataset.ticker;
    const w = parseFloat(row.querySelector('.track-weight-input').value) || 0;
    if (ticker && w > 0) {
      holdings.push({ ticker, weight: w });
      total += w;
    }
  });

  if (!holdings.length) {
    errEl.textContent = 'Need at least 1 ticker with positive weight.';
    errEl.style.display = 'block';
    return;
  }
  if (Math.abs(total - 100) > 0.5) {
    errEl.textContent = `Weights must sum to 100% (currently ${total.toFixed(1)}%).`;
    errEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('track-modal-lock-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Locking…';

  try {
    await api.createTracker({
      name,
      holdings,
      source: {
        sector: _latestBrief?.sector || null,
        lookback_days: _latestBrief?.days || null,
        brief_generated_at: _latestBrief?.generated_at,
      },
    });
    closeTrackModal();
    // Reload the paper portfolio list (now in Ideas view)
    loadTrackers();
    // Switch to Ideas view so user can see the new portfolio
    showView('view-intelligence');
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.target === 'view-intelligence');
    });
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = '📌 Lock In Portfolio';
  }
}

// ============================================================================
// ============================================================================
// Fund Admin — auth gate + data loading
// ============================================================================

const FUND_TOKEN_KEY = 'dga_fund_token';

function getFundToken()            { return localStorage.getItem(FUND_TOKEN_KEY) || ''; }
function setFundToken(t)           { localStorage.setItem(FUND_TOKEN_KEY, t); }
function clearFundToken()          { localStorage.removeItem(FUND_TOKEN_KEY); }

let _fundLoaded   = false;
let _activeFundId = null;   // UUID of the currently-open fund (null = list view)

// Called when the Fund tab is clicked.
function openFundTab() {
  if (getFundToken()) {
    // Already authenticated this session — show branch selector and load data.
    document.getElementById('fund-branch-selector').style.display = 'flex';
    loadFundList();
    _loadMyPortfolioData();
  } else {
    // Show the lock overlay; data loads after successful auth.
    showFundLock();
  }
}

// Load My Portfolio data (YTD snapshots + rehydrate last result).
// Safe to call any time; only acts on visible elements.
function _loadMyPortfolioData() {
  loadYtdSnapshots();
  _rehydrateYtdResult();
}

function showFundLock() {
  const overlay = document.getElementById('fund-lock-overlay');
  const input   = document.getElementById('fund-lock-input');
  const errEl   = document.getElementById('fund-lock-error');
  // Hide branch selector while locked
  const sel = document.getElementById('fund-branch-selector');
  if (sel) sel.style.display = 'none';
  overlay.style.display = 'flex';
  errEl.style.display   = 'none';
  input.value           = '';
  setTimeout(() => input.focus(), 80);
}

function hideFundLock() {
  document.getElementById('fund-lock-overlay').style.display = 'none';
  // Reveal branch selector now that we're authenticated
  const sel = document.getElementById('fund-branch-selector');
  if (sel) sel.style.display = 'flex';
  // Load fund list + My Portfolio data
  loadFundList();
  _loadMyPortfolioData();
}

// Show the fund list view (hide detail view)
function showFundListView() {
  _activeFundId = null;
  _fundLoaded   = false;
  const listEl   = document.getElementById('fund-list-view');
  const detailEl = document.getElementById('fund-detail-view');
  if (listEl)   listEl.style.display   = '';
  if (detailEl) detailEl.style.display = 'none';
}

// Show the detail view for a specific fund
function showFundDetailView(fundId, fundName) {
  _activeFundId = fundId;
  _activityCollapsed = true;   // reset to collapsed for each fund
  _fundLoaded   = false;
  const listEl   = document.getElementById('fund-list-view');
  const detailEl = document.getElementById('fund-detail-view');
  if (listEl)   listEl.style.display   = 'none';
  if (detailEl) detailEl.style.display = '';
  const nameEl = document.getElementById('fund-detail-name');
  if (nameEl) nameEl.textContent = fundName || '';
  // Reset loading state for the detail containers
  ['fund-overview-cards','fund-lps-wrap','fund-positions-wrap',
   'fund-activity-wrap','fund-waterfall-wrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<div class="fund-card-loading">Loading…</div>';
  });
  loadFund();
}

// Wire up the Unlock button (and Enter key) once the DOM is ready.
document.addEventListener('DOMContentLoaded', () => {
  // ── Fund lock button ─────────────────────────────────────────────────────
  const btn   = document.getElementById('fund-lock-btn');
  const input = document.getElementById('fund-lock-input');
  if (btn) {
    async function attemptFundAuth() {
      const pw = input.value.trim();
      if (!pw) return;
      btn.disabled    = true;
      btn.textContent = 'Checking…';
      try {
        const r = await fetch('/api/fund/auth', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'x-auth-token': getToken() },
          body:    JSON.stringify({ password: pw }),
        });
        if (!r.ok) throw new Error('wrong');
        const { fund_token } = await r.json();
        setFundToken(fund_token);
        hideFundLock();
        loadFund();
      } catch {
        document.getElementById('fund-lock-error').style.display = 'block';
        input.value = '';
        input.focus();
      } finally {
        btn.disabled    = false;
        btn.textContent = 'Unlock';
      }
    }
    btn.addEventListener('click', attemptFundAuth);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') attemptFundAuth(); });
  }

  // ── Fund back button ─────────────────────────────────────────────────────
  const backBtn = document.getElementById('fund-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      showFundListView();
      loadFundList();
    });
  }

  // ── Fund branch selector ─────────────────────────────────────────────────
  document.querySelectorAll('.fund-branch-btn').forEach(branchBtn => {
    branchBtn.addEventListener('click', () => {
      const branch = branchBtn.dataset.branch;
      document.querySelectorAll('.fund-branch-btn').forEach(b => b.classList.remove('active'));
      branchBtn.classList.add('active');
      document.getElementById('fund-branch-lp').style.display        = branch === 'lp'        ? 'block' : 'none';
      document.getElementById('fund-branch-portfolio').style.display = branch === 'portfolio' ? 'block' : 'none';
      if (branch === 'lp') {
        // When returning to LP Fund branch always show list view first
        showFundListView();
        loadFundList();
      }
      if (branch === 'portfolio') {
        loadYtdSnapshots();
        _rehydrateYtdResult();
      }
    });
  });

  // ── "Open Paper Portfolios" card — navigates to Ideas tab ────────────────
  const trackerCard = document.getElementById('fund-open-tracker-btn');
  if (trackerCard) {
    trackerCard.addEventListener('click', () => {
      showView('view-intelligence');
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.target === 'view-intelligence');
      });
    });
  }
});

// Re-render the most recent YTD result (from persisted account_history) so
// the attribution table is visible immediately when switching to My Portfolio.
async function _rehydrateYtdResult() {
  try {
    const data = await api.getLiveBenchmark();
    const h = data?.live_portfolio?.account_history;
    if (!h || !h.attribution) return;
    _renderUnifiedYtdResult({
      md_return_pct:       h.md_return_pct,
      twrr_return_pct:     h.twrr_return_pct    ?? null,
      begin_value:         h.begin_value,
      end_value:           h.end_value,
      emv_source:          h.emv_source || 'positions_csv',
      net_flow:            h.net_flow,
      flow_count:          h.flow_count,
      trade_count:         h.trade_count,
      dividend_count:      h.dividend_count,
      attribution:         h.attribution,
      flows:               h.flows               || [],
      unique_actions:      h.unique_actions      || [],
      monthly_chart:       h.monthly_chart       || null,
      monthly_chart_error: h.monthly_chart_error || null,
      has_monthly_perf:    h.has_monthly_perf    ?? false,
      total_dollar_gain: (h.attribution || []).reduce((s,a) => s + (a.dollar_gain || 0), 0),
      explained_pct: h.begin_value
        ? (h.attribution || []).reduce((s,a) => s + (a.dollar_gain || 0), 0) / h.begin_value * 100
        : 0,
    });
  } catch (_) { /* non-fatal — no previous run */ }
}

async function loadFundList() {
  const listEl = document.getElementById('fund-list-cards');
  if (!listEl) return;
  listEl.innerHTML = '<div class="fund-card-loading">Loading funds…</div>';

  async function fundFetch(path) {
    const r = await fetch(path, {
      headers: { 'x-auth-token': getToken(), 'x-fund-token': getFundToken() },
    });
    if (r.status === 403) {
      clearFundToken();
      showFundLock();
      throw new Error('fund_locked');
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`${r.status}${body ? ': ' + body : ''}`);
    }
    return r.json();
  }

  try {
    const funds = await fundFetch('/api/fund/list');
    if (!funds.length) {
      listEl.innerHTML = '<div class="fund-card-loading">No funds found in database.</div>';
      return;
    }
    listEl.innerHTML = `
      <div class="fund-list-hint">Select a fund to view details</div>
      ${funds.map(f => {
        const gainColor  = f.total_gain >= 0 ? '#c9a84c' : '#e05a4e';
        const statusCls  = (f.status || 'active').toLowerCase() === 'active' ? 'active' : 'closed';
        const statusLbl  = (f.status || 'active').toUpperCase();
        const econLabel  = `${(f.mgmt_fee_pct * 100).toFixed(0)} &amp; ${(f.carry_pct * 100).toFixed(0)}`;
        return `
        <div class="fund-summary-card" data-fund-id="${f.id}" data-fund-name="${escHtml(f.name)}">
          <div class="fund-summary-header">
            <div>
              <div class="fund-summary-name">${escHtml(f.name)}</div>
              <div class="fund-summary-short">${escHtml(f.short_name)}  ·  est. ${f.inception_date?.slice(0,4)}</div>
            </div>
            <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
              <span class="fund-summary-status ${statusCls}">${statusLbl}</span>
              <button class="fund-delete-btn" title="Delete fund" data-fund-id="${f.id}" data-fund-name="${escHtml(f.name)}"
                      onclick="event.stopPropagation(); confirmDeleteFund('${f.id}', '${escHtml(f.name)}')">✕</button>
            </div>
          </div>
          <div class="fund-summary-metrics">
            <div class="fund-summary-metric">
              <div class="fund-summary-metric-label">NAV</div>
              <div class="fund-summary-metric-value">${fmt$(f.nav)}</div>
            </div>
            <div class="fund-summary-metric">
              <div class="fund-summary-metric-label">GAIN</div>
              <div class="fund-summary-metric-value" style="color:${gainColor}">${fmtPct(f.gain_pct)}</div>
            </div>
            <div class="fund-summary-metric">
              <div class="fund-summary-metric-label">LPs</div>
              <div class="fund-summary-metric-value">${f.lp_count}</div>
            </div>
            <div class="fund-summary-metric">
              <div class="fund-summary-metric-label">POSITIONS</div>
              <div class="fund-summary-metric-value">${f.position_count || 0}</div>
            </div>
            <div class="fund-summary-metric">
              <div class="fund-summary-metric-label">ECONOMICS</div>
              <div class="fund-summary-metric-value">${econLabel}</div>
            </div>
          </div>
          <div class="fund-summary-cta">View Details →</div>
        </div>`;
      }).join('')}`;

    // Wire click handlers on each card
    listEl.querySelectorAll('.fund-summary-card').forEach(card => {
      card.addEventListener('click', () => {
        showFundDetailView(card.dataset.fundId, card.dataset.fundName);
      });
    });
  } catch (e) {
    if (e.message === 'fund_locked') return;
    listEl.innerHTML = `<div class="fund-error">Unable to load funds: ${e.message}</div>`;
  }
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function loadFund() {
  if (_fundLoaded) return;

  // Build query string with active fund ID if set
  const qs = _activeFundId ? `?fund_id=${encodeURIComponent(_activeFundId)}` : '';

  async function fundFetch(path) {
    const r = await fetch(path, {
      headers: { 'x-auth-token': getToken(), 'x-fund-token': getFundToken() },
    });
    if (r.status === 403) {
      // Fund token expired or revoked — re-show the lock screen.
      clearFundToken();
      _fundLoaded = false;
      showFundLock();
      throw new Error('fund_locked');
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`${r.status}${body ? ': ' + body : ''}`);
    }
    return r.json();
  }

  try {
    const [ov, lps, positions, activity, waterfall] = await Promise.all([
      fundFetch(`/api/fund/overview${qs}`),
      fundFetch(`/api/fund/lps${qs}`),
      fundFetch(`/api/fund/positions${qs}`),
      fundFetch(`/api/fund/activity${qs}`),
      fundFetch(`/api/fund/waterfall${qs}`),
    ]);

    renderFundOverview(ov);
    renderFundLPs(lps, ov);
    renderFundPositions(positions);
    renderFundActivity(activity);
    renderFundWaterfall(waterfall);
    _fundLoaded = true;

  } catch (e) {
    if (e.message === 'fund_locked') return;  // lock screen shown — do nothing
    const msg = `<div class="fund-error">Unable to load fund data: ${e.message}</div>`;
    ['fund-overview-cards','fund-lps-wrap','fund-positions-wrap',
     'fund-activity-wrap','fund-waterfall-wrap'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = msg;
    });
  }
}

// All fund/portfolio dollar amounts display as whole dollars (no cents).
function fmt$(n) {
  if (n == null) return '—';
  const abs = Math.abs(n);
  return (n < 0 ? '−$' : '$') + Math.round(abs).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function fmtPct(n, decimals = 1) {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return sign + Number(n).toFixed(decimals) + '%';
}
function fmtCat(cat) {
  return (cat || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function renderFundOverview(ov) {
  const gainColor = ov.total_gain >= 0 ? '#c9a84c' : '#e05a4e';
  document.getElementById('fund-overview-cards').innerHTML = `
    <div class="fund-stat-grid">
      <div class="fund-stat-card fund-stat-primary">
        <div class="fund-stat-label">CURRENT NAV</div>
        <div class="fund-stat-value">${fmt$(ov.nav)}</div>
        <div class="fund-stat-sub" style="color:${gainColor}">
          ${fmtPct(ov.gain_pct)} since inception
        </div>
      </div>
      <div class="fund-stat-card">
        <div class="fund-stat-label">CONTRIBUTIONS</div>
        <div class="fund-stat-value fund-stat-md">${fmt$(ov.contributions)}</div>
        <div class="fund-stat-sub">${ov.lp_count} limited partners</div>
      </div>
      <div class="fund-stat-card">
        <div class="fund-stat-label">TOTAL GAIN</div>
        <div class="fund-stat-value fund-stat-md" style="color:${gainColor}">${fmt$(ov.total_gain)}</div>
        <div class="fund-stat-sub">since ${ov.inception_date?.slice(0,4) || '—'}</div>
      </div>
      <div class="fund-stat-card">
        <div class="fund-stat-label">ECONOMICS</div>
        <div class="fund-stat-value fund-stat-sm">
          ${(ov.mgmt_fee_pct * 100).toFixed(0)} &amp; ${(ov.carry_pct * 100).toFixed(0)}
        </div>
        <div class="fund-stat-sub">${(ov.hurdle_pct * 100).toFixed(0)}% hurdle · ${ov.position_count} positions</div>
      </div>
    </div>`;
}

function renderFundLPs(lps, ov) {
  if (!lps.length) {
    document.getElementById('fund-lps-wrap').innerHTML = '<div class="fund-empty">No LP records found.</div>';
    return;
  }
  const rows = lps.map(lp => `
    <tr>
      <td class="fund-td-name">${lp.legal_name}</td>
      <td class="fund-td-num">${fmt$(lp.commitment)}</td>
      <td class="fund-td-num" style="color:#c9a84c">${fmt$(lp.gain)}</td>
      <td class="fund-td-num fund-td-bold">${fmt$(lp.current_value)}</td>
      <td class="fund-td-pct">${lp.share_pct.toFixed(1)}%</td>
    </tr>`).join('');
  document.getElementById('fund-lps-wrap').innerHTML = `
    <table class="fund-table">
      <thead>
        <tr>
          <th class="fund-th">LP</th>
          <th class="fund-th fund-th-num">Commitment</th>
          <th class="fund-th fund-th-num">Gain</th>
          <th class="fund-th fund-th-num">Current Value</th>
          <th class="fund-th fund-th-pct">Share</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderFundPositions(positions) {
  if (!positions.length) {
    document.getElementById('fund-positions-wrap').innerHTML = '<div class="fund-empty">No open positions.</div>';
    return;
  }
  const totalMktVal = positions.reduce((s, p) => s + (p.market_value || 0), 0);
  const rows = positions.map(p => {
    const hasMkt = p.market_value != null;
    const gainColor = (p.unrealized_gain || 0) >= 0 ? '#4cc870' : '#e06050';
    const mktWt = p.market_weight_pct != null ? p.market_weight_pct.toFixed(1) + '%' : '—';
    return `
    <tr>
      <td class="fund-td-ticker">${p.symbol}</td>
      <td class="fund-td-name fund-td-dim">${p.name}</td>
      <td class="fund-td-num">${Number(p.total_qty).toLocaleString()}</td>
      <td class="fund-td-num">${fmt$(p.avg_cost)}</td>
      <td class="fund-td-num">${fmt$(p.total_cost)}</td>
      <td class="fund-td-num" style="color:#c9a84c">${hasMkt ? fmt$(p.last_price) : '—'}</td>
      <td class="fund-td-num fund-td-bold">${hasMkt ? fmt$(p.market_value) : '—'}</td>
      <td class="fund-td-num" style="color:${gainColor}">${hasMkt ? fmt$(p.unrealized_gain) : '—'}</td>
      <td class="fund-td-pct">${mktWt}</td>
      <td class="fund-td-lots">${p.lot_count > 1 ? p.lot_count + ' lots' : '1 lot'}</td>
    </tr>`;
  }).join('');

  // Summary footer row
  const totalCost = positions.reduce((s, p) => s + (p.total_cost || 0), 0);
  const totalGain = positions.reduce((s, p) => s + (p.unrealized_gain || 0), 0);
  const gainColor = totalGain >= 0 ? '#4cc870' : '#e06050';
  const footer = totalMktVal > 0 ? `
    <tr style="border-top:1px solid rgba(201,168,76,0.2);">
      <td class="fund-td-ticker" style="color:#6a8aaa; font-size:10px; font-weight:600;">TOTAL</td>
      <td></td><td></td><td></td>
      <td class="fund-td-num fund-td-bold">${fmt$(totalCost)}</td>
      <td></td>
      <td class="fund-td-num fund-td-bold" style="color:#c9a84c">${fmt$(totalMktVal)}</td>
      <td class="fund-td-num" style="color:${gainColor}">${fmt$(totalGain)}</td>
      <td></td><td></td>
    </tr>` : '';

  document.getElementById('fund-positions-wrap').innerHTML = `
    <table class="fund-table">
      <thead>
        <tr>
          <th class="fund-th">Symbol</th>
          <th class="fund-th">Name</th>
          <th class="fund-th fund-th-num">Qty</th>
          <th class="fund-th fund-th-num">Avg Cost</th>
          <th class="fund-th fund-th-num">Cost Basis</th>
          <th class="fund-th fund-th-num" style="color:#c9a84c">Last Price</th>
          <th class="fund-th fund-th-num" style="color:#c9a84c">Mkt Value</th>
          <th class="fund-th fund-th-num">Unrealized</th>
          <th class="fund-th fund-th-pct">Wt%</th>
          <th class="fund-th">Lots</th>
        </tr>
      </thead>
      <tbody>${rows}${footer}</tbody>
    </table>`;
}

// ── Collapsible activity toggle ───────────────────────────────────────────────
let _activityCollapsed = true;
function toggleFundActivity() {
  _activityCollapsed = !_activityCollapsed;
  const wrap = document.getElementById('fund-activity-wrap');
  const chev = document.getElementById('fund-activity-chevron');
  if (wrap) wrap.style.display = _activityCollapsed ? 'none' : 'block';
  if (chev) chev.style.transform = _activityCollapsed ? '' : 'rotate(180deg)';
}

function renderFundActivity(activity) {
  if (!activity.length) {
    document.getElementById('fund-activity-wrap').innerHTML = '<div class="fund-empty">No transactions.</div>';
    return;
  }
  const rows = activity.map(a => `
    <tr>
      <td class="fund-td-date">${a.effective_date}</td>
      <td class="fund-td-cat"><span class="fund-cat-pill fund-cat-${a.category}">${fmtCat(a.category)}</span></td>
      <td class="fund-td-desc">${a.description}</td>
      <td class="fund-td-num fund-td-bold">${fmt$(a.amount)}</td>
    </tr>`).join('');
  document.getElementById('fund-activity-wrap').innerHTML = `
    <table class="fund-table">
      <thead>
        <tr>
          <th class="fund-th">Date</th>
          <th class="fund-th">Type</th>
          <th class="fund-th">Description</th>
          <th class="fund-th fund-th-num">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderFundWaterfall(w) {
  const hurdle_pct = (w.hurdle_pct * 100).toFixed(0);
  const carry_pct  = (w.carry_pct  * 100).toFixed(0);

  // Approximation warning banner (shown when annual NAV snapshots aren't entered yet)
  const approxWarning = w.data_source === 'approximation' ? `
    <div class="wfall-approx-warning">
      ⚠ Approximation — actual year-end NAVs not yet entered.
      Carry is estimated using ${hurdle_pct}% × ${w.years_since_inception} yrs on committed capital.
      Enter annual NAV snapshots for exact calculation.
    </div>` : '';

  // Per-LP breakdown rows
  const lpRows = (w.per_lp || []).map(lp => `
    <tr>
      <td class="fund-td-name">${lp.legal_name}</td>
      <td class="fund-td-num">${fmt$(lp.commitment)}</td>
      <td class="fund-td-num fund-carry-charge">−${fmt$(lp.carry_charge)}</td>
      <td class="fund-td-num fund-td-bold" style="color:#c9a84c">${fmt$(lp.nav_after_carry)}</td>
    </tr>`).join('');

  // Annual snapshots table (shown when year-end NAVs have been entered)
  const snapshots = w.annual_snapshots || [];
  const snapshotTable = snapshots.length > 0 ? `
    <div class="fund-section-row" style="margin-top:20px;">
      <div class="label section-label" style="font-size:10px;">YEAR-BY-YEAR WATERFALL</div>
    </div>
    <table class="fund-table">
      <thead>
        <tr>
          <th class="fund-th">Year</th>
          <th class="fund-th fund-th-num">Start NAV</th>
          <th class="fund-th fund-th-num">End NAV</th>
          <th class="fund-th fund-th-num">Gross Profit</th>
          <th class="fund-th fund-th-num">HWM Threshold</th>
          <th class="fund-th fund-th-num">Carry Earned</th>
          <th class="fund-th fund-th-num">GP Equity $</th>
          <th class="fund-th fund-th-num">GP Equity %</th>
        </tr>
      </thead>
      <tbody>
        ${snapshots.map(s => {
          const carryColor = s.carry_earned > 0 ? '#c9a84c' : '#4a5568';
          const profitColor = s.gross_profit >= 0 ? '#c9a84c' : '#e05a4e';
          return `
        <tr>
          <td class="fund-td-date" style="font-weight:700">${s.year}</td>
          <td class="fund-td-num">${fmt$(s.start_nav)}</td>
          <td class="fund-td-num" style="font-weight:700">${fmt$(s.end_nav)}</td>
          <td class="fund-td-num" style="color:${profitColor}">${fmt$(s.gross_profit)}</td>
          <td class="fund-td-num" style="color:#6080a0">${fmt$(s.hwm_threshold)}</td>
          <td class="fund-td-num" style="color:${carryColor};font-weight:${s.carry_earned > 0 ? '700' : '400'}">${s.carry_earned > 0 ? fmt$(s.carry_earned) : '—'}</td>
          <td class="fund-td-num fund-td-bold" style="color:#e8a060">${fmt$(s.gp_equity_end)}</td>
          <td class="fund-td-num" style="color:#e8a060">${s.accum_gp_pct != null ? s.accum_gp_pct.toFixed(2) + '%' : '—'}</td>
        </tr>`;
        }).join('')}
      </tbody>
    </table>` : '';

  // Carry-year badges
  const carryYears  = (w.carry_years || []).join(', ') || 'None';
  const hwmFmt      = fmt$(w.high_watermark);
  const gpPct       = w.gp_equity_pct != null ? w.gp_equity_pct.toFixed(2) + '%' : '—';
  const curYearNote = w.cur_year_new_carry > 0
    ? ` + ${fmt$(w.cur_year_new_carry)} est. ${new Date().getFullYear()} carry`
    : '';

  document.getElementById('fund-waterfall-wrap').innerHTML = `
    ${approxWarning}
    <div class="wfall-summary">
      <div class="wfall-row">
        <span class="wfall-label">Structure</span>
        <span class="wfall-value">$100K/yr hurdle · ${carry_pct}% carry above high-watermark</span>
      </div>
      <div class="wfall-row">
        <span class="wfall-label">Years since inception</span>
        <span class="wfall-value">${w.years_since_inception} yrs (as of ${w.as_of})</span>
      </div>
      <div class="wfall-row">
        <span class="wfall-label">Total fund gain</span>
        <span class="wfall-value">${fmt$(w.total_gain)}</span>
      </div>
      <div class="wfall-row">
        <span class="wfall-label">High-watermark (current)</span>
        <span class="wfall-value">${hwmFmt}</span>
      </div>
      <div class="wfall-row">
        <span class="wfall-label">Years carry was earned</span>
        <span class="wfall-value">${carryYears}</span>
      </div>
      <div class="wfall-row wfall-highlight">
        <span class="wfall-label">GP equity (${gpPct} of NAV${curYearNote})</span>
        <span class="wfall-value wfall-gp">${fmt$(w.gp_accrued_carry)}</span>
      </div>
      <div class="wfall-row wfall-highlight">
        <span class="wfall-label">LP net value (after GP carry)</span>
        <span class="wfall-value" style="color:#c9a84c">${fmt$(w.lp_nav_after_carry)}</span>
      </div>
    </div>

    <div class="fund-section-row" style="margin-top:16px;">
      <div class="label section-label" style="font-size:10px;">PER-LP BREAKDOWN</div>
    </div>
    <table class="fund-table">
      <thead>
        <tr>
          <th class="fund-th">LP</th>
          <th class="fund-th fund-th-num">Contributed</th>
          <th class="fund-th fund-th-num">GP Carry −</th>
          <th class="fund-th fund-th-num">Net Value</th>
        </tr>
      </thead>
      <tbody>${lpRows}</tbody>
    </table>
    ${snapshotTable}`;
}

// ── Import Positions (Fidelity CSV) ──────────────────────────────────────────
function triggerPositionsUpload() {
  const el = document.getElementById('positions-file-input');
  if (el) el.click();
}

async function handlePositionsUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const statusEl = document.getElementById('positions-import-status');
  statusEl.textContent = '⏳ Uploading positions…';
  statusEl.className = 'fund-import-status fund-import-status-loading';

  try {
    const form = new FormData();
    form.append('file', file);
    if (_activeFundId) form.append('fund_id', _activeFundId);

    const r = await fetch(`${API_BASE}/api/fund/import-positions`, {
      method: 'POST',
      headers: { 'x-auth-token': getToken(), 'x-fund-token': getFundToken() },
      body: form,
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);

    const n = body.imported || 0;
    const mkt = body.market_value_total != null ? ` · Market value: ${fmt$(body.market_value_total)}` : '';
    statusEl.textContent = `✓ Imported ${n} positions${mkt}`;
    statusEl.className = 'fund-import-status fund-import-status-ok';
    // Reload positions table
    _fundLoaded = false;
    loadFund();
  } catch (e) {
    statusEl.textContent = `✗ Import failed: ${e.message}`;
    statusEl.className = 'fund-import-status fund-import-status-err';
  }
  input.value = '';   // reset so same file can be re-uploaded
}

// ── Import Cap Table (CSV or XLSX) ───────────────────────────────────────────
function triggerCaptableUpload() {
  const el = document.getElementById('captable-file-input');
  if (el) el.click();
}

async function handleCaptableUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const statusEl = document.getElementById('captable-import-status');
  statusEl.textContent = '⏳ Uploading cap table…';
  statusEl.className = 'fund-import-status fund-import-status-loading';

  try {
    const form = new FormData();
    form.append('file', file);
    if (_activeFundId) form.append('fund_id', _activeFundId);

    const r = await fetch(`${API_BASE}/api/fund/import-captable`, {
      method: 'POST',
      headers: { 'x-auth-token': getToken(), 'x-fund-token': getFundToken() },
      body: form,
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);

    statusEl.textContent = `✓ ${body.message || `Imported ${body.imported || 0} LP records`}`;
    statusEl.className = 'fund-import-status fund-import-status-ok';
    _fundLoaded = false;
    loadFund();
  } catch (e) {
    statusEl.textContent = `✗ Import failed: ${e.message}`;
    statusEl.className = 'fund-import-status fund-import-status-err';
  }
  input.value = '';
}

// ── Import Annual NAV ─────────────────────────────────────────────────────────
function triggerAnnualNavUpload() {
  const el = document.getElementById('annual-nav-file-input');
  if (el) el.click();
}

async function handleAnnualNavUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const statusEl = document.getElementById('fund-annual-nav-status');
  statusEl.textContent = '⏳ Uploading annual NAV data…';
  statusEl.className = 'fund-import-status fund-import-status-loading';

  try {
    const form = new FormData();
    form.append('file', file);
    if (_activeFundId) form.append('fund_id', _activeFundId);

    const r = await fetch(`${API_BASE}/api/fund/import-annual-nav`, {
      method: 'POST',
      headers: { 'x-auth-token': getToken(), 'x-fund-token': getFundToken() },
      body: form,
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);

    statusEl.textContent = `✓ ${body.message || `Imported ${body.imported} rows`}`;
    statusEl.className = 'fund-import-status fund-import-status-ok';
    _fundLoaded = false;
    loadFund();
  } catch (e) {
    statusEl.textContent = `✗ Import failed: ${e.message}`;
    statusEl.className = 'fund-import-status fund-import-status-err';
  }
  input.value = '';
}

// ── Delete Fund ───────────────────────────────────────────────────────────────
async function confirmDeleteFund(fundId, fundName) {
  const ok = window.confirm(
    `Delete "${fundName}"?\n\nThis will permanently erase the fund and ALL its data — LPs, positions, transactions, and waterfall history.\n\nThis action CANNOT be undone. Continue?`
  );
  if (!ok) return;
  try {
    const r = await fetch(
      `${API_BASE}/api/fund/admin/delete?fund_id=${encodeURIComponent(fundId)}`,
      { method: 'DELETE',
        headers: { 'x-auth-token': getToken(), 'x-fund-token': getFundToken() } }
    );
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
    loadFundList();
  } catch (e) {
    alert(`Delete failed: ${e.message}`);
  }
}

// ── Deduplicate LP rows ────────────────────────────────────────────────────────
async function dedupLPs() {
  const statusEl = document.getElementById('captable-import-status');
  if (statusEl) {
    statusEl.textContent = '⏳ Removing duplicates…';
    statusEl.className = 'fund-import-status fund-import-status-loading';
  }
  try {
    const fid = _activeFundId;
    const url = `/api/fund/admin/dedup-lps${fid ? '?fund_id=' + encodeURIComponent(fid) : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-auth-token': getToken(), 'x-fund-token': getFundToken() }
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.detail || 'Error');
    if (statusEl) {
      statusEl.textContent = j.message || `Removed ${j.duplicates_removed} duplicate(s).`;
      statusEl.className = 'fund-import-status fund-import-status-ok';
    }
    if (j.duplicates_removed > 0) loadFundLPs();   // refresh LP table
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = '✗ ' + err.message;
      statusEl.className = 'fund-import-status fund-import-status-error';
    }
  }
}

// ── Export Fund to Excel ───────────────────────────────────────────────────────
async function exportFundExcel() {
  const statusEl = document.getElementById('fund-export-status');
  if (statusEl) {
    statusEl.textContent = '⏳ Generating Excel file…';
    statusEl.className = 'fund-import-status fund-import-status-loading';
  }
  try {
    const qs = _activeFundId ? `?fund_id=${encodeURIComponent(_activeFundId)}` : '';
    const r = await fetch(`${API_BASE}/api/fund/export-excel${qs}`, {
      headers: { 'x-auth-token': getToken(), 'x-fund-token': getFundToken() },
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.detail || `HTTP ${r.status}`);
    }
    // Trigger browser download
    const blob = await r.blob();
    const disp  = r.headers.get('content-disposition') || '';
    const match = disp.match(/filename="([^"]+)"/);
    const fname = match ? match[1] : 'Fund_Export.xlsx';
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href = url; a.download = fname; a.click();
    URL.revokeObjectURL(url);
    if (statusEl) {
      statusEl.textContent = `✓ Downloaded ${fname}`;
      statusEl.className = 'fund-import-status fund-import-status-ok';
    }
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = `✗ Export failed: ${e.message}`;
      statusEl.className = 'fund-import-status fund-import-status-err';
    }
  }
}

// ── Create New Fund ───────────────────────────────────────────────────────────
function toggleCreateFundForm() {
  const form = document.getElementById('create-fund-form');
  if (!form) return;
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
  const statusEl = document.getElementById('create-fund-status');
  if (statusEl) statusEl.textContent = '';
}

async function submitCreateFund() {
  const name     = (document.getElementById('cf-name')?.value || '').trim();
  const short    = (document.getElementById('cf-short')?.value || '').trim();
  const inception= (document.getElementById('cf-inception')?.value || '').trim();
  const mgmt     = parseFloat(document.getElementById('cf-mgmt')?.value || '2');
  const carry    = parseFloat(document.getElementById('cf-carry')?.value || '20');
  const hurdle   = parseFloat(document.getElementById('cf-hurdle')?.value || '8');
  const statusEl = document.getElementById('create-fund-status');

  // Accept bare year ("2017") → normalize to "2017-01-01"
  const inceptionNorm = /^\d{4}$/.test(inception) ? inception + '-01-01' : inception;

  if (!name || !short || !inceptionNorm) {
    statusEl.textContent = '✗ Name, short name, and inception date are required.';
    statusEl.className = 'fund-import-status fund-import-status-err';
    return;
  }

  statusEl.textContent = '⏳ Creating fund…';
  statusEl.className = 'fund-import-status fund-import-status-loading';

  try {
    const r = await fetch(`${API_BASE}/api/fund/admin/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-auth-token': getToken(),
        'x-fund-token': getFundToken(),
      },
      body: JSON.stringify({
        name,
        short_name: short,
        inception_date: inceptionNorm,
        mgmt_fee_pct: mgmt / 100,
        carry_pct: carry / 100,
        hurdle_pct: hurdle / 100,
        status: 'active',
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);

    statusEl.textContent = `✓ Fund "${name}" created!`;
    statusEl.className = 'fund-import-status fund-import-status-ok';
    // Clear form
    ['cf-name','cf-short','cf-inception','cf-mgmt','cf-carry','cf-hurdle']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    // Reload fund list
    setTimeout(() => {
      toggleCreateFundForm();
      loadFundList();
    }, 1200);
  } catch (e) {
    statusEl.textContent = `✗ ${e.message}`;
    statusEl.className = 'fund-import-status fund-import-status-err';
  }
}
