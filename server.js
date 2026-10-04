import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import * as bank from './lib/bank.js';
import { planRoutes } from './lib/planner.js';
import * as imessage from './lib/imessage.js';
import * as auth from './lib/auth.js';
import * as push from './lib/push.js';
import { db } from './lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const XAI_API_KEY = process.env.XAI_API_KEY?.trim();
const XAI_VOICE_MODEL = process.env.XAI_VOICE_MODEL || 'grok-voice-latest';
const XAI_VOICE = process.env.XAI_VOICE || 'eve';
const DEBUG = process.env.DEBUG === '1';

const app = express();
app.set('trust proxy', 1); // behind a hosting proxy or tunnel: real client IP + https detection
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Wraps a handler so thrown errors become JSON responses.
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    console.error(`[api] ${req.method} ${req.path}:`, err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
};

// Ask xAI whether the key can actually be used (it can be valid but out of credits).
// Cached for a minute so adding credits takes effect on the next page load.
let keyStatus = { checkedAt: 0, ok: false, message: 'XAI_API_KEY is not set' };
async function checkXaiKey() {
  if (!XAI_API_KEY) return keyStatus;
  if (Date.now() - keyStatus.checkedAt < 60000) return keyStatus;
  try {
    const res = await fetch('https://api.x.ai/v1/api-key', {
      headers: { Authorization: `Bearer ${XAI_API_KEY}` },
      signal: AbortSignal.timeout(6000),
    });
    const info = await res.json();
    if (!res.ok) keyStatus = { ok: false, message: info.error || `HTTP ${res.status}` };
    else if (info.team_blocked) keyStatus = { ok: false, message: 'xAI team is out of credits or over its spending limit' };
    else if (info.api_key_blocked || info.api_key_disabled) keyStatus = { ok: false, message: 'xAI API key is blocked or disabled' };
    else keyStatus = { ok: true, message: 'ok' };
  } catch (err) {
    // Network hiccup: assume the key works and let the voice connection report real errors.
    keyStatus = { ok: true, message: `Could not verify key: ${err.message}` };
  }
  keyStatus.checkedAt = Date.now();
  return keyStatus;
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/config', handle(async () => {
  const status = await checkXaiKey();
  return {
    grokVoice: Boolean(XAI_API_KEY) && status.ok,
    voice: XAI_VOICE,
    voiceStatus: status.message,
    imessage: imessage.enabled,
    pushKey: push.publicKey,
  };
}));

// ---- Accounts ----
const onCreate = async (userId, { guest }) => {
  await bank.createBank(userId, { guest });
  // Carry over the hackathon setup: the first real account gets the IMESSAGE_TO number.
  if (!guest && process.env.IMESSAGE_TO && db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_guest = 0').get().n === 1) {
    auth.updateProfile(userId, { phone: process.env.IMESSAGE_TO });
  }
};
const respond = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    if (!err.status || err.status >= 500) console.error(`[auth] ${req.path}:`, err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
};
app.post('/api/auth/signup', respond((req, res) => auth.signup(req, res, { onCreate })));
app.post('/api/auth/login', respond((req, res) => auth.login(req, res)));
app.post('/api/auth/guest', respond((req, res) => auth.guest(req, res, { onCreate })));
app.post('/api/auth/logout', respond((req, res) => auth.logout(req, res)));

// Everything below needs a signed-in user (guest accounts count).
app.use('/api', auth.requireUser);

app.get('/api/me', handle((req) => ({ ...auth.publicUser(req.user), notifications: push.hasSubscription(req.user.id) })));
app.post('/api/me', handle((req) => auth.updateProfile(req.user.id, req.body)));

// ---- Notifications ----
app.post('/api/push/subscribe', handle((req) => push.subscribe(req.user.id, req.body)));
app.post('/api/push/unsubscribe', handle((req) => push.unsubscribe(req.user.id, req.body?.endpoint)));
app.post('/api/push/test', handle((req) => {
  push.notify(req.user.id, { title: 'Stride', body: 'Notifications are on. See you on your next run! 🏃' });
  return { ok: true };
}));

// ---- Bank ----
const money = (n) => `$${Number(n).toFixed(2)}`;
const celebrate = (userId, result) => {
  if (result.goalReached) {
    push.notify(userId, { title: '🎉 Goal reached!', body: `${result.state.goal.name} hit ${money(result.state.goal.target)}. Time to set a new one.` });
  }
  return result;
};
app.get('/api/bank', handle((req) => bank.getState(req.user.id)));
app.post('/api/bank/transfer', handle(async (req) => celebrate(req.user.id, await bank.transferToSavings(req.user.id, req.body))));
app.post('/api/bank/purchase', handle((req) => bank.purchase(req.user.id, req.body)));
app.post('/api/bank/penalty', handle(async (req) => celebrate(req.user.id, await bank.skipPenalty(req.user.id))));
app.post('/api/bank/goal', handle((req) => bank.updateGoal(req.user.id, req.body)));
app.post('/api/bank/runs', handle((req) => {
  const result = bank.recordRun(req.user.id, req.body);
  const { run, state } = result;
  imessage.sendRunRecap(req.user, run, state);
  if (run.miles >= 0.05) {
    push.notify(req.user.id, {
      title: `🏃 ${run.miles.toFixed(2)} mi${run.destination ? ` to ${run.destination}` : ''}`,
      body: `+${money(run.earned)} saved · ${state.goal.name} is at ${money(state.goal.saved)} of ${money(state.goal.target)}`,
    });
  }
  return result;
}));
app.post('/api/bank/reset', handle((req) => bank.reset(req.user.id)));
app.get('/api/bank/verify', handle((req) => bank.verifyNessie(req.user.id)));

// ---- Route planning (rate-limited: it calls shared public map servers) ----
const planCalls = new Map();
app.post('/api/routes', handle((req) => {
  const recent = (planCalls.get(req.user.id) || []).filter((t) => t > Date.now() - 60000);
  if (recent.length >= 15) {
    const err = new Error('Too many route requests. Try again in a minute.');
    err.status = 429;
    throw err;
  }
  planCalls.set(req.user.id, [...recent, Date.now()]);
  return planRoutes(req.body);
}));

const server = http.createServer(app);

// ---- Grok voice proxy ----
// Browsers can't set an Authorization header on a WebSocket, so the page talks
// to us and we relay to xAI with the key attached. The key never reaches the client.
const wss = new WebSocketServer({ server, path: '/realtime' });

wss.on('connection', (client, req) => {
  // Only signed-in users may spend the server's xAI credits.
  if (!auth.userFromRequest(req)) {
    client.close(4401, 'Please sign in');
    return;
  }
  if (!XAI_API_KEY) {
    client.close(4001, 'XAI_API_KEY is not set on the server');
    return;
  }

  const upstream = new WebSocket(
    `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(XAI_VOICE_MODEL)}`,
    { headers: { Authorization: `Bearer ${XAI_API_KEY}` } },
  );
  const queued = [];

  upstream.on('open', () => {
    console.log('[voice] connected to xAI realtime');
    for (const msg of queued) upstream.send(msg);
    queued.length = 0;
  });

  upstream.on('message', (data, isBinary) => {
    if (DEBUG && !isBinary) {
      const text = data.toString();
      const type = text.match(/"type"\s*:\s*"([^"]+)"/)?.[1];
      if (type !== 'response.output_audio.delta') console.log('[voice] <-', type, type === 'error' ? text : '');
    }
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });

  upstream.on('unexpected-response', (req, res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      const message = `xAI rejected the connection (HTTP ${res.statusCode}): ${body.slice(0, 200)}`;
      console.error('[voice]', message);
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'proxy.error', message }));
        client.close(4002, 'Upstream rejected connection');
      }
    });
  });

  upstream.on('error', (err) => {
    console.error('[voice] upstream error:', err.message);
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'proxy.error', message: err.message }));
      client.close(4003, 'Upstream error');
    }
  });

  upstream.on('close', (code, reason) => {
    console.log(`[voice] xAI closed (${code}) ${reason}`);
    if (client.readyState === WebSocket.OPEN) client.close(1000, String(reason).slice(0, 120));
  });

  client.on('message', (data, isBinary) => {
    const msg = isBinary ? data : data.toString();
    if (DEBUG && !isBinary) {
      const type = msg.match(/"type"\s*:\s*"([^"]+)"/)?.[1];
      if (type !== 'input_audio_buffer.append') console.log('[voice] ->', type);
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(msg, { binary: isBinary });
    else if (upstream.readyState === WebSocket.CONNECTING) queued.push(msg);
  });

  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
  });
});

server.listen(PORT, async () => {
  console.log(`\n  Stride running at http://localhost:${PORT}`);
  const status = await checkXaiKey();
  console.log(`  Grok voice: ${status.ok ? `on (${XAI_VOICE_MODEL}, voice "${XAI_VOICE}")` : `off — ${status.message} (browser voice fallback in use)`}`);
  console.log(`  Nessie:     ${process.env.NESSIE_API_KEY ? 'on (accounts open per user)' : 'off — add NESSIE_API_KEY to .env (local ledger only)'}`);
  await imessage.start({ bank });
  auth.cleanup();
  setInterval(auth.cleanup, 6 * 3600000).unref();
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  console.log(`  iMessage:   ${imessage.enabled ? `on${imessage.reason ? ` (replies off: ${imessage.reason})` : ''}` : `off — ${imessage.reason}`}`);
  console.log(`  Users:      ${users}\n`);
});

const shutdown = async () => {
  await imessage.stop();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
