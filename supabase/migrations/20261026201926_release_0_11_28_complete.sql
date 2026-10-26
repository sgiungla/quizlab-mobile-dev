create table quizlab_release_private.before_01128_quizlab_banks as table public.quizlab_banks;
create table quizlab_release_private.before_01128_quizlab_user_courses as table public.quizlab_user_courses;
create table quizlab_release_private.before_01128_quizlab_user_access as table public.quizlab_user_access;
create table quizlab_release_private.before_01128_quizlab_contracts as table public.quizlab_contracts;
create table quizlab_release_private.before_01128_quizlab_installments as table public.quizlab_installments;
create table quizlab_release_private.before_01128_quizlab_plans as table public.quizlab_plans;
create table quizlab_release_private.before_01128_quizlab_bank_history as table public.quizlab_bank_history;
create table quizlab_release_private.before_01128_quizlab_admin_requests as table public.quizlab_admin_requests;
-- Local commerce only. No payment credentials, remote calls or changes to existing grants.
create table public.quizlab_shop_products(
 product_id text primary key check(product_id ~ '^[a-zA-Z0-9_-]{1,64}$'),
 label text not null check(length(label) between 1 and 120),
 total_cents bigint not null check(total_cents between 0 and 1000000000),
 currency text not null default 'EUR' check(currency='EUR'),
 source_bank_id uuid references public.quizlab_banks(id) on delete set null,
 active boolean not null default false,version bigint not null default 1,updated_at timestamptz not null default now()
);
create table public.quizlab_shop_orders(
 order_id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),
 request_id uuid not null,kind text not null check(kind in ('plan','course')),item_id text not null,
 snapshot jsonb not null,source_bank jsonb,expected_license_revision bigint not null,
 provider_session_id text unique not null,status text not null default 'awaiting_payment'
 check(status in ('awaiting_payment','payment_failed','paid_pending_review','fulfilled')),
 contract_id uuid references public.quizlab_contracts(contract_id),fulfillment jsonb,
 payment_issues jsonb not null default '{}'::jsonb check(jsonb_typeof(payment_issues)='object'),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(user_id,request_id)
);
create table public.quizlab_shop_events(
 event_id text primary key,payload_hash text not null,order_id uuid not null references public.quizlab_shop_orders(order_id),
 event_type text not null,result jsonb not null,created_at timestamptz not null default now()
);
alter table public.quizlab_shop_products enable row level security;
alter table public.quizlab_shop_orders enable row level security;
alter table public.quizlab_shop_events enable row level security;
revoke all on public.quizlab_shop_products,public.quizlab_shop_orders,public.quizlab_shop_events from public,anon,authenticated;
create function public.quizlab_shop_snapshot_immutable() returns trigger language plpgsql set search_path=pg_catalog,public,auth as $$
begin
 if row(new.order_id,new.user_id,new.request_id,new.kind,new.item_id,new.snapshot,new.source_bank,new.expected_license_revision,new.provider_session_id,new.created_at)
 is distinct from row(old.order_id,old.user_id,old.request_id,old.kind,old.item_id,old.snapshot,old.source_bank,old.expected_license_revision,old.provider_session_id,old.created_at)
 then raise exception 'purchase snapshot is immutable' using errcode='42501'; end if;
 return new;
end; $$;
create trigger quizlab_shop_snapshot_immutable before update on public.quizlab_shop_orders for each row execute function public.quizlab_shop_snapshot_immutable();
revoke all on function public.quizlab_shop_snapshot_immutable() from public,anon,authenticated;

-- Only commerce renewals defer plan modules until their paid period begins.
-- Existing manual-contract semantics and account overrides remain unchanged.
-- More than one prepaid renewal is possible: walk the previous contract chain
-- until the contract whose period has begun (or a manual contract) is reached.
create function public.quizlab_current_plan_modules_for(target_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare ua public.quizlab_user_access%rowtype;c public.quizlab_contracts%rowtype;
 previous_id uuid;seen uuid[]:='{}';defaults jsonb:=public.quizlab_all_modules();
begin
 if exists(select 1 from public.quizlab_admins where user_id=target_user_id) then return defaults; end if;
 select * into ua from public.quizlab_user_access where user_id=target_user_id;
 if not found then return defaults; end if;
 previous_id:=ua.current_contract_id;
 while previous_id is not null loop
  if previous_id=any(seen) then raise exception 'invalid commerce contract chain'; end if;
  seen:=array_append(seen,previous_id);
  select * into c from public.quizlab_contracts where contract_id=previous_id and user_id=target_user_id;
  if not found then raise exception 'commerce contract not found'; end if;
  defaults:=coalesce(c.plan_snapshot->'modules',public.quizlab_all_modules());
  if c.starts_at<=now() then exit; end if;
  select nullif(o.fulfillment->>'previous_contract_id','')::uuid into previous_id
   from public.quizlab_shop_orders o where o.contract_id=c.contract_id and o.user_id=target_user_id
    and o.kind='plan' and o.status='fulfilled' order by o.created_at desc limit 1;
  if not found then exit; end if; -- a manual contract retains its original behavior
  if previous_id is null then defaults:=public.quizlab_all_modules(); end if;
 end loop;
 return defaults;
end; $$;
revoke all on function public.quizlab_current_plan_modules_for(uuid) from public,anon,authenticated;

create or replace function public.quizlab_effective_modules_for(target_user_id uuid)
returns jsonb language sql stable security definer set search_path=public,auth as $$
 select case when exists(select 1 from public.quizlab_admins where user_id=target_user_id) then public.quizlab_all_modules()
 else public.quizlab_current_plan_modules_for(target_user_id)||coalesce((select module_overrides from public.quizlab_user_access where user_id=target_user_id),'{}'::jsonb) end;
$$;

-- The administrator's "from plan" controls must use the same current period
-- as the signed license; otherwise a future renewal would show false defaults.
create or replace view public.quizlab_admin_user_index as
 select u.id user_id,u.email::text email,u.created_at,u.last_sign_in_at,d.last_seen,
 greatest(d.last_seen,u.last_sign_in_at,pr.last_progress) last_activity,
 coalesce(ua.status,'pending') approval_status,
 case when a.user_id is not null then 'active' when ua.status='active' and ua.expires_at<=now() then 'expired' when ua.status='active' and ua.starts_at>now() then 'pending' else coalesce(ua.status,'pending') end status,
 case when a.user_id is not null then 'active' when ua.status='active' and ua.expires_at<=now() then 'expired' when ua.status='active' and ua.starts_at>now() then 'pending' else coalesce(ua.status,'pending') end account_status,
 ua.expires_at,ua.starts_at,a.user_id is not null is_admin,coalesce(ua.license_revision,1) license_revision,
 coalesce(b.course_count,0)::bigint course_count,coalesce(pr.attempt_count,0)::bigint attempt_count,coalesce(pr.exam_count,0)::bigint exam_count,
 case when c.contract_id is null then null else jsonb_build_object('contract_id',c.contract_id,'plan_id',c.plan_snapshot->>'plan_id','label',c.plan_snapshot->>'label','duration_months',(c.plan_snapshot->>'duration_months')::int,'starts_at',c.starts_at,'ends_at',c.ends_at,'payment_mode',c.plan_snapshot->>'payment_mode','total_cents',(c.plan_snapshot->>'total_cents')::bigint,'currency',c.plan_snapshot->>'currency','manual_override',c.manual_override) end plan,
 public.quizlab_current_plan_modules_for(u.id) module_defaults,
 coalesce(ua.module_overrides,'{}'::jsonb) module_overrides,
 public.quizlab_effective_modules_for(u.id) modules,
 public.quizlab_module_features(public.quizlab_effective_modules_for(u.id)) features
 from auth.users u left join public.quizlab_user_access ua on ua.user_id=u.id left join public.quizlab_admins a on a.user_id=u.id left join public.quizlab_contracts c on c.contract_id=ua.current_contract_id
 left join lateral(select max(last_seen) last_seen from public.quizlab_devices where user_id=u.id)d on true
 left join lateral(select count(*) course_count from public.quizlab_banks where owner_id=u.id)b on true
 left join lateral(select max(updated_at) last_progress,
 coalesce(sum(case when jsonb_typeof(progress_json->'attempts')='array' then jsonb_array_length(progress_json->'attempts') else 0 end),0) attempt_count,
 coalesce(sum(case when jsonb_typeof(progress_json->'exams')='array' then jsonb_array_length(progress_json->'exams') else 0 end),0) exam_count from public.quizlab_user_courses where user_id=u.id)pr on true;

-- Additive LAB migration. Existing banks, attempts, exams and auth are untouched.
create table public.quizlab_notification_preferences (
 user_id uuid primary key references auth.users(id) on delete cascade,
 revision bigint not null default 1, settings jsonb not null, updated_at timestamptz not null default now()
);
create table public.quizlab_study_items (
 item_id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
 kind text not null check(kind in ('goal','exam')), revision bigint not null default 1,
 data jsonb not null, deleted boolean not null default false, updated_at timestamptz not null default now()
);
create index quizlab_study_items_owner on public.quizlab_study_items(user_id,kind,deleted);
create table public.quizlab_notification_devices (
 user_id uuid not null references auth.users(id) on delete cascade, device_id text not null,
 label text not null, subscription jsonb, endpoint_hash text unique, enabled boolean not null default false,
 permission text not null default 'default', clean boolean not null default false,
 last_seen timestamptz not null default now(), active_until timestamptz,
 primary key(user_id,device_id)
);
create table public.quizlab_notifications (
 notification_id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
 event_key text not null, category text not null check(category in ('study','progress','service','marketing')),
 title text not null, message text not null, destination text not null default './',
 essential boolean not null default false, automatic boolean not null default false,
 priority integer not null default 1, context jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(), due_at timestamptz not null,
 expires_at timestamptz not null, state text not null default 'queued',
 delivery_cancelled boolean not null default false,
 read_at timestamptz, archived_at timestamptz, unique(user_id,event_key)
);
alter table public.quizlab_notifications add column next_check_at timestamptz not null default now();
create index quizlab_notifications_inbox on public.quizlab_notifications(user_id,created_at desc);
create index quizlab_notifications_due on public.quizlab_notifications(state,due_at);
create table public.quizlab_notification_deliveries (
 notification_id uuid not null references public.quizlab_notifications(notification_id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade, device_id text not null,
 status text not null, attempts integer not null default 0, retry_at timestamptz,
 attempt_started_at timestamptz,
 provider_status integer, failure text, accepted_at timestamptz, received_at timestamptz, clicked_at timestamptz,
 primary key(notification_id,device_id)
);
create table public.quizlab_study_badges (
 user_id uuid not null references auth.users(id) on delete cascade, badge_key text not null,
 label text not null, awarded_at timestamptz not null default now(), evidence jsonb not null,
 primary key(user_id,badge_key)
);
create table public.quizlab_notification_automations (
 automation_id text primary key, revision bigint not null default 1, config jsonb not null,
 updated_at timestamptz not null default now()
);
create table public.quizlab_notification_campaigns (
 campaign_id uuid primary key, actor_id uuid not null references auth.users(id), revision bigint not null default 1,
 data jsonb not null, state text not null default 'draft', scheduled_at timestamptz,
 generated_count integer not null default 0,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.quizlab_notification_audit (
 audit_id uuid primary key default gen_random_uuid(), actor_id uuid references auth.users(id),
 action text not null, detail jsonb not null default '{}'::jsonb, at timestamptz not null default now()
);
create table public.quizlab_study_requests (
 user_id uuid not null references auth.users(id) on delete cascade, request_id uuid not null,
 fingerprint text not null, result jsonb not null, primary key(user_id,request_id)
);
create unique index quizlab_notification_interaction_once on public.quizlab_notification_audit
 (actor_id,action,(detail->>'notification_id'),(detail->>'device_id'))
 where action in ('notification_session','notification_review');
create table public.quizlab_study_snapshots (
 user_id uuid primary key references auth.users(id) on delete cascade, signature text not null,
 data jsonb not null, consolidated_at timestamptz not null default now()
);
-- Server is the only writer. No public SDK access to push endpoints or audit.
do $$ declare t text; extra text; begin
 foreach t in array array['quizlab_notification_preferences','quizlab_study_items','quizlab_notification_devices',
 'quizlab_notifications','quizlab_notification_deliveries','quizlab_study_badges','quizlab_notification_automations',
 'quizlab_notification_campaigns','quizlab_notification_audit','quizlab_study_requests','quizlab_study_snapshots'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
 end loop;
 foreach t in array array['quizlab_notification_preferences','quizlab_study_items','quizlab_notifications','quizlab_study_badges'] loop
  execute format('grant select on public.%I to authenticated',t);
  extra:=case when t in ('quizlab_study_items','quizlab_study_badges') then ' and public.quizlab_quiz_access_allowed()'
   when t='quizlab_notifications' then ' and (category=''service'' or public.quizlab_quiz_access_allowed())' else '' end;
  execute format('create policy own_read on public.%I for select to authenticated using (user_id=(select auth.uid())%s)',t,extra);
 end loop;
end $$;

-- Additive infrastructure. No student content is changed.
create table quizlab_release_private.suite_settings(
 singleton boolean primary key default true check(singleton), settings jsonb not null,created_at timestamptz not null default now()
);
create table quizlab_release_private.suite_scheduler(
 singleton boolean primary key default true check(singleton),enabled boolean not null default false,
 owner uuid,lease_until timestamptz,cursor integer not null default 0,last_run timestamptz
);
insert into quizlab_release_private.suite_scheduler(singleton)values(true);
create table quizlab_release_private.suite_limits(
 user_id uuid not null,route text not null,minute timestamptz not null,n integer not null,primary key(user_id,route,minute)
);
create table quizlab_release_private.suite_traffic(
 day date not null,route text not null,requests bigint not null default 0,response_bytes bigint not null default 0,
 database_logical_bytes bigint not null default 0,errors bigint not null default 0,last_at timestamptz not null default now(),primary key(day,route)
);
alter table quizlab_release_private.suite_settings enable row level security;
alter table quizlab_release_private.suite_scheduler enable row level security;
alter table quizlab_release_private.suite_limits enable row level security;
alter table quizlab_release_private.suite_traffic enable row level security;
revoke all on quizlab_release_private.suite_settings,quizlab_release_private.suite_scheduler,quizlab_release_private.suite_limits,quizlab_release_private.suite_traffic from public,anon,authenticated;
create index quizlab_notification_scheduler_pending on public.quizlab_notifications(next_check_at,due_at) where state in ('queued','ready') and not delivery_cancelled;
create index quizlab_notification_campaign_pending on public.quizlab_notification_campaigns(scheduled_at) where state='scheduled';
create index quizlab_notification_delivery_retries on public.quizlab_notification_deliveries(retry_at) where status='retry';
create index quizlab_shop_owner_time on public.quizlab_shop_orders(user_id,created_at desc);
-- Existing administrative index remains accessible only through guarded RPCs.
revoke all on public.quizlab_admin_user_index from public,anon,authenticated;

create extension if not exists pg_cron;
create or replace function quizlab_release_private.run_suite_scheduler()
returns bigint language plpgsql security definer set search_path=pg_catalog,public as $$
declare token text;request_id bigint;
begin
 if not exists(select 1 from quizlab_release_private.suite_scheduler where singleton and enabled) then return null; end if;
 select settings->>'schedulerToken' into token from quizlab_release_private.suite_settings where singleton;
 if token is null then return null; end if;
 select net.http_post(
  url:='https://eqrcdvhhfrkpmnzqoerr.supabase.co/functions/v1/quizlab-suite/tick',
  headers:=jsonb_build_object('Content-Type','application/json','X-QuizLab-Scheduler',token),body:='{}'::jsonb,timeout_milliseconds:=120000
 ) into request_id;
 delete from quizlab_release_private.suite_limits where minute<now()-interval '1 day';
 return request_id;
end $$;
revoke all on function quizlab_release_private.run_suite_scheduler() from public,anon,authenticated;
select cron.schedule('quizlab-study-minute','* * * * *','select quizlab_release_private.run_suite_scheduler()');
