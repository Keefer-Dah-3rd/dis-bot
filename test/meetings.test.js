import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { parseTranscript, fromMessages, renderForModel, renderSegments, shortTime, stripFiller } from '../src/transcript.js';
import {
  ANSWER_SCHEMA, EARLIER_DECISIONS_LIMIT, SECTION_TITLES, SUMMARY_SCHEMA, summaryText,
  answerQuestion, buildQuestionRequest, buildSummaryRequest, formatAnswer,
  normalizeSummary, notesFile, renderSummary, summarizeMeeting,
} from '../src/meetings.js';
import { AI_OFF, ASK_HINT, createMeetingHandlers, looksLikeQuestion, NO_MEETINGS } from '../src/meeting-handlers.js';

const G = 'guild';

// Stands in for Claude: records each request and replies with canned JSON. Costs nothing.
function fakeAi(...replies) {
  const calls = [];
  return {
    calls,
    model: 'fake',
    async json(req) {
      calls.push(req);
      const next = replies.length > 1 ? replies.shift() : replies[0];
      return { data: typeof next === 'function' ? next(req) : structuredClone(next) };
    },
  };
}

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

function storedMeeting(repo, summary = SUMMARY) {
  const segments = parseTranscript(VTT);
  const m = repo.addMeeting({ guild_id: G, title: 'call', source: 'file: call.vtt', raw: VTT, segments, created_by_id: 'u1' });
  repo.setMeetingSummary(m.id, normalizeSummary(summary, segments));
  repo.setMeetingPost(m.id, 'chan', 'msg1', 'thread1');
  return repo.getMeeting(G, m.id);
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

test('a meeting keeps its full notes, not just the summary', () => {
  const repo = openDb();
  const m = storedMeeting(repo);
  assert.equal(m.raw, VTT, 'raw transcript stored as-is');
  assert.equal(m.segments.length, 4, 'every segment stored');
  assert.equal(m.title, 'Launch timing', 'title from the summary');
  assert.equal(repo.meetingByThread(G, 'thread1').id, m.id);
  assert.equal(repo.meetingByMessage(G, 'msg1').id, m.id);
  assert.equal(repo.latestMeeting(G).id, m.id);
  assert.equal(repo.latestMeeting('other'), null);
  assert.match(notesFile(m).toString(), /\[S4 · 3:00\] Ana: Still not sure about pricing\./);
});

test('meetings without a finished summary are not offered for questions', () => {
  const repo = openDb();
  repo.addMeeting({ guild_id: G, title: 'x', source: 's', raw: 'a', segments: [{ n: 1, time: null, speaker: null, text: 'a' }], created_by_id: 'u' });
  assert.equal(repo.latestMeeting(G), null);
  assert.equal(repo.listMeetings(G).length, 0);
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
  const repo = openDb();
  const m = storedMeeting(repo);
  const { embeds } = renderSummary(m, m.summary);
  const [header, important, changes, open] = embeds.map((e) => e.data);

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
  const repo = openDb();
  const m = storedMeeting(repo, { ...SUMMARY, changes: [], open_questions: [], important: { key_points: [], decisions: [], action_items: [{ task: 'Tidy', owner: '', due: '', refs: [] }] } });
  const { embeds } = renderSummary(m, m.summary);
  assert.equal(embeds.length, 3, 'open questions section is left out when empty');
  assert.equal(embeds[2].data.description, 'No changes to earlier plans or decisions.');
  assert.match(embeds[1].data.description, /• _unassigned_: Tidy$/);
});

test('huge summaries stay inside Discord limits', () => {
  const repo = openDb();
  const many = (n, f) => Array.from({ length: n }, (_, k) => f(k));
  const m = storedMeeting(repo, {
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
  const total = embeds.reduce((sum, e) => sum + (e.data.title?.length ?? 0) + (e.data.description?.length ?? 0), 0);
  assert.ok(total <= 6000, `total ${total}`);
  for (const e of embeds) assert.ok(e.data.description.length <= 4096);
  assert.match(embeds[1].data.description, /…and \d+ more$/);
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
  const repo = openDb();
  const m = storedMeeting(repo);
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
  const repo = openDb();
  const m = storedMeeting(repo);
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

test('looksLikeQuestion filters thread chatter', () => {
  assert.ok(looksLikeQuestion('who owns the checklist'));
  assert.ok(looksLikeQuestion('launch date?'));
  assert.ok(looksLikeQuestion('Summarize the pricing bit'));
  assert.ok(!looksLikeQuestion('thanks!'));
  assert.ok(!looksLikeQuestion('nice work everyone'));
});

// ---------- talking to the bot in Discord ----------

function fakeMessage({ content, channelId = 'elsewhere', mentionsBot = false, replyTo = null, bot = false }) {
  const replies = [];
  return {
    replies,
    content,
    guildId: G,
    channelId,
    author: { id: 'asker', bot },
    mentions: { users: new Map(mentionsBot ? [['42', {}]] : []) },
    reference: replyTo ? { messageId: replyTo } : null,
    channel: { sendTyping: async () => {} },
    reply: async (payload) => { replies.push(payload); return payload; },
  };
}

function setup(aiReply) {
  const repo = openDb();
  const meeting = storedMeeting(repo);
  const ai = aiReply === null ? null : fakeAi(aiReply ?? ((req) => ({ answer: `You asked: ${req.messages.at(-1).content} [S2]`, covered: true, refs: [2] })));
  const handlers = createMeetingHandlers({ client: { user: { id: '42' } }, repo, ai });
  return { repo, meeting, ai, handlers };
}

test('a question in the meeting thread is answered from that meeting and remembered', async () => {
  const { repo, meeting, ai, handlers } = setup();
  const msg = fakeMessage({ content: 'When is launch now?', channelId: 'thread1' });
  await handlers.onMessage(msg);
  assert.equal(msg.replies.length, 1);
  assert.equal(msg.replies[0].content, 'You asked: When is launch now? [S2 · 1:10]');
  assert.deepEqual(msg.replies[0].allowedMentions, { parse: [], repliedUser: false });
  assert.equal(repo.recentQuestions(meeting.id).length, 1);

  // The follow-up includes the first exchange so "it" / "that" make sense.
  await handlers.onMessage(fakeMessage({ content: 'Why did it move?', channelId: 'thread1' }));
  assert.deepEqual(ai.calls[1].messages.map((x) => x.content), ['When is launch now?', 'You asked: When is launch now? [S2 · 1:10]', 'Why did it move?']);
});

test('chatter in the thread is ignored; @mentions always answer', async () => {
  const { ai, handlers } = setup();
  const chatter = fakeMessage({ content: 'thanks!', channelId: 'thread1' });
  await handlers.onMessage(chatter);
  assert.equal(chatter.replies.length, 0);
  assert.equal(ai.calls.length, 0);

  const pinged = fakeMessage({ content: '<@42> recap pricing', channelId: 'thread1', mentionsBot: true });
  await handlers.onMessage(pinged);
  assert.equal(ai.calls.at(-1).messages.at(-1).content, 'recap pricing', 'mention stripped from the question');
});

test('@mention outside the thread uses the replied-to meeting, else the latest (and says which)', async () => {
  const { handlers } = setup();
  const reply = fakeMessage({ content: '<@42> what changed?', mentionsBot: true, replyTo: 'msg1' });
  await handlers.onMessage(reply);
  assert.doesNotMatch(reply.replies[0].content, /About meeting/);

  const loose = fakeMessage({ content: '<@42> what changed?', mentionsBot: true });
  await handlers.onMessage(loose);
  assert.match(loose.replies[0].content, /^-# About meeting #1: Launch timing\n/);
});

test('messages that are not for the bot are ignored', async () => {
  const { ai, handlers } = setup();
  for (const m of [
    fakeMessage({ content: 'what time is lunch?' }), // not in a meeting thread, no mention
    fakeMessage({ content: 'When is launch?', channelId: 'thread1', bot: true }), // bots
    fakeMessage({ content: '<@42>', mentionsBot: true }), // mention with no question
  ]) {
    await handlers.onMessage(m);
    assert.equal(m.replies.length, 0);
  }
  assert.equal(ai.calls.length, 0);
});

test('without an API key the bot explains instead of answering', async () => {
  const { handlers } = setup(null);
  const msg = fakeMessage({ content: '<@42> when is launch?', mentionsBot: true });
  await handlers.onMessage(msg);
  assert.equal(msg.replies[0].content, AI_OFF);
});

test('no meetings yet', async () => {
  const repo = openDb();
  const handlers = createMeetingHandlers({ client: { user: { id: '42' } }, repo, ai: fakeAi({}) });
  const msg = fakeMessage({ content: '<@42> when is launch?', mentionsBot: true });
  await handlers.onMessage(msg);
  assert.equal(msg.replies[0].content, NO_MEETINGS);
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

test('only recent questions are sent as history', async () => {
  const { repo, meeting, ai, handlers } = setup();
  const hourAgo = Date.now() - 60 * 60 * 1000;
  repo.addQuestion(meeting.id, 'x', 'Old question?', 'Old answer.', hourAgo);
  for (const q of ['One?', 'Two?', 'Three?', 'Four?']) repo.addQuestion(meeting.id, 'x', q, 'A.');
  await handlers.onMessage(fakeMessage({ content: 'And five?', channelId: 'thread1' }));
  const sent = ai.calls[0].messages.filter((m) => m.role === 'user').map((m) => m.content);
  assert.deepEqual(sent, ['Two?', 'Three?', 'Four?', 'And five?'], 'last 3 from the past 30 minutes, nothing older');
});

test('a very long question is cut down before it is sent', async () => {
  const { ai, handlers } = setup();
  await handlers.onMessage(fakeMessage({ content: `why ${'x'.repeat(3000)}?`, channelId: 'thread1' }));
  assert.ok(ai.calls[0].messages.at(-1).content.length <= 501);
});

test('an @mention that is not a question gets a free tip, not an AI call', async () => {
  const { ai, handlers } = setup();
  const hi = fakeMessage({ content: '<@42> hi!', mentionsBot: true });
  await handlers.onMessage(hi);
  assert.equal(hi.replies[0].content, ASK_HINT);
  assert.equal(ai.calls.length, 0);
});

test('summarizing the same transcript twice reuses the first summary', async () => {
  const repo = openDb();
  const segments = parseTranscript(VTT);
  const first = repo.addMeeting({ guild_id: G, title: 'call', source: 'file: call.vtt', raw: VTT, segments, created_by_id: 'u1' });
  repo.setMeetingSummary(first.id, normalizeSummary(SUMMARY, segments));
  repo.setMeetingPost(first.id, 'notes-chan', 'msg9', 't9');

  let calls = 0;
  const handlers = createMeetingHandlers({
    client: { user: { id: '42' }, channels: { fetch: async () => { throw new Error('none'); } } },
    repo,
    ai: { async json() { calls += 1; return { data: SUMMARY }; } },
    fetchText: async () => VTT,
  });
  const edits = [];
  await handlers.command({
    guildId: G, channelId: 'c', channel: { name: 'general' }, user: { id: 'u1' },
    options: { getSubcommand: () => 'summarize', getAttachment: () => ({ name: 'call.vtt', url: 'u', size: 10, contentType: 'text/vtt' }), getInteger: () => null, getString: () => null },
    async deferReply() {},
    async editReply(p) { edits.push(p); return {}; },
  });
  assert.equal(calls, 0, 'no AI call');
  assert.match(edits[0], /already summarized as meeting #1.*\/notes-chan\/msg9/);
});
