-- Post-deployment advisor review: pin resolution of the new helper routines.
alter function public.quizlab_module_features(jsonb) set search_path=pg_catalog,public;
alter function public.quizlab_all_modules() set search_path=pg_catalog,public;
alter function public.quizlab_add_utc_months(timestamptz,integer) set search_path=pg_catalog,public;
alter function public.quizlab_history_immutable() set search_path=pg_catalog,public;
alter function public.quizlab_contract_snapshot_immutable() set search_path=pg_catalog,public;
alter function public.quizlab_validate_modules(jsonb,boolean) set search_path=pg_catalog,public;
create index if not exists quizlab_retired_actor_idx on public.quizlab_retired_courses(retired_by);
create index if not exists quizlab_egress_actor_idx on quizlab_release_private.egress_monitor(updated_by);
-- This Supabase event-trigger helper is used by its owner, never by browser roles.
do $$ begin
 if to_regprocedure('public.rls_auto_enable()') is not null then
  execute 'revoke all on function public.rls_auto_enable() from public,anon,authenticated';
 end if;
end; $$;
notify pgrst,'reload schema';
