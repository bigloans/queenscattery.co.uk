// Booking storage. Uses Supabase when config.js is filled in, otherwise this browser.

import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { plan } from './planner.js';

export const demo = !SUPABASE_URL || !SUPABASE_KEY;

const LOCAL = 'qc-demo-bookings';
const LOCAL_CLOSURES = 'qc-demo-closures';
let client;

const db = async () => {
  if (!client) {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
    client = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return client;
};

const browserList = key => ({
  read() {
    try {
      return JSON.parse(localStorage.getItem(key)) || [];
    } catch {
      return [];
    }
  },
  write(list) {
    try {
      localStorage.setItem(key, JSON.stringify(list));
    } catch {}
  }
});
const local = browserList(LOCAL);
const localClosures = browserList(LOCAL_CLOSURES);

export async function signedIn() {
  if (demo) return true;
  const { data } = await (await db()).auth.getSession();
  return !!data.session;
}

export async function signIn(email, password) {
  const { error } = await (await db()).auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut() {
  if (!demo) await (await db()).auth.signOut();
}

// Columns added after launch. Until the SQL for them has run, saves leave them out.

const LATER = ['arrive_time', 'depart_time', 'deposit_paid', 'bill_paid'];
export let hasLaterColumns = true;

export async function load() {
  if (demo) return local.read();
  const client = await db();
  const probe = await client.from('bookings').select(LATER.join(',')).limit(1);
  hasLaterColumns = !probe.error;
  const { data, error } = await client.from('bookings').select('*').order('arrive');
  if (error) throw error;
  return data.map(b => ({ arrive_time: '', depart_time: '', deposit_paid: false, bill_paid: false, ...b }));
}

export async function save(rows) {
  rows = [].concat(rows).map(r => ({ ...r, updated_at: new Date().toISOString() }));
  if (!rows.length) return;
  if (demo) {
    const all = local.read();
    for (const r of rows) {
      const i = all.findIndex(x => x.id === r.id);
      if (i < 0) all.push(r);
      else all[i] = r;
    }
    local.write(all);
    return;
  }
  if (!hasLaterColumns) rows = rows.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !LATER.includes(k))));
  const { error } = await (await db()).from('bookings').upsert(rows);
  if (error) throw error;
}

export async function remove(id) {
  if (demo) return local.write(local.read().filter(b => b.id !== id));
  const { error } = await (await db()).from('bookings').delete().eq('id', id);
  if (error) throw error;
}

// Closures, as {id, closed_from, reopens, note}. The cattery is shut from the night of
// closed_from up to the day it reopens.

export async function loadClosures() {
  if (demo) return localClosures.read();
  const { data, error } = await (await db()).from('closures').select('*').order('closed_from');
  if (error) throw error;
  return data;
}

export async function saveClosure(c) {
  if (demo) return localClosures.write(localClosures.read().filter(x => x.id !== c.id).concat(c));
  const { error } = await (await db()).from('closures').upsert(c);
  if (error) throw error;
}

export async function removeClosure(id) {
  if (demo) return localClosures.write(localClosures.read().filter(x => x.id !== id));
  const { error } = await (await db()).from('closures').delete().eq('id', id);
  if (error) throw error;
}

export const closedNights = list => list.map(c => ({ from: c.closed_from, to: c.reopens, note: c.note }));

export const blank = fields => ({
  id: crypto.randomUUID(),
  source: null,
  name: '',
  email: '',
  phone: '',
  cats: 1,
  cat_names: '',
  kennels: 1,
  joined: false,
  arrive: '',
  depart: '',
  arrive_time: '',
  depart_time: '',
  deposit_paid: false,
  bill_paid: false,
  diet: '',
  meds: '',
  notes: '',
  new_customer: false,
  placement: null,
  locked: false,
  created_at: new Date().toISOString(),
  ...fields
});

// Add bookings and give them kennels. Others only move if that's the only way to fit them.
// Returns the saved rows, the ids that moved, and the ids that didn't fit.

export async function addAndPlace(rows, all, closures) {
  all ??= await load();
  closures ??= await loadClosures().catch(() => []);
  const list = [...all, ...rows];
  const res = plan(list, { closures: closedNights(closures) });
  const added = new Set(rows.map(r => r.id));
  const out = list
    .filter(b => added.has(b.id) || res.changed.includes(b.id))
    .map(b => ({ ...b, placement: res.placements[b.id] }));
  await save(out);
  return {
    rows: out,
    moved: res.changed.filter(id => !added.has(id)),
    unplaced: res.unplaced.filter(id => added.has(id)),
    holding: res.holding.filter(id => added.has(id) || res.changed.includes(id))
  };
}
