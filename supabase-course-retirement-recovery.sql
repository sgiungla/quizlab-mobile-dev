-- QuizLab: admin recovery for globally retired courses.
-- Restoring a course only removes the global tombstone; deleted banks/progress are not recreated.
-- A backup/import is still required to repopulate the course.

create or replace function public.quizlab_admin_retired_courses()
returns table (
  course_id text,
  subject text,
  retired_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.quizlab_is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select r.course_id, r.subject, r.retired_at
  from public.quizlab_retired_courses r
  order by r.retired_at desc;
end;
$$;

create or replace function public.quizlab_admin_restore_course(target_course_id text)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.quizlab_is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if coalesce(trim(target_course_id),'') = '' then
    raise exception 'invalid course id';
  end if;

  delete from public.quizlab_retired_courses
  where course_id = target_course_id;

  return true;
end;
$$;

revoke all on function public.quizlab_admin_retired_courses() from public;
revoke all on function public.quizlab_admin_restore_course(text) from public;

grant execute on function public.quizlab_admin_retired_courses() to authenticated;
grant execute on function public.quizlab_admin_restore_course(text) to authenticated;
