import {
  ApplicationCommandType,
  ChannelType,
  ContextMenuCommandBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { PICKABLE_TAGS, TAGS, TAG_KEYS } from './tags.js';

const choice = (k) => ({ name: `${TAGS[k].emoji} ${TAGS[k].label}`, value: k });

export const SAVE_AS_NOTE = 'Save as note';

export const commandDefs = [
  new SlashCommandBuilder()
    .setName('note')
    .setDescription('Save a note')
    .addStringOption((o) => o.setName('text').setDescription('What to remember (add #idea, #bug… to tag it)').setRequired(true).setMaxLength(2000))
    .addStringOption((o) => o.setName('tag').setDescription('Which bucket it goes in').addChoices(...PICKABLE_TAGS.map(choice))),

  new ContextMenuCommandBuilder().setName(SAVE_AS_NOTE).setType(ApplicationCommandType.Message),

  new SlashCommandBuilder()
    .setName('decide')
    .setDescription('Log a decision the team made, and why')
    .addStringOption((o) => o.setName('decision').setDescription('What was decided').setRequired(true).setMaxLength(1000))
    .addStringOption((o) => o.setName('why').setDescription('The reason, so future-you remembers').setMaxLength(1000)),

  new SlashCommandBuilder()
    .setName('todo')
    .setDescription('Create an action item for someone')
    .addStringOption((o) => o.setName('task').setDescription('What needs doing').setRequired(true).setMaxLength(1000))
    .addUserOption((o) => o.setName('owner').setDescription('Who owns it (default: you)'))
    .addStringOption((o) => o.setName('due').setDescription('When, e.g. "Friday" or "Nov 20"').setMaxLength(40)),

  new SlashCommandBuilder()
    .setName('todos')
    .setDescription('Show open action items')
    .addUserOption((o) => o.setName('owner').setDescription('Only this person’s items')),

  new SlashCommandBuilder()
    .setName('notes')
    .setDescription('Find notes')
    .addSubcommand((c) => c.setName('search').setDescription('Search every note')
      .addStringOption((o) => o.setName('query').setDescription('Words to look for').setRequired(true)))
    .addSubcommand((c) => c.setName('recent').setDescription('The latest notes'))
    .addSubcommand((c) => c.setName('tag').setDescription('Notes with one tag')
      .addStringOption((o) => o.setName('tag').setDescription('Which tag').setRequired(true).addChoices(...TAG_KEYS.map(choice))))
    .addSubcommand((c) => c.setName('delete').setDescription('Delete a note')
      .addIntegerOption((o) => o.setName('id').setDescription('The note number, e.g. 12').setRequired(true).setMinValue(1))),

  new SlashCommandBuilder()
    .setName('digest')
    .setDescription('Post this week’s round-up of notes, decisions and action items here'),

  new SlashCommandBuilder()
    .setName('meeting')
    .setDescription('Meeting summaries you can ask questions about')
    .addSubcommand((c) => c.setName('summarize').setDescription('Summarize a meeting from a transcript file or this channel')
      .addAttachmentOption((o) => o.setName('file').setDescription('Transcript (.vtt, .srt, .txt or .md) from Zoom, Meet, Teams, Otter…'))
      .addIntegerOption((o) => o.setName('hours').setDescription('Or: summarize the last N hours of messages in this channel').setMinValue(1).setMaxValue(24))
      .addStringOption((o) => o.setName('title').setDescription('Meeting name (optional)').setMaxLength(100)))
    .addSubcommand((c) => c.setName('ask').setDescription('Ask a question about a meeting')
      .addStringOption((o) => o.setName('question').setDescription('What you want to know').setRequired(true).setMaxLength(1000))
      .addIntegerOption((o) => o.setName('id').setDescription('Meeting number (default: this thread’s meeting, or the latest)').setMinValue(1)))
    .addSubcommand((c) => c.setName('list').setDescription('Recent meetings'))
    .addSubcommand((c) => c.setName('notes').setDescription('Get the full numbered notes of a meeting')
      .addIntegerOption((o) => o.setName('id').setDescription('Meeting number').setRequired(true).setMinValue(1))),

  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Create the bot’s channels (or pick existing ones)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName('forum').setDescription('Forum for notes (default: create #notes)').addChannelTypes(ChannelType.GuildForum))
    .addChannelOption((o) => o.setName('meetings_channel').setDescription('Where meeting summaries go (default: create #meeting-notes)').addChannelTypes(ChannelType.GuildText))
    .addChannelOption((o) => o.setName('digest_channel').setDescription('Where the Monday digest goes (default: create #weekly-digest)').addChannelTypes(ChannelType.GuildText)),
].map((c) => c.toJSON());
