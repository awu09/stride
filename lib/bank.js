// Per-user ledger: a checking account plus one savings goal, stored in SQLite.
// The local ledger is authoritative for the UI (instant, works offline from Nessie);
// every money movement is mirrored to Capital One Nessie when NESSIE_API_KEY is set.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now, newId, tx } from './db.js';
import * as nessie from './nessie.js';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DEFAULTS = { checking: 1240.55, goalName: 'Marathon Fund', target: 400, perMile: 1, skipPenalty: 5 };

const round = (n) => Math.round(n * 100) / 100;
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

function parseAmount(value) {
  const amount = round(Number(value));
  if (!Number.isFinite(amount) || amount <= 0) fail(400, 'Amount must be a positive number');
  return amount;
}

const bankRow = (userId) => db.prepare('SELECT * FROM banks WHERE user_id = ?').get(userId) || fail(404, 'No bank for this user');
const linkOf = (row) => (row.nessie ? JSON.parse(row.nessie) : null);
const saveLink = (userId, link) => db.prepare('UPDATE banks SET nessie = ? WHERE user_id = ?').run(JSON.stringify(link), userId);

function insertTx(userId, { type, amount, memo, budget = null, date = now() }) {
  const row = { id: newId(), user_id: userId, date, type, amount: round(amount), memo, budget };
  db.prepare('INSERT INTO transactions (id, user_id, date, type, amount, memo, budget) VALUES (@id, @user_id, @date, @type, @amount, @memo, @budget)').run(row);
  return row;
}

function insertRun(userId, { miles, seconds, earned, destination, mode = 'gps', date = now() }) {
  const row = { id: newId(), user_id: userId, date, miles: round(miles), seconds: Math.round(seconds), earned: round(earned), destination: destination || null, mode: mode === 'sim' ? 'sim' : 'gps' };
  db.prepare('INSERT INTO runs (id, user_id, date, miles, seconds, earned, destination, mode) VALUES (@id, @user_id, @date, @miles, @seconds, @earned, @destination, @mode)').run(row);
  return row;
}

const txById = (id) => db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);

function toTransaction(r) {
  return {
    id: r.id,
    date: r.date,
    type: r.type,
    amount: r.amount,
    memo: r.memo,
    ...(r.budget != null && { budget: r.budget }),
    ...(r.nessie && { nessie: JSON.parse(r.nessie) }),
    ...(r.nessie_error && { nessieError: r.nessie_error }),
  };
}

// ---------- setup ----------
function seedBank(userId, { guest }) {
  db.prepare(
    `INSERT INTO banks (user_id, checking_balance, goal_name, goal_target, goal_saved, per_mile, skip_penalty)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, DEFAULTS.checking, DEFAULTS.goalName, DEFAULTS.target, guest ? 142 : 0, DEFAULTS.perMile, DEFAULTS.skipPenalty);
  if (guest) {
    // Guests (e.g. judges trying the app) start with a little history so the wallet isn't empty.
    insertTx(userId, { type: 'transfer', amount: 5, memo: 'Commitment: skipped run', date: daysAgo(3) });
    insertTx(userId, { type: 'purchase', amount: 4.75, memo: 'Coffee after run', budget: 6, date: daysAgo(1) });
    insertTx(userId, { type: 'transfer', amount: 3.1, memo: 'Run reward · 3.1 mi', date: daysAgo(1) });
    insertRun(userId, { miles: 4.2, seconds: 2310, earned: 4.2, destination: 'Grocery', date: daysAgo(4) });
    insertRun(userId, { miles: 3.1, seconds: 1650, earned: 3.1, destination: 'Coffee', date: daysAgo(1) });
  }
}

// Brings the single-user data from the hackathon version (data/bank.json) into the first real account.
function importLegacy(userId) {
  const file = path.join(DATA_DIR, 'bank.json');
  if (!fs.existsSync(file)) return false;
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  let link = null;
  try {
    link = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'nessie.json'), 'utf8'));
  } catch {
    /* no Nessie link saved */
  }
  tx(() => {
    db.prepare(
      `INSERT INTO banks (user_id, checking_balance, goal_name, goal_target, goal_saved, per_mile, skip_penalty, nessie)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, old.checking.balance, old.goal.name, old.goal.target, old.goal.saved, old.rules.perMile, old.rules.skipPenalty, link?.checking ? JSON.stringify(link) : null);
    for (const t of [...old.transactions].reverse()) insertTx(userId, { type: t.type, amount: t.amount, memo: t.memo, budget: t.budget ?? null, date: t.date });
    for (const r of [...old.runs].reverse()) insertRun(userId, r);
  });
  fs.renameSync(file, `${file}.imported`);
  console.log('[bank] imported hackathon data into the first account');
  return true;
}

export async function createBank(userId, { guest }) {
  const firstRealAccount = !guest && !db.prepare('SELECT 1 FROM users WHERE is_guest = 0 AND id != ?').get(userId);
  if (!(firstRealAccount && importLegacy(userId))) tx(() => seedBank(userId, { guest }));
  // Open Nessie accounts in the background so signup stays fast.
  ensureNessie(userId).catch((err) => console.warn('[nessie] setup failed:', err.message));
}

// ---------- Nessie link ----------
const opening = new Map(); // userId → promise, so concurrent calls open accounts once

// Returns { link, fresh }. `fresh` means the accounts were just seeded with the current
// balances, which already include whatever movement triggered this call.
async function ensureNessie(userId) {
  if (!nessie.enabled()) return { link: null };
  const row = bankRow(userId);
  const link = linkOf(row);
  if (link?.checking) return { link, fresh: false };
  if (!opening.has(userId)) {
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    const p = nessie
      .openAccounts(link, { name: user?.name, checking: row.checking_balance, savings: row.goal_saved, goalName: row.goal_name })
      .then((next) => {
        saveLink(userId, next);
        return next;
      })
      .finally(() => opening.delete(userId));
    opening.set(userId, p);
  }
  return { link: await opening.get(userId), fresh: true };
}

// Record the movement in Nessie; a Nessie outage never blocks the runner, the row is just flagged.
async function mirror(userId, txRow, fn) {
  try {
    const { link, fresh } = await ensureNessie(userId);
    if (!link) return;
    const result = fresh ? { seeded: true } : await fn(link);
    db.prepare('UPDATE transactions SET nessie = ?, nessie_error = NULL WHERE id = ?').run(JSON.stringify(result), txRow.id);
  } catch (err) {
    console.warn('[nessie]', err.message);
    db.prepare('UPDATE transactions SET nessie_error = ? WHERE id = ?').run(err.message.slice(0, 300), txRow.id);
  }
}

// ---------- reads ----------
export function getState(userId) {
  const b = bankRow(userId);
  return {
    checking: { name: 'Everyday Checking', balance: b.checking_balance },
    goal: { name: b.goal_name, target: b.goal_target, saved: b.goal_saved },
    rules: { perMile: b.per_mile, skipPenalty: b.skip_penalty },
    transactions: db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC LIMIT 100').all(userId).map(toTransaction),
    runs: db.prepare('SELECT id, date, miles, seconds, earned, destination, mode FROM runs WHERE user_id = ? ORDER BY date DESC LIMIT 200').all(userId),
    nessie: nessie.info(linkOf(b)),
  };
}

// ---------- money movements ----------
function moveToGoal(userId, amount, memo) {
  return tx(() => {
    const b = bankRow(userId);
    if (amount > b.checking_balance) fail(400, 'Insufficient funds in checking');
    db.prepare('UPDATE banks SET checking_balance = round(checking_balance - ?, 2), goal_saved = round(goal_saved + ?, 2) WHERE user_id = ?').run(amount, amount, userId);
    const goalReached = b.goal_saved < b.goal_target && b.goal_saved + amount >= b.goal_target;
    return { row: insertTx(userId, { type: 'transfer', amount, memo }), goalReached };
  });
}

export async function transferToSavings(userId, { amount, memo } = {}) {
  const value = parseAmount(amount);
  const { row, goalReached } = moveToGoal(userId, value, memo || 'Transfer to savings');
  await mirror(userId, row, (link) => nessie.moveToSavings(link, value, row.memo));
  return { transaction: toTransaction(txById(row.id)), goalReached, state: getState(userId) };
}

export async function skipPenalty(userId) {
  const { skip_penalty: penalty } = bankRow(userId);
  const { row, goalReached } = moveToGoal(userId, penalty, 'Commitment: skipped run');
  await mirror(userId, row, (link) => nessie.moveToSavings(link, penalty, row.memo));
  return { transaction: toTransaction(txById(row.id)), goalReached, state: getState(userId) };
}

export async function purchase(userId, { merchant, amount, budget } = {}) {
  const value = parseAmount(amount);
  const hasBudget = budget !== undefined && budget !== null && budget !== '';
  const budgetValue = hasBudget ? round(Number(budget)) : null;
  const row = tx(() => {
    const b = bankRow(userId);
    if (value > b.checking_balance) fail(400, 'Insufficient funds in checking');
    db.prepare('UPDATE banks SET checking_balance = round(checking_balance - ?, 2) WHERE user_id = ?').run(value, userId);
    return insertTx(userId, { type: 'purchase', amount: value, memo: String(merchant || 'Purchase').slice(0, 80), budget: budgetValue });
  });
  await mirror(userId, row, async (link) => {
    const result = await nessie.purchase(link, value, row.memo, 'Post-run purchase');
    if (!link.merchants?.[row.memo]) saveLink(userId, { ...link, merchants: { ...link.merchants, [row.memo]: result.merchantId } });
    return { purchaseId: result.purchaseId };
  });
  const verdict = hasBudget ? { budget: budgetValue, difference: round(budgetValue - value), withinBudget: value <= budgetValue } : null;
  return { transaction: toTransaction(txById(row.id)), verdict, state: getState(userId) };
}

// Pledge payout: from the backer's checking into the runner's savings goal.
// Returns { paid, transaction } or { paid: 0, reason } when the backer can't cover it.
export async function payPledge(fromUserId, toUserId, amount, { challengeTitle, backerName, runnerName }) {
  const value = round(amount);
  if (!(value > 0)) return { paid: 0, reason: 'nothing owed' };
  const result = tx(() => {
    const from = bankRow(fromUserId);
    if (value > from.checking_balance) return null;
    const to = bankRow(toUserId);
    db.prepare('UPDATE banks SET checking_balance = round(checking_balance - ?, 2) WHERE user_id = ?').run(value, fromUserId);
    db.prepare('UPDATE banks SET goal_saved = round(goal_saved + ?, 2) WHERE user_id = ?').run(value, toUserId);
    return {
      out: insertTx(fromUserId, { type: 'pledge_out', amount: value, memo: `Pledge to ${runnerName} · ${challengeTitle}` }),
      in: insertTx(toUserId, { type: 'pledge_in', amount: value, memo: `${backerName} backed ${challengeTitle}` }),
      goalReached: to.goal_saved < to.goal_target && to.goal_saved + value >= to.goal_target,
    };
  });
  if (!result) return { paid: 0, reason: 'insufficient funds' };
  await Promise.all([
    mirror(fromUserId, result.out, (link) => nessie.withdraw(link, value, result.out.memo)),
    mirror(toUserId, result.in, (link) => nessie.deposit(link, value, result.in.memo)),
  ]);
  return { paid: value, goalReached: result.goalReached };
}

export function checkingBalance(userId) {
  return bankRow(userId).checking_balance;
}

// ---------- settings, runs, verification ----------
export function updateGoal(userId, { name, target, perMile, skipPenalty: penalty } = {}) {
  const b = bankRow(userId);
  db.prepare('UPDATE banks SET goal_name = ?, goal_target = ?, per_mile = ?, skip_penalty = ? WHERE user_id = ?').run(
    name !== undefined ? String(name).trim().slice(0, 40) || b.goal_name : b.goal_name,
    target !== undefined ? parseAmount(target) : b.goal_target,
    perMile !== undefined ? parseAmount(perMile) : b.per_mile,
    penalty !== undefined ? parseAmount(penalty) : b.skip_penalty,
    userId,
  );
  return { state: getState(userId) };
}

export function recordRun(userId, { miles, seconds, earned, destination, mode } = {}) {
  const run = insertRun(userId, {
    miles: Number(miles) || 0,
    seconds: Number(seconds) || 0,
    earned: Number(earned) || 0,
    destination: destination ? String(destination).slice(0, 80) : null,
    mode,
  });
  const { user_id: _u, ...publicRun } = run;
  return { run: publicRun, state: getState(userId) };
}

export async function verifyNessie(userId) {
  const link = linkOf(bankRow(userId));
  if (!link?.checking) fail(400, 'Nessie is not connected');
  const remote = await nessie.verify(link);
  const b = bankRow(userId);
  const matches = Math.abs(remote.checking - b.checking_balance) < 0.005 && Math.abs(remote.savings - b.goal_saved) < 0.005;
  return { remote, local: { checking: b.checking_balance, savings: b.goal_saved }, matches };
}

// Back to a fresh start (keeps the account and goal settings' defaults), with new Nessie accounts.
export async function reset(userId) {
  const user = db.prepare('SELECT is_guest FROM users WHERE id = ?').get(userId);
  const link = linkOf(bankRow(userId));
  tx(() => {
    db.prepare('DELETE FROM transactions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM runs WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM banks WHERE user_id = ?').run(userId);
    seedBank(userId, { guest: Boolean(user?.is_guest) });
  });
  if (nessie.enabled()) {
    // Same Nessie customer, fresh account pair (the old pair is closed) seeded with the new balances.
    try {
      const b = bankRow(userId);
      const name = db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name;
      saveLink(userId, await nessie.openAccounts(link, { name, checking: b.checking_balance, savings: b.goal_saved, goalName: b.goal_name }));
    } catch (err) {
      console.warn('[nessie] reset failed:', err.message);
    }
  }
  return { state: getState(userId) };
}
