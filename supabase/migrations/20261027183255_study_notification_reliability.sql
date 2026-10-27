-- Additive notification metadata; banks, answers, accounts and consents are untouched.
-- Filename supplied by `supabase migration new study_notification_reliability`.
-- The Windows CLI could not open its generated path; the same file was saved locally.
alter table public.quizlab_notification_devices
 add column if not exists client_info jsonb not null default '{}'::jsonb,
 add column if not exists pending_local boolean;
alter table public.quizlab_notifications
 add column if not exists push_state text,
 add column if not exists push_checked_at timestamptz;
create index if not exists quizlab_notifications_push_overview
 on public.quizlab_notifications(created_at desc)
 where state in ('queued','ready') and read_at is null and archived_at is null;

comment on column public.quizlab_notification_devices.pending_local is
 'Latest explicit activity report: true means local work awaiting sync, false means clean, null means unknown legacy report. Not an authorization claim.';
comment on column public.quizlab_notifications.push_state is
 'Reason for waiting or suppressing a push. Provider acceptance and device display remain in notification_deliveries.';
