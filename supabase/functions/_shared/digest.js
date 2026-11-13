import { TAGS, TAG_KEYS } from './tags.js';
import { snippet, noteUrl, fitLines } from './format.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PER_TAG = 8;

// The weekly round-up: what got noted, decided and finished in the last 7 days,
// plus every action item that's still open. Returns null when there's nothing.
export async function buildDigest(repo, guildId, now = Date.now()) {
  const weekAgo = now - WEEK_MS;
  const [notes, finished, open] = await Promise.all([
    repo.since(guildId, weekAgo), repo.doneSince(guildId, weekAgo), repo.openTodos(guildId, null, 50),
  ]);
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

// Day, date and hour of `date` on the team's clock (e.g. "America/New_York").
// Without a timezone, uses this computer's.
export function localTime(date, timeZone) {
  if (!timeZone) {
    const pad = (n) => String(n).padStart(2, '0');
    return { weekday: date.getDay(), hour: date.getHours(), ymd: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` };
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    hour: Number(parts.hour),
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

// Returns a key for "this week's digest slot" once it's time to send, else null.
// Day 1 = Monday. Keyed by the local date, so it sends once per week.
export function digestSlot(date, day = 1, hour = 9, timeZone) {
  const t = localTime(date, timeZone);
  if (t.weekday !== day || t.hour < hour) return null;
  return t.ymd;
}

// The UTC hours (and days) when it's `day` at `hour` on the team's clock, across
// a whole year, so daylight saving is covered. Becomes the Monday timer.
export function utcTimesFor(day, hour, timeZone, from = new Date()) {
  const found = new Set();
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  for (let h = 0; h < 366 * 24; h++) {
    const at = new Date(start + h * 3_600_000);
    const t = localTime(at, timeZone);
    if (t.weekday === day && t.hour === hour) found.add(`${at.getUTCDay()}:${at.getUTCHours()}`);
  }
  return [...found].map((k) => k.split(':').map(Number)).map(([d, hr]) => ({ day: d, hour: hr }))
    .sort((a, b) => a.day - b.day || a.hour - b.hour);
}
