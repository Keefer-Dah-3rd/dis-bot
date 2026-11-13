import { AttachmentBuilder, MessageFlags, ThreadAutoArchiveDuration } from 'discord.js';
import { AiError } from './ai.js';
import { queueFile } from './filing.js';
import { fitLines, snippet } from './format.js';
import { answerQuestion, MAX_NOTES_CHARS, notesFile, renderSummary, summarizeMeeting } from './meetings.js';
import { fromMessages, parseTranscript, renderSegments } from './transcript.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const TEXT_FILE = /\.(txt|text|vtt|srt|md|markdown)$/i;
const MEDIA_FILE = /\.(mp3|m4a|wav|aac|flac|ogg|opus|mp4|mov|webm|mkv|avi)$/i;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const HISTORY = 4; // earlier questions about the same meeting the bot remembers

export const AI_OFF = 'Meeting summaries and questions use AI, which isn’t switched on for this bot yet. Whoever runs the bot can turn it on by adding an Anthropic API key to `.env` (see “Meeting notes” in the README).';
export const NO_MEETINGS = 'There are no meeting summaries yet. Make one with `/meeting summarize`.';
const THREAD_INTRO = 'Ask me anything about this meeting here. I answer from the full notes and point to where it was said, like `S12 · 4:05`.';

// In a meeting thread, only messages that look like questions get an answer,
// so "thanks!" doesn't cost anything. @mentioning the bot always works.
export function looksLikeQuestion(text) {
  return /\?/.test(text) || /^(who|what|when|where|why|how|which|did|do|does|is|are|was|were|can|could|should|will|would|has|have|any|tell|summari[sz]e|list|explain)\b/i.test(text.trim());
}

function errorText(err) {
  if (err instanceof AiError) return `⚠️ ${err.message}`;
  console.error(err);
  return '⚠️ Something went wrong. The details are in the bot’s terminal window.';
}

async function defaultFetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn’t download the file (${res.status}).`);
  return res.text();
}

// Messages from the last `hours` in a channel, oldest first, skipping bots.
async function recentMessages(channel, hours) {
  const cutoff = Date.now() - hours * 3_600_000;
  const out = [];
  let before;
  while (out.length < 2000) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    let reachedCutoff = false;
    for (const m of batch.values()) {
      if (m.createdTimestamp < cutoff) { reachedCutoff = true; break; }
      if (m.author.bot) continue;
      out.push({
        createdAt: m.createdAt,
        speaker: m.member?.displayName ?? m.author.globalName ?? m.author.username,
        content: m.content,
        attachments: [...m.attachments.values()].map((a) => a.name),
      });
    }
    if (reachedCutoff) break;
    before = batch.last().id;
  }
  return out.reverse();
}

export function createMeetingHandlers({ client, repo, ai, fetchText = defaultFetchText }) {
  async function ask(meeting, question, userId, { showWhich = false } = {}) {
    const history = repo.recentQuestions(meeting.id, HISTORY);
    const { text } = await answerQuestion(ai, meeting, history, question);
    repo.addQuestion(meeting.id, userId, question, text);
    return showWhich ? `-# About meeting #${meeting.id}: ${snippet(meeting.title, 80)}\n${text}` : text;
  }

  async function summarize(i) {
    const file = i.options.getAttachment('file');
    const hours = i.options.getInteger('hours');
    const givenTitle = i.options.getString('title');

    if (!file && !hours) {
      return i.reply({ content: 'Attach a transcript with `file:`, or use `hours:` to summarize this channel’s recent messages.', flags: EPHEMERAL });
    }
    if (file && MEDIA_FILE.test(file.name)) {
      return i.reply({ content: 'Audio and video files aren’t supported yet. Zoom, Google Meet and Teams can all export a transcript (.vtt or .txt): upload that instead.', flags: EPHEMERAL });
    }
    if (file && !TEXT_FILE.test(file.name) && !String(file.contentType ?? '').startsWith('text/')) {
      return i.reply({ content: 'I can read .vtt, .srt, .txt and .md transcripts.', flags: EPHEMERAL });
    }
    if (file && file.size > MAX_FILE_BYTES) {
      return i.reply({ content: 'That file is over 5 MB. Split it into parts and summarize each.', flags: EPHEMERAL });
    }

    await i.deferReply();
    try {
      let raw;
      let segments;
      let source;
      if (file) {
        raw = await fetchText(file.url);
        segments = parseTranscript(raw);
        source = `file: ${file.name}`;
      } else {
        segments = fromMessages(await recentMessages(i.channel, hours));
        raw = renderSegments(segments);
        source = `#${i.channel?.name ?? 'channel'}, last ${hours}h`;
      }
      if (!segments.length) return i.editReply('I couldn’t find any text to summarize.');
      if (renderSegments(segments).length > MAX_NOTES_CHARS) {
        return i.editReply('Those notes are too long for one summary. Split the meeting into parts and summarize each.');
      }

      const fallbackTitle = givenTitle ?? (file ? file.name.replace(/\.[^.]+$/, '') : `#${i.channel?.name ?? 'channel'} discussion`);
      const meeting = repo.addMeeting({ guild_id: i.guildId, title: fallbackTitle, source, raw, segments, created_by_id: i.user.id });
      const summary = await summarizeMeeting(ai, { title: givenTitle ?? '', segments, earlierDecisions: repo.recentDecisions(i.guildId, 40) });
      if (givenTitle) summary.title = givenTitle;
      repo.setMeetingSummary(meeting.id, summary);
      const stored = repo.getMeeting(i.guildId, meeting.id);

      const post = {
        ...renderSummary(stored, summary),
        files: [new AttachmentBuilder(notesFile(stored), { name: `meeting-${meeting.id}-notes.txt` })],
        allowedMentions: { parse: [] },
      };

      // Summaries live in the meeting-notes channel. If the command was run
      // somewhere else, post there and leave a pointer here.
      const homeId = repo.getSetting(i.guildId, 'meetings_channel');
      const home = homeId && homeId !== i.channelId ? await client.channels.fetch(homeId).catch(() => null) : null;
      let msg;
      if (home?.isTextBased?.()) {
        msg = await home.send(post);
        await i.editReply({ content: `🎙️ Meeting notes for **${snippet(summary.title, 80)}** are in <#${home.id}>: ${msg.url}`, allowedMentions: { parse: [] } });
      } else {
        msg = await i.editReply(post);
      }

      let thread = null;
      try {
        thread = await msg.startThread({ name: snippet(`💬 ${summary.title}`, 100), autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek });
        await thread.send(THREAD_INTRO);
      } catch {
        thread = null; // e.g. the command ran inside a thread, where threads can't nest
      }
      repo.setMeetingPost(meeting.id, msg.channelId, msg.id, thread?.id ?? null);

      // Decisions from the meeting go into the decision log too.
      for (const d of summary.important.decisions) {
        const note = repo.addNote({ guild_id: i.guildId, tag: 'decision', content: d.text, why: d.why || null, author_id: i.user.id, source_url: msg.url });
        queueFile(client, repo, i.guildId, note.id);
      }
    } catch (err) {
      await i.editReply({ content: errorText(err), embeds: [], files: [] }).catch(() => {});
    }
  }

  async function askCommand(i) {
    const id = i.options.getInteger('id');
    const question = i.options.getString('question', true);
    const inThread = repo.meetingByThread(i.guildId, i.channelId);
    const meeting = id ? repo.getMeeting(i.guildId, id) : (inThread ?? repo.latestMeeting(i.guildId));
    if (!meeting?.summary) return i.reply({ content: id ? 'There’s no meeting with that number.' : NO_MEETINGS, flags: EPHEMERAL });

    await i.deferReply();
    try {
      const text = await ask(meeting, question, i.user.id, { showWhich: !inThread || inThread.id !== meeting.id });
      await i.editReply({ content: `> ${snippet(question, 200)}\n${text}`, allowedMentions: { parse: [] } });
    } catch (err) {
      await i.editReply(errorText(err)).catch(() => {});
    }
  }

  async function list(i) {
    const meetings = repo.listMeetings(i.guildId, 15);
    if (!meetings.length) return i.reply({ content: NO_MEETINGS, flags: EPHEMERAL });
    const lines = meetings.map((m) => {
      const link = m.message_id ? ` · [open](https://discord.com/channels/${m.guild_id}/${m.channel_id}/${m.message_id})` : '';
      return `🎙️ **#${m.id}** ${snippet(m.title, 70)} · <t:${Math.floor(m.created_at / 1000)}:d>${link}`;
    });
    return i.reply({ content: fitLines(lines, 1900), flags: EPHEMERAL });
  }

  async function notes(i) {
    const meeting = repo.getMeeting(i.guildId, i.options.getInteger('id', true));
    if (!meeting) return i.reply({ content: 'There’s no meeting with that number.', flags: EPHEMERAL });
    return i.reply({
      content: `Full notes for meeting #${meeting.id}: ${snippet(meeting.title, 80)}`,
      files: [new AttachmentBuilder(notesFile(meeting), { name: `meeting-${meeting.id}-notes.txt` })],
      flags: EPHEMERAL,
    });
  }

  return {
    async command(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'list') return list(i);
      if (sub === 'notes') return notes(i);
      if (!ai) return i.reply({ content: AI_OFF, flags: EPHEMERAL });
      if (sub === 'summarize') return summarize(i);
      if (sub === 'ask') return askCommand(i);
    },

    // Talking to the bot: any question in a meeting's thread, or an @mention anywhere.
    async onMessage(msg) {
      if (msg.author?.bot || !msg.guildId) return;
      const mentioned = Boolean(client.user && msg.mentions?.users?.has(client.user.id));
      let meeting = repo.meetingByThread(msg.guildId, msg.channelId);
      if (!meeting && !mentioned) return;

      const question = String(msg.content ?? '').replace(/<@!?\d+>/g, '').trim();
      if (!question) return;
      if (meeting && !mentioned && !looksLikeQuestion(question)) return;
      const quiet = { allowedMentions: { parse: [], repliedUser: false } };
      if (!ai) return msg.reply({ content: AI_OFF, ...quiet });

      let showWhich = false;
      if (!meeting && msg.reference?.messageId) meeting = repo.meetingByMessage(msg.guildId, msg.reference.messageId);
      if (!meeting) {
        meeting = repo.latestMeeting(msg.guildId);
        showWhich = true;
      }
      if (!meeting?.summary) return msg.reply({ content: NO_MEETINGS, ...quiet });

      await msg.channel?.sendTyping?.().catch(() => {});
      try {
        await msg.reply({ content: await ask(meeting, question, msg.author.id, { showWhich }), ...quiet });
      } catch (err) {
        await msg.reply({ content: errorText(err), ...quiet }).catch(() => {});
      }
    },
  };
}
