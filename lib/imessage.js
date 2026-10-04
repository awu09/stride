// Run recaps over iMessage via Photon's imessage-kit (macOS only).
// Each user can save a phone number; Stride texts them a recap after every run and answers
// BALANCE / RUNS / SKIP replies from that number. Enable with IMESSAGE_ENABLED=1 (or IMESSAGE_TO).
// If it can't start (not a Mac, no Full Disk Access), the rest of Stride runs normally.
import { db } from './db.js';

export let enabled = false;
export let reason = 'set IMESSAGE_ENABLED=1 in .env to turn on';

let sdk = null;
let bank = null;
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const money = (n) => `$${Number(n).toFixed(2)}`;
const clock = (secs) => `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}`;

// Texts we sent, so a self-addressed thread doesn't make Stride answer itself.
const sentByUs = new Set();

async function send(to, text) {
  if (!enabled || !to) return;
  sentByUs.add(text.trim());
  if (sentByUs.size > 200) sentByUs.delete(sentByUs.values().next().value);
  try {
    await sdk.send({ to, text });
  } catch (err) {
    console.error('[imessage] send failed:', err.message);
  }
}

function goalLine(state) {
  const g = state.goal;
  return `${g.name}: ${money(g.saved)} / ${money(g.target)} (${Math.round((g.saved / g.target) * 100)}%)`;
}

function userByPhone(phone) {
  const d = digits(phone);
  if (d.length < 10) return null;
  return db.prepare('SELECT id, phone FROM users WHERE phone IS NOT NULL').all().find((u) => digits(u.phone) === d) || null;
}

async function reply(userId, text) {
  const t = text.trim().toLowerCase();
  const state = bank.getState(userId);
  if (/^(balance|savings?|goal|fund)\b/.test(t)) {
    return `💰 ${goalLine(state)}\nChecking: ${money(state.checking.balance)}\nEarning ${money(state.rules.perMile)} per mile.`;
  }
  if (/^(runs?|history|stats)\b/.test(t)) {
    const runs = state.runs.slice(0, 3);
    if (!runs.length) return 'No runs yet. Go get one! 🏃';
    return `🏃 Last runs:\n${runs
      .map((r) => `• ${new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ${r.miles.toFixed(2)} mi${r.destination ? ` → ${r.destination}` : ''}, +${money(r.earned)}`)
      .join('\n')}`;
  }
  if (/^skip(ped)?\b/.test(t)) {
    try {
      const { transaction, state: next } = await bank.skipPenalty(userId);
      return `⏭️ Skipped run logged. ${money(transaction.amount)} moved to savings.\n${goalLine(next)}`;
    } catch (err) {
      return `Couldn't log the skip: ${err.message}`;
    }
  }
  if (/^(help|stride|\?)$/.test(t)) return 'Stride commands: BALANCE, RUNS, SKIP';
  return null; // not a command; stay quiet
}

async function onMessage(msg) {
  const text = msg.text?.trim();
  if (!text || msg.chatKind === 'group') return;
  if (msg.isFromMe && sentByUs.has(text)) return;
  const user = userByPhone(msg.participant);
  if (!user) return;
  const answer = await reply(user.id, text);
  if (answer) await send(user.phone, answer);
}

export async function start(deps) {
  bank = deps.bank;
  if (process.env.IMESSAGE_ENABLED !== '1' && !process.env.IMESSAGE_TO) return;
  if (process.platform !== 'darwin') {
    reason = 'iMessage needs the server to run on a Mac';
    return;
  }
  try {
    const { IMessageSDK } = await import('@photon-ai/imessage-kit');
    sdk = new IMessageSDK();
    enabled = true;
    reason = '';
    await sdk.startWatching({
      onDirectMessage: onMessage,
      // Texting your own number shows up as "from me"; still answer commands.
      onFromMeMessage: onMessage,
      onError: (err) => console.error('[imessage] watcher error:', err.message),
    });
  } catch (err) {
    // Usually missing Full Disk Access for the terminal running node.
    reason = `${err.message} (grant Full Disk Access to your terminal in System Settings → Privacy & Security)`;
    enabled = Boolean(sdk); // sending can still work without the watcher
    if (!enabled) sdk = null;
  }
}

export function sendRunRecap(user, run, state) {
  if (!enabled || !user?.phone || !run || run.miles < 0.05) return;
  const pace = run.miles > 0 ? clock(run.seconds / run.miles) : '--:--';
  send(
    user.phone,
    [
      `🏃 Stride recap: ${run.miles.toFixed(2)} mi in ${clock(run.seconds)} (${pace}/mi)${run.destination ? ` to ${run.destination}` : ''}.`,
      `+${money(run.earned)} → ${goalLine(state)}`,
      'Reply BALANCE, RUNS or SKIP.',
    ].join('\n'),
  );
}

export async function stop() {
  await sdk?.close().catch(() => {});
}
