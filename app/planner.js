// Kennel planner shared by the board and the reply page.
//
// The planner works in half-days. Slot 2n is the morning of day n, and slot 2n + 1 is its
// afternoon and the night after. A booking runs from its arrival slot up to its departure
// slot. With no times given, cats arrive in the afternoon and leave in the morning, so a
// kennel can turn round on the day one booking leaves and the next arrives.
//
// A booking needs `kennels` units. Each unit is a list of segments {k, from, to} covering
// the whole stay. A unit starts and ends in the same kennel. In between it can move to other
// kennels and back, always on a morning. Optimise only moves units with one cat.
//
// The planner only ever chooses kennels. It never changes a booking's dates, times, cats or
// number of kennels.
//
// Holding pens 16 to 23 are a last resort. When the planner places a cat itself, a stay in
// one lasts at most two nights, either for a whole short stay or while the cat is out of its
// kennel mid-stay. Closures block
// every kennel and holding pen, from the first closed night up to the day we reopen.

export const KENNELS = 15;
export const PAIRS = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12], [13, 14]];
export const HOLDING = [16, 17, 18, 19, 20, 21, 22, 23];
export const LANES = 23;
export const isHolding = k => k > KENNELS;
export const capacity = k => (k === 15 ? 3 : 2);
export const mateOf = k => (k < KENNELS ? (k % 2 ? k + 1 : k - 1) : 0);

const HOLD_NIGHTS = 2;
const CLOSED = -1;

export const dayNum = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5;
export const isoDay = n => new Date(n * 864e5).toISOString().slice(0, 10);
export const todayIso = () => {
  const d = new Date();
  return isoDay(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
};

// Times are '', 'am', 'pm' or 'HH:MM'. Only morning or afternoon matters for planning.

export const isAfternoon = time => time === 'pm' || (/^\d\d:\d\d$/.test(time ?? '') && time >= '12:00');
export const isMorning = time => time === 'am' || (/^\d\d:\d\d$/.test(time ?? '') && time < '12:00');
export const arriveSlot = b => 2 * dayNum(b.arrive) + (isMorning(b.arrive_time) ? 0 : 1);
export const departSlot = b => 2 * dayNum(b.depart) + (isAfternoon(b.depart_time) ? 1 : 0);

// Each unit's segments as slots. The first and last follow the booking's times; moves in
// between happen on a morning.

export function unitSlots(b, placement = b.placement) {
  const A = arriveSlot(b);
  const D = departSlot(b);
  return placement?.map(u => u.map((s, i) => ({
    k: s.k,
    a: i === 0 ? A : 2 * dayNum(s.from),
    d: i === u.length - 1 ? D : 2 * dayNum(s.to)
  })));
}

// Cover slots [x, y) for one unit, changing lanes only on mornings. A night in a holding pen
// costs more than any number of moves between main kennels, so holding pens only fill the
// nights no main kennel can. Each stay in holding pens lasts at most holdMax nights.
// Returns segments {k, a, d}, or null if the nights can't be covered.

const ROUTE_HOLD = 1000;

export function route(x, y, lanes, free, holdMax = HOLD_NIGHTS) {
  const days = (y - x) / 2;
  if (days <= 0) return [];
  let prev = null;
  for (let i = 0; i < days; i++) {
    const a = x + 2 * i;
    const cur = new Map();
    lanes.forEach((lane, j) => {
      if (!free(lane, a, a + 2)) return;
      const hold = isHolding(lane);
      const options = prev ? [...prev.values()] : [null];
      for (const st of options) {
        const run = hold ? (st && isHolding(lanes[st.j]) ? st.run + 1 : 1) : 0;
        if (run > holdMax) continue;
        const cost = (st ? st.cost : 0) + (hold ? ROUTE_HOLD : 0) + (st && st.j !== j ? 1 : 0);
        const key = `${j}:${run}`;
        if (!cur.has(key) || cur.get(key).cost > cost) cur.set(key, { j, run, cost, back: st });
      }
    });
    if (!cur.size) return null;
    prev = cur;
  }
  let best = null;
  for (const st of prev.values()) if (!best || st.cost < best.cost) best = st;
  const seq = [];
  for (let st = best; st; st = st.back) seq.unshift(lanes[st.j]);
  const segs = [];
  seq.forEach((lane, i) => {
    const a = x + 2 * i;
    if (segs.length && segs.at(-1).k === lane) segs.at(-1).d = a + 2;
    else segs.push({ k: lane, a, d: a + 2 });
  });
  return segs;
}

// Join neighbouring segments in the same lane

export function mergeSegs(u) {
  const out = [];
  for (const s of u) {
    if (out.length && out.at(-1).k === s.k) out.at(-1).d = s.d;
    else out.push({ ...s });
  }
  return out;
}

// Fitting a booking beats a night in a holding pen, a holding pen beats any other move, a
// move beats an unjoined pen, and an unjoined pen beats short gaps between bookings. Short
// gaps are hard to fill, so each night in one costs more than a night in a longer gap, and
// gaps of three weeks or more cost nothing. An owner's kennels sit side by side even when
// they aren't joined, and kennel 15 is kept for bookings that need its extra space.
// Costs are per night, so per-slot costs are halved.

const COST = { unplaced: 1e6, holding: 3000, move: 1000, unjoined: 15, apart: 2, big: 3, gap: 3, halfPair: 0.2 };

// Moving a booking that already has a kennel. When adding bookings this costs more than any
// preference but less than a mid-stay move, so others only move to make room.

const CHANGED = { insert: 500, optimise: 3 };
const gapCost = slots => {
  const g = slots / 2;
  return COST.gap * g * Math.max(0, 1 - g / 21);
};

const ALL = Array.from({ length: KENNELS }, (_, i) => i + 1);

// Kennel 15 can take 3 cats, so it can stand in for a joined pair

const allows15 = it => it.joined && it.kennels === 2 && it.cats <= 3;
const singleKennels = it => (it.cats > 2 ? [15] : ALL);

// Cats in unit i. Extra cats share kennels from the first unit on, so later units hold one.

const catsIn = (it, i) => (it.kennels === 1 ? it.cats : 1 + (i < it.cats - it.kennels ? 1 : 0));

class Grid {
  constructor(start, end, T) {
    this.T = T;
    this.s = start;
    this.e = end;
    this.c = Array.from({ length: LANES + 1 }, () => new Int32Array(end - start));
  }

  at(k, t) {
    return this.c[k][t - this.s];
  }

  free(k, a, d) {
    const c = this.c[k];
    for (let i = a - this.s, e = d - this.s; i < e; i++) if (c[i]) return false;
    return true;
  }

  set(k, a, d, v) {
    this.c[k].fill(v, a - this.s, d - this.s);
  }
}

// Placement conversion

const toIso = units => units?.map(u => u.map(s => ({ k: s.k, from: isoDay(Math.floor(s.a / 2)), to: isoDay(Math.floor(s.d / 2)) })));
const keyOf = units => (units ? JSON.stringify(units.map(u => u.map(s => [s.k, s.a, s.d])).sort()) : '');

const validUnits = (it, units) => {
  if (!Array.isArray(units) || !units.length) return false;
  const single15 = units.length === 1 && allows15(it) && units[0].every(s => s.k === 15);
  if (units.length !== it.kennels && !single15) return false;
  return units.every(u => u.length && u[0].k === u.at(-1).k
    && u.every((s, i) => s.k >= 1 && s.k <= LANES && s.a < s.d && (!i || s.a === u[i - 1].d)));
};

const kennelOn = (unit, t) => unit.find(s => s.a <= t && t < s.d)?.k;

function prepare(bookings, T) {
  return bookings.map((b, i) => {
    const it = { id: b.id, v: i + 1, a: arriveSlot(b), d: departSlot(b), cats: +b.cats || 1, kennels: +b.kennels || 1, joined: !!b.joined };
    const units = unitSlots(b);
    it.units = validUnits(it, units) ? units : null;
    it.orig = keyOf(it.units);
    it.fixed = !!it.units && (!!b.locked || dayNum(b.arrive) <= T / 2);
    return it;
  });
}

// Scoring

// Slots where a multi-kennel booking has fewer pairs than it could

function unjoined(it, T) {
  if (it.kennels < 2 || it.units.length === 1) return 0;
  const want = Math.floor(it.kennels / 2);
  let missing = 0;
  for (let t = Math.max(it.a, T); t < it.d; t++) {
    const ks = it.units.map(u => kennelOn(u, t));
    const got = PAIRS.filter(([p, q]) => ks.includes(p) && ks.includes(q)).length;
    missing += Math.max(0, want - got);
  }
  return missing;
}

function bookingCost(it, T) {
  let c = (it.joined ? COST.unjoined : COST.apart) * it.miss / 2;
  const needs15 = it.units.length === 1 && it.cats > 2;
  for (const u of it.units) {
    c += COST.move * (u.length - 1) / 2;
    for (const s of u) {
      if (isHolding(s.k)) c += COST.holding * (s.d - s.a) / 2;
      else if (s.k === 15 && !needs15) c += COST.big * Math.max(0, s.d - Math.max(s.a, T)) / 2;
    }
  }
  return c;
}

// Cost change from filling one free segment

function segDelta(g, T, { k, a, d }) {
  const lo = Math.max(a, T);
  if (lo >= d || isHolding(k)) return 0;
  let p = lo - 1;
  while (p >= T && !g.at(k, p)) p--;
  const prevEnd = p >= T ? p + 1 : T;
  let n = d;
  while (n < g.e && !g.at(k, n)) n++;
  const open = n >= g.e;
  let cost = gapCost(lo - prevEnd) + (open ? 0 : gapCost(n - d) - gapCost(n - prevEnd));
  const m = mateOf(k);
  if (m) for (let t = lo; t < d; t++) cost += (g.at(m, t) ? -COST.halfPair : COST.halfPair) / 2;
  return cost;
}

function totalCost(g, items, T, wChanged) {
  let c = 0;
  for (const it of items) {
    if (!it.units) {
      c += COST.unplaced + (it.orig ? wChanged : 0);
      continue;
    }
    c += bookingCost(it, T);
    if (!it.fixed && it.orig && it.key !== it.orig) c += wChanged;
  }
  for (let k = 1; k <= KENNELS; k++) {
    let free = 0;
    for (let t = Math.max(T, g.s); t < g.e; t++) {
      if (g.at(k, t)) {
        c += gapCost(free);
        free = 0;
      } else free++;
    }
  }
  for (const [p, q] of PAIRS) {
    for (let t = Math.max(T, g.s); t < g.e; t++) if (!g.at(p, t) !== !g.at(q, t)) c += COST.halfPair / 2;
  }
  return c;
}

// Placing

function place(g, it, units) {
  for (const u of units) for (const s of u) g.set(s.k, s.a, s.d, it.v);
  it.units = units;
  it.key = keyOf(units);
  it.miss = unjoined(it, g.T);
}

function unplace(g, it) {
  for (const u of it.units) for (const s of u) g.set(s.k, s.a, s.d, 0);
  it.units = null;
}

function tryPlace(g, it, units, T, wChanged) {
  let score = 0;
  for (const u of units) {
    for (const s of u) {
      score += segDelta(g, T, s);
      g.set(s.k, s.a, s.d, it.v);
    }
  }
  it.units = units;
  it.miss = unjoined(it, T);
  score += bookingCost(it, T);
  if (it.orig && keyOf(units) !== it.orig) score += wChanged;
  return score;
}

// Ways to place one unit with `cats` cats in it. Moves and holding pens are only offered when
// the unit can't stay in one kennel. Only a lone cat moves mid-stay. Holding pens take up to
// 2 cats, so a unit that needs kennel 15 can't use them.

function unitOptions(g, a, d, ks, allowMove, cats) {
  const out = [];
  for (const k of ks) if (g.free(k, a, d)) out.push([{ k, a, d }]);
  if (out.length || !allowMove) return out;
  const holds = cats <= 2 ? HOLDING : [];
  if (Math.floor(d / 2) - Math.floor(a / 2) <= HOLD_NIGHTS) for (const h of holds) if (g.free(h, a, d)) out.push([{ k: h, a, d }]);
  if (cats > 1) return out;
  for (const k of ks) {
    if (g.at(k, a) || g.at(k, d - 1)) continue;
    let x = -1;
    let y = -1;
    for (let t = a; t < d; t++) {
      if (g.at(k, t)) {
        if (x < 0) x = t;
        y = t + 1;
      }
    }
    if (x < 0) continue;
    x -= x % 2;
    y += y % 2;
    if (x <= a || y >= d) continue;
    const mid = route(x, y, ks.concat(holds), (lane, s, e) => g.free(lane, s, e));
    if (mid) out.push(mergeSegs([{ k, a, d: x }, ...mid, { k, a: y, d }]));
  }
  return out;
}

function unitScore(g, T, u) {
  return u.reduce((sum, s) => sum + segDelta(g, T, s) + (isHolding(s.k) ? COST.holding * (s.d - s.a) / 2 : 0), 0) + COST.move * (u.length - 1) / 2;
}

// Add units one at a time, each in its best spot, on top of the units given

function extend(g, it, units, need, T, allowMove) {
  const out = units.slice();
  const fill = (u, v) => u.forEach(s => g.set(s.k, s.a, s.d, v));
  out.forEach(u => fill(u, it.v));
  let ok = true;
  for (let i = 0; i < need && ok; i++) {
    let best = null;
    let bestScore = Infinity;
    for (const u of unitOptions(g, it.a, it.d, ALL, allowMove, catsIn(it, out.length))) {
      const s = unitScore(g, T, u);
      if (s < bestScore) {
        bestScore = s;
        best = u;
      }
    }
    if (best) {
      fill(best, it.v);
      out.push(best);
    } else ok = false;
  }
  out.forEach(u => fill(u, 0));
  return ok ? out : null;
}

function bestPlacement(g, it, T, wChanged, allowMove) {
  const { a, d } = it;
  let best = null;
  let bestScore = Infinity;
  const consider = units => {
    if (!units) return;
    const s = tryPlace(g, it, units, T, wChanged);
    unplace(g, it);
    if (s < bestScore) {
      bestScore = s;
      best = units;
    }
  };

  if (it.kennels === 1) {
    for (const u of unitOptions(g, a, d, singleKennels(it), allowMove, it.cats)) consider([u]);
    return best;
  }
  if (allows15(it) && g.free(15, a, d)) consider([[{ k: 15, a, d }]]);
  for (const [p, q] of PAIRS) {
    if (g.free(p, a, d) && g.free(q, a, d)) consider(extend(g, it, [[{ k: p, a, d }], [{ k: q, a, d }]], it.kennels - 2, T, false));
  }
  for (const first of unitOptions(g, a, d, ALL, allowMove, catsIn(it, 0))) consider(extend(g, it, [first], it.kennels - 1, T, allowMove));
  return best;
}

// Large-neighbourhood search: lift a few overlapping bookings out, put them back in their
// best spots, and keep the result if the total cost doesn't go up

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function improve(g, items, T, wChanged, ms) {
  const movable = items.filter(it => !it.fixed);
  if (!movable.length) return;
  const rand = rng(1);
  const pick = list => list[Math.floor(rand() * list.length)];
  const insertOnly = wChanged === CHANGED.insert;
  let cost = totalCost(g, items, T, wChanged);
  const stop = performance.now() + ms;

  for (let iter = 0; iter < 50000 && performance.now() < stop; iter++) {
    const waiting = movable.filter(it => !it.units);
    if (insertOnly && !waiting.length) break;
    const split = movable.filter(it => it.units && it.miss);
    const seed = waiting.length && rand() < 0.7 ? pick(waiting)
      : split.length && rand() < 0.5 ? pick(split)
        : pick(movable);

    // Either clear specific kennels for the seed, or lift out a few bookings near it

    let target = null;
    if (rand() < 0.6) {
      const p = pick(PAIRS);
      target = seed.kennels >= 2 ? [[p[0]], [p[1]]] : [[pick(seed.cats > 2 ? [15] : ALL)]];
    }
    const group = new Set([seed]);
    let ok = true;
    if (target) {
      for (const [k] of target) {
        for (let t = seed.a; t < seed.d && ok; t++) {
          const v = g.at(k, t);
          if (!v) continue;
          if (v === CLOSED || items[v - 1].fixed) ok = false;
          else group.add(items[v - 1]);
        }
      }
      if (!ok) continue;
    } else {
      const near = movable.filter(it => it !== seed && it.a < seed.d + 4 && it.d > seed.a - 4);
      const size = 1 + Math.floor(rand() * 6);
      while (group.size < size && near.length) group.add(near.splice(Math.floor(rand() * near.length), 1)[0]);
    }

    const saved = new Map([...group].map(it => [it, it.units]));
    group.forEach(it => it.units && unplace(g, it));
    const order = [...group];
    if (target) {
      order.shift();
      const units = target.map(([k]) => [{ k, a: seed.a, d: seed.d }]);
      const full = seed.kennels > units.length ? extend(g, seed, units, seed.kennels - units.length, T, true) : units;
      if (full) place(g, seed, full);
      else order.unshift(seed);
      order.sort((x, y) => x.a - y.a);
    } else if (rand() < 0.5) order.sort(() => rand() - 0.5);
    else order.sort((x, y) => y.kennels - x.kennels || (y.d - y.a) - (x.d - x.a));
    for (const it of order) {
      if (it.units) continue;
      const units = bestPlacement(g, it, T, wChanged, true);
      if (units) place(g, it, units);
    }

    const next = totalCost(g, items, T, wChanged);
    if (next <= cost) cost = next;
    else {
      group.forEach(it => it.units && unplace(g, it));
      saved.forEach((units, it) => units && place(g, it, units));
    }
  }
}

// Main entry point
//
// mode 'insert' places bookings with no kennel, moving others only if it has to.
// mode 'optimise' rearranges every booking that hasn't started and isn't locked.

export function plan(bookings, { today = todayIso(), mode = 'insert', ms, closures = [] } = {}) {
  const T = 2 * dayNum(today);
  const items = prepare(bookings, T);
  if (!items.length) return { placements: {}, changed: [], unplaced: [], clashes: [], moves: [], holding: [] };

  const start = Math.min(T, ...items.map(it => it.a));
  const end = Math.max(T + 2, ...items.map(it => it.d)) + 2;
  const g = new Grid(start, end, T);
  const clashes = new Set();
  const wChanged = CHANGED[mode];

  for (const c of closures) {
    const a = Math.max(2 * dayNum(c.from) + 1, start);
    const d = Math.min(2 * dayNum(c.to), end);
    if (a < d) for (let k = 1; k <= LANES; k++) g.set(k, a, d, CLOSED);
  }

  // Fixed bookings keep their kennels even if they clash, so clashes show on the board

  for (const it of items.filter(it => it.fixed)) {
    for (const u of it.units) {
      for (const s of u) {
        for (let t = s.a; t < s.d; t++) {
          const other = g.at(s.k, t);
          if (other === CLOSED) clashes.add(it.id);
          else if (other && other !== it.v) clashes.add(it.id).add(items[other - 1].id);
          else g.set(s.k, t, t + 1, it.v);
        }
      }
    }
    it.key = it.orig;
    it.miss = unjoined(it, T);
  }
  for (const it of items.filter(it => !it.fixed && it.units)) {
    if (it.units.every(u => u.every(s => g.free(s.k, s.a, s.d)))) place(g, it, it.units);
    else it.units = null;
  }

  const waiting = items.filter(it => !it.units).sort((x, y) => x.a - y.a || y.kennels - x.kennels);
  for (const it of waiting) {
    const units = bestPlacement(g, it, T, wChanged, false);
    if (units) place(g, it, units);
  }
  if (mode === 'optimise' || items.some(it => !it.units)) {
    improve(g, items, T, wChanged, ms ?? (mode === 'optimise' ? 1500 : 500));
  }

  const placements = {};
  for (const it of items) placements[it.id] = toIso(it.units);
  return {
    placements,
    changed: items.filter(it => it.units && keyOf(it.units) !== it.orig).map(it => it.id),
    unplaced: items.filter(it => !it.units).map(it => it.id),
    clashes: [...clashes],
    moves: items.filter(it => it.units?.some(u => u.length > 1)).map(it => it.id),
    holding: items.filter(it => it.units?.some(u => u.some(s => isHolding(s.k)))).map(it => it.id)
  };
}

// Overlap check for hand moves on the board. `b` would take `placement`; returns the ids of
// bookings in the way, using arrival and departure times.

export function blockers(bookings, b, placement) {
  const mine = unitSlots(b, placement).flat();
  const out = new Set();
  for (const o of bookings) {
    if (o.id === b.id || !o.placement) continue;
    for (const s of unitSlots(o).flat()) {
      if (mine.some(m => m.k === s.k && m.a < s.d && s.a < m.d)) out.add(o.id);
    }
  }
  return [...out];
}
