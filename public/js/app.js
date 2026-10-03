import { api } from './api.js';
import { RunMap, OPTION_COLORS } from './map.js';
import { RunSession } from './run.js';
import { GrokVoice, BrowserVoice, speak } from './voice.js';
import { parseCommand } from './commands.js';
import { money, formatClock, formatPace, formatDistanceShort, spokenDistance } from './geo.js';

const DEFAULT_START = { lat: 42.3554, lng: -71.0656 }; // Boston Common
const DEFAULT_PACE = 570; // 9:30 / mi, used until the runner has history
const CATEGORY_LABELS = { coffee: 'Coffee', smoothie: 'Smoothie', grocery: 'Grocery', atm: 'ATM', treat: 'Treat', any: 'Surprise' };
const TURN_ICONS = { left: '↰', right: '↱', 'slight left': '↖', 'slight right': '↗', 'sharp left': '↰', 'sharp right': '↱', uturn: '↶', straight: '↑' };

const $ = (id) => document.getElementById(id);
const round2 = (n) => Math.round(n * 100) / 100;
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`stride.${key}`);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`stride.${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  },
};

const S = {
  config: { grokVoice: false },
  bank: null,
  start: DEFAULT_START,
  plan: store.get('plan', { miles: 3.1, category: 'coffee', budget: 6 }),
  // Phones track real GPS by default; laptops default to the demo simulation.
  runMode: store.get('runMode', window.matchMedia('(pointer: coarse)').matches ? 'gps' : 'sim'),
  simSpeed: store.get('simSpeed', 10),
  result: null,
  selectedId: null,
  run: null,
  runRoute: null,
  runEarned: 0,
  lastRun: null,
  view: 'plan',
};

const map = new RunMap($('map'), DEFAULT_START);
let grok = null;

// ---------- small UI helpers ----------
let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

function setBusy(button, busy, label) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

function show(view) {
  S.view = view;
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.dataset.view !== view));
  document.body.dataset.view = view;
  $('turnBanner').hidden = view !== 'run';
  $('sheet').scrollTop = 0;
  requestAnimationFrame(updateMapPadding);
}

function updateMapPadding() {
  const sheet = $('sheet').getBoundingClientRect();
  const wide = window.innerWidth >= 900;
  map.padding = wide
    ? { topLeft: [sheet.right + 32, 96], bottomRight: [40, 40] }
    : { topLeft: [24, 96], bottomRight: [24, window.innerHeight - sheet.top + 24] };
  map.invalidate();
}
window.addEventListener('resize', updateMapPadding);

// ---------- voice bubble ----------
let bubbleTimer;
function bubble(role, text) {
  const el = $('voiceBubble');
  el.hidden = false;
  $(role === 'user' ? 'vbUser' : 'vbBot').textContent = text;
  if (role === 'user') $('vbBot').textContent = '';
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => (el.hidden = true), 9000);
}

// Spoken cue: through Grok when it's live, otherwise the browser's voice.
function cue(text) {
  if (!text) return;
  if (grok?.connected) grok.say(text);
  else {
    speak(text);
    bubble('bot', text);
  }
}

// ---------- bank ----------
function setBank(bank) {
  S.bank = bank;
  const g = bank.goal;
  const pct = Math.min(100, (g.saved / g.target) * 100);
  $('goalName').textContent = g.name;
  $('goalAmount').textContent = `${money(g.saved)} / ${money(g.target)}`;
  $('goalBar').style.width = `${pct}%`;
  $('walletGoalName').textContent = g.name;
  $('walletGoalSaved').textContent = money(g.saved);
  $('walletGoalTarget').textContent = `${Math.round(pct)}% of ${money(g.target)}`;
  $('walletGoalBar').style.width = `${pct}%`;
  $('checkingBal').textContent = money(bank.checking.balance);
  $('perMileLabel').textContent = money(bank.rules.perMile);
  $('penaltyBtn').textContent = `I skipped today's run · move ${money(bank.rules.skipPenalty)} to savings`;
  const form = $('goalForm');
  if (!form.contains(document.activeElement)) {
    form.goalName.value = g.name;
    form.goalTarget.value = g.target;
    form.perMile.value = bank.rules.perMile;
    form.skipPenalty.value = bank.rules.skipPenalty;
  }
  const n = bank.nessie;
  $('nessieCard').hidden = !n;
  if (n) $('nessieAccounts').textContent = `Checking ••${n.checking.last4} · Savings ••${n.savings.last4}`;
  renderTransactions();
}

function renderTransactions() {
  const list = $('txList');
  list.replaceChildren(
    ...S.bank.transactions.slice(0, 25).map((t) => {
      const li = document.createElement('li');
      const toGoal = t.type === 'transfer';
      const date = new Date(t.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      li.innerHTML = `
        <span class="tx-icon ${toGoal ? 'in' : 'out'}">${toGoal ? '↗' : '☕'}</span>
        <span class="tx-body"><span class="tx-memo"></span><span class="tx-date">${date}${t.budget != null ? ` · budget ${money(t.budget)}` : ''}${t.nessie ? ' · <span class="synced">Nessie ✓</span>' : t.nessieError ? ' · <span class="unsynced">not synced</span>' : ''}</span></span>
        <span class="tx-amt ${toGoal ? 'in' : 'out'}">${toGoal ? '+' : '−'}${money(t.amount)}</span>`;
      li.querySelector('.tx-memo').textContent = t.memo;
      return li;
    }),
  );
}

function averagePace() {
  const runs = S.bank?.runs?.filter((r) => r.miles > 0.5) ?? [];
  const miles = runs.reduce((s, r) => s + r.miles, 0);
  const secs = runs.reduce((s, r) => s + r.seconds, 0);
  return miles ? secs / miles : DEFAULT_PACE;
}

function goalProjection() {
  const { goal, rules, runs } = S.bank;
  const weekAgo = Date.now() - 7 * 86400000;
  const weeklyMiles = runs.filter((r) => new Date(r.date) > weekAgo).reduce((s, r) => s + r.miles, 0);
  const left = goal.target - goal.saved;
  if (left <= 0) return `Goal reached. Time to set a new one!`;
  if (!weeklyMiles) return `Run this week to start earning toward ${money(goal.target)}.`;
  const weeks = Math.ceil(left / (weeklyMiles * rules.perMile));
  return `At ${weeklyMiles.toFixed(1)} mi/week you'll hit ${money(goal.target)} in about ${weeks} week${weeks === 1 ? '' : 's'}.`;
}

// ---------- start location ----------
function setStart(pos, source, { recenter = true } = {}) {
  S.start = pos;
  S.startSource = source;
  map.setStart(pos, { recenter, visible: source !== 'gps' });
  $('startLabel').textContent = {
    gps: 'Starting from your location · tap the map to move',
    map: 'Custom start · tap the map to move',
    default: 'Demo start: Boston Common · tap the map or use your location',
  }[source];
}

// Resolves true once the start point is the runner's real location.
function locate({ quiet = false } = {}) {
  if (!navigator.geolocation) return Promise.resolve(false);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setStart({ lat: p.coords.latitude, lng: p.coords.longitude }, 'gps');
        resolve(true);
      },
      (err) => {
        if (!quiet) {
          toast(
            err.code === err.PERMISSION_DENIED
              ? 'Location is blocked. On iPhone: Settings → Privacy & Security → Location Services → Safari Websites → While Using.'
              : 'Location unavailable. Tap the map to set a start point.',
          );
        }
        resolve(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 },
    );
  });
}

// Keep the blue dot on the runner at all times, and the start point on them while planning.
let liveFixes = 0;
function watchLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    (p) => {
      const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
      S.me = pos;
      if (!map.isRunning) map.setMe(pos, p.coords.accuracy);
      if (S.view === 'plan' && S.startSource !== 'map') setStart(pos, 'gps', { recenter: liveFixes === 0 });
      liveFixes++;
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
}

map.onClick((pos) => {
  if (S.view === 'plan') setStart(pos, 'map');
});

// ---------- plan form ----------
function renderPlan() {
  const { miles, category, budget } = S.plan;
  $('milesRange').value = miles;
  $('milesOut').textContent = `${Number(miles).toFixed(1)} mi`;
  document.querySelectorAll('#distanceChips button').forEach((b) => b.setAttribute('aria-pressed', Number(b.dataset.miles) === Number(miles)));
  document.querySelectorAll('#categoryChips button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.cat === category));
  $('budgetInput').value = budget ?? '';
  $('budgetField').hidden = category === 'atm';
  store.set('plan', S.plan);
}

$('distanceChips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.plan.miles = Number(b.dataset.miles);
  renderPlan();
});
$('milesRange').addEventListener('input', (e) => {
  S.plan.miles = Number(e.target.value);
  renderPlan();
});
$('categoryChips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.plan.category = b.dataset.cat;
  renderPlan();
});
$('budgetInput').addEventListener('input', (e) => {
  S.plan.budget = e.target.value === '' ? null : Number(e.target.value);
  store.set('plan', S.plan);
});
$('locateBtn').addEventListener('click', () => locate());
$('findBtn').addEventListener('click', () => findRoutes().catch(() => {}));

// ---------- route options ----------
async function findRoutes() {
  const btn = $('findBtn');
  setBusy(btn, true, 'Finding routes…');
  try {
    // Never plan a real run from the demo start point if we can get the real one.
    if (S.startSource === 'default') {
      btn.textContent = 'Finding your location…';
      await locate({ quiet: S.runMode !== 'gps' });
      btn.textContent = 'Finding routes…';
    }
    const result = await api.routes({
      ...S.start,
      miles: S.plan.miles,
      category: S.plan.category,
      budget: S.plan.category === 'atm' ? null : S.plan.budget,
    });
    if (!result.options.length) throw new Error('No routes found. Try another distance or destination.');
    S.result = result;
    S.selectedId = result.options[0].id;
    show('options');
    renderOptions();
    map.showOptions(result.options, S.selectedId, selectRoute);
    return result;
  } catch (err) {
    toast(err.message);
    throw err;
  } finally {
    setBusy(btn, false);
  }
}

function renderOptions() {
  const { options, notice, budget } = S.result;
  $('routeNotice').hidden = !notice;
  $('routeNotice').textContent = notice || '';
  const pace = averagePace();
  $('optionList').replaceChildren(
    ...options.map((o) => {
      const btn = document.createElement('button');
      btn.className = 'option';
      btn.type = 'button';
      btn.dataset.id = o.id;
      btn.setAttribute('aria-pressed', o.id === S.selectedId);
      btn.style.setProperty('--c', OPTION_COLORS[o.id]);
      const free = o.place.price === 0;
      const over = budget != null && !free ? round2(o.place.price - budget) : 0;
      const badge = free
        ? '<span class="badge neutral">No spend</span>'
        : budget == null
          ? ''
          : over > 0
            ? `<span class="badge warn">${money(over)} over</span>`
            : '<span class="badge good">In budget</span>';
      btn.innerHTML = `
        <span class="opt-letter">${o.id}</span>
        <span class="opt-main">
          <span class="opt-name"></span>
          <span class="opt-meta">${o.miles.toFixed(1)} mi · ~${Math.round((o.miles * pace) / 60)} min · ${CATEGORY_LABELS[o.place.category] || ''}</span>
        </span>
        <span class="opt-price">
          ${free ? '' : `<b>~${money(o.place.price)}</b>`}
          ${badge}
        </span>`;
      btn.querySelector('.opt-name').textContent = o.place.name;
      btn.addEventListener('click', () => selectRoute(o.id));
      return btn;
    }),
  );
  $('startBtn').disabled = !S.selectedId;
}

function selectRoute(id) {
  S.selectedId = id;
  document.querySelectorAll('#optionList .option').forEach((b) => b.setAttribute('aria-pressed', b.dataset.id === id));
  map.showOptions(S.result.options, id, selectRoute, { fit: false });
  $('startBtn').disabled = false;
}

$('backToPlan').addEventListener('click', () => {
  map.showOptions([], null, selectRoute, { fit: false });
  show('plan');
});
$('startBtn').addEventListener('click', () => startRun());

// ---------- running ----------
function renderModeToggle() {
  document.querySelectorAll('#modeToggle button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === S.runMode));
  $('simSpeed').value = String(S.simSpeed);
  $('simSpeed').hidden = S.runMode !== 'sim';
}

function startRun() {
  const route = S.result?.options.find((o) => o.id === S.selectedId);
  if (!route) return;
  S.runRoute = route;
  S.runEarned = 0;
  S.lastRun = null;
  S.finishing = false;
  map.showRun(route);
  show('run');
  renderModeToggle();
  $('pauseBtn').textContent = 'Pause';
  $('runDest').textContent = `To ${route.place.name}`;

  S.run = new RunSession(
    route,
    {
      onTick: renderRunStats,
      onCue: cue,
      onMile,
      onArrive: () => finishRun(true),
      onGps: renderGps,
      onError: toast,
    },
    { mode: S.runMode, simSpeed: S.simSpeed, simPace: averagePace() },
  );
  S.run.start();
  keepAwake(true);
  cue(`Let's go! ${route.miles.toFixed(1)} miles to ${route.place.name}. ${route.steps[0]?.text ?? ''}.`);

  if (S.config.grokVoice && !grok) connectGrok();
}

const GPS_LABELS = {
  waiting: 'Waiting for GPS…',
  denied: 'Location blocked: allow it in Settings → Privacy → Location Services',
  error: 'GPS unavailable, trying again…',
  unsupported: 'GPS not supported in this browser',
};
function renderGps(gps) {
  const el = $('gpsBadge');
  el.hidden = !gps;
  if (!gps) return;
  el.dataset.status = gps.status;
  el.textContent = gps.status === 'good' ? `GPS ±${gps.accuracy} m` : gps.status === 'weak' ? `Weak GPS ±${gps.accuracy} m` : GPS_LABELS[gps.status];
}

function renderRunStats(st) {
  renderGps(st.gps);
  $('statMiles').textContent = st.miles.toFixed(2);
  $('statTime').textContent = formatClock(st.elapsed);
  $('statPace').textContent = formatPace(st.pace);
  $('statEarned').textContent = money(S.runEarned);
  $('runRemaining').textContent = `${st.remainingMiles.toFixed(2)} mi left`;
  $('runBar').style.width = `${Math.min(100, st.fraction * 100)}%`;
  map.updateRun(st.position, st.done, st.gps?.accuracy);

  const next = st.next;
  if (next) {
    $('turnIcon').textContent = next.type === 'arrive' ? '⚑' : TURN_ICONS[next.modifier] || '↑';
    $('turnDist').textContent = formatDistanceShort(next.ahead);
    $('turnText').textContent = next.text;
  }
}

async function onMile(mile, st) {
  const amount = S.bank.rules.perMile;
  try {
    const { state } = await api.transfer(amount, `Run reward · mile ${mile}`);
    S.runEarned = round2(S.runEarned + amount);
    setBank(state);
    cue(`Mile ${mile}. ${money(amount)} moved to your ${state.goal.name}. Pace ${formatPace(st.pace)}.`);
  } catch (err) {
    toast(`Couldn't move mile reward: ${err.message}`);
  }
}

// iPhones stop reporting location when the screen locks, so hold a wake lock while running.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* not supported or denied; the run still works while the screen is on */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.run && !S.run.finished) keepAwake(true);
});

async function finishRun(arrived) {
  if (!S.run || S.finishing) return;
  S.finishing = true;
  const st = S.run.stats();
  S.run.finish();
  keepAwake(false);
  const route = S.runRoute;

  // Pay out the partial mile so total earned = miles × rate.
  const owed = round2(st.miles * S.bank.rules.perMile - S.runEarned);
  if (owed >= 0.01) {
    try {
      const { state } = await api.transfer(owed, `Run reward · ${st.miles.toFixed(2)} mi`);
      S.runEarned = round2(S.runEarned + owed);
      setBank(state);
    } catch (err) {
      toast(err.message);
    }
  }
  try {
    const { state } = await api.recordRun({ miles: st.miles, seconds: st.elapsed, earned: S.runEarned, destination: route.place.name });
    setBank(state);
  } catch (err) {
    toast(err.message);
  }

  S.lastRun = { ...st, arrived, route, earned: S.runEarned };
  S.run = null;
  renderRecap();
  show('recap');

  const budget = S.plan.category === 'atm' ? null : S.plan.budget;
  cue(
    arrived
      ? `You made it to ${route.place.name}! ${st.miles.toFixed(1)} miles in ${formatClock(st.elapsed)}. You earned ${money(S.runEarned)} for your ${S.bank.goal.name}.` +
          (budget != null ? ` Your budget here is ${money(budget)}. Tell me what you spend.` : '')
      : `Run ended. ${st.miles.toFixed(1)} miles and ${money(S.runEarned)} earned. Nice work.`,
  );
}

$('modeToggle').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.runMode = b.dataset.mode;
  store.set('runMode', S.runMode);
  S.run?.setMode(S.runMode);
  renderModeToggle();
});
$('simSpeed').addEventListener('change', (e) => {
  S.simSpeed = Number(e.target.value);
  store.set('simSpeed', S.simSpeed);
  if (S.run) S.run.simSpeed = S.simSpeed;
});
$('pauseBtn').addEventListener('click', () => {
  if (!S.run) return;
  if (S.run.paused) {
    S.run.resume();
    $('pauseBtn').textContent = 'Pause';
  } else {
    S.run.pause();
    $('pauseBtn').textContent = 'Resume';
  }
});
$('endBtn').addEventListener('click', () => finishRun(false));
$('recenterBtn').addEventListener('click', () => {
  map.following = true;
});
map.map.on('dragstart', () => {
  map.following = false;
});

// ---------- recap ----------
function renderRecap() {
  const r = S.lastRun;
  const budget = S.plan.category === 'atm' ? null : S.plan.budget;
  $('recapTitle').textContent = r.arrived ? `You made it to ${r.route.place.name}` : 'Run complete';
  $('recapMiles').textContent = r.miles.toFixed(2);
  $('recapTime').textContent = formatClock(r.elapsed);
  $('recapPace').textContent = formatPace(r.pace);
  $('recapEarned').textContent = money(r.earned);
  $('recapGoalLine').textContent = `${money(S.bank.goal.saved)} of ${money(S.bank.goal.target)} in ${S.bank.goal.name}`;
  $('recapGoalBar').style.width = `${Math.min(100, (S.bank.goal.saved / S.bank.goal.target) * 100)}%`;
  $('goalProjection').textContent = goalProjection();

  const showPurchase = r.arrived && r.route.place.price > 0;
  $('purchaseCard').hidden = !showPurchase;
  $('purchaseResult').hidden = true;
  $('purchaseForm').hidden = false;
  if (showPurchase) {
    $('recapPlace').textContent = r.route.place.name;
    $('recapBudget').textContent = budget != null ? money(budget) : 'none';
    $('recapEst').textContent = `~${money(r.route.place.price)}`;
    $('spendInput').value = r.route.place.price.toFixed(2);
  }
}

async function logPurchase(amount, merchant) {
  const name = merchant || S.lastRun?.route.place.name || S.runRoute?.place.name || 'Purchase';
  const budget = S.plan.category === 'atm' ? null : S.plan.budget;
  const result = await api.purchase(name, amount, budget);
  setBank(result.state);
  showPurchaseResult(result.verdict, amount);
  return result;
}

function showPurchaseResult(verdict, amount) {
  const el = $('purchaseResult');
  $('purchaseForm').hidden = true;
  el.hidden = false;
  el.className = 'purchase-result';
  if (!verdict) {
    el.textContent = `Logged ${money(amount)}.`;
    return;
  }
  if (verdict.withinBudget) {
    el.classList.add('good');
    el.innerHTML = `<p><b>${money(verdict.difference)} under budget.</b> Nice discipline.</p>`;
    if (verdict.difference >= 0.01) {
      const btn = document.createElement('button');
      btn.className = 'primary sm';
      btn.textContent = `Move ${money(verdict.difference)} to ${S.bank.goal.name}`;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const { state } = await api.transfer(verdict.difference, 'Under-budget bonus');
          setBank(state);
          btn.textContent = `Moved ${money(verdict.difference)} ✓`;
          renderRecapGoal();
          cue(`Moved ${money(verdict.difference)} to your ${state.goal.name}.`);
        } catch (err) {
          btn.disabled = false;
          toast(err.message);
        }
      });
      el.append(btn);
    }
  } else {
    el.classList.add('warn');
    el.innerHTML = `<p><b>${money(-verdict.difference)} over budget.</b> Next run's rewards will help even it out.</p>`;
  }
  renderRecapGoal();
}

function renderRecapGoal() {
  $('recapGoalLine').textContent = `${money(S.bank.goal.saved)} of ${money(S.bank.goal.target)} in ${S.bank.goal.name}`;
  $('recapGoalBar').style.width = `${Math.min(100, (S.bank.goal.saved / S.bank.goal.target) * 100)}%`;
  $('goalProjection').textContent = goalProjection();
}

function purchaseReply(verdict, amount) {
  if (!verdict) return `Logged ${money(amount)}.`;
  return verdict.withinBudget
    ? `Logged ${money(amount)}. That's ${money(verdict.difference)} under budget. Want me to move the difference to savings?`
    : `Logged ${money(amount)}. That's ${money(-verdict.difference)} over your ${money(verdict.budget)} budget.`;
}

$('purchaseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  if (form.dataset.busy) return; // a double tap must not charge twice
  const amount = Number($('spendInput').value);
  if (!(amount > 0)) return toast('Enter what you spent');
  form.dataset.busy = '1';
  try {
    const { verdict } = await logPurchase(amount);
    cue(purchaseReply(verdict, amount));
  } catch (err) {
    toast(err.message);
  } finally {
    delete form.dataset.busy;
  }
});
$('skipSpendBtn').addEventListener('click', () => {
  $('purchaseForm').hidden = true;
  const el = $('purchaseResult');
  el.hidden = false;
  el.className = 'purchase-result good';
  el.innerHTML = '<p><b>No spend today.</b> Your whole budget stays in checking.</p>';
});
$('againBtn').addEventListener('click', () => {
  map.clearRun();
  if (S.me && S.startSource !== 'map') setStart(S.me, 'gps');
  else map.setStart(S.start, { visible: S.startSource !== 'gps' });
  if (S.me) map.setMe(S.me);
  show('plan');
});

// ---------- wallet ----------
$('goalChip').addEventListener('click', () => {
  if (S.view === 'run') return;
  S.returnView = S.view === 'wallet' ? S.returnView : S.view;
  show('wallet');
});
$('walletBack').addEventListener('click', () => show(S.returnView || 'plan'));
$('goalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const { state } = await api.updateGoal({
      name: f.goalName.value,
      target: f.goalTarget.value,
      perMile: f.perMile.value,
      skipPenalty: f.skipPenalty.value,
    });
    document.activeElement?.blur();
    setBank(state);
    toast('Goal saved');
  } catch (err) {
    toast(err.message);
  }
});
$('penaltyBtn').addEventListener('click', async () => {
  try {
    const { state, transaction } = await api.penalty();
    setBank(state);
    cue(`${money(transaction.amount)} moved to your ${state.goal.name}. Tomorrow's run earns it back.`);
  } catch (err) {
    toast(err.message);
  }
});
$('verifyBtn').addEventListener('click', async () => {
  const btn = $('verifyBtn');
  const out = $('verifyResult');
  setBusy(btn, true, 'Checking Nessie…');
  try {
    const { remote, matches } = await api.verify();
    out.hidden = false;
    out.className = `small ${matches ? 'ok' : 'bad'}`;
    out.textContent = matches
      ? `✓ Balances match: rebuilt from ${remote.transactions} Nessie transactions (checking ${money(remote.checking)}, savings ${money(remote.savings)}).`
      : `Mismatch: Nessie shows checking ${money(remote.checking)}, savings ${money(remote.savings)}.`;
  } catch (err) {
    out.hidden = false;
    out.className = 'small bad';
    out.textContent = err.message;
  } finally {
    setBusy(btn, false);
  }
});

let resetArmed = false;
$('resetBtn').addEventListener('click', async () => {
  if (!resetArmed) {
    resetArmed = true;
    $('resetBtn').textContent = 'Tap again to reset';
    setTimeout(() => {
      resetArmed = false;
      $('resetBtn').textContent = 'Reset demo data';
    }, 3000);
    return;
  }
  const { state } = await api.reset();
  setBank(state);
  resetArmed = false;
  $('resetBtn').textContent = 'Reset demo data';
  toast('Demo data reset');
});

// ---------- tools (shared by Grok and the fallback parser) ----------
const TOOL_DEFS = [
  {
    type: 'function',
    name: 'plan_routes',
    description: 'Find up to three running routes of a target distance that finish at a kind of place. Call whenever the runner asks for a route or a run.',
    parameters: {
      type: 'object',
      properties: {
        distance_miles: { type: 'number', description: 'Target distance in miles. 5K = 3.1, 10K = 6.2, half marathon = 13.1.' },
        destination_type: { type: 'string', enum: ['coffee', 'smoothie', 'grocery', 'atm', 'treat', 'any'] },
        budget_dollars: { type: 'number', description: 'Most the runner wants to spend at the destination.' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'choose_route',
    description: 'Select one of the planned route options.',
    parameters: { type: 'object', properties: { option: { type: 'string', enum: ['A', 'B', 'C'] } }, required: ['option'] },
  },
  {
    type: 'function',
    name: 'start_run',
    description: 'Start the selected route with turn-by-turn guidance.',
    parameters: { type: 'object', properties: { simulate: { type: 'boolean', description: 'true for a sped-up demo run instead of GPS.' } } },
  },
  {
    type: 'function',
    name: 'get_run_status',
    description: 'Distance done and left, elapsed time, pace, next turn, and money earned this run.',
    parameters: { type: 'object', properties: {} },
  },
  { type: 'function', name: 'end_run', description: 'End the current run early.', parameters: { type: 'object', properties: {} } },
  {
    type: 'function',
    name: 'get_savings',
    description: 'Checking balance, savings goal progress, reward per mile, and recent activity.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'transfer_to_savings',
    description: 'Move money from checking into the savings goal.',
    parameters: {
      type: 'object',
      properties: { amount_dollars: { type: 'number' }, reason: { type: 'string' } },
      required: ['amount_dollars'],
    },
  },
  {
    type: 'function',
    name: 'log_purchase',
    description: 'Record what the runner spent at the destination and compare it to their budget.',
    parameters: {
      type: 'object',
      properties: { amount_dollars: { type: 'number' }, merchant: { type: 'string' } },
      required: ['amount_dollars'],
    },
  },
];

const tools = {
  async plan_routes({ distance_miles, destination_type, budget_dollars }) {
    if (S.view === 'run') return { error: 'A run is in progress. End it before planning a new route.' };
    if (distance_miles) S.plan.miles = Math.min(Math.max(Number(distance_miles), 0.5), 13.1);
    if (destination_type) S.plan.category = destination_type;
    if (budget_dollars != null) S.plan.budget = Number(budget_dollars);
    renderPlan();
    show('plan');
    const r = await findRoutes();
    return {
      notice: r.notice,
      budget: r.budget,
      options: r.options.map((o) => ({
        option: o.id,
        place: o.place.name,
        miles: round2(o.miles),
        estimated_price: o.place.price,
        within_budget: o.withinBudget,
      })),
    };
  },
  choose_route({ option }) {
    const id = String(option || '').toUpperCase();
    const o = S.result?.options.find((x) => x.id === id);
    if (!o) return { error: 'That option does not exist. Plan routes first.' };
    if (S.view !== 'options') show('options');
    selectRoute(id);
    return { selected: id, place: o.place.name, miles: round2(o.miles) };
  },
  start_run({ simulate } = {}) {
    if (S.view === 'run') return { error: 'Already running.' };
    if (!S.selectedId || !S.result) return { error: 'Plan and pick a route first.' };
    if (simulate === true) S.runMode = 'sim';
    if (simulate === false) S.runMode = 'gps';
    startRun();
    const r = S.runRoute;
    return { started: true, mode: S.runMode, destination: r.place.name, miles: round2(r.miles), first_instruction: r.steps[0]?.text };
  },
  get_run_status() {
    if (!S.run) {
      const r = S.lastRun;
      return r ? { running: false, last_run: { miles: round2(r.miles), time: formatClock(r.elapsed), earned: r.earned } } : { running: false };
    }
    const st = S.run.stats();
    return {
      running: true,
      destination: S.runRoute.place.name,
      miles_done: round2(st.miles),
      miles_left: round2(st.remainingMiles),
      elapsed: formatClock(st.elapsed),
      pace_per_mile: formatPace(st.pace),
      next_instruction: st.next ? `In ${spokenDistance(st.next.ahead)}, ${st.next.text}` : null,
      earned_this_run: S.runEarned,
    };
  },
  end_run() {
    if (!S.run) return { error: 'No run in progress.' };
    finishRun(false);
    return { ended: true };
  },
  get_savings() {
    const b = S.bank;
    return {
      checking_balance: b.checking.balance,
      goal: b.goal.name,
      saved: b.goal.saved,
      target: b.goal.target,
      percent: Math.round((b.goal.saved / b.goal.target) * 100),
      reward_per_mile: b.rules.perMile,
      skip_penalty: b.rules.skipPenalty,
      projection: goalProjection(),
      recent: b.transactions.slice(0, 3).map((t) => ({ type: t.type, amount: t.amount, memo: t.memo })),
    };
  },
  async transfer_to_savings({ amount_dollars, reason }) {
    const { state } = await api.transfer(amount_dollars, reason || 'Voice transfer');
    setBank(state);
    return { moved: Number(amount_dollars), goal: state.goal.name, saved: state.goal.saved, target: state.goal.target };
  },
  async log_purchase({ amount_dollars, merchant }) {
    const { verdict } = await logPurchase(Number(amount_dollars), merchant);
    return { charged: Number(amount_dollars), ...(verdict && { budget: verdict.budget, under_budget_by: verdict.withinBudget ? verdict.difference : 0, over_budget_by: verdict.withinBudget ? 0 : -verdict.difference }) };
  },
};

async function runTool(name, args) {
  const fn = tools[name];
  if (!fn) return { error: `Unknown tool ${name}` };
  return fn(args || {});
}

// Spoken replies for the fallback (Grok writes its own).
function replyFor(tool, r) {
  if (r?.error) return r.error;
  switch (tool) {
    case 'plan_routes':
      return `I found ${r.options.length} routes. ${r.options
        .map((o) => `${o.option}: ${o.place}, ${o.miles.toFixed(1)} miles${o.estimated_price ? `, about ${money(o.estimated_price)}` : ''}${o.within_budget ? '' : ', over budget'}`)
        .join('. ')}. Which one?`;
    case 'choose_route':
      return `Route ${r.selected} to ${r.place}. Say start when you're ready.`;
    case 'get_run_status':
      return r.running
        ? `${r.miles_done.toFixed(2)} miles done, ${r.miles_left.toFixed(2)} to go, pace ${r.pace_per_mile}. ${r.next_instruction ?? ''}`
        : "You're not running right now.";
    case 'get_savings':
      return `You've saved ${money(r.saved)} of ${money(r.target)} for your ${r.goal}. That's ${r.percent} percent. ${r.projection}`;
    case 'transfer_to_savings':
      return `Done. Moved ${money(r.moved)}. Your ${r.goal} is at ${money(r.saved)}.`;
    case 'log_purchase':
      return r.budget == null
        ? `Logged ${money(r.charged)}.`
        : r.over_budget_by > 0
          ? `Logged ${money(r.charged)}. That's ${money(r.over_budget_by)} over budget.`
          : `Logged ${money(r.charged)}. That's ${money(r.under_budget_by)} under budget. Nice.`;
    default:
      return ''; // start_run / end_run speak their own cues
  }
}

async function handleCommand(text) {
  const cmd = parseCommand(text);
  if (!cmd) return 'Try "plan a 5K to coffee under six dollars", "how far", or "how much have I saved".';
  try {
    return replyFor(cmd.tool, await runTool(cmd.tool, cmd.args));
  } catch (err) {
    return `Sorry, ${err.message}`;
  }
}

// ---------- mic ----------
const MIC_LABELS = { off: 'Talk', connecting: 'Connecting…', listening: 'Listening', speaking: 'Speaking', muted: 'Muted', thinking: 'Thinking…' };
function setMicState(state) {
  $('micBtn').dataset.state = state;
  $('micLabel').textContent = MIC_LABELS[state] ?? 'Talk';
}

function instructions() {
  const b = S.bank;
  return `You are Stride, an upbeat running coach and money buddy speaking in the runner's earbuds.
- The runner is often mid-run and short of breath. Reply in one or two short spoken sentences. No lists, no markdown.
- Use the tools for every fact about routes, the run, or money. Never invent distances, balances, or prices.
- When you present route options, give each as: letter, place, distance, rough price, and whether it fits the budget. Then ask which one.
- Prices are estimates, so say "about".
- The runner automatically earns ${money(b?.rules.perMile ?? 1)} per mile into their "${b?.goal.name ?? 'savings'}" goal. Celebrate milestones briefly.
- Confirm before moving more than $25.
- Turn-by-turn cues are spoken automatically; you don't need to repeat them unless asked.`;
}

async function connectGrok() {
  grok = new GrokVoice({
    voice: S.config.voice,
    instructions: instructions(),
    tools: TOOL_DEFS,
    handleTool: runTool,
    onState: (state) => {
      setMicState(state);
      if (state === 'off') grok = null;
    },
    onUserText: (text) => bubble('user', text),
    onAssistantText: (text) => bubble('bot', text),
    onError: toast,
  });
  try {
    await grok.start();
  } catch (err) {
    grok?.stop();
    grok = null;
    S.config.grokVoice = false;
    setMicState('off');
    toast(`Grok voice unavailable (${err.message}). Using browser voice.`);
  }
}

const browserVoice = new BrowserVoice({
  handleCommand,
  onState: setMicState,
  onUserText: (text) => bubble('user', text),
  onAssistantText: (text) => bubble('bot', text),
});

$('micBtn').addEventListener('click', async () => {
  if (S.config.grokVoice) {
    if (!grok) return connectGrok();
    if (grok.state === 'connecting') return;
    grok.setListening(!grok.listening);
    return;
  }
  browserVoice.listenOnce();
});

$('askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('askInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  bubble('user', text);
  if (grok?.connected) {
    grok.sendText(text);
    return;
  }
  const reply = await handleCommand(text);
  if (reply) browserVoice.say(reply);
});

// ---------- boot ----------
async function boot() {
  renderPlan();
  setStart(DEFAULT_START, 'default');
  watchLocation();
  show('plan');
  try {
    const [config, bank] = await Promise.all([api.config(), api.bank()]);
    S.config = config;
    setBank(bank);
    $('voiceMode').textContent = config.grokVoice ? 'Grok voice' : 'Browser voice';
    if (!config.grokVoice && config.voiceStatus) $('voiceMode').title = config.voiceStatus;
  } catch (err) {
    toast(`Can't reach the Stride server: ${err.message}`);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot();
