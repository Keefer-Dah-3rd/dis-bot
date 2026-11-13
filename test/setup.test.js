import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { openDb } from '../src/db.js';
import { CATEGORY_NAME, ensureChannels } from '../src/setup.js';
import { createMeetingHandlers } from '../src/meeting-handlers.js';

// A server with whatever channels you give it; create() adds more.
function fakeGuild(existing = []) {
  const channels = new Map(existing.map((c) => [c.id, c]));
  let next = 1000;
  return {
    id: 'g',
    channels: {
      all: channels,
      async fetch() { return new Map(channels); },
      async create(opts) {
        const c = { id: String(next++), ...opts, parentId: opts.parent ?? null };
        channels.set(c.id, c);
        return c;
      },
    },
  };
}

test('/setup on an empty server creates the category and all three channels', async () => {
  const repo = openDb();
  const guild = fakeGuild();
  const r = await ensureChannels(guild, repo);
  const made = [...guild.channels.all.values()];
  const category = made.find((c) => c.type === ChannelType.GuildCategory);
  assert.equal(category.name, CATEGORY_NAME);
  const byName = Object.fromEntries(made.map((c) => [c.name, c]));
  assert.equal(byName.notes.type, ChannelType.GuildForum);
  assert.equal(byName['meeting-notes'].type, ChannelType.GuildText);
  assert.match(byName['meeting-notes'].topic, /Meeting summaries/);
  assert.equal(byName['weekly-digest'].type, ChannelType.GuildText);
  for (const c of [byName.notes, byName['meeting-notes'], byName['weekly-digest']]) assert.equal(c.parentId, category.id);
  assert.equal(repo.getSetting('g', 'meetings_channel'), byName['meeting-notes'].id);
  assert.equal(r.created.length, 3);
});

test('running /setup again creates nothing new', async () => {
  const repo = openDb();
  const guild = fakeGuild();
  await ensureChannels(guild, repo);
  const before = guild.channels.all.size;
  const r = await ensureChannels(guild, repo);
  assert.equal(guild.channels.all.size, before);
  assert.deepEqual(r.created, []);
});

test('existing channels are reused by name, and picked channels win', async () => {
  const repo = openDb();
  const guild = fakeGuild([
    { id: 'old-notes', name: 'notes', type: ChannelType.GuildForum },
    { id: 'team-chat', name: 'team-chat', type: ChannelType.GuildText },
  ]);
  const r = await ensureChannels(guild, repo, { digest_channel: { id: 'team-chat' } });
  assert.equal(r.notes_forum, 'old-notes');
  assert.equal(r.digest_channel, 'team-chat');
  assert.deepEqual(r.created, [r.meetings_channel], 'only #meeting-notes was missing');
  assert.equal(repo.getSetting('g', 'digest_channel'), 'team-chat');
});

test('a deleted channel gets recreated', async () => {
  const repo = openDb();
  const guild = fakeGuild();
  const first = await ensureChannels(guild, repo);
  guild.channels.all.delete(first.meetings_channel);
  const second = await ensureChannels(guild, repo);
  assert.notEqual(second.meetings_channel, first.meetings_channel);
  assert.deepEqual(second.created, [second.meetings_channel]);
});

// ---------- where summaries land ----------

const VTT = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\n<v Ana>Launch moves to Dec 8.</v>\n';
const SUMMARY = {
  title: 'Launch', overview: 'Moved launch.',
  important: { key_points: [], decisions: [{ text: 'Launch moves to Dec 8.', why: '', refs: [1] }], action_items: [] },
  changes: [], open_questions: [],
};

function fakePostTarget(id) {
  const sent = [];
  return {
    id, sent,
    isTextBased: () => true,
    async send(payload) {
      const msg = { id: `m-${id}`, channelId: id, url: `https://discord.com/channels/g/${id}/m-${id}`, payload, async startThread() { return { id: `t-${id}`, async send() {} }; } };
      sent.push(msg);
      return msg;
    },
  };
}

function fakeInteraction({ channelId, edits }) {
  return {
    guildId: 'g',
    channelId,
    channel: { name: 'general' },
    user: { id: 'u1' },
    options: {
      getSubcommand: () => 'summarize',
      getAttachment: () => ({ name: 'call.vtt', url: 'https://cdn/call.vtt', size: 100, contentType: 'text/vtt' }),
      getInteger: () => null,
      getString: () => null,
    },
    async deferReply() {},
    async editReply(payload) {
      edits.push(payload);
      return { id: 'reply', channelId, url: `https://discord.com/channels/g/${channelId}/reply`, async startThread() { return { id: 't-reply', async send() {} }; } };
    },
  };
}

function handlersWith(repo, homeChannel) {
  const ai = { async json() { return { data: structuredClone(SUMMARY) }; } };
  const client = { user: { id: '42' }, channels: { async fetch(id) { if (id === homeChannel?.id) return homeChannel; throw new Error('unknown'); } } };
  return createMeetingHandlers({ client, repo, ai, fetchText: async () => VTT });
}

test('summaries post in #meeting-notes, with a link left where the command ran', async () => {
  const repo = openDb();
  const home = fakePostTarget('meeting-notes-id');
  repo.setSetting('g', 'meetings_channel', home.id);
  const edits = [];
  await handlersWith(repo, home).command(fakeInteraction({ channelId: 'general-id', edits }));

  assert.equal(home.sent.length, 1, 'summary posted in #meeting-notes');
  assert.equal(home.sent[0].payload.embeds[1].data.title, '⭐ Important');
  assert.equal(home.sent[0].payload.files.length, 1, 'full notes attached');
  assert.match(edits.at(-1).content, /Meeting notes for \*\*Launch\*\* are in <#meeting-notes-id>/);

  const m = repo.latestMeeting('g');
  assert.equal(m.channel_id, 'meeting-notes-id');
  assert.equal(m.thread_id, 't-meeting-notes-id', 'Q&A thread lives under the summary in #meeting-notes');
  assert.equal(repo.recentDecisions('g')[0].source_url, home.sent[0].url, 'decision log links to the summary');
});

test('without a meeting-notes channel the summary is posted where the command ran', async () => {
  const repo = openDb();
  const edits = [];
  await handlersWith(repo, null).command(fakeInteraction({ channelId: 'general-id', edits }));
  assert.equal(edits.at(-1).embeds[1].data.title, '⭐ Important');
  assert.equal(repo.latestMeeting('g').thread_id, 't-reply');
});
