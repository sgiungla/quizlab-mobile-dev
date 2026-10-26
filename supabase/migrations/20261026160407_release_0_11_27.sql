-- Private, consistent in-database copy before additive schema changes.
set local lock_timeout='5s';
set local statement_timeout='120s';
create schema if not exists quizlab_release_private;
revoke all on schema quizlab_release_private from public,anon,authenticated;
do $snapshot$ declare t text; begin
 if pg_database_size(current_database())>400000000 then raise exception 'Insufficient safe Free-plan headroom for release snapshot'; end if;
 foreach t in array array['quizlab_admins','quizlab_banks','quizlab_devices','quizlab_profiles','quizlab_retired_courses','quizlab_user_access','quizlab_user_courses','quizlab_user_deleted_courses'] loop
  execute format('lock table public.%I in share mode',t);
 end loop;
 foreach t in array array['quizlab_admins','quizlab_banks','quizlab_devices','quizlab_profiles','quizlab_retired_courses','quizlab_user_access','quizlab_user_courses','quizlab_user_deleted_courses'] loop
  execute format('create table quizlab_release_private.%I as table public.%I', 'before_01127_'||t,t);
  execute format('alter table quizlab_release_private.%I enable row level security','before_01127_'||t);
  execute format('revoke all on quizlab_release_private.%I from public,anon,authenticated','before_01127_'||t);
 end loop;
end; $snapshot$;

-- Reviewed source: 0118-local.sql
-- LAB ONLY. Never apply to production without a compatibility/staging review.
alter table public.quizlab_user_access add column if not exists expires_at timestamptz;
alter table public.quizlab_user_access add column if not exists license_revision bigint not null default 1;
alter table public.quizlab_banks add column if not exists bank_revision bigint not null default 1;
alter table public.quizlab_banks add column if not exists managed_by_admin boolean not null default false;
alter table public.quizlab_banks add column if not exists assigned_by uuid references auth.users(id) on delete set null;

create or replace function public.quizlab_account_status() returns text language sql stable security definer set search_path=public,auth as $$
 select case when auth.uid() is null then 'pending' when public.quizlab_is_admin() then 'active'
 else coalesce((select case when status='active' and expires_at is not null and expires_at<=now() then 'expired' else status end from public.quizlab_user_access where user_id=auth.uid()),'pending') end;
$$;

create or replace function public.quizlab_license_status() returns jsonb language sql stable security definer set search_path=public,auth as $$
 select jsonb_build_object('userId',auth.uid(),'status',public.quizlab_account_status(),'isAdmin',public.quizlab_is_admin(),
 'expiresAt',case when public.quizlab_is_admin() then null else (select expires_at from public.quizlab_user_access where user_id=auth.uid()) end,
 'licenseRevision',coalesce((select license_revision from public.quizlab_user_access where user_id=auth.uid()),1),'serverTime',now(),'offlineHours',24);
$$;

create or replace function public.quizlab_admin_set_expiry(target_user_id uuid,target_expires_at timestamptz default null) returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 if not exists(select 1 from auth.users where id=target_user_id) then raise exception 'user not found'; end if;
 if exists(select 1 from public.quizlab_admins where user_id=target_user_id) then raise exception 'administrator expiry is protected'; end if;
 insert into public.quizlab_user_access(user_id,status,expires_at,updated_at) values(target_user_id,'pending',target_expires_at,now())
 on conflict(user_id) do update set expires_at=excluded.expires_at,license_revision=quizlab_user_access.license_revision+1,updated_at=now();
 return jsonb_build_object('ok',true,'expiresAt',target_expires_at);
end; $$;

create or replace function public.quizlab_admin_set_user_status(target_user uuid,new_status text) returns text language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 if new_status not in ('pending','active','suspended') then raise exception 'invalid status'; end if;
 if exists(select 1 from public.quizlab_admins where user_id=target_user) then raise exception 'administrator status is protected'; end if;
 insert into public.quizlab_user_access(user_id,status,updated_at) values(target_user,new_status,now())
 on conflict(user_id) do update set status=excluded.status,license_revision=quizlab_user_access.license_revision+1,updated_at=now();
 return new_status;
end; $$;

create or replace function public.quizlab_admin_user_licenses() returns table(user_id uuid,email text,account_status text,expires_at timestamptz,license_revision bigint,is_admin boolean,assigned_course_count bigint) language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 return query select u.id,u.email::text,
 case when a.user_id is not null then 'active' when ua.status='active' and ua.expires_at<=now() then 'expired' else coalesce(ua.status,'pending') end,
 ua.expires_at,coalesce(ua.license_revision,1),a.user_id is not null,
 (select count(*) from public.quizlab_banks b where b.owner_id=u.id and b.managed_by_admin)
 from auth.users u left join public.quizlab_user_access ua on ua.user_id=u.id left join public.quizlab_admins a on a.user_id=u.id order by u.email;
end; $$;

-- Validate incoming content at the trust boundary, without silently dropping rows.
create or replace function public.quizlab_validate_bank(incoming_bank jsonb) returns void language plpgsql set search_path=public as $$
declare q jsonb; option_count integer; ids text[]:='{}'; qid text; letter text;
begin
 if jsonb_typeof(incoming_bank) is distinct from 'object' or octet_length(incoming_bank::text)>8388608 then raise exception 'invalid or oversized bank'; end if;
 if jsonb_typeof(coalesce(incoming_bank->'officialBank','[]'::jsonb))<>'array' or jsonb_typeof(coalesce(incoming_bank->'aiBank','[]'::jsonb))<>'array' then raise exception 'bank arrays required'; end if;
 if jsonb_array_length(coalesce(incoming_bank->'officialBank','[]'::jsonb))+jsonb_array_length(coalesce(incoming_bank->'aiBank','[]'::jsonb))>20000 then raise exception 'bank question quota exceeded'; end if;
 for q in select value from jsonb_array_elements(coalesce(incoming_bank->'officialBank','[]'::jsonb)||coalesce(incoming_bank->'aiBank','[]'::jsonb)) loop
  qid:=q->>'id';
  if coalesce(qid,'')='' or length(qid)>256 or qid=any(ids) or qid in ('__proto__','constructor','prototype') then raise exception 'invalid or duplicate question id'; end if;
  ids:=array_append(ids,qid);
  if coalesce(q->>'question','')='' and coalesce(q->>'text','')='' then raise exception 'question text required'; end if;
  if coalesce(q->>'chapter','') !~ '^[1-9][0-9]*$' then raise exception 'positive chapter required'; end if;
  if jsonb_typeof(q->'options') is distinct from 'array' or jsonb_array_length(q->'options')<>4 then raise exception 'four options required'; end if;
  select count(distinct value->>'letter') into option_count from jsonb_array_elements(q->'options') where value->>'letter' in ('A','B','C','D') and coalesce(value->>'text','')<>'';
  if option_count<>4 then raise exception 'invalid options'; end if;
  letter:=coalesce(q->>'correctLetter',q->>'correct');
  if letter is null or letter not in ('A','B','C','D') then raise exception 'invalid correct answer'; end if;
 end loop;
end; $$;

create or replace function public.quizlab_save_bank_v2(target_course_id text,expected_revision bigint,incoming_bank jsonb,target_subject text default null,incoming_hash text default null) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare r public.quizlab_banks%rowtype;
begin
 if auth.uid() is null or not public.quizlab_access_allowed() then raise exception 'forbidden' using errcode='42501'; end if;
 if coalesce(trim(target_course_id),'')='' or length(target_course_id)>256 or target_course_id in ('__proto__','prototype','constructor') then raise exception 'invalid course id'; end if;
 if public.quizlab_course_blocked(target_course_id) then raise exception 'course blocked' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':'||target_course_id,0));
 select * into r from public.quizlab_banks where owner_id=auth.uid() and course_id=target_course_id for update;
 if found and r.managed_by_admin then
  return jsonb_build_object('ok',true,'readonly',true,'bank_id',r.id,'revision',r.bank_revision,'bank_json',r.bank_json,'bank_hash',r.bank_hash,'updated_at',r.updated_at,'subject',r.subject,'managed_by_admin',true);
 end if;
 if coalesce(r.bank_revision,0)<>coalesce(expected_revision,0) then
  return jsonb_build_object('ok',false,'conflict',true,'bank_id',r.id,'revision',coalesce(r.bank_revision,0),'bank_json',coalesce(r.bank_json,'{}'),'bank_hash',r.bank_hash,'updated_at',r.updated_at,'subject',r.subject);
 end if;
 perform public.quizlab_validate_bank(incoming_bank);
 insert into public.quizlab_banks(owner_id,course_id,subject,bank_json,bank_hash,bank_revision) values(auth.uid(),target_course_id,coalesce(nullif(target_subject,''),target_course_id),incoming_bank,incoming_hash,1)
 on conflict(owner_id,course_id) do update set bank_json=excluded.bank_json,bank_hash=excluded.bank_hash,subject=excluded.subject,bank_revision=quizlab_banks.bank_revision+1,updated_at=now() returning * into r;
 return jsonb_build_object('ok',true,'conflict',false,'bank_id',r.id,'revision',r.bank_revision,'bank_json',r.bank_json,'bank_hash',r.bank_hash,'updated_at',r.updated_at,'subject',r.subject,'managed_by_admin',false);
end; $$;

create or replace function public.quizlab_admin_list_assignments(target_user_id uuid) returns table(bank_id uuid,course_id text,subject text,revision bigint,managed_by_admin boolean,question_count integer) language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 return query select b.id,b.course_id,b.subject,b.bank_revision,b.managed_by_admin,jsonb_array_length(coalesce(b.bank_json->'officialBank','[]'))+jsonb_array_length(coalesce(b.bank_json->'aiBank','[]')) from public.quizlab_banks b where b.owner_id=target_user_id order by b.subject;
end; $$;

create or replace function public.quizlab_admin_assign_course(target_user_id uuid,target_course_id text,target_subject text,incoming_bank jsonb,expected_revision bigint default 0) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare r public.quizlab_banks%rowtype;
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 if not exists(select 1 from auth.users where id=target_user_id) then raise exception 'user not found'; end if;
 if coalesce(trim(target_course_id),'')='' or length(target_course_id)>256 or target_course_id in ('__proto__','prototype','constructor') then raise exception 'invalid course id'; end if;
 if exists(select 1 from public.quizlab_retired_courses where course_id=target_course_id) then raise exception 'course retired'; end if;
 perform public.quizlab_validate_bank(incoming_bank);
 perform pg_advisory_xact_lock(hashtextextended(target_user_id::text||':'||target_course_id,0));
 select * into r from public.quizlab_banks where owner_id=target_user_id and course_id=target_course_id for update;
 if coalesce(r.bank_revision,0)<>coalesce(expected_revision,0) then return jsonb_build_object('ok',false,'conflict',true,'revision',coalesce(r.bank_revision,0)); end if;
 insert into public.quizlab_banks(owner_id,course_id,subject,bank_json,bank_revision,managed_by_admin,assigned_by) values(target_user_id,target_course_id,coalesce(nullif(target_subject,''),target_course_id),incoming_bank,1,true,auth.uid())
 on conflict(owner_id,course_id) do update set subject=excluded.subject,bank_json=excluded.bank_json,bank_hash=null,bank_revision=quizlab_banks.bank_revision+1,managed_by_admin=true,assigned_by=auth.uid(),updated_at=now() returning * into r;
 delete from public.quizlab_user_deleted_courses where user_id=target_user_id and course_id=target_course_id;
 return jsonb_build_object('ok',true,'bank_id',r.id,'revision',r.bank_revision,'managed_by_admin',true);
end; $$;

create or replace function public.quizlab_save_progress_v2(target_bank_id uuid,expected_revision bigint,incoming_progress jsonb) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare r public.quizlab_user_courses%rowtype; cid text; next_rev bigint;
begin
 if auth.uid() is null or not public.quizlab_access_allowed() then raise exception 'forbidden' using errcode='42501'; end if;
 if jsonb_typeof(incoming_progress) is distinct from 'object' or octet_length(incoming_progress::text)>5242880 then raise exception 'invalid or oversized progress'; end if;
 -- Lock the parent bank also when the progress row does not yet exist.
 select course_id into cid from public.quizlab_banks where id=target_bank_id and owner_id=auth.uid() for update;
 if cid is null or public.quizlab_course_blocked(cid) then raise exception 'bank forbidden or course blocked' using errcode='42501'; end if;
 select * into r from public.quizlab_user_courses where user_id=auth.uid() and bank_id=target_bank_id for update;
 if coalesce(r.revision,0)<>coalesce(expected_revision,0) then return jsonb_build_object('ok',false,'conflict',true,'revision',coalesce(r.revision,0),'progress',coalesce(r.progress_json,'{}'),'updated_at',r.updated_at); end if;
 next_rev:=coalesce(r.revision,0)+1;
 insert into public.quizlab_user_courses(user_id,bank_id,progress_json,revision,updated_at) values(auth.uid(),target_bank_id,incoming_progress,next_rev,now())
 on conflict(user_id,bank_id) do update set progress_json=excluded.progress_json,revision=excluded.revision,updated_at=now();
 return jsonb_build_object('ok',true,'conflict',false,'revision',next_rev,'progress',incoming_progress,'updated_at',now());
end; $$;

-- Admins assign banks through the checked RPC; recipients cannot alter managed banks.
revoke insert,update,delete on public.quizlab_banks from authenticated;
revoke all on public.quizlab_banks,public.quizlab_user_courses from anon;
revoke all on function public.quizlab_validate_bank(jsonb) from public,anon,authenticated;
revoke all on function public.quizlab_license_status(),public.quizlab_admin_set_expiry(uuid,timestamptz),public.quizlab_admin_user_licenses(),public.quizlab_save_bank_v2(text,bigint,jsonb,text,text),public.quizlab_admin_list_assignments(uuid),public.quizlab_admin_assign_course(uuid,text,text,jsonb,bigint) from public,anon;
grant execute on function public.quizlab_license_status(),public.quizlab_admin_set_expiry(uuid,timestamptz),public.quizlab_admin_user_licenses(),public.quizlab_save_bank_v2(text,bigint,jsonb,text,text),public.quizlab_admin_list_assignments(uuid),public.quizlab_admin_assign_course(uuid,text,text,jsonb,bigint) to authenticated;
-- Disable global shared-bank visibility: accounts only see their own assigned bank.
drop policy if exists "banks_owner_or_shared_select" on public.quizlab_banks;
create policy "banks_owner_or_shared_select" on public.quizlab_banks for select to authenticated using(owner_id=auth.uid() and public.quizlab_access_allowed());


-- Reviewed source: 0119-managed-delete.sql
-- LAB only: a managed assignment cannot be erased or rewritten by its recipient.
create or replace function public.quizlab_delete_my_course(target_course_id text) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare bank_count bigint:=0;
begin
 if auth.uid() is null or not public.quizlab_access_allowed() then raise exception 'forbidden' using errcode='42501'; end if;
 if coalesce(trim(target_course_id),'')='' then raise exception 'invalid course id'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':'||target_course_id,0));
 if exists(select 1 from public.quizlab_banks where owner_id=auth.uid() and course_id=target_course_id and managed_by_admin) then raise exception 'Materia gestita dall''amministratore: rimozione cloud non consentita' using errcode='42501'; end if;
 insert into public.quizlab_user_deleted_courses(user_id,course_id,deleted_at) values(auth.uid(),target_course_id,now()) on conflict(user_id,course_id) do update set deleted_at=now();
 select count(*) into bank_count from public.quizlab_banks where owner_id=auth.uid() and course_id=target_course_id;
 delete from public.quizlab_banks where owner_id=auth.uid() and course_id=target_course_id;
 return jsonb_build_object('course_id',target_course_id,'deleted_banks',bank_count);
end; $$;
revoke all on function public.quizlab_delete_my_course(text) from public,anon;
grant execute on function public.quizlab_delete_my_course(text) to authenticated;

alter function public.quizlab_validate_bank(jsonb) rename to quizlab_validate_bank_shape_v1;
create function public.quizlab_validate_bank(incoming_bank jsonb) returns void language plpgsql set search_path=public as $$
declare q jsonb; option_count integer; correct_id text;
begin
 perform public.quizlab_validate_bank_shape_v1(incoming_bank);
 for q in select value from jsonb_array_elements(coalesce(incoming_bank->'officialBank','[]'::jsonb)||coalesce(incoming_bank->'aiBank','[]'::jsonb)) loop
  if coalesce(q->>'source','official') not in ('official','ai') then raise exception 'invalid question source'; end if;
  if exists(select 1 from jsonb_array_elements(q->'options') o where o->>'optionId' in ('__proto__','prototype','constructor')) then raise exception 'reserved option id'; end if;
  select count(distinct coalesce(o->>'optionId',o->>'id',o->>'letter')) into option_count from jsonb_array_elements(q->'options') o;
  if option_count<>4 then raise exception 'duplicate option ids'; end if;
  correct_id:=coalesce(q->>'correctOptionId',q->>'correct_option_id');
  if correct_id is not null and not exists(select 1 from jsonb_array_elements(q->'options') o where coalesce(o->>'optionId',o->>'id',o->>'letter')=correct_id and o->>'letter'=coalesce(q->>'correct',q->>'correctLetter')) then raise exception 'correct option id mismatch'; end if;
 end loop;
end; $$;
revoke all on function public.quizlab_validate_bank(jsonb),public.quizlab_validate_bank_shape_v1(jsonb) from public,anon,authenticated;


-- Reviewed source: 0120-validation-hardening.sql
-- LAB validation aliases must obey the same rules as canonical fields.
alter function public.quizlab_validate_bank(jsonb) rename to quizlab_validate_bank_shape_v2;
create function public.quizlab_validate_bank(incoming_bank jsonb) returns void language plpgsql set search_path=public as $$
declare q jsonb;
begin
 perform public.quizlab_validate_bank_shape_v2(incoming_bank);
 for q in select value from jsonb_array_elements(coalesce(incoming_bank->'officialBank','[]'::jsonb)||coalesce(incoming_bank->'aiBank','[]'::jsonb)) loop
  if exists(select 1 from jsonb_array_elements(q->'options') o where coalesce(o->>'optionId',o->>'id',o->>'letter') in ('__proto__','prototype','constructor')) then raise exception 'reserved option id'; end if;
  if q ? 'correct' and q ? 'correctLetter' and q->>'correct' is distinct from q->>'correctLetter' then raise exception 'conflicting correct answer aliases'; end if;
 end loop;
end; $$;
revoke all on function public.quizlab_validate_bank(jsonb),public.quizlab_validate_bank_shape_v2(jsonb) from public,anon,authenticated;


-- Reviewed source: 0121-admin-lab.sql
-- LAB 0.11.19 only. Append-only bank history and explicit administrator operations.
-- Existing banks, progress, licenses and accounts are retained as they are.
create table public.quizlab_admin_requests(
 actor_id uuid not null references auth.users(id),request_id uuid not null,
 operation text not null,parameters jsonb not null,response jsonb,created_at timestamptz not null default now(),
 primary key(actor_id,request_id)
);
create table public.quizlab_bank_history(
 history_id uuid primary key default gen_random_uuid(),bank_id uuid not null,
 user_id uuid not null references auth.users(id),course_id text not null,
 subject text not null,bank_json jsonb not null,revision bigint not null,
 actor_id uuid not null references auth.users(id),archived_at timestamptz not null default now(),
 source_course_id text,operation text not null
);
create index quizlab_bank_history_target_idx on public.quizlab_bank_history(user_id,course_id,archived_at desc);
create table public.quizlab_plans(
 plan_id text primary key,label text not null,duration_months integer not null check(duration_months between 1 and 120),
 currency text not null check(currency='EUR'),total_cents bigint not null check(total_cents between 0 and 1000000000),
 payment_mode text not null check(payment_mode in ('full','installments')),installment_count integer not null,
 active boolean not null default true,version bigint not null default 1,updated_at timestamptz not null default now(),
 check(installment_count between 1 and duration_months),check(payment_mode<>'full' or installment_count=1)
);
create table public.quizlab_contracts(
 contract_id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),
 plan_snapshot jsonb not null,starts_at timestamptz not null,ends_at timestamptz not null check(ends_at>starts_at),
 action text not null check(action in ('activate','renew')),actor_id uuid not null references auth.users(id),
 created_at timestamptz not null default now(),manual_override boolean not null default false
);
create index quizlab_contracts_user_idx on public.quizlab_contracts(user_id,created_at desc);
create table public.quizlab_installments(
 installment_id uuid primary key default gen_random_uuid(),contract_id uuid not null references public.quizlab_contracts(contract_id),
 number integer not null,due_at timestamptz not null,amount_cents bigint not null check(amount_cents>=0),
 currency text not null check(currency='EUR'),status text not null default 'scheduled' check(status in ('scheduled','paid')),
 paid_at timestamptz,updated_at timestamptz not null default now(),unique(contract_id,number)
);
alter table public.quizlab_user_access add column starts_at timestamptz;
alter table public.quizlab_user_access add column current_contract_id uuid references public.quizlab_contracts(contract_id);

alter table public.quizlab_admin_requests enable row level security;
alter table public.quizlab_bank_history enable row level security;
alter table public.quizlab_plans enable row level security;
alter table public.quizlab_contracts enable row level security;
alter table public.quizlab_installments enable row level security;
revoke all on public.quizlab_admin_requests,public.quizlab_bank_history,public.quizlab_plans,public.quizlab_contracts,public.quizlab_installments from public,anon,authenticated;
grant select on public.quizlab_bank_history,public.quizlab_plans,public.quizlab_contracts,public.quizlab_installments to authenticated;
create policy history_admin on public.quizlab_bank_history for select to authenticated using(public.quizlab_is_admin());
create policy plans_admin on public.quizlab_plans for select to authenticated using(public.quizlab_is_admin());
create policy contracts_admin on public.quizlab_contracts for select to authenticated using(public.quizlab_is_admin());
create policy installments_admin on public.quizlab_installments for select to authenticated using(public.quizlab_is_admin());

create function public.quizlab_history_immutable() returns trigger language plpgsql as $$
begin raise exception 'bank history is immutable' using errcode='42501'; end; $$;
create trigger quizlab_bank_history_immutable before update or delete on public.quizlab_bank_history for each row execute function public.quizlab_history_immutable();
create function public.quizlab_contract_snapshot_immutable() returns trigger language plpgsql as $$
begin
 if row(new.contract_id,new.user_id,new.plan_snapshot,new.starts_at,new.ends_at,new.action,new.actor_id,new.created_at)
 is distinct from row(old.contract_id,old.user_id,old.plan_snapshot,old.starts_at,old.ends_at,old.action,old.actor_id,old.created_at) then raise exception 'contract snapshot is immutable' using errcode='42501'; end if;
 return new;
end; $$;
create trigger quizlab_contract_snapshot_immutable before update on public.quizlab_contracts for each row execute function public.quizlab_contract_snapshot_immutable();

-- The same request UUID is tied to its administrator, operation and exact parameters.
-- A replay returns the first result; reusing it for another operation is rejected.
create function public.quizlab_admin_request_begin(rid uuid,kind text,params jsonb) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare r public.quizlab_admin_requests%rowtype;
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 if rid is null then raise exception 'request_id required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':request:'||rid::text,0));
 select * into r from public.quizlab_admin_requests where actor_id=auth.uid() and request_id=rid for update;
 if found then
  if r.operation<>kind or r.parameters is distinct from params then raise exception 'request_id reused with different parameters'; end if;
  return r.response;
 end if;
 insert into public.quizlab_admin_requests(actor_id,request_id,operation,parameters)values(auth.uid(),rid,kind,params);
 return null;
end; $$;
create function public.quizlab_admin_request_finish(rid uuid,result jsonb) returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
 update public.quizlab_admin_requests set response=result where actor_id=auth.uid() and request_id=rid;
 return result;
end; $$;

create function public.quizlab_admin_assign_course_safe(target_user_id uuid,target_course_id text,target_subject text,incoming_bank jsonb,expected_revision bigint,operation_mode text,source_course_id text,request_id uuid) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare r public.quizlab_banks%rowtype;reply jsonb;present boolean;
begin
 reply:=public.quizlab_admin_request_begin(request_id,'assign_safe',jsonb_build_object('user',target_user_id,'course',target_course_id,'subject',target_subject,'bank',incoming_bank,'revision',expected_revision,'mode',operation_mode,'source',source_course_id));
 if reply is not null then return reply; end if;
 if operation_mode is null or operation_mode not in ('create','update') then raise exception 'operation_mode must be create or update'; end if;
 if not exists(select 1 from auth.users where id=target_user_id) then raise exception 'user not found'; end if;
 if coalesce(trim(target_course_id),'')='' or length(target_course_id)>256 or target_course_id in ('__proto__','prototype','constructor') then raise exception 'invalid course id'; end if;
 if coalesce(trim(source_course_id),'')='' then raise exception 'source_course_id required'; end if;
 if operation_mode='update' and source_course_id<>target_course_id then raise exception 'source_course_id differs from target: create a separate assignment'; end if;
 if exists(select 1 from public.quizlab_retired_courses where course_id=target_course_id) then raise exception 'course retired'; end if;
 perform public.quizlab_validate_bank(incoming_bank);
 if incoming_bank ?| array['attempts','exams','marked','pendingReview','historicalWrong','syncMeta','access_token','refresh_token'] then raise exception 'assignment accepts question content only'; end if;
 perform pg_advisory_xact_lock(hashtextextended(target_user_id::text||':'||target_course_id,0));
 select * into r from public.quizlab_banks where owner_id=target_user_id and course_id=target_course_id for update;present:=found;
 if (operation_mode='create' and present) or (operation_mode='update' and not present) or coalesce(expected_revision,-1)<>coalesce(r.bank_revision,0) then
  return public.quizlab_admin_request_finish(request_id,jsonb_build_object('ok',false,'conflict',true,'reason',case when operation_mode='create' and present then 'target_exists' when not present and operation_mode='update' then 'target_missing' else 'revision_changed' end,'revision',coalesce(r.bank_revision,0),'bank_id',r.id));
 end if;
 if present then
  insert into public.quizlab_bank_history(bank_id,user_id,course_id,subject,bank_json,revision,actor_id,source_course_id,operation)values(r.id,r.owner_id,r.course_id,r.subject,r.bank_json,r.bank_revision,auth.uid(),source_course_id,'update');
  update public.quizlab_banks set subject=coalesce(nullif(trim(target_subject),''),target_course_id),bank_json=incoming_bank,bank_hash=null,bank_revision=bank_revision+1,managed_by_admin=true,assigned_by=auth.uid(),updated_at=now() where id=r.id returning * into r;
 else
  insert into public.quizlab_banks(owner_id,course_id,subject,bank_json,bank_revision,managed_by_admin,assigned_by) values(target_user_id,target_course_id,coalesce(nullif(trim(target_subject),''),target_course_id),incoming_bank,1,true,auth.uid()) returning * into r;
 end if;
 delete from public.quizlab_user_deleted_courses where user_id=target_user_id and course_id=target_course_id;
 return public.quizlab_admin_request_finish(request_id,jsonb_build_object('ok',true,'bank_id',r.id,'revision',r.bank_revision,'managed_by_admin',true));
end; $$;

-- Legacy clients may create or confirm identical content, but may not overwrite without source intent.
create or replace function public.quizlab_admin_assign_course(target_user_id uuid,target_course_id text,target_subject text,incoming_bank jsonb,expected_revision bigint default 0) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare r public.quizlab_banks%rowtype;
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(target_user_id::text||':'||target_course_id,0));
 select * into r from public.quizlab_banks where owner_id=target_user_id and course_id=target_course_id for update;
 if found then
  if r.bank_json is distinct from incoming_bank or r.subject is distinct from coalesce(nullif(target_subject,''),target_course_id) then return jsonb_build_object('ok',false,'conflict',true,'reason','safe_assignment_required','revision',r.bank_revision); end if;
  if r.bank_revision<>expected_revision then return jsonb_build_object('ok',false,'conflict',true,'reason','revision_changed','revision',r.bank_revision); end if;
  return jsonb_build_object('ok',true,'bank_id',r.id,'revision',r.bank_revision,'managed_by_admin',r.managed_by_admin);
 end if;
 return public.quizlab_admin_assign_course_safe(target_user_id,target_course_id,target_subject,incoming_bank,expected_revision,'create',target_course_id,gen_random_uuid());
end; $$;

create function public.quizlab_admin_bank_snapshot(target_user_id uuid,target_course_id text) returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 return(select jsonb_build_object('bank_id',id,'user_id',owner_id,'course_id',course_id,'subject',subject,'bank_json',bank_json,'revision',bank_revision,'managed_by_admin',managed_by_admin) from public.quizlab_banks where owner_id=target_user_id and course_id=target_course_id);
end; $$;
create function public.quizlab_admin_bank_history(target_user_id uuid,target_course_id text,limit_count integer default 20) returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 if limit_count is null or limit_count not between 1 and 100 then raise exception 'history limit must be 1..100'; end if;
 return jsonb_build_object('total',(select count(*) from public.quizlab_bank_history where user_id=target_user_id and course_id=target_course_id),'items',coalesce((select jsonb_agg(to_jsonb(x)) from(select history_id,revision,subject,jsonb_array_length(coalesce(bank_json->'officialBank','[]')) official_count,jsonb_array_length(coalesce(bank_json->'aiBank','[]')) ai_count,archived_at,actor_id from public.quizlab_bank_history where user_id=target_user_id and course_id=target_course_id order by archived_at desc,revision desc limit limit_count)x),'[]'));
end; $$;
create function public.quizlab_admin_history_bank(history_id uuid) returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 return(select jsonb_build_object('history_id',h.history_id,'user_id',h.user_id,'course_id',h.course_id,'subject',h.subject,'revision',h.revision,'bank_json',h.bank_json) from public.quizlab_bank_history h where h.history_id=$1);
end; $$;
create function public.quizlab_admin_restore_bank(target_user_id uuid,target_course_id text,history_id uuid,expected_revision bigint,request_id uuid) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare r public.quizlab_banks%rowtype;h public.quizlab_bank_history%rowtype;reply jsonb;
begin
 reply:=public.quizlab_admin_request_begin(request_id,'restore_bank',jsonb_build_object('user',target_user_id,'course',target_course_id,'history',history_id,'revision',expected_revision));if reply is not null then return reply; end if;
 if exists(select 1 from public.quizlab_retired_courses where course_id=target_course_id) then raise exception 'course retired'; end if;
 select * into h from public.quizlab_bank_history bh where bh.history_id=$3 and bh.user_id=target_user_id and bh.course_id=target_course_id;
 if not found then raise exception 'history does not belong to this user/course'; end if;
 perform pg_advisory_xact_lock(hashtextextended(target_user_id::text||':'||target_course_id,0));
 select * into r from public.quizlab_banks where owner_id=target_user_id and course_id=target_course_id for update;
 if not found or expected_revision is null or r.bank_revision<>expected_revision then return public.quizlab_admin_request_finish(request_id,jsonb_build_object('ok',false,'conflict',true,'reason','revision_changed','revision',coalesce(r.bank_revision,0))); end if;
 insert into public.quizlab_bank_history(bank_id,user_id,course_id,subject,bank_json,revision,actor_id,source_course_id,operation)values(r.id,r.owner_id,r.course_id,r.subject,r.bank_json,r.bank_revision,auth.uid(),target_course_id,'restore');
 update public.quizlab_banks set bank_json=h.bank_json,subject=h.subject,bank_hash=null,bank_revision=bank_revision+1,managed_by_admin=true,assigned_by=auth.uid(),updated_at=now() where id=r.id returning * into r;
 return public.quizlab_admin_request_finish(request_id,jsonb_build_object('ok',true,'bank_id',r.id,'revision',r.bank_revision,'managed_by_admin',true,'restored_from',h.history_id));
end; $$;

create function public.quizlab_add_utc_months(value timestamptz,months integer) returns timestamptz language sql immutable as $$
 select ((value at time zone 'UTC')+make_interval(months=>months)) at time zone 'UTC';
$$;
create function public.quizlab_admin_list_plans() returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(to_jsonb(p) order by duration_months,plan_id) from public.quizlab_plans p),'[]');
end; $$;
create function public.quizlab_admin_save_plan(plan_id text,label text,duration_months integer,currency text,total_cents bigint,payment_mode text,installment_count integer,active boolean,request_id uuid,expected_version bigint default 0) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare p public.quizlab_plans%rowtype;reply jsonb;
begin
 reply:=public.quizlab_admin_request_begin(request_id,'save_plan',jsonb_build_object('plan',plan_id,'label',label,'months',duration_months,'currency',currency,'cents',total_cents,'mode',payment_mode,'count',installment_count,'active',active,'version',expected_version));if reply is not null then return reply; end if;
 if plan_id !~ '^[a-zA-Z0-9_-]{1,64}$' or plan_id in ('__proto__','constructor','prototype') or coalesce(trim(label),'')='' or length(label)>120 then raise exception 'invalid plan id/label'; end if;
 perform pg_advisory_xact_lock(hashtextextended('plan:'||plan_id,0));
 select * into p from public.quizlab_plans qp where qp.plan_id=$1 for update;
 if coalesce(p.version,0)<>coalesce(expected_version,-1) then return public.quizlab_admin_request_finish(request_id,jsonb_build_object('ok',false,'conflict',true,'reason','plan_changed','version',coalesce(p.version,0))); end if;
 insert into public.quizlab_plans(plan_id,label,duration_months,currency,total_cents,payment_mode,installment_count,active)
 values($1,trim($2),$3,$4,$5,$6,$7,$8) on conflict on constraint quizlab_plans_pkey do update set label=excluded.label,duration_months=excluded.duration_months,currency=excluded.currency,total_cents=excluded.total_cents,payment_mode=excluded.payment_mode,installment_count=excluded.installment_count,active=excluded.active,version=quizlab_plans.version+1,updated_at=now() returning * into p;
 return public.quizlab_admin_request_finish(request_id,jsonb_build_object('ok',true,'plan',to_jsonb(p)));
end; $$;

create function public.quizlab_admin_preview_contract(target_user_id uuid,plan_id text,action text,starts_at timestamptz default null,payment_mode text default null,installment_count integer default null) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare p public.quizlab_plans%rowtype;ua public.quizlab_user_access%rowtype;start_time timestamptz;end_time timestamptz;mode text;parts integer;i integer;rows jsonb:='[]';snapshot jsonb;
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 if exists(select 1 from public.quizlab_admins where user_id=target_user_id) then raise exception 'administrator license is protected'; end if;
 if not exists(select 1 from auth.users where id=target_user_id) then raise exception 'user not found'; end if;
 if action is null or action not in ('activate','renew') then raise exception 'action must be activate or renew'; end if;
 select * into p from public.quizlab_plans qp where qp.plan_id=$2;
 if not found or not p.active then raise exception 'plan not available'; end if;
 select * into ua from public.quizlab_user_access where user_id=target_user_id;
 mode:=coalesce(payment_mode,p.payment_mode);parts:=coalesce(installment_count,case when mode='full' then 1 else p.installment_count end);
 if mode not in ('full','installments') or parts not between 1 and p.duration_months or (mode='full' and parts<>1) then raise exception 'invalid payment schedule'; end if;
 if action='renew' then
  if starts_at is not null then raise exception 'renew starts from current expiry or now'; end if;
  start_time:=greatest(now(),ua.expires_at);
 else
  start_time:=coalesce(starts_at,now());
  if start_time<now()-interval '2 minutes' then raise exception 'activation must start now or in the future'; end if;
 end if;
 end_time:=public.quizlab_add_utc_months(start_time,p.duration_months);
 snapshot:=to_jsonb(p)-'updated_at'||jsonb_build_object('payment_mode',mode,'installment_count',parts);
 for i in 1..parts loop
  rows:=rows||jsonb_build_array(jsonb_build_object('number',i,'due_at',public.quizlab_add_utc_months(start_time,i-1),'amount_cents',p.total_cents/parts+case when i<=p.total_cents%parts then 1 else 0 end,'currency',p.currency,'status','scheduled'));
 end loop;
 return jsonb_build_object('user_id',target_user_id,'action',action,'starts_at',start_time,'ends_at',end_time,'plan_snapshot',snapshot,'installments',rows,'previous_expires_at',ua.expires_at,'license_revision',coalesce(ua.license_revision,1));
end; $$;
create function public.quizlab_admin_save_contract(target_user_id uuid,plan_id text,action text,request_id uuid,starts_at timestamptz default null,payment_mode text default null,installment_count integer default null,expected_license_revision bigint default null,expected_plan_version bigint default null,preview_starts_at timestamptz default null) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare reply jsonb;preview jsonb;entry jsonb;cid uuid;rev bigint;
begin
 reply:=public.quizlab_admin_request_begin(request_id,'save_contract',jsonb_build_object('user',target_user_id,'plan',plan_id,'action',action,'start',starts_at,'mode',payment_mode,'count',installment_count,'license',expected_license_revision,'version',expected_plan_version,'preview_start',preview_starts_at));if reply is not null then return reply; end if;
 if expected_license_revision is null or expected_plan_version is null then raise exception 'license and plan preview revisions required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(target_user_id::text||':license',0));
 perform 1 from public.quizlab_plans qp where qp.plan_id=$2 for share;
 perform 1 from public.quizlab_user_access where user_id=target_user_id for update;
 preview:=public.quizlab_admin_preview_contract(target_user_id,plan_id,action,starts_at,payment_mode,installment_count);
 if expected_license_revision is not null and expected_license_revision<>(preview->>'license_revision')::bigint then return public.quizlab_admin_request_finish(request_id,jsonb_build_object('ok',false,'conflict',true,'reason','license_changed')); end if;
 if expected_plan_version is not null and expected_plan_version<>(preview#>>'{plan_snapshot,version}')::bigint then return public.quizlab_admin_request_finish(request_id,jsonb_build_object('ok',false,'conflict',true,'reason','plan_changed')); end if;
 if action='renew' then
  if preview_starts_at is null then raise exception 'renew preview required'; end if;
  if (preview->>'previous_expires_at')::timestamptz>now() then
   if preview_starts_at is distinct from (preview->>'previous_expires_at')::timestamptz then raise exception 'renew preview no longer matches expiry'; end if;
  elsif preview_starts_at<now()-interval '2 minutes' or preview_starts_at>now() then raise exception 'renew preview expired: request a new preview'; end if;
  preview:=public.quizlab_admin_preview_contract(target_user_id,plan_id,'activate',preview_starts_at,payment_mode,installment_count)||jsonb_build_object('action','renew');
 elsif preview_starts_at is not null then raise exception 'preview_starts_at is only valid for renew'; end if;

 insert into public.quizlab_contracts(user_id,plan_snapshot,starts_at,ends_at,action,actor_id)values(target_user_id,preview->'plan_snapshot',(preview->>'starts_at')::timestamptz,(preview->>'ends_at')::timestamptz,action,auth.uid()) returning contract_id into cid;
 for entry in select value from jsonb_array_elements(preview->'installments') loop
  insert into public.quizlab_installments(contract_id,number,due_at,amount_cents,currency)values(cid,(entry->>'number')::integer,(entry->>'due_at')::timestamptz,(entry->>'amount_cents')::bigint,entry->>'currency');
 end loop;
 insert into public.quizlab_user_access(user_id,status,starts_at,expires_at,current_contract_id,license_revision,updated_at)values(target_user_id,'active',(preview->>'starts_at')::timestamptz,(preview->>'ends_at')::timestamptz,cid,(preview->>'license_revision')::bigint+1,now())
 on conflict(user_id)do update set status='active',starts_at=case when action='renew' and quizlab_user_access.status='active' and quizlab_user_access.expires_at>now() then quizlab_user_access.starts_at else excluded.starts_at end,expires_at=excluded.expires_at,current_contract_id=excluded.current_contract_id,license_revision=quizlab_user_access.license_revision+1,updated_at=now() returning license_revision into rev;
 return public.quizlab_admin_request_finish(request_id,preview||jsonb_build_object('ok',true,'contract_id',cid,'license_revision',rev));
end; $$;
create function public.quizlab_admin_set_installment_status(installment_id uuid,status text,request_id uuid) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare entry public.quizlab_installments%rowtype;reply jsonb;
begin
 reply:=public.quizlab_admin_request_begin(request_id,'installment_status',jsonb_build_object('id',installment_id,'status',status));if reply is not null then return reply; end if;
 if status is null or status not in ('scheduled','paid') then raise exception 'invalid installment status'; end if;
 update public.quizlab_installments qi set status=$2,paid_at=case when $2='paid' then coalesce(qi.paid_at,now()) else null end,updated_at=now() where qi.installment_id=$1 returning * into entry;
 if not found then raise exception 'installment not found'; end if;
 return public.quizlab_admin_request_finish(request_id,jsonb_build_object('ok',true,'installment',to_jsonb(entry)));
end; $$;

create or replace function public.quizlab_account_status() returns text language sql stable security definer set search_path=public,auth as $$
 select case when auth.uid() is null then 'pending' when public.quizlab_is_admin() then 'active'
 else coalesce((select case when status='active' and expires_at is not null and expires_at<=now() then 'expired' when status='active' and starts_at>now() then 'pending' else status end from public.quizlab_user_access where user_id=auth.uid()),'pending') end;
$$;
create or replace function public.quizlab_admin_set_expiry(target_user_id uuid,target_expires_at timestamptz default null) returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 if not exists(select 1 from auth.users where id=target_user_id) then raise exception 'user not found'; end if;
 if exists(select 1 from public.quizlab_admins where user_id=target_user_id) then raise exception 'administrator expiry is protected'; end if;
 perform pg_advisory_xact_lock(hashtextextended(target_user_id::text||':license',0));
 update public.quizlab_contracts set manual_override=true where contract_id=(select current_contract_id from public.quizlab_user_access where user_id=target_user_id);
 insert into public.quizlab_user_access(user_id,status,starts_at,expires_at,updated_at)values(target_user_id,'pending',null,target_expires_at,now())
 on conflict(user_id)do update set starts_at=null,expires_at=excluded.expires_at,license_revision=quizlab_user_access.license_revision+1,updated_at=now();
 return jsonb_build_object('ok',true,'expiresAt',target_expires_at,'manualOverride',true);
end; $$;

-- Index and summaries are internal: authentication role cannot read the view directly.
create view public.quizlab_admin_user_index as
 select u.id user_id,u.email::text email,u.created_at,u.last_sign_in_at,d.last_seen,
 greatest(d.last_seen,u.last_sign_in_at,pr.last_progress) last_activity,
 coalesce(ua.status,'pending') approval_status,
 case when a.user_id is not null then 'active' when ua.status='active' and ua.expires_at<=now() then 'expired' when ua.status='active' and ua.starts_at>now() then 'pending' else coalesce(ua.status,'pending') end status,
 case when a.user_id is not null then 'active' when ua.status='active' and ua.expires_at<=now() then 'expired' when ua.status='active' and ua.starts_at>now() then 'pending' else coalesce(ua.status,'pending') end account_status,
 ua.expires_at,ua.starts_at,a.user_id is not null is_admin,coalesce(ua.license_revision,1) license_revision,
 coalesce(b.course_count,0)::bigint course_count,coalesce(pr.attempt_count,0)::bigint attempt_count,coalesce(pr.exam_count,0)::bigint exam_count,
 case when c.contract_id is null then null else jsonb_build_object('contract_id',c.contract_id,'plan_id',c.plan_snapshot->>'plan_id','label',c.plan_snapshot->>'label','duration_months',(c.plan_snapshot->>'duration_months')::int,'starts_at',c.starts_at,'ends_at',c.ends_at,'payment_mode',c.plan_snapshot->>'payment_mode','total_cents',(c.plan_snapshot->>'total_cents')::bigint,'currency',c.plan_snapshot->>'currency','manual_override',c.manual_override) end plan
 from auth.users u left join public.quizlab_user_access ua on ua.user_id=u.id left join public.quizlab_admins a on a.user_id=u.id left join public.quizlab_contracts c on c.contract_id=ua.current_contract_id
 left join lateral(select max(last_seen) last_seen from public.quizlab_devices where user_id=u.id)d on true
 left join lateral(select count(*) course_count from public.quizlab_banks where owner_id=u.id)b on true
 left join lateral(select max(updated_at) last_progress,
 coalesce(sum(case when jsonb_typeof(progress_json->'attempts')='array' then jsonb_array_length(progress_json->'attempts') else 0 end),0) attempt_count,
 coalesce(sum(case when jsonb_typeof(progress_json->'exams')='array' then jsonb_array_length(progress_json->'exams') else 0 end),0) exam_count from public.quizlab_user_courses where user_id=u.id)pr on true;
revoke all on public.quizlab_admin_user_index from public,anon,authenticated;
create function public.quizlab_admin_users_page(search_text text default '',approval_filter text default 'all',status_filter text default 'all',plan_filter text default 'all',expiry_filter text default 'all',activity_filter text default 'all',sort_by text default 'email',sort_dir text default 'asc',page_number integer default 1,page_size integer default 25) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare summary jsonb;items jsonb;total_count bigint;
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 if page_number is null or page_size is null or search_text is null or approval_filter is null or status_filter is null or plan_filter is null or expiry_filter is null or activity_filter is null or sort_by is null or sort_dir is null or page_number not between 1 and 100000 or page_size not between 1 and 25 or length(search_text)>256 or approval_filter not in ('all','pending','active','suspended') or status_filter not in ('all','pending','active','suspended','expired') or expiry_filter not in ('all','none','expired','7d','30d') or activity_filter not in ('all','never','7d','30d','inactive30d') or sort_by not in ('email','status','expires_at','last_seen','course_count','created_at') or sort_dir not in ('asc','desc') then raise exception 'invalid user filters or pagination'; end if;
 select jsonb_build_object('total',count(*),'active',count(*)filter(where status='active'),'pending',count(*)filter(where status='pending'),'suspended',count(*)filter(where status='suspended'),'expired',count(*)filter(where status='expired'),'expiring_7d',count(*)filter(where not is_admin and expires_at>now() and expires_at<=now()+interval '7 days')) into summary from public.quizlab_admin_user_index;
 with filtered as(select * from public.quizlab_admin_user_index v where
 (search_text='' or position(lower(search_text) in lower(v.email))>0 or position(lower(search_text) in lower(v.user_id::text))>0)
 and (approval_filter='all' or v.approval_status=approval_filter) and(status_filter='all' or v.status=status_filter)
 and(plan_filter='all' or (plan_filter='none' and v.plan is null) or v.plan->>'plan_id'=plan_filter)
 and(expiry_filter='all' or (expiry_filter='none' and v.expires_at is null) or (expiry_filter='expired' and v.expires_at<=now() and not v.is_admin) or(expiry_filter='7d' and v.expires_at>now() and v.expires_at<=now()+interval '7 days')or(expiry_filter='30d' and v.expires_at>now() and v.expires_at<=now()+interval '30 days'))
 and(activity_filter='all' or(activity_filter='never' and v.last_activity is null)or(activity_filter='7d' and v.last_activity>=now()-interval '7 days')or(activity_filter='30d' and v.last_activity>=now()-interval '30 days')or(activity_filter='inactive30d' and (v.last_activity is null or v.last_activity<now()-interval '30 days')))),
 counted as(select count(*) n from filtered),
 paged as(select * from filtered order by
 case when sort_dir='asc' then case sort_by when 'email' then email when 'status' then status end end asc nulls last,
 case when sort_dir='desc' then case sort_by when 'email' then email when 'status' then status end end desc nulls last,
 case when sort_dir='asc' then case sort_by when 'expires_at' then expires_at when 'last_seen' then last_activity when 'created_at' then created_at end end asc nulls last,
 case when sort_dir='desc' then case sort_by when 'expires_at' then expires_at when 'last_seen' then last_activity when 'created_at' then created_at end end desc nulls last,
 case when sort_dir='asc' and sort_by='course_count' then course_count end asc,
 case when sort_dir='desc' and sort_by='course_count' then course_count end desc,user_id
 limit page_size offset(greatest(1,least(page_number,greatest(1,ceil((select n from counted)::numeric/page_size)::int)))-1)*page_size)
 select(select count(*) from filtered),coalesce((select jsonb_agg(to_jsonb(p))from paged p),'[]') into total_count,items;
 page_number:=greatest(1,least(page_number,greatest(1,ceil(total_count::numeric/page_size)::int)));
 return jsonb_build_object('page',page_number,'page_size',page_size,'total',total_count,'total_pages',greatest(1,ceil(total_count::numeric/page_size)::int),'summary',summary,'items',items);
end; $$;
create function public.quizlab_admin_course_summary() returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(to_jsonb(x))from(select b.course_id,max(b.subject) subject,count(distinct b.owner_id) user_count,
 coalesce(sum(case when jsonb_typeof(uc.progress_json->'attempts')='array' then jsonb_array_length(uc.progress_json->'attempts') else 0 end),0)::bigint attempt_count,
 coalesce(sum(case when jsonb_typeof(uc.progress_json->'exams')='array' then jsonb_array_length(uc.progress_json->'exams') else 0 end),0)::bigint exam_count
 from public.quizlab_banks b left join public.quizlab_user_courses uc on uc.bank_id=b.id group by b.course_id order by b.course_id limit 2000)x),'[]');
end; $$;

create or replace function public.quizlab_admin_user_course_stats_for(target_user_id uuid)
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
  where uc.user_id=target_user_id
  order by uc.updated_at desc;
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
      else coalesce((select case when ua.status='active' and ua.expires_at<=now() then 'expired' when ua.status='active' and ua.starts_at>now() then 'pending' else ua.status end from public.quizlab_user_access ua where ua.user_id=u.id),'pending')
    end::text,
    (select count(*) from public.quizlab_user_courses uc where uc.user_id=u.id)::bigint,
    coalesce((select sum(case when jsonb_typeof(uc.progress_json->'attempts')='array' then jsonb_array_length(uc.progress_json->'attempts') else 0 end) from public.quizlab_user_courses uc where uc.user_id=u.id),0)::bigint,
    coalesce((select sum(case when jsonb_typeof(uc.progress_json->'exams')='array' then jsonb_array_length(uc.progress_json->'exams') else 0 end) from public.quizlab_user_courses uc where uc.user_id=u.id),0)::bigint
  from auth.users u
  order by (select max(d.last_seen) from public.quizlab_devices d where d.user_id=u.id) desc nulls last, u.created_at desc;
end;
$$;


create function public.quizlab_admin_user_detail(target_user_id uuid) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare account jsonb;assignments jsonb;stats jsonb;contracts jsonb;
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 select to_jsonb(v) into account from public.quizlab_admin_user_index v where v.user_id=target_user_id;
 if account is null then raise exception 'user not found'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('bank_id',b.id,'course_id',b.course_id,'subject',b.subject,'revision',b.bank_revision,'managed_by_admin',b.managed_by_admin,'official_count',jsonb_array_length(coalesce(b.bank_json->'officialBank','[]')),'ai_count',jsonb_array_length(coalesce(b.bank_json->'aiBank','[]')),'question_count',jsonb_array_length(coalesce(b.bank_json->'officialBank','[]'))+jsonb_array_length(coalesce(b.bank_json->'aiBank','[]'))) order by b.subject),'[]') into assignments from public.quizlab_banks b where b.owner_id=target_user_id;
 select coalesce(jsonb_agg(to_jsonb(s)),'[]') into stats from public.quizlab_admin_user_course_stats_for(target_user_id)s;
 select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('installments',coalesce((select jsonb_agg(to_jsonb(i) order by i.number) from public.quizlab_installments i where i.contract_id=c.contract_id),'[]')) order by c.created_at desc),'[]') into contracts from public.quizlab_contracts c where c.user_id=target_user_id;
 return jsonb_build_object('user',account,'assignments',assignments,'stats',stats,'contracts',contracts);
end; $$;
create or replace function public.quizlab_admin_user_licenses() returns table(user_id uuid,email text,account_status text,expires_at timestamptz,license_revision bigint,is_admin boolean,assigned_course_count bigint) language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 return query select v.user_id,v.email,v.status,v.expires_at,v.license_revision,v.is_admin,(select count(*)from public.quizlab_banks b where b.owner_id=v.user_id and b.managed_by_admin)from public.quizlab_admin_user_index v order by v.email;
end; $$;
-- Explicit grants; internal request/history/UTC helpers are not directly callable by clients.
revoke all on function public.quizlab_history_immutable(),public.quizlab_contract_snapshot_immutable(),public.quizlab_admin_request_begin(uuid,text,jsonb),public.quizlab_admin_request_finish(uuid,jsonb),public.quizlab_add_utc_months(timestamptz,integer),public.quizlab_admin_user_course_stats_for(uuid) from public,anon,authenticated;
revoke all on function public.quizlab_admin_assign_course_safe(uuid,text,text,jsonb,bigint,text,text,uuid),public.quizlab_admin_bank_snapshot(uuid,text),public.quizlab_admin_bank_history(uuid,text,integer),public.quizlab_admin_history_bank(uuid),public.quizlab_admin_restore_bank(uuid,text,uuid,bigint,uuid),public.quizlab_admin_list_plans(),public.quizlab_admin_save_plan(text,text,integer,text,bigint,text,integer,boolean,uuid,bigint),public.quizlab_admin_preview_contract(uuid,text,text,timestamptz,text,integer),public.quizlab_admin_save_contract(uuid,text,text,uuid,timestamptz,text,integer,bigint,bigint,timestamptz),public.quizlab_admin_set_installment_status(uuid,text,uuid),public.quizlab_admin_users_page(text,text,text,text,text,text,text,text,integer,integer),public.quizlab_admin_user_detail(uuid),public.quizlab_admin_course_summary() from public,anon;
grant execute on function public.quizlab_admin_assign_course_safe(uuid,text,text,jsonb,bigint,text,text,uuid),public.quizlab_admin_bank_snapshot(uuid,text),public.quizlab_admin_bank_history(uuid,text,integer),public.quizlab_admin_history_bank(uuid),public.quizlab_admin_restore_bank(uuid,text,uuid,bigint,uuid),public.quizlab_admin_list_plans(),public.quizlab_admin_save_plan(text,text,integer,text,bigint,text,integer,boolean,uuid,bigint),public.quizlab_admin_preview_contract(uuid,text,text,timestamptz,text,integer),public.quizlab_admin_save_contract(uuid,text,text,uuid,timestamptz,text,integer,bigint,bigint,timestamptz),public.quizlab_admin_set_installment_status(uuid,text,uuid),public.quizlab_admin_users_page(text,text,text,text,text,text,text,text,integer,integer),public.quizlab_admin_user_detail(uuid),public.quizlab_admin_course_summary() to authenticated;


-- Reviewed source: 0122-modules.sql
-- LAB 0.11.20. Existing accounts/contracts retain all modules until explicitly configured.
-- Authentication, account/profile, license refresh and administration remain shared services.
create function public.quizlab_all_modules() returns jsonb language sql immutable as $$
 select '{"lessons":true,"kit_ai":true,"question_banks":true,"handouts":true,"quizlab_desktop":true,"quizlab_pwa":true}'::jsonb;
$$;
create function public.quizlab_validate_modules(value jsonb, partial boolean default false) returns jsonb language plpgsql immutable as $$
declare entry record;
begin
 if value is null or jsonb_typeof(value)<>'object' then raise exception 'modules must be an object'; end if;
 for entry in select * from jsonb_each(value) loop
  if not public.quizlab_all_modules()?entry.key or jsonb_typeof(entry.value)<>'boolean' then raise exception 'unknown module or invalid permission'; end if;
 end loop;
 return case when partial then value else public.quizlab_all_modules()||value end;
end; $$;
create function public.quizlab_module_features(value jsonb) returns jsonb language sql immutable as $$
 select coalesce(jsonb_agg(key order by key),'[]'::jsonb) from jsonb_each(value) where value='true'::jsonb;
$$;
alter table public.quizlab_user_access add column module_overrides jsonb not null default '{}'::jsonb;
alter table public.quizlab_plans add column modules jsonb not null default public.quizlab_all_modules();
alter table public.quizlab_user_access add constraint quizlab_module_overrides_valid check(module_overrides=public.quizlab_validate_modules(module_overrides,true));
alter table public.quizlab_plans add constraint quizlab_plan_modules_valid check(modules=public.quizlab_validate_modules(modules,false));

create function public.quizlab_effective_modules_for(target_user_id uuid) returns jsonb language sql stable security definer set search_path=public,auth as $$
 select case when exists(select 1 from public.quizlab_admins where user_id=target_user_id) then public.quizlab_all_modules()
 else coalesce((select coalesce(c.plan_snapshot->'modules',public.quizlab_all_modules())||ua.module_overrides
 from public.quizlab_user_access ua left join public.quizlab_contracts c on c.contract_id=ua.current_contract_id where ua.user_id=target_user_id),public.quizlab_all_modules()) end;
$$;
create function public.quizlab_has_feature(feature text) returns boolean language sql stable security definer set search_path=public,auth as $$
 select coalesce(auth.uid() is not null and public.quizlab_access_allowed() and public.quizlab_all_modules()?feature
 and coalesce((public.quizlab_effective_modules_for(auth.uid())->>feature)::boolean,false),false);
$$;
create function public.quizlab_quiz_access_allowed() returns boolean language sql stable security definer set search_path=public,auth as $$
 select public.quizlab_has_feature('quizlab_desktop') or public.quizlab_has_feature('quizlab_pwa');
$$;
create or replace function public.quizlab_license_status() returns jsonb language sql stable security definer set search_path=public,auth as $$
 select jsonb_build_object('userId',auth.uid(),'status',public.quizlab_account_status(),'isAdmin',public.quizlab_is_admin(),
 'expiresAt',case when public.quizlab_is_admin() then null else (select expires_at from public.quizlab_user_access where user_id=auth.uid()) end,
 'licenseRevision',coalesce((select license_revision from public.quizlab_user_access where user_id=auth.uid()),1),'serverTime',now(),'offlineHours',24,
 'modules',public.quizlab_effective_modules_for(auth.uid()),'features',public.quizlab_module_features(public.quizlab_effective_modules_for(auth.uid())));
$$;

-- Every exposed bank/progress path checks current server permissions, including security-definer RPCs.
drop policy if exists "banks_owner_or_shared_select" on public.quizlab_banks;
create policy "banks_owner_or_shared_select" on public.quizlab_banks for select to authenticated
 using(owner_id=auth.uid() and public.quizlab_quiz_access_allowed() and not public.quizlab_course_blocked(course_id));
drop policy if exists "banks_owner_insert" on public.quizlab_banks;
create policy "banks_owner_insert" on public.quizlab_banks for insert to authenticated
 with check(owner_id=auth.uid() and public.quizlab_quiz_access_allowed() and not public.quizlab_course_blocked(course_id));
drop policy if exists "banks_owner_update" on public.quizlab_banks;
create policy "banks_owner_update" on public.quizlab_banks for update to authenticated
 using(owner_id=auth.uid() and public.quizlab_quiz_access_allowed() and not public.quizlab_course_blocked(course_id))
 with check(owner_id=auth.uid() and public.quizlab_quiz_access_allowed() and not public.quizlab_course_blocked(course_id));
drop policy if exists "banks_owner_delete" on public.quizlab_banks;
create policy "banks_owner_delete" on public.quizlab_banks for delete to authenticated
 using(owner_id=auth.uid() and public.quizlab_quiz_access_allowed() and not public.quizlab_course_blocked(course_id));
drop policy if exists "user_courses_own" on public.quizlab_user_courses;
create policy "user_courses_own" on public.quizlab_user_courses for all to authenticated
 using(user_id=auth.uid() and public.quizlab_quiz_access_allowed())
 with check(user_id=auth.uid() and public.quizlab_quiz_access_allowed() and exists(select 1 from public.quizlab_banks b where b.id=bank_id and b.owner_id=auth.uid()));

alter function public.quizlab_save_bank_v2(text,bigint,jsonb,text,text) rename to quizlab_save_bank_pre_modules;
create function public.quizlab_save_bank_v2(target_course_id text,expected_revision bigint,incoming_bank jsonb,target_subject text default null,incoming_hash text default null) returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_quiz_access_allowed() then raise exception 'QuizLab module not authorized' using errcode='42501'; end if;
 return public.quizlab_save_bank_pre_modules(target_course_id,expected_revision,incoming_bank,target_subject,incoming_hash);
end; $$;
alter function public.quizlab_save_progress_v2(uuid,bigint,jsonb) rename to quizlab_save_progress_pre_modules;
create function public.quizlab_save_progress_v2(target_bank_id uuid,expected_revision bigint,incoming_progress jsonb) returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_quiz_access_allowed() then raise exception 'QuizLab module not authorized' using errcode='42501'; end if;
 return public.quizlab_save_progress_pre_modules(target_bank_id,expected_revision,incoming_progress);
end; $$;
alter function public.quizlab_delete_my_course(text) rename to quizlab_delete_course_pre_modules;
create function public.quizlab_delete_my_course(target_course_id text) returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_quiz_access_allowed() then raise exception 'QuizLab module not authorized' using errcode='42501'; end if;
 return public.quizlab_delete_course_pre_modules(target_course_id);
end; $$;
alter function public.quizlab_restore_my_course(text) rename to quizlab_restore_course_pre_modules;
create function public.quizlab_restore_my_course(target_course_id text) returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_quiz_access_allowed() then raise exception 'QuizLab module not authorized' using errcode='42501'; end if;
 return public.quizlab_restore_course_pre_modules(target_course_id);
end; $$;

create function public.quizlab_admin_save_user_access(target_user_id uuid,approval_status text,module_overrides jsonb,expected_license_revision bigint,request_id uuid) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare reply jsonb;current_revision bigint;account jsonb;normalized jsonb;
begin
 reply:=public.quizlab_admin_request_begin(request_id,'save_user_access',jsonb_build_object('user',target_user_id,'status',approval_status,'overrides',module_overrides,'revision',expected_license_revision));
 if reply is not null then return reply; end if;
 if exists(select 1 from public.quizlab_admins where user_id=target_user_id) then raise exception 'administrator access is protected' using errcode='42501'; end if;
 if not exists(select 1 from auth.users where id=target_user_id) then raise exception 'user not found'; end if;
 if approval_status is null or approval_status not in ('pending','active','suspended') then raise exception 'invalid approval status'; end if;
 normalized:=public.quizlab_validate_modules(module_overrides,true);
 perform pg_advisory_xact_lock(hashtextextended(target_user_id::text||':license',0));
 select license_revision into current_revision from public.quizlab_user_access where user_id=target_user_id for update;
 current_revision:=coalesce(current_revision,1);
 if expected_license_revision is null or expected_license_revision<>current_revision then return public.quizlab_admin_request_finish(request_id,jsonb_build_object('ok',false,'conflict',true,'reason','license_changed','license_revision',current_revision)); end if;
 insert into public.quizlab_user_access(user_id,status,module_overrides,license_revision,updated_at)
 values(target_user_id,approval_status,normalized,current_revision+1,now()) on conflict(user_id) do update
 set status=excluded.status,module_overrides=excluded.module_overrides,license_revision=excluded.license_revision,updated_at=now();
 select to_jsonb(v) into account from public.quizlab_admin_user_index v where v.user_id=target_user_id;
 return public.quizlab_admin_request_finish(request_id,account||jsonb_build_object('ok',true,'user',account));
end; $$;

revoke all on function public.quizlab_all_modules(),public.quizlab_validate_modules(jsonb,boolean),public.quizlab_module_features(jsonb),public.quizlab_effective_modules_for(uuid),public.quizlab_save_bank_pre_modules(text,bigint,jsonb,text,text),public.quizlab_save_progress_pre_modules(uuid,bigint,jsonb),public.quizlab_delete_course_pre_modules(text),public.quizlab_restore_course_pre_modules(text) from public,anon,authenticated;
-- Constraint helpers require authenticated execution; their only result is validated public module metadata.
grant execute on function public.quizlab_all_modules(),public.quizlab_validate_modules(jsonb,boolean) to authenticated;
revoke all on function public.quizlab_has_feature(text),public.quizlab_quiz_access_allowed(),public.quizlab_admin_save_user_access(uuid,text,jsonb,bigint,uuid),public.quizlab_save_bank_v2(text,bigint,jsonb,text,text),public.quizlab_save_progress_v2(uuid,bigint,jsonb),public.quizlab_delete_my_course(text),public.quizlab_restore_my_course(text) from public,anon;
grant execute on function public.quizlab_has_feature(text),public.quizlab_quiz_access_allowed(),public.quizlab_admin_save_user_access(uuid,text,jsonb,bigint,uuid),public.quizlab_save_bank_v2(text,bigint,jsonb,text,text),public.quizlab_save_progress_v2(uuid,bigint,jsonb),public.quizlab_delete_my_course(text),public.quizlab_restore_my_course(text) to authenticated;


-- Configurable plan modules are frozen in new contracts; old snapshots remain unchanged.
alter function public.quizlab_admin_save_plan(text,text,integer,text,bigint,text,integer,boolean,uuid,bigint) rename to quizlab_admin_save_plan_pre_modules;
create function public.quizlab_admin_save_plan(plan_id text,label text,duration_months integer,currency text,total_cents bigint,payment_mode text,installment_count integer,active boolean,request_id uuid,expected_version bigint default 0,modules jsonb default null) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare p public.quizlab_plans%rowtype;reply jsonb;normalized jsonb;
begin
 reply:=public.quizlab_admin_request_begin(request_id,'save_plan',jsonb_build_object('plan',plan_id,'label',label,'months',duration_months,'currency',currency,'cents',total_cents,'mode',payment_mode,'count',installment_count,'active',active,'version',expected_version,'modules',modules));if reply is not null then return reply; end if;
 if plan_id !~ '^[a-zA-Z0-9_-]{1,64}$' or plan_id in ('__proto__','constructor','prototype') or coalesce(trim(label),'')='' or length(label)>120 then raise exception 'invalid plan id/label'; end if;
 perform pg_advisory_xact_lock(hashtextextended('plan:'||plan_id,0));
 select * into p from public.quizlab_plans qp where qp.plan_id=$1 for update;
 if coalesce(p.version,0)<>coalesce(expected_version,-1) then return public.quizlab_admin_request_finish(request_id,jsonb_build_object('ok',false,'conflict',true,'reason','plan_changed','version',coalesce(p.version,0))); end if;
 normalized:=public.quizlab_validate_modules(coalesce(modules,p.modules,public.quizlab_all_modules()),false);
 insert into public.quizlab_plans(plan_id,label,duration_months,currency,total_cents,payment_mode,installment_count,active,modules)
 values($1,trim($2),$3,$4,$5,$6,$7,$8,normalized) on conflict on constraint quizlab_plans_pkey do update set label=excluded.label,duration_months=excluded.duration_months,currency=excluded.currency,total_cents=excluded.total_cents,payment_mode=excluded.payment_mode,installment_count=excluded.installment_count,active=excluded.active,modules=excluded.modules,version=quizlab_plans.version+1,updated_at=now() returning * into p;
 return public.quizlab_admin_request_finish(request_id,jsonb_build_object('ok',true,'plan',to_jsonb(p)));
end; $$;

create or replace function public.quizlab_admin_preview_contract(target_user_id uuid,plan_id text,action text,starts_at timestamptz default null,payment_mode text default null,installment_count integer default null) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare p public.quizlab_plans%rowtype;ua public.quizlab_user_access%rowtype;start_time timestamptz;end_time timestamptz;mode text;parts integer;i integer;rows jsonb:='[]';snapshot jsonb;
begin
 if not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 if exists(select 1 from public.quizlab_admins where user_id=target_user_id) then raise exception 'administrator license is protected'; end if;
 if not exists(select 1 from auth.users where id=target_user_id) then raise exception 'user not found'; end if;
 if action is null or action not in ('activate','renew') then raise exception 'action must be activate or renew'; end if;
 select * into p from public.quizlab_plans qp where qp.plan_id=$2;
 if not found or not p.active then raise exception 'plan not available'; end if;
 select * into ua from public.quizlab_user_access where user_id=target_user_id;
 mode:=coalesce(payment_mode,p.payment_mode);parts:=coalesce(installment_count,case when mode='full' then 1 else p.installment_count end);
 if mode not in ('full','installments') or parts not between 1 and p.duration_months or (mode='full' and parts<>1) then raise exception 'invalid payment schedule'; end if;
 if action='renew' then
  if starts_at is not null then raise exception 'renew starts from current expiry or now'; end if;
  start_time:=greatest(now(),ua.expires_at);
 else
  start_time:=coalesce(starts_at,now());
  if start_time<now()-interval '2 minutes' then raise exception 'activation must start now or in the future'; end if;
 end if;
 end_time:=public.quizlab_add_utc_months(start_time,p.duration_months);
 snapshot:=to_jsonb(p)-'updated_at'||jsonb_build_object('payment_mode',mode,'installment_count',parts);
 for i in 1..parts loop
  rows:=rows||jsonb_build_array(jsonb_build_object('number',i,'due_at',public.quizlab_add_utc_months(start_time,i-1),'amount_cents',p.total_cents/parts+case when i<=p.total_cents%parts then 1 else 0 end,'currency',p.currency,'status','scheduled'));
 end loop;
 return jsonb_build_object('user_id',target_user_id,'action',action,'starts_at',start_time,'ends_at',end_time,'plan_snapshot',snapshot,'installments',rows,'previous_expires_at',ua.expires_at,'license_revision',coalesce(ua.license_revision,1),'modules',p.modules||coalesce(ua.module_overrides,'{}'::jsonb),'features',public.quizlab_module_features(p.modules||coalesce(ua.module_overrides,'{}'::jsonb)));
end; $$;

create or replace view public.quizlab_admin_user_index as
 select u.id user_id,u.email::text email,u.created_at,u.last_sign_in_at,d.last_seen,
 greatest(d.last_seen,u.last_sign_in_at,pr.last_progress) last_activity,
 coalesce(ua.status,'pending') approval_status,
 case when a.user_id is not null then 'active' when ua.status='active' and ua.expires_at<=now() then 'expired' when ua.status='active' and ua.starts_at>now() then 'pending' else coalesce(ua.status,'pending') end status,
 case when a.user_id is not null then 'active' when ua.status='active' and ua.expires_at<=now() then 'expired' when ua.status='active' and ua.starts_at>now() then 'pending' else coalesce(ua.status,'pending') end account_status,
 ua.expires_at,ua.starts_at,a.user_id is not null is_admin,coalesce(ua.license_revision,1) license_revision,
 coalesce(b.course_count,0)::bigint course_count,coalesce(pr.attempt_count,0)::bigint attempt_count,coalesce(pr.exam_count,0)::bigint exam_count,
 case when c.contract_id is null then null else jsonb_build_object('contract_id',c.contract_id,'plan_id',c.plan_snapshot->>'plan_id','label',c.plan_snapshot->>'label','duration_months',(c.plan_snapshot->>'duration_months')::int,'starts_at',c.starts_at,'ends_at',c.ends_at,'payment_mode',c.plan_snapshot->>'payment_mode','total_cents',(c.plan_snapshot->>'total_cents')::bigint,'currency',c.plan_snapshot->>'currency','manual_override',c.manual_override) end plan,
 coalesce(c.plan_snapshot->'modules',public.quizlab_all_modules()) module_defaults,
 coalesce(ua.module_overrides,'{}'::jsonb) module_overrides,
 public.quizlab_effective_modules_for(u.id) modules,
 public.quizlab_module_features(public.quizlab_effective_modules_for(u.id)) features
 from auth.users u left join public.quizlab_user_access ua on ua.user_id=u.id left join public.quizlab_admins a on a.user_id=u.id left join public.quizlab_contracts c on c.contract_id=ua.current_contract_id
 left join lateral(select max(last_seen) last_seen from public.quizlab_devices where user_id=u.id)d on true
 left join lateral(select count(*) course_count from public.quizlab_banks where owner_id=u.id)b on true
 left join lateral(select max(updated_at) last_progress,
 coalesce(sum(case when jsonb_typeof(progress_json->'attempts')='array' then jsonb_array_length(progress_json->'attempts') else 0 end),0) attempt_count,
 coalesce(sum(case when jsonb_typeof(progress_json->'exams')='array' then jsonb_array_length(progress_json->'exams') else 0 end),0) exam_count from public.quizlab_user_courses where user_id=u.id)pr on true;
revoke all on function public.quizlab_admin_save_plan_pre_modules(text,text,integer,text,bigint,text,integer,boolean,uuid,bigint) from public,anon,authenticated;
revoke all on function public.quizlab_admin_save_plan(text,text,integer,text,bigint,text,integer,boolean,uuid,bigint,jsonb) from public,anon;
grant execute on function public.quizlab_admin_save_plan(text,text,integer,text,bigint,text,integer,boolean,uuid,bigint,jsonb) to authenticated;


-- Reviewed source: 0124-restore-json.sql
-- Keep the public JSON contract when the underlying restore returns boolean.
create or replace function public.quizlab_restore_my_course(target_course_id text)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
begin
 if not public.quizlab_quiz_access_allowed() then
  raise exception 'QuizLab module not authorized' using errcode='42501';
 end if;
 return to_jsonb(public.quizlab_restore_course_pre_modules(target_course_id));
end; $$;
revoke all on function public.quizlab_restore_my_course(text) from public,anon;
grant execute on function public.quizlab_restore_my_course(text) to authenticated;

-- Server-held signing material: inaccessible to browser roles and never returned by public routes.
create table quizlab_release_private.runtime_keys(
 id boolean primary key default true check(id),value jsonb not null,created_at timestamptz not null default now()
);
alter table quizlab_release_private.runtime_keys enable row level security;
revoke all on quizlab_release_private.runtime_keys from public,anon,authenticated;
create function public.quizlab_runtime_key(candidate jsonb default null) returns jsonb
 language plpgsql security definer set search_path=pg_catalog,quizlab_release_private as $$
declare result jsonb;
begin
 if coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','')<>'service_role' then raise exception 'forbidden' using errcode='42501'; end if;
 if candidate is not null then
  if jsonb_typeof(candidate) is distinct from 'object'
   or candidate->>'algorithm' is distinct from 'Ed25519'
   or jsonb_typeof(candidate->'privateJwk') is distinct from 'object'
   or candidate->'privateJwk'->>'kty' is distinct from 'OKP'
   or candidate->'privateJwk'->>'crv' is distinct from 'Ed25519'
   or coalesce(candidate->'privateJwk'->>'d','') !~ '^[A-Za-z0-9_-]{43}$'
   or coalesce(candidate->'privateJwk'->>'x','') !~ '^[A-Za-z0-9_-]{43}$'
   or coalesce(candidate->>'publicSpki','') !~ '^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$'
  then raise exception 'invalid key' using errcode='22023'; end if;
  insert into quizlab_release_private.runtime_keys(id,value) values(true,candidate) on conflict(id) do nothing;
 end if;
 select value into result from quizlab_release_private.runtime_keys where id;
 return result;
end; $$;
revoke all on function public.quizlab_runtime_key(jsonb) from public,anon,authenticated;
grant execute on function public.quizlab_runtime_key(jsonb) to service_role;

create table quizlab_release_private.egress_monitor(
 id boolean primary key default true check(id),value jsonb not null,updated_by uuid references auth.users(id),updated_at timestamptz not null default now()
);
alter table quizlab_release_private.egress_monitor enable row level security;
revoke all on quizlab_release_private.egress_monitor from public,anon,authenticated;
create function public.quizlab_admin_egress(input jsonb default null) returns jsonb
 language plpgsql security definer set search_path=pg_catalog,public,quizlab_release_private as $$
declare result jsonb; revision bigint; snapshot jsonb; thresholds jsonb; entry record;
 observed_at timestamptz; period_start timestamptz; period_end timestamptz; reset_at timestamptz;
begin
 if auth.uid() is null or not public.quizlab_is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('quizlab-egress',0));
 select value into result from quizlab_release_private.egress_monitor where id for update;
 result:=coalesce(result,'{"version":1,"snapshot":null,"thresholds":[70,90],"revision":0}'::jsonb);
 if input is not null then
  if jsonb_typeof(input) is distinct from 'object' or octet_length(input::text)>8192
   or not input ?& array['expectedRevision','snapshot','thresholds']
   or exists(select 1 from jsonb_object_keys(input) key where key not in ('expectedRevision','snapshot','thresholds'))
   or jsonb_typeof(input->'expectedRevision') is distinct from 'number'
   or coalesce(input->>'expectedRevision','') !~ '^(0|[1-9][0-9]{0,15})$'
   or (input->>'expectedRevision')::numeric>9007199254740991
  then raise exception 'invalid snapshot' using errcode='22023'; end if;
  thresholds:=input->'thresholds';
  if jsonb_typeof(thresholds) is distinct from 'array' then raise exception 'invalid thresholds' using errcode='22023'; end if;
  if jsonb_array_length(thresholds)<>2 then raise exception 'invalid thresholds' using errcode='22023'; end if;
  if jsonb_typeof(thresholds->0) is distinct from 'number' or jsonb_typeof(thresholds->1) is distinct from 'number'
  then raise exception 'invalid thresholds' using errcode='22023'; end if;
  if (thresholds->>0)::numeric<=0 or (thresholds->>1)::numeric>=100 or (thresholds->>0)::numeric>=(thresholds->>1)::numeric
  then raise exception 'invalid thresholds' using errcode='22023'; end if;
  snapshot:=input->'snapshot';
  if snapshot<>'null'::jsonb then
   if jsonb_typeof(snapshot) is distinct from 'object' then raise exception 'invalid snapshot' using errcode='22023'; end if;
   if exists(select 1 from jsonb_object_keys(snapshot) key where key not in ('usedBytes','quotaBytes','cachedUsedBytes','cachedQuotaBytes','periodStart','periodEnd','resetAt','observedAt','restricted','scope','source'))
    or snapshot->>'scope' not in ('organization','project') or snapshot->>'scope' is null
    or snapshot->>'source' is distinct from 'supabase-usage-manual'
    or jsonb_typeof(snapshot->'restricted') is distinct from 'boolean'
   then raise exception 'invalid snapshot source or fields' using errcode='22023'; end if;
   for entry in select * from jsonb_each(snapshot) where key in ('usedBytes','quotaBytes','cachedUsedBytes','cachedQuotaBytes') loop
    if entry.value<>'null'::jsonb then
     if jsonb_typeof(entry.value) is distinct from 'number' then raise exception 'invalid byte count' using errcode='22023'; end if;
     if entry.value::text !~ '^(0|[1-9][0-9]{0,15})$' or entry.value::text::numeric>9007199254740991
      or (entry.key in ('quotaBytes','cachedQuotaBytes') and entry.value::text::numeric=0)
     then raise exception 'invalid byte count' using errcode='22023'; end if;
    end if;
   end loop;
   if coalesce(snapshot->'usedBytes','null'::jsonb)='null'::jsonb and coalesce(snapshot->'cachedUsedBytes','null'::jsonb)='null'::jsonb
   then raise exception 'missing usage measurement' using errcode='22023'; end if;
   begin
    if jsonb_typeof(snapshot->'observedAt') is distinct from 'string' or length(snapshot->>'observedAt')>40 then raise exception 'invalid observed date' using errcode='22023'; end if;
    observed_at:=(snapshot->>'observedAt')::timestamptz;
    for entry in select * from jsonb_each(snapshot) where key in ('periodStart','periodEnd','resetAt') loop
     if entry.value<>'null'::jsonb and (jsonb_typeof(entry.value) is distinct from 'string' or length(entry.value#>>'{}')>40)
     then raise exception 'invalid period date' using errcode='22023'; end if;
    end loop;
    period_start:=(snapshot->>'periodStart')::timestamptz;
    period_end:=(snapshot->>'periodEnd')::timestamptz;
    reset_at:=(snapshot->>'resetAt')::timestamptz;
   exception when invalid_datetime_format or datetime_field_overflow then raise exception 'invalid snapshot date' using errcode='22023'; end;
   if not isfinite(observed_at) or observed_at>now()+interval '1 minute'
    or (period_start is not null and (not isfinite(period_start) or observed_at<period_start))
    or (period_end is not null and (not isfinite(period_end) or observed_at>period_end))
    or (reset_at is not null and not isfinite(reset_at))
    or (period_start is not null and period_end is not null and period_end<=period_start)
   then raise exception 'invalid snapshot period' using errcode='22023'; end if;
  end if;
  revision:=(result->>'revision')::bigint;
  if coalesce((input->>'expectedRevision')::bigint,-1)<>revision then raise exception 'Egress revision changed' using errcode='40001'; end if;
  result:=jsonb_build_object('version',1,'snapshot',input->'snapshot','thresholds',input->'thresholds','revision',revision+1,'updatedAt',now());
  insert into quizlab_release_private.egress_monitor(id,value,updated_by) values(true,result,auth.uid()) on conflict(id) do update set value=excluded.value,updated_by=excluded.updated_by,updated_at=now();
 end if;
 return result;
end; $$;
revoke all on function public.quizlab_admin_egress(jsonb) from public,anon;
grant execute on function public.quizlab_admin_egress(jsonb) to authenticated;

-- Helpers need no public API surface. Public entry points above perform role/ownership checks.
revoke all on public.quizlab_admin_user_index from public,anon,authenticated;
create index if not exists quizlab_banks_assigned_by_idx on public.quizlab_banks(assigned_by);
create index if not exists quizlab_history_actor_idx on public.quizlab_bank_history(actor_id);
create index if not exists quizlab_history_bank_idx on public.quizlab_bank_history(bank_id);
create index if not exists quizlab_contracts_actor_idx on public.quizlab_contracts(actor_id);
create index if not exists quizlab_access_contract_idx on public.quizlab_user_access(current_contract_id);
create index if not exists quizlab_progress_bank_idx on public.quizlab_user_courses(bank_id);
notify pgrst,'reload schema';
