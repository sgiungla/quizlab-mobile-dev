create table quizlab_release_private.suite_generation(
 user_id uuid primary key references auth.users(id) on delete cascade,
 signature text not null,evaluated_at timestamptz not null default now()
);
alter table quizlab_release_private.suite_generation enable row level security;
revoke all on quizlab_release_private.suite_generation from public,anon,authenticated;
alter table quizlab_release_private.suite_traffic add column last_response_bytes bigint;
alter table quizlab_release_private.suite_traffic add column last_database_logical_bytes bigint;
