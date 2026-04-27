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

function renderIntelResult(data) {
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
