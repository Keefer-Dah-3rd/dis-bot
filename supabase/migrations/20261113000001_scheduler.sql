-- The timer that wakes the bot for the Monday digest and a daily check-in.
-- The schedules themselves are created by /setup (they include the bot's
-- address and a secret, which don't belong in this public repo).
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
grant usage on schema cron to postgres;
