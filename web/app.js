// ============================================================================
// DGA Research Analyst — Web UI
// ============================================================================
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
  startIntelligence: (days) => apiPost('/api/intelligence', { days }),
  getIntelligenceJob: (id) => apiGet(`/api/intelligence/${id}`),
  getLatestIntelligence: () => apiGet('/api/intelligence/latest'),
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
    if (t === 'view-portfolio') rehydratePortfolioLastCard();
  });
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
    const strategy = document.querySelector('input[name="strategy"]:checked')?.value || 'pro';
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
      portfolioStatusText.textContent =
        `${job.status === 'running' ? 'Analyzing' : 'Queued'} — ${job.n_tickers} tickers (${job.strategy})…`;
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

// Load strategy metadata from the server (keeps UI in sync with backend).
async function loadStrategies() {
  try {
    const strategies = await api.listStrategies();
    const list = document.getElementById('strategy-list');
    if (!list || !strategies?.length) return;
    list.innerHTML = strategies.map((s, i) => `
      <label class="strategy-option">
        <input type="radio" name="strategy" value="${s.key}" ${i === 0 ? 'checked' : ''}>
        <div class="strategy-body">
          <div class="strategy-title">${s.label}</div>
          <div class="strategy-desc">${s.description}</div>
        </div>
      </label>
    `).join('');
  } catch {
    // keep static fallback
  }
}

// ============================================================================
// REAL-TIME PRICES — inject live price tags into the Saved Reports list
// ============================================================================
async function injectReportPrices(reports) {
  if (!reports || !reports.length) return;
  // Fan out all quote fetches in parallel — non-blocking, best-effort.
  const fetches = reports.map(async r => {
    const el = document.getElementById(`price-tag-${r.ticker}`);
    if (!el) return;
    try {
      const q = await api.getQuote(r.ticker);
      if (!q?.price) return;
      const price = Number(q.price);
      const prev  = Number(q.previous_close);
      el.textContent = `$${price.toFixed(2)}`;
      if (prev && prev > 0) {
        const pct = ((price - prev) / prev) * 100;
        const sign = pct >= 0 ? '+' : '';
        el.title = `${sign}${pct.toFixed(2)}% today`;
        el.className = `report-price-tag ${pct > 0 ? 'up' : pct < 0 ? 'down' : ''}`;
        el.textContent = `$${price.toFixed(2)} (${sign}${pct.toFixed(1)}%)`;
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
// Updated loadReports — now also fetches live prices
// ============================================================================
async function loadReports() {
  const list = document.getElementById('reports-list');
  try {
    const reports = await api.listReports();
    if (!reports.length) {
      list.innerHTML = '<div class="empty">No reports yet. Run your first analysis above.</div>';
      return;
    }
    list.innerHTML = reports.map(r => `
      <div class="report-item" data-ticker="${r.ticker}">
        <div class="report-item-left">
          <div class="ticker-name">${r.ticker}</div>
          <div class="date">${formatDate(r.generated_at)}</div>
        </div>
        <div class="report-item-right">
          <span class="report-price-tag" id="price-tag-${r.ticker}">…</span>
          ${r.has_docx ? '<span class="badge">DOCX</span>' : ''}
          ${r.has_pptx ? '<span class="badge gold">PPTX</span>' : ''}
          <span class="chevron">›</span>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('.report-item').forEach(el => {
      el.addEventListener('click', () => openReport(el.dataset.ticker));
    });
    // Kick off price fetches without blocking the render.
    injectReportPrices(reports);
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

let _intelDays = 30;
let _intelPollTimer = null;

function initIntelligence() {
  // Horizon pill wiring
  document.querySelectorAll('.intel-horizon-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.intel-horizon-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _intelDays = parseInt(btn.dataset.days, 10);
    });
  });

  // Run button
  document.getElementById('intel-run-btn')?.addEventListener('click', runIntelligence);

  // Load latest persisted brief
  loadLatestIntelligence();
}

async function loadLatestIntelligence() {
  try {
    const data = await api.getLatestIntelligence();
    if (data?.exists && data?.markdown) {
      renderIntelResult(data);
    }
  } catch { /* server offline — silent */ }
}

async function runIntelligence() {
  const btn = document.getElementById('intel-run-btn');
  const statusEl = document.getElementById('intel-status');
  const errEl = document.getElementById('intel-error');

  btn.disabled = true;
  btn.textContent = '⏳ Running…';
  statusEl.style.display = 'block';
  statusEl.textContent = 'Queued — starting shortly…';
  errEl.style.display = 'none';
  document.getElementById('intel-empty').style.display = 'none';

  clearInterval(_intelPollTimer);

  try {
    const job = await api.startIntelligence(_intelDays);
    _intelPollTimer = setInterval(async () => {
      try {
        const j = await api.getIntelligenceJob(job.job_id);
        if (j.status === 'done') {
          clearInterval(_intelPollTimer);
          btn.disabled = false;
          btn.textContent = '💡 Run Intelligence';
          statusEl.style.display = 'none';
          if (j.result?.ok) {
            renderIntelResult(j.result);
          } else {
            showIntelError(j.result?.error || j.error || 'Unknown error');
          }
        } else if (j.status === 'failed') {
          clearInterval(_intelPollTimer);
          btn.disabled = false;
          btn.textContent = '💡 Run Intelligence';
          statusEl.style.display = 'none';
          showIntelError(j.error || 'Intelligence run failed');
        } else {
          statusEl.textContent = j.status === 'running'
            ? 'Scanning X and web for market signals…'
            : 'Queued — starting shortly…';
        }
      } catch (err) {
        clearInterval(_intelPollTimer);
        btn.disabled = false;
        btn.textContent = '💡 Run Intelligence';
        statusEl.style.display = 'none';
        showIntelError(err.message);
      }
    }, 3000);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '💡 Run Intelligence';
    statusEl.style.display = 'none';
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

function renderIntelResult(data) {
  _latestBrief = data;

  // Hide empty state
  document.getElementById('intel-empty').style.display = 'none';

  // Meta
  const card = document.getElementById('intel-result-card');
  card.style.display = 'block';
  document.getElementById('intel-days-label').textContent = `${data.days}-day lookback`;
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
  // Mode toggle on Portfolio tab
  document.querySelectorAll('.port-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.portMode;
      document.querySelectorAll('.port-mode-btn').forEach(b =>
        b.classList.toggle('active', b === btn));
      document.getElementById('port-mode-rebalance').style.display =
        mode === 'rebalance' ? '' : 'none';
      document.getElementById('port-mode-tracker').style.display =
        mode === 'tracker' ? '' : 'none';
      if (mode === 'tracker') {
        loadTrackers();
        loadLiveBenchmark();
      }
    });
  });

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
    const data = await api.listYtdSnapshots();
    const snaps = data?.snapshots || [];
    if (!snaps.length) { card.style.display = 'none'; return; }
    card.style.display = '';
    list.innerHTML = snaps.map(s => _ytdSnapshotRowHtml(s)).join('');
    list.querySelectorAll('.ytd-snap-row').forEach(el => {
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('.ytd-snap-delete')) return;  // ignore delete clicks
        openLiveBenchmarkDetail(el.dataset.id);
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

function _ytdSnapshotRowHtml(s) {
  const md = s.md_return_pct ?? 0;
  const cls = md >= 0 ? 'green' : 'red';
  const sign = md >= 0 ? '+' : '';
  const dt = s.uploaded_at ? new Date(s.uploaded_at).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }) : '—';
  const usd0 = (v) => v == null ? '—' : (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', {maximumFractionDigits: 0});
  return `<div class="ytd-snap-row" data-id="${s.id}">
    <div class="ytd-snap-row-left">
      <div class="ytd-snap-date">${dt}</div>
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
  const histCard = document.getElementById('history-upload-card');
  if (!wrap) return;
  try {
    const data = await api.getLiveBenchmark();
    const live = data?.live_portfolio;
    if (!live) {
      wrap.innerHTML = `<div class="tracker-live-empty">
        No live portfolio yet. Upload your portfolio on the Live Rebalance tab to set a benchmark.
      </div>`;
      card?.classList.remove('clickable');
      card?.removeAttribute('role');
      if (histCard) histCard.style.display = 'none';
      return;
    }

    // Load snapshot history (newest first) — shows past YTD runs above the
    // upload card so the user can re-open / email any one of them.
    loadYtdSnapshots();

    // Show the unified YTD card once we have a live portfolio
    if (histCard) {
      histCard.style.display = '';
      // If a previous unified-YTD upload was persisted, re-render it from
      // live.account_history (which now also stores the attribution rows).
      const h = live.account_history;
      if (h && h.attribution) {
        _renderUnifiedYtdResult({
          md_return_pct:     h.md_return_pct,
          begin_value:       h.begin_value,
          end_value:         h.end_value,
          emv_source:        h.emv_source || 'positions_csv',
          net_flow:          h.net_flow,
          flow_count:        h.flow_count,
          trade_count:       h.trade_count,
          dividend_count:    h.dividend_count,
          attribution:       h.attribution,
          // total / explained recomputed from rows so it matches even if not stored
          total_dollar_gain: (h.attribution || []).reduce((s,a) => s + (a.dollar_gain || 0), 0),
          explained_pct:     h.begin_value
            ? (h.attribution || []).reduce((s,a) => s + (a.dollar_gain || 0), 0) / h.begin_value * 100
            : 0,
        });
      }
    }

    const n = (live.holdings || []).length;
    const sorted = (live.holdings || [])
      .slice().sort((a, b) => b.weight - a.weight);
    const chipsHtml = sorted.map(h =>
      `<span class="live-chip">
         <span class="live-chip-ticker">${h.ticker}</span>
         <span class="live-chip-weight">${(h.weight * 100).toFixed(1)}%</span>
       </span>`
    ).join('');

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
  const beginInput = document.getElementById('history-begin-value');
  const statusEl   = document.getElementById('history-upload-status');
  const resultBox  = document.getElementById('history-result-box');
  const btn        = document.getElementById('history-upload-btn');

  const posFile    = posInput?.files?.[0];
  const actFile    = actInput?.files?.[0];
  const beginValue = parseFloat(beginInput?.value);

  if (!posFile)             { alert('Please select your Fidelity Positions CSV.'); return; }
  if (!actFile)             { alert('Please select your Fidelity Activity CSV.'); return; }
  if (!beginValue || beginValue <= 0) {
    alert('Please enter your Jan 1 portfolio value.'); return;
  }

  btn.disabled = true;
  if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Calculating YTD return + transaction attribution…'; }
  if (resultBox) resultBox.style.display = 'none';

  try {
    const fd = new FormData();
    fd.append('positions_file', posFile);
    fd.append('activity_file',  actFile);
    fd.append('begin_value',    beginValue);
    fd.append('token',          getToken());

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
    // Refresh the live benchmark card so the YTD detail picks up new attribution
    await loadLiveBenchmark();
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
    return (v < 0 ? '−' : '') + '$' + abs.toLocaleString('en-US', { maximumFractionDigits: 0 });
  };
  const fmtUSD2 = (v) => {
    const abs = Math.abs(v ?? 0);
    return (v < 0 ? '−' : '') + '$' + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const fmtPct  = (v, d=2) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
  const fmtSh   = (n) => n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const cls     = (v) => v == null ? '' : v >= 0 ? 'green' : 'red';
  const sign    = (v) => v == null ? '' : v >= 0 ? '+' : '';

  const md       = data.md_return_pct ?? 0;
  const netFlow  = data.net_flow      ?? 0;

  // ── Per-ticker attribution rows (clean, summarized) ──────────────────────
  const attribRows = (data.attribution || []).map(a => {
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

  box.style.display = '';
  box.innerHTML = `
    <div class="ytd-result-grid">
      <div class="ytd-stat hero">
        <div class="ytd-stat-label">YTD Return</div>
        <div class="ytd-stat-val ${cls(md)}">${sign(md)}${md.toFixed(2)}%</div>
        <div class="ytd-stat-sub">cash-flow adjusted (Modified Dietz)</div>
      </div>
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

    <div class="attr-table-title">PERFORMANCE ATTRIBUTION — by holding (transaction-aware)</div>
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
    </div>`;
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
    list.innerHTML = `<div class="empty">No paper portfolios yet. Generate an Intelligence brief, then tap <strong>📌 Track This Brief</strong>.</div>`;
    return;
  }
  list.innerHTML = _trackerCache.map(p => trackerRowHtml(p)).join('');
  list.querySelectorAll('.tracker-row').forEach(el => {
    el.addEventListener('click', () => openTrackerDetail(el.dataset.id));
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
        lookback_days: _latestBrief?.days,
        brief_generated_at: _latestBrief?.generated_at,
      },
    });
    closeTrackModal();
    // Switch to Portfolio → Tracker mode and refresh
    showView('view-portfolio');
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.target === 'view-portfolio');
    });
    document.querySelector('.port-mode-btn[data-port-mode="tracker"]')?.click();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = '📌 Lock In Portfolio';
  }
}
