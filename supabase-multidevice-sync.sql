-- QuizLab v0.7: optimistic concurrency control for multi-device progress sync.
-- Existing tables/data are preserved. This adds an atomic save RPC only.

create or replace function public.quizlab_save_progress_v2(
  target_bank_id uuid,
  expected_revision bigint,
  incoming_progress jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  current_row public.quizlab_user_courses%rowtype;
  target_course_id text;
  next_revision bigint;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if not public.quizlab_access_allowed() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select b.course_id
    into target_course_id
  from public.quizlab_banks b
  where b.id = target_bank_id
    and b.owner_id = auth.uid();

  if target_course_id is null then
    raise exception 'bank not found or forbidden' using errcode = '42501';
  end if;

  if public.quizlab_course_blocked(target_course_id) then
    raise exception 'course blocked' using errcode = '42501';
  end if;

  select *
    into current_row
  from public.quizlab_user_courses uc
  where uc.user_id = auth.uid()
    and uc.bank_id = target_bank_id
  for update;

  if not found then
    if coalesce(expected_revision, 0) <> 0 then
      return jsonb_build_object(
        'ok', false,
        'conflict', true,
        'revision', 0,
        'progress', '{}'::jsonb
      );
    end if;

    insert into public.quizlab_user_courses(
      user_id,
      bank_id,
      progress_json,
      revision,
      updated_at
    )
    values(
      auth.uid(),
      target_bank_id,
      coalesce(incoming_progress, '{}'::jsonb),
      1,
      now()
    );

    return jsonb_build_object(
      'ok', true,
      'conflict', false,
      'revision', 1,
      'progress', coalesce(incoming_progress, '{}'::jsonb)
    );
  end if;

  if current_row.revision <> coalesce(expected_revision, 0) then
    return jsonb_build_object(
      'ok', false,
      'conflict', true,
      'revision', current_row.revision,
      'progress', current_row.progress_json,
      'updated_at', current_row.updated_at
    );
  end if;

  next_revision := current_row.revision + 1;

  update public.quizlab_user_courses
  set progress_json = coalesce(incoming_progress, '{}'::jsonb),
      revision = next_revision,
      updated_at = now()
  where user_id = auth.uid()
    and bank_id = target_bank_id;

  return jsonb_build_object(
    'ok', true,
    'conflict', false,
    'revision', next_revision,
    'progress', coalesce(incoming_progress, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.quizlab_save_progress_v2(uuid,bigint,jsonb) from public;
grant execute on function public.quizlab_save_progress_v2(uuid,bigint,jsonb) to authenticated;
