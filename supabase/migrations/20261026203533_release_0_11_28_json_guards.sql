-- Fail closed if any future driver accidentally serializes JSON twice.
alter table quizlab_release_private.suite_settings add constraint suite_settings_object check(jsonb_typeof(settings)='object');
alter table public.quizlab_notification_preferences add constraint notification_settings_object check(jsonb_typeof(settings)='object');
alter table public.quizlab_study_items add constraint study_item_data_object check(jsonb_typeof(data)='object');
alter table public.quizlab_study_snapshots add constraint study_snapshot_data_object check(jsonb_typeof(data)='object');
alter table public.quizlab_notification_campaigns add constraint notification_campaign_data_object check(jsonb_typeof(data)='object');
alter table public.quizlab_notifications add constraint notification_context_object check(jsonb_typeof(context)='object');
alter table public.quizlab_shop_orders add constraint shop_order_snapshot_object check(jsonb_typeof(snapshot)='object');
