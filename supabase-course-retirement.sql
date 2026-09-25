-- QuizLab: global course retirement managed by admin.
create table if not exists public.quizlab_retired_courses (
  course_id text primary key,
  subject text,
  retired_at timestamptz not null default now(),
  retired_by uuid not null references auth.users(id)
);

alter table public.quizlab_retired_courses enable row level security;
revoke all on table public.quizlab_retired_courses from anon, authenticated;

create or replace function public.quizlab_retired_course_ids()
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
  select r.course_id
  from public.quizlab_retired_courses r
  order by r.retired_at desc;
end;
$$;

create or replace function public.quizlab_admin_retire_course(target_course_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  bank_count bigint := 0;
  progress_count bigint := 0;
  subject_name text := null;
begin
  if not public.quizlab_is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(trim(target_course_id),'') = '' then
    raise exception 'invalid course id';
  end if;

  select count(*), max(b.subject)
    into bank_count, subject_name
  from public.quizlab_banks b
  where b.course_id = target_course_id;

  select count(*)
    into progress_count
  from public.quizlab_user_courses uc
  join public.quizlab_banks b on b.id = uc.bank_id
  where b.course_id = target_course_id;

  insert into public.quizlab_retired_courses(course_id,subject,retired_at,retired_by)
  values(target_course_id,subject_name,now(),auth.uid())
  on conflict(course_id) do update
  set subject=excluded.subject,
      retired_at=excluded.retired_at,
      retired_by=excluded.retired_by;

  delete from public.quizlab_banks
  where course_id = target_course_id;

  return jsonb_build_object(
    'course_id', target_course_id,
    'subject', subject_name,
    'deleted_banks', bank_count,
    'deleted_progress', progress_count
  );
end;
$$;

revoke all on function public.quizlab_retired_course_ids() from public;
revoke all on function public.quizlab_admin_retire_course(text) from public;
grant execute on function public.quizlab_retired_course_ids() to authenticated;
grant execute on function public.quizlab_admin_retire_course(text) to authenticated;
