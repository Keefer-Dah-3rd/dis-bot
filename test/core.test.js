import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, toFtsQuery } from '../src/db.js';
import { tagFromText } from '../src/tags.js';
import { buildDigest, digestSlot } from '../src/digest.js';
import { fitLines, snippet } from '../src/format.js';
import { commandDefs } from '../src/commands.js';

const G = 'guild1';
const add = (repo, n) => repo.addNote({ guild_id: G, author_id: 'u1', ...n });

test('hashtags pick a tag', () => {
  assert.equal(tagFromText('new onboarding flow #idea'), 'idea');
  assert.equal(tagFromText('#BUGS: crash on save'), 'bug');
  assert.equal(tagFromText('see <#12345> later'), null);
  assert.equal(tagFromText('#ideasx'), null);
  assert.equal(tagFromText(''), null);
});

test('search: prefixes, multi-word, junk input, other servers hidden', () => {
  const repo = openDb();
  add(repo, { content: 'Onboarding should start with a sound' });
  add(repo, { content: 'Pad colors feel too dark', tag: 'design' });
  add(repo, { content: 'Use OKLCH tokens', tag: 'decision', why: 'Better onboarding contrast' });
  repo.addNote({ guild_id: 'other', author_id: 'x', content: 'onboarding elsewhere' });

  assert.equal(repo.search(G, 'onboard').length, 2, 'prefix + why field');
  assert.equal(repo.search(G, 'pad dark').length, 1);
  assert.equal(repo.search(G, 'pad sound').length, 0, 'all words must match');
  assert.deepEqual(repo.search(G, '"(*)" AND OR'), repo.search(G, 'and or'), 'no FTS syntax errors');
  assert.equal(repo.search(G, '!!!').length, 0);
  assert.equal(toFtsQuery('Hello, world!'), '"hello"* "world"*');
});

test('search index follows edits and deletes', () => {
  const repo = openDb();
  const n = add(repo, { content: 'temporary thought' });
  assert.equal(repo.search(G, 'temporary').length, 1);
  assert.ok(repo.deleteNote(n.id));
  assert.equal(repo.search(G, 'temporary').length, 0);
});

test('action items: open, by owner, done once', () => {
  const repo = openDb();
  const a = add(repo, { tag: 'todo', content: 'Ship pads', owner_id: 'u1' });
  add(repo, { tag: 'todo', content: 'Write copy', owner_id: 'u2' });
  assert.equal(repo.openTodos(G).length, 2);
  assert.equal(repo.openTodos(G, 'u2').length, 1);
  assert.equal(repo.markDone(a.id, 'u1'), true);
  assert.equal(repo.markDone(a.id, 'u2'), false, 'second click does nothing');
  assert.equal(repo.getNote(G, a.id).done_by_id, 'u1');
  assert.equal(repo.openTodos(G).length, 1);
});

test('duplicate saves are detected by source message', () => {
  const repo = openDb();
  add(repo, { content: 'x', source_url: 'https://discord.com/channels/g/c/m' });
  assert.ok(repo.findBySource(G, 'https://discord.com/channels/g/c/m'));
  assert.equal(repo.findBySource('other', 'https://discord.com/channels/g/c/m'), null);
});

test('settings upsert', () => {
  const repo = openDb();
  assert.equal(repo.getSetting(G, 'notes_forum'), null);
  repo.setSetting(G, 'notes_forum', '1');
  repo.setSetting(G, 'notes_forum', '2');
  assert.equal(repo.getSetting(G, 'notes_forum'), '2');
});

test('digest groups the week and lists open items', () => {
  const repo = openDb();
  const now = Date.now();
  const old = now - 10 * 24 * 3600 * 1000;
  add(repo, { content: 'ancient idea', tag: 'idea', created_at: old });
  add(repo, { content: 'fresh idea', tag: 'idea' });
  add(repo, { content: 'Go with OKLCH', tag: 'decision', why: 'contrast' });
  const t = add(repo, { content: 'Ship pads', tag: 'todo', owner_id: 'u9', due: 'Friday' });
  const done = add(repo, { content: 'Old task', tag: 'todo', owner_id: 'u9', created_at: old });
  repo.markDone(done.id, 'u9');

  const d = buildDigest(repo, G, now);
  assert.match(d.description, /Ideas\*\* \(1\)/);
  assert.match(d.description, /fresh idea/);
  assert.doesNotMatch(d.description, /ancient idea/);
  assert.match(d.description, /Go with OKLCH — _contrast_/);
  assert.match(d.description, /Finished\*\* \(1\)[\s\S]*Old task/);
  assert.match(d.description, /Still open\*\* \(1\)[\s\S]*<@u9> Ship pads · due Friday/);
  assert.ok(t);
  assert.equal(buildDigest(openDb(), G, now), null);
});

test('digest stays under the embed limit', () => {
  const repo = openDb();
  for (let i = 0; i < 300; i++) add(repo, { tag: 'todo', owner_id: 'u1', content: `task ${i} `.repeat(20) });
  assert.ok(buildDigest(repo, G).description.length <= 4096);
});

test('digest slot: Monday 9:00 onward only', () => {
  assert.equal(digestSlot(new Date(2026, 10, 16, 9, 5)), '2026-11-16'); // Monday
  assert.equal(digestSlot(new Date(2026, 10, 16, 8, 59)), null);
  assert.equal(digestSlot(new Date(2026, 10, 17, 10, 0)), null); // Tuesday
});

test('formatting helpers', () => {
  assert.equal(snippet('a\n\n b   c', 50), 'a b c');
  assert.equal(snippet('abcdefghij', 5), 'abcd…');
  assert.match(fitLines(Array(500).fill('x'.repeat(50))), /…and \d+ more$/);
});

test('command definitions are valid for Discord', () => {
  const names = commandDefs.map((c) => c.name);
  assert.deepEqual(names, ['note', 'Save as note', 'decide', 'todo', 'todos', 'notes', 'digest', 'meeting', 'setup']);
});
