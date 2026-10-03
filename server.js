import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import * as bank from './lib/bank.js';
import { planRoutes } from './lib/planner.js';
import * as imessage from './lib/imessage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const XAI_API_KEY = process.env.XAI_API_KEY?.trim();
const XAI_VOICE_MODEL = process.env.XAI_VOICE_MODEL || 'grok-voice-latest';
const XAI_VOICE = process.env.XAI_VOICE || 'eve';
const DEBUG = process.env.DEBUG === '1';

const app = express();
app.use(express.json());
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

app.get('/api/config', handle(async () => {
  const status = await checkXaiKey();
  return { grokVoice: Boolean(XAI_API_KEY) && status.ok, voice: XAI_VOICE, voiceStatus: status.message };
}));

// ---- Bank (mock ledger) ----
app.get('/api/bank', handle(() => bank.getState()));
app.post('/api/bank/transfer', handle((req) => bank.transferToSavings(req.body)));
app.post('/api/bank/purchase', handle((req) => bank.purchase(req.body)));
app.post('/api/bank/penalty', handle(() => bank.skipPenalty()));
app.post('/api/bank/goal', handle((req) => bank.updateGoal(req.body)));
app.post('/api/bank/runs', handle((req) => {
  const result = bank.recordRun(req.body);
  imessage.sendRunRecap(result.run, result.state);
  return result;
}));
app.post('/api/bank/reset', handle(() => bank.reset()));
app.get('/api/bank/verify', handle(() => bank.verifyNessie()));

// ---- Route planning ----
app.post('/api/routes', handle((req) => planRoutes(req.body)));

const server = http.createServer(app);

// ---- Grok voice proxy ----
// Browsers can't set an Authorization header on a WebSocket, so the page talks
// to us and we relay to xAI with the key attached. The key never reaches the client.
const wss = new WebSocketServer({ server, path: '/realtime' });

wss.on('connection', (client) => {
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
  try {
    const linked = await bank.connectNessie();
    console.log(`  Nessie:     ${linked ? `on (checking ••${linked.checking.last4}, savings ••${linked.savings.last4})` : 'off — add NESSIE_API_KEY to .env (local ledger only)'}`);
  } catch (err) {
    console.log(`  Nessie:     off — ${err.message} (local ledger only)`);
  }
  await imessage.start({ bank });
  console.log(`  iMessage:   ${imessage.enabled ? `on → ${process.env.IMESSAGE_TO}${imessage.reason ? ` (replies off: ${imessage.reason})` : ''}` : `off — ${imessage.reason}`}\n`);
});

process.on('SIGINT', async () => {
  await imessage.stop();
  process.exit(0);
});
