// Notes go into the notes forum: one post per tag, each note a reply inside it.
import { CHANNEL } from './discord-api.js';
import { button, row } from './interaction.js';
import { tagInfo } from './tags.js';

// How a single note looks, both in the notes forum and in replies.
export function noteEmbed(note) {
  const t = tagInfo(note.tag);
  const lines = [note.content.length > 3500 ? `${note.content.slice(0, 3499)}…` : note.content];

  if (note.why) lines.push('', `**Why:** ${note.why}`);
  if (note.tag === 'todo') {
    const due = note.due ? ` · **Due:** ${note.due}` : '';
    lines.push('', `**Owner:** <@${note.owner_id}>${due}`);
    if (note.done_at) lines.push(`✔︎ Done by <@${note.done_by_id}> <t:${Math.floor(note.done_at / 1000)}:R>`);
  }

  const credit = note.author_id === note.saved_by_id
    ? `<@${note.author_id}>`
    : `<@${note.author_id}> · saved by <@${note.saved_by_id}>`;
  const source = note.source_url ? ` · [original message](${note.source_url})` : '';
  lines.push('', `${credit}${source}`);

  return {
    color: note.done_at ? 0x22c55e : t.color,
    title: `${t.emoji} ${t.label.replace(/s$/, '')} #${note.id}`,
    description: lines.join('\n'),
    timestamp: new Date(note.created_at).toISOString(),
  };
}

// Open action items get a "Mark done" button.
export function noteComponents(note) {
  if (note.tag !== 'todo' || note.done_at) return [];
  return [row(button({ customId: `done:${note.id}`, label: 'Mark done', emoji: '✔️', style: 3 }))];
}

async function openThread(discord, id) {
  if (!id) return null;
  const thread = await discord.getChannel(id).catch(() => null);
  if (!thread?.thread_metadata) return null;
  if (thread.thread_metadata.archived) await discord.unarchive(thread.id).catch(() => {});
  return thread;
}

// The forum post for a tag: the saved one, else one with the right name (so a
// lost setting never creates a duplicate), else a new one.
async function tagThread(discord, repo, forum, tag) {
  const key = `thread:${tag}`;
  const t = tagInfo(tag);
  const name = `${t.emoji} ${t.label}`;

  const saved = await openThread(discord, await repo.getSetting(forum.guild_id, key));
  if (saved && saved.parent_id === forum.id) return saved;

  const active = await discord.activeThreads(forum.guild_id).catch(() => ({ threads: [] }));
  const byName = active.threads?.find((th) => th.parent_id === forum.id && th.name === name);
  const thread = byName ?? await discord.createForumPost(forum.id, {
    name,
    message: { content: `Every note tagged **${t.label}** lands here. Save one with \`/note\` or right-click a message → Apps → **Save as note**.` },
  });
  await repo.setSetting(forum.guild_id, key, thread.id);
  return thread;
}

export async function isForumSetUp(repo, guildId) {
  return Boolean(await repo.getSetting(guildId, 'notes_forum'));
}

async function filedMessageRef(discord, note) {
  if (!note.forum_thread_id || !note.forum_message_id) return null;
  await openThread(discord, note.forum_thread_id);
  return { channelId: note.forum_thread_id, messageId: note.forum_message_id };
}

// Posts the note into its tag's post, removing the old copy if it moved. Holds
// a lock on the note, so two requests at once can't leave duplicates.
export function fileNote(discord, repo, guildId, noteId) {
  return repo.withLock(noteId, async (tx) => {
    const note = await tx.getNote(guildId, noteId);
    if (!note) return false;
    const forumId = await tx.getSetting(guildId, 'notes_forum');
    if (!forumId) return false;
    const forum = await discord.getChannel(forumId).catch(() => null);
    if (forum?.type !== CHANNEL.FORUM) return false;
    forum.guild_id ??= guildId;

    const old = await filedMessageRef(discord, note);
    if (old) await discord.remove(old.channelId, old.messageId).catch(() => {});

    const thread = await tagThread(discord, tx, forum, note.tag);
    const msg = await discord.send(thread.id, { embeds: [noteEmbed(note)], components: noteComponents(note), allowed_mentions: { parse: [] } });
    await tx.setForumRef(note.id, thread.id, msg.id);
    return true;
  });
}

// Updates the forum copy in place (e.g. after an action item is done).
export function refreshFiled(discord, repo, guildId, noteId) {
  return repo.withLock(noteId, async (tx) => {
    const note = await tx.getNote(guildId, noteId);
    const ref = note && await filedMessageRef(discord, note);
    if (ref) await discord.edit(ref.channelId, ref.messageId, { embeds: [noteEmbed(note)], components: noteComponents(note) }).catch(() => {});
  });
}

export async function unfile(discord, note) {
  const ref = await filedMessageRef(discord, note);
  if (ref) await discord.remove(ref.channelId, ref.messageId).catch(() => {});
}
