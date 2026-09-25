-- QuizLab / Sgiungla cloud schema (Supabase)
-- Apply in Supabase SQL Editor only after creating the project.
-- RLS keeps each user's profile/progress private. Banks can optionally be shared later.

create extension if not exists pgcrypto;

create table if not exists public.quizlab_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_url text,
  motto text not null default 'La giungla universitaria è sotto controllo.',
  updated_at timestamptz not null default now()
);

create table if not exists public.quizlab_banks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  subject text not null,
  bank_json jsonb not null default '{}'::jsonb,
  bank_hash text,
  is_shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, course_id)
);

create table if not exists public.quizlab_user_courses (
  user_id uuid not null references auth.users(id) on delete cascade,
  bank_id uuid not null references public.quizlab_banks(id) on delete cascade,
  progress_json jsonb not null default '{}'::jsonb,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key(user_id, bank_id)
);

create table if not exists public.quizlab_devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  last_seen timestamptz not null default now(),
  last_push_at timestamptz,
  last_pull_at timestamptz,
  primary key(user_id, client_id)
);

alter table public.quizlab_profiles enable row level security;
alter table public.quizlab_banks enable row level security;
alter table public.quizlab_user_courses enable row level security;
alter table public.quizlab_devices enable row level security;

drop policy if exists "profiles_own_select" on public.quizlab_profiles;
create policy "profiles_own_select" on public.quizlab_profiles
for select using (auth.uid() = user_id);

drop policy if exists "profiles_own_write" on public.quizlab_profiles;
create policy "profiles_own_write" on public.quizlab_profiles
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "banks_owner_or_shared_select" on public.quizlab_banks;
create policy "banks_owner_or_shared_select" on public.quizlab_banks
for select using (auth.uid() = owner_id or is_shared = true);

drop policy if exists "banks_owner_insert" on public.quizlab_banks;
create policy "banks_owner_insert" on public.quizlab_banks
for insert with check (auth.uid() = owner_id);

drop policy if exists "banks_owner_update" on public.quizlab_banks;
create policy "banks_owner_update" on public.quizlab_banks
for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "banks_owner_delete" on public.quizlab_banks;
create policy "banks_owner_delete" on public.quizlab_banks
for delete using (auth.uid() = owner_id);

drop policy if exists "user_courses_own" on public.quizlab_user_courses;
create policy "user_courses_own" on public.quizlab_user_courses
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "devices_own" on public.quizlab_devices;
create policy "devices_own" on public.quizlab_devices
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists quizlab_banks_course_idx on public.quizlab_banks(course_id);
create index if not exists quizlab_user_courses_user_idx on public.quizlab_user_courses(user_id);
