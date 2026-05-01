/**
 * DGA Capital — API client for React Native
 *
 * Auth flow (matches the web app exactly):
 *   1. App calls login(password) → POST /api/auth → server returns HMAC token
 *   2. Token is cached in AsyncStorage
 *   3. Every request sends   x-auth-token: <token>
 *   4. On 401, cached token is cleared and login is retried once with the
 *      stored password.  If that also fails, isAuthError is thrown.
 *
 * Default password is "dgacapital" (matches server default PORTFOLIO_PASSWORD).
 * Users only need to change it if they set a custom PORTFOLIO_PASSWORD in .env.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

// Build-time-injected API base URL. Set via eas.json's `env` block per profile:
//   • development → http://localhost:8000  (Mac running `npx expo start`)
//   • preview     → https://<your>.up.railway.app
//   • production  → https://<your>.up.railway.app  (LP-facing build)
// Falls back to localhost when running via plain `npx expo start` with no env.
const DEFAULT_BASE_URL   = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:8000';
const DEFAULT_PASSWORD   = 'dgacapital';           // server default

const BASE_URL_KEY  = '@dga_api_base_url';
const GAMMA_KEY     = '@dga_gamma_enabled';
const PASSWORD_KEY  = '@dga_password';             // plain-text password user entered
const TOKEN_KEY     = '@dga_token_cache';          // HMAC token returned by /api/auth

// ── Base URL ─────────────────────────────────────────────────────────────────
export async function getBaseUrl() {
  try {
    const s = await AsyncStorage.getItem(BASE_URL_KEY);
    return s || DEFAULT_BASE_URL;
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
    const s = await AsyncStorage.getItem(GAMMA_KEY);
    return s === null ? false : s === 'true';   // default OFF
  } catch { return false; }
}
export async function setGammaEnabled(v) {
  await AsyncStorage.setItem(GAMMA_KEY, v ? 'true' : 'false');
}

// ── Auth ──────────────────────────────────────────────────────────────────────
/** Exchange a plain password for the server's HMAC token and cache it. */
export async function login(password) {
  const base = await getBaseUrl();
  const resp = await fetch(`${base}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: password.trim() }),
  });
  if (!resp.ok) {
    const err = new Error('Incorrect password');
    err.isAuthError = true;
    throw err;
  }
  const { token } = await resp.json();
  await AsyncStorage.multiSet([
    [PASSWORD_KEY, password.trim()],
    [TOKEN_KEY,    token],
  ]);
  return token;
}

/** Get the cached HMAC token, auto-authenticating with the stored password
 *  (or the server default "dgacapital") if no token is cached yet. */
export async function getToken() {
  try {
    const cached = await AsyncStorage.getItem(TOKEN_KEY);
    if (cached) return cached;
    // No token yet — silently authenticate with stored/default password
    const password = (await AsyncStorage.getItem(PASSWORD_KEY)) || DEFAULT_PASSWORD;
    return await login(password);
  } catch {
    return '';
  }
}

export async function getStoredPassword() {
  try { return (await AsyncStorage.getItem(PASSWORD_KEY)) || ''; }
  catch { return ''; }
}

export async function clearToken() {
  await AsyncStorage.removeItem(TOKEN_KEY);
}

// ── Core fetch helper ─────────────────────────────────────────────────────────
async function request(path, options = {}, _isRetry = false) {
  const [base, token] = await Promise.all([getBaseUrl(), getToken()]);
  const url = `${base}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['x-auth-token'] = token;

  const resp = await fetch(url, { ...options, headers });

  if (resp.status === 401) {
    // Token may be stale — clear it and retry once by re-authenticating
    await clearToken();
    if (!_isRetry) {
      return request(path, options, true);
    }
    // Still 401 after re-auth → wrong password in Settings
    const err = new Error('Incorrect password. Please update it in Settings → Server Password.');
    err.isAuthError = true;
    throw err;
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status}: ${text}`);
  }
  return resp.json();
}

// ── Public API surface ────────────────────────────────────────────────────────
export const api = {
  // ---------- Health (no auth needed) ----------
  health: async () => {
    const base = await getBaseUrl();
    const resp = await fetch(`${base}/health`);
    if (!resp.ok) throw new Error(`${resp.status}`);
    return resp.json();
  },

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
    fd.append('file', { uri: fileUri, name: fileName || 'portfolio.xlsx',
      type: mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    fd.append('strategy',       strategy      || 'pro');
    fd.append('reuse_existing', reuseExisting ? 'true' : 'false');
    fd.append('generate_gamma', generateGamma ? 'true' : 'false');
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
  getWatchlist:        ()       => request('/api/watchlist'),
  addToWatchlist:      (ticker) => request(`/api/watchlist/${ticker}`, { method: 'POST' }),
  removeFromWatchlist: (ticker) => request(`/api/watchlist/${ticker}`, { method: 'DELETE' }),

  // ---------- Market Scan ----------
  startScan:     (tickers) => request('/api/scan', {
    method: 'POST', body: JSON.stringify({ tickers }),
  }),
  getScanJob:    (jobId) => request(`/api/scan/${jobId}`),
  getLatestScan: ()      => request('/api/scan/latest'),

  // ---------- Market Intelligence ----------
  startIntelligence: (days = 30) => request('/api/intelligence', {
    method: 'POST', body: JSON.stringify({ days }),
  }),
  getIntelligenceJob:    (jobId) => request(`/api/intelligence/${jobId}`),
  getLatestIntelligence: ()      => request('/api/intelligence/latest'),

  // ---------- Paper Portfolio Tracker ----------
  createTracker: (body) => request('/api/track', {
    method: 'POST', body: JSON.stringify(body),
  }),
  listTrackers:           ()    => request('/api/track'),
  getTracker:             (id)  => request(`/api/track/${id}`),
  closeTracker:           (id)  => request(`/api/track/${id}/close`, { method: 'POST' }),
  deleteTracker:          (id)  => request(`/api/track/${id}`, { method: 'DELETE' }),
  getLiveBenchmark:       ()    => request('/api/track/live'),
  getLiveBenchmarkDetail: (snapshotId) => request(
    '/api/track/live/detail' + (snapshotId ? `?snapshot_id=${encodeURIComponent(snapshotId)}` : '')
  ),
  listYtdSnapshots:       ()    => request('/api/track/live/snapshots'),
  deleteYtdSnapshot:      (id)  => request(`/api/track/live/snapshots/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  emailYtdReport:         (email, snapshotId) => request('/api/track/live/ytd/email', {
    method: 'POST',
    body:   JSON.stringify({ email, snapshot_id: snapshotId || null }),
  }),

  // Unified YTD: Modified Dietz return + per-stock attribution in ONE call.
  // Today's total value is auto-extracted from the Positions CSV (sum of all
  // positions × current prices + money market) — no manual entry needed.
  computeUnifiedYtd: async ({
    positionsUri, positionsName, positionsType,
    activityUri,  activityName,  activityType,
    beginValue,
  }) => {
    const [base, token] = await Promise.all([getBaseUrl(), getToken()]);
    const fd = new FormData();
    fd.append('positions_file', {
      uri:  positionsUri,
      name: positionsName || 'positions.csv',
      type: positionsType || 'text/csv',
    });
    fd.append('activity_file', {
      uri:  activityUri,
      name: activityName || 'activity.csv',
      type: activityType || 'text/csv',
    });
    fd.append('begin_value', String(beginValue));
    fd.append('token',       token || '');
    const headers = {};
    if (token) headers['x-auth-token'] = token;
    const resp = await fetch(`${base}/api/track/live/ytd`, {
      method:  'POST',
      headers,
      body:    fd,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text || `${resp.status}`);
    }
    return resp.json();
  },
};
