import { tagInfo } from './tags.js';

// One line of text, cut to `max` characters.
export function snippet(text = '', max = 90) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Where a note can be opened: its post in the notes forum, else the original message.
export function noteUrl(note) {
  if (note.forum_thread_id && note.forum_message_id) {
    return `https://discord.com/channels/${note.guild_id}/${note.forum_thread_id}/${note.forum_message_id}`;
  }
  return note.source_url ?? null;
}

export function noteListLine(note, max = 80) {
  const url = noteUrl(note);
  const link = url ? ` · [open](${url})` : '';
  const done = note.done_at ? ' ✔︎' : '';
  return `${tagInfo(note.tag).emoji} **#${note.id}** ${snippet(note.content, max)}${done}${link}`;
}

// Keeps a list under Discord's embed limit, saying how many were left out.
export function fitLines(lines, limit = 4000) {
  const out = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const cost = lines[i].length + 1;
    if (used + cost > limit - 40) {
      out.push(`…and ${lines.length - i} more`);
      break;
    }
    out.push(lines[i]);
    used += cost;
  }
  return out.join('\n');
}
