-- Toolbox schema. Run this in the Supabase SQL Editor (Dashboard → SQL Editor).
--
-- User accounts and passwords are handled by Supabase Auth (auth.users);
-- passwords are stored as bcrypt hashes by Supabase — never in plain text.
-- This table only stores per-user, per-utility config blobs.

create table if not exists public.utility_configs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  utility_id text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, utility_id)
);

-- Keep updated_at fresh on every change.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists utility_configs_set_updated_at on public.utility_configs;
create trigger utility_configs_set_updated_at
  before update on public.utility_configs
  for each row execute function public.set_updated_at();

-- Row Level Security: users can only ever see and modify their own configs.
alter table public.utility_configs enable row level security;

create policy "Users can read own configs"
  on public.utility_configs for select
  using (auth.uid() = user_id);

create policy "Users can insert own configs"
  on public.utility_configs for insert
  with check (auth.uid() = user_id);

create policy "Users can update own configs"
  on public.utility_configs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own configs"
  on public.utility_configs for delete
  using (auth.uid() = user_id);
