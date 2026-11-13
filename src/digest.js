import { TAGS, TAG_KEYS } from './tags.js';
import { snippet, noteUrl, fitLines } from './format.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PER_TAG = 8;

// The weekly round-up: what got noted, decided and finished in the last 7 days,
// plus every action item that's still open. Returns null when there's nothing.
export function buildDigest(repo, guildId, now = Date.now()) {
  const weekAgo = now - WEEK_MS;
  const notes = repo.since(guildId, weekAgo);
  const finished = repo.doneSince(guildId, weekAgo);
  const open = repo.openTodos(guildId, null, 50);
  if (!notes.length && !finished.length && !open.length) return null;

  const lines = [];
  for (const tag of TAG_KEYS) {
    if (tag === 'todo') continue;
    const items = notes.filter((n) => n.tag === tag);
    if (!items.length) continue;
    const t = TAGS[tag];
    lines.push(`**${t.emoji} ${t.label}** (${items.length})`);
    for (const n of items.slice(0, PER_TAG)) {
      const why = tag === 'decision' && n.why ? ` — _${snippet(n.why, 60)}_` : '';
      lines.push(`• ${snippet(n.content, 90)}${why}${link(n)}`);
    }
    if (items.length > PER_TAG) lines.push(`• …and ${items.length - PER_TAG} more`);
    lines.push('');
  }

  if (finished.length) {
    lines.push(`**✔︎ Finished** (${finished.length})`);
    for (const n of finished.slice(0, PER_TAG)) lines.push(`• ~~${snippet(n.content, 80)}~~ <@${n.owner_id}>`);
    if (finished.length > PER_TAG) lines.push(`• …and ${finished.length - PER_TAG} more`);
    lines.push('');
  }

  if (open.length) {
    lines.push(`**📋 Still open** (${open.length})`);
    for (const n of open) {
      const due = n.due ? ` · due ${snippet(n.due, 20)}` : '';
      lines.push(`• <@${n.owner_id}> ${snippet(n.content, 80)}${due}${link(n)}`);
    }
  }

  return {
    title: '🗒️ This week in Mibbit notes',
    description: fitLines(lines),
    count: notes.length,
  };
}

function link(note) {
  const url = noteUrl(note);
  return url ? ` [↗](${url})` : '';
}

// Returns a key for "this week's digest slot" once it's time to send, else null.
// Day 1 = Monday. Keyed by local date, so it sends once per week even across restarts.
export function digestSlot(date, day = 1, hour = 9) {
  if (date.getDay() !== day || date.getHours() < hour) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
