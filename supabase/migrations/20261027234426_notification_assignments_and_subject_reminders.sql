-- Additive notification outbox; no changes to the assignment RPC or study data.
create table if not exists public.quizlab_assignment_events (
 bank_id uuid primary key references public.quizlab_banks(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 course_id text not null,
 revision bigint not null,
 created_at timestamptz not null default now(),
 processed_at timestamptz
);
alter table public.quizlab_assignment_events enable row level security;
revoke all on public.quizlab_assignment_events from public,anon,authenticated;
create index if not exists quizlab_assignment_events_pending on public.quizlab_assignment_events(user_id,created_at) where processed_at is null;

create or replace function public.quizlab_capture_assignment_event()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.managed_by_admin and new.assigned_by is not null then
  if exists(select 1 from public.quizlab_admins where user_id=new.assigned_by) then
   insert into public.quizlab_assignment_events(bank_id,user_id,course_id,revision)
    values(new.id,new.owner_id,new.course_id,new.bank_revision) on conflict(bank_id) do nothing;
  end if;
 end if;
 return new;
end;
$$;
revoke all on function public.quizlab_capture_assignment_event() from public,anon,authenticated;
drop trigger if exists quizlab_capture_assignment_event on public.quizlab_banks;
create trigger quizlab_capture_assignment_event after insert on public.quizlab_banks
 for each row execute function public.quizlab_capture_assignment_event();
-- Deliberately no INSERT ... SELECT of existing banks: no historical blast.
