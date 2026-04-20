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
    if (t === 'view-home') loadReports();
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

// ---------- Reports list ----------
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
          ${r.has_docx ? '<span class="badge">DOCX</span>' : ''}
          ${r.has_pptx ? '<span class="badge gold">PPTX</span>' : ''}
          <span class="chevron">›</span>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('.report-item').forEach(el => {
      el.addEventListener('click', () => openReport(el.dataset.ticker));
    });
  } catch (err) {
    list.innerHTML = `<div class="empty">Could not load reports: ${err.message}</div>`;
  }
}

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
    window.location.href = `${API_BASE}/api/download/${ticker}/docx`;
  document.getElementById('download-pptx').onclick = () =>
    window.location.href = `${API_BASE}/api/download/${ticker}/pptx`;

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
    portfolioStatusText.textContent = 'Queued…';
    portfolioResultBox.style.display = 'none';
    portfolioErrorBox.style.display = 'none';
    portfolioDownloadBtn.style.display = 'none';

    try {
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
    } else if (job.status === 'failed') {
      clearInterval(portfolioPollTimer);
      portfolioStatusText.textContent = '❌ Failed';
      portfolioErrorBox.textContent = job.error || 'Unknown error';
      portfolioErrorBox.style.display = 'block';
    }
  } catch (err) {
    clearInterval(portfolioPollTimer);
    portfolioErrorBox.textContent = err.message;
    portfolioErrorBox.style.display = 'block';
  }
}

function renderPortfolioResult(result) {
  if (!result) return;
  const primary = result.primary_strategy;
  const order = [primary, ...Object.keys(result.strategies).filter(k => k !== primary)];
  const blocks = order.map(k => {
    const s = result.strategies[k];
    if (!s) return '';
    const weights = Object.entries(s.weights)
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
  portfolioResultBox.innerHTML = blocks;
  portfolioResultBox.style.display = 'block';
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

// ---------- Boot ----------
async function boot() {
  checkServer();
  loadReports();
  loadStrategies();
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
