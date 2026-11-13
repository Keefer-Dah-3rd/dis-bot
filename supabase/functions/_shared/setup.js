// /setup: the bot's channels, and the timers that wake it.
import { CHANNEL } from './discord-api.js';
import { utcTimesFor } from './digest.js';

export const CATEGORY_NAME = 'Mibbit Notes';

export const CHANNELS = {
  notes_forum: {
    name: 'notes',
    label: '📝 Notes',
    type: CHANNEL.FORUM,
    topic: 'Every saved note, sorted into one post per tag. Save with /note or right-click a message → Apps → Save as note.',
  },
  meetings_channel: {
    name: 'meeting-notes',
    label: '🎙️ Meeting notes',
    type: CHANNEL.TEXT,
    topic: 'Meeting summaries (⭐ Important · 🔄 Changes · ❓ Open questions). Press "Ask a question" on a summary to ask about it.',
  },
  digest_channel: {
    name: 'weekly-digest',
    label: '🗒️ Weekly digest',
    type: CHANNEL.TEXT,
    topic: 'The Monday round-up of notes, decisions and action items.',
  },
};

// `chosen` holds channels someone picked in /setup; everything else is reused
// if it exists (saved, or by name), or created inside a "Mibbit Notes" category.
export async function ensureChannels(discord, repo, guildId, chosen = {}) {
  const all = await discord.guildChannels(guildId);
  const byId = new Map(all.map((c) => [c.id, c]));
  const find = (pred) => all.find(pred);
  const result = {};
  const created = [];
  let category = null;

  for (const [key, def] of Object.entries(CHANNELS)) {
    if (chosen[key]) {
      result[key] = chosen[key].id;
      await repo.setSetting(guildId, key, chosen[key].id);
      continue;
    }
    const savedId = await repo.getSetting(guildId, key);
    const existing = (savedId && byId.get(savedId)) || find((c) => c.name === def.name && c.type === def.type);
    if (existing) {
      result[key] = existing.id;
      await repo.setSetting(guildId, key, existing.id);
      continue;
    }
    category ??= find((c) => c.type === CHANNEL.CATEGORY && c.name === CATEGORY_NAME)
      ?? await discord.createChannel(guildId, { name: CATEGORY_NAME, type: CHANNEL.CATEGORY });
    const channel = await discord.createChannel(guildId, { name: def.name, type: def.type, topic: def.topic, parent_id: category.id });
    all.push(channel);
    result[key] = channel.id;
    created.push(channel.id);
    await repo.setSetting(guildId, key, channel.id);
  }
  return { ...result, created };
}

// The cron schedules Supabase uses to call the bot:
//  - Monday, at the digest hour on the team's clock (both daylight-saving variants)
//  - once a day, a tiny check-in so the free database isn't paused for inactivity
export function timerSchedules({ day = 1, hour = 9, timeZone }) {
  const byDay = new Map();
  for (const t of utcTimesFor(day, hour, timeZone)) byDay.set(t.day, [...(byDay.get(t.day) ?? []), t.hour]);
  const digest = [...byDay].map(([d, hours]) => `0 ${hours.join(',')} * * ${d}`);
  return { digest, checkIn: '17 12 * * *' };
}

// Creates (or updates) the schedules in Supabase's pg_cron. The bot's address
// and secret live only in the database, never in the code.
export async function scheduleTimers(db, { url, secret, day, hour, timeZone }) {
  const { digest, checkIn } = timerSchedules({ day, hour, timeZone });
  const call = "select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', %L), body := '{}'::jsonb, timeout_milliseconds := 60000)";
  const jobs = [...digest.map((s, n) => [`mibbit-notes-digest-${n}`, s]), ['mibbit-notes-check-in', checkIn]];
  // Remove old digest timers (the hours change if the digest time changes).
  await db.query("select cron.unschedule(jobname) from cron.job where jobname like 'mibbit-notes-digest-%'");
  for (const [name, schedule] of jobs) {
    await db.query('select cron.schedule($1, $2, format($3, $4::text, $5::text))', [name, schedule, call, url, secret]);
  }
  return jobs.map(([name, schedule]) => ({ name, schedule }));
}
