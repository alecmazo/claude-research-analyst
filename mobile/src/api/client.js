import AsyncStorage from '@react-native-async-storage/async-storage';

const DEFAULT_BASE_URL = 'http://localhost:8000';
const BASE_URL_KEY = '@dga_api_base_url';
const GAMMA_KEY = '@dga_gamma_enabled';

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

async function request(path, options = {}) {
  const base = await getBaseUrl();
  const url = `${base}${path}`;
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status}: ${text}`);
  }
  return resp.json();
}

export const api = {
  health: () => request('/health'),

  startAnalysis: (ticker, generateGamma = false) =>
    request('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({ ticker, generate_gamma: generateGamma }),
    }),

  getJobStatus: (jobId) => request(`/api/jobs/${jobId}`),

  listJobs: () => request('/api/jobs'),

  getReport: (ticker) => request(`/api/report/${ticker}`),

  listReports: () => request('/api/reports'),

  getQuote: (ticker) => request(`/api/quote/${ticker}`),

  downloadUrl: async (ticker, type) => {
    const base = await getBaseUrl();
    return `${base}/api/download/${ticker}/${type}`;
  },

  // ---------- Portfolio ----------
  listStrategies: () => request('/api/strategies'),

  startPortfolio: async ({ fileUri, fileName, mimeType, strategy, reuseExisting, generateGamma }) => {
    const base = await getBaseUrl();
    const fd = new FormData();
    fd.append('file', {
      uri: fileUri,
      name: fileName || 'portfolio.xlsx',
      type: mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    fd.append('strategy', strategy || 'pro');
    fd.append('reuse_existing', reuseExisting ? 'true' : 'false');
    fd.append('generate_gamma', generateGamma ? 'true' : 'false');
    const resp = await fetch(`${base}/api/portfolio`, { method: 'POST', body: fd });
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
};
