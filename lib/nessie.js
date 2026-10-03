// Capital One Nessie mirror. Every money movement in Stride is also recorded in Nessie:
//   move to savings → withdrawal from Checking + deposit into Savings
//   purchase        → merchant purchase from Checking
// Nessie stores whole numbers and doesn't update balances itself, so amounts are sent in
// cents and balances are rebuilt from Nessie's transaction history in verify().
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.NESSIE_URL || 'https://api.nessieisreal.com';
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'nessie.json');
const key = () => process.env.NESSIE_API_KEY?.trim();

export const enabled = () => Boolean(key());

let ids = (() => {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
})();

function saveIds() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(ids, null, 2));
}

const cents = (dollars) => Math.round(Number(dollars) * 100);
const today = () => new Date().toISOString().slice(0, 10);

async function call(method, route, body) {
  const res = await fetch(`${BASE}${route}?key=${key()}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`Nessie ${method} ${route.split('/')[1]} failed (${res.status}): ${String(data?.message ?? data).slice(0, 160)}`);
  return data;
}

// Nessie answers 404 for an empty transaction list.
async function list(route) {
  try {
    const data = await call('GET', route);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (/\(404\)/.test(err.message)) return [];
    throw err;
  }
}

async function findOrCreateCustomer() {
  const customers = await call('GET', '/customers');
  const existing = customers.find((c) => c.first_name === 'Stride' && c.last_name === 'Runner');
  if (existing) return existing._id;
  const created = await call('POST', '/customers', {
    first_name: 'Stride',
    last_name: 'Runner',
    address: { street_number: '139', street_name: 'Tremont St', city: 'Boston', state: 'MA', zip: '02111' },
  });
  return created.objectCreated._id;
}

// Opens a fresh Checking + Savings pair seeded with the given balances (dollars).
export async function openAccounts({ checking, savings, goalName }) {
  ids.customerId = ids.customerId || (await findOrCreateCustomer());
  // Close the previous pair (best effort) so the customer doesn't pile up stale accounts.
  await Promise.allSettled([ids.checking, ids.savings].filter(Boolean).map((a) => call('DELETE', `/accounts/${a.id}`)));
  const open = (type, nickname, balance) =>
    call('POST', `/customers/${ids.customerId}/accounts`, { type, nickname, rewards: 0, balance: cents(balance) });
  const [chk, sav] = await Promise.all([open('Checking', 'Everyday Checking', checking), open('Savings', goalName, savings)]);
  ids.checking = { id: chk.objectCreated._id, number: chk.objectCreated.account_number };
  ids.savings = { id: sav.objectCreated._id, number: sav.objectCreated.account_number };
  ids.merchants = ids.merchants || {};
  saveIds();
  return info();
}

// Makes sure the saved accounts still exist; opens new ones otherwise.
export async function connect(seed) {
  if (!enabled()) return null;
  if (ids.checking?.id && ids.savings?.id) {
    try {
      await Promise.all([call('GET', `/accounts/${ids.checking.id}`), call('GET', `/accounts/${ids.savings.id}`)]);
      return info();
    } catch {
      /* accounts gone; reopen below */
    }
  }
  return openAccounts(seed);
}

export function info() {
  if (!ids.checking) return null;
  return {
    customerId: ids.customerId,
    checking: { id: ids.checking.id, last4: ids.checking.number.slice(-4) },
    savings: { id: ids.savings.id, last4: ids.savings.number.slice(-4) },
  };
}

export async function moveToSavings(amount, description) {
  const c = cents(amount);
  const [w, d] = await Promise.all([
    call('POST', `/accounts/${ids.checking.id}/withdrawals`, { medium: 'balance', transaction_date: today(), status: 'completed', amount: c, description }),
    call('POST', `/accounts/${ids.savings.id}/deposits`, { medium: 'balance', transaction_date: today(), status: 'completed', amount: c, description }),
  ]);
  return { withdrawalId: w.objectCreated._id, depositId: d.objectCreated._id };
}

async function merchantId(name) {
  ids.merchants = ids.merchants || {};
  if (ids.merchants[name]) return ids.merchants[name];
  const m = await call('POST', '/merchants', { name: name.slice(0, 60), category: 'food' });
  ids.merchants[name] = m.objectCreated._id;
  saveIds();
  return ids.merchants[name];
}

export async function purchase(amount, merchantName, description) {
  const p = await call('POST', `/accounts/${ids.checking.id}/purchases`, {
    merchant_id: await merchantId(merchantName),
    medium: 'balance',
    purchase_date: today(),
    status: 'completed',
    amount: cents(amount),
    description,
  });
  return { purchaseId: p.objectCreated._id };
}

// Rebuild balances from Nessie: opening balance + deposits − withdrawals − purchases.
export async function verify() {
  const [chk, sav, chkW, chkD, chkP, savW, savD, savP] = await Promise.all([
    call('GET', `/accounts/${ids.checking.id}`),
    call('GET', `/accounts/${ids.savings.id}`),
    list(`/accounts/${ids.checking.id}/withdrawals`),
    list(`/accounts/${ids.checking.id}/deposits`),
    list(`/accounts/${ids.checking.id}/purchases`),
    list(`/accounts/${ids.savings.id}/withdrawals`),
    list(`/accounts/${ids.savings.id}/deposits`),
    list(`/accounts/${ids.savings.id}/purchases`),
  ]);
  const sum = (xs) => xs.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  return {
    checking: (chk.balance + sum(chkD) - sum(chkW) - sum(chkP)) / 100,
    savings: (sav.balance + sum(savD) - sum(savW) - sum(savP)) / 100,
    transactions: chkW.length + chkD.length + chkP.length + savW.length + savD.length + savP.length,
  };
}
