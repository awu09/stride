// Web Push notifications (works on iPhone for home-screen web apps, iOS 16.4+).
// VAPID keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or are generated once into data/vapid.json.
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { db, now, DATA_DIR } from './db.js';

// Kept beside the database so the keys (and every phone's subscription) survive redeploys.
const FILE = path.join(DATA_DIR, 'vapid.json');

function loadKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    const keys = webpush.generateVAPIDKeys();
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(keys), { mode: 0o600 });
    return keys;
  }
}

const keys = loadKeys();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:stride@example.com', keys.publicKey, keys.privateKey);

export const publicKey = keys.publicKey;

export function subscribe(userId, subscription) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    const err = new Error('Invalid push subscription');
    err.status = 400;
    throw err;
  }
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, keys, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys`,
  ).run(subscription.endpoint, userId, JSON.stringify(subscription.keys), now());
  return { ok: true };
}

export function unsubscribe(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
  return { ok: true };
}

export function hasSubscription(userId) {
  return Boolean(db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ?').get(userId));
}

// Fire-and-forget: notify every device the user turned notifications on for.
export function notify(userId, { title, body, url = '/' }) {
  const subs = db.prepare('SELECT endpoint, keys FROM push_subscriptions WHERE user_id = ?').all(userId);
  for (const s of subs) {
    webpush
      .sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify({ title, body, url }), { TTL: 3600 })
      .catch((err) => {
        // 404/410: the device unsubscribed or the app was removed.
        if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
        else console.warn('[push]', err.statusCode || '', err.body || err.message);
      });
  }
}
