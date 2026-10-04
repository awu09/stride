// Capital One Nessie mirror. Every money movement in Stride is also recorded in Nessie:
//   move to savings → withdrawal from Checking + deposit into Savings
//   purchase        → merchant purchase from Checking
// Nessie stores whole numbers and doesn't update balances itself, so amounts are sent in
// cents and balances are rebuilt from Nessie's transaction history in verify().
// Each Stride user has their own Nessie customer and accounts; their ids are passed in as `link`.

const BASE = process.env.NESSIE_URL || 'https://api.nessieisreal.com';
const key = () => process.env.NESSIE_API_KEY?.trim();

export const enabled = () => Boolean(key());

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

// Opens a Checking + Savings pair for a user, seeded with their current balances (dollars).
// Reuses the user's Nessie customer if they already have one; closes any previous pair.
export async function openAccounts(link, { name, checking, savings, goalName }) {
  const next = { ...(link || {}), merchants: link?.merchants || {} };
  if (!next.customerId) {
    const [first, ...rest] = String(name || 'Stride').split(/\s+/);
    const created = await call('POST', '/customers', {
      first_name: first.slice(0, 30) || 'Stride',
      last_name: rest.join(' ').slice(0, 30) || 'Runner',
      address: { street_number: '139', street_name: 'Tremont St', city: 'Boston', state: 'MA', zip: '02111' },
    });
    next.customerId = created.objectCreated._id;
  }
  await Promise.allSettled([link?.checking, link?.savings].filter(Boolean).map((a) => call('DELETE', `/accounts/${a.id}`)));
  const open = (type, nickname, balance) =>
    call('POST', `/customers/${next.customerId}/accounts`, { type, nickname: nickname.slice(0, 40), rewards: 0, balance: cents(balance) });
  const [chk, sav] = await Promise.all([open('Checking', 'Everyday Checking', checking), open('Savings', goalName, savings)]);
  next.checking = { id: chk.objectCreated._id, number: chk.objectCreated.account_number };
  next.savings = { id: sav.objectCreated._id, number: sav.objectCreated.account_number };
  return next;
}

// True when the saved accounts still exist in Nessie.
export async function stillThere(link) {
  if (!link?.checking?.id || !link?.savings?.id) return false;
  try {
    await Promise.all([call('GET', `/accounts/${link.checking.id}`), call('GET', `/accounts/${link.savings.id}`)]);
    return true;
  } catch {
    return false;
  }
}

export function info(link) {
  if (!link?.checking) return null;
  return {
    customerId: link.customerId,
    checking: { id: link.checking.id, last4: link.checking.number.slice(-4) },
    savings: { id: link.savings.id, last4: link.savings.number.slice(-4) },
  };
}

export async function moveToSavings(link, amount, description) {
  const c = cents(amount);
  const [w, d] = await Promise.all([
    call('POST', `/accounts/${link.checking.id}/withdrawals`, { medium: 'balance', transaction_date: today(), status: 'completed', amount: c, description }),
    call('POST', `/accounts/${link.savings.id}/deposits`, { medium: 'balance', transaction_date: today(), status: 'completed', amount: c, description }),
  ]);
  return { withdrawalId: w.objectCreated._id, depositId: d.objectCreated._id };
}

// One side of a transfer between two Stride users (a pledge): money leaves one person's
// checking and lands in another person's savings.
export async function withdraw(link, amount, description) {
  const w = await call('POST', `/accounts/${link.checking.id}/withdrawals`, { medium: 'balance', transaction_date: today(), status: 'completed', amount: cents(amount), description });
  return { withdrawalId: w.objectCreated._id };
}

export async function deposit(link, amount, description) {
  const d = await call('POST', `/accounts/${link.savings.id}/deposits`, { medium: 'balance', transaction_date: today(), status: 'completed', amount: cents(amount), description });
  return { depositId: d.objectCreated._id };
}

// Returns the purchase ids plus the merchant id (callers cache it in link.merchants).
export async function purchase(link, amount, merchantName, description) {
  let merchantId = link.merchants?.[merchantName];
  if (!merchantId) {
    const m = await call('POST', '/merchants', { name: merchantName.slice(0, 60), category: 'food' });
    merchantId = m.objectCreated._id;
  }
  const p = await call('POST', `/accounts/${link.checking.id}/purchases`, {
    merchant_id: merchantId,
    medium: 'balance',
    purchase_date: today(),
    status: 'completed',
    amount: cents(amount),
    description,
  });
  return { purchaseId: p.objectCreated._id, merchantId };
}

// Rebuild balances from Nessie: opening balance + deposits − withdrawals − purchases.
export async function verify(link) {
  const [chk, sav, chkW, chkD, chkP, savW, savD, savP] = await Promise.all([
    call('GET', `/accounts/${link.checking.id}`),
    call('GET', `/accounts/${link.savings.id}`),
    list(`/accounts/${link.checking.id}/withdrawals`),
    list(`/accounts/${link.checking.id}/deposits`),
    list(`/accounts/${link.checking.id}/purchases`),
    list(`/accounts/${link.savings.id}/withdrawals`),
    list(`/accounts/${link.savings.id}/deposits`),
    list(`/accounts/${link.savings.id}/purchases`),
  ]);
  const sum = (xs) => xs.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  return {
    checking: (chk.balance + sum(chkD) - sum(chkW) - sum(chkP)) / 100,
    savings: (sav.balance + sum(savD) - sum(savW) - sum(savP)) / 100,
    transactions: chkW.length + chkD.length + chkP.length + savW.length + savD.length + savP.length,
  };
}
