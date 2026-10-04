// Email/password accounts, guest accounts, and cookie sessions.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, now, newId } from './db.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'stride_session';
const SESSION_DAYS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function checkPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((part) => {
      const i = part.indexOf('=');
      return i < 0 ? [part.trim(), ''] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
    }),
  );
}

const isSecure = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

function setSessionCookie(req, res, token, maxAgeSeconds) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

export function publicUser(u) {
  return u && { id: u.id, email: u.email, name: u.name, phone: u.phone, isGuest: Boolean(u.is_guest) };
}

// The signed-in user for an HTTP request or WebSocket upgrade, or null.
export function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db
    .prepare('SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
    .get(sha256(token));
  if (!row || row.expires_at < now()) return null;
  return row;
}

export function requireUser(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Please sign in' });
  req.user = user;
  next();
}

// Basic brute-force protection: 10 failed logins per email+IP per 15 minutes.
const attempts = new Map();
function throttle(key) {
  const entry = attempts.get(key);
  if (entry && entry.until > Date.now() && entry.count >= 10) fail(429, 'Too many attempts. Try again in a few minutes.');
}
function recordFailure(key) {
  const entry = attempts.get(key);
  if (!entry || entry.until < Date.now()) attempts.set(key, { count: 1, until: Date.now() + 15 * 60000 });
  else entry.count++;
}

function validate({ email, password, name }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) fail(400, 'Enter a valid email address');
  if (String(password || '').length < 8) fail(400, 'Password must be at least 8 characters');
  const cleanName = String(name || '').trim().slice(0, 40) || cleanEmail.split('@')[0];
  return { email: cleanEmail, password: String(password), name: cleanName };
}

// Creates an account, or upgrades the current guest so their runs and savings are kept.
export async function signup(req, res, { onCreate }) {
  const fields = validate(req.body || {});
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(fields.email)) fail(409, 'An account with that email already exists');
  const passwordHash = await hashPassword(fields.password);
  const current = userFromRequest(req);
  let userId;
  if (current?.is_guest) {
    userId = current.id;
    db.prepare('UPDATE users SET email = ?, name = ?, password_hash = ?, is_guest = 0 WHERE id = ?').run(fields.email, fields.name, passwordHash, userId);
  } else {
    userId = newId();
    db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, fields.email, fields.name, passwordHash, now());
    await onCreate(userId, { guest: false });
  }
  startSession(req, res, userId);
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

export async function login(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const key = `${email}|${req.ip}`;
  throttle(key);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !(await checkPassword(String(req.body?.password || ''), user.password_hash))) {
    recordFailure(key);
    fail(401, 'Wrong email or password');
  }
  attempts.delete(key);
  startSession(req, res, user.id);
  return publicUser(user);
}

export async function guest(req, res, { onCreate }) {
  const userId = newId();
  db.prepare('INSERT INTO users (id, name, is_guest, created_at) VALUES (?, ?, 1, ?)').run(userId, 'Guest runner', now());
  await onCreate(userId, { guest: true });
  startSession(req, res, userId);
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

export function logout(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setSessionCookie(req, res, '', 0);
  return { ok: true };
}

export function updateProfile(userId, { name, phone } = {}) {
  if (name !== undefined) {
    const clean = String(name).trim().slice(0, 40);
    if (clean) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(clean, userId);
  }
  if (phone !== undefined) {
    const clean = String(phone).replace(/[^\d+]/g, '');
    if (clean && clean.replace(/\D/g, '').length < 10) fail(400, 'Enter a full phone number, e.g. +15551234567');
    db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(clean || null, userId);
  }
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

// Housekeeping: drop expired sessions and stale guest accounts (no activity for 30 days).
export function cleanup() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  db.prepare(
    `DELETE FROM users WHERE is_guest = 1 AND created_at < ? AND id NOT IN (SELECT user_id FROM sessions)`,
  ).run(new Date(Date.now() - 30 * 86400000).toISOString());
}
