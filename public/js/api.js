async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('stride:signed-out'));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const post = (path, body = {}) => request(path, { method: 'POST', body });

export const api = {
  config: () => request('/api/config'),
  me: () => request('/api/me'),
  updateMe: (fields) => post('/api/me', fields),
  signup: (fields) => post('/api/auth/signup', fields),
  login: (fields) => post('/api/auth/login', fields),
  guest: () => post('/api/auth/guest'),
  logout: () => post('/api/auth/logout'),
  pushSubscribe: (subscription) => post('/api/push/subscribe', subscription),
  pushUnsubscribe: (endpoint) => post('/api/push/unsubscribe', { endpoint }),
  pushTest: () => post('/api/push/test'),
  bank: () => request('/api/bank'),
  transfer: (amount, memo) => post('/api/bank/transfer', { amount, memo }),
  purchase: (merchant, amount, budget) => post('/api/bank/purchase', { merchant, amount, budget }),
  penalty: () => post('/api/bank/penalty'),
  updateGoal: (fields) => post('/api/bank/goal', fields),
  recordRun: (run) => post('/api/bank/runs', run),
  reset: () => post('/api/bank/reset'),
  verify: () => request('/api/bank/verify'),
  routes: (params) => post('/api/routes', params),
  challenges: () => request('/api/challenges'),
  challenge: (code) => request(`/api/challenges/${encodeURIComponent(code)}`),
  publicChallenge: (code) => request(`/api/public/challenges/${encodeURIComponent(code)}`),
  createChallenge: (fields) => post('/api/challenges', fields),
  cancelChallenge: (code) => request(`/api/challenges/${encodeURIComponent(code)}`, { method: 'DELETE' }),
  pledge: (code, fields) => post(`/api/challenges/${encodeURIComponent(code)}/pledge`, fields),
  unpledge: (code) => request(`/api/challenges/${encodeURIComponent(code)}/pledge`, { method: 'DELETE' }),
};
