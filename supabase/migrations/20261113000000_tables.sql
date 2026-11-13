-- Mibbit Notes: everything the bot stores.
-- Times are milliseconds since 1970 (bigint), the same as JavaScript's Date.now().

create table if not exists notes (
  id integer generated always as identity primary key,
  guild_id text not null,
  tag text not null default 'general',
  content text not null,
  why text,
  author_id text not null,
  saved_by_id text not null,
  source_url text,
  owner_id text,
  due text,
  done_at bigint,
  done_by_id text,
  forum_thread_id text,
  forum_message_id text,
  created_at bigint not null,
  -- Full-text search over the note and its reason ("onboard" finds "onboarding").
  search tsvector generated always as (to_tsvector('simple', content || ' ' || coalesce(why, ''))) stored
);
create index if not exists notes_search on notes using gin (search);
create index if not exists notes_guild_created on notes (guild_id, created_at);
create index if not exists notes_source on notes (guild_id, source_url);

create table if not exists settings (
  guild_id text not null,
  key text not null,
  value text,
  primary key (guild_id, key)
);

-- A meeting keeps its full notes (raw text + numbered segments), not just the
-- summary, so questions are answered from the source.
create table if not exists meetings (
  id integer generated always as identity primary key,
  guild_id text not null,
  title text not null,
  source text not null,
  raw text not null,
  raw_hash text generated always as (md5(raw)) stored,
  segments jsonb not null,
  summary jsonb,
  created_by_id text not null,
  channel_id text,
  message_id text,
  thread_id text,
  created_at bigint not null
);
create index if not exists meetings_guild on meetings (guild_id, created_at);
create index if not exists meetings_thread on meetings (guild_id, thread_id);
create index if not exists meetings_message on meetings (guild_id, message_id);
create index if not exists meetings_raw on meetings (guild_id, raw_hash);

create table if not exists meeting_questions (
  id integer generated always as identity primary key,
  meeting_id integer not null references meetings (id) on delete cascade,
  asked_by_id text not null,
  question text not null,
  answer text not null,
  created_at bigint not null
);
create index if not exists meeting_questions_meeting on meeting_questions (meeting_id, created_at);

-- Supabase can expose tables through its public API. With row-level security on
-- and no policies, that API sees nothing; only the bot's own connection can read.
alter table notes enable row level security;
alter table settings enable row level security;
alter table meetings enable row level security;
alter table meeting_questions enable row level security;
