import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { openDb } from '../src/db.js';
import { fileNote, queueFile, queueRefresh, noteComponents, unfile } from '../src/filing.js';

// A tiny stand-in for Discord: a forum whose posts hold messages.
function fakeDiscord() {
  const channels = new Map();
  let nextId = 100;
  const forum = {
    id: 'forum', type: ChannelType.GuildForum,
    threads: {
      async create({ name }) {
        const messages = new Map();
        const thread = {
          id: String(nextId++), name, parentId: 'forum', archived: false,
          isThread: () => true,
          async setArchived(v) { this.archived = v; },
          messages: { async fetch(id) { const m = messages.get(id); if (!m) throw new Error('gone'); return m; } },
          async send(payload) {
            const msg = { id: String(nextId++), payload,
              async delete() { messages.delete(this.id); },
              async edit(p) { this.payload = p; } };
            messages.set(msg.id, msg);
            return msg;
          },
          all: messages,
        };
        channels.set(thread.id, thread);
        return thread;
      },
    },
  };
  channels.set('forum', forum);
  const client = { channels: { async fetch(id) { const c = channels.get(id); if (!c) throw new Error('unknown'); return c; } } };
  const threads = () => [...channels.values()].filter((c) => c.isThread);
  return { client, threads };
}

const G = 'g';

test('nothing happens until a forum is set up', async () => {
  const repo = openDb();
  const { client } = fakeDiscord();
  const n = repo.addNote({ guild_id: G, author_id: 'u', content: 'hi' });
  assert.equal(await fileNote(client, repo, n), false);
});

test('notes go into one post per tag, and move when retagged', async () => {
  const repo = openDb();
  const { client, threads } = fakeDiscord();
  repo.setSetting(G, 'notes_forum', 'forum');

  const a = repo.addNote({ guild_id: G, author_id: 'u', content: 'idea one', tag: 'idea' });
  const b = repo.addNote({ guild_id: G, author_id: 'u', content: 'idea two', tag: 'idea' });
  await queueFile(client, repo, G, a.id);
  await queueFile(client, repo, G, b.id);
  assert.equal(threads().length, 1, 'both ideas share the Ideas post');
  assert.equal(threads()[0].name, '💡 Ideas');
  assert.equal(threads()[0].all.size, 2);

  // Retag twice in a row without waiting: must end with exactly one copy, in Design.
  repo.setTag(a.id, 'bug');
  const p1 = queueFile(client, repo, G, a.id);
  repo.setTag(a.id, 'design');
  const p2 = queueFile(client, repo, G, a.id);
  await Promise.all([p1, p2]);
  const counts = Object.fromEntries(threads().map((t) => [t.name, t.all.size]));
  assert.deepEqual(counts, { '💡 Ideas': 1, '🎨 Design': 1 }, 'skips the in-between tag, no duplicates');

  // Archived posts get reopened instead of duplicated.
  threads()[0].archived = true;
  const c = repo.addNote({ guild_id: G, author_id: 'u', content: 'idea three', tag: 'idea' });
  await queueFile(client, repo, G, c.id);
  assert.equal(threads().length, 2);
  assert.equal(threads()[0].all.size, 2);

  await unfile(client, repo.getNote(G, c.id));
  assert.equal(threads()[0].all.size, 1);
});

test('done action items update their forum copy and lose the button', async () => {
  const repo = openDb();
  const { client, threads } = fakeDiscord();
  repo.setSetting(G, 'notes_forum', 'forum');
  const t = repo.addNote({ guild_id: G, author_id: 'u', content: 'ship it', tag: 'todo', owner_id: 'u' });
  await queueFile(client, repo, G, t.id);
  const msg = [...threads()[0].all.values()][0];
  assert.equal(msg.payload.components.length, 1);
  repo.markDone(t.id, 'u');
  await queueRefresh(client, repo, G, t.id);
  assert.equal(msg.payload.components.length, 0);
  assert.match(msg.payload.embeds[0].data.description, /Done by <@u>/);
  assert.deepEqual(noteComponents(repo.getNote(G, t.id)), []);
});
