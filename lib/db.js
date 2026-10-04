// SQLite storage for users, sessions, bank state, transactions, runs and push subscriptions.
// One file (data/stride.db by default; DATABASE_PATH to move it, e.g. onto a cloud disk).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DATABASE_PATH || path.join(ROOT, 'data', 'stride.db');
export const DATA_DIR = path.dirname(DB_PATH);
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT,
    phone         TEXT,
    is_guest      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS banks (
    user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    checking_balance REAL NOT NULL,
    goal_name        TEXT NOT NULL,
    goal_target      REAL NOT NULL,
    goal_saved       REAL NOT NULL,
    per_mile         REAL NOT NULL,
    skip_penalty     REAL NOT NULL,
    nessie           TEXT
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date         TEXT NOT NULL,
    type         TEXT NOT NULL,
    amount       REAL NOT NULL,
    memo         TEXT NOT NULL,
    budget       REAL,
    nessie       TEXT,
    nessie_error TEXT
  );
  CREATE INDEX IF NOT EXISTS transactions_user ON transactions(user_id, date DESC);
  CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    miles       REAL NOT NULL,
    seconds     INTEGER NOT NULL,
    earned      REAL NOT NULL,
    destination TEXT
  );
  CREATE INDEX IF NOT EXISTS runs_user ON runs(user_id, date DESC);
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    keys     TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

export const now = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

// Runs fn inside one SQLite transaction.
export const tx = (fn) => db.transaction(fn)();
