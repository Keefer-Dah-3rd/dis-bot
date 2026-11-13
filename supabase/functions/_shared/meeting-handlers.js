// /meeting: summaries, and questions about them (the "Ask a question" button,
// or /meeting ask).
import { fileNote } from './filing.js';
import { messageUrl } from './discord-api.js';
import { fitLines, snippet } from './format.js';
import { defer, modal, reply, row } from './interaction.js';
import { answerQuestion, MAX_NOTES_CHARS, notesFile, renderSummary, summarizeMeeting } from './meetings.js';
import { fromMessages, parseTranscript, renderSegments } from './transcript.js';

const EPH = { ephemeral: true };
const TEXT_FILE = /\.(txt|text|vtt|srt|md|markdown)$/i;
const MEDIA_FILE = /\.(mp3|m4a|wav|aac|flac|ogg|opus|mp4|mov|webm|mkv|avi)$/i;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Follow-ups ("why did it move?") need the last few exchanges, but older ones
// are just extra tokens on every question.
const HISTORY = 3;
const HISTORY_WINDOW_MS = 30 * 60 * 1000;
const MAX_QUESTION_CHARS = 500;

export const AI_OFF = 'Meeting summaries and questions use AI, which isn’t switched on for this bot yet. It turns on once an Anthropic API key is added to the bot’s settings (see “Meeting notes” in the README).';
export const NO_MEETINGS = 'There are no meeting summaries yet. Make one with `/meeting summarize`.';
export const THREAD_INTRO = 'Questions and answers about this meeting collect here. Press **Ask a question** on the summary, or type `/meeting ask` in this thread.';

async function defaultFetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn’t download the file (${res.status}).`);
  return res.text();
}

// Messages from the last `hours` in a channel, oldest first, skipping bots and emoji-only chatter.
async function recentMessages(discord, channelId, hours) {
  const cutoff = Date.now() - hours * 3_600_000;
  const out = [];
  let before;
  while (out.length < 2000) {
    const batch = await discord.messages(channelId, { before });
    if (!batch?.length) break;
    let reachedCutoff = false;
    for (const m of batch) {
      const at = new Date(m.timestamp);
      if (at.getTime() < cutoff) { reachedCutoff = true; break; }
      if (m.author?.bot) continue;
      if (!/[\p{L}\p{N}]/u.test(m.content ?? '') && !m.attachments?.length) continue;
      out.push({
        createdAt: at,
        speaker: m.author?.global_name ?? m.author?.username ?? 'someone',
        content: m.content,
        attachments: (m.attachments ?? []).map((a) => a.filename),
      });
    }
    if (reachedCutoff) break;
    before = batch.at(-1).id;
  }
  return out.reverse();
}

export function createMeetingHandlers({ repo, discord, ai, fetchText = defaultFetchText }) {
  async function ask(meeting, question, userId) {
    question = question.length > MAX_QUESTION_CHARS ? `${question.slice(0, MAX_QUESTION_CHARS)}…` : question;
    const history = await repo.recentQuestions(meeting.id, HISTORY, Date.now() - HISTORY_WINDOW_MS);
    const { text } = await answerQuestion(ai, meeting, history, question);
    await repo.addQuestion(meeting.id, userId, question, text);
    return text;
  }

  async function summarize(c) {
    const file = c.optAttachment('file');
    const hours = c.opt('hours');
    const givenTitle = c.opt('title');

    if (!file && !hours) return reply({ content: 'Attach a transcript with `file:`, or use `hours:` to summarize this channel’s recent messages.' }, EPH);
    if (file && MEDIA_FILE.test(file.filename)) {
      return reply({ content: 'Audio and video files aren’t supported yet. Zoom, Google Meet and Teams can all export a transcript (.vtt or .txt): upload that instead.' }, EPH);
    }
    if (file && !TEXT_FILE.test(file.filename) && !String(file.content_type ?? '').startsWith('text/')) {
      return reply({ content: 'I can read .vtt, .srt, .txt and .md transcripts.' }, EPH);
    }
    if (file && file.size > MAX_FILE_BYTES) return reply({ content: 'That file is over 5 MB. Split it into parts and summarize each.' }, EPH);

    return defer(async () => {
      let raw;
      let segments;
      let source;
      if (file) {
        raw = await fetchText(file.url);
        segments = parseTranscript(raw);
        source = `file: ${file.filename}`;
      } else {
        segments = fromMessages(await recentMessages(discord, c.channelId, hours));
        raw = renderSegments(segments);
        source = `#${c.channel?.name ?? 'channel'}, last ${hours}h`;
      }
      if (!segments.length) return { content: 'I couldn’t find any text to summarize.' };
      if (renderSegments(segments).length > MAX_NOTES_CHARS) {
        return { content: 'Those notes are too long for one summary. Split the meeting into parts and summarize each.' };
      }

      // The same transcript twice? Point to the summary we already paid for.
      const already = await repo.findMeetingByRaw(c.guildId, raw);
      if (already?.message_id) {
        return { content: `🎙️ That was already summarized as meeting #${already.id}, **${snippet(already.title, 80)}**: ${messageUrl(c.guildId, already.channel_id, already.message_id)}` };
      }

      const fallbackTitle = givenTitle ?? (file ? file.filename.replace(/\.[^.]+$/, '') : `#${c.channel?.name ?? 'channel'} discussion`);
      const meeting = await repo.addMeeting({ guild_id: c.guildId, title: fallbackTitle, source, raw, segments, created_by_id: c.userId });
      const summary = await summarizeMeeting(ai, { title: givenTitle ?? '', segments, earlierDecisions: await repo.recentDecisions(c.guildId, 15) });
      if (givenTitle) summary.title = givenTitle;
      await repo.setMeetingSummary(meeting.id, summary);
      const stored = await repo.getMeeting(c.guildId, meeting.id);

      const post = { ...renderSummary(stored, summary), allowed_mentions: { parse: [] } };
      const files = [{ name: `meeting-${meeting.id}-notes.txt`, data: notesFile(stored) }];

      // Summaries live in the meeting-notes channel; if the command ran somewhere
      // else, post there and leave a pointer here.
      const homeId = await repo.getSetting(c.guildId, 'meetings_channel');
      let msg = null;
      let pointer = null;
      if (homeId && homeId !== c.channelId) {
        msg = await discord.send(homeId, post, files).catch(() => null);
        if (msg) pointer = { content: `🎙️ Meeting notes for **${snippet(summary.title, 80)}** are in <#${homeId}>: ${messageUrl(c.guildId, homeId, msg.id)}` };
      }
      if (!msg) msg = await discord.editOriginal(c.token, post, files);

      let thread = null;
      try {
        thread = await discord.startThread(msg.channel_id, msg.id, { name: snippet(`💬 ${summary.title}`, 100), auto_archive_duration: 10080 });
        await discord.send(thread.id, { content: THREAD_INTRO });
      } catch {
        thread = null; // e.g. the command ran inside a thread, where threads can't nest
      }
      await repo.setMeetingPost(meeting.id, msg.channel_id, msg.id, thread?.id ?? null);

      // Decisions from the meeting go into the decision log too.
      for (const d of summary.important.decisions) {
        const note = await repo.addNote({
          guild_id: c.guildId, tag: 'decision', content: d.text, why: d.why || null,
          author_id: c.userId, source_url: messageUrl(c.guildId, msg.channel_id, msg.id),
        });
        await fileNote(discord, repo, c.guildId, note.id).catch(() => {});
      }
      return pointer; // null when the summary itself replaced the "thinking…" message
    });
  }

  async function askCommand(c) {
    const id = c.opt('id');
    const inThread = await repo.meetingByThread(c.guildId, c.channelId);
    const meeting = id ? await repo.getMeeting(c.guildId, id) : (inThread ?? await repo.latestMeeting(c.guildId));
    if (!meeting?.summary) return reply({ content: id ? 'There’s no meeting with that number.' : NO_MEETINGS }, EPH);
    const question = c.opt('question');
    const which = inThread?.id === meeting.id ? '' : `-# About meeting #${meeting.id}: ${snippet(meeting.title, 80)}\n`;
    return defer(async () => ({ content: `${which}> ${snippet(question, 200)}\n${await ask(meeting, question, c.userId)}` }));
  }

  async function list(c) {
    const meetings = await repo.listMeetings(c.guildId, 15);
    if (!meetings.length) return reply({ content: NO_MEETINGS }, EPH);
    const lines = meetings.map((m) => {
      const link = m.message_id ? ` · [open](${messageUrl(m.guild_id, m.channel_id, m.message_id)})` : '';
      return `🎙️ **#${m.id}** ${snippet(m.title, 70)} · <t:${Math.floor(m.created_at / 1000)}:d>${link}`;
    });
    return reply({ content: fitLines(lines, 1900) }, EPH);
  }

  async function notes(c) {
    const meeting = await repo.getMeeting(c.guildId, c.opt('id'));
    if (!meeting) return reply({ content: 'There’s no meeting with that number.' }, EPH);
    return defer(async () => ({
      content: `Full notes for meeting #${meeting.id}: ${snippet(meeting.title, 80)}`,
      files: [{ name: `meeting-${meeting.id}-notes.txt`, data: notesFile(meeting) }],
    }), EPH);
  }

  return {
    commands: {
      async meeting(c) {
        if (c.sub === 'list') return list(c);
        if (c.sub === 'notes') return notes(c);
        if (!ai) return reply({ content: AI_OFF }, EPH);
        if (c.sub === 'summarize') return summarize(c);
        if (c.sub === 'ask') return askCommand(c);
        return null;
      },
    },

    components: {
      // "Ask a question" under a summary: opens a small form.
      async ask(c, id) {
        if (!ai) return reply({ content: AI_OFF }, EPH);
        const meeting = await repo.getMeeting(c.guildId, Number(id));
        if (!meeting?.summary) return reply({ content: 'I can’t find that meeting any more.' }, EPH);
        return modal({
          custom_id: `askm:${meeting.id}`,
          title: snippet(`Ask about: ${meeting.title}`, 45),
          components: [row({
            type: 4, custom_id: 'question', style: 2, label: 'Your question', required: true, max_length: MAX_QUESTION_CHARS,
            placeholder: 'e.g. Who owns the release checklist?',
          })],
        });
      },
    },

    modals: {
      // The form was sent: answer in the meeting's thread so Q&A stays together.
      async askm(c, id) {
        const question = String(c.field('question') ?? '').trim();
        if (!question) return reply({ content: 'Type a question first.' }, EPH);
        if (!ai) return reply({ content: AI_OFF }, EPH);
        const meeting = await repo.getMeeting(c.guildId, Number(id));
        if (!meeting?.summary) return reply({ content: 'I can’t find that meeting any more.' }, EPH);

        return defer(async () => {
          const answer = await ask(meeting, question, c.userId);
          const where = meeting.thread_id ?? meeting.channel_id;
          if (meeting.thread_id) await discord.unarchive(meeting.thread_id).catch(() => {});
          const posted = where
            ? await discord.send(where, { content: `**<@${c.userId}> asked:** ${snippet(question, 300)}\n${answer}`, allowed_mentions: { parse: [] } }).catch(() => null)
            : null;
          if (!posted) return { content: answer }; // couldn't post: show the answer just to the asker
          return { content: `Answered in the meeting’s thread: ${messageUrl(c.guildId, where, posted.id)}` };
        }, EPH);
      },
    },
  };
}
