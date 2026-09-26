-- QuizLab: robust per-user cloud deletion with tombstones.
-- This prevents stale/offline clients from recreating a course after the user deleted it.

create table if not exists public.quizlab_user_deleted_courses (
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  deleted_at timestamptz not null default now(),
  primary key(user_id, course_id)
);

alter table public.quizlab_user_deleted_courses enable row level security;
revoke all on table public.quizlab_user_deleted_courses from anon, authenticated;

create or replace function public.quizlab_course_blocked(target_course_id text)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    exists(
      select 1
      from public.quizlab_retired_courses r
      where r.course_id = target_course_id
    )
    or exists(
      select 1
      from public.quizlab_user_deleted_courses d
      where d.user_id = auth.uid()
        and d.course_id = target_course_id
    );
$$;

create or replace function public.quizlab_blocked_course_ids()
returns table (course_id text)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not public.quizlab_access_allowed() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select r.course_id from public.quizlab_retired_courses r
  union
  select d.course_id
  from public.quizlab_user_deleted_courses d
  where d.user_id = auth.uid();
end;
$$;

create or replace function public.quizlab_delete_my_course(target_course_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  bank_count bigint := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not public.quizlab_access_allowed() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(trim(target_course_id),'') = '' then
    raise exception 'invalid course id';
  end if;

  insert into public.quizlab_user_deleted_courses(user_id,course_id,deleted_at)
  values(auth.uid(),target_course_id,now())
  on conflict(user_id,course_id) do update
  set deleted_at=excluded.deleted_at;

  select count(*) into bank_count
  from public.quizlab_banks
  where owner_id=auth.uid()
    and course_id=target_course_id;

  delete from public.quizlab_banks
  where owner_id=auth.uid()
    and course_id=target_course_id;

  return jsonb_build_object(
    'course_id',target_course_id,
    'deleted_banks',bank_count
  );
end;
$$;

create or replace function public.quizlab_restore_my_course(target_course_id text)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not public.quizlab_access_allowed() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if exists(
    select 1 from public.quizlab_retired_courses r
    where r.course_id=target_course_id
  ) then
    raise exception 'course retired by administrator' using errcode = '42501';
  end if;

  delete from public.quizlab_user_deleted_courses
  where user_id=auth.uid()
    and course_id=target_course_id;

  return true;
end;
$$;

revoke all on function public.quizlab_course_blocked(text) from public;
revoke all on function public.quizlab_blocked_course_ids() from public;
revoke all on function public.quizlab_delete_my_course(text) from public;
revoke all on function public.quizlab_restore_my_course(text) from public;

grant execute on function public.quizlab_course_blocked(text) to authenticated;
grant execute on function public.quizlab_blocked_course_ids() to authenticated;
grant execute on function public.quizlab_delete_my_course(text) to authenticated;
grant execute on function public.quizlab_restore_my_course(text) to authenticated;

-- Defense in depth: a stale device is not allowed to recreate a deleted/retired course.
drop policy if exists "banks_owner_or_shared_select" on public.quizlab_banks;
create policy "banks_owner_or_shared_select" on public.quizlab_banks
for select to authenticated
using (
  (auth.uid() = owner_id or is_shared = true)
  and public.quizlab_access_allowed()
  and not public.quizlab_course_blocked(course_id)
);

drop policy if exists "banks_owner_insert" on public.quizlab_banks;
create policy "banks_owner_insert" on public.quizlab_banks
for insert to authenticated
with check (
  auth.uid() = owner_id
  and public.quizlab_access_allowed()
  and not public.quizlab_course_blocked(course_id)
);

drop policy if exists "banks_owner_update" on public.quizlab_banks;
create policy "banks_owner_update" on public.quizlab_banks
for update to authenticated
using (
  auth.uid() = owner_id
  and public.quizlab_access_allowed()
  and not public.quizlab_course_blocked(course_id)
)
with check (
  auth.uid() = owner_id
  and public.quizlab_access_allowed()
  and not public.quizlab_course_blocked(course_id)
);
