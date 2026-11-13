// The whole bot, driven the way Discord drives it: signed web requests in,
// Discord API calls out (to a fake Discord), a real Postgres database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, command, fakeDiscord, makeBot, messageCommand, sign } from './helpers.js';
import { CHANNEL, DiscordError } from '../supabase/functions/_shared/discord-api.js';
import { SAVE_AS_NOTE } from '../supabase/functions/_shared/commands.js';

const FORUM = { id: 'forum', type: CHANNEL.FORUM, name: 'notes', guild_id: 'g' };
const forumPosts = (discord) => [...discord.state.channels.values()].filter((c) => c.parent_id === 'forum');
const notesIn = (discord, threadName) => {
  const thread = forumPosts(discord).find((t) => t.name === threadName);
  return thread ? discord.posts(thread.id).filter((m) => m.embeds) : [];
};

async function botWithForum(opts = {}) {
  const bot = await makeBot({ discord: fakeDiscord({ channels: [FORUM] }), ...opts });
  await bot.repo.setSetting('g', 'notes_forum', 'forum');
  return bot;
}

// ---------- the front door ----------

test('requests without a valid Discord signature are refused', async () => {
  const { app } = await makeBot();
  const body = JSON.stringify(command('note', { text: 'hi' }));
  const unsigned = await app.handle(new Request('https://bot.test/', { method: 'POST', body }));
  assert.equal(unsigned.status, 401);
  const headers = await sign(body);
  const tampered = await app.handle(new Request('https://bot.test/', { method: 'POST', body: body.replace('hi', 'hacked'), headers }));
  assert.equal(tampered.status, 401);
});

test('Discord’s ping gets a pong; GET says it is up', async () => {
  const { app, send } = await makeBot();
  assert.deepEqual((await send({ type: 1 })).response, { type: 1 });
  assert.equal(await (await app.handle(new Request('https://bot.test/'))).text(), 'Mibbit Notes is ready.');
});

test('outside a server, it says it only works in one', async () => {
  const { send } = await makeBot();
  const { data } = await send({ ...command('note', { text: 'x' }), guild_id: undefined });
  assert.match(data.content, /only work inside a server/);
});

test('a failing handler answers with a friendly error', async () => {
  const discord = fakeDiscord();
  const bot = await makeBot({ discord });
  bot.repo.addNote = async () => { throw new Error('database down'); };
  const { data } = await bot.send(command('note', { text: 'x' }));
  assert.match(data.content, /Something went wrong/);
  assert.equal(data.flags, 64);
  assert.equal(bot.errors.length, 1);
});

// ---------- saving notes ----------

test('/note replies privately, then files the note in the right forum post', async () => {
  const { send, discord } = await botWithForum();
  const { response } = await send(command('note', { text: 'Start with a sound #idea' }));
  assert.equal(response.type, 4);
  assert.equal(response.data.flags, 64, 'only the author sees the reply');
  assert.match(response.data.content, /Saved as \*\*💡 Ideas #1\*\*\.$/);
  assert.equal(response.data.components[0].components[0].custom_id, 'retag:1');

  const filed = notesIn(discord, '💡 Ideas');
  assert.equal(filed.length, 1);
  assert.equal(filed[0].embeds[0].title, '💡 Idea #1');
});

test('without a forum, /note says how to set one up', async () => {
  const { send } = await makeBot();
  const { data } = await send(command('note', { text: 'x' }));
  assert.match(data.content, /run `\/setup`/);
});

test('changing the tag moves the note: one copy, in the new post', async () => {
  const { send, discord, repo } = await botWithForum();
  await send(command('note', { text: 'Start with a sound' }));
  const { response } = await send(click('retag:1', { values: ['design'] }));
  assert.equal(response.type, 7, 'the private reply updates in place');
  assert.match(response.data.content, /Moved to \*\*🎨 Design #1\*\*/);
  assert.equal(notesIn(discord, '📝 General').length, 0);
  assert.equal(notesIn(discord, '🎨 Design').length, 1);
  assert.equal((await repo.getNote('g', 1)).tag, 'design');
});

test('two tag changes at the same moment still leave exactly one copy', async () => {
  const { send, discord } = await botWithForum();
  await send(command('note', { text: 'race' }));
  await Promise.all([send(click('retag:1', { values: ['bug'] })), send(click('retag:1', { values: ['design'] }))]);
  const copies = forumPosts(discord).flatMap((t) => discord.posts(t.id).filter((m) => m.embeds));
  assert.equal(copies.length, 1);
});

test('a lost forum setting or archived post never creates a duplicate post', async () => {
  const { send, discord, repo } = await botWithForum();
  await send(command('note', { text: 'one' }));
  const general = forumPosts(discord)[0];

  await repo.setSetting('g', 'thread:general', 'deleted-id'); // setting points nowhere
  await send(command('note', { text: 'two' }));
  assert.equal(forumPosts(discord).length, 1, 'found the existing post by name');

  general.thread_metadata.archived = true; // Discord archives quiet posts
  await repo.setSetting('g', 'thread:general', general.id);
  await send(command('note', { text: 'three' }));
  assert.ok(discord.state.calls.some(([k, id]) => k === 'unarchive' && id === general.id));
  assert.equal(notesIn(discord, '📝 General').length, 3);
});

test('right-click → Save as note keeps the author and a link; saving twice is caught', async () => {
  const { send, repo } = await botWithForum();
  const message = { id: 'm1', channel_id: 'design-chat', content: 'Pads should glow #design', author: { id: 'u7' }, attachments: [{ filename: 'pad.png', url: 'https://cdn/pad.png' }] };
  const first = await send(messageCommand(SAVE_AS_NOTE, message));
  assert.match(first.data.content, /🎨 Design #1/);
  const note = await repo.getNote('g', 1);
  assert.equal(note.author_id, 'u7');
  assert.equal(note.saved_by_id, 'u1');
  assert.equal(note.source_url, 'https://discord.com/channels/g/design-chat/m1');
  assert.match(note.content, /📎 \[pad\.png\]/);
  const again = await send(messageCommand(SAVE_AS_NOTE, message));
  assert.match(again.data.content, /Already saved as/);
});

test('/decide posts publicly and logs the decision', async () => {
  const { send, discord } = await botWithForum();
  const { data } = await send(command('decide', { decision: 'Launch Dec 8', why: 'Pads need a week' }));
  assert.equal(data.flags, undefined, 'everyone sees it');
  assert.match(data.embeds[0].description, /\*\*Why:\*\* Pads need a week/);
  assert.equal(notesIn(discord, '✅ Decisions').length, 1);
});

test('/todo pings the owner; Mark done updates the reply and the forum copy', async () => {
  const { send, discord, repo } = await botWithForum();
  const { data } = await send(command('todo', { task: 'Ship build', owner: 'u2', due: 'Thursday' }, { resolved: { users: { u2: { id: 'u2' } } } }));
  assert.deepEqual(data.allowed_mentions, { users: ['u2'] });
  assert.equal(data.components[0].components[0].custom_id, 'done:1');

  const done = await send(click('done:1', { member: { user: { id: 'u2' }, permissions: '0' } }));
  assert.equal(done.response.type, 7);
  assert.match(done.response.data.embeds[0].description, /Done by <@u2>/);
  assert.deepEqual(done.response.data.components, [], 'button removed');
  assert.ok((await repo.getNote('g', 1)).done_at);
  const forumCopy = notesIn(discord, '📋 Action items')[0];
  assert.match(forumCopy.embeds[0].description, /Done by <@u2>/, 'forum copy updated');
});

test('/todos lists open items and marks one done from the menu', async () => {
  const { send, repo } = await botWithForum();
  await send(command('todo', { task: 'A' }));
  await send(command('todo', { task: 'B' }));
  const list = await send(command('todos'));
  assert.match(list.data.embeds[0].title, /Open action items \(2\)/);
  const picked = await send(click('done-select', { values: ['2'] }));
  assert.match(picked.data.content, /Marked \*\*#2\*\* done/);
  assert.equal((await repo.openTodos('g')).length, 1);
  assert.match((await send(click('done-select', { values: ['2'] }))).data.content, /already done/);
});

test('/notes search, recent, tag and delete', async () => {
  const { send, discord } = await botWithForum();
  await send(command('note', { text: 'Onboarding starts with a sound' }));
  await send(command('note', { text: 'Pad grid stays 4x4 #design' }));
  assert.match((await send(command('notes', { query: 'onboard' }, { sub: 'search' }))).data.embeds[0].description, /#1/);
  assert.match((await send(command('notes', {}, { sub: 'recent' }))).data.embeds[0].description, /#2[\s\S]*#1/);
  assert.match((await send(command('notes', { tag: 'design' }, { sub: 'tag' }))).data.embeds[0].description, /Pad grid/);

  const stranger = await send(command('notes', { id: 1 }, { sub: 'delete', member: { user: { id: 'u9' }, permissions: '0' } }));
  assert.match(stranger.data.content, /Only the person/);
  const moderator = await send(command('notes', { id: 1 }, { sub: 'delete', member: { user: { id: 'u9' }, permissions: String(1 << 13) } }));
  assert.match(moderator.data.content, /Deleted note #1/);
  assert.equal(notesIn(discord, '📝 General').length, 0, 'removed from the forum too');
});

// ---------- setup ----------

test('/setup creates the channels and sets the Monday timer', async () => {
  const scheduled = [];
  const bot = await makeBot({
    env: { CRON_SECRET: 's3cret', SUPABASE_URL: 'https://ref.supabase.co', DIGEST_TZ: 'America/New_York' },
    schedule: async (opts) => scheduled.push(opts),
  });
  const { response } = await bot.send(command('setup'));
  assert.equal(response.type, 5, '“thinking…” first, the channels after');
  assert.equal(response.data.flags, 64);

  const edit = bot.discord.state.webhooks.at(-1);
  assert.match(edit.body.content, /📝 Notes → <#\d+> \(one post per tag\) · \*new\*/);
  assert.match(edit.body.content, /🎙️ Meeting notes → <#\d+>/);
  assert.match(edit.body.content, /Timer set: digest every Monday at 9:00 \(America\/New_York\)/);
  const names = [...bot.discord.state.channels.values()].map((c) => c.name);
  assert.deepEqual(names.sort(), ['Mibbit Notes', 'meeting-notes', 'notes', 'weekly-digest']);
  assert.deepEqual(scheduled, [{ url: 'https://ref.supabase.co/functions/v1/discord-bot/cron', secret: 's3cret', day: 1, hour: 9, timeZone: 'America/New_York' }]);

  await bot.send(command('setup'));
  assert.equal(bot.discord.state.channels.size, 4, 'running it again creates nothing');
});

test('/setup explains a missing permission', async () => {
  const discord = fakeDiscord();
  discord.createChannel = async () => { throw new DiscordError(403, { code: 50013, message: 'Missing Permissions' }); };
  const bot = await makeBot({ discord });
  await bot.send(command('setup'));
  assert.match(discord.state.webhooks.at(-1).body.content, /Manage Channels/);
});

// ---------- the timer ----------

async function timer(bot, secret = 'tick') {
  const res = await bot.app.handle(new Request('https://ref.supabase.co/functions/v1/discord-bot/cron', { method: 'POST', headers: { 'x-cron-secret': secret } }));
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

test('the timer needs its secret', async () => {
  const bot = await makeBot({ env: { CRON_SECRET: 'tick' } });
  assert.equal((await timer(bot, 'wrong')).status, 401);
  assert.equal((await makeBot()).app ? (await timer(await makeBot(), '')).status : 0, 401, 'no secret configured: always refused');
});

test('Monday 9:00 New York: the digest posts once; other times it stays quiet', async () => {
  let clock = new Date('2026-11-16T14:05:00Z'); // Monday 9:05 in New York
  const discord = fakeDiscord({ channels: [{ id: 'digest', type: CHANNEL.TEXT }] });
  const bot = await makeBot({ discord, env: { CRON_SECRET: 'tick', DIGEST_TZ: 'America/New_York' }, now: () => clock });
  await bot.repo.setSetting('g', 'digest_channel', 'digest');
  await bot.repo.addNote({ guild_id: 'g', author_id: 'u', content: 'Fresh idea', tag: 'idea', created_at: clock.getTime() - 3600_000 });

  assert.deepEqual((await timer(bot)).body, { ok: true, slot: '2026-11-16', posted: 1 });
  assert.match(discord.posts('digest')[0].embeds[0].description, /Fresh idea/);
  assert.equal((await timer(bot)).body.posted, 0, 'not twice the same Monday');

  clock = new Date('2026-11-17T14:05:00Z'); // Tuesday: just the daily check-in
  assert.deepEqual((await timer(bot)).body, { ok: true, slot: null, posted: 0 });
  assert.equal(discord.posts('digest').length, 1);
});

test('unknown commands get a polite answer', async () => {
  const { data } = await (await makeBot()).send(command('dance'));
  assert.match(data.content, /don’t know that one/);
});
