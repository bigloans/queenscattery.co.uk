import { KENNELS, PAIRS, mateOf, dayNum, isoDay, todayIso, plan, blockers } from '../app/planner.js';
import * as store from '../app/store.js';

const $ = id => document.getElementById(id);
const TODAY = todayIso();
const T = dayNum(TODAY);
const PALETTE = ['#dfe8d8', '#f3dfc9', '#d9e6ee', '#efd9df', '#e6e0f0', '#f2ecc6', '#d6ebe4', '#eadfd3'];

let bookings = [];
let preview = null;
let clashes = new Set();
let pieces = new Map();
let openId = null;
let start = T;
let end = T + 1;
let freeEls = [];

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

const allows15 = b => b.joined && +b.kennels === 2 && +b.cats <= 3;
const seg = (k, b) => ({ k, from: b.arrive, to: b.depart });
const placementOf = b => (preview ? preview.placements[b.id] : b.placement);
const isPair = p => p?.length === 2 && p.every(u => u.length === 1) && mateOf(p[0][0].k) === p[1][0].k;

// Layout

const L = { row: 28, dateW: 128, colW: 60, gap: 8, mobile: false };

function measure() {
  const css = getComputedStyle(document.documentElement);
  L.mobile = matchMedia('(max-width: 700px)').matches;
  L.row = parseFloat(css.getPropertyValue('--row'));
  L.dateW = parseFloat(css.getPropertyValue('--date-w'));
  L.gap = L.mobile ? 4 : 8;
  const room = $('scroller').clientWidth - L.dateW - 7 * L.gap - 4;
  L.colW = L.mobile ? 42 : Math.max(52, Math.min(110, Math.floor(room / KENNELS)));
}

const laneX = k => (k - 1) * L.colW + Math.floor((k - 1) / 2) * L.gap;
const lanesWidth = () => laneX(KENNELS) + L.colW;

function kennelAtX(x) {
  let best = 1;
  for (let k = 1; k <= KENNELS; k++) if (x >= laneX(k) - L.gap / 2) best = k;
  return best;
}

// Where a booking is, in words

function describe(b, p = placementOf(b)) {
  if (!p) return 'No kennel yet';
  if (p.length === 1 && p[0].length === 1 && p[0][0].k === 15 && +b.kennels === 2) return 'Kennel 15, in place of 2 joined kennels';
  if (isPair(p)) return `Kennels ${Math.min(p[0][0].k, p[1][0].k)} and ${Math.max(p[0][0].k, p[1][0].k)}, joined`;
  const parts = p.map(u => {
    if (u.length === 1) return `kennel ${u[0].k}`;
    return `kennel ${u[0].k}, moving to ${u[1].k} on ${niceDate(u[1].from)} and back on ${niceDate(u[1].to)}`;
  });
  const text = parts.join('; ');
  return text[0].toUpperCase() + text.slice(1);
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
    heads += `<div class="kh" style="left:${laneX(k)}px;width:${L.colW}px">${k}${k === 15 && !L.mobile ? '<small>up to 3 cats</small>' : ''}</div>`;
  }
  for (const [p] of PAIRS) heads += `<div class="pairline" style="left:${laneX(p) + 6}px;width:${2 * L.colW - 12}px" title="Kennels ${p} and ${p + 1} can be joined"></div>`;
  $('heads').innerHTML = heads;

  const dates = $('dates');
  dates.textContent = '';
  freeEls = [];
  const frag = document.createDocumentFragment();
  for (let n = start; n < end; n++) {
    const row = document.createElement('div');
    const dow = new Date(n * 864e5).getUTCDay();
    const first = new Date(n * 864e5).getUTCDate() === 1;
    row.className = `date${dow === 0 || dow === 6 ? ' weekend' : ''}${first ? ' month' : ''}${n === T ? ' today' : ''}${n < T ? ' past' : ''}`;
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

// Cards

function piecesOf(b, p) {
  const a = dayNum(b.arrive);
  const d = dayNum(b.depart);
  if (isPair(p)) return [{ ks: [p[0][0].k, p[1][0].k], a, d, part: 'pair', unit: 0 }];
  const out = [];
  p.forEach((u, unit) => {
    if (u.length === 1) {
      out.push({ ks: [u[0].k], a, d, part: p.length === 1 && u[0].k === 15 && +b.kennels === 2 ? 'pair' : 'whole', unit });
      return;
    }
    u.forEach((s, i) => out.push({ ks: [s.k], a: dayNum(s.from), d: dayNum(s.to), part: i === 1 ? 'away' : 'home', unit, home: u[0].k, away: u[1].k, back: u[1].to }));
  });
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
  const width = laneX(hi) + L.colW - laneX(lo) - 4;
  const top = (piece.a - start) * L.row + 1;
  const height = (piece.d - piece.a) * L.row - 2;
  const rows = piece.d - piece.a;
  const name = b.name || 'No name';
  const cats = b.cat_names || plural(+b.cats, 'cat');
  const p = placementOf(b);
  const classes = ['card'];
  if (piece.part === 'away') classes.push('away');
  if (clashes.has(b.id)) classes.push('clash');
  if (preview?.changed.has(b.id)) classes.push('changed');
  if (b.locked) classes.push('locked');

  let lines = `<b>${esc(name)}</b>`;
  if (piece.part === 'away') {
    lines = `<b>↪ ${esc(name)}</b>${rows > 1 ? `<span>Back to ${piece.home} ${esc(shortDate(dayNum(piece.back)))}</span>` : ''}`;
  } else {
    if (rows > 1) lines += `<span>${esc(cats)}</span>`;
    if (rows > 2) {
      lines += piece.d < dayNum(b.depart)
        ? `<span>To ${piece.away} ${esc(shortDate(piece.d))}</span>`
        : `<span>Leaves ${esc(shortDate(piece.d))}</span>`;
    }
  }
  const title = `${name} · ${cats} · ${niceDate(b.arrive)} to ${niceDate(b.depart)} · ${describe(b)}`;
  return `<div class="${classes.join(' ')}" tabindex="0" role="button" data-key="${key}" title="${esc(title)}"
    style="left:${left}px;width:${width}px;top:${top}px;height:${height}px;--c:${colourOf(b.id)}">${lines}</div>`;
}

function render() {
  const days = end - start;
  const lanes = $('lanes');
  lanes.style.width = `${lanesWidth()}px`;
  lanes.style.height = `${days * L.row}px`;

  // Occupancy, free counts and clashes

  const occ = Array.from({ length: days }, () => new Map());
  clashes = new Set();
  for (const b of bookings) {
    const p = placementOf(b);
    if (!p) continue;
    for (const u of p) {
      for (const s of u) {
        for (let t = Math.max(dayNum(s.from), start); t < Math.min(dayNum(s.to), end); t++) {
          const cell = occ[t - start];
          const other = cell.get(s.k);
          if (other && other !== b.id) clashes.add(other).add(b.id);
          cell.set(s.k, b.id);
        }
      }
    }
  }
  occ.forEach((cell, i) => {
    const free = KENNELS - cell.size;
    freeEls[i].textContent = free ? `${free} free` : 'Full';
    freeEls[i].classList.toggle('full', !free);
  });

  let html = '';
  for (let k = 1; k <= KENNELS; k++) html += `<div class="lane" style="left:${laneX(k)}px;width:${L.colW}px"></div>`;
  html += `<div class="band past" style="top:0;height:${(T - start) * L.row}px"></div>`;
  for (let n = start; n < end; n++) {
    const date = new Date(n * 864e5);
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) html += `<div class="band weekend" style="top:${(n - start) * L.row}px"></div>`;
    if (date.getUTCDate() === 1) html += `<div class="band month" style="top:${(n - start) * L.row}px"></div>`;
  }
  html += `<div class="band today" style="top:${(T - start) * L.row}px"></div>`;

  pieces = new Map();
  for (const b of bookings) {
    const p = placementOf(b);
    if (!p) continue;
    piecesOf(b, p).forEach((piece, i) => {
      const key = `${b.id}:${i}`;
      pieces.set(key, { b, piece });
      html += cardHtml(b, piece, key);
    });
  }
  lanes.innerHTML = html;
  renderNotices();
}

// Notices above the board

function renderNotices() {
  const out = [];
  if (store.demo) {
    out.push(`<div class="notice demo"><span class="grow">Demo mode. Bookings are saved in this browser only until Supabase is connected.</span></div>`);
  }
  if (preview) {
    const { changed, placedNow, midStay } = preview;
    const moved = changed.size - placedNow;
    const parts = [];
    if (moved) parts.push(`move ${plural(moved, 'booking')}`);
    if (placedNow) parts.push(`find kennels for ${placedNow} that ${placedNow === 1 ? 'has' : 'have'} none`);
    let text = `Optimise would ${parts.join(' and ')}.`;
    if (midStay) text += ` ${plural(midStay, 'booking')} would need a cat moved mid-stay.`;
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
  if (clashes.size) {
    const list = [...clashes].map(byId).filter(Boolean);
    out.push(`<div class="notice waiting"><span>These bookings share a kennel on some nights:</span>
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

async function reload() {
  try {
    bookings = await store.load();
  } catch (err) {
    return toast(`Couldn't load bookings: ${err.message}`);
  }
  const keepTop = scroller.scrollTop;
  const oldStart = start;
  buildStatic();
  render();
  scroller.scrollTop = keepTop + (start - oldStart) * L.row;
}

// Moving cards by hand

function selfOverlap(p) {
  const seen = new Map();
  for (const u of p) {
    for (const s of u) {
      for (let t = dayNum(s.from); t < dayNum(s.to); t++) {
        const key = `${s.k}:${t}`;
        if (seen.has(key)) return true;
        seen.set(key, 1);
      }
    }
  }
  return false;
}

function collapse(u) {
  return u.every(s => s.k === u[0].k) ? [{ k: u[0].k, from: u[0].from, to: u.at(-1).to }] : u;
}

// The placement a booking would have if this piece went to kennel k

function proposal(b, piece, k) {
  const p = structuredClone(placementOf(b));
  if (piece.part === 'pair') {
    if (k === 15) return allows15(b) ? [[seg(15, b)]] : null;
    const lo = k % 2 ? k : k - 1;
    return [[seg(lo, b)], [seg(lo + 1, b)]];
  }
  if (piece.part === 'whole') {
    if (+b.cats > 2 && +b.kennels === 1 && k !== 15) return null;
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
  return selfOverlap(p) ? null : p;
}

// Work out a hand move. If one other booking is in the way, try swapping it into the
// space this one leaves. Returns the rows to save, or an error to show.

function planMove(b, piece, k) {
  const p = proposal(b, piece, k);
  const name = b.name || 'That booking';
  if (!p) return { error: `${name} can't go in kennel ${k}.` };
  if (JSON.stringify(p) === JSON.stringify(b.placement)) return { same: true };
  const moved = { ...b, placement: p, locked: true };
  const others = bookings.filter(x => x.id !== b.id);
  const inWay = blockers(others, b.id, p);
  if (!inWay.length) {
    return { rows: [moved], message: `Moved ${name} to ${describe(moved, p).toLowerCase()}. It's locked, so Optimise leaves it there.` };
  }

  const from = piece.ks[0];
  const other = byId(inWay[0]);
  if (inWay.length === 1 && piece.part === 'whole' && from !== k && other.placement) {
    const op = other.placement.map(u => collapse(u.map(s => (s.k === k ? { ...s, k: from } : s))));
    const fits = !selfOverlap(op) && !(from !== 15 && +other.cats > 2 && +other.kennels === 1)
      && !blockers(others.filter(x => x.id !== other.id).concat(moved), other.id, op).length;
    if (fits) {
      return { swap: true, rows: [moved, { ...other, placement: op }], message: `Swapped ${name} with ${other.name || 'another booking'}.` };
    }
  }
  const names = inWay.map(id => byId(id)?.name || 'another booking');
  return { error: `Kennel ${k} is taken by ${names.slice(0, 2).join(' and ')}${names.length > 2 ? ' and others' : ''} on some of those nights.` };
}

function moveTo(b, piece, k) {
  const m = planMove(b, piece, k);
  if (m.error) toast(m.error);
  else if (m.rows) commit(m.rows, m.message);
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
  if (wide && k !== 15) k = k % 2 ? k : k - 1;
  drag.k = k;
  const width = wide && k !== 15 ? laneX(k + 1) + L.colW - laneX(k) - 4 : L.colW - 4;
  drag.ghost.style.left = `${laneX(k) + 2}px`;
  drag.ghost.style.width = `${width}px`;
  const m = planMove(drag.b, drag.piece, k);
  drag.ghost.classList.toggle('bad', !!m.error);
  drag.ghost.classList.toggle('swap', !!m.swap);
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
  if (preview) return toast('Apply or cancel the optimiser’s changes first.');
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

function renderWhere(b) {
  const where = $('where');
  const p = b?.placement;
  if (!b || !byId(b.id)) {
    where.innerHTML = '<p>Fill in the stay and save. The board finds the best kennel for it.</p>';
    return;
  }
  let html = p ? `<p><b>${esc(describe(b, p))}</b></p>` : '<p class="warn">No kennel yet. There’s no room on these dates as the board stands.</p>';
  if (p) {
    const options = isPair(p) || (p.length === 1 && +b.kennels === 2)
      ? [...PAIRS.map(([x, y]) => [x, `Kennels ${x} and ${y}`]), ...(allows15(b) ? [[15, 'Kennel 15']] : [])].map(([v, label]) => `<option value="${v}">${label}</option>`).join('')
      : null;
    if (options) {
      const cur = Math.min(...p.map(u => u[0].k));
      html += `<label class="field"><span>Move to</span><select data-pair>${options}</select></label>`;
      setTimeout(() => (where.querySelector('[data-pair]').value = cur));
    } else {
      p.forEach((u, i) => {
        if (u.length > 1) return;
        const opts = Array.from({ length: KENNELS }, (_, j) => `<option value="${j + 1}"${j + 1 === u[0].k ? ' selected' : ''}>Kennel ${j + 1}</option>`).join('');
        html += `<label class="field"><span>${p.length > 1 ? `Kennel for cat group ${i + 1}` : 'Move to'}</span><select data-unit="${i}">${opts}</select></label>`;
      });
    }
    html += `<label class="check"><input type="checkbox" data-lock${b.locked ? ' checked' : ''}><span>Lock in place, so Optimise won’t move it</span></label>`;
  }
  where.innerHTML = html;
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
});

$('add').addEventListener('click', () => {
  if (preview) return toast('Apply or cancel the optimiser’s changes first.');
  openPanel(null);
});

$('save').addEventListener('click', async () => {
  const fields = {
    name: form.name.value.trim(),
    phone: form.phone.value.trim(),
    email: form.email.value.trim(),
    arrive: form.arrive.value,
    depart: form.depart.value,
    cats: +form.cats.value,
    kennels: +form.kennels.value,
    joined: +form.kennels.value > 1 && form.joined.checked,
    cat_names: form.cat_names.value.trim(),
    diet: form.diet.value.trim(),
    meds: form.meds.value.trim(),
    notes: form.notes.value.trim(),
    new_customer: form.new_customer.checked
  };
  if (!fields.name) return toast('Add a name first.');
  if (!fields.arrive || !fields.depart || fields.depart <= fields.arrive) return toast('The leaving date needs to be after the arrival date.');
  if (fields.cats > fields.kennels * 2 + (fields.kennels === 1 ? 1 : 0)) return toast(`${plural(fields.cats, 'cat')} need more kennels than that.`);

  const old = byId(openId);
  const needsKennel = !old || ['arrive', 'depart', 'cats', 'kennels', 'joined'].some(f => String(old[f]) !== String(fields[f]));
  if (old && !needsKennel) {
    closePanel();
    return commit([{ ...old, ...fields }], 'Saved.');
  }

  const row = old ? { ...old, ...fields, placement: null, locked: false } : store.blank(fields);
  const list = bookings.filter(b => b.id !== row.id).concat(row);
  const res = plan(list);
  const changed = list
    .filter(b => b.id === row.id || res.changed.includes(b.id))
    .map(b => ({ ...b, placement: res.placements[b.id] }));
  const moved = changed.length - 1;
  const placed = changed.find(b => b.id === row.id);
  closePanel();
  const msg = placed.placement
    ? `${old ? 'Saved' : 'Added'}, in ${describe(placed).toLowerCase()}${moved ? `. ${plural(moved, 'other booking')} moved to make room` : ''}.`
    : 'Saved, but there’s no room on those dates. It’s listed above the board.';
  await commit(changed, msg);
  focusBooking(row.id, false);
});

$('delete').addEventListener('click', async () => {
  const b = byId(openId);
  if (!b || !confirm(`Delete the booking for ${b.name || 'this customer'}? This can’t be undone.`)) return;
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
  const res = plan(bookings, { mode: 'optimise' });
  btn.disabled = false;
  btn.textContent = 'Optimise';
  if (!res.changed.length) return toast('The board is already in its best layout.');
  preview = {
    placements: res.placements,
    changed: new Set(res.changed),
    placedNow: res.changed.filter(id => !byId(id).placement).length,
    midStay: res.moves.filter(id => res.changed.includes(id)).length,
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

// Start up

window.addEventListener('focus', () => {
  if (!$('app').hidden && panel.hidden && !preview && !drag) reload();
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
    err.textContent = error.message || 'Couldn’t sign in.';
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
  measure();
  buildStatic();
  render();
  scrollToDay(T, false);
}

if (await store.signedIn()) showApp();
else $('login').hidden = false;
