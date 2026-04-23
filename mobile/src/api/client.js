import AsyncStorage from '@react-native-async-storage/async-storage';

const DEFAULT_BASE_URL = 'http://localhost:8000';
const BASE_URL_KEY = '@dga_api_base_url';
const GAMMA_KEY    = '@dga_gamma_enabled';
const TOKEN_KEY    = '@dga_auth_token';

// ── Base URL ─────────────────────────────────────────────────────────────────
export async function getBaseUrl() {
  try {
    const stored = await AsyncStorage.getItem(BASE_URL_KEY);
    return stored || DEFAULT_BASE_URL;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

export async function setBaseUrl(url) {
  await AsyncStorage.setItem(BASE_URL_KEY, url.replace(/\/$/, ''));
}

// ── Gamma preference ─────────────────────────────────────────────────────────
export async function getGammaEnabled() {
  try {
    const stored = await AsyncStorage.getItem(GAMMA_KEY);
    return stored === null ? true : stored === 'true'; // default ON
  } catch {
    return true;
  }
}

export async function setGammaEnabled(value) {
  await AsyncStorage.setItem(GAMMA_KEY, value ? 'true' : 'false');
}

// ── Auth token ───────────────────────────────────────────────────────────────
export async function getToken() {
  try {
    return (await AsyncStorage.getItem(TOKEN_KEY)) || '';
  } catch {
    return '';
  }
}

export async function setToken(token) {
  await AsyncStorage.setItem(TOKEN_KEY, token.trim());
}

// ── Core fetch helper (injects x-auth-token automatically) ───────────────────
async function request(path, options = {}) {
  const [base, token] = await Promise.all([getBaseUrl(), getToken()]);
  const url = `${base}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['x-auth-token'] = token;
  const resp = await fetch(url, { ...options, headers });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status}: ${text}`);
  }
  return resp.json();
}

// ── Public API surface ────────────────────────────────────────────────────────
export const api = {
  // ---------- Health ----------
  health: () => request('/health'),

  // ---------- Single-ticker analysis ----------
  startAnalysis: (ticker, generateGamma = false) =>
    request('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({ ticker, generate_gamma: generateGamma }),
    }),

  getJobStatus: (jobId) => request(`/api/jobs/${jobId}`),
  listJobs:     ()       => request('/api/jobs'),
  getReport:    (ticker) => request(`/api/report/${ticker}`),
  listReports:  ()       => request('/api/reports'),
  getQuote:     (ticker) => request(`/api/quote/${ticker}`),

  downloadUrl: async (ticker, type) => {
    const base = await getBaseUrl();
    return `${base}/api/download/${ticker}/${type}`;
  },

  // ---------- Portfolio ----------
  listStrategies: () => request('/api/strategies'),

  startPortfolio: async ({ fileUri, fileName, mimeType, strategy, reuseExisting, generateGamma }) => {
    const [base, token] = await Promise.all([getBaseUrl(), getToken()]);
    const fd = new FormData();
    fd.append('file', {
      uri:  fileUri,
      name: fileName || 'portfolio.xlsx',
      type: mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    fd.append('strategy',       strategy       || 'pro');
    fd.append('reuse_existing', reuseExisting  ? 'true' : 'false');
    fd.append('generate_gamma', generateGamma  ? 'true' : 'false');
    const headers = {};
    if (token) headers['x-auth-token'] = token;
    const resp = await fetch(`${base}/api/portfolio`, { method: 'POST', headers, body: fd });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${resp.status}: ${text}`);
    }
    return resp.json();
  },

  getPortfolioJob: (jobId) => request(`/api/portfolio/${jobId}`),

  portfolioDownloadUrl: async (jobId) => {
    const base = await getBaseUrl();
    return `${base}/api/portfolio/${jobId}/download`;
  },

  getLastPortfolio:    () => request('/api/portfolio/last'),
  getPortfolioSummary: () => request('/api/portfolio/summary'),

  // ---------- Watchlist ----------
  getWatchlist:         ()       => request('/api/watchlist'),
  addToWatchlist:       (ticker) => request(`/api/watchlist/${ticker}`, { method: 'POST' }),
  removeFromWatchlist:  (ticker) => request(`/api/watchlist/${ticker}`, { method: 'DELETE' }),

  // ---------- Market Scan ----------
  startScan: (tickers) =>
    request('/api/scan', {
      method: 'POST',
      body: JSON.stringify({ tickers }),
    }),
  getScanJob:    (jobId) => request(`/api/scan/${jobId}`),
  getLatestScan: ()      => request('/api/scan/latest'),
};
