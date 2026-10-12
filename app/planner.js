// Kennel planner shared by the board and the reply page.
//
// A booking needs `kennels` units. Each unit is a list of segments {k, from, to} covering
// every night from arrival to departure. A unit starts and ends in the same kennel, and may
// move out to one other kennel and back in the middle of the stay.
//
// Nights run from the arrival date up to the night before departure, so one booking can
// leave a kennel on the day the next one arrives.

export const KENNELS = 15;
export const PAIRS = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12], [13, 14]];
export const capacity = k => (k === 15 ? 3 : 2);
export const mateOf = k => (k < KENNELS ? (k % 2 ? k + 1 : k - 1) : 0);

export const dayNum = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5;
export const isoDay = n => new Date(n * 864e5).toISOString().slice(0, 10);
export const todayIso = () => {
  const d = new Date();
  return isoDay(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
};

// Fitting a booking beats any move, a move beats an unjoined pen, and an unjoined pen beats
// short gaps between bookings. Short gaps are hard to fill, so each night in one costs more
// than a night in a longer gap, and gaps of three weeks or more cost nothing. An owner's
// kennels sit side by side even when they aren't joined, and kennel 15 is kept for bookings
// that need its extra space.

const COST = { unplaced: 1e6, move: 1000, unjoined: 15, apart: 2, big: 3, gap: 3, halfPair: 0.2 };
const CHANGED = { insert: 40, optimise: 3 };
const gapCost = g => COST.gap * g * Math.max(0, 1 - g / 21);

const ALL = Array.from({ length: KENNELS }, (_, i) => i + 1);

// Kennel 15 can take 3 cats, so it can stand in for a joined pair

const allows15 = it => it.joined && it.kennels === 2 && it.cats <= 3;
const singleKennels = it => (it.cats > 2 ? [15] : ALL);

class Grid {
  constructor(start, end, T) {
    this.T = T;
    this.s = start;
    this.e = end;
    this.c = Array.from({ length: KENNELS + 1 }, () => new Int32Array(end - start));
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

const toDays = placement => placement?.map(u => u.map(s => ({ k: s.k, a: dayNum(s.from), d: dayNum(s.to) })));
const toIso = units => units?.map(u => u.map(s => ({ k: s.k, from: isoDay(s.a), to: isoDay(s.d) })));
const keyOf = units => (units ? JSON.stringify(units.map(u => u.map(s => [s.k, s.a, s.d])).sort()) : '');

const validUnits = (it, units) => {
  if (!Array.isArray(units) || !units.length) return false;
  const single15 = units.length === 1 && allows15(it) && units[0].every(s => s.k === 15);
  if (units.length !== it.kennels && !single15) return false;
  return units.every(u => u.length && u[0].a === it.a && u.at(-1).d === it.d && u[0].k === u.at(-1).k
    && u.every((s, i) => s.k >= 1 && s.k <= KENNELS && s.a < s.d && (!i || s.a === u[i - 1].d)));
};

const kennelOn = (unit, t) => unit.find(s => s.a <= t && t < s.d)?.k;

function prepare(bookings, T) {
  return bookings.map((b, i) => {
    const it = { id: b.id, v: i + 1, a: dayNum(b.arrive), d: dayNum(b.depart), cats: +b.cats || 1, kennels: +b.kennels || 1, joined: !!b.joined };
    const units = toDays(b.placement);
    it.units = validUnits(it, units) ? units : null;
    it.orig = keyOf(it.units);
    it.fixed = !!it.units && (!!b.locked || it.a <= T);
    return it;
  });
}

// Scoring

// Nights where a multi-kennel booking has fewer pairs than it could

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
  let c = (it.joined ? COST.unjoined : COST.apart) * it.miss;
  const needs15 = it.units.length === 1 && it.cats > 2;
  for (const u of it.units) {
    if (u.length > 1) c += COST.move;
    if (!needs15) for (const s of u) if (s.k === 15) c += COST.big * (s.d - Math.max(s.a, T));
  }
  return c;
}

// Cost change from filling one free segment

function segDelta(g, T, { k, a, d }) {
  const lo = Math.max(a, T);
  if (lo >= d) return 0;
  let p = lo - 1;
  while (p >= T && !g.at(k, p)) p--;
  const prevEnd = p >= T ? p + 1 : T;
  let n = d;
  while (n < g.e && !g.at(k, n)) n++;
  const open = n >= g.e;
  let cost = gapCost(lo - prevEnd) + (open ? 0 : gapCost(n - d) - gapCost(n - prevEnd));
  const m = mateOf(k);
  if (m) for (let t = lo; t < d; t++) cost += g.at(m, t) ? -COST.halfPair : COST.halfPair;
  return cost;
}

function totalCost(g, items, T, wChanged) {
  let c = 0;
  for (const it of items) {
    if (!it.units) {
      c += COST.unplaced;
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
    for (let t = Math.max(T, g.s); t < g.e; t++) if (!g.at(p, t) !== !g.at(q, t)) c += COST.halfPair;
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

// Ways to place one unit. Moves are only offered when the unit can't stay in one kennel.

function unitOptions(g, a, d, ks, allowMove) {
  const out = [];
  for (const k of ks) if (g.free(k, a, d)) out.push([{ k, a, d }]);
  if (out.length || !allowMove) return out;
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
    for (const k2 of ks) {
      if (k2 !== k && g.free(k2, x, y)) out.push([{ k, a, d: x }, { k: k2, a: x, d: y }, { k, a: y, d }]);
    }
  }
  return out;
}

function unitScore(g, T, u) {
  return u.reduce((sum, s) => sum + segDelta(g, T, s), 0) + (u.length > 1 ? COST.move : 0);
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
    for (const u of unitOptions(g, it.a, it.d, ALL, allowMove)) {
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
    for (const u of unitOptions(g, a, d, singleKennels(it), allowMove)) consider([u]);
    return best;
  }
  if (allows15(it) && g.free(15, a, d)) consider([[{ k: 15, a, d }]]);
  if (it.kennels >= 2) {
    for (const [p, q] of PAIRS) {
      if (g.free(p, a, d) && g.free(q, a, d)) consider(extend(g, it, [[{ k: p, a, d }], [{ k: q, a, d }]], it.kennels - 2, T, false));
    }
  }
  for (const first of unitOptions(g, a, d, ALL, allowMove)) consider(extend(g, it, [first], it.kennels - 1, T, allowMove));
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
          if (items[v - 1].fixed) ok = false;
          else group.add(items[v - 1]);
        }
      }
      if (!ok) continue;
    } else {
      const near = movable.filter(it => it !== seed && it.a < seed.d + 2 && it.d > seed.a - 2);
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

export function plan(bookings, { today = todayIso(), mode = 'insert', ms } = {}) {
  const T = dayNum(today);
  const items = prepare(bookings, T);
  if (!items.length) return { placements: {}, changed: [], unplaced: [], clashes: [], moves: [] };

  const start = Math.min(T, ...items.map(it => it.a));
  const end = Math.max(T + 1, ...items.map(it => it.d)) + 1;
  const g = new Grid(start, end, T);
  const clashes = new Set();
  const wChanged = CHANGED[mode];

  // Fixed bookings keep their kennels even if they clash, so clashes show on the board

  for (const it of items.filter(it => it.fixed)) {
    for (const u of it.units) {
      for (const s of u) {
        for (let t = s.a; t < s.d; t++) {
          const other = g.at(s.k, t);
          if (other && other !== it.v) clashes.add(it.id).add(items[other - 1].id);
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
    moves: items.filter(it => it.units?.some(u => u.length > 1)).map(it => it.id)
  };
}

// Overlap check for hand moves on the board. Returns the ids of bookings in the way.

export function blockers(bookings, id, units) {
  const out = new Set();
  for (const b of bookings) {
    if (b.id === id || !b.placement) continue;
    for (const u of b.placement) {
      for (const s of u) {
        for (const nu of units) {
          for (const ns of nu) if (ns.k === s.k && ns.from < s.to && s.from < ns.to) out.add(b.id);
        }
      }
    }
  }
  return [...out];
}
