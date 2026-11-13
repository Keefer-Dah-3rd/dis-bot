import {
  ActionRowBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  OAuth2Scopes,
  Partials,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} from 'discord.js';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAi } from './ai.js';
import { commandDefs, SAVE_AS_NOTE } from './commands.js';
import { openDb } from './db.js';
import { buildDigest, digestSlot } from './digest.js';
import { createMeetingHandlers } from './meeting-handlers.js';
import { forumConfigured, noteComponents, noteEmbed, queueFile, queueRefresh, serial, unfile } from './filing.js';
import { fitLines, noteListLine, snippet } from './format.js';
import { CHANNELS, ensureChannels } from './setup.js';
import { PICKABLE_TAGS, TAGS, tagFromText, tagLine } from './tags.js';

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error('\nNo bot token found. Copy .env.example to .env and paste your token after DISCORD_TOKEN= (see README step 4).\n');
  process.exit(1);
}

const DIGEST_DAY = Number(process.env.DIGEST_DAY ?? 1); // 1 = Monday
const DIGEST_HOUR = Number(process.env.DIGEST_HOUR ?? 9); // 24h clock, this computer's timezone
const PIN = '📌';
const EPHEMERAL = MessageFlags.Ephemeral;

const repo = openDb(process.env.DB_PATH ?? fileURLToPath(new URL('../data/notes.db', import.meta.url)));
const ai = createAi(); // null unless ANTHROPIC_API_KEY is set in .env

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

const meetings = createMeetingHandlers({ client, repo, ai });

// ---------- helpers ----------

const SETUP_HINT = '\n-# Notes aren’t being filed anywhere yet — an admin can run `/setup` to create the channels.';

function savedReply(note) {
  return `Saved as **${tagLine(note.tag)} #${note.id}**.${forumConfigured(repo, note.guild_id) ? '' : SETUP_HINT}`;
}

function tagPicker(note) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`retag:${note.id}`)
      .setPlaceholder('Change tag…')
      .addOptions(PICKABLE_TAGS.map((k) => ({ label: TAGS[k].label, value: k, emoji: { name: TAGS[k].emoji }, default: k === note.tag }))),
  );
}

// The text worth keeping from a Discord message, including attachments.
function messageText(msg) {
  const parts = [];
  if (msg.content?.trim()) parts.push(msg.content.trim());
  else if (msg.embeds?.[0]?.description) parts.push(msg.embeds[0].description);
  for (const a of msg.attachments?.values() ?? []) parts.push(`📎 [${a.name}](${a.url})`);
  return parts.join('\n');
}

function listEmbed(title, notes, empty) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(notes.length ? fitLines(notes.map((n) => noteListLine(n))) : empty);
}

function digestEmbed(digest) {
  return new EmbedBuilder().setColor(0x5865f2).setTitle(digest.title).setDescription(digest.description).setTimestamp();
}

async function completeTodo(guildId, noteId, userId) {
  const changed = repo.markDone(noteId, userId);
  return { changed, note: repo.getNote(guildId, noteId) };
}

// ---------- slash commands ----------

const handlers = {
  async note(i) {
    const text = i.options.getString('text', true);
    const note = repo.addNote({
      guild_id: i.guildId,
      tag: i.options.getString('tag') ?? tagFromText(text) ?? 'general',
      content: text,
      author_id: i.user.id,
    });
    await i.reply({ content: savedReply(note), components: [tagPicker(note)], flags: EPHEMERAL });
    queueFile(client, repo, i.guildId, note.id);
  },

  async decide(i) {
    const note = repo.addNote({
      guild_id: i.guildId,
      tag: 'decision',
      content: i.options.getString('decision', true),
      why: i.options.getString('why'),
      author_id: i.user.id,
    });
    await i.reply({ content: 'Decision logged.', embeds: [noteEmbed(note)], allowedMentions: { parse: [] } });
    queueFile(client, repo, i.guildId, note.id);
  },

  async todo(i) {
    const owner = i.options.getUser('owner') ?? i.user;
    const note = repo.addNote({
      guild_id: i.guildId,
      tag: 'todo',
      content: i.options.getString('task', true),
      owner_id: owner.id,
      due: i.options.getString('due'),
      author_id: i.user.id,
    });
    await i.reply({
      content: `<@${owner.id}>, new action item for you.`,
      embeds: [noteEmbed(note)],
      components: noteComponents(note),
      allowedMentions: { users: [owner.id] },
    });
    queueFile(client, repo, i.guildId, note.id);
  },

  async todos(i) {
    const owner = i.options.getUser('owner');
    const open = repo.openTodos(i.guildId, owner?.id ?? null, 25);
    if (!open.length) {
      return i.reply({ content: owner ? `<@${owner.id}> has no open action items 🎉` : 'No open action items 🎉', flags: EPHEMERAL, allowedMentions: { parse: [] } });
    }
    const lines = open.map((n) => `📋 **#${n.id}** <@${n.owner_id}> ${snippet(n.content, 70)}${n.due ? ` · due ${n.due}` : ''}`);
    const picker = new StringSelectMenuBuilder()
      .setCustomId('done-select')
      .setPlaceholder('Mark one done…')
      .addOptions(open.map((n) => ({ label: snippet(`#${n.id} ${n.content}`, 100), value: String(n.id) })));
    await i.reply({
      embeds: [new EmbedBuilder().setColor(TAGS.todo.color).setTitle(`📋 Open action items (${open.length})`).setDescription(fitLines(lines))],
      components: [new ActionRowBuilder().addComponents(picker)],
      flags: EPHEMERAL,
    });
  },

  async notes(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'search') {
      const query = i.options.getString('query', true);
      const found = repo.search(i.guildId, query);
      return i.reply({ embeds: [listEmbed(`🔎 “${snippet(query, 60)}”`, found, 'Nothing matched. Try fewer or different words.')], flags: EPHEMERAL });
    }
    if (sub === 'recent') {
      return i.reply({ embeds: [listEmbed('🕘 Latest notes', repo.recent(i.guildId), 'No notes yet. Try `/note`!')], flags: EPHEMERAL });
    }
    if (sub === 'tag') {
      const tag = i.options.getString('tag', true);
      return i.reply({ embeds: [listEmbed(tagLine(tag), repo.byTag(i.guildId, tag), 'No notes with this tag yet.')], flags: EPHEMERAL });
    }
    if (sub === 'delete') {
      const note = repo.getNote(i.guildId, i.options.getInteger('id', true));
      if (!note) return i.reply({ content: 'There’s no note with that number.', flags: EPHEMERAL });
      const mine = [note.author_id, note.saved_by_id].includes(i.user.id);
      if (!mine && !i.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
        return i.reply({ content: 'Only the person who wrote or saved this note (or a moderator) can delete it.', flags: EPHEMERAL });
      }
      await serial(note.id, async () => {
        await unfile(client, repo.getNote(i.guildId, note.id) ?? note);
        repo.deleteNote(note.id);
      });
      return i.reply({ content: `Deleted note #${note.id}.`, flags: EPHEMERAL });
    }
  },

  async digest(i) {
    const digest = buildDigest(repo, i.guildId);
    if (!digest) return i.reply({ content: 'Nothing from the last 7 days yet.', flags: EPHEMERAL });
    await i.reply({ embeds: [digestEmbed(digest)], allowedMentions: { parse: [] } });
  },

  meeting: (i) => meetings.command(i),

  async setup(i) {
    await i.deferReply({ flags: EPHEMERAL });
    let channels;
    try {
      channels = await ensureChannels(i.guild, repo, {
        notes_forum: i.options.getChannel('forum'),
        meetings_channel: i.options.getChannel('meetings_channel'),
        digest_channel: i.options.getChannel('digest_channel'),
      });
    } catch (err) {
      if (err?.code === 50013) {
        return i.editReply('I need the **Manage Channels** permission to create channels. Re-add me with the invite link from the terminal, or create the channels yourself and pick them in `/setup`.');
      }
      throw err;
    }
    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][DIGEST_DAY] ?? 'Monday';
    const when = { notes_forum: 'one post per tag', meetings_channel: 'every `/meeting summarize` posts here', digest_channel: `every ${day} at ${DIGEST_HOUR}:00` };
    const lines = Object.entries(CHANNELS).map(([key, def]) =>
      `${def.label} → <#${channels[key]}> (${when[key]})${channels.created.includes(channels[key]) ? ' · *new*' : ''}`);
    await i.editReply(`All set.\n${lines.join('\n')}`);
  },
};

async function saveMessageAsNote(i) {
  const msg = i.targetMessage;
  const existing = repo.findBySource(i.guildId, msg.url);
  if (existing) {
    return i.reply({ content: `Already saved as **${tagLine(existing.tag)} #${existing.id}**.`, components: [tagPicker(existing)], flags: EPHEMERAL });
  }
  const text = messageText(msg);
  if (!text) return i.reply({ content: 'That message has nothing to save.', flags: EPHEMERAL });
  const note = repo.addNote({
    guild_id: i.guildId,
    tag: tagFromText(text) ?? 'general',
    content: text,
    author_id: msg.author.id,
    saved_by_id: i.user.id,
    source_url: msg.url,
  });
  await i.reply({ content: savedReply(note), components: [tagPicker(note)], flags: EPHEMERAL });
  queueFile(client, repo, i.guildId, note.id);
}

// ---------- buttons and menus ----------

async function handleComponent(i) {
  const [kind, rawId] = i.customId.split(':');

  if (kind === 'retag') {
    const note = repo.getNote(i.guildId, Number(rawId));
    if (!note) return i.update({ content: 'That note was deleted.', components: [] });
    const tag = i.values[0];
    repo.setTag(note.id, tag);
    const updated = repo.getNote(i.guildId, note.id);
    await i.update({ content: `Moved to **${tagLine(tag)} #${note.id}**.`, components: [tagPicker(updated)] });
    queueFile(client, repo, i.guildId, note.id);
    return;
  }

  if (kind === 'done' || kind === 'done-select') {
    const id = Number(kind === 'done' ? rawId : i.values[0]);
    const { changed, note } = await completeTodo(i.guildId, id, i.user.id);
    if (!note) return i.reply({ content: 'That action item was deleted.', flags: EPHEMERAL });

    if (kind === 'done') {
      // Update the message the button was on, then the forum copy if that was somewhere else.
      await i.update({ embeds: [noteEmbed(note)], components: noteComponents(note) });
    } else {
      await i.reply({ content: changed ? `Marked **#${id}** done ✔︎` : `**#${id}** was already done.`, flags: EPHEMERAL });
    }
    if (changed && i.message?.id !== note.forum_message_id) queueRefresh(client, repo, i.guildId, id);
  }
}

// ---------- events ----------

client.on(Events.InteractionCreate, async (i) => {
  if (!i.inGuild()) return;
  try {
    if (i.isChatInputCommand()) await handlers[i.commandName]?.(i);
    else if (i.isMessageContextMenuCommand() && i.commandName === SAVE_AS_NOTE) await saveMessageAsNote(i);
    else if (i.isButton() || i.isStringSelectMenu()) await handleComponent(i);
  } catch (err) {
    console.error(err);
    const payload = { content: 'Something went wrong. The details are in the bot’s terminal window.', flags: EPHEMERAL };
    if (i.isRepliable()) await (i.replied || i.deferred ? i.followUp(payload) : i.reply(payload)).catch(() => {});
  }
});

// Questions about meetings: in a meeting's thread, or by @mentioning the bot.
client.on(Events.MessageCreate, (msg) => meetings.onMessage(msg).catch((err) => console.error(err)));

// React 📌 to any message to save it.
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.emoji.name !== PIN) return;
    const msg = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (!msg.guildId || repo.findBySource(msg.guildId, msg.url)) return;
    const text = messageText(msg);
    if (!text) return;
    const note = repo.addNote({
      guild_id: msg.guildId,
      tag: tagFromText(text) ?? 'general',
      content: text,
      author_id: msg.author.id,
      saved_by_id: user.id,
      source_url: msg.url,
    });
    await msg.react('✅').catch(() => {});
    queueFile(client, repo, msg.guildId, note.id);
  } catch (err) {
    console.error('Couldn’t save pinned message:', err.message);
  }
});

// Only re-sends the command list to Discord when it has changed.
const COMMANDS_HASH = createHash('sha256').update(JSON.stringify(commandDefs)).digest('hex').slice(0, 16);
async function registerCommands(guild) {
  if (repo.getSetting(guild.id, 'commands_hash') !== COMMANDS_HASH) {
    await guild.commands.set(commandDefs);
    repo.setSetting(guild.id, 'commands_hash', COMMANDS_HASH);
  }
  console.log(`Commands ready in “${guild.name}”.`);
}

client.on(Events.GuildCreate, (guild) => registerCommands(guild).catch((err) => console.error(err.message)));

client.once(Events.ClientReady, async () => {
  console.log(`\nLogged in as ${client.user.tag}.`);
  console.log(ai ? `Meeting AI: on (${ai.model}).` : 'Meeting AI: off (no ANTHROPIC_API_KEY in .env).');
  const invite = client.generateInvite({
    scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
    permissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.ManageThreads,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AddReactions,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ManageChannels,
    ],
  });
  if (client.guilds.cache.size === 0) {
    console.log(`\nThe bot isn’t in a server yet. Open this link to add it to the Mibbit server:\n\n  ${invite}\n`);
  } else {
    console.log(`Invite link (if you ever need it again): ${invite}`);
  }
  for (const guild of client.guilds.cache.values()) await registerCommands(guild).catch((err) => console.error(err.message));

  setInterval(postDigests, 10 * 60 * 1000);
  postDigests();
});

// The Monday digest. Checks every 10 minutes and sends once per week.
async function postDigests() {
  const slot = digestSlot(new Date(), DIGEST_DAY, DIGEST_HOUR);
  if (!slot) return;
  for (const guild of client.guilds.cache.values()) {
    try {
      const channelId = repo.getSetting(guild.id, 'digest_channel');
      if (!channelId || repo.getSetting(guild.id, 'last_digest') === slot) continue;
      repo.setSetting(guild.id, 'last_digest', slot);
      const digest = buildDigest(repo, guild.id);
      if (!digest) continue;
      const channel = await client.channels.fetch(channelId);
      await channel.send({ embeds: [digestEmbed(digest)], allowedMentions: { parse: [] } });
    } catch (err) {
      console.error(`Couldn’t post the digest in “${guild.name}”:`, err.message);
    }
  }
}

process.on('unhandledRejection', (err) => console.error('Unhandled error:', err));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nShutting down.');
    client.destroy();
    repo.close();
    process.exit(0);
  });
}

client.login(token).catch((err) => {
  if (/disallowed intents/i.test(err.message)) {
    console.error('\nDiscord refused to connect: turn on “Message Content Intent” in the Developer Portal (Bot page), then run again. See README step 2.\n');
  } else if (/token/i.test(err.message)) {
    console.error('\nDiscord didn’t accept the token. Reset it in the Developer Portal (Bot page) and paste the new one into .env.\n');
  } else {
    console.error(err);
  }
  process.exit(1);
});
