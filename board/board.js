import {
  KENNELS, LANES, HOLDING, PAIRS, isHolding, mateOf, dayNum, isoDay, todayIso, plan, blockers,
  unitSlots, arriveSlot, departSlot
} from '../app/planner.js';
import * as store from '../app/store.js';

const $ = id => document.getElementById(id);
const TODAY = todayIso();
const T = dayNum(TODAY);
const PALETTE = ['#dfe8d8', '#f3dfc9', '#d9e6ee', '#efd9df', '#e6e0f0', '#f2ecc6', '#d6ebe4', '#eadfd3'];
const HOLD_MAX = 2;

let bookings = [];
let closures = [];
let closuresMissing = false;
let showHolding = false;
let holdingPref = null;
let preview = null;
let clashes = new Set();
let pieces = new Map();
let openId = null;
let start = T;
let end = T + 1;
let freeEls = [];
let ticketDay = T;

const byId = id => bookings.find(b => b.id === id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmt = (n, opts) => new Date(n * 864e5).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
const shortDate = n => `${fmt(n, { weekday: 'short' })} ${fmt(n, { day: 'numeric' })}`;
const niceDate = iso => {
  const n = dayNum(iso);
  const year = new Date(n * 864e5).getUTCFullYear();
  const text = `${shortDate(n)} ${fmt(n, { month: 'short' })}`;
  return year === new Date(T * 864e5).getUTCFullYear() ? text : `${text} ${year}`;
};
const monthStart = n => {
  const d = new Date(n * 864e5);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 864e5;
};
const addMonths = (n, m) => {
  const d = new Date(n * 864e5);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, 1) / 864e5;
};
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r)));

const kname = k => (isHolding(k) ? `holding pen ${k - KENNELS}` : `kennel ${k}`);
const kshort = k => (isHolding(k) ? `H${k - KENNELS}` : `${k}`);
const cap = s => s[0].toUpperCase() + s.slice(1);
const planOpts = extra => ({ closures: store.closedNights(closures), ...extra });
const closureOn = n => closures.find(c => dayNum(c.closed_from) <= n && n < dayNum(c.reopens));
const closureDuring = b => closures.find(c => c.closed_from < b.depart && b.arrive < c.reopens);
const holdNights = p => (p ? p.flat().filter(s => isHolding(s.k)) : []);

const allows15 = b => b.joined && +b.kennels === 2 && +b.cats <= 3;
const seg = (k, b) => ({ k, from: b.arrive, to: b.depart });
const placementOf = b => (preview ? preview.placements[b.id] : b.placement);
const isPair = p => p?.length === 2 && p.every(u => u.length === 1) && mateOf(p[0][0].k) === p[1][0].k;

// Cats in unit i, matching the planner. Extra cats share kennels from the first unit on.

const unitCats = (b, i, p = b.placement) => (p.length === 1 ? +b.cats : 1 + (i < +b.cats - +b.kennels ? 1 : 0));

// Holding pens show when asked for, or whenever an upcoming booking uses one

const usesHolding = () => bookings.some(b => b.depart > TODAY && holdNights(placementOf(b)).length);

// Times

const timeText = t => (t === 'am' ? 'Morning' : t === 'pm' ? 'Afternoon' : t || '');
const minutes = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);

// Where in a day row a stay starts or ends, as a fraction of the row. Without a time, a stay
// fills the whole day, unless another booking turns the kennel round that day.

function arriveFrac(t, other) {
  if (t === 'am') return 0;
  if (t === 'pm') return 0.5;
  if (t) return minutes(t) / 1440;
  return other ? departFrac(other.depart_time) ?? 0.5 : 0;
}

function departFrac(t, other) {
  if (t === 'am') return 0.5;
  if (t === 'pm') return 1;
  if (t) return minutes(t) / 1440;
  if (other === undefined) return null;
  return other ? arriveFrac(other.arrive_time) || 0.5 : 1;
}

const MOVE_FRAC = 0.375;

// Layout

const L = { row: 30, dateW: 128, colW: 60, holdW: 44, gap: 8, mobile: false };
const HOLD_SHARE = 0.7;

function measure() {
  const css = getComputedStyle(document.documentElement);
  showHolding = holdingPref ?? usesHolding();
  L.mobile = matchMedia('(max-width: 700px)').matches;
  L.row = parseFloat(css.getPropertyValue('--row'));
  L.dateW = parseFloat(css.getPropertyValue('--date-w'));
  L.gap = L.mobile ? 4 : 8;
  const holdGap = showHolding ? 3 * L.gap : 0;
  const room = $('scroller').clientWidth - L.dateW - 7 * L.gap - holdGap - 4;
  const cols = KENNELS + (showHolding ? HOLDING.length * HOLD_SHARE : 0);
  L.colW = L.mobile ? 42 : Math.max(52, Math.min(110, Math.floor(room / cols)));
  L.holdW = Math.round(L.colW * HOLD_SHARE);
}

const lastLane = () => (showHolding ? LANES : KENNELS);
const laneW = k => (isHolding(k) ? L.holdW : L.colW);
const laneX = k => (isHolding(k)
  ? laneX(KENNELS) + L.colW + 3 * L.gap + (k - KENNELS - 1) * L.holdW
  : (k - 1) * L.colW + Math.floor((k - 1) / 2) * L.gap);
const lanesWidth = () => laneX(lastLane()) + laneW(lastLane());
const rowTop = n => (n - start) * L.row;

function kennelAtX(x) {
  let best = 1;
  for (let k = 1; k <= lastLane(); k++) if (x >= laneX(k) - L.gap / 2) best = k;
  return best;
}

// Where a booking is, in words

function describe(b, p = placementOf(b)) {
  if (!p) return 'No kennel yet';
  if (p.length === 1 && p[0].length === 1 && p[0][0].k === 15 && +b.kennels === 2) return 'Kennel 15, in place of 2 joined kennels';
  if (isPair(p)) return `Kennels ${Math.min(p[0][0].k, p[1][0].k)} and ${Math.max(p[0][0].k, p[1][0].k)}, joined`;
  const parts = p.map(u => {
    if (u.length === 1) return kname(u[0].k);
    return `${kname(u[0].k)}, moving to ${kname(u[1].k)} on ${niceDate(u[1].from)} and back on ${niceDate(u[1].to)}`;
  });
  return cap(parts.join('; '));
}

// Static parts: kennel headers, date column, month picker

function buildStatic() {
  const days = bookings.flatMap(b => [dayNum(b.arrive), dayNum(b.depart)]);
  start = monthStart(Math.min(T - 31, ...days));
  end = addMonths(Math.max(T + 730, ...days), 2);

  $('sheet').style.width = `${L.dateW + lanesWidth()}px`;
  $('heads').style.width = `${lanesWidth()}px`;
  let heads = '';
  for (let k = 1; k <= KENNELS; k++) {
    heads += `<div class="kh" style="left:${laneX(k)}px;width:${L.colW}px">${k}${k === 15 && L.colW >= 72 ? '<small>up to 3 cats</small>' : ''}</div>`;
  }
  for (const [p] of PAIRS) heads += `<div class="pairline" style="left:${laneX(p) + 6}px;width:${2 * L.colW - 12}px" title="Kennels ${p} and ${p + 1} can be joined"></div>`;
  if (showHolding) {
    for (const k of HOLDING) heads += `<div class="kh hold" style="left:${laneX(k)}px;width:${L.holdW}px" title="Holding pen ${k - KENNELS}">${kshort(k)}</div>`;
  }
  $('heads').innerHTML = heads;
  $('holding').textContent = showHolding ? 'Hide holding' : 'Holding pens';
  $('holding').setAttribute('aria-pressed', showHolding);

  const dates = $('dates');
  dates.textContent = '';
  freeEls = [];
  const frag = document.createDocumentFragment();
  for (let n = start; n < end; n++) {
    const row = document.createElement('div');
    const dow = new Date(n * 864e5).getUTCDay();
    const first = new Date(n * 864e5).getUTCDate() === 1;
    row.className = `date${dow === 0 || dow === 6 ? ' weekend' : ''}${first ? ' month' : ''}${n === T ? ' today' : ''}${n < T ? ' past' : ''}${closureOn(n) ? ' closed' : ''}`;
    row.textContent = L.mobile
      ? `${fmt(n, { weekday: 'narrow' })} ${fmt(n, { day: 'numeric' })}${first ? ' ' + fmt(n, { month: 'short' }) : ''}`
      : fmt(n, { weekday: 'short', day: 'numeric', month: 'short' });
    const free = document.createElement('span');
    free.className = 'free';
    row.append(free);
    freeEls.push(free);
    frag.append(row);
  }
  dates.append(frag);

  const month = $('month');
  month.textContent = '';
  for (let m = start; m < end; m = addMonths(m, 1)) month.add(new Option(fmt(m, { month: 'long', year: 'numeric' }), m));
}

// Turnarounds: in each lane, who leaves and who arrives on each day

function turnarounds() {
  const out = new Map();
  const note = (k, day, field, b) => {
    const key = `${k}:${day}`;
    if (!out.has(key)) out.set(key, {});
    out.get(key)[field] = b;
  };
  for (const b of bookings) {
    const p = placementOf(b);
    if (!p) continue;
    for (const u of p) {
      note(u[0].k, b.arrive, 'arrive', b);
      note(u.at(-1).k, b.depart, 'depart', b);
    }
  }
  return out;
}

// Cards

function piecesOf(b, p, turns) {
  if (isPair(p)) return [{ ks: [p[0][0].k, p[1][0].k], segs: [p[0][0]], u: p[0], part: 'pair', unit: 0 }];
  const out = [];
  p.forEach((u, unit) => {
    const pairLike = p.length === 1 && u[0].k === 15 && +b.kennels === 2;
    if (u.length === 1) {
      out.push({ ks: [u[0].k], segs: [u[0]], u, part: pairLike ? 'pair' : 'whole', unit });
      return;
    }
    u.forEach((s, i) => out.push({ ks: [s.k], segs: [s], u, i, part: i === 1 ? 'away' : 'home', unit, home: u[0].k, away: u[1].k, back: u[1].to }));
  });
  for (const piece of out) {
    const s = piece.segs[0];
    const k = piece.ks[0];
    const first = s === piece.u[0];
    const last = s === piece.u.at(-1);
    const turnIn = turns.get(`${k}:${b.arrive}`)?.depart;
    const turnOut = turns.get(`${k}:${b.depart}`)?.arrive;
    piece.top = first ? rowTop(dayNum(b.arrive)) + arriveFrac(b.arrive_time, turnIn && turnIn !== b ? turnIn : null) * L.row
      : rowTop(dayNum(s.from)) + MOVE_FRAC * L.row;
    piece.bottom = last ? rowTop(dayNum(b.depart)) + departFrac(b.depart_time, turnOut && turnOut !== b ? turnOut : null) * L.row
      : rowTop(dayNum(s.to)) + MOVE_FRAC * L.row;
  }
  return out;
}

function colourOf(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function cardHtml(b, piece, key) {
  const lo = Math.min(...piece.ks);
  const hi = Math.max(...piece.ks);
  const left = laneX(lo) + 2;
  const width = laneX(hi) + laneW(hi) - laneX(lo) - 4;
  const top = piece.top + 1;
  const height = Math.max(10, piece.bottom - piece.top - 2);
  const rows = height / L.row;
  const name = b.name || 'No name';
  const cats = b.cat_names && b.cat_names !== b.name ? b.cat_names : plural(+b.cats, 'cat');
  const classes = ['card'];
  if (piece.part === 'away') classes.push('away');
  if (isHolding(lo)) classes.push('held');
  if (clashes.has(b.id)) classes.push('clash');
  if (preview?.changed.has(b.id)) classes.push('changed');
  if (b.locked) classes.push('locked');

  let lines = `<b>${esc(name)}</b>`;
  if (piece.part === 'away') {
    lines = `<b>↪ ${esc(name)}</b>${rows > 1.5 ? `<span>Back to ${kshort(piece.home)} ${esc(shortDate(dayNum(piece.back)))}</span>` : ''}`;
  } else {
    if (rows > 1.5) lines += `<span>${esc(cats)}</span>`;
    if (rows > 2.5) {
      const s = piece.segs[0];
      const leaves = s === piece.u.at(-1);
      lines += leaves
        ? `<span>Leaves ${esc(shortDate(dayNum(b.depart)))}${b.depart_time ? ` ${esc(timeText(b.depart_time).toLowerCase())}` : ''}</span>`
        : `<span>To ${kshort(piece.away)} ${esc(shortDate(dayNum(s.to)))}</span>`;
    }
  }
  const title = `${name} · ${cats} · ${niceDate(b.arrive)}${b.arrive_time ? ` ${timeText(b.arrive_time).toLowerCase()}` : ''} to ${niceDate(b.depart)}${b.depart_time ? ` ${timeText(b.depart_time).toLowerCase()}` : ''} · ${describe(b)}`;
  return `<div class="${classes.join(' ')}" tabindex="0" role="button" data-key="${key}" title="${esc(title)}"
    style="left:${left}px;width:${width}px;top:${top}px;height:${height}px;--c:${colourOf(b.id)}">${lines}</div>`;
}

function render() {
  const days = end - start;
  const lanes = $('lanes');
  lanes.style.width = `${lanesWidth()}px`;
  lanes.style.height = `${days * L.row}px`;

  // Clashes, using arrival and departure times, and free kennels each night

  clashes = new Set();
  const byLane = new Map();
  const nightUse = Array.from({ length: days }, () => new Set());
  for (const b of bookings) {
    const p = placementOf(b);
    if (!p) continue;
    for (const s of unitSlots(b, p).flat()) {
      if (!byLane.has(s.k)) byLane.set(s.k, []);
      byLane.get(s.k).push({ ...s, id: b.id });
      for (let t = s.a; t < s.d; t++) {
        const n = Math.floor(t / 2);
        if (t % 2 && n >= start && n < end && !isHolding(s.k)) nightUse[n - start].add(s.k);
        if (t % 2 && closureOn(n)) clashes.add(b.id);
      }
    }
  }
  for (const list of byLane.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i];
        const y = list[j];
        if (x.id !== y.id && x.a < y.d && y.a < x.d) clashes.add(x.id).add(y.id);
      }
    }
  }
  nightUse.forEach((used, i) => {
    const closed = closureOn(start + i);
    const free = KENNELS - used.size;
    freeEls[i].textContent = closed ? 'Closed' : free ? `${free} free` : 'Full';
    freeEls[i].classList.toggle('full', !free && !closed);
  });

  let html = '';
  for (let k = 1; k <= lastLane(); k++) html += `<div class="lane${isHolding(k) ? ' hold' : ''}" style="left:${laneX(k)}px;width:${laneW(k)}px"></div>`;
  html += `<div class="band past" style="top:0;height:${(T - start) * L.row}px"></div>`;
  for (let n = start; n < end; n++) {
    const date = new Date(n * 864e5);
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) html += `<div class="band weekend" style="top:${rowTop(n)}px"></div>`;
    if (date.getUTCDate() === 1) html += `<div class="band month" style="top:${rowTop(n)}px"></div>`;
  }
  html += `<div class="band today" style="top:${rowTop(T)}px;height:${L.row}px"></div>`;
  for (const c of closures) {
    const a = Math.max(dayNum(c.closed_from), start);
    const d = Math.min(dayNum(c.reopens), end);
    if (a >= d) continue;
    html += `<div class="closure" style="top:${rowTop(a) + L.row / 2}px;height:${(d - a) * L.row}px"><span>Closed${c.note ? ` · ${esc(c.note)}` : ''}</span></div>`;
  }

  const turns = turnarounds();
  pieces = new Map();
  for (const b of bookings) {
    const p = placementOf(b);
    if (!p) continue;
    piecesOf(b, p, turns).forEach((piece, i) => {
      const key = `${b.id}:${i}`;
      pieces.set(key, { b, piece });
      html += cardHtml(b, piece, key);
    });
  }
  lanes.innerHTML = html;
  renderNotices();
  renderTickets();
}

// Jobs for the day: arrivals, departures, turnarounds and mid-stay moves

function jobsFor(n) {
  const iso = isoDay(n);
  const ins = [];
  const outs = [];
  const moves = [];
  for (const b of bookings) {
    const p = b.placement;
    if (b.arrive === iso) ins.push({ b, ks: p ? p.map(u => u[0].k) : [] });
    if (b.depart === iso) outs.push({ b, ks: p ? p.map(u => u.at(-1).k) : [] });
    p?.forEach(u => u.forEach((s, i) => {
      if (i > 0 && s.from === iso) moves.push({ b, from: u[i - 1].k, to: s.k, back: i === 2 });
    }));
  }

  const jobs = [];
  const paired = new Set();
  for (const o of outs) {
    for (const i of ins) {
      const k = o.ks.find(x => i.ks.includes(x));
      if (k && o.b !== i.b && !paired.has(i)) {
        jobs.push({ type: 'turn', k, out: o, in: i, key: o.b.depart_time });
        paired.add(o).add(i);
        break;
      }
    }
  }
  for (const o of outs) if (!paired.has(o)) jobs.push({ type: 'out', ev: o, key: o.b.depart_time });
  for (const i of ins) if (!paired.has(i)) jobs.push({ type: 'in', ev: i, key: i.b.arrive_time });
  for (const m of moves) jobs.push({ type: 'move', ev: m, key: 'am' });

  const order = t => (t === 'am' ? '09:00' : t === 'pm' ? '14:00' : t || '23:59');
  return jobs.sort((x, y) => order(x.key).localeCompare(order(y.key)));
}

function where(ks) {
  if (!ks.length) return 'No kennel yet';
  if (ks.length === 2 && mateOf(ks[0]) === ks[1]) return `Kennels ${Math.min(...ks)} and ${Math.max(...ks)}`;
  return cap(ks.map(kname).join(', '));
}

function payHtml(b) {
  return `<div class="pay">
    <label><input type="checkbox" data-pay="deposit_paid" data-id="${b.id}"${b.deposit_paid ? ' checked' : ''}> Deposit paid</label>
    <label><input type="checkbox" data-pay="bill_paid" data-id="${b.id}"${b.bill_paid ? ' checked' : ''}> Bill paid</label>
  </div>`;
}

function personHtml(b, time, extra = '') {
  const cats = b.cat_names && b.cat_names !== b.name ? b.cat_names : plural(+b.cats, 'cat');
  return `<button class="tname" type="button" data-open="${b.id}">${esc(b.name || 'No name')}</button>
    <small>${esc(cats)}${b.new_customer ? ' · new customer' : ''}${time ? ` · ${esc(time)}` : ''}${extra}</small>`;
}

function ticketHtml(job) {
  if (job.type === 'turn') {
    const { out, in: inn, k } = job;
    return `<article class="ticket turn">
      <header><span class="tag">Turnaround</span><span class="where">${esc(cap(kname(k)))}</span></header>
      <div class="leg"><span class="dir">Out</span>${personHtml(out.b, timeText(out.b.depart_time) || 'Time not set')}${payHtml(out.b)}</div>
      <div class="leg"><span class="dir">In</span>${personHtml(inn.b, timeText(inn.b.arrive_time) || 'Time not set')}${payHtml(inn.b)}</div>
    </article>`;
  }
  const { b } = job.ev;
  if (job.type === 'move') {
    const m = job.ev;
    return `<article class="ticket move">
      <header><span class="tag">${m.back ? 'Move back' : 'Move'}</span><span class="where">${esc(cap(kname(m.from)))} → ${esc(kname(m.to))}</span></header>
      ${personHtml(b, 'Morning')}${payHtml(b)}
    </article>`;
  }
  const isIn = job.type === 'in';
  const time = timeText(isIn ? b.arrive_time : b.depart_time) || 'Time not set';
  const extra = isIn ? ` · leaves ${esc(niceDate(b.depart))}` : '';
  return `<article class="ticket ${job.type}">
    <header><span class="tag">${isIn ? 'In' : 'Out'}</span><span class="where">${esc(where(job.ev.ks))}</span></header>
    ${personHtml(b, time, extra)}${payHtml(b)}
  </article>`;
}

function renderTickets() {
  const jobs = jobsFor(ticketDay);
  const label = ticketDay === T ? 'Today' : ticketDay === T + 1 ? 'Tomorrow' : ticketDay === T - 1 ? 'Yesterday' : '';
  $('jobs-day').textContent = `${label ? label + ', ' : ''}${niceDate(isoDay(ticketDay))}`;
  $('jobs-count').textContent = jobs.length ? plural(jobs.length, 'job') : 'Nothing on';
  $('tickets').innerHTML = jobs.length
    ? jobs.map(ticketHtml).join('')
    : `<p class="muted">${closureOn(ticketDay) ? 'Closed.' : 'No cats coming in or going out.'}</p>`;
}

$('jobs-prev').addEventListener('click', () => {
  ticketDay--;
  renderTickets();
});
$('jobs-next').addEventListener('click', () => {
  ticketDay++;
  renderTickets();
});
$('jobs-today').addEventListener('click', () => {
  ticketDay = T;
  renderTickets();
});
$('jobs-toggle').addEventListener('click', () => {
  const hidden = $('tickets').hidden = !$('tickets').hidden;
  $('jobs-toggle').textContent = hidden ? 'Show' : 'Hide';
  try {
    localStorage.setItem('qc-jobs-hidden', hidden ? '1' : '');
  } catch {}
});
try {
  if (localStorage.getItem('qc-jobs-hidden')) {
    $('tickets').hidden = true;
    $('jobs-toggle').textContent = 'Show';
  }
} catch {}

$('tickets').addEventListener('click', e => {
  const open = e.target.closest('[data-open]');
  if (open) focusBooking(open.dataset.open);
});

$('tickets').addEventListener('change', e => {
  const box = e.target.closest('[data-pay]');
  if (!box) return;
  const b = byId(box.dataset.id);
  if (!b) return;
  if (!store.hasLaterColumns) {
    box.checked = !box.checked;
    return toast('Payments need one more setup step in Supabase first.');
  }
  commit([{ ...b, [box.dataset.pay]: box.checked }], null, { undoable: false });
});

// Notices above the board

function renderNotices() {
  const out = [];
  if (store.demo) {
    out.push(`<div class="notice demo"><span class="grow">Demo mode. Bookings are saved in this browser only until Supabase is connected.</span></div>`);
  }
  if (closuresMissing || !store.hasLaterColumns) {
    out.push(`<div class="notice waiting"><span class="grow">${!store.hasLaterColumns ? 'Times and payments' : 'Closures'} need one more setup step in Supabase before they can be saved.</span></div>`);
  }
  if (preview) {
    const { changed, placedNow, midStay, held } = preview;
    const moved = changed.size - placedNow;
    const parts = [];
    if (moved) parts.push(`move ${plural(moved, 'booking')}`);
    if (placedNow) parts.push(`find kennels for ${placedNow} that ${placedNow === 1 ? 'has' : 'have'} none`);
    let text = `Optimise would ${parts.join(' and ')}.`;
    if (midStay) text += ` ${plural(midStay, 'booking')} would need a cat moved mid-stay.`;
    if (held) text += ` ${plural(held, 'booking')} would use a holding pen.`;
    out.push(`<div class="notice preview"><span class="grow">${text} Changes are outlined in orange.</span>
      <button class="btn" data-act="next-change">Next change</button>
      <button class="btn" data-act="cancel-preview">Cancel</button>
      <button class="btn primary" data-act="apply-preview">Apply</button></div>`);
  }
  const waiting = bookings.filter(b => !placementOf(b) && b.depart > TODAY).sort((x, y) => x.arrive.localeCompare(y.arrive));
  if (waiting.length) {
    out.push(`<div class="notice waiting"><span>${plural(waiting.length, 'booking')} with no kennel yet:</span>
      ${waiting.map(b => `<button class="chip" data-open="${b.id}">${esc(b.name || 'No name')}, ${esc(niceDate(b.arrive))}</button>`).join('')}</div>`);
  }
  const held = bookings.filter(b => b.depart > TODAY && holdNights(placementOf(b)).length).sort((x, y) => x.arrive.localeCompare(y.arrive));
  if (held.length) {
    out.push(`<div class="notice waiting"><span>${held.length === 1 ? 'This booking uses' : 'These bookings use'} a holding pen:</span>
      ${held.map(b => `<button class="chip" data-open="${b.id}">${esc(b.name || 'No name')}, ${esc(niceDate(holdNights(placementOf(b))[0].from))}</button>`).join('')}</div>`);
  }
  if (clashes.size) {
    const list = [...clashes].map(byId).filter(Boolean);
    out.push(`<div class="notice waiting"><span>These bookings share a kennel, or fall in a closure:</span>
      ${list.map(b => `<button class="chip" data-open="${b.id}">${esc(b.name || 'No name')}, ${esc(niceDate(b.arrive))}</button>`).join('')}</div>`);
  }
  $('notices').innerHTML = out.join('');
}

$('notices').addEventListener('click', e => {
  const open = e.target.closest('[data-open]');
  if (open) return focusBooking(open.dataset.open);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'cancel-preview') {
    preview = null;
    render();
  } else if (act === 'apply-preview') applyPreview();
  else if (act === 'next-change') {
    const ids = [...preview.changed].map(byId).sort((x, y) => x.arrive.localeCompare(y.arrive));
    const b = ids[preview.idx++ % ids.length];
    focusBooking(b.id, false);
  }
});

// Scrolling and navigation

const scroller = $('scroller');

function scrollToDay(n, smooth = true) {
  scroller.scrollTo({ top: Math.max(0, (n - start - 2) * L.row), behavior: smooth ? 'smooth' : 'auto' });
}

function topDay() {
  return start + Math.floor(scroller.scrollTop / L.row) + 2;
}

let ticking = false;
scroller.addEventListener('scroll', () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    $('month').value = monthStart(topDay());
  });
});

$('month').addEventListener('change', e => scrollToDay(+e.target.value));
$('prev').addEventListener('click', () => scrollToDay(Math.max(start, addMonths(monthStart(topDay()), -1))));
$('next').addEventListener('click', () => scrollToDay(Math.min(end - 1, addMonths(monthStart(topDay()), 1))));
$('today').addEventListener('click', () => scrollToDay(T));

function focusBooking(id, open = true) {
  const b = byId(id);
  if (!b) return;
  scrollToDay(dayNum(b.arrive));
  const p = placementOf(b);
  if (p) {
    const k = p[0][0].k;
    const x = laneX(k) - (scroller.clientWidth - L.dateW) / 2;
    scroller.scrollTo({ left: Math.max(0, x), behavior: 'smooth' });
    setTimeout(() => {
      document.querySelectorAll(`.card[data-key^="${id}:"]`).forEach(el => {
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
      });
    }, 350);
  }
  if (open && !preview) openPanel(b);
}

// Search

const search = $('search');
const results = $('results');

search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  if (!q) {
    results.hidden = true;
    return;
  }
  const hits = bookings
    .filter(b => [b.name, b.cat_names, b.phone, b.email].some(v => String(v || '').toLowerCase().includes(q)))
    .sort((x, y) => Math.abs(dayNum(x.arrive) - T) - Math.abs(dayNum(y.arrive) - T))
    .slice(0, 12);
  results.innerHTML = hits.length
    ? hits.map(b => `<button data-open="${b.id}">${esc(b.name || 'No name')}<small>${esc(b.cat_names || plural(+b.cats, 'cat'))} · ${esc(niceDate(b.arrive))} to ${esc(niceDate(b.depart))}</small></button>`).join('')
    : '<p>No bookings match.</p>';
  results.hidden = false;
});

results.addEventListener('click', e => {
  const btn = e.target.closest('[data-open]');
  if (!btn) return;
  results.hidden = true;
  search.value = '';
  focusBooking(btn.dataset.open);
});

document.addEventListener('click', e => {
  if (!e.target.closest('.search')) results.hidden = true;
});

// Saving, with undo

let toastTimer;

function toast(text, undo) {
  const el = $('toast');
  el.innerHTML = `<span>${esc(text)}</span>${undo ? '<button type="button">Undo</button>' : ''}`;
  el.hidden = false;
  if (undo) el.querySelector('button').onclick = () => {
    el.hidden = true;
    undo();
  };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), undo ? 8000 : 4500);
}

async function commit(rows, message, { undoable = true } = {}) {
  const before = rows.map(r => byId(r.id)).filter(Boolean);
  const isNew = rows.filter(r => !byId(r.id)).map(r => r.id);
  for (const r of rows) {
    const i = bookings.findIndex(b => b.id === r.id);
    if (i < 0) bookings.push(r);
    else bookings[i] = r;
  }
  render();
  try {
    await store.save(rows);
  } catch (err) {
    toast(`Couldn't save: ${err.message}. Reloading.`);
    return reload();
  }
  const undo = undoable ? async () => {
    for (const id of isNew) {
      bookings = bookings.filter(b => b.id !== id);
      await store.remove(id);
    }
    if (before.length) await commit(before, 'Undone', { undoable: false });
    else render();
  } : null;
  if (message) toast(message, undo);
}

async function loadClosures() {
  try {
    closures = await store.loadClosures();
    closuresMissing = false;
  } catch {
    closures = [];
    closuresMissing = true;
  }
}

async function reload() {
  try {
    bookings = await store.load();
  } catch (err) {
    return toast(`Couldn't load bookings: ${err.message}`);
  }
  await loadClosures();
  measure();
  const keepTop = scroller.scrollTop;
  const oldStart = start;
  buildStatic();
  render();
  scroller.scrollTop = keepTop + (start - oldStart) * L.row;
}

// Moving cards by hand

function selfOverlap(b, p) {
  const all = unitSlots(b, p).flat();
  return all.some((s, i) => all.some((o, j) => j > i && o.k === s.k && o.a < s.d && s.a < o.d));
}

function collapse(u) {
  return u.every(s => s.k === u[0].k) ? [{ k: u[0].k, from: u[0].from, to: u.at(-1).to }] : u;
}

const nights = s => dayNum(s.to) - dayNum(s.from);

// The placement a booking would have if this piece went to kennel k

function proposal(b, piece, k) {
  const p = structuredClone(placementOf(b));
  if (isHolding(k)) {
    if (piece.part === 'pair' || piece.part === 'home') return null;
    if (piece.part === 'whole' && (dayNum(b.depart) - dayNum(b.arrive) > HOLD_MAX || unitCats(b, piece.unit) > 2)) return null;
    if (piece.part === 'away' && nights(p[piece.unit][1]) > HOLD_MAX) return null;
  }
  if (piece.part === 'pair') {
    if (k === 15) return allows15(b) ? [[seg(15, b)]] : null;
    const lo = k % 2 ? k : k - 1;
    return [[seg(lo, b)], [seg(lo + 1, b)]];
  }
  if (piece.part === 'whole') {
    if (unitCats(b, piece.unit) > 2 && k !== 15) return null;
    p[piece.unit] = [seg(k, b)];
  } else if (piece.part === 'home') {
    const home = piece.home;
    p[piece.unit].forEach(s => {
      if (s.k === home) s.k = k;
    });
  } else {
    p[piece.unit][1].k = k;
  }
  p[piece.unit] = collapse(p[piece.unit]);
  return selfOverlap(b, p) ? null : p;
}

// Is lane k free over slots [a, d), ignoring some bookings?

function laneFree(k, a, d, ignore) {
  for (const c of closures) {
    if (2 * dayNum(c.closed_from) + 1 < d && a < 2 * dayNum(c.reopens)) return false;
  }
  for (const o of bookings) {
    if (ignore.has(o.id) || !o.placement) continue;
    if (unitSlots(o).flat().some(s => s.k === k && s.a < d && a < s.d)) return false;
  }
  return true;
}

const canMove = o => o.arrive > TODAY && !o.locked;

// Work out a hand move to kennel k. When another booking is in the way, first try moving it
// somewhere else. If it can't move, move this cat out of kennel k for the nights it clashes,
// into another kennel or a holding pen. Returns the rows to save, or an error to show.

function planMove(b, piece, k) {
  const name = b.name || 'That booking';
  const p = proposal(b, piece, k);
  if (!p) return { error: isHolding(k) ? 'Holding pens take up to 2 cats for 2 nights at most, partway through a stay or for a short stay.' : `${name} can't go in ${kname(k)}.` };
  if (JSON.stringify(p) === JSON.stringify(b.placement)) return { same: true };
  const moved = { ...b, placement: p, locked: true };
  const others = bookings.filter(x => x.id !== b.id);
  const inWay = blockers(others, b, p);
  const lockedNote = 'It\u2019s locked, so Optimise leaves it there.';
  if (!inWay.length) {
    const held = holdNights(p).length ? ' This uses a holding pen.' : '';
    return { rows: [moved], message: `Moved ${name} to ${describe(moved, p).toLowerCase()}. ${lockedNote}${held}` };
  }

  // Move the bookings in the way, if none of them has arrived or is locked

  if (inWay.every(id => canMove(byId(id)))) {
    const before = new Set(bookings.filter(x => !x.placement).map(x => x.id));
    const list = others.map(o => (inWay.includes(o.id) ? { ...o, placement: null } : o)).concat(moved);
    const res = plan(list, planOpts());
    const ok = inWay.every(id => res.placements[id] && !res.moves.includes(id) && !res.holding.includes(id))
      && res.unplaced.every(id => before.has(id));
    if (ok) {
      const rows = [moved, ...list.filter(o => o.id !== b.id && res.changed.includes(o.id)).map(o => ({ ...o, placement: res.placements[o.id] }))];
      const shifted = rows.slice(1).map(o => `${o.name || 'another booking'} to ${describe(o, o.placement).toLowerCase()}`);
      return { rows, message: `Moved ${name} to ${describe(moved, p).toLowerCase()}, and ${shifted.join(', ')} to make room. ${lockedNote}` };
    }
  }

  // Otherwise move this cat out of kennel k while the other booking is there

  const blockedBy = inWay.map(id => byId(id)?.name || 'another booking').slice(0, 2).join(' and ');
  if (piece.part !== 'whole') return { error: `${cap(kname(k))} is taken by ${blockedBy} on some of those nights.` };
  if (unitCats(b, piece.unit, p) > 1) return { error: `${cap(kname(k))} is taken by ${blockedBy} on some of those nights. Only a single cat can move kennels mid-stay.` };
  const A = arriveSlot(b);
  const D = departSlot(b);
  const clash = inWay.flatMap(id => unitSlots(byId(id)).flat().filter(s => s.k === k && s.a < D && A < s.d));
  let x = Math.min(...clash.map(s => Math.max(s.a, A)));
  let y = Math.max(...clash.map(s => Math.min(s.d, D)));
  x -= x % 2;
  y += y % 2;
  const ignore = new Set([b.id]);
  if (x <= A || y >= D) return { error: `${blockedBy} ${inWay.length > 1 ? 'are' : 'is'} in ${kname(k)} when ${name} arrives or leaves, so ${name} can't start or end there.` };
  const away = [...Array.from({ length: KENNELS }, (_, i) => i + 1).sort((m, n) => Math.abs(m - k) - Math.abs(n - k)), ...((y - x) / 2 <= HOLD_MAX ? HOLDING : [])];
  const own = p.filter((u, i) => i !== piece.unit).flat().map(s => s.k);
  const k2 = away.find(j => j !== k && !own.includes(j) && laneFree(j, x, y, ignore));
  if (!k2) return { error: `${cap(kname(k))} is taken by ${blockedBy}, and there's nowhere free to move ${name} to in the meantime.` };
  const mid = [{ k, from: b.arrive, to: isoDay(x / 2) }, { k: k2, from: isoDay(x / 2), to: isoDay(y / 2) }, { k, from: isoDay(y / 2), to: b.depart }];
  const p2 = p.map((u, i) => (i === piece.unit ? mid : u));
  const moved2 = { ...b, placement: p2, locked: true };
  if (blockers(others, b, p2).length) return { error: `${cap(kname(k))} is taken by ${blockedBy} on some of those nights.` };
  const held = isHolding(k2) ? ' This uses a holding pen.' : '';
  return {
    rows: [moved2],
    detour: true,
    message: `Moved ${name} to ${kname(k)}. While ${blockedBy} ${inWay.length > 1 ? 'are' : 'is'} there, ${name} moves to ${kname(k2)} from ${niceDate(isoDay(x / 2))} to ${niceDate(isoDay(y / 2))}. ${lockedNote}${held}`
  };
}

function moveTo(b, piece, k) {
  const m = planMove(b, piece, k);
  if (m.error) toast(m.error);
  else if (m.rows) {
    const held = m.rows.flatMap(r => holdNights(r.placement));
    if (held.length && !confirm(`This move puts ${b.name || 'a cat'} in ${kname(held[0].k)} from ${niceDate(held[0].from)} to ${niceDate(held[0].to)}. Go ahead?`)) return;
    commit(m.rows, m.message);
  }
}

const lanes = $('lanes');
let drag = null;
let justDragged = false;

lanes.addEventListener('pointerdown', e => {
  const card = e.target.closest('.card');
  if (!card || e.button !== 0 || e.pointerType === 'touch' || preview) return;
  drag = { card, ...pieces.get(card.dataset.key), x0: e.clientX, y0: e.clientY, started: false };
  card.setPointerCapture(e.pointerId);
});

// While dragging, green means free, orange means something has to move, red means it can't go there

lanes.addEventListener('pointermove', e => {
  if (!drag) return;
  if (!drag.started) {
    if (Math.abs(e.clientX - drag.x0) < 5 && Math.abs(e.clientY - drag.y0) < 5) return;
    drag.started = true;
    drag.ghost = drag.card.cloneNode(true);
    drag.ghost.classList.add('ghost');
    lanes.append(drag.ghost);
    drag.card.classList.add('dim');
  }
  const x = e.clientX - lanes.getBoundingClientRect().left;
  let k = kennelAtX(x);
  const wide = drag.piece.part === 'pair';
  if (wide && k < 15) k = k % 2 ? k : k - 1;
  drag.k = k;
  const width = wide && k < 15 ? laneX(k + 1) + L.colW - laneX(k) - 4 : laneW(k) - 4;
  drag.ghost.style.left = `${laneX(k) + 2}px`;
  drag.ghost.style.width = `${width}px`;
  const p = proposal(drag.b, drag.piece, k);
  const busy = p && blockers(bookings.filter(o => o.id !== drag.b.id), drag.b, p).length > 0;
  drag.ghost.classList.toggle('bad', !p);
  drag.ghost.classList.toggle('swap', !!busy);
});

const endDrag = e => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.started) return;
  d.ghost.remove();
  d.card.classList.remove('dim');
  justDragged = true;
  setTimeout(() => (justDragged = false));
  if (e.type === 'pointerup' && d.k) moveTo(d.b, d.piece, d.k);
};
lanes.addEventListener('pointerup', endDrag);
lanes.addEventListener('pointercancel', endDrag);

lanes.addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (!card || justDragged) return;
  if (preview) return toast('Apply or cancel the optimiser\u2019s changes first.');
  openPanel(pieces.get(card.dataset.key).b);
});

lanes.addEventListener('keydown', e => {
  const card = e.target.closest('.card');
  if (card && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    card.click();
  }
});

// Booking panel

const form = $('booking-form');
const panel = $('panel');

for (let n = 1; n <= 9; n++) form.cats.add(new Option(n, n));
for (let n = 1; n <= 6; n++) form.kennels.add(new Option(n, n));

const syncJoin = () => ($('joined-wrap').hidden = +form.kennels.value < 2);
form.kennels.addEventListener('change', syncJoin);
form.cats.addEventListener('change', () => {
  const cats = +form.cats.value;
  const min = cats === 3 ? 1 : Math.ceil(cats / 2);
  if (+form.kennels.value < min) form.kennels.value = min;
  syncJoin();
});

// Arrival and departure times: not set, morning, afternoon, or a time of day

const setTime = (which, t) => {
  form[`${which}_when`].value = t === 'am' || t === 'pm' || !t ? t || '' : 'at';
  form[`${which}_at`].value = /^\d\d:\d\d$/.test(t || '') ? t : '';
  form[`${which}_at`].hidden = form[`${which}_when`].value !== 'at';
};
const getTime = which => (form[`${which}_when`].value === 'at' ? form[`${which}_at`].value : form[`${which}_when`].value);
for (const which of ['arrive', 'depart']) {
  form[`${which}_when`].addEventListener('change', () => {
    form[`${which}_at`].hidden = form[`${which}_when`].value !== 'at';
    if (!form[`${which}_at`].hidden) form[`${which}_at`].focus();
  });
}

function renderWhere(b) {
  const box = $('where');
  const p = b?.placement;
  if (!b || !byId(b.id)) {
    box.innerHTML = '<p>Fill in the stay and save. The board finds the best kennel for it.</p>';
    return;
  }
  const closed = closureDuring(b);
  let html = p ? `<p><b>${esc(describe(b, p))}</b></p>` : '<p class="warn">No kennel yet. There\u2019s no room on these dates as the board stands.</p>';
  if (closed) html += `<p class="warn">This stay falls in a closure, ${esc(niceDate(closed.closed_from))} until ${esc(niceDate(closed.reopens))}.</p>`;
  const held = holdNights(p);
  if (held.length) html += `<p class="warn">Uses ${esc(kname(held[0].k))} from ${esc(niceDate(held[0].from))} to ${esc(niceDate(held[0].to))}.</p>`;
  if (p) {
    const pairy = isPair(p) || (p.length === 1 && +b.kennels === 2);
    if (pairy) {
      const options = [...PAIRS.map(([x, y]) => [x, `Kennels ${x} and ${y}`]), ...(allows15(b) ? [[15, 'Kennel 15']] : [])]
        .map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
      const cur = Math.min(...p.map(u => u[0].k));
      html += `<label class="field"><span>Move to</span><select data-pair>${options}</select></label>`;
      setTimeout(() => (box.querySelector('[data-pair]').value = cur));
    } else {
      p.forEach((u, i) => {
        if (u.length > 1) return;
        const opts = Array.from({ length: KENNELS }, (_, j) => `<option value="${j + 1}"${j + 1 === u[0].k ? ' selected' : ''}>Kennel ${j + 1}</option>`).join('');
        html += `<label class="field"><span>${p.length > 1 ? `Kennel for cat group ${i + 1}` : 'Move to'}</span><select data-unit="${i}">${opts}</select></label>`;
      });
    }
    html += `<label class="check"><input type="checkbox" data-lock${b.locked ? ' checked' : ''}><span>Lock in place, so Optimise won\u2019t move it</span></label>`;
  }
  box.innerHTML = html;
}

$('where').addEventListener('change', e => {
  const b = byId(openId);
  if (!b) return;
  if (e.target.matches('[data-lock]')) {
    commit([{ ...b, locked: e.target.checked }], e.target.checked ? 'Locked in place.' : 'Unlocked. Optimise can move it now.');
    return;
  }
  const k = +e.target.value;
  if (e.target.matches('[data-pair]')) moveTo(b, { part: 'pair', ks: [] }, k);
  else {
    const unit = +e.target.dataset.unit;
    moveTo(b, { part: 'whole', unit, ks: [b.placement[unit][0].k] }, k);
  }
  setTimeout(() => byId(openId) && renderWhere(byId(openId)));
});

function openPanel(b) {
  openId = b?.id ?? null;
  $('panel-title').textContent = b ? b.name || 'Booking' : 'New booking';
  const v = b ?? store.blank({ arrive: isoDay(T + 1), depart: isoDay(T + 2) });
  for (const name of ['name', 'phone', 'email', 'arrive', 'depart', 'cat_names', 'diet', 'meds', 'notes']) form[name].value = v[name] ?? '';
  form.cats.value = v.cats;
  form.kennels.value = v.kennels;
  form.joined.checked = !!v.joined;
  form.new_customer.checked = !!v.new_customer;
  form.deposit_paid.checked = !!v.deposit_paid;
  form.bill_paid.checked = !!v.bill_paid;
  setTime('arrive', v.arrive_time);
  setTime('depart', v.depart_time);
  syncJoin();
  const contact = [];
  if (v.phone) contact.push(`<a href="tel:${esc(v.phone)}">Call</a>`, `<a href="sms:${esc(v.phone.replace(/[^\d+]/g, ''))}">Text</a>`);
  if (v.email) contact.push(`<a href="mailto:${esc(v.email)}">Email</a>`);
  $('contact').innerHTML = contact.join(' · ');
  $('contact').hidden = !contact.length;
  $('delete').hidden = !b;
  renderWhere(b);
  panel.hidden = false;
  if (!b) form.name.focus();
}

const closePanel = () => {
  panel.hidden = true;
  openId = null;
};
$('panel-close').addEventListener('click', closePanel);
$('cancel').addEventListener('click', closePanel);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !panel.hidden) closePanel();
  if (e.key === 'Escape') closuresPanel.hidden = true;
});

$('add').addEventListener('click', () => {
  if (preview) return toast('Apply or cancel the optimiser\u2019s changes first.');
  openPanel(null);
});

$('save').addEventListener('click', async () => {
  const fields = {
    name: form.name.value.trim(),
    phone: form.phone.value.trim(),
    email: form.email.value.trim(),
    arrive: form.arrive.value,
    depart: form.depart.value,
    arrive_time: getTime('arrive'),
    depart_time: getTime('depart'),
    cats: +form.cats.value,
    kennels: +form.kennels.value,
    joined: +form.kennels.value > 1 && form.joined.checked,
    cat_names: form.cat_names.value.trim(),
    diet: form.diet.value.trim(),
    meds: form.meds.value.trim(),
    notes: form.notes.value.trim(),
    new_customer: form.new_customer.checked,
    deposit_paid: form.deposit_paid.checked,
    bill_paid: form.bill_paid.checked
  };
  if (!fields.name) return toast('Add a name first.');
  if (!fields.arrive || !fields.depart || fields.depart <= fields.arrive) return toast('The leaving date needs to be after the arrival date.');
  if (fields.cats > fields.kennels * 2 + (fields.kennels === 1 ? 1 : 0)) return toast(`${plural(fields.cats, 'cat')} need more kennels than that.`);

  // Keep the kennel unless the stay changed shape, or new times clash with a neighbour

  const old = byId(openId);
  const reshaped = !old || ['arrive', 'depart', 'cats', 'kennels', 'joined'].some(f => String(old[f]) !== String(fields[f]));
  const updated = old ? { ...old, ...fields } : null;
  if (old && !reshaped && (!old.placement || !blockers(bookings.filter(o => o.id !== old.id), updated, old.placement).length)) {
    closePanel();
    return commit([updated], 'Saved.');
  }

  const row = old ? { ...updated, placement: null, locked: false } : store.blank(fields);
  const closed = closureDuring(row);
  if (closed && !confirm(`We're closed from ${niceDate(closed.closed_from)} until ${niceDate(closed.reopens)}, so this stay can't have a kennel. Save it anyway?`)) return;
  const list = bookings.filter(b => b.id !== row.id).concat(row);
  const res = plan(list, planOpts());
  const heldIds = res.holding.filter(id => id === row.id || res.changed.includes(id));
  if (heldIds.length) {
    const lines = heldIds.map(id => {
      const b = list.find(x => x.id === id);
      const h = holdNights(res.placements[id])[0];
      return `${b.name || 'A booking'} in ${kname(h.k)} from ${niceDate(h.from)} to ${niceDate(h.to)}`;
    });
    if (!confirm(`This only fits by using a holding pen:\n\n${lines.join('\n')}\n\nGo ahead?`)) return;
  }
  const changed = list
    .filter(b => b.id === row.id || res.changed.includes(b.id))
    .map(b => ({ ...b, placement: res.placements[b.id] }));
  const moved = changed.length - 1;
  const placed = changed.find(b => b.id === row.id);
  closePanel();
  const msg = placed.placement
    ? `${old ? 'Saved' : 'Added'}, in ${describe(placed).toLowerCase()}${moved ? `. ${plural(moved, 'other booking')} moved to make room` : ''}${heldIds.length ? '. Uses a holding pen' : ''}.`
    : 'Saved, but there\u2019s no room on those dates. It\u2019s listed above the board.';
  await commit(changed, msg);
  focusBooking(row.id, false);
});

$('delete').addEventListener('click', async () => {
  const b = byId(openId);
  if (!b || !confirm(`Delete the booking for ${b.name || 'this customer'}? This can\u2019t be undone.`)) return;
  closePanel();
  bookings = bookings.filter(x => x.id !== b.id);
  render();
  try {
    await store.remove(b.id);
    toast('Booking deleted.');
  } catch (err) {
    toast(`Couldn't delete: ${err.message}`);
    reload();
  }
});

// Optimise

$('optimise').addEventListener('click', async () => {
  if (preview) return;
  const btn = $('optimise');
  btn.disabled = true;
  btn.textContent = 'Optimising…';
  await nextFrame();
  const res = plan(bookings, planOpts({ mode: 'optimise' }));
  btn.disabled = false;
  btn.textContent = 'Optimise';
  if (!res.changed.length) return toast('The board is already in its best layout.');
  preview = {
    placements: res.placements,
    changed: new Set(res.changed),
    placedNow: res.changed.filter(id => !byId(id).placement).length,
    midStay: res.moves.filter(id => res.changed.includes(id)).length,
    held: res.holding.filter(id => res.changed.includes(id)).length,
    idx: 0
  };
  render();
  const first = [...preview.changed].map(byId).sort((x, y) => x.arrive.localeCompare(y.arrive))[0];
  focusBooking(first.id, false);
  preview.idx = 1;
});

async function applyPreview() {
  const rows = [...preview.changed].map(id => ({ ...byId(id), placement: preview.placements[id] }));
  preview = null;
  await commit(rows, `Moved ${plural(rows.length, 'booking')}.`);
}

// Holding pens toggle

$('holding').addEventListener('click', () => {
  holdingPref = !showHolding;
  measure();
  buildStatic();
  render();
});

// Closures

const closuresPanel = $('closures-panel');
const closureForm = $('closure-form');

function renderClosures() {
  const list = $('closure-list');
  const upcoming = closures.filter(c => c.reopens > TODAY);
  list.innerHTML = upcoming.length
    ? upcoming.map(c => `<li><span><b>${esc(niceDate(c.closed_from))}</b> until <b>${esc(niceDate(c.reopens))}</b>${c.note ? `<br><small>${esc(c.note)}</small>` : ''}</span>
        <button class="btn danger" type="button" data-remove="${c.id}">Remove</button></li>`).join('')
    : '<li class="muted">No closures coming up.</li>';
}

$('closures').addEventListener('click', () => {
  renderClosures();
  closureForm.closed_from.value = '';
  closureForm.reopens.value = '';
  closureForm.note.value = '';
  closuresPanel.hidden = false;
});
$('closures-close').addEventListener('click', () => (closuresPanel.hidden = true));

$('closure-add').addEventListener('click', async () => {
  const c = {
    id: crypto.randomUUID(),
    closed_from: closureForm.closed_from.value,
    reopens: closureForm.reopens.value,
    note: closureForm.note.value.trim()
  };
  if (!c.closed_from || !c.reopens || c.reopens <= c.closed_from) return toast('The reopening date needs to be after the first closed night.');
  const hit = bookings.filter(b => b.placement && b.arrive < c.reopens && c.closed_from < b.depart);
  if (hit.length && !confirm(`${plural(hit.length, 'booking')} already fall in these dates:\n\n${hit.map(b => `${b.name}, ${niceDate(b.arrive)} to ${niceDate(b.depart)}`).join('\n')}\n\nAdd the closure anyway?`)) return;
  try {
    await store.saveClosure(c);
  } catch (err) {
    return toast(`Couldn't save the closure: ${err.message}`);
  }
  closures = [...closures, c].sort((x, y) => x.closed_from.localeCompare(y.closed_from));
  renderClosures();
  closureForm.closed_from.value = '';
  closureForm.reopens.value = '';
  closureForm.note.value = '';
  buildStatic();
  render();
  toast(`Closed from ${niceDate(c.closed_from)} until ${niceDate(c.reopens)}.`);
});

$('closure-list').addEventListener('click', async e => {
  const id = e.target.closest('[data-remove]')?.dataset.remove;
  if (!id) return;
  try {
    await store.removeClosure(id);
  } catch (err) {
    return toast(`Couldn't remove it: ${err.message}`);
  }
  closures = closures.filter(c => c.id !== id);
  renderClosures();
  buildStatic();
  render();
});

// Start up

window.addEventListener('focus', () => {
  if (!$('app').hidden && panel.hidden && closuresPanel.hidden && !preview && !drag) reload();
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if ($('app').hidden) return;
    const day = topDay();
    measure();
    buildStatic();
    render();
    scrollToDay(day, false);
  }, 150);
});

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const err = $('login-error');
  err.hidden = true;
  try {
    await store.signIn(f.email.value.trim(), f.password.value);
    showApp();
  } catch (error) {
    err.textContent = error.message || 'Couldn\u2019t sign in.';
    err.hidden = false;
  }
});

$('signout').addEventListener('click', async () => {
  await store.signOut();
  location.reload();
});
$('signout').hidden = store.demo;

async function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  try {
    bookings = await store.load();
  } catch (err) {
    toast(`Couldn't load bookings: ${err.message}`);
  }
  await loadClosures();
  measure();
  buildStatic();
  render();
  scrollToDay(T, false);
}

if (await store.signedIn()) showApp();
else $('login').hidden = false;
