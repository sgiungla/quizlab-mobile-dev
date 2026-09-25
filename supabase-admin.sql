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
  status text not null default 'pending' check (status in ('pending','active','suspended')),
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
  select case
    when public.quizlab_is_admin() then 'active'
    else coalesce(
      (select ua.status from public.quizlab_user_access ua where ua.user_id = auth.uid()),
      'pending'
    )
  end;
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
    (select max(d.last_seen) from public.quizlab_devices d where d.user_id=u.id),
    case
      when exists(select 1 from public.quizlab_admins a where a.user_id=u.id) then 'active'
      else coalesce((select ua.status from public.quizlab_user_access ua where ua.user_id=u.id),'pending')
    end::text,
    (select count(*) from public.quizlab_user_courses uc where uc.user_id=u.id)::bigint,
    coalesce((select sum(case when jsonb_typeof(uc.progress_json->'attempts')='array' then jsonb_array_length(uc.progress_json->'attempts') else 0 end) from public.quizlab_user_courses uc where uc.user_id=u.id),0)::bigint,
    coalesce((select sum(case when jsonb_typeof(uc.progress_json->'exams')='array' then jsonb_array_length(uc.progress_json->'exams') else 0 end) from public.quizlab_user_courses uc where uc.user_id=u.id),0)::bigint
  from auth.users u
  order by (select max(d.last_seen) from public.quizlab_devices d where d.user_id=u.id) desc nulls last, u.created_at desc;
end;
$$;

create or replace function public.quizlab_admin_user_course_stats()
returns table (
  user_id uuid,
  course_id text,
  subject text,
  attempt_count bigint,
  unique_question_count bigint,
  correct_count bigint,
  accuracy_pct numeric,
  exam_count bigint,
  avg_exam_grade numeric,
  best_exam_grade numeric,
  full_seen_count bigint,
  pending_review_count bigint,
  marked_count bigint,
  last_activity timestamptz
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
    uc.user_id,
    b.course_id,
    b.subject,
    case when jsonb_typeof(uc.progress_json->'attempts')='array' then jsonb_array_length(uc.progress_json->'attempts') else 0 end::bigint,
    coalesce((
      select count(distinct a->>'questionId')
      from jsonb_array_elements(case when jsonb_typeof(uc.progress_json->'attempts')='array' then uc.progress_json->'attempts' else '[]'::jsonb end) a
      where coalesce(a->>'questionId','') <> ''
    ),0)::bigint,
    coalesce((
      select count(*)
      from (
        select distinct on (a->>'questionId') a
        from jsonb_array_elements(case when jsonb_typeof(uc.progress_json->'attempts')='array' then uc.progress_json->'attempts' else '[]'::jsonb end) a
        where coalesce(a->>'questionId','') <> ''
        order by a->>'questionId', coalesce(a->>'at','') desc
      ) latest
      where lower(coalesce(latest.a->>'correct','false'))='true'
    ),0)::bigint,
    coalesce((
      select round(
        100.0 * count(*) filter (where lower(coalesce(latest.a->>'correct','false'))='true')
        / nullif(count(*),0),
        1
      )
      from (
        select distinct on (a->>'questionId') a
        from jsonb_array_elements(case when jsonb_typeof(uc.progress_json->'attempts')='array' then uc.progress_json->'attempts' else '[]'::jsonb end) a
        where coalesce(a->>'questionId','') <> ''
        order by a->>'questionId', coalesce(a->>'at','') desc
      ) latest
    ),0)::numeric,
    case when jsonb_typeof(uc.progress_json->'exams')='array' then jsonb_array_length(uc.progress_json->'exams') else 0 end::bigint,
    (
      select round(avg(nullif(e->>'grade','')::numeric),1)
      from jsonb_array_elements(case when jsonb_typeof(uc.progress_json->'exams')='array' then uc.progress_json->'exams' else '[]'::jsonb end) e
      where coalesce(e->>'grade','') ~ '^[0-9]+([.][0-9]+)?$'
    ),
    (
      select max(nullif(e->>'grade','')::numeric)
      from jsonb_array_elements(case when jsonb_typeof(uc.progress_json->'exams')='array' then uc.progress_json->'exams' else '[]'::jsonb end) e
      where coalesce(e->>'grade','') ~ '^[0-9]+([.][0-9]+)?$'
    ),
    case when jsonb_typeof(uc.progress_json#>'{fullCampaign,seenIds}')='array' then jsonb_array_length(uc.progress_json#>'{fullCampaign,seenIds}') else 0 end::bigint,
    case when jsonb_typeof(uc.progress_json->'pendingReview')='array' then jsonb_array_length(uc.progress_json->'pendingReview') else 0 end::bigint,
    case when jsonb_typeof(uc.progress_json->'marked')='array' then jsonb_array_length(uc.progress_json->'marked') else 0 end::bigint,
    uc.updated_at
  from public.quizlab_user_courses uc
  join public.quizlab_banks b on b.id=uc.bank_id
  order by uc.updated_at desc;
end;
$$;

revoke all on function public.quizlab_admin_user_course_stats() from public;
grant execute on function public.quizlab_admin_user_course_stats() to authenticated;

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
  if new_status not in ('pending','active','suspended') then
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

create or replace function public.quizlab_register_pending_user()
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if public.quizlab_is_admin() then
    return 'active';
  end if;

  insert into public.quizlab_user_access(user_id,status,updated_at)
  values(auth.uid(),'pending',now())
  on conflict(user_id) do nothing;

  return public.quizlab_account_status();
end;
$$;

revoke all on function public.quizlab_register_pending_user() from public;
grant execute on function public.quizlab_register_pending_user() to authenticated;

-- DOPO aver copiato l'UUID del tuo account, esegui UNA VOLTA:
-- insert into public.quizlab_admins(user_id) values ('INCOLLA-QUI-IL-TUO-UUID') on conflict do nothing;
