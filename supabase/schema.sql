-- Run once in Supabase, SQL editor. Replace OWNER_EMAIL with the login's email address first.

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  source text unique,
  name text not null default '',
  email text not null default '',
  phone text not null default '',
  cats int not null default 1 check (cats between 1 and 9),
  cat_names text not null default '',
  kennels int not null default 1 check (kennels between 1 and 6),
  joined boolean not null default false,
  arrive date not null,
  depart date not null check (depart > arrive),
  diet text not null default '',
  meds text not null default '',
  notes text not null default '',
  new_customer boolean not null default false,
  placement jsonb,
  locked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bookings enable row level security;

create policy "Owner only" on public.bookings
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'OWNER_EMAIL')
  with check ((auth.jwt() ->> 'email') = 'OWNER_EMAIL');
