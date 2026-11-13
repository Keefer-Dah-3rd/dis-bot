import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { toTsQuery } from '../supabase/functions/_shared/db.js';
import { tagFromText } from '../supabase/functions/_shared/tags.js';
import { buildDigest, digestSlot, utcTimesFor } from '../supabase/functions/_shared/digest.js';
import { fitLines, snippet } from '../supabase/functions/_shared/format.js';
import { commandDefs } from '../supabase/functions/_shared/commands.js';
import { timerSchedules } from '../supabase/functions/_shared/setup.js';

const G = 'guild1';
const add = (repo, n) => repo.addNote({ guild_id: G, author_id: 'u1', ...n });

test('hashtags pick a tag', () => {
  assert.equal(tagFromText('new onboarding flow #idea'), 'idea');
  assert.equal(tagFromText('#BUGS: crash on save'), 'bug');
  assert.equal(tagFromText('see <#12345> later'), null);
  assert.equal(tagFromText('#ideasx'), null);
  assert.equal(tagFromText(''), null);
});

test('search: prefixes, multi-word, junk input, other servers hidden', async () => {
  const { repo } = await freshDb();
  await add(repo, { content: 'Onboarding should start with a sound' });
  await add(repo, { content: 'Pad colors feel too dark', tag: 'design' });
  await add(repo, { content: 'Use OKLCH tokens', tag: 'decision', why: 'Better onboarding contrast' });
  await repo.addNote({ guild_id: 'other', author_id: 'x', content: 'onboarding elsewhere' });

  assert.equal((await repo.search(G, 'onboard')).length, 2, 'prefix + why field');
  assert.equal((await repo.search(G, 'pad dark')).length, 1);
  assert.equal((await repo.search(G, 'pad sound')).length, 0, 'all words must match');
  assert.deepEqual(await repo.search(G, '"(*)" & | ! :'), [], 'search syntax characters are harmless');
  assert.equal(toTsQuery('Hello, world!'), 'hello:* & world:*');
});

test('search index follows deletes', async () => {
  const { repo } = await freshDb();
  const n = await add(repo, { content: 'temporary thought' });
  assert.equal((await repo.search(G, 'temporary')).length, 1);
  assert.ok(await repo.deleteNote(n.id));
  assert.equal((await repo.search(G, 'temporary')).length, 0);
});

test('action items: open, by owner, done once', async () => {
  const { repo } = await freshDb();
  const a = await add(repo, { tag: 'todo', content: 'Ship pads', owner_id: 'u1' });
  await add(repo, { tag: 'todo', content: 'Write copy', owner_id: 'u2' });
  assert.equal((await repo.openTodos(G)).length, 2);
  assert.equal((await repo.openTodos(G, 'u2')).length, 1);
  assert.equal(await repo.markDone(a.id, 'u1'), true);
  assert.equal(await repo.markDone(a.id, 'u2'), false, 'second click does nothing');
  assert.equal((await repo.getNote(G, a.id)).done_by_id, 'u1');
  assert.equal((await repo.openTodos(G)).length, 1);
});

test('numbers come back as numbers', async () => {
  const { repo } = await freshDb();
  const n = await add(repo, { content: 'x', created_at: 1_763_000_000_000 });
  assert.equal(typeof n.id, 'number');
  assert.equal(n.created_at, 1_763_000_000_000);
  assert.equal('search' in n, false, 'search index column is hidden');
});

test('settings upsert, and which servers have a setting', async () => {
  const { repo } = await freshDb();
  assert.equal(await repo.getSetting(G, 'notes_forum'), null);
  await repo.setSetting(G, 'notes_forum', '1');
  await repo.setSetting(G, 'notes_forum', '2');
  assert.equal(await repo.getSetting(G, 'notes_forum'), '2');
  await repo.setSetting('g2', 'digest_channel', 'd');
  assert.deepEqual(await repo.guildsWithSetting('digest_channel'), ['g2']);
});

test('digest groups the week and lists open items', async () => {
  const { repo } = await freshDb();
  const now = Date.now();
  const old = now - 10 * 24 * 3600 * 1000;
  await add(repo, { content: 'ancient idea', tag: 'idea', created_at: old });
  await add(repo, { content: 'fresh idea', tag: 'idea' });
  await add(repo, { content: 'Go with OKLCH', tag: 'decision', why: 'contrast' });
  await add(repo, { content: 'Ship pads', tag: 'todo', owner_id: 'u9', due: 'Friday' });
  const done = await add(repo, { content: 'Old task', tag: 'todo', owner_id: 'u9', created_at: old });
  await repo.markDone(done.id, 'u9');

  const d = await buildDigest(repo, G, now);
  assert.match(d.description, /Ideas\*\* \(1\)/);
  assert.match(d.description, /fresh idea/);
  assert.doesNotMatch(d.description, /ancient idea/);
  assert.match(d.description, /Go with OKLCH — _contrast_/);
  assert.match(d.description, /Finished\*\* \(1\)[\s\S]*Old task/);
  assert.match(d.description, /Still open\*\* \(1\)[\s\S]*<@u9> Ship pads · due Friday/);
  assert.equal(await buildDigest((await freshDb()).repo, G, now), null);
});

test('digest stays under the embed limit', async () => {
  const { repo } = await freshDb();
  for (let i = 0; i < 120; i++) await add(repo, { tag: 'todo', owner_id: 'u1', content: `task ${i} `.repeat(20) });
  assert.ok((await buildDigest(repo, G)).description.length <= 4096);
});

test('digest slot: Monday 9:00 onward, on the team’s clock', () => {
  assert.equal(digestSlot(new Date(2026, 10, 16, 9, 5)), '2026-11-16'); // Monday, this computer's clock
  assert.equal(digestSlot(new Date(2026, 10, 16, 8, 59)), null);
  assert.equal(digestSlot(new Date(2026, 10, 17, 10, 0)), null); // Tuesday
  assert.equal(digestSlot(new Date('2026-11-16T14:05:00Z'), 1, 9, 'America/New_York'), '2026-11-16', '9:05 in New York');
  assert.equal(digestSlot(new Date('2026-11-16T13:05:00Z'), 1, 9, 'America/New_York'), null, '8:05 in New York');
  assert.equal(digestSlot(new Date('2026-11-16T03:00:00Z'), 1, 9, 'Asia/Tokyo'), '2026-11-16', 'noon in Tokyo');
});

test('the Monday timer covers daylight saving', () => {
  assert.deepEqual(utcTimesFor(1, 9, 'America/New_York', new Date('2026-11-13')), [{ day: 1, hour: 13 }, { day: 1, hour: 14 }]);
  assert.deepEqual(utcTimesFor(1, 9, 'Asia/Tokyo', new Date('2026-11-13')), [{ day: 1, hour: 0 }], 'no daylight saving');
  assert.deepEqual(utcTimesFor(1, 9, 'Australia/Sydney', new Date('2026-11-13')), [{ day: 0, hour: 22 }, { day: 0, hour: 23 }], 'Sunday in UTC');
  assert.deepEqual(timerSchedules({ day: 1, hour: 9, timeZone: 'America/New_York' }).digest, ['0 13,14 * * 1']);
  assert.match(timerSchedules({ timeZone: 'UTC' }).checkIn, /^\d+ \d+ \* \* \*$/, 'one check-in a day');
});

test('formatting helpers', () => {
  assert.equal(snippet('a\n\n b   c', 50), 'a b c');
  assert.equal(snippet('abcdefghij', 5), 'abcd…');
  assert.match(fitLines(Array(500).fill('x'.repeat(50))), /…and \d+ more$/);
});

test('command definitions follow Discord’s rules', () => {
  assert.deepEqual(commandDefs.map((c) => c.name), ['note', 'Save as note', 'decide', 'todo', 'todos', 'notes', 'digest', 'meeting', 'setup']);
  const check = (opts = [], where) => {
    let seenOptional = false;
    for (const o of opts) {
      assert.match(o.name, /^[a-z0-9_-]{1,32}$/, `${where}.${o.name} name`);
      assert.ok(o.description.length >= 1 && o.description.length <= 100, `${where}.${o.name} description length`);
      if (o.type === 1) check(o.options, `${where} ${o.name}`);
      else if (o.required) assert.ok(!seenOptional, `${where}.${o.name}: required options come first`);
      else seenOptional = true;
    }
  };
  for (const c of commandDefs) {
    if (c.type === 1) {
      assert.match(c.name, /^[a-z0-9_-]{1,32}$/);
      assert.ok(c.description.length <= 100);
      check(c.options, c.name);
    }
    assert.deepEqual(c.contexts, [0], `${c.name} is server-only`);
  }
  assert.equal(commandDefs.find((c) => c.name === 'setup').default_member_permissions, '32', 'setup needs Manage Server');
});
