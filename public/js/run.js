import { cumulative, pointAt, project, nearestIndex, spokenDistance, haversine, METERS_PER_MILE } from './geo.js';

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// GPS tuning. Phone fixes wander, especially near tall buildings.
const MAX_ACCURACY = 50; // m — fuzzier fixes move the dot but don't add distance
const MAX_SPEED = 9; // m/s (~3 min/mile) — faster jumps are GPS glitches
const MIN_STEP = 4; // m — smaller moves are treated as standing still
const SMOOTH_WINDOW = 3; // average the last few fixes so jitter doesn't add phantom distance

// Tracks one run, either from GPS or a sped-up simulation.
// Distance is what the runner actually covered (like Strava); the planned route
// is used only for turn-by-turn cues and to know when they've arrived.
export class RunSession {
  constructor(route, callbacks, { mode = 'sim', simSpeed = 10, simPace = 570 } = {}) {
    this.route = route;
    this.line = route.geometry;
    this.cum = cumulative(this.line);
    this.total = this.cum[this.cum.length - 1];
    this.destination = { lat: route.place.lat, lng: route.place.lng };
    this.cb = callbacks;
    this.mode = mode;
    this.simSpeed = simSpeed;
    this.simPace = simPace; // seconds per mile while simulating

    let idx = 0;
    this.steps = route.steps.map((s) => {
      idx = nearestIndex(this.line, [s.lat, s.lng], idx);
      return { ...s, along: s.type === 'arrive' ? this.total : this.cum[idx], warned: false };
    });
    this.nextStep = 1; // step 0 is "depart", spoken when the run starts

    this.distance = 0; // meters actually covered
    this.progress = 0; // meters along the planned route (for navigation)
    this.elapsed = 0;
    this.mile = 0;
    this.paused = false;
    this.finished = false;
    this.arrived = false;
    this.gpsPos = null;
    this.gps = { status: 'waiting', accuracy: null };
    this.lastFix = null;
    this.recent = [];
    this.offRoute = false;
    this.warnedStart = false;
  }

  start() {
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), 250);
    if (this.mode === 'gps') this.startGps();
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.lastFix = null;
    this.recent = [];
    if (mode === 'gps') this.startGps();
    else this.stopGps();
  }

  setGps(status, accuracy = null) {
    this.gps = { status, accuracy };
    this.cb.onGps?.(this.gps);
  }

  startGps() {
    if (!navigator.geolocation) {
      this.setGps('unsupported');
      return;
    }
    this.setGps('waiting');
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.onPosition(p.coords),
      (err) => this.setGps(err.code === err.PERMISSION_DENIED ? 'denied' : 'error'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  }

  stopGps() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  onPosition({ latitude, longitude, accuracy }) {
    if (this.mode !== 'gps' || this.finished) return;
    const pos = { lat: latitude, lng: longitude };
    const now = performance.now();
    this.gpsPos = [latitude, longitude];
    this.setGps(accuracy <= MAX_ACCURACY ? 'good' : 'weak', Math.round(accuracy));
    if (accuracy > MAX_ACCURACY) return;

    // 1. Real distance covered, measured between smoothed positions and ignoring glitch jumps.
    if (this.lastFix && haversine(this.lastFix.pos, pos) / Math.max((now - this.lastFix.t) / 1000, 0.001) > MAX_SPEED * 2) return;
    this.recent.push(pos);
    if (this.recent.length > SMOOTH_WINDOW) this.recent.shift();
    const smooth = {
      lat: this.recent.reduce((s, p) => s + p.lat, 0) / this.recent.length,
      lng: this.recent.reduce((s, p) => s + p.lng, 0) / this.recent.length,
    };
    if (!this.lastFix) {
      this.lastFix = { pos: smooth, t: now };
    } else if (!this.paused) {
      const step = haversine(this.lastFix.pos, smooth);
      const dt = (now - this.lastFix.t) / 1000;
      // A too-fast jump is a glitch: skip it and keep measuring from the last good fix.
      if (step >= Math.max(MIN_STEP, accuracy * 0.25) && dt > 0 && step / dt <= MAX_SPEED) {
        this.distance += step;
        this.lastFix = { pos: smooth, t: now };
      }
    }

    // 2. Where we are along the planned route, for turn cues.
    const tolerance = Math.max(40, accuracy + 25);
    let snap = project(this.line, this.cum, pos, this.progress - 50, this.progress + 600);
    if (snap.offRoute > tolerance) {
      // Maybe they took a shortcut or rejoined further along.
      const anywhere = project(this.line, this.cum, pos, Math.max(0, this.progress - 50));
      if (anywhere.offRoute < snap.offRoute) snap = anywhere;
    }
    if (snap.offRoute <= tolerance) {
      this.offRoute = false;
      if (snap.along > this.progress) this.progress = snap.along;
    } else if (!this.offRoute) {
      this.offRoute = true;
      const fromStart = haversine(pos, { lat: this.line[0][0], lng: this.line[0][1] });
      if (this.progress < 50 && fromStart > 150 && !this.warnedStart) {
        this.warnedStart = true;
        this.cb.onCue?.(`This route starts ${spokenDistance(fromStart)} away. Head to the start, or plan a new route from here.`);
      } else {
        this.cb.onCue?.("You're off route. Head back toward the highlighted line.");
      }
    }

    // 3. Arrived when close to the destination itself.
    if (haversine(pos, this.destination) <= Math.max(30, accuracy)) this.arrived = true;
  }

  tick() {
    const now = performance.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    if (this.paused || this.finished) return;
    if (this.mode === 'sim') {
      const simDt = dt * this.simSpeed;
      const moved = Math.min(this.total - this.progress, (simDt / this.simPace) * METERS_PER_MILE);
      this.elapsed += simDt;
      this.progress += moved;
      this.distance += moved;
    } else {
      this.elapsed += dt;
    }
    this.update();
  }

  // Real-world meters per second at which the runner moves across the map.
  get screenSpeed() {
    return this.mode === 'sim' ? (METERS_PER_MILE / this.simPace) * this.simSpeed : 3;
  }

  update() {
    // Warn ~8 seconds ahead of each maneuver, then mark it done as we pass it.
    const warnAt = Math.min(Math.max(this.screenSpeed * 8, 40), 250);
    while (this.nextStep < this.steps.length) {
      const step = this.steps[this.nextStep];
      const ahead = step.along - this.progress;
      if (ahead <= 12) {
        if (!step.warned && step.type !== 'arrive') this.cb.onCue?.(step.text);
        this.nextStep++;
        continue;
      }
      if (!step.warned && ahead <= warnAt && step.type !== 'arrive') {
        step.warned = true;
        this.cb.onCue?.(`In ${spokenDistance(ahead)}, ${lowerFirst(step.text)}`);
      }
      break;
    }

    const mile = Math.floor(this.distance / METERS_PER_MILE);
    if (mile > this.mile) {
      this.mile = mile;
      this.cb.onMile?.(mile, this.stats());
    }

    const stats = this.stats();
    this.cb.onTick?.(stats);

    if (this.arrived || this.progress >= this.total - 10) {
      this.finish();
      this.cb.onArrive?.(stats);
    }
  }

  stats() {
    const miles = this.distance / METERS_PER_MILE;
    const next = this.steps[this.nextStep];
    let i = 1;
    while (i < this.cum.length && this.cum[i] < this.progress) i++;
    const here = pointAt(this.line, this.cum, this.progress);
    return {
      miles,
      totalMiles: this.total / METERS_PER_MILE,
      remainingMiles: Math.max(0, this.total - this.progress) / METERS_PER_MILE,
      fraction: this.total ? this.progress / this.total : 0,
      elapsed: this.elapsed,
      pace: miles > 0.02 ? this.elapsed / miles : NaN,
      position: this.mode === 'gps' && this.gpsPos ? this.gpsPos : here,
      done: [...this.line.slice(0, i), here],
      next: next ? { ...next, ahead: Math.max(0, next.along - this.progress) } : null,
      gps: this.mode === 'gps' ? this.gps : null,
    };
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.last = performance.now();
    this.lastFix = null; // don't count the gap while paused
    this.recent = [];
  }

  finish() {
    this.finished = true;
    clearInterval(this.timer);
    this.stopGps();
  }
}
