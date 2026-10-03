export const METERS_PER_MILE = 1609.34;
const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const [lat1, lng1] = Array.isArray(a) ? a : [a.lat, a.lng];
  const [lat2, lng2] = Array.isArray(b) ? b : [b.lat, b.lng];
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Cumulative distance (m) at each vertex of a [[lat,lng],...] polyline.
export function cumulative(line) {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + haversine(line[i - 1], line[i]));
  return out;
}

// Point at `dist` meters along the polyline.
export function pointAt(line, cum, dist) {
  if (dist <= 0) return line[0];
  if (dist >= cum[cum.length - 1]) return line[line.length - 1];
  let i = 1;
  while (cum[i] < dist) i++;
  const t = (dist - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  const [a, b] = [line[i - 1], line[i]];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// Project a position onto the polyline, searching only between `fromDist` and `toDist`
// so a route that doubles back doesn't snap to the wrong side of the street.
export function project(line, cum, pos, fromDist = 0, toDist = Infinity) {
  const kx = Math.cos(toRad(pos.lat)) * 111320;
  const ky = 110540;
  let best = { along: fromDist, offRoute: Infinity };
  for (let i = 1; i < line.length; i++) {
    if (cum[i] < fromDist) continue;
    if (cum[i - 1] > toDist) break;
    const ax = line[i - 1][1] * kx, ay = line[i - 1][0] * ky;
    const bx = line[i][1] * kx, by = line[i][0] * ky;
    const px = pos.lng * kx, py = pos.lat * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best.offRoute) best = { along: cum[i - 1] + t * (cum[i] - cum[i - 1]), offRoute: d };
  }
  return best;
}

// Index of the polyline vertex nearest to `pt`, searching forward from `startIdx`.
export function nearestIndex(line, pt, startIdx = 0) {
  let best = startIdx;
  let bestD = Infinity;
  for (let i = startIdx; i < line.length; i++) {
    const d = haversine(line[i], pt);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export const toMiles = (m) => m / METERS_PER_MILE;

export function formatDistanceShort(meters) {
  const feet = meters * 3.28084;
  if (feet < 1000) return `${Math.max(50, Math.round(feet / 50) * 50)} ft`;
  return `${toMiles(meters).toFixed(1)} mi`;
}

export function spokenDistance(meters) {
  const feet = meters * 3.28084;
  if (feet < 1000) return `${Math.max(50, Math.round(feet / 50) * 50)} feet`;
  const mi = toMiles(meters);
  return mi < 0.3 ? 'a quarter mile' : `${mi.toFixed(1)} miles`;
}

export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function formatPace(secondsPerMile) {
  if (!Number.isFinite(secondsPerMile) || secondsPerMile <= 0 || secondsPerMile > 3600) return '--:--';
  return formatClock(secondsPerMile);
}

export const money = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
