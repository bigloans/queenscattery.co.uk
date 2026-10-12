// Booking storage. Uses Supabase when config.js is filled in, otherwise this browser.

import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { plan } from './planner.js';

export const demo = !SUPABASE_URL || !SUPABASE_KEY;

const LOCAL = 'qc-demo-bookings';
let client;

const db = async () => {
  if (!client) {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
    client = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return client;
};

const local = {
  read() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL)) || [];
    } catch {
      return [];
    }
  },
  write(list) {
    try {
      localStorage.setItem(LOCAL, JSON.stringify(list));
    } catch {}
  }
};

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

export async function load() {
  if (demo) return local.read();
  const { data, error } = await (await db()).from('bookings').select('*').order('arrive');
  if (error) throw error;
  return data;
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
  const { error } = await (await db()).from('bookings').upsert(rows);
  if (error) throw error;
}

export async function remove(id) {
  if (demo) return local.write(local.read().filter(b => b.id !== id));
  const { error } = await (await db()).from('bookings').delete().eq('id', id);
  if (error) throw error;
}

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

export async function addAndPlace(rows, all) {
  all ??= await load();
  const list = [...all, ...rows];
  const res = plan(list);
  const added = new Set(rows.map(r => r.id));
  const out = list
    .filter(b => added.has(b.id) || res.changed.includes(b.id))
    .map(b => ({ ...b, placement: res.placements[b.id] }));
  await save(out);
  return {
    rows: out,
    moved: res.changed.filter(id => !added.has(id)),
    unplaced: res.unplaced.filter(id => added.has(id))
  };
}
