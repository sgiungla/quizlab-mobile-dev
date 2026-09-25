-- QuizLab / Sgiungla - amministrazione sicura
-- Da eseguire nel SQL Editor di Supabase DOPO supabase-schema.sql.
-- ATTENZIONE: la tabella quizlab_admins parte vuota.
-- L'amministratore viene aggiunto esplicitamente tramite UUID auth.users.

create table if not exists public.quizlab_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.quizlab_user_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active','suspended')),
  note text,
  updated_at timestamptz not null default now()
);

alter table public.quizlab_admins enable row level security;
alter table public.quizlab_user_access enable row level security;

drop policy if exists "admins_self_select" on public.quizlab_admins;
create policy "admins_self_select" on public.quizlab_admins
for select to authenticated using (auth.uid() = user_id);

drop policy if exists "access_self_select" on public.quizlab_user_access;
create policy "access_self_select" on public.quizlab_user_access
for select to authenticated using (auth.uid() = user_id);

grant select on table public.quizlab_admins to authenticated;
grant select on table public.quizlab_user_access to authenticated;
revoke all on table public.quizlab_admins from anon;
revoke all on table public.quizlab_user_access from anon;

create or replace function public.quizlab_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.quizlab_admins a
    where a.user_id = auth.uid()
  );
$$;

create or replace function public.quizlab_account_status()
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce(
    (select ua.status from public.quizlab_user_access ua where ua.user_id = auth.uid()),
    'active'
  );
$$;

create or replace function public.quizlab_access_allowed()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.quizlab_account_status() = 'active';
$$;

revoke all on function public.quizlab_is_admin() from public;
revoke all on function public.quizlab_account_status() from public;
revoke all on function public.quizlab_access_allowed() from public;
grant execute on function public.quizlab_is_admin() to authenticated;
grant execute on function public.quizlab_account_status() to authenticated;
grant execute on function public.quizlab_access_allowed() to authenticated;

-- Applica la sospensione anche alle normali tabelle QuizLab.
drop policy if exists "profiles_own_select" on public.quizlab_profiles;
create policy "profiles_own_select" on public.quizlab_profiles
for select to authenticated
using (auth.uid() = user_id and public.quizlab_access_allowed());

drop policy if exists "profiles_own_write" on public.quizlab_profiles;
create policy "profiles_own_write" on public.quizlab_profiles
for all to authenticated
using (auth.uid() = user_id and public.quizlab_access_allowed())
with check (auth.uid() = user_id and public.quizlab_access_allowed());

drop policy if exists "banks_owner_or_shared_select" on public.quizlab_banks;
create policy "banks_owner_or_shared_select" on public.quizlab_banks
for select to authenticated
using ((auth.uid() = owner_id or is_shared = true) and public.quizlab_access_allowed());

drop policy if exists "banks_owner_insert" on public.quizlab_banks;
create policy "banks_owner_insert" on public.quizlab_banks
for insert to authenticated
with check (auth.uid() = owner_id and public.quizlab_access_allowed());

drop policy if exists "banks_owner_update" on public.quizlab_banks;
create policy "banks_owner_update" on public.quizlab_banks
for update to authenticated
using (auth.uid() = owner_id and public.quizlab_access_allowed())
with check (auth.uid() = owner_id and public.quizlab_access_allowed());

drop policy if exists "banks_owner_delete" on public.quizlab_banks;
create policy "banks_owner_delete" on public.quizlab_banks
for delete to authenticated
using (auth.uid() = owner_id and public.quizlab_access_allowed());

drop policy if exists "user_courses_own" on public.quizlab_user_courses;
create policy "user_courses_own" on public.quizlab_user_courses
for all to authenticated
using (auth.uid() = user_id and public.quizlab_access_allowed())
with check (auth.uid() = user_id and public.quizlab_access_allowed());

drop policy if exists "devices_own" on public.quizlab_devices;
create policy "devices_own" on public.quizlab_devices
for all to authenticated
using (auth.uid() = user_id and public.quizlab_access_allowed())
with check (auth.uid() = user_id and public.quizlab_access_allowed());

create or replace function public.quizlab_admin_storage_overview()
returns table (
  database_bytes bigint,
  banks_table_bytes bigint,
  progress_table_bytes bigint,
  banks_json_bytes bigint,
  progress_json_bytes bigint
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.quizlab_is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select
    pg_database_size(current_database())::bigint,
    pg_total_relation_size('public.quizlab_banks'::regclass)::bigint,
    pg_total_relation_size('public.quizlab_user_courses'::regclass)::bigint,
    coalesce((select sum(octet_length(bank_json::text)) from public.quizlab_banks),0)::bigint,
    coalesce((select sum(octet_length(progress_json::text)) from public.quizlab_user_courses),0)::bigint;
end;
$$;

create or replace function public.quizlab_admin_user_overview()
returns table (
  user_id uuid,
  email text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  last_seen timestamptz,
  account_status text,
  course_count bigint,
  attempt_count bigint,
  exam_count bigint
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.quizlab_is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select
    u.id,
    u.email::text,
    u.created_at,
    u.last_sign_in_at,
    max(d.last_seen),
    coalesce(max(ua.status),'active')::text,
    count(distinct uc.bank_id)::bigint,
    coalesce(sum(
      case when jsonb_typeof(uc.progress_json->'attempts') = 'array'
      then jsonb_array_length(uc.progress_json->'attempts') else 0 end
    ),0)::bigint,
    coalesce(sum(
      case when jsonb_typeof(uc.progress_json->'exams') = 'array'
      then jsonb_array_length(uc.progress_json->'exams') else 0 end
    ),0)::bigint
  from auth.users u
  left join public.quizlab_devices d on d.user_id = u.id
  left join public.quizlab_user_access ua on ua.user_id = u.id
  left join public.quizlab_user_courses uc on uc.user_id = u.id
  group by u.id,u.email,u.created_at,u.last_sign_in_at
  order by max(d.last_seen) desc nulls last, u.created_at desc;
end;
$$;

create or replace function public.quizlab_admin_set_user_status(
  target_user uuid,
  new_status text
)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.quizlab_is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if new_status not in ('active','suspended') then
    raise exception 'invalid status';
  end if;
  if target_user = auth.uid() and new_status = 'suspended' then
    raise exception 'cannot suspend the current administrator';
  end if;

  insert into public.quizlab_user_access(user_id,status,updated_at)
  values(target_user,new_status,now())
  on conflict(user_id) do update
  set status=excluded.status, updated_at=excluded.updated_at;

  return new_status;
end;
$$;

revoke all on function public.quizlab_admin_storage_overview() from public;
revoke all on function public.quizlab_admin_user_overview() from public;
revoke all on function public.quizlab_admin_set_user_status(uuid,text) from public;
grant execute on function public.quizlab_admin_storage_overview() to authenticated;
grant execute on function public.quizlab_admin_user_overview() to authenticated;
grant execute on function public.quizlab_admin_set_user_status(uuid,text) to authenticated;

-- DOPO aver copiato l'UUID del tuo account, esegui UNA VOLTA:
-- insert into public.quizlab_admins(user_id) values ('INCOLLA-QUI-IL-TUO-UUID') on conflict do nothing;
