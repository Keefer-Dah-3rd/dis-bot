import { ChannelType } from 'discord.js';

// The channels the bot uses. /setup creates any that are missing, inside a
// "Mibbit Notes" category, so everyone knows where things go.
export const CATEGORY_NAME = 'Mibbit Notes';

export const CHANNELS = {
  notes_forum: {
    name: 'notes',
    label: '📝 Notes',
    type: ChannelType.GuildForum,
    topic: 'Every saved note, sorted into one post per tag. Save with /note, right-click a message → Apps → Save as note, or react 📌.',
  },
  meetings_channel: {
    name: 'meeting-notes',
    label: '🎙️ Meeting notes',
    type: ChannelType.GuildText,
    topic: 'Meeting summaries (⭐ Important · 🔄 Changes · ❓ Open questions). Ask questions about a meeting in its thread. Make one with /meeting summarize.',
  },
  digest_channel: {
    name: 'weekly-digest',
    label: '🗒️ Weekly digest',
    type: ChannelType.GuildText,
    topic: 'The Monday round-up of notes, decisions and action items.',
  },
};

// `chosen` holds channels someone picked in /setup; everything else is reused
// if it already exists, or created.
export async function ensureChannels(guild, repo, chosen = {}) {
  const all = await guild.channels.fetch();
  const find = (pred) => [...all.values()].find((c) => c && pred(c));
  const result = {};
  const created = [];
  let category = null;

  for (const [key, def] of Object.entries(CHANNELS)) {
    if (chosen[key]) {
      result[key] = chosen[key].id;
      repo.setSetting(guild.id, key, chosen[key].id);
      continue;
    }

    const savedId = repo.getSetting(guild.id, key);
    const existing = (savedId && all.get(savedId)) || find((c) => c.name === def.name && c.type === def.type);
    if (existing) {
      result[key] = existing.id;
      repo.setSetting(guild.id, key, existing.id);
      continue;
    }

    category ??= find((c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME)
      ?? await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory });
    const channel = await guild.channels.create({ name: def.name, type: def.type, topic: def.topic, parent: category.id });
    result[key] = channel.id;
    created.push(channel.id);
    repo.setSetting(guild.id, key, channel.id);
  }

  return { ...result, created };
}
