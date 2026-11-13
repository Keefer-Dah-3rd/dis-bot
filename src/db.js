import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT 'general',
  content TEXT NOT NULL,
  why TEXT,
  author_id TEXT NOT NULL,
  saved_by_id TEXT NOT NULL,
  source_url TEXT,
  owner_id TEXT,
  due TEXT,
  done_at INTEGER,
  done_by_id TEXT,
  forum_thread_id TEXT,
  forum_message_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_guild_created ON notes(guild_id, created_at);
CREATE INDEX IF NOT EXISTS notes_source ON notes(guild_id, source_url);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts
  USING fts5(content, why, content='notes', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, content, why) VALUES (new.id, new.content, coalesce(new.why, ''));
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content, why)
    VALUES ('delete', old.id, old.content, coalesce(old.why, ''));
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF content, why ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content, why)
    VALUES ('delete', old.id, old.content, coalesce(old.why, ''));
  INSERT INTO notes_fts(rowid, content, why) VALUES (new.id, new.content, coalesce(new.why, ''));
END;

CREATE TABLE IF NOT EXISTS settings (
  guild_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (guild_id, key)
);

-- A meeting keeps its full notes (raw text + numbered segments), not just the
-- summary, so questions can be answered from the source.
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  raw TEXT NOT NULL,
  segments TEXT NOT NULL,
  summary TEXT,
  created_by_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  thread_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS meetings_guild ON meetings(guild_id, created_at);
CREATE INDEX IF NOT EXISTS meetings_thread ON meetings(guild_id, thread_id);
CREATE INDEX IF NOT EXISTS meetings_message ON meetings(guild_id, message_id);

CREATE TABLE IF NOT EXISTS meeting_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  asked_by_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

function hydrateMeeting(row) {
  if (!row) return null;
  return { ...row, segments: JSON.parse(row.segments), summary: row.summary ? JSON.parse(row.summary) : null };
}

// Turns whatever someone typed into a safe full-text query: every word must
// appear, and words match as prefixes ("onboard" finds "onboarding").
export function toFtsQuery(input = '') {
  const words = (String(input).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
  return words.map((w) => `"${w}"*`).join(' ');
}

export function openDb(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const s = {
    insert: db.prepare(`
      INSERT INTO notes (guild_id, tag, content, why, author_id, saved_by_id, source_url, owner_id, due, created_at)
      VALUES (@guild_id, @tag, @content, @why, @author_id, @saved_by_id, @source_url, @owner_id, @due, @created_at)`),
    get: db.prepare('SELECT * FROM notes WHERE guild_id = ? AND id = ?'),
    bySource: db.prepare('SELECT * FROM notes WHERE guild_id = ? AND source_url = ? LIMIT 1'),
    setTag: db.prepare('UPDATE notes SET tag = ? WHERE id = ?'),
    setForumRef: db.prepare('UPDATE notes SET forum_thread_id = ?, forum_message_id = ? WHERE id = ?'),
    markDone: db.prepare('UPDATE notes SET done_at = ?, done_by_id = ? WHERE id = ? AND done_at IS NULL'),
    del: db.prepare('DELETE FROM notes WHERE id = ?'),
    search: db.prepare(`
      SELECT n.* FROM notes_fts f JOIN notes n ON n.id = f.rowid
      WHERE notes_fts MATCH ? AND n.guild_id = ?
      ORDER BY f.rank LIMIT ?`),
    recent: db.prepare('SELECT * FROM notes WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'),
    byTag: db.prepare('SELECT * FROM notes WHERE guild_id = ? AND tag = ? ORDER BY created_at DESC, id DESC LIMIT ?'),
    openTodos: db.prepare(`
      SELECT * FROM notes WHERE guild_id = ? AND tag = 'todo' AND done_at IS NULL
      ORDER BY created_at ASC, id ASC LIMIT ?`),
    openTodosFor: db.prepare(`
      SELECT * FROM notes WHERE guild_id = ? AND tag = 'todo' AND done_at IS NULL AND owner_id = ?
      ORDER BY created_at ASC, id ASC LIMIT ?`),
    since: db.prepare('SELECT * FROM notes WHERE guild_id = ? AND created_at >= ? ORDER BY created_at ASC, id ASC'),
    doneSince: db.prepare(`
      SELECT * FROM notes WHERE guild_id = ? AND tag = 'todo' AND done_at >= ? ORDER BY done_at ASC`),
    getSetting: db.prepare('SELECT value FROM settings WHERE guild_id = ? AND key = ?'),
    setSetting: db.prepare(`
      INSERT INTO settings (guild_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value`),
    recentDecisions: db.prepare(`
      SELECT * FROM notes WHERE guild_id = ? AND tag = 'decision' ORDER BY created_at DESC, id DESC LIMIT ?`),
    addMeeting: db.prepare(`
      INSERT INTO meetings (guild_id, title, source, raw, segments, created_by_id, created_at)
      VALUES (@guild_id, @title, @source, @raw, @segments, @created_by_id, @created_at)`),
    setMeetingSummary: db.prepare('UPDATE meetings SET summary = ?, title = ? WHERE id = ?'),
    setMeetingPost: db.prepare('UPDATE meetings SET channel_id = ?, message_id = ?, thread_id = ? WHERE id = ?'),
    getMeeting: db.prepare('SELECT * FROM meetings WHERE guild_id = ? AND id = ?'),
    meetingByThread: db.prepare('SELECT * FROM meetings WHERE guild_id = ? AND thread_id = ? LIMIT 1'),
    meetingByMessage: db.prepare('SELECT * FROM meetings WHERE guild_id = ? AND message_id = ? LIMIT 1'),
    latestMeeting: db.prepare(`
      SELECT * FROM meetings WHERE guild_id = ? AND summary IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1`),
    listMeetings: db.prepare(`
      SELECT id, guild_id, title, source, created_by_id, channel_id, message_id, thread_id, created_at
      FROM meetings WHERE guild_id = ? AND summary IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT ?`),
    addQuestion: db.prepare(`
      INSERT INTO meeting_questions (meeting_id, asked_by_id, question, answer, created_at) VALUES (?, ?, ?, ?, ?)`),
    recentQuestions: db.prepare(`
      SELECT * FROM (SELECT * FROM meeting_questions WHERE meeting_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`),
  };

  const repo = {
    addNote(n) {
      const info = s.insert.run({
        guild_id: n.guild_id,
        tag: n.tag ?? 'general',
        content: n.content,
        why: n.why ?? null,
        author_id: n.author_id,
        saved_by_id: n.saved_by_id ?? n.author_id,
        source_url: n.source_url ?? null,
        owner_id: n.owner_id ?? null,
        due: n.due ?? null,
        created_at: n.created_at ?? Date.now(),
      });
      return repo.getNote(n.guild_id, Number(info.lastInsertRowid));
    },
    getNote: (guildId, id) => s.get.get(guildId, id) ?? null,
    findBySource: (guildId, url) => s.bySource.get(guildId, url) ?? null,
    setTag: (id, tag) => s.setTag.run(tag, id),
    setForumRef: (id, threadId, messageId) => s.setForumRef.run(threadId, messageId, id),
    markDone: (id, userId, at = Date.now()) => s.markDone.run(at, userId, id).changes > 0,
    deleteNote: (id) => s.del.run(id).changes > 0,
    search(guildId, text, limit = 15) {
      const q = toFtsQuery(text);
      return q ? s.search.all(q, guildId, limit) : [];
    },
    recent: (guildId, limit = 15) => s.recent.all(guildId, limit),
    byTag: (guildId, tag, limit = 15) => s.byTag.all(guildId, tag, limit),
    openTodos: (guildId, ownerId = null, limit = 25) =>
      ownerId ? s.openTodosFor.all(guildId, ownerId, limit) : s.openTodos.all(guildId, limit),
    since: (guildId, ts) => s.since.all(guildId, ts),
    doneSince: (guildId, ts) => s.doneSince.all(guildId, ts),
    getSetting: (guildId, key) => s.getSetting.get(guildId, key)?.value ?? null,
    setSetting: (guildId, key, value) => s.setSetting.run(guildId, key, value),

    recentDecisions: (guildId, limit = 40) => s.recentDecisions.all(guildId, limit),
    addMeeting(m) {
      const info = s.addMeeting.run({
        guild_id: m.guild_id,
        title: m.title,
        source: m.source,
        raw: m.raw,
        segments: JSON.stringify(m.segments),
        created_by_id: m.created_by_id,
        created_at: m.created_at ?? Date.now(),
      });
      return repo.getMeeting(m.guild_id, Number(info.lastInsertRowid));
    },
    setMeetingSummary: (id, summary) => s.setMeetingSummary.run(JSON.stringify(summary), summary.title, id),
    setMeetingPost: (id, channelId, messageId, threadId = null) => s.setMeetingPost.run(channelId, messageId, threadId, id),
    getMeeting: (guildId, id) => hydrateMeeting(s.getMeeting.get(guildId, id)),
    meetingByThread: (guildId, threadId) => hydrateMeeting(s.meetingByThread.get(guildId, threadId)),
    meetingByMessage: (guildId, messageId) => hydrateMeeting(s.meetingByMessage.get(guildId, messageId)),
    latestMeeting: (guildId) => hydrateMeeting(s.latestMeeting.get(guildId)),
    listMeetings: (guildId, limit = 10) => s.listMeetings.all(guildId, limit),
    addQuestion: (meetingId, userId, question, answer, at = Date.now()) =>
      s.addQuestion.run(meetingId, userId, question, answer, at),
    recentQuestions: (meetingId, limit = 4) => s.recentQuestions.all(meetingId, limit),

    close: () => db.close(),
  };
  return repo;
}
