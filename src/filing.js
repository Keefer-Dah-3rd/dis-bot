import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder } from 'discord.js';
import { tagInfo } from './tags.js';

// How a single note looks, both in the notes forum and in replies.
export function noteEmbed(note) {
  const t = tagInfo(note.tag);
  const lines = [note.content.length > 3500 ? `${note.content.slice(0, 3499)}…` : note.content];

  if (note.why) lines.push('', `**Why:** ${note.why}`);
  if (note.tag === 'todo') {
    const due = note.due ? ` · **Due:** ${note.due}` : '';
    lines.push('', `**Owner:** <@${note.owner_id}>${due}`);
    if (note.done_at) {
      lines.push(`✔︎ Done by <@${note.done_by_id}> <t:${Math.floor(note.done_at / 1000)}:R>`);
    }
  }

  const credit = note.author_id === note.saved_by_id
    ? `<@${note.author_id}>`
    : `<@${note.author_id}> · saved by <@${note.saved_by_id}>`;
  const source = note.source_url ? ` · [original message](${note.source_url})` : '';
  lines.push('', `${credit}${source}`);

  return new EmbedBuilder()
    .setColor(note.done_at ? 0x22c55e : t.color)
    .setTitle(`${t.emoji} ${t.label.replace(/s$/, '')} #${note.id}`)
    .setDescription(lines.join('\n'))
    .setTimestamp(note.created_at);
}

// Open action items get a "Mark done" button.
export function noteComponents(note) {
  if (note.tag !== 'todo' || note.done_at) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`done:${note.id}`).setLabel('Mark done').setEmoji('✔️').setStyle(ButtonStyle.Success),
    ),
  ];
}

async function openThread(client, id) {
  if (!id) return null;
  const thread = await client.channels.fetch(id).catch(() => null);
  if (!thread?.isThread?.()) return null;
  if (thread.archived) await thread.setArchived(false).catch(() => {});
  return thread;
}

// Each tag has one post in the notes forum; notes are replies inside it.
async function tagThread(client, repo, forum, guildId, tag) {
  const key = `thread:${tag}`;
  const existing = await openThread(client, repo.getSetting(guildId, key));
  if (existing && existing.parentId === forum.id) return existing;

  const t = tagInfo(tag);
  const thread = await forum.threads.create({
    name: `${t.emoji} ${t.label}`,
    message: { content: `Every note tagged **${t.label}** lands here. Save one with \`/note\`, right-click a message → Apps → **Save as note**, or react 📌.` },
  });
  repo.setSetting(guildId, key, thread.id);
  return thread;
}

async function filedMessage(client, note) {
  const thread = await openThread(client, note.forum_thread_id);
  if (!thread || !note.forum_message_id) return null;
  return thread.messages.fetch(note.forum_message_id).catch(() => null);
}

export function forumConfigured(repo, guildId) {
  return Boolean(repo.getSetting(guildId, 'notes_forum'));
}

// Posts the note into its tag's post, removing it from wherever it was before.
export async function fileNote(client, repo, note) {
  const forumId = repo.getSetting(note.guild_id, 'notes_forum');
  if (!forumId) return false;
  const forum = await client.channels.fetch(forumId).catch(() => null);
  if (!forum || forum.type !== ChannelType.GuildForum) return false;

  const old = await filedMessage(client, note);
  if (old) await old.delete().catch(() => {});

  const thread = await tagThread(client, repo, forum, note.guild_id, note.tag);
  const msg = await thread.send({
    embeds: [noteEmbed(note)],
    components: noteComponents(note),
    allowedMentions: { parse: [] },
  });
  repo.setForumRef(note.id, thread.id, msg.id);
  return true;
}

// Updates the forum copy in place (e.g. after an action item is done).
export async function refreshFiled(client, note) {
  const msg = await filedMessage(client, note);
  if (msg) await msg.edit({ embeds: [noteEmbed(note)], components: noteComponents(note) }).catch(() => {});
}

export async function unfile(client, note) {
  const msg = await filedMessage(client, note);
  if (msg) await msg.delete().catch(() => {});
}

// Forum work for one note runs one step at a time, so changing a tag twice
// quickly can't leave duplicate copies behind.
const chains = new Map();
export function serial(key, task) {
  const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
  chains.set(key, next);
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => {});
  return next;
}

export function queueFile(client, repo, guildId, noteId) {
  return serial(noteId, async () => {
    const note = repo.getNote(guildId, noteId);
    if (note) await fileNote(client, repo, note);
  }).catch((err) => console.error(`Couldn't file note #${noteId}:`, err.message));
}

export function queueRefresh(client, repo, guildId, noteId) {
  return serial(noteId, async () => {
    const note = repo.getNote(guildId, noteId);
    if (note) await refreshFiled(client, note);
  }).catch((err) => console.error(`Couldn't update note #${noteId}:`, err.message));
}
