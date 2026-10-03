// Run recaps over iMessage via Photon's imessage-kit (macOS only).
// Sends a recap after each run and answers a few text commands from IMESSAGE_TO.
// Everything here is optional: if it can't start, the rest of Stride runs normally.

export let enabled = false;
export let reason = 'IMESSAGE_TO not set in .env';

let sdk = null;
let bank = null;
const recipient = () => process.env.IMESSAGE_TO?.trim();
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const money = (n) => `$${Number(n).toFixed(2)}`;
const clock = (secs) => `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}`;

// Texts we sent, so a self-addressed thread doesn't make Stride answer itself.
const sentByUs = new Set();

async function send(text) {
  if (!enabled) return;
  sentByUs.add(text.trim());
  if (sentByUs.size > 50) sentByUs.delete(sentByUs.values().next().value);
  try {
    await sdk.send({ to: recipient(), text });
  } catch (err) {
    console.error('[imessage] send failed:', err.message);
  }
}

function goalLine(state) {
  const g = state.goal;
  return `${g.name}: ${money(g.saved)} / ${money(g.target)} (${Math.round((g.saved / g.target) * 100)}%)`;
}

async function reply(text) {
  const t = text.trim().toLowerCase();
  const state = bank.getState();
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
      const { transaction, state: next } = await bank.skipPenalty();
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
  if (!text || msg.chatKind === 'group' || digits(msg.participant) !== digits(recipient())) return;
  if (msg.isFromMe && sentByUs.has(text)) return;
  const answer = await reply(text);
  if (answer) await send(answer);
}

export async function start(deps) {
  bank = deps.bank;
  if (!recipient()) return;
  if (process.platform !== 'darwin') {
    reason = 'iMessage needs macOS';
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

export function sendRunRecap(run, state) {
  if (!enabled || !run || run.miles < 0.05) return;
  const pace = run.miles > 0 ? clock(run.seconds / run.miles) : '--:--';
  const text = [
    `🏃 Stride recap: ${run.miles.toFixed(2)} mi in ${clock(run.seconds)} (${pace}/mi)${run.destination ? ` to ${run.destination}` : ''}.`,
    `+${money(run.earned)} → ${goalLine(state)}`,
    'Reply BALANCE, RUNS or SKIP.',
  ].join('\n');
  send(text);
}

export async function stop() {
  await sdk?.close().catch(() => {});
}
