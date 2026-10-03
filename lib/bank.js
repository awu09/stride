// Mock bank ledger: a checking account plus one savings goal, persisted to data/bank.json.
// Swap these functions for real banking API calls without touching the rest of the app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nessie from './nessie.js';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = path.join(DATA_DIR, 'bank.json');

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

function seed() {
  return {
    checking: { name: 'Everyday Checking', balance: 1240.55 },
    goal: { name: 'Marathon Fund', target: 400, saved: 142 },
    rules: { perMile: 1, skipPenalty: 5 },
    transactions: [
      { id: 't3', date: daysAgo(1), type: 'transfer', amount: 3.1, memo: 'Run reward · 3.1 mi' },
      { id: 't2', date: daysAgo(1), type: 'purchase', amount: 4.75, memo: 'Coffee after run', budget: 6 },
      { id: 't1', date: daysAgo(3), type: 'transfer', amount: 5, memo: 'Commitment: skipped run' },
    ],
    runs: [
      { id: 'r2', date: daysAgo(1), miles: 3.1, seconds: 1650, earned: 3.1, destination: 'Coffee' },
      { id: 'r1', date: daysAgo(4), miles: 4.2, seconds: 2310, earned: 4.2, destination: 'Grocery' },
    ],
  };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return seed();
  }
}

let state = load();

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

const round = (n) => Math.round(n * 100) / 100;
const id = () => Math.random().toString(36).slice(2, 10);

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

function addTransaction(fields) {
  const tx = { id: id(), date: new Date().toISOString(), ...fields };
  state.transactions.unshift(tx);
  state.transactions = state.transactions.slice(0, 100);
  return tx;
}

function moveToGoal(amount, memo) {
  if (amount > state.checking.balance) fail(400, 'Insufficient funds in checking');
  state.checking.balance = round(state.checking.balance - amount);
  state.goal.saved = round(state.goal.saved + amount);
  return addTransaction({ type: 'transfer', amount, memo });
}

// Record the movement in Capital One Nessie too. The local ledger stays authoritative
// for the UI, so a Nessie outage never blocks a run; the transaction is just flagged.
async function mirror(tx, fn) {
  if (!state.nessie) return;
  try {
    tx.nessie = await fn();
  } catch (err) {
    tx.nessieError = err.message;
    console.warn('[nessie]', err.message);
  }
}

export function getState() {
  return state;
}

// Link to Nessie at startup, opening accounts seeded with the current balances if needed.
export async function connectNessie() {
  if (!nessie.enabled()) {
    state.nessie = null;
    return null;
  }
  state.nessie = await nessie.connect({ checking: state.checking.balance, savings: state.goal.saved, goalName: state.goal.name });
  save();
  return state.nessie;
}

export async function verifyNessie() {
  if (!state.nessie) fail(400, 'Nessie is not connected');
  const remote = await nessie.verify();
  const matches = Math.abs(remote.checking - state.checking.balance) < 0.005 && Math.abs(remote.savings - state.goal.saved) < 0.005;
  return { remote, local: { checking: state.checking.balance, savings: state.goal.saved }, matches };
}

export async function transferToSavings({ amount, memo } = {}) {
  const value = parseAmount(amount);
  const transaction = moveToGoal(value, memo || `Transfer to ${state.goal.name}`);
  await mirror(transaction, () => nessie.moveToSavings(value, transaction.memo));
  save();
  return { transaction, state };
}

export async function purchase({ merchant, amount, budget } = {}) {
  const value = parseAmount(amount);
  if (value > state.checking.balance) fail(400, 'Insufficient funds in checking');
  state.checking.balance = round(state.checking.balance - value);
  const hasBudget = budget !== undefined && budget !== null && budget !== '';
  const transaction = addTransaction({
    type: 'purchase',
    amount: value,
    memo: merchant || 'Purchase',
    ...(hasBudget && { budget: round(Number(budget)) }),
  });
  await mirror(transaction, () => nessie.purchase(value, transaction.memo, 'Post-run purchase'));
  save();
  const verdict = hasBudget
    ? { budget: round(Number(budget)), difference: round(Number(budget) - value), withinBudget: value <= Number(budget) }
    : null;
  return { transaction, verdict, state };
}

export async function skipPenalty() {
  const transaction = moveToGoal(state.rules.skipPenalty, 'Commitment: skipped run');
  await mirror(transaction, () => nessie.moveToSavings(state.rules.skipPenalty, transaction.memo));
  save();
  return { transaction, state };
}

export function updateGoal({ name, target, perMile, skipPenalty } = {}) {
  if (name !== undefined) state.goal.name = String(name).slice(0, 40) || state.goal.name;
  if (target !== undefined) state.goal.target = parseAmount(target);
  if (perMile !== undefined) state.rules.perMile = parseAmount(perMile);
  if (skipPenalty !== undefined) state.rules.skipPenalty = parseAmount(skipPenalty);
  save();
  return { state };
}

export function recordRun({ miles, seconds, earned, destination } = {}) {
  const run = {
    id: id(),
    date: new Date().toISOString(),
    miles: round(Number(miles) || 0),
    seconds: Math.round(Number(seconds) || 0),
    earned: round(Number(earned) || 0),
    destination: destination || null,
  };
  state.runs.unshift(run);
  state.runs = state.runs.slice(0, 200);
  save();
  return { run, state };
}

export async function reset() {
  state = seed();
  // Fresh Nessie accounts so verify() starts from matching balances.
  if (nessie.enabled()) {
    try {
      state.nessie = await nessie.openAccounts({ checking: state.checking.balance, savings: state.goal.saved, goalName: state.goal.name });
    } catch (err) {
      console.warn('[nessie] reset failed:', err.message);
      state.nessie = null;
    }
  }
  save();
  return { state };
}
