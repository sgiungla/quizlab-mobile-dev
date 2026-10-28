begin;
-- New module is additive; preserve all prior explicit choices and plan content.
create or replace function public.quizlab_all_modules() returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select '{"lessons":true,"kit_ai":true,"question_banks":true,"handouts":true,"quizlab_desktop":true,"quizlab_pwa":true,"gradebook":true}'::jsonb;
$$;
-- Older complete module objects must continue to satisfy the existing check.
update public.quizlab_plans set modules=jsonb_build_object('gradebook',true)||modules
where not modules?'gradebook';
-- Keep contractual snapshots immutable. A module introduced after the
-- snapshot inherits its new default; all stored flags and user overrides win.
create or replace function public.quizlab_effective_modules_for(target_user_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,auth as $$
 select case when exists(select 1 from public.quizlab_admins where user_id=target_user_id)
 then public.quizlab_all_modules()
 else jsonb_build_object('gradebook',true)||public.quizlab_current_plan_modules_for(target_user_id)
 ||coalesce((select module_overrides from public.quizlab_user_access where user_id=target_user_id),'{}'::jsonb) end;
$$;
-- Existing policy/default grants stay unchanged. New entitlement is evaluated
-- through the existing effective modules and account/license status functions.


-- Additive: real grades extend the existing exam items; no second calendar.
create table if not exists quizlab_release_private.gradebook_accounts(
 user_id uuid primary key references auth.users(id) on delete cascade,
 revision bigint not null default 0 check(revision>=0),
 settings jsonb not null default '{"degreeName":"","totalCredits":180,"honorsValue":30,"thesisBonus":0}'::jsonb check(jsonb_typeof(settings)='object'),
 updated_at timestamptz not null default now()
);
alter table quizlab_release_private.gradebook_accounts enable row level security;
revoke all on quizlab_release_private.gradebook_accounts from public,anon,authenticated;

create or replace function quizlab_release_private.gradebook_exam_revision()
returns trigger language plpgsql security invoker set search_path='' as $$
declare owner_id uuid;
begin
 if coalesce(new.kind,old.kind)<>'exam' then return coalesce(new,old);end if;
 owner_id=coalesce(new.user_id,old.user_id);
 insert into quizlab_release_private.gradebook_accounts(user_id,revision)values(owner_id,1)
 on conflict(user_id)do update set revision=quizlab_release_private.gradebook_accounts.revision+1,updated_at=now();
 return coalesce(new,old);
end;
$$;
revoke all on function quizlab_release_private.gradebook_exam_revision() from public,anon,authenticated;
drop trigger if exists quizlab_gradebook_exam_revision on public.quizlab_study_items;
create trigger quizlab_gradebook_exam_revision after insert or update or delete on public.quizlab_study_items
for each row execute function quizlab_release_private.gradebook_exam_revision();

-- No Data API grants: authenticated HTTP endpoints validate license and owner.
-- Existing exam records need no rewrite; first read maps missing CFU to null.


-- Additive private aggregates; apply only as part of the reviewed release.
create table if not exists quizlab_release_private.performance_daily(
 day date not null,kind text not null check(kind in('pwa_desktop','pwa_mobile','extension_desktop')),
 operation text not null check(operation in('startup','course_open','answer','local_save','cloud_sync','gradebook_save')),
 samples bigint not null check(samples>0),total_ms double precision not null check(total_ms>=0),max_ms double precision not null check(max_ms>=0 and max_ms<=120000),
 errors bigint not null check(errors>=0 and errors<=samples),slow_samples bigint not null check(slow_samples>=0 and slow_samples<=samples),last_at timestamptz not null default now(),
 primary key(day,kind,operation));
create table if not exists quizlab_release_private.performance_batches(
 user_id uuid not null references auth.users(id) on delete cascade,batch_id uuid not null,body_hash text not null check(length(body_hash)=64),received_at timestamptz not null default now(),primary key(user_id,batch_id));
create index if not exists performance_batches_received on quizlab_release_private.performance_batches(received_at);
alter table quizlab_release_private.performance_daily enable row level security;
alter table quizlab_release_private.performance_batches enable row level security;
revoke all on quizlab_release_private.performance_daily,quizlab_release_private.performance_batches from public,anon,authenticated;
-- No client policies or public RPC: authenticated user is verified by the
-- Edge handler; its server-only DB connection is the sole writer/reader.

commit;
