// "Back Me" challenge screens: list, create, detail + pledge form.
import { api } from './api.js';
import { money, formatClock } from './geo.js';

const $ = (id) => document.getElementById(id);

// "27:00" → 1620, "3:45:00" → 13500, "" → null; anything else throws.
export function parseClock(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const parts = t.split(':').map((x) => x.trim());
  if (parts.length > 3 || parts.some((x) => !/^\d+$/.test(x))) throw new Error('Use a time like 27:00 or 3:45:00');
  const nums = parts.map(Number);
  const seconds = nums.length === 3 ? nums[0] * 3600 + nums[1] * 60 + nums[2] : nums.length === 2 ? nums[0] * 60 + nums[1] : nums[0] * 60;
  if (!(seconds > 0)) throw new Error('Use a time like 27:00 or 3:45:00');
  return seconds;
}

function timeLeft(endsAt) {
  const ms = new Date(endsAt) - Date.now();
  if (ms <= 0) return 'ending now';
  const h = Math.round(ms / 3600000);
  if (h < 1) return 'less than an hour left';
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} left`;
  return `${Math.round(h / 24)} days left`;
}

function goalText(c) {
  const dist = `${c.miles} mi`;
  if (c.kind === 'total') return `${dist} total by ${new Date(c.endsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  return `${dist} in one run${c.targetSeconds ? ` under ${formatClock(c.targetSeconds)}` : ''}`;
}

const STATUS = { open: 'Open', completed: 'Completed ✓', missed: 'Missed', cancelled: 'Cancelled' };
const pill = (c) => `<span class="pill ${c.status}">${c.status === 'open' ? timeLeft(c.endsAt) : STATUS[c.status]}</span>`;

function pledgeText(b) {
  return [b.flat && `${money(b.flat)} if they finish`, b.perMile && `${money(b.perMile)}/mile (up to ${money(b.cap)})`, b.predictedSeconds && `guesses ${formatClock(b.predictedSeconds)}`]
    .filter(Boolean)
    .join(' · ');
}

export function initChallenges(ctx) {
  // ctx: { show, toast, setBusy, cue, planFor(miles), back() }
  let current = null;
  let listCache = { own: [], backing: [] };

  // ---------- list ----------
  function card(c, own) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'ch-card';
    el.innerHTML = `
      <span class="ch-card-top"><span class="ch-card-title"></span>${pill(c)}</span>
      <span class="ch-card-meta"></span>`;
    el.querySelector('.ch-card-title').textContent = c.title;
    el.querySelector('.ch-card-meta').textContent = own
      ? `${goalText(c)} · ${c.totals.backers} backer${c.totals.backers === 1 ? '' : 's'} · ${money(c.status === 'open' ? c.totals.ifSuccess : c.totals.paid)}`
      : `${c.runner.name}: ${goalText(c)}${c.myPledge ? ` · you: ${pledgeText(c.myPledge)}` : ''}`;
    el.addEventListener('click', () => open(c.code));
    return el;
  }

  function fill(listEl, items, own, empty) {
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'ch-empty';
      p.textContent = empty;
      listEl.replaceChildren(p);
    } else {
      listEl.replaceChildren(...items.map((c) => card(c, own)));
    }
  }

  async function refresh() {
    try {
      listCache = await api.challenges();
    } catch {
      return listCache;
    }
    fill($('myChallenges'), listCache.own, true, 'No challenges yet. Create one and share it.');
    fill($('backingChallenges'), listCache.backing, false, "When someone shares a challenge with you, it'll show up here.");
    const open = listCache.own.filter((c) => c.status === 'open');
    $('challengesHint').textContent = open.length
      ? `${open.length} open · ${money(open.reduce((s, c) => s + c.totals.ifSuccess, 0))} pledged`
      : 'Get friends to back your runs';
    return listCache;
  }

  async function showList() {
    ctx.show('challenges');
    await refresh();
  }

  // ---------- create ----------
  let kind = 'run';
  function renderKind() {
    document.querySelectorAll('#kindToggle button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.kind === kind));
    $('targetField').hidden = kind !== 'run';
    $('kindHint').textContent =
      kind === 'run' ? 'A race or one big run. Flat pledges pay if a single run covers the distance (and beats the time goal).' : 'Add up every run until the deadline. Flat pledges pay when the total reaches the goal.';
  }

  function showCreate() {
    const f = $('challengeForm');
    f.reset();
    const week = new Date(Date.now() + 7 * 86400000);
    f.ends.value = `${week.getFullYear()}-${String(week.getMonth() + 1).padStart(2, '0')}-${String(week.getDate()).padStart(2, '0')}`;
    f.ends.min = new Date().toISOString().slice(0, 10);
    kind = 'run';
    renderKind();
    $('challengeError').hidden = true;
    ctx.show('challenge-new');
  }

  $('kindToggle').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    kind = b.dataset.kind;
    renderKind();
  });
  $('challengeDistanceChips').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) $('challengeForm').miles.value = b.dataset.miles;
  });
  $('challengeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = $('challengeSubmit');
    $('challengeError').hidden = true;
    setBusyOn(btn, 'Creating…');
    try {
      if (!f.ends.value) throw new Error('Pick a deadline');
      const created = await api.createChallenge({
        title: f.title.value,
        kind,
        miles: Number(f.miles.value),
        targetSeconds: kind === 'run' ? parseClock(f.target.value) : null,
        endsAt: new Date(`${f.ends.value}T23:59:59`).toISOString(),
        message: f.message.value,
      });
      await refresh();
      render(created);
      ctx.show('challenge');
      share(created);
    } catch (err) {
      $('challengeError').textContent = err.message;
      $('challengeError').hidden = false;
    } finally {
      ctx.setBusy(btn, false);
    }
  });

  function setBusyOn(btn, label) {
    ctx.setBusy(btn, true, label);
  }

  // ---------- detail ----------
  async function open(code) {
    try {
      render(await api.challenge(code));
      ctx.show('challenge');
    } catch (err) {
      ctx.toast(err.message);
    }
  }

  function render(c) {
    current = c;
    $('chTitle').textContent = c.title;
    $('chMeta').textContent = `${c.isOwner ? 'Your challenge' : `${c.runner.name}'s challenge`} · ${goalText(c)}`;
    $('chStatus').innerHTML = pill(c);
    const open = c.status === 'open';
    $('chPledged').textContent = money(open ? c.totals.ifSuccess : c.totals.paid);
    $('chPledgedLabel').textContent = open ? 'if they finish' : 'paid';
    $('chBackers').textContent = c.totals.backers;
    $('chPredict').textContent = c.predictions.medianSeconds ? formatClock(c.predictions.medianSeconds) : '–';
    const pct = Math.min(100, ((c.progressMiles || 0) / c.miles) * 100);
    $('chProgress').style.width = `${pct}%`;
    $('chProgressText').textContent =
      c.kind === 'total' ? `${(c.progressMiles || 0).toFixed(1)} of ${c.miles} mi so far` : c.progressMiles ? `Longest run so far: ${c.progressMiles.toFixed(2)} mi` : 'No runs yet';
    $('chMessage').hidden = !c.message;
    $('chMessage').textContent = c.message ? `“${c.message}”` : '';

    const outcome = $('chOutcome');
    outcome.hidden = open;
    outcome.className = `ch-outcome${c.status === 'missed' ? ' missed' : ''}`;
    if (!open) {
      const result = c.result?.seconds && c.kind === 'run' ? `${c.result.miles.toFixed(2)} mi in ${formatClock(c.result.seconds)}` : `${(c.result?.miles || 0).toFixed(1)} mi`;
      const closest = c.predictions.closest ? ` Closest guess: ${c.predictions.closest.name} (${formatClock(c.predictions.closest.seconds)}).` : '';
      outcome.textContent =
        c.status === 'completed'
          ? `Finished: ${result}. ${money(c.totals.paid)} from backers moved to savings.${closest}`
          : c.status === 'missed'
            ? `Ended at ${result}. ${c.totals.paid ? `${money(c.totals.paid)} in per-mile pledges was paid; ` : ''}flat pledges were released.`
            : 'This challenge was cancelled. Nobody was charged.';
    }

    $('chOwnerActions').hidden = !c.isOwner || !open;
    $('chCancel').textContent = 'Cancel challenge';
    delete $('chCancel').dataset.armed;

    const form = $('pledgeForm');
    form.hidden = c.isOwner || !open;
    if (!form.hidden) {
      $('pledgeTitle').textContent = c.myPledge ? `Your pledge for ${c.runner.name}` : `Back ${c.runner.name}`;
      form.flat.value = c.myPledge?.flat || '';
      form.perMile.value = c.myPledge?.perMile || '';
      form.predict.value = c.myPledge?.predictedSeconds ? formatClock(c.myPledge.predictedSeconds) : '';
      form.message.value = c.myPledge?.message || '';
      $('predictField').hidden = c.kind !== 'run';
      $('pledgeSubmit').textContent = c.myPledge ? 'Update pledge' : 'Back this run';
      $('pledgeWithdraw').hidden = !c.myPledge;
      $('pledgeError').hidden = true;
      updateFine();
    }

    $('backerList').replaceChildren(
      ...(c.backers.length
        ? c.backers.map((b) => {
            const li = document.createElement('li');
            li.innerHTML = `<span class="backer-top"><span class="backer-name"></span><span class="backer-what"></span></span><span class="backer-what" data-line></span><span class="backer-msg"></span>`;
            li.querySelector('.backer-name').textContent = b.mine ? `${b.name} (you)` : b.name;
            li.querySelector('.backer-top .backer-what').textContent = b.status === 'paid' ? `paid ${money(b.paid)}` : b.status === 'released' ? 'released' : b.status === 'short' ? 'not enough funds' : '';
            li.querySelector('[data-line]').textContent = pledgeText(b);
            li.querySelector('.backer-msg').textContent = b.message ? `“${b.message}”` : '';
            return li;
          })
        : [Object.assign(document.createElement('li'), { className: 'ch-empty', textContent: c.isOwner ? 'No backers yet. Share the link!' : 'Be the first to back this run.' })]),
    );
  }

  function updateFine() {
    if (!current) return;
    const f = $('pledgeForm');
    const flat = Number(f.flat.value) || 0;
    const perMile = Number(f.perMile.value) || 0;
    const cap = perMile * current.miles;
    $('pledgeFine').textContent =
      flat || perMile
        ? `You're charged ${flat ? `${money(flat)} only if ${current.runner.name} finishes` : ''}${flat && perMile ? ', plus ' : ''}${perMile ? `${money(perMile)} per mile they run (at most ${money(cap)})` : ''}. It goes into their savings goal.`
        : 'Pick an amount, or just predict their time.';
  }

  $('pledgeForm').addEventListener('input', updateFine);
  $('flatChips').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('pledgeForm').flat.value = b.dataset.v;
    updateFine();
  });
  $('pledgeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = $('pledgeSubmit');
    $('pledgeError').hidden = true;
    setBusyOn(btn, 'Saving…');
    try {
      const updated = await api.pledge(current.code, {
        flat: Number(f.flat.value) || 0,
        perMile: Number(f.perMile.value) || 0,
        predictedSeconds: current.kind === 'run' ? parseClock(f.predict.value) : null,
        message: f.message.value,
      });
      render(updated);
      refresh();
      ctx.toast(`You're backing ${updated.runner.name}! 🤝`);
    } catch (err) {
      $('pledgeError').textContent = err.message;
      $('pledgeError').hidden = false;
    } finally {
      ctx.setBusy(btn, false);
      if (current?.myPledge) btn.textContent = 'Update pledge';
    }
  });
  $('pledgeWithdraw').addEventListener('click', async () => {
    try {
      render(await api.unpledge(current.code));
      refresh();
      ctx.toast('Pledge withdrawn');
    } catch (err) {
      ctx.toast(err.message);
    }
  });

  async function share(c = current) {
    const url = `${location.origin}/c/${c.code}`;
    const text = `I'm going for “${c.title}”: ${goalText(c)}. Back me on Stride. Pledges go into my savings when I make it!`;
    try {
      if (navigator.share) await navigator.share({ title: c.title, text, url });
      else {
        await navigator.clipboard.writeText(`${text} ${url}`);
        ctx.toast('Link copied. Paste it to friends and family.');
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        ctx.toast(`Share this link: ${url}`);
      }
    }
  }

  $('chShare').addEventListener('click', () => share());
  $('chRun').addEventListener('click', () => ctx.planFor(current.kind === 'run' ? current.miles : Math.min(current.miles, 3.1)));
  $('chCancel').addEventListener('click', async () => {
    const btn = $('chCancel');
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'Tap again to cancel. Backers will be notified.';
      return;
    }
    try {
      await api.cancelChallenge(current.code);
      await refresh();
      ctx.show('challenges');
      ctx.toast('Challenge cancelled');
    } catch (err) {
      ctx.toast(err.message);
    }
  });

  $('challengesBtn').addEventListener('click', showList);
  $('challengesBack').addEventListener('click', () => ctx.back());
  $('newChallengeBtn').addEventListener('click', showCreate);
  $('newChallengeBack').addEventListener('click', showList);
  $('challengeBack').addEventListener('click', showList);

  return {
    open,
    refresh,
    // The runner's open challenges, for the spoken cue when a run starts.
    openOwn: () => listCache.own.filter((c) => c.status === 'open'),
    // Recap card after a run settles challenges.
    showResults(results) {
      const el = $('challengeResult');
      el.hidden = !results?.length;
      if (!results?.length) return '';
      el.replaceChildren(
        ...results.map((r) => {
          const p = document.createElement('p');
          p.innerHTML = '<b></b> <span></span>';
          p.querySelector('b').textContent = `🏁 ${r.title} complete!`;
          p.querySelector('span').textContent = r.paid ? `${money(r.paid)} from ${r.backers} backer${r.backers === 1 ? '' : 's'} moved to your savings.` : 'Nice work!';
          return p;
        }),
      );
      refresh();
      return results.map((r) => `You completed ${r.title}!${r.paid ? ` ${money(r.paid)} from your backers just moved to savings.` : ''}`).join(' ');
    },
  };
}
