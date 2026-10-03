// Plans running routes of a target distance that finish at a real place (coffee, groceries, ...).
// Places come from OpenStreetMap via Photon (with Overpass as backup), walking routes from OSRM's foot profile.
// If either service is unreachable, a synthetic route is generated so the demo never dead-ends.

const UA = 'Stride/1.0 (hackathon running app)';
const PHOTON_URL = process.env.PHOTON_URL || 'https://photon.komoot.io';
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const OSRM_URL = process.env.OSRM_URL || 'https://routing.openstreetmap.de/routed-foot';
const METERS_PER_MILE = 1609.34;
// Street routes run longer than straight lines; used to seed the first routing attempt.
const NETWORK_FACTOR = 1.25;

export const CATEGORIES = {
  coffee: {
    label: 'Coffee',
    basePrice: 5,
    photon: ['amenity:cafe'],
    query: ['nwr["amenity"="cafe"]'],
  },
  smoothie: {
    label: 'Smoothie & juice',
    basePrice: 8,
    // OSM rarely tags juice bars precisely, so search cafés/takeaways and keep juice-sounding names.
    photon: ['amenity:cafe', 'amenity:fast_food', 'amenity:juice_bar', 'shop:beverages'],
    nameFilter: /juice|smoothie|jamba|acai|açaí|bowl|pressed|squeeze|blend|boba|bubble|tea|kombucha/i,
    query: [
      'nwr["shop"="beverages"]',
      'nwr["amenity"~"cafe|fast_food"]["cuisine"~"juice|smoothie|bubble_tea",i]',
      'nwr["amenity"~"cafe|fast_food"]["name"~"juice|smoothie|jamba|acai|bowl",i]',
    ],
  },
  grocery: {
    label: 'Grocery',
    basePrice: 5,
    photon: ['shop:supermarket', 'shop:greengrocer', 'shop:convenience'],
    query: ['nwr["shop"~"^(supermarket|convenience|greengrocer)$"]'],
  },
  atm: {
    label: 'ATM & bank',
    basePrice: 0,
    photon: ['amenity:atm', 'amenity:bank'],
    query: ['nwr["amenity"~"^(atm|bank)$"]'],
  },
  treat: {
    label: 'Treat',
    basePrice: 6,
    photon: ['amenity:ice_cream', 'shop:bakery', 'shop:pastry'],
    query: ['nwr["amenity"="ice_cream"]', 'nwr["shop"~"^(bakery|pastry|confectionery)$"]'],
  },
};

// Rough single-item prices by chain. OSM has no menu prices, so everything is an estimate.
const BRAND_PRICES = [
  [/starbucks/i, 5.75], [/dunkin/i, 3.5], [/blue bottle/i, 6], [/peet/i, 5.25], [/tatte/i, 6.5],
  [/pret/i, 4.5], [/tim hortons/i, 3], [/caribou/i, 5], [/la colombe/i, 5.5], [/philz/i, 6],
  [/juice press|pressed/i, 9.5], [/jamba/i, 7], [/smoothie king/i, 7.5], [/playa bowls/i, 11],
  [/trader joe/i, 4], [/whole foods/i, 6], [/7-eleven|7 eleven/i, 2.5], [/cvs|walgreens/i, 3],
  [/star market|stop & shop|shaw/i, 4], [/ben & jerry|j\.p\. licks|jp licks/i, 6.5],
];

// ---------- geo helpers ----------
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
const R = 6371000;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearing(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function offset(p, bearingDeg, meters) {
  const d = meters / R;
  const b = toRad(bearingDeg);
  const lat1 = toRad(p.lat);
  const lng1 = toRad(p.lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 = lng1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: toDeg(lat2), lng: toDeg(lng2) };
}

const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// A point that makes start → point → end roughly `pathLength` meters as the crow flies
// (a point on the ellipse with foci at start and end).
function detourPoint(start, end, pathLength, side) {
  const d = haversine(start, end);
  const mid = { lat: (start.lat + end.lat) / 2, lng: (start.lng + end.lng) / 2 };
  const a = pathLength / 2;
  const c = d / 2;
  const h = Math.sqrt(Math.max(a * a - c * c, 0));
  const base = d < 1 ? 0 : bearing(start, end);
  return offset(d < 1 ? start : mid, base + 90 * side, d < 1 ? a : h);
}

// ---------- external services ----------
async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const res = await fetch(url, {
    ...options,
    headers: { 'User-Agent': UA, ...options.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json();
}

async function findPlaces(center, radius, categoryKey) {
  try {
    const places = await findPlacesPhoton(center, radius, categoryKey);
    if (places.length) return places;
  } catch (err) {
    console.warn('[planner] Photon failed, trying Overpass:', err.message);
  }
  return findPlacesOverpass(center, radius, categoryKey);
}

const NOT_A_RUN_STOP = /wine|liquor|spirits|beer|package store|\bpub\b|tavern/i;

const keysFor = (categoryKey) => (categoryKey === 'any' ? ['coffee', 'smoothie', 'treat'] : [categoryKey]);

function dedupe(places) {
  const seen = new Set();
  return places.filter((p) => {
    const key = `${p.name}|${p.lat.toFixed(3)}|${p.lng.toFixed(3)}`;
    if (!p.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Photon's reverse endpoint returns the nearest features carrying an OSM tag.
async function findPlacesPhoton(center, radius, categoryKey) {
  const requests = keysFor(categoryKey).flatMap((key) =>
    CATEGORIES[key].photon.map(async (tag) => {
      const url = `${PHOTON_URL}/reverse?lat=${center.lat}&lon=${center.lng}&radius=${(radius / 1000).toFixed(2)}&osm_tag=${tag}&limit=50`;
      const data = await fetchJson(url, {}, 8000);
      return data.features.map((f) => {
        const pr = f.properties;
        const [lng, lat] = f.geometry.coordinates;
        const name = pr.name || pr.brand;
        if (!name || (CATEGORIES[key].nameFilter && !CATEGORIES[key].nameFilter.test(name))) return null;
        return { id: `${pr.osm_type}/${pr.osm_id}`, name, lat, lng, category: key, ...estimatePrice(name, key, pr.osm_id) };
      }).filter(Boolean);
    }),
  );
  const settled = await Promise.allSettled(requests);
  const ok = settled.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw settled[0].reason;
  return dedupe(ok.flatMap((r) => r.value)).filter((p) => !NOT_A_RUN_STOP.test(p.name));
}

async function findPlacesOverpass(center, radius, categoryKey) {
  const clauses = keysFor(categoryKey)
    .flatMap((k) => CATEGORIES[k].query.map((q) => `${q}(around:${Math.round(radius)},${center.lat},${center.lng});`))
    .join('');
  const query = `[out:json][timeout:15];(${clauses});out center tags 150;`;
  const data = await fetchJson(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  }, 18000);

  return dedupe(data.elements
    .map((el) => {
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      const name = el.tags?.name || el.tags?.brand;
      if (lat == null || !name) return null;
      const category = categoryKey === 'any' ? classify(el.tags) : categoryKey;
      return { id: `${el.type}/${el.id}`, name, lat, lng, category, ...estimatePrice(name, category, el.id) };
    })
    .filter(Boolean));
}

function classify(tags = {}) {
  if (tags.amenity === 'ice_cream' || /bakery|pastry|confectionery/.test(tags.shop || '')) return 'treat';
  if (tags.shop === 'beverages' || /juice|smoothie|bubble_tea/i.test(tags.cuisine || '')) return 'smoothie';
  return 'coffee';
}

function estimatePrice(name, category, seed) {
  const brand = BRAND_PRICES.find(([re]) => re.test(name));
  if (brand) return { price: brand[1], priceSource: 'chain average' };
  const base = CATEGORIES[category]?.basePrice ?? 5;
  if (base === 0) return { price: 0, priceSource: 'free' };
  const jitter = ((Number(seed) % 7) - 3) * 0.5; // deterministic per place
  return { price: Math.max(2, base + jitter), priceSource: 'estimate' };
}

async function osrmRoute(points) {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `${OSRM_URL}/route/v1/foot/${coords}?overview=full&geometries=geojson&steps=true`;
  const data = await fetchJson(url);
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error(`Routing failed: ${data.code}`);
  const route = data.routes[0];
  const legs = route.legs;
  const steps = [];
  legs.forEach((leg, li) => {
    leg.steps.forEach((s) => {
      const t = s.maneuver.type;
      // Hide the seam at our invisible detour waypoint.
      if ((t === 'arrive' && li < legs.length - 1) || (t === 'depart' && li > 0)) return;
      steps.push({
        type: t,
        modifier: s.maneuver.modifier || null,
        name: s.name || '',
        lat: s.maneuver.location[1],
        lng: s.maneuver.location[0],
        bearingAfter: s.maneuver.bearing_after,
      });
    });
  });
  return {
    distance: route.distance,
    geometry: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    steps,
  };
}

// Route start → (detour) → place, nudging the detour until length is close to target.
async function routeOfLength(start, place, target, side) {
  const direct = haversine(start, place);
  let pathLength = target / NETWORK_FACTOR;
  let best = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const useDetour = pathLength > direct * 1.08;
    const pts = useDetour ? [start, detourPoint(start, place, pathLength, side), place] : [start, place];
    const r = await osrmRoute(pts);
    if (!best || Math.abs(r.distance - target) < Math.abs(best.distance - target)) best = r;
    if (Math.abs(r.distance - target) / target < 0.07) break;
    if (!useDetour && r.distance > target) break; // already the shortest way there
    pathLength *= target / r.distance;
  }
  return best;
}

// ---------- turn-by-turn text ----------
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

export function instructionFor(step, placeName) {
  const onto = step.name ? ` onto ${step.name}` : '';
  const mod = step.modifier || 'straight';
  const turnWord = mod.includes('slight') ? `bear ${mod.replace('slight ', '')}` : mod === 'uturn' ? 'make a U-turn' : mod === 'straight' ? 'continue straight' : `turn ${mod.replace('sharp ', '')}`;
  switch (step.type) {
    case 'depart':
      return `Head ${COMPASS[Math.round((step.bearingAfter ?? 0) / 45) % 8]}${step.name ? ` on ${step.name}` : ''}`;
    case 'arrive':
      return `Arrive at ${placeName}`;
    case 'roundabout':
    case 'rotary':
      return `Take the roundabout${onto}`;
    case 'fork':
      return `At the fork, keep ${mod.replace('slight ', '')}${onto}`;
    case 'end of road':
      return `At the end of the road, ${turnWord}${onto}`;
    case 'new name':
    case 'continue':
      return mod === 'straight' ? `Continue${onto}` : `${cap(turnWord)}${onto}`;
    default:
      return `${cap(turnWord)}${onto}`;
  }
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// Drop "continue straight" noise so runners only hear turns that matter.
function meaningfulSteps(steps, placeName) {
  return steps
    .filter((s, i) => i === 0 || s.type === 'arrive' || !(s.type === 'new name' || ((s.type === 'continue' || s.type === 'turn') && (s.modifier === 'straight' || !s.modifier))))
    .map((s) => ({ ...s, text: instructionFor(s, placeName) }));
}

// ---------- synthetic fallback ----------
const SYNTH_NAMES = {
  coffee: ['Corner Café', 'Daily Grind', 'Bean There'],
  smoothie: ['Green Machine Juice', 'Blend Bar', 'Squeeze'],
  grocery: ['Neighborhood Market', 'Fresh Stop', 'Corner Grocer'],
  atm: ['Main St ATM', 'Plaza ATM', 'Station ATM'],
  treat: ['Sweet Spot Bakery', 'Scoops', 'Crumb'],
};

function syntheticOptions(start, target, categoryKey) {
  const cat = categoryKey === 'any' ? 'coffee' : categoryKey;
  return [0, 1, 2].map((i) => {
    // A rectangle-ish loop with sides h, w, h, w/2, ending part-way back toward start.
    const heading = i * 120 + 20;
    const side = target / 3.5;
    const legs = [
      [heading, side], [heading + 90, side * 0.75], [heading + 180, side], [heading + 270, side * 0.75],
    ];
    const pts = [start];
    const corners = [];
    let p = start;
    for (const [b, len] of legs) {
      for (let k = 1; k <= 6; k++) pts.push(offset(p, b, (len * k) / 6));
      p = offset(p, b, len);
      corners.push({ ...p, bearing: b });
    }
    const placeName = SYNTH_NAMES[cat][i];
    const steps = [
      { type: 'depart', lat: start.lat, lng: start.lng, bearingAfter: heading, name: '' },
      ...corners.slice(0, 3).map((c) => ({ type: 'turn', modifier: 'right', lat: c.lat, lng: c.lng, name: '' })),
      { type: 'arrive', lat: p.lat, lng: p.lng },
    ].map((s) => ({ ...s, text: instructionFor(s, placeName) }));
    return {
      place: { id: `synthetic/${i}`, name: placeName, lat: p.lat, lng: p.lng, category: cat, ...estimatePrice(placeName, cat, i * 3 + 2) },
      distance: side * 3.5,
      geometry: pts.map((q) => [q.lat, q.lng]),
      steps,
      synthetic: true,
    };
  });
}

// ---------- main entry ----------
function pickDiverse(places, start, count, budget) {
  const scored = places
    .map((p) => ({ ...p, bearing: bearing(start, p), withinBudget: budget == null || p.price <= budget }))
    .sort((a, b) => Number(b.withinBudget) - Number(a.withinBudget) || a.straight - b.straight);
  const chosen = [];
  for (const minGap of [70, 40, 0]) {
    for (const p of scored) {
      if (chosen.length >= count) break;
      if (chosen.includes(p)) continue;
      const fresh = minGap === 0 || chosen.every((c) => c.name !== p.name);
      if (fresh && chosen.every((c) => angleDiff(c.bearing, p.bearing) >= minGap)) chosen.push(p);
    }
  }
  return chosen;
}

export async function planRoutes({ lat, lng, miles = 3.1, category = 'coffee', budget } = {}) {
  const start = { lat: Number(lat), lng: Number(lng) };
  if (!Number.isFinite(start.lat) || !Number.isFinite(start.lng)) {
    const err = new Error('A start location (lat, lng) is required');
    err.status = 400;
    throw err;
  }
  if (category !== 'any' && !CATEGORIES[category]) category = 'coffee';
  const target = Math.min(Math.max(Number(miles) || 3.1, 0.5), 15) * METERS_PER_MILE;
  const budgetNum = budget === '' || budget == null || Number.isNaN(Number(budget)) ? null : Number(budget);

  let options = [];
  let notice = null;
  try {
    const radius = Math.min(Math.max(target * 0.6, 500), 7000);
    const places = (await findPlaces(start, radius, category))
      .map((p) => ({ ...p, straight: haversine(start, p) }))
      // Reachable without overshooting the target distance, and not right on top of the start.
      .filter((p) => p.straight > 120 && p.straight * NETWORK_FACTOR < target * 1.1);
    const picks = pickDiverse(places, start, 3, budgetNum);
    if (!picks.length) throw new Error(`No ${CATEGORIES[category]?.label ?? 'places'} found within range`);

    const results = await Promise.allSettled(picks.map((p, i) => routeOfLength(start, p, target, i % 2 ? -1 : 1)));
    options = results
      .map((r, i) => {
        if (r.status !== 'fulfilled') return null;
        const { bearing: _b, straight: _s, withinBudget: _w, ...place } = picks[i];
        return { place, distance: r.value.distance, geometry: r.value.geometry, steps: meaningfulSteps(r.value.steps, place.name), synthetic: false };
      })
      .filter(Boolean);
    if (!options.length) throw new Error(results.find((r) => r.status === 'rejected')?.reason?.message || 'Routing failed');
  } catch (err) {
    console.warn('[planner] falling back to synthetic routes:', err.message);
    notice = `Live map data unavailable (${err.message}). Showing practice routes.`;
    options = syntheticOptions(start, target, category);
  }

  return {
    start,
    targetMiles: target / METERS_PER_MILE,
    budget: budgetNum,
    notice,
    options: options.map((o, i) => ({
      id: 'ABC'[i],
      ...o,
      miles: Math.round((o.distance / METERS_PER_MILE) * 100) / 100,
      withinBudget: budgetNum == null || o.place.price <= budgetNum,
    })),
  };
}
