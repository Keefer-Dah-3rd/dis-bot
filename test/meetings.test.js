import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, command, fakeAi, fakeDiscord, freshDb, makeBot, submitForm } from './helpers.js';
import { CHANNEL } from '../supabase/functions/_shared/discord-api.js';
import { parseTranscript, fromMessages, renderForModel, renderSegments, shortTime, stripFiller } from '../supabase/functions/_shared/transcript.js';
import {
  ANSWER_SCHEMA, EARLIER_DECISIONS_LIMIT, SECTION_TITLES, SUMMARY_SCHEMA, summaryText,
  answerQuestion, buildQuestionRequest, buildSummaryRequest, formatAnswer,
  normalizeSummary, notesFile, renderSummary, summarizeMeeting,
} from '../supabase/functions/_shared/meetings.js';
import { AI_OFF, NO_MEETINGS, THREAD_INTRO } from '../supabase/functions/_shared/meeting-handlers.js';

const G = 'guild';

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
<v Ana>We said launch on December 1st.</v>

2
00:00:04.500 --> 00:00:07.000
<v Ana>But the pads need another week.</v>

3
00:01:10.000 --> 00:01:15.000
<v Ben>Agreed, let's move launch to December 8.</v>

4
00:02:00.000 --> 00:02:05.000
<v Ben>I'll update the release checklist by Friday.</v>

5
00:03:00.000 --> 00:03:04.000
<v Ana>Still not sure about pricing.</v>
`;

const SUMMARY = {
  title: 'Launch timing',
  overview: 'The team pushed the launch a week so the pads can be finished.',
  important: {
    key_points: [{ text: 'Pads need one more week of work.', refs: [1] }],
    decisions: [{ text: 'Launch moves to December 8.', why: 'Pads need another week.', refs: [2, 99] }],
    action_items: [{ task: 'Update the release checklist', owner: 'Ben', due: 'Friday', refs: [3] }],
  },
  changes: [{ what: 'Launch date', before: 'December 1', after: 'December 8', refs: [1, 2] }],
  open_questions: [{ text: 'Pricing is undecided.', refs: [4] }],
};

// A stored meeting, as the database returns it.
function meetingObj(summary = SUMMARY, extra = {}) {
  const segments = parseTranscript(VTT);
  return { id: 1, guild_id: G, title: 'Launch timing', source: 'file: call.vtt', raw: VTT, segments, summary: normalizeSummary(summary, segments), created_at: Date.now(), thread_id: 'thread1', ...extra };
}

// ---------- reading transcripts ----------

test('VTT: speakers from <v> tags, times shortened, same-speaker lines merged', () => {
  const s = parseTranscript(VTT);
  assert.equal(s.length, 4);
  assert.deepEqual(s[0], { n: 1, time: '0:01', speaker: 'Ana', text: 'We said launch on December 1st. But the pads need another week.' });
  assert.equal(s[1].speaker, 'Ben');
  assert.equal(s[1].time, '1:10');
  assert.match(s[2].text, /release checklist/);
  assert.match(renderSegments(s), /^\[S1 · 0:01\] Ana: We said/);
});

test('SRT and "Name: text" transcripts', () => {
  const srt = parseTranscript('1\n00:00:01,000 --> 00:00:02,000\nAna: Hi all\n\n2\n00:00:03,000 --> 00:00:04,000\nBen: Hello\n');
  assert.deepEqual(srt.map((x) => [x.speaker, x.text, x.time]), [['Ana', 'Hi all', '0:01'], ['Ben', 'Hello', '0:03']]);

  const plain = parseTranscript('[00:12] Ana: Kickoff\nBen: Sounds good\nBen: Shipping Friday\nloose note without a speaker');
  assert.deepEqual(plain.map((x) => [x.speaker, x.text, x.time]), [
    ['Ana', 'Kickoff', '0:12'], ['Ben', 'Sounds good Shipping Friday', null], [null, 'loose note without a speaker', null],
  ]);
});

test('Otter-style speaker headers', () => {
  const s = parseTranscript('Ana Lee  0:03\nWelcome everyone.\n\nBen  1:15\nQuick update on pads.\nThey ship Friday.');
  assert.deepEqual(s.map((x) => [x.speaker, x.time, x.text]), [
    ['Ana Lee', '0:03', 'Welcome everyone.'], ['Ben', '1:15', 'Quick update on pads. They ship Friday.'],
  ]);
});

test('Discord messages become segments, and times shorten correctly', () => {
  const s = fromMessages([
    { createdAt: new Date(2026, 10, 12, 14, 5), speaker: 'Ana', content: 'Ship it?', attachments: [] },
    { createdAt: new Date(2026, 10, 12, 14, 6), speaker: 'Ben', content: '', attachments: ['mock.png'] },
    { createdAt: new Date(2026, 10, 12, 14, 6), speaker: 'Ben', content: '   ', attachments: [] },
  ]);
  assert.deepEqual(s.map((x) => [x.n, x.time, x.speaker, x.text]), [[1, '14:05', 'Ana', 'Ship it?'], [2, '14:06', 'Ben', '[attached mock.png]']]);
  assert.equal(shortTime('01:15:00.000'), '1:15:00');
  assert.equal(shortTime('00:00:09'), '0:09');
});

// ---------- storing the full notes ----------

test('a meeting keeps its full notes, not just the summary', async () => {
  const { repo } = await freshDb();
  const segments = parseTranscript(VTT);
  const created = await repo.addMeeting({ guild_id: G, title: 'call', source: 'file: call.vtt', raw: VTT, segments, created_by_id: 'u1' });
  await repo.setMeetingSummary(created.id, normalizeSummary(SUMMARY, segments));
  await repo.setMeetingPost(created.id, 'chan', 'msg1', 'thread1');
  const m = await repo.getMeeting(G, created.id);
  assert.equal(m.raw, VTT, 'raw transcript stored as-is');
  assert.equal(m.segments.length, 4, 'every segment stored');
  assert.equal(m.title, 'Launch timing', 'title from the summary');
  assert.equal(m.summary.changes[0].after, 'December 8');
  assert.equal((await repo.meetingByThread(G, 'thread1')).id, m.id);
  assert.equal((await repo.meetingByMessage(G, 'msg1')).id, m.id);
  assert.equal((await repo.latestMeeting(G)).id, m.id);
  assert.equal(await repo.latestMeeting('other'), null);
  assert.equal((await repo.findMeetingByRaw(G, VTT)).id, m.id, 'same transcript is recognised');
  assert.match(notesFile(m), /\[S4 · 3:00\] Ana: Still not sure about pricing\./);
});

test('meetings without a finished summary are not offered for questions', async () => {
  const { repo } = await freshDb();
  await repo.addMeeting({ guild_id: G, title: 'x', source: 's', raw: 'a', segments: [{ n: 1, time: null, speaker: null, text: 'a' }], created_by_id: 'u' });
  assert.equal(await repo.latestMeeting(G), null);
  assert.equal((await repo.listMeetings(G)).length, 0);
});

// ---------- summary sections ----------

test('summary schema requires the Important and Changes sections', () => {
  assert.deepEqual(SUMMARY_SCHEMA.required, ['title', 'overview', 'important', 'changes', 'open_questions']);
  assert.deepEqual(SUMMARY_SCHEMA.properties.important.required, ['key_points', 'decisions', 'action_items']);
  assert.deepEqual(SUMMARY_SCHEMA.properties.changes.items.required, ['what', 'before', 'after', 'refs']);
  // Structured outputs needs every object closed.
  const walk = (s) => { if (s.type === 'object') { assert.equal(s.additionalProperties, false); Object.values(s.properties).forEach(walk); } if (s.items) walk(s.items); };
  walk(SUMMARY_SCHEMA);
  walk(ANSWER_SCHEMA);
});

test('summary request includes the numbered notes and earlier decisions to compare against', () => {
  const segments = parseTranscript(VTT);
  const req = buildSummaryRequest({
    title: 'Weekly',
    segments,
    earlierDecisions: [{ id: 3, content: 'Launch on December 1', why: 'Holiday traffic', created_at: Date.UTC(2026, 9, 1) }],
  });
  const body = req.messages[0].content;
  assert.match(body, /<earlier_decisions>\n- 2026-10-01: Launch on December 1\n<\/earlier_decisions>/, 'date + decision only, no reason');
  assert.match(body, /\[S2\] Ben: Agreed, let's move launch to December 8\./);
  assert.doesNotMatch(body, /\[S\d+ · /, 'no timestamps sent to Claude');
  assert.match(req.system, /important\.key_points/);
  assert.match(req.system, /changes: anything that changes/);
  assert.equal(req.schema, SUMMARY_SCHEMA);
  assert.match(buildSummaryRequest({ segments }).messages[0].content, /\(none logged yet\)/);
});

test('summary is cleaned up: bad citations dropped, empty items removed', () => {
  const segments = parseTranscript(VTT);
  const s = normalizeSummary({
    ...SUMMARY,
    important: { ...SUMMARY.important, key_points: [...SUMMARY.important.key_points, { text: '   ', refs: [1] }] },
    changes: [...SUMMARY.changes, { what: '', before: '', after: '', refs: [] }],
  }, segments);
  assert.deepEqual(s.important.decisions[0].refs, [2], 'S99 does not exist');
  assert.equal(s.important.key_points.length, 1);
  assert.equal(s.changes.length, 1);
  assert.equal(normalizeSummary({}, segments, 'Fallback').title, 'Fallback');
});

test('rendered summary: decisions and action items under Important, before → after under Changes', () => {
  const m = meetingObj();
  const { embeds } = renderSummary(m, m.summary);
  const [header, important, changes, open] = embeds;

  assert.equal(header.title, '🎙️ Launch timing');
  assert.equal(important.title, SECTION_TITLES.important);
  assert.match(important.description, /\*\*Key points\*\*\n• Pads need one more week of work\. `S1 · 0:01`/);
  assert.match(important.description, /\*\*Decisions\*\*\n• Launch moves to December 8\. — _Pads need another week\._ `S2 · 1:10`/);
  assert.match(important.description, /\*\*Action items\*\*\n• \*\*Ben\*\*: Update the release checklist · due Friday `S3 · 2:00`/);

  assert.equal(changes.title, SECTION_TITLES.changes);
  assert.match(changes.description, /• Launch date: ~~December 1~~ → \*\*December 8\*\*/);
  assert.doesNotMatch(important.description, /~~/, 'changes are not mixed into Important');

  assert.equal(open.title, SECTION_TITLES.open);
  assert.match(open.description, /Pricing is undecided/);
});

test('no changes and no open questions are shown clearly', () => {
  const m = meetingObj({ ...SUMMARY, changes: [], open_questions: [], important: { key_points: [], decisions: [], action_items: [{ task: 'Tidy', owner: '', due: '', refs: [] }] } });
  const { embeds } = renderSummary(m, m.summary);
  assert.equal(embeds.length, 3, 'open questions section is left out when empty');
  assert.equal(embeds[2].description, 'No changes to earlier plans or decisions.');
  assert.match(embeds[1].description, /• _unassigned_: Tidy$/);
});

test('huge summaries stay inside Discord limits', () => {
  const many = (n, f) => Array.from({ length: n }, (_, k) => f(k));
  const m = meetingObj({
    ...SUMMARY,
    overview: 'o'.repeat(3000),
    important: {
      key_points: many(80, (k) => ({ text: `point ${k} `.repeat(15), refs: [1, 2, 3] })),
      decisions: many(80, (k) => ({ text: `decision ${k} `.repeat(10), why: 'why '.repeat(20), refs: [2] })),
      action_items: many(80, (k) => ({ task: `task ${k} `.repeat(10), owner: 'Someone', due: 'soon', refs: [3] })),
    },
    changes: many(80, (k) => ({ what: `thing ${k}`, before: 'b '.repeat(30), after: 'a '.repeat(30), refs: [1] })),
    open_questions: many(80, (k) => ({ text: `q ${k} `.repeat(20), refs: [4] })),
  });
  const { embeds } = renderSummary(m, m.summary);
  const total = embeds.reduce((sum, e) => sum + (e.title?.length ?? 0) + (e.description?.length ?? 0), 0);
  assert.ok(total <= 6000, `total ${total}`);
  for (const e of embeds) assert.ok(e.description.length <= 4096);
  assert.match(embeds[1].description, /…and \d+ more$/);
});

test('summarizeMeeting sends the request and returns a clean summary', async () => {
  const segments = parseTranscript(VTT);
  const ai = fakeAi(SUMMARY);
  const s = await summarizeMeeting(ai, { title: '', segments, earlierDecisions: [] });
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].schema, SUMMARY_SCHEMA);
  assert.equal(s.changes[0].after, 'December 8');
});

// ---------- questions ----------

test('question request carries the full notes (cached), earlier Q&A, then the new question', () => {
  const m = meetingObj();
  const req = buildQuestionRequest(m, [{ question: 'When is launch?', answer: 'December 8 [S2 · 1:10].' }], 'Who updates the checklist?');
  const notes = req.system[1];
  assert.equal(notes.cache_control.type, 'ephemeral');
  for (const seg of m.segments) assert.ok(notes.text.includes(seg.text), `segment S${seg.n} sent`);
  assert.match(notes.text, /<summary>\n[\s\S]*Decisions:\n- Launch moves to December 8\. \(why: Pads need another week\.\) \[S2\]/, 'summary as plain text');
  assert.doesNotMatch(notes.text, /"key_points"/, 'not JSON');
  assert.match(req.system[0].text, /say so plainly/);
  assert.deepEqual(req.messages.map((x) => x.role), ['user', 'assistant', 'user']);
  assert.equal(req.messages.at(-1).content, 'Who updates the checklist?');
  assert.equal(req.schema, ANSWER_SCHEMA);
});

test('answers cite where they came from', async () => {
  const m = meetingObj();
  const ai = fakeAi({ answer: 'Ben is updating the release checklist by Friday [S3].', covered: true, refs: [3] });
  const a = await answerQuestion(ai, m, [], 'Who updates the checklist?');
  assert.equal(a.text, 'Ben is updating the release checklist by Friday [S3 · 2:00].');
  assert.deepEqual(a.refs, [3]);
  assert.equal(a.covered, true);
});

test('answers say when the notes do not cover the question', () => {
  const segs = parseTranscript(VTT);
  assert.equal(formatAnswer({ answer: 'Budget was not discussed.', covered: false, refs: [] }, segs).text, 'Budget was not discussed.');
  assert.equal(formatAnswer({ answer: 'Maybe ten dollars.', covered: false, refs: [] }, segs).text, 'The meeting notes don’t cover that. Maybe ten dollars.');
  assert.equal(formatAnswer({ answer: '', covered: false, refs: [] }, segs).text, 'The meeting notes don’t cover that.');
  assert.equal(formatAnswer({ answer: 'Yes [S9] and [S1].', covered: true, refs: [9, 1] }, segs).text, 'Yes and [S1 · 0:01].', 'made-up citation removed');
});

// ---------- token savings ----------

test('filler words are dropped from what Claude reads, but kept in the stored notes', () => {
  assert.equal(stripFiller('Um, so I think the, uh, onboarding flow is mostly there.'), 'so I think the onboarding flow is mostly there.');
  assert.equal(stripFiller('Right. Um. Next thing'), 'Right. Next thing');
  assert.equal(stripFiller('We hum along with the umbrella.'), 'We hum along with the umbrella.', 'real words untouched');
  assert.equal(stripFiller('Uhh'), 'Uhh', 'a line that is only filler is kept');
  const segs = parseTranscript('[00:05] Ana: Um, launch is, uh, Friday.');
  assert.equal(renderForModel(segs), '[S1] Ana: launch is Friday.');
  assert.match(renderSegments(segs), /Um, launch is, uh, Friday\./, 'downloadable notes stay word-for-word');
});

test('only the 15 most recent earlier decisions are sent, each kept short', () => {
  const decisions = Array.from({ length: 40 }, (_, k) => ({ id: k, content: `Decision ${k} ${'x'.repeat(300)}`, why: 'long reason', created_at: Date.UTC(2026, 9, 1) }));
  const body = buildSummaryRequest({ segments: parseTranscript(VTT), earlierDecisions: decisions }).messages[0].content;
  const listed = body.split('</earlier_decisions>')[0].split('\n').filter((l) => l.startsWith('- '));
  assert.equal(listed.length, EARLIER_DECISIONS_LIMIT);
  assert.ok(listed.every((l) => l.length < 170));
  assert.doesNotMatch(body, /long reason/);
});

test('the summary asks for short lists and at most 3 citations per item', () => {
  const req = buildSummaryRequest({ segments: parseTranscript(VTT) });
  assert.match(req.system, /at most 5/);
  assert.match(req.system, /1-3 segment numbers/);
});

test('summary as plain text is much smaller than JSON', () => {
  const segments = parseTranscript(VTT);
  const s = normalizeSummary(SUMMARY, segments);
  assert.ok(summaryText(s).length < JSON.stringify(s).length * 0.75, `${summaryText(s).length} vs ${JSON.stringify(s).length}`);
  assert.match(summaryText(s), /Changes:\n- Launch date: December 1 -> December 8 \[S1,S2\]/);
  assert.equal(summaryText(null), '');
});

// ---------- in Discord: summaries, the Ask button, /meeting ask ----------
import { AiError } from '../supabase/functions/_shared/ai.js';

const transcript = { id: 'att1', filename: 'call.vtt', url: 'https://cdn.discordapp.com/call.vtt', size: VTT.length, content_type: 'text/vtt; charset=utf-8' };
const summarize = (options = {}, extra = {}) =>
  command('meeting', { file: 'att1', ...options }, { sub: 'summarize', resolved: { attachments: { att1: transcript } }, ...extra });
const answerEcho = (req) => ({ answer: `You asked: ${req.messages.at(-1).content} [S2]`, covered: true, refs: [2] });

async function meetingBot({ ai = fakeAi(SUMMARY, answerEcho), home = true } = {}) {
  const discord = fakeDiscord({ channels: [
    { id: 'forum', type: CHANNEL.FORUM, name: 'notes' },
    { id: 'meeting-notes', type: CHANNEL.TEXT, name: 'meeting-notes' },
    { id: 'general', type: CHANNEL.TEXT, name: 'general' },
  ] });
  const bot = await makeBot({ ai, discord, fetchText: async () => VTT });
  await bot.repo.setSetting('g', 'notes_forum', 'forum');
  if (home) await bot.repo.setSetting('g', 'meetings_channel', 'meeting-notes');
  return bot;
}

test('/meeting summarize posts in #meeting-notes with sections, full notes, an Ask button and a thread', async () => {
  const bot = await meetingBot();
  const { response } = await bot.send(summarize());
  assert.equal(response.type, 5, 'shows “thinking…” while Claude works');

  const [post] = bot.discord.posts('meeting-notes');
  assert.deepEqual(post.embeds.map((e) => e.title), ['🎙️ Launch timing', '⭐ Important', '🔄 Changes', '❓ Open questions']);
  assert.equal(post.components[0].components[0].custom_id, 'ask:1');
  assert.equal(post.files[0].name, 'meeting-1-notes.txt');
  assert.match(post.files[0].data, /\[S4 · 3:00\] Ana: Still not sure about pricing\./);

  const pointer = bot.discord.state.webhooks.at(-1).body.content;
  assert.match(pointer, /are in <#meeting-notes>: https:\/\/discord\.com\/channels\/g\/meeting-notes\//);

  const thread = [...bot.discord.state.channels.values()].find((c) => c.from === post.id);
  assert.equal(thread.name, '💬 Launch timing');
  assert.equal(bot.discord.posts(thread.id)[0].content, THREAD_INTRO);

  const m = await bot.repo.latestMeeting('g');
  assert.equal(m.raw, VTT);
  assert.deepEqual([m.channel_id, m.message_id, m.thread_id], ['meeting-notes', post.id, thread.id]);
  const [decision] = await bot.repo.recentDecisions('g');
  assert.equal(decision.content, 'Launch moves to December 8.', 'decisions go into the decision log');
});

test('with no meeting-notes channel, the summary appears where the command ran', async () => {
  const bot = await meetingBot({ home: false });
  await bot.send(summarize());
  const edit = bot.discord.state.webhooks.at(-1);
  assert.equal(edit.body.embeds[1].title, '⭐ Important');
  assert.equal(edit.files[0].name, 'meeting-1-notes.txt');
  assert.ok((await bot.repo.latestMeeting('g')).thread_id);
});

test('the same transcript twice is not summarized (or paid for) twice', async () => {
  const bot = await meetingBot();
  await bot.send(summarize());
  await bot.send(summarize());
  assert.equal(bot.ai.calls.length, 1);
  assert.match(bot.discord.state.webhooks.at(-1).body.content, /already summarized as meeting #1/);
});

test('audio files and missing input are turned away before any AI call', async () => {
  const bot = await meetingBot();
  const audio = await bot.send(command('meeting', { file: 'a' }, { sub: 'summarize', resolved: { attachments: { a: { ...transcript, filename: 'call.m4a' } } } }));
  assert.match(audio.data.content, /Audio and video files aren’t supported yet/);
  const nothing = await bot.send(command('meeting', {}, { sub: 'summarize' }));
  assert.match(nothing.data.content, /Attach a transcript/);
  assert.equal(bot.ai.calls.length, 0);
});

test('without an API key, meeting AI explains itself; listing still works', async () => {
  const bot = await meetingBot({ ai: null });
  assert.equal((await bot.send(summarize())).data.content, AI_OFF);
  assert.equal((await bot.send(click('ask:1'))).data.content, AI_OFF);
  assert.equal((await bot.send(command('meeting', {}, { sub: 'list' }))).data.content, NO_MEETINGS);
});

test('Ask a question opens a form; the answer is posted in the meeting’s thread with citations', async () => {
  const bot = await meetingBot();
  await bot.send(summarize());
  const m = await bot.repo.latestMeeting('g');

  const form = await bot.send(click(`ask:${m.id}`));
  assert.equal(form.response.type, 9, 'a form pops up');
  assert.equal(form.response.data.custom_id, `askm:${m.id}`);
  assert.equal(form.response.data.components[0].components[0].custom_id, 'question');

  const sent = await bot.send(submitForm(`askm:${m.id}`, { question: 'When is launch?' }));
  assert.equal(sent.response.type, 5);
  assert.equal(sent.response.data.flags, 64, 'the pointer is private');
  const [, answer] = bot.discord.posts(m.thread_id);
  assert.equal(answer.content, '**<@u1> asked:** When is launch?\nYou asked: When is launch? [S2 · 1:10]');
  assert.deepEqual(answer.allowed_mentions, { parse: [] }, 'nobody gets pinged');
  assert.match(bot.discord.state.webhooks.at(-1).body.content, /Answered in the meeting’s thread/);
  assert.equal((await bot.repo.recentQuestions(m.id)).length, 1);
});

test('follow-up questions include recent Q&A, but nothing older than 30 minutes', async () => {
  const bot = await meetingBot();
  await bot.send(summarize());
  const m = await bot.repo.latestMeeting('g');
  await bot.repo.addQuestion(m.id, 'x', 'Ancient?', 'Old.', Date.now() - 60 * 60 * 1000);
  await bot.send(submitForm(`askm:${m.id}`, { question: 'When is launch?' }));
  await bot.send(submitForm(`askm:${m.id}`, { question: 'Why did it move?' }));
  const sent = bot.ai.calls.at(-1).messages.map((x) => x.content);
  assert.deepEqual(sent, ['When is launch?', 'You asked: When is launch? [S2 · 1:10]', 'Why did it move?']);
});

test('a very long question is cut down before it is sent', async () => {
  const bot = await meetingBot();
  await bot.send(summarize());
  await bot.send(submitForm('askm:1', { question: `why ${'x'.repeat(3000)}?` }));
  assert.ok(bot.ai.calls.at(-1).messages.at(-1).content.length <= 501);
});

test('/meeting ask uses the thread’s meeting, or the latest one (and says which)', async () => {
  const bot = await meetingBot();
  await bot.send(summarize());
  const m = await bot.repo.latestMeeting('g');
  await bot.send(command('meeting', { question: 'When is launch?' }, { sub: 'ask', channel_id: m.thread_id }));
  assert.equal(bot.discord.state.webhooks.at(-1).body.content, '> When is launch?\nYou asked: When is launch? [S2 · 1:10]');
  await bot.send(command('meeting', { question: 'Who owns it?' }, { sub: 'ask' }));
  assert.match(bot.discord.state.webhooks.at(-1).body.content, /^-# About meeting #1: Launch timing\n> Who owns it\?/);
});

test('when Claude fails, the “thinking…” message turns into a clear error', async () => {
  const ai = fakeAi(() => { throw new AiError('Claude took too long to answer.'); });
  const bot = await meetingBot({ ai });
  await bot.send(summarize());
  assert.equal(bot.discord.state.webhooks.at(-1).body.content, '⚠️ Claude took too long to answer.');
});

test('/meeting list and /meeting notes', async () => {
  const bot = await meetingBot();
  await bot.send(summarize());
  assert.match((await bot.send(command('meeting', {}, { sub: 'list' }))).data.content, /🎙️ \*\*#1\*\* Launch timing/);
  await bot.send(command('meeting', { id: 1 }, { sub: 'notes' }));
  const edit = bot.discord.state.webhooks.at(-1);
  assert.match(edit.files[0].data, /\[S1 · 0:01\] Ana:/);
});

test('hours: summarizes the channel’s recent messages, skipping bots and emoji-only chatter', async () => {
  const bot = await meetingBot();
  const t = (min) => new Date(Date.now() - min * 60_000).toISOString();
  bot.discord.state.messages.set('history:general', [ // newest first, like Discord
    { id: '4', timestamp: t(1), author: { username: 'ben' }, content: 'Agreed, Dec 8.' },
    { id: '3', timestamp: t(2), author: { username: 'bot', bot: true }, content: 'beep' },
    { id: '2', timestamp: t(3), author: { username: 'ana' }, content: '👍' },
    { id: '1', timestamp: t(4), author: { username: 'ana', global_name: 'Ana' }, content: 'Move launch a week?' },
    { id: '0', timestamp: t(200), author: { username: 'ana' }, content: 'too old' },
  ]);
  await bot.send(command('meeting', { hours: 2 }, { sub: 'summarize' }));
  const sent = bot.ai.calls[0].messages[0].content;
  assert.match(sent, /\[S1\] Ana: Move launch a week\?\n\[S2\] ben: Agreed, Dec 8\./);
  assert.doesNotMatch(sent, /beep|👍|too old/);
});
