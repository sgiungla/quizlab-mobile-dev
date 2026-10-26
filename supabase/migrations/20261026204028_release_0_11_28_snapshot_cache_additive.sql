-- Additive replacement for the rejected cache-moving migration.
-- Every existing public snapshot is retained byte-for-byte; no UPDATE/DELETE.
create table quizlab_release_private.suite_study_cache(
 user_id uuid primary key references auth.users(id) on delete cascade,signature text not null,
 data jsonb not null check(jsonb_typeof(data)='object'),consolidated_at timestamptz not null default now()
);
create table quizlab_release_private.suite_bank_revisions(
 user_id uuid primary key references auth.users(id) on delete cascade,signature text not null,
 data jsonb not null check(jsonb_typeof(data)='array'),consolidated_at timestamptz not null default now()
);
alter table quizlab_release_private.suite_study_cache enable row level security;
alter table quizlab_release_private.suite_bank_revisions enable row level security;
revoke all on quizlab_release_private.suite_study_cache,quizlab_release_private.suite_bank_revisions from public,anon,authenticated;
insert into quizlab_release_private.suite_study_cache(user_id,signature,data,consolidated_at)
 select user_id,signature,data,consolidated_at from public.quizlab_study_snapshots where jsonb_typeof(data)='object';
insert into quizlab_release_private.suite_bank_revisions(user_id,signature,data,consolidated_at)
 select user_id,signature,data,consolidated_at from public.quizlab_study_snapshots where jsonb_typeof(data)='array';
