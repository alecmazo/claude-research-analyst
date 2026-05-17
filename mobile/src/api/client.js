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

// API base URL.
// CRITICAL: the production fallback MUST be the public Railway URL —
// `localhost` from an iPhone points to the phone itself, never your Mac.
// `EXPO_PUBLIC_API_BASE_URL` is build-time-injected via eas.json env blocks
// (development → localhost:8000 for the simulator), but if it's missing
// (e.g. an OTA bundle published from a shell without that env var set)
// we default to Railway so the iPhone can still reach the API.
const PROD_API_BASE_URL  = 'https://dga-portfolio.up.railway.app';
const DEFAULT_BASE_URL   = process.env.EXPO_PUBLIC_API_BASE_URL || PROD_API_BASE_URL;
const DEFAULT_PASSWORD   = 'dgacapital';           // server default

const BASE_URL_KEY  = '@dga_api_base_url';
const GAMMA_KEY     = '@dga_gamma_enabled';
const PASSWORD_KEY  = '@dga_password';             // plain-text password user entered
const TOKEN_KEY     = '@dga_token_cache';          // HMAC token returned by /api/auth
const FUND_TOKEN_KEY = '@dga_fund_token';          // fund-specific access token

// v2 per-user auth — email + password → signed claims token (role + scope).
// Runs ALONGSIDE the legacy v1 flow until all screens migrate to v2.
const V2_TOKEN_KEY = '@dga_v2_token';
const V2_USER_KEY  = '@dga_v2_user';

// Migrate stale `localhost` URLs that older builds saved to AsyncStorage.
// On a real iPhone (TestFlight build) localhost is meaningless and every
// request fails with "Network request failed" — auto-redirect to Railway.
function isInvalidStoredUrl(url) {
  if (!url) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url);
}

// ── Base URL ─────────────────────────────────────────────────────────────────
export async function getBaseUrl() {
  try {
    const s = await AsyncStorage.getItem(BASE_URL_KEY);
    if (isInvalidStoredUrl(s)) {
      // Stale dev URL — overwrite with Railway and surface that to callers.
      if (s) {
        try { await AsyncStorage.setItem(BASE_URL_KEY, DEFAULT_BASE_URL); } catch {}
      }
      return DEFAULT_BASE_URL;
    }
    return s;
  } catch {
    return DEFAULT_BASE_URL;
  }
}
export async function setBaseUrl(url) {
  await AsyncStorage.setItem(BASE_URL_KEY, url.replace(/\/$/, ''));
}
// Force-reset whatever URL is stored back to the production default. Wired
// to the "Reset Server URL" button in Settings so the user can self-recover
// if a bad URL got cached and the app can't reach the API.
export async function resetBaseUrlToProd() {
  await AsyncStorage.setItem(BASE_URL_KEY, DEFAULT_BASE_URL);
  return DEFAULT_BASE_URL;
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

// ── v2 Auth (email + password, role-aware) ────────────────────────────────────
/** Sign in via POST /api/auth/v2/login. Stores the token + user record
 *  in AsyncStorage and returns the user object. Throws with isAuthError
 *  on a 401. */
export async function loginV2(email, password) {
  const base = await getBaseUrl();
  const resp = await fetch(`${base}/api/auth/v2/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: String(email || '').trim(),
      password: String(password || ''),
    }),
  });
  if (resp.status === 401) {
    const err = new Error('Invalid email or password');
    err.isAuthError = true;
    throw err;
  }
  if (!resp.ok) {
    throw new Error(`Login failed (${resp.status})`);
  }
  const data = await resp.json();
  const user = {
    lp_id:                data.lp_id,
    name:                 data.name,
    email:                data.email,
    role:                 data.role,
    must_change_password: data.must_change_password,
    fund_memberships:     data.fund_memberships || {},
    managed_account_ids:  data.managed_account_ids || [],
    impersonated:         data.impersonated || false,
  };
  await AsyncStorage.multiSet([
    [V2_TOKEN_KEY, data.token],
    [V2_USER_KEY,  JSON.stringify(user)],
  ]);
  return user;
}

/** Get the cached v2 user (no network). Returns null if not signed in. */
export async function getV2User() {
  try {
    const raw = await AsyncStorage.getItem(V2_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Get the cached v2 token. Returns '' if not signed in. */
export async function getV2Token() {
  try { return (await AsyncStorage.getItem(V2_TOKEN_KEY)) || ''; }
  catch { return ''; }
}

/** Verify the cached v2 token against /me. Refreshes the cached user
 *  record on success. Returns the user or null. */
export async function whoamiV2() {
  const [base, tok] = await Promise.all([getBaseUrl(), getV2Token()]);
  if (!tok) return null;
  try {
    const r = await fetch(`${base}/api/auth/v2/me`, {
      headers: { 'x-auth-v2-token': tok },
    });
    if (!r.ok) {
      // Token rejected — clear it so the user sees the login screen
      await AsyncStorage.multiRemove([V2_TOKEN_KEY, V2_USER_KEY]);
      return null;
    }
    const me = await r.json();
    await AsyncStorage.setItem(V2_USER_KEY, JSON.stringify(me));
    return me;
  } catch {
    return null;
  }
}

/** Sign out of v2. Clears the token + cached user record. */
export async function logoutV2() {
  await AsyncStorage.multiRemove([V2_TOKEN_KEY, V2_USER_KEY]);
}

/** Wrapped fetch that auto-attaches the v2 token. Use for any /api/v2/*
 *  call. Returns the raw Response object. */
export async function v2Fetch(path, options = {}) {
  const [base, tok] = await Promise.all([getBaseUrl(), getV2Token()]);
  const url = `${base}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (tok) headers['x-auth-v2-token'] = tok;
  return fetch(url, { ...options, headers });
}

// ── Fund token ────────────────────────────────────────────────────────────────
export async function getFundToken() {
  try { return (await AsyncStorage.getItem(FUND_TOKEN_KEY)) || ''; }
  catch { return ''; }
}
export async function setFundToken(token) {
  await AsyncStorage.setItem(FUND_TOKEN_KEY, token);
}
export async function clearFundToken() {
  await AsyncStorage.removeItem(FUND_TOKEN_KEY);
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
  getSpyYtd:    ()       => request('/api/market/spy-ytd'),
  getTickerMeta: (ticker) => request(`/api/market/ticker-meta/${encodeURIComponent(ticker)}`),
  deleteReport: (ticker) => request(`/api/report/${ticker}`, { method: 'DELETE' }),

  downloadUrl: async (ticker, type) => {
    const [base, token] = await Promise.all([getBaseUrl(), getToken()]);
    const t = token ? `?token=${encodeURIComponent(token)}` : '';
    return `${base}/api/download/${ticker}/${type}${t}`;
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
    const [base, token] = await Promise.all([getBaseUrl(), getToken()]);
    const t = token ? `?token=${encodeURIComponent(token)}` : '';
    return `${base}/api/portfolio/${jobId}/download${t}`;
  },
  getLastPortfolio:    () => request('/api/portfolio/last'),
  // Full payload of the last completed rebalance (synced via Dropbox on server).
  // Same shape as the AsyncStorage LAST_PORTFOLIO_KEY — whichever is newer wins.
  getLastPortfolioJob: () => request('/api/portfolio/last-job'),
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
  startIntelligence: (sector = 'Tech') => request('/api/intelligence', {
    method: 'POST', body: JSON.stringify({ sector }),
  }),
  getIntelligenceJob:    (jobId) => request(`/api/intelligence/${jobId}`),
  getLatestIntelligence: ()      => request('/api/intelligence/latest'),

  // ---------- Daily Brief (Goldman-style PM morning note) ----------
  startDailyBrief:     ()      => request('/api/daily-brief', { method: 'POST' }),
  getDailyBriefJob:    (jobId) => request(`/api/daily-brief/${jobId}`),
  getLatestDailyBrief: ()      => request('/api/daily-brief/latest'),

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
  // Today's total value is auto-extracted from the Account Positions CSV (sum
  // of all positions × current prices + money market).
  //
  // Optional inputs:
  //  • monthlyPerf*  — Investment Income Balance CSV (Fidelity Monthly
  //    Statement). When present, the server reads exact month-end balances
  //    for accurate chart + TWRR, AND uses its first-month "start" value as
  //    the Jan 1 begin_value if the user leaves that field blank.
  //  • beginValue    — Jan 1 portfolio total. May be null when monthlyPerf
  //    is provided; otherwise required.
  computeUnifiedYtd: async ({
    positionsUri, positionsName, positionsType,
    activityUri,  activityName,  activityType,
    monthlyPerfUri, monthlyPerfName, monthlyPerfType,
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
    if (monthlyPerfUri) {
      fd.append('monthly_perf_file', {
        uri:  monthlyPerfUri,
        name: monthlyPerfName || 'monthly_perf.csv',
        type: monthlyPerfType || 'text/csv',
      });
    }
    if (beginValue != null && beginValue !== '' && Number(beginValue) > 0) {
      fd.append('begin_value', String(beginValue));
    }
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

  // ---------- Fund Admin ----------
  // All fund data endpoints require the x-fund-token header (second auth layer).
  // Call fundAuth(password) first, then use fundList/fundOverview/etc.
  // All data endpoints accept an optional fundId parameter to select a specific
  // fund; omit it to use the server default (DGA-I / FUND_ID env var).
  fundAuth: (password) => request('/api/fund/auth', {
    method: 'POST',
    body:   JSON.stringify({ password }),
  }),

  createFund: async (payload) => {
    const ft = await getFundToken();
    return request('/api/fund/admin/create', {
      method:  'POST',
      body:    JSON.stringify(payload),
      headers: { 'x-fund-token': ft },
    });
  },

  fundList: async (fundType) => {
    const ft = await getFundToken();
    const qs = fundType ? `?fund_type=${encodeURIComponent(fundType)}` : '';
    return request(`/api/fund/list${qs}`, { headers: { 'x-fund-token': ft } });
  },
  getYtdCache: async (fundId) => {
    const ft = await getFundToken();
    return request(`/api/fund/account/${encodeURIComponent(fundId)}/ytd-cache`,
      { headers: { 'x-fund-token': ft } });
  },
  saveYtdCache: async (fundId, nav, ytdPct, resultJson) => {
    const ft = await getFundToken();
    return request(`/api/fund/account/${encodeURIComponent(fundId)}/ytd-cache`, {
      method: 'PUT',
      body: JSON.stringify({ nav, ytd_pct: ytdPct, result_json: resultJson }),
      headers: { 'x-fund-token': ft },
    });
  },
  fundOverview: async (fundId) => {
    const ft = await getFundToken();
    const qs = fundId ? `?fund_id=${encodeURIComponent(fundId)}` : '';
    return request(`/api/fund/overview${qs}`, { headers: { 'x-fund-token': ft } });
  },
  fundLps: async (fundId) => {
    const ft = await getFundToken();
    const qs = fundId ? `?fund_id=${encodeURIComponent(fundId)}` : '';
    return request(`/api/fund/lps${qs}`, { headers: { 'x-fund-token': ft } });
  },
  fundPositions: async (fundId) => {
    const ft = await getFundToken();
    const qs = fundId ? `?fund_id=${encodeURIComponent(fundId)}` : '';
    return request(`/api/fund/positions${qs}`, { headers: { 'x-fund-token': ft } });
  },
  fundActivity: async (fundId) => {
    const ft = await getFundToken();
    const qs = fundId ? `?fund_id=${encodeURIComponent(fundId)}` : '';
    return request(`/api/fund/activity${qs}`, { headers: { 'x-fund-token': ft } });
  },
  fundWaterfall: async (fundId) => {
    const ft = await getFundToken();
    const qs = fundId ? `?fund_id=${encodeURIComponent(fundId)}` : '';
    return request(`/api/fund/waterfall${qs}`, { headers: { 'x-fund-token': ft } });
  },

  // Import Fidelity CSV positions for a fund.
  // fileUri / fileName / mimeType come from expo-document-picker.
  fundImportPositions: async ({ fileUri, fileName, mimeType, fundId }) => {
    const ft   = await getFundToken();
    const base = await getBaseUrl();
    const token = await getToken();
    const form = new FormData();
    form.append('file', { uri: fileUri, name: fileName || 'positions.csv', type: mimeType || 'text/csv' });
    if (fundId) form.append('fund_id', fundId);
    const resp = await fetch(`${base}/api/fund/import-positions`, {
      method: 'POST',
      headers: { 'x-auth-token': token, 'x-fund-token': ft },
      body: form,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(txt || `HTTP ${resp.status}`);
    }
    return resp.json();
  },

  // Import cap table CSV/XLSX for a fund.
  fundImportCaptable: async ({ fileUri, fileName, mimeType, fundId }) => {
    const ft   = await getFundToken();
    const base = await getBaseUrl();
    const token = await getToken();
    const form = new FormData();
    form.append('file', { uri: fileUri, name: fileName || 'captable.csv', type: mimeType || 'text/csv' });
    if (fundId) form.append('fund_id', fundId);
    const resp = await fetch(`${base}/api/fund/import-captable`, {
      method: 'POST',
      headers: { 'x-auth-token': token, 'x-fund-token': ft },
      body: form,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(txt || `HTTP ${resp.status}`);
    }
    return resp.json();
  },

  // Server build version (public — no auth required). Used by Settings to
  // show what's currently deployed and let the user verify the OTA update.
  getBuild: async () => {
    const base = await getBaseUrl();
    const resp = await fetch(`${base}/api/build?_t=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!resp.ok) throw new Error(`${resp.status}`);
    return resp.json();
  },

  // ---------- Batch quotes (avoids Yahoo rate limits) ----------
  getBatchQuotes: async (tickers) => {
    // uses v2Fetch so it attaches the v2 token
    const qs = tickers.map(encodeURIComponent).join(',');
    const r = await v2Fetch(`/api/quotes?tickers=${qs}`);
    if (!r.ok) throw new Error(`quotes ${r.status}`);
    return r.json(); // { quotes: { TICKER: { price, pct_change, ... } } }
  },

  // ---------- Market Scan (independent ticker list) ----------
  getMarketScanTickers: async () => {
    const r = await v2Fetch('/api/scan/market-tickers');
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json(); // { tickers: [...] }
  },
  addMarketScanTicker: async (ticker) => {
    const r = await v2Fetch('/api/scan/market-tickers', {
      method: 'POST',
      body: JSON.stringify({ ticker }),
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  },
  removeMarketScanTicker: async (ticker) => {
    const r = await v2Fetch(`/api/scan/market-tickers/${encodeURIComponent(ticker)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  },
  startMarketScan: async () => {
    const r = await v2Fetch('/api/scan/market', { method: 'POST' });
    if (!r.ok) { const e = await r.json().catch(()=>{}); throw new Error(e?.detail || `${r.status}`); }
    return r.json();
  },

  // ---------- Archived reports ----------
  getArchivedReports: async () => {
    const r = await v2Fetch('/api/reports/archived');
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  },
  restoreReport: async (ticker) => {
    const r = await v2Fetch(`/api/reports/${encodeURIComponent(ticker)}/restore`, { method: 'POST' });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  },
  restoreAllReports: async () => {
    const r = await v2Fetch('/api/reports/restore-all', { method: 'POST' });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  },

  // ---------- Automation settings ----------
  getAutomationSettings: async () => {
    const r = await v2Fetch('/api/automation/settings');
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  },
  saveAutomationSettings: async (settings) => {
    const r = await v2Fetch('/api/automation/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  },
};
