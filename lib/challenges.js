// "Back Me" challenges: a runner sets a goal (a race, a timed run, or total miles by a date),
// shares a link, and friends pledge. Pledges are support, not bets:
//   flat     → paid only if the runner succeeds
//   per mile → paid for miles actually run, up to a cap
//   predictions (finish time) carry no money; the closest guess gets bragging rights.
// When a recorded run proves the goal, every pledge moves from the backer's checking into
// the runner's savings goal (mirrored to Nessie for both people).
import crypto from 'node:crypto';
import { db, now, newId } from './db.js';
import * as bank from './bank.js';
import * as push from './push.js';

const MAX_FLAT = 500;
const MAX_PER_MILE = 50;
const DISTANCE_SLACK = 0.98; // GPS distance can come up a hair short
const round = (n) => Math.round(n * 100) / 100;
const money = (n) => `$${Number(n).toFixed(2)}`;
const firstName = (name) => String(name || 'A runner').split(/\s+/)[0];

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

// Simulated runs prove nothing in production; allowed elsewhere so the demo works indoors.
const simulatedRunsCount = () =>
  process.env.ALLOW_SIM_CHALLENGES === '1' || (process.env.ALLOW_SIM_CHALLENGES !== '0' && process.env.NODE_ENV !== 'production');

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const makeCode = () => Array.from(crypto.randomBytes(7), (b) => ALPHABET[b % ALPHABET.length]).join('');

const byCode = (code) => db.prepare('SELECT * FROM challenges WHERE code = ?').get(String(code || '').toLowerCase());

export function clock(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// ---------- progress ----------
function qualifyingRuns(c) {
  const runs = db
    .prepare('SELECT * FROM runs WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date')
    .all(c.user_id, c.starts_at, c.ends_at);
  return simulatedRunsCount() ? runs : runs.filter((r) => r.mode !== 'sim');
}

// How far along the challenge is: total miles for 'total', the best single run for 'run'.
function progress(c) {
  const runs = qualifyingRuns(c);
  if (c.kind === 'total') {
    return { miles: round(runs.reduce((s, r) => s + r.miles, 0)), seconds: runs.reduce((s, r) => s + r.seconds, 0), done: false, runs: runs.length };
  }
  const meets = (r) => r.miles >= c.miles * DISTANCE_SLACK && (!c.target_seconds || r.seconds <= c.target_seconds);
  const winner = runs.find(meets);
  const best = winner || runs.reduce((b, r) => (!b || r.miles > b.miles ? r : b), null);
  return { miles: best ? best.miles : 0, seconds: best ? best.seconds : null, done: Boolean(winner), runs: runs.length };
}

function isDone(c, p) {
  return c.kind === 'total' ? p.miles >= c.miles * DISTANCE_SLACK : p.done;
}

// What a pledge pays: flat only on success, per-mile on miles run (capped).
function owed(pledge, success, miles) {
  const perMile = pledge.per_mile > 0 ? Math.min(pledge.per_mile * miles, pledge.cap ?? Infinity) : 0;
  return round((success ? pledge.flat : 0) + perMile);
}

const closestPrediction = (pledges, actual) =>
  pledges
    .filter((x) => x.predicted_seconds)
    .reduce((best, x) => (!best || Math.abs(x.predicted_seconds - actual) < Math.abs(best.predicted_seconds - actual) ? x : best), null);

// ---------- reads ----------
function pledgesOf(challengeId) {
  return db
    .prepare('SELECT p.*, u.name AS backer_name FROM pledges p JOIN users u ON u.id = p.backer_id WHERE p.challenge_id = ? ORDER BY p.created_at')
    .all(challengeId);
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function summarize(c, viewerId = null) {
  const owner = db.prepare('SELECT name FROM users WHERE id = ?').get(c.user_id);
  const pledges = pledgesOf(c.id);
  const p = progress(c);
  const predictions = pledges.filter((x) => x.predicted_seconds);
  const closest = c.status === 'completed' && c.result_seconds ? closestPrediction(pledges, c.result_seconds) : null;
  const mine = pledges.find((x) => x.backer_id === viewerId);
  return {
    code: c.code,
    title: c.title,
    kind: c.kind,
    miles: c.miles,
    targetSeconds: c.target_seconds,
    message: c.message,
    startsAt: c.starts_at,
    endsAt: c.ends_at,
    status: c.status,
    result: c.status === 'open' ? null : { miles: c.result_miles, seconds: c.result_seconds },
    progressMiles: c.status === 'open' ? p.miles : c.result_miles,
    runner: { name: firstName(owner?.name) },
    isOwner: viewerId === c.user_id,
    totals: {
      backers: pledges.length,
      ifSuccess: round(pledges.reduce((s, x) => s + owed(x, true, c.miles), 0)),
      flat: round(pledges.reduce((s, x) => s + x.flat, 0)),
      perMile: round(pledges.reduce((s, x) => s + x.per_mile, 0)),
      paid: round(pledges.reduce((s, x) => s + (x.paid_amount || 0), 0)),
    },
    predictions: {
      count: predictions.length,
      medianSeconds: median(predictions.map((x) => x.predicted_seconds)),
      closest: closest ? { name: firstName(closest.backer_name), seconds: closest.predicted_seconds } : null,
    },
    backers: pledges.map((x) => ({
      name: firstName(x.backer_name),
      flat: x.flat,
      perMile: x.per_mile,
      cap: x.cap,
      predictedSeconds: x.predicted_seconds,
      message: x.message,
      status: x.status,
      paid: x.paid_amount,
      mine: x.backer_id === viewerId,
    })),
    myPledge: mine ? { flat: mine.flat, perMile: mine.per_mile, cap: mine.cap, predictedSeconds: mine.predicted_seconds, message: mine.message, status: mine.status } : null,
  };
}

export function get(code, viewerId) {
  const c = byCode(code) || fail(404, 'Challenge not found');
  return summarize(c, viewerId);
}

export function list(userId) {
  const own = db.prepare("SELECT * FROM challenges WHERE user_id = ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 50").all(userId);
  const backing = db
    .prepare(
      `SELECT c.* FROM challenges c JOIN pledges p ON p.challenge_id = c.id
       WHERE p.backer_id = ? AND c.status != 'cancelled' ORDER BY c.ends_at DESC LIMIT 50`,
    )
    .all(userId);
  return { own: own.map((c) => summarize(c, userId)), backing: backing.map((c) => summarize(c, userId)) };
}

// ---------- writes ----------
export function create(userId, { title, kind, miles, targetSeconds, endsAt, message } = {}) {
  const cleanTitle = String(title || '').trim().slice(0, 60) || fail(400, 'Give your challenge a name');
  if (!['run', 'total'].includes(kind)) fail(400, 'Pick a challenge type');
  const m = round(Number(miles));
  if (!(m >= 0.1 && m <= 500)) fail(400, 'Distance must be between 0.1 and 500 miles');
  let target = null;
  if (targetSeconds != null && targetSeconds !== '') {
    target = Math.round(Number(targetSeconds));
    if (kind !== 'run') fail(400, 'Time goals only apply to a single run');
    if (!(target >= 60 && target <= 48 * 3600)) fail(400, 'Time goal must be between 1 minute and 48 hours');
  }
  const ends = new Date(endsAt);
  if (Number.isNaN(ends.getTime()) || ends.getTime() <= Date.now()) fail(400, 'Pick a deadline in the future');
  if (ends.getTime() > Date.now() + 366 * 86400000) fail(400, 'Deadline must be within a year');
  const row = {
    id: newId(),
    code: makeCode(),
    user_id: userId,
    title: cleanTitle,
    kind,
    miles: m,
    target_seconds: target,
    message: message ? String(message).trim().slice(0, 140) : null,
    starts_at: now(),
    ends_at: ends.toISOString(),
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO challenges (id, code, user_id, title, kind, miles, target_seconds, message, starts_at, ends_at, created_at)
     VALUES (@id, @code, @user_id, @title, @kind, @miles, @target_seconds, @message, @starts_at, @ends_at, @created_at)`,
  ).run(row);
  return summarize(byCode(row.code), userId);
}

export function cancel(userId, code) {
  const c = byCode(code) || fail(404, 'Challenge not found');
  if (c.user_id !== userId) fail(403, 'Only the runner can cancel this challenge');
  if (c.status !== 'open') fail(400, 'This challenge is already settled');
  db.prepare("UPDATE challenges SET status = 'cancelled', settled_at = ? WHERE id = ?").run(now(), c.id);
  for (const p of pledgesOf(c.id)) {
    push.notify(p.backer_id, { title: 'Challenge cancelled', body: `${firstName(db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name)} cancelled “${c.title}”. You won't be charged.` });
  }
  return { ok: true };
}

export function pledge(backerId, code, { flat, perMile, cap, predictedSeconds, message } = {}) {
  const c = byCode(code) || fail(404, 'Challenge not found');
  if (c.status !== 'open' || new Date(c.ends_at) < new Date()) fail(400, 'This challenge is closed');
  if (c.user_id === backerId) fail(400, "You can't back your own challenge, but you can share it");
  const f = round(Number(flat) || 0);
  const pm = round(Number(perMile) || 0);
  if (f < 0 || f > MAX_FLAT) fail(400, `Flat pledge must be between $0 and ${money(MAX_FLAT)}`);
  if (pm < 0 || pm > MAX_PER_MILE) fail(400, `Per-mile pledge must be between $0 and ${money(MAX_PER_MILE)}`);
  const capValue = pm > 0 ? round(cap != null && cap !== '' ? Number(cap) : pm * c.miles) : null;
  if (capValue != null && !(capValue > 0)) fail(400, 'Per-mile cap must be more than $0');
  let predicted = null;
  if (predictedSeconds != null && predictedSeconds !== '') {
    predicted = Math.round(Number(predictedSeconds));
    if (c.kind !== 'run') fail(400, 'Predictions are for single runs');
    if (!(predicted >= 60 && predicted <= 48 * 3600)) fail(400, 'Prediction must be between 1 minute and 48 hours');
  }
  if (!f && !pm && !predicted) fail(400, 'Pledge an amount or make a prediction');
  const most = round(f + (capValue || 0));
  const balance = bank.checkingBalance(backerId);
  if (most > balance) fail(400, `That could cost up to ${money(most)}, but your checking has ${money(balance)}`);

  const existing = db.prepare('SELECT id FROM pledges WHERE challenge_id = ? AND backer_id = ?').get(c.id, backerId);
  const fields = { flat: f, per_mile: pm, cap: capValue, predicted_seconds: predicted, message: message ? String(message).trim().slice(0, 140) : null };
  if (existing) {
    db.prepare('UPDATE pledges SET flat = @flat, per_mile = @per_mile, cap = @cap, predicted_seconds = @predicted_seconds, message = @message WHERE id = @id').run({ ...fields, id: existing.id });
  } else {
    db.prepare(
      `INSERT INTO pledges (id, challenge_id, backer_id, flat, per_mile, cap, predicted_seconds, message, created_at)
       VALUES (@id, @challenge_id, @backer_id, @flat, @per_mile, @cap, @predicted_seconds, @message, @created_at)`,
    ).run({ ...fields, id: newId(), challenge_id: c.id, backer_id: backerId, created_at: now() });
    const backer = db.prepare('SELECT name FROM users WHERE id = ?').get(backerId);
    const what = [f && `${money(f)} if you finish`, pm && `${money(pm)}/mile`, predicted && `predicts ${clock(predicted)}`].filter(Boolean).join(' + ');
    push.notify(c.user_id, { title: `🤝 ${firstName(backer?.name)} backed “${c.title}”`, body: what, url: `/c/${c.code}` });
  }
  return summarize(byCode(code), backerId);
}

export function unpledge(backerId, code) {
  const c = byCode(code) || fail(404, 'Challenge not found');
  if (c.status !== 'open') fail(400, 'This challenge is already settled');
  db.prepare('DELETE FROM pledges WHERE challenge_id = ? AND backer_id = ?').run(c.id, backerId);
  return summarize(c, backerId);
}

// ---------- settlement ----------
async function settle(c, success, p) {
  // Claim the challenge first so two runs finishing at once can't pay twice.
  const claimed = db
    .prepare("UPDATE challenges SET status = ?, result_miles = ?, result_seconds = ?, settled_at = ? WHERE id = ? AND status = 'open'")
    .run(success ? 'completed' : 'missed', p.miles, p.seconds ?? null, now(), c.id);
  if (!claimed.changes) return null;

  const runner = db.prepare('SELECT name FROM users WHERE id = ?').get(c.user_id);
  const runnerName = firstName(runner?.name);
  let total = 0;
  let goalReached = false;
  const paidBy = [];
  for (const pl of pledgesOf(c.id)) {
    const amount = owed(pl, success, p.miles);
    const result = amount > 0
      ? await bank.payPledge(pl.backer_id, c.user_id, amount, { challengeTitle: c.title, backerName: firstName(pl.backer_name), runnerName })
      : { paid: 0 };
    const status = amount === 0 ? 'released' : result.paid ? 'paid' : 'short';
    db.prepare('UPDATE pledges SET status = ?, paid_amount = ? WHERE id = ?').run(status, result.paid || 0, pl.id);
    total = round(total + (result.paid || 0));
    goalReached ||= Boolean(result.goalReached);
    if (result.paid) paidBy.push(firstName(pl.backer_name));

    push.notify(pl.backer_id, {
      title: success ? `🏁 ${runnerName} did it!` : `${runnerName} ran ${p.miles.toFixed(1)} of ${c.miles} mi`,
      body: result.paid
        ? `Your ${money(result.paid)} pledge for “${c.title}” went to their savings.`
        : status === 'short'
          ? `Your pledge for “${c.title}” couldn't be paid: not enough in checking.`
          : `“${c.title}” ended. Your pledge was released; you weren't charged.`,
      url: `/c/${c.code}`,
    });
  }

  const goal = db.prepare('SELECT goal_name FROM banks WHERE user_id = ?').get(c.user_id)?.goal_name || 'savings';
  push.notify(c.user_id, {
    title: success ? `🏁 You did it: ${c.title}` : `Challenge ended: ${c.title}`,
    body: total
      ? `${money(total)} from ${paidBy.length} backer${paidBy.length === 1 ? '' : 's'} moved to your ${goal}.`
      : success
        ? 'Nice work! Share your next challenge to get backers.'
        : `You ran ${p.miles.toFixed(1)} of ${c.miles} mi. Next time!`,
    url: `/c/${c.code}`,
  });
  if (goalReached) push.notify(c.user_id, { title: '🎉 Goal reached!', body: `Your ${goal} hit its target.` });

  const winner = success && p.seconds ? closestPrediction(pledgesOf(c.id), p.seconds) : null;
  if (winner) {
    push.notify(winner.backer_id, { title: '🎯 Closest prediction!', body: `You guessed ${clock(winner.predicted_seconds)} for ${runnerName}'s “${c.title}”. Actual: ${clock(p.seconds)}.` });
  }
  return { code: c.code, title: c.title, status: success ? 'completed' : 'missed', paid: total, backers: paidBy.length };
}

// After a run is recorded: settle any of the runner's open challenges it completes.
export async function onRun(userId) {
  const open = db.prepare("SELECT * FROM challenges WHERE user_id = ? AND status = 'open' AND ends_at >= ?").all(userId, now());
  const results = [];
  for (const c of open) {
    const p = progress(c);
    if (isDone(c, p)) {
      const r = await settle(c, true, p);
      if (r) results.push(r);
    }
  }
  return results;
}

// Close challenges whose deadline passed: per-mile pledges pay for miles run, flat pledges are released.
export async function sweep() {
  const expired = db.prepare("SELECT * FROM challenges WHERE status = 'open' AND ends_at < ?").all(now());
  for (const c of expired) {
    const p = progress(c);
    await settle(c, isDone(c, p), p).catch((err) => console.warn('[challenges] settle failed:', err.message));
  }
}
