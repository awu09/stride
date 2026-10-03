async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const post = (path, body = {}) => request(path, { method: 'POST', body });

export const api = {
  config: () => request('/api/config'),
  bank: () => request('/api/bank'),
  transfer: (amount, memo) => post('/api/bank/transfer', { amount, memo }),
  purchase: (merchant, amount, budget) => post('/api/bank/purchase', { merchant, amount, budget }),
  penalty: () => post('/api/bank/penalty'),
  updateGoal: (fields) => post('/api/bank/goal', fields),
  recordRun: (run) => post('/api/bank/runs', run),
  reset: () => post('/api/bank/reset'),
  verify: () => request('/api/bank/verify'),
  routes: (params) => post('/api/routes', params),
};
