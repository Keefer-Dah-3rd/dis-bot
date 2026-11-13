// Saving and finding notes, decisions, action items, the digest and /setup.
import { buildDigest } from './digest.js';
import { DiscordError, messageUrl } from './discord-api.js';
import { fileNote, isForumSetUp, noteComponents, noteEmbed, refreshFiled, unfile } from './filing.js';
import { fitLines, noteListLine, snippet } from './format.js';
import { defer, PERMISSION, reply, row, select, update } from './interaction.js';
import { CHANNELS, ensureChannels } from './setup.js';
import { PICKABLE_TAGS, TAGS, tagFromText, tagLine } from './tags.js';
import { SAVE_AS_NOTE } from './commands.js';

const EPH = { ephemeral: true };
const SETUP_HINT = '\n-# Notes aren’t being filed anywhere yet. An admin can run `/setup` to create the channels.';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function tagPicker(note) {
  return row(select({
    customId: `retag:${note.id}`,
    placeholder: 'Change tag…',
    options: PICKABLE_TAGS.map((k) => ({ label: TAGS[k].label, value: k, emoji: { name: TAGS[k].emoji }, default: k === note.tag })),
  }));
}

// The text worth keeping from a Discord message, including attachments.
export function messageText(msg) {
  const parts = [];
  if (msg.content?.trim()) parts.push(msg.content.trim());
  else if (msg.embeds?.[0]?.description) parts.push(msg.embeds[0].description);
  for (const a of msg.attachments ?? []) parts.push(`📎 [${a.filename}](${a.url})`);
  return parts.join('\n');
}

export const digestEmbed = (d) => ({ color: 0x5865f2, title: d.title, description: d.description, timestamp: new Date().toISOString() });

const listEmbed = (title, notes, empty) => ({
  color: 0x5865f2,
  title,
  description: notes.length ? fitLines(notes.map((n) => noteListLine(n))) : empty,
});

export function digestSettings(env) {
  return {
    day: Number(env.DIGEST_DAY ?? 1),
    hour: Number(env.DIGEST_HOUR ?? 9),
    timeZone: env.DIGEST_TZ || 'America/New_York',
  };
}

export function createNotesHandlers({ repo, discord, env = {}, schedule }) {
  const file = (guildId, id) => () => fileNote(discord, repo, guildId, id);
  const refresh = (guildId, id) => () => refreshFiled(discord, repo, guildId, id);
  const savedReply = async (note) =>
    `Saved as **${tagLine(note.tag)} #${note.id}**.${await isForumSetUp(repo, note.guild_id) ? '' : SETUP_HINT}`;

  const commands = {
    async note(c) {
      const text = c.opt('text');
      const note = await repo.addNote({
        guild_id: c.guildId, tag: c.opt('tag') ?? tagFromText(text) ?? 'general', content: text, author_id: c.userId,
      });
      return { ...reply({ content: await savedReply(note), components: [tagPicker(note)] }, EPH), after: file(c.guildId, note.id) };
    },

    async [SAVE_AS_NOTE](c) {
      const msg = c.targetMessage;
      const url = messageUrl(c.guildId, msg.channel_id, msg.id);
      const existing = await repo.findBySource(c.guildId, url);
      if (existing) {
        return reply({ content: `Already saved as **${tagLine(existing.tag)} #${existing.id}**.`, components: [tagPicker(existing)] }, EPH);
      }
      const text = messageText(msg);
      if (!text) return reply({ content: 'That message has nothing to save.' }, EPH);
      const note = await repo.addNote({
        guild_id: c.guildId, tag: tagFromText(text) ?? 'general', content: text,
        author_id: msg.author.id, saved_by_id: c.userId, source_url: url,
      });
      return { ...reply({ content: await savedReply(note), components: [tagPicker(note)] }, EPH), after: file(c.guildId, note.id) };
    },

    async decide(c) {
      const note = await repo.addNote({
        guild_id: c.guildId, tag: 'decision', content: c.opt('decision'), why: c.opt('why'), author_id: c.userId,
      });
      return { ...reply({ content: 'Decision logged.', embeds: [noteEmbed(note)] }), after: file(c.guildId, note.id) };
    },

    async todo(c) {
      const owner = c.optUser('owner') ?? c.user;
      const note = await repo.addNote({
        guild_id: c.guildId, tag: 'todo', content: c.opt('task'), owner_id: owner.id, due: c.opt('due'), author_id: c.userId,
      });
      return {
        ...reply({
          content: `<@${owner.id}>, new action item for you.`,
          embeds: [noteEmbed(note)],
          components: noteComponents(note),
          allowed_mentions: { users: [owner.id] },
        }),
        after: file(c.guildId, note.id),
      };
    },

    async todos(c) {
      const owner = c.optUser('owner');
      const open = await repo.openTodos(c.guildId, owner?.id ?? null, 25);
      if (!open.length) return reply({ content: owner ? `<@${owner.id}> has no open action items 🎉` : 'No open action items 🎉' }, EPH);
      const lines = open.map((n) => `📋 **#${n.id}** <@${n.owner_id}> ${snippet(n.content, 70)}${n.due ? ` · due ${n.due}` : ''}`);
      return reply({
        embeds: [{ color: TAGS.todo.color, title: `📋 Open action items (${open.length})`, description: fitLines(lines) }],
        components: [row(select({
          customId: 'done-select',
          placeholder: 'Mark one done…',
          options: open.map((n) => ({ label: snippet(`#${n.id} ${n.content}`, 100), value: String(n.id) })),
        }))],
      }, EPH);
    },

    async notes(c) {
      if (c.sub === 'search') {
        const query = c.opt('query');
        return reply({ embeds: [listEmbed(`🔎 “${snippet(query, 60)}”`, await repo.search(c.guildId, query), 'Nothing matched. Try fewer or different words.')] }, EPH);
      }
      if (c.sub === 'recent') return reply({ embeds: [listEmbed('🕘 Latest notes', await repo.recent(c.guildId), 'No notes yet. Try `/note`!')] }, EPH);
      if (c.sub === 'tag') {
        const tag = c.opt('tag');
        return reply({ embeds: [listEmbed(tagLine(tag), await repo.byTag(c.guildId, tag), 'No notes with this tag yet.')] }, EPH);
      }
      if (c.sub === 'delete') {
        const note = await repo.getNote(c.guildId, c.opt('id'));
        if (!note) return reply({ content: 'There’s no note with that number.' }, EPH);
        const mine = [note.author_id, note.saved_by_id].includes(c.userId);
        if (!mine && !(c.permissions & PERMISSION.MANAGE_MESSAGES)) {
          return reply({ content: 'Only the person who wrote or saved this note (or a moderator) can delete it.' }, EPH);
        }
        await repo.deleteNote(note.id);
        return { ...reply({ content: `Deleted note #${note.id}.` }, EPH), after: () => unfile(discord, note) };
      }
      return null;
    },

    async digest(c) {
      const d = await buildDigest(repo, c.guildId);
      if (!d) return reply({ content: 'Nothing from the last 7 days yet.' }, EPH);
      return reply({ embeds: [digestEmbed(d)] });
    },

    async setup(c) {
      return defer(async () => {
        let channels;
        try {
          channels = await ensureChannels(discord, repo, c.guildId, {
            notes_forum: c.optChannel('forum'),
            meetings_channel: c.optChannel('meetings_channel'),
            digest_channel: c.optChannel('digest_channel'),
          });
        } catch (err) {
          if (err instanceof DiscordError && err.code === 50013) {
            return { content: 'I need the **Manage Channels** permission to create channels. Create them yourself and pick them in `/setup`, or give me that permission.' };
          }
          throw err;
        }
        const { day, hour, timeZone } = digestSettings(env);
        let timers = '';
        if (schedule && env.CRON_SECRET && env.SUPABASE_URL) {
          await schedule({ url: `${env.SUPABASE_URL}/functions/v1/discord-bot/cron`, secret: env.CRON_SECRET, day, hour, timeZone });
          timers = `\n⏰ Timer set: digest every ${DAYS[day] ?? 'Monday'} at ${hour}:00 (${timeZone}).`;
        }
        const when = { notes_forum: 'one post per tag', meetings_channel: 'every `/meeting summarize` posts here', digest_channel: `every ${DAYS[day] ?? 'Monday'} at ${hour}:00` };
        const lines = Object.entries(CHANNELS).map(([key, def]) =>
          `${def.label} → <#${channels[key]}> (${when[key]})${channels.created.includes(channels[key]) ? ' · *new*' : ''}`);
        return { content: `All set.\n${lines.join('\n')}${timers}` };
      }, EPH);
    },
  };

  const components = {
    async retag(c, id) {
      const note = await repo.getNote(c.guildId, Number(id));
      if (!note) return update({ content: 'That note was deleted.', components: [] });
      const tag = c.selected[0];
      await repo.setTag(note.id, tag);
      return {
        ...update({ content: `Moved to **${tagLine(tag)} #${note.id}**.`, components: [tagPicker({ ...note, tag })] }),
        after: file(c.guildId, note.id),
      };
    },

    // The "Mark done" button, on the /todo reply or in the notes forum.
    async done(c, id) {
      const noteId = Number(id);
      const changed = await repo.markDone(noteId, c.userId);
      const note = await repo.getNote(c.guildId, noteId);
      if (!note) return reply({ content: 'That action item was deleted.' }, EPH);
      const result = update({ embeds: [noteEmbed(note)], components: noteComponents(note) });
      if (changed && c.message?.id !== note.forum_message_id) result.after = refresh(c.guildId, noteId);
      return result;
    },

    // The "Mark one done…" menu under /todos.
    async 'done-select'(c) {
      const noteId = Number(c.selected[0]);
      const changed = await repo.markDone(noteId, c.userId);
      const note = await repo.getNote(c.guildId, noteId);
      if (!note) return reply({ content: 'That action item was deleted.' }, EPH);
      return {
        ...reply({ content: changed ? `Marked **#${noteId}** done ✔︎` : `**#${noteId}** was already done.` }, EPH),
        ...(changed ? { after: refresh(c.guildId, noteId) } : {}),
      };
    },
  };

  return { commands, components };
}
