// Everything the bot stores, in Supabase's Postgres database.
//
// `db` is a tiny adapter so the same code runs on Supabase (postgres.js) and in
// tests (PGlite, Postgres compiled to run inside Node):
//   db.query(text, params) → rows
//   db.transaction(async (txDb) => …)

// Turns whatever someone typed into a safe full-text query: every word must
// appear, and words match as prefixes ("onboard" finds "onboarding").
export function toTsQuery(input = '') {
  const words = (String(input).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
  return words.map((w) => `${w}:*`).join(' & ');
}

const NUMBERS = ['id', 'created_at', 'done_at', 'meeting_id'];

function clean(row) {
  if (!row) return null;
  for (const k of NUMBERS) if (row[k] != null) row[k] = Number(row[k]);
  delete row.search;
  delete row.raw_hash;
  return row;
}

function meeting(row) {
  if (!row) return null;
  clean(row);
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  return { ...row, segments: parse(row.segments), summary: row.summary ? parse(row.summary) : null };
}

export function createRepo(db) {
  const all = async (text, params = []) => (await db.query(text, params)).map(clean);
  const one = async (text, params = []) => (await all(text, params))[0] ?? null;

  const repo = {
    // ---------- notes ----------
    addNote: (n) => one(
      `insert into notes (guild_id, tag, content, why, author_id, saved_by_id, source_url, owner_id, due, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
      [n.guild_id, n.tag ?? 'general', n.content, n.why ?? null, n.author_id, n.saved_by_id ?? n.author_id,
        n.source_url ?? null, n.owner_id ?? null, n.due ?? null, n.created_at ?? Date.now()],
    ),
    getNote: (guildId, id) => one('select * from notes where guild_id = $1 and id = $2', [guildId, id]),
    findBySource: (guildId, url) => one('select * from notes where guild_id = $1 and source_url = $2 limit 1', [guildId, url]),
    setTag: (id, tag) => db.query('update notes set tag = $1 where id = $2', [tag, id]),
    setForumRef: (id, threadId, messageId) =>
      db.query('update notes set forum_thread_id = $1, forum_message_id = $2 where id = $3', [threadId, messageId, id]),
    markDone: async (id, userId, at = Date.now()) =>
      (await db.query('update notes set done_at = $1, done_by_id = $2 where id = $3 and done_at is null returning id', [at, userId, id])).length > 0,
    deleteNote: async (id) => (await db.query('delete from notes where id = $1 returning id', [id])).length > 0,
    search(guildId, text, limit = 15) {
      const q = toTsQuery(text);
      if (!q) return [];
      return all(
        `select * from notes where guild_id = $1 and search @@ to_tsquery('simple', $2)
         order by ts_rank(search, to_tsquery('simple', $2)) desc, id desc limit $3`,
        [guildId, q, limit],
      );
    },
    recent: (guildId, limit = 15) => all('select * from notes where guild_id = $1 order by created_at desc, id desc limit $2', [guildId, limit]),
    byTag: (guildId, tag, limit = 15) =>
      all('select * from notes where guild_id = $1 and tag = $2 order by created_at desc, id desc limit $3', [guildId, tag, limit]),
    openTodos: (guildId, ownerId = null, limit = 25) => (ownerId
      ? all(`select * from notes where guild_id = $1 and tag = 'todo' and done_at is null and owner_id = $2 order by created_at, id limit $3`, [guildId, ownerId, limit])
      : all(`select * from notes where guild_id = $1 and tag = 'todo' and done_at is null order by created_at, id limit $2`, [guildId, limit])),
    since: (guildId, ts) => all('select * from notes where guild_id = $1 and created_at >= $2 order by created_at, id', [guildId, ts]),
    doneSince: (guildId, ts) => all(`select * from notes where guild_id = $1 and tag = 'todo' and done_at >= $2 order by done_at`, [guildId, ts]),
    recentDecisions: (guildId, limit = 15) =>
      all(`select * from notes where guild_id = $1 and tag = 'decision' order by created_at desc, id desc limit $2`, [guildId, limit]),

    // ---------- settings ----------
    getSetting: async (guildId, key) => (await one('select value from settings where guild_id = $1 and key = $2', [guildId, key]))?.value ?? null,
    setSetting: (guildId, key, value) => db.query(
      `insert into settings (guild_id, key, value) values ($1, $2, $3)
       on conflict (guild_id, key) do update set value = excluded.value`,
      [guildId, key, value],
    ),
    guildsWithSetting: async (key) => (await db.query('select guild_id from settings where key = $1 and value is not null', [key])).map((r) => r.guild_id),

    // ---------- meetings ----------
    addMeeting: async (m) => meeting((await db.query(
      `insert into meetings (guild_id, title, source, raw, segments, created_by_id, created_at)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7) returning *`,
      [m.guild_id, m.title, m.source, m.raw, JSON.stringify(m.segments), m.created_by_id, m.created_at ?? Date.now()],
    ))[0]),
    setMeetingSummary: (id, summary) =>
      db.query('update meetings set summary = $1::jsonb, title = $2 where id = $3', [JSON.stringify(summary), summary.title, id]),
    setMeetingPost: (id, channelId, messageId, threadId = null) =>
      db.query('update meetings set channel_id = $1, message_id = $2, thread_id = $3 where id = $4', [channelId, messageId, threadId, id]),
    getMeeting: async (guildId, id) => meeting((await db.query('select * from meetings where guild_id = $1 and id = $2', [guildId, id]))[0]),
    meetingByThread: async (guildId, threadId) =>
      meeting((await db.query('select * from meetings where guild_id = $1 and thread_id = $2 limit 1', [guildId, threadId]))[0]),
    meetingByMessage: async (guildId, messageId) =>
      meeting((await db.query('select * from meetings where guild_id = $1 and message_id = $2 limit 1', [guildId, messageId]))[0]),
    latestMeeting: async (guildId) => meeting((await db.query(
      'select * from meetings where guild_id = $1 and summary is not null order by created_at desc, id desc limit 1', [guildId],
    ))[0]),
    listMeetings: (guildId, limit = 10) => all(
      `select id, guild_id, title, source, created_by_id, channel_id, message_id, thread_id, created_at
       from meetings where guild_id = $1 and summary is not null order by created_at desc, id desc limit $2`,
      [guildId, limit],
    ),
    // Same transcript again? Matched by fingerprint, so the AI isn't paid twice.
    findMeetingByRaw: async (guildId, raw) => meeting((await db.query(
      'select * from meetings where guild_id = $1 and raw_hash = md5($2) and summary is not null order by id desc limit 1', [guildId, raw],
    ))[0]),
    addQuestion: (meetingId, userId, question, answer, at = Date.now()) => db.query(
      'insert into meeting_questions (meeting_id, asked_by_id, question, answer, created_at) values ($1, $2, $3, $4, $5)',
      [meetingId, userId, question, answer, at],
    ),
    recentQuestions: (meetingId, limit = 3, since = 0) => all(
      `select * from (select * from meeting_questions where meeting_id = $1 and created_at >= $2 order by id desc limit $3) q order by id`,
      [meetingId, since, limit],
    ),

    // Runs `fn` while holding a lock named `key`, with a repo bound to that
    // transaction. Two requests touching the same note wait for each other
    // instead of both posting it.
    withLock: (key, fn) => db.transaction(async (tx) => {
      await tx.query('select pg_advisory_xact_lock($1)', [key]);
      return fn(createRepo(tx));
    }),
  };
  return repo;
}
