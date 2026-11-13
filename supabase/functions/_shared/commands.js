// The slash commands and right-click menu, in the format Discord expects.
// After changing these, run `npm run register-commands`.
import { PICKABLE_TAGS, TAGS, TAG_KEYS } from './tags.js';

const OPTION = { SUB: 1, STRING: 3, INTEGER: 4, USER: 6, CHANNEL: 7, ATTACHMENT: 11 };
const CHANNEL_TYPE = { TEXT: 0, FORUM: 15 };
const GUILD_ONLY = { contexts: [0], integration_types: [0] };

const choice = (k) => ({ name: `${TAGS[k].emoji} ${TAGS[k].label}`, value: k });
const opt = (type, name, description, extra = {}) => ({ type, name, description, ...extra });
const sub = (name, description, options = []) => ({ type: OPTION.SUB, name, description, options });
const slash = (name, description, options = [], extra = {}) => ({ type: 1, name, description, options, ...GUILD_ONLY, ...extra });

export const SAVE_AS_NOTE = 'Save as note';

export const commandDefs = [
  slash('note', 'Save a note', [
    opt(OPTION.STRING, 'text', 'What to remember (add #idea, #bug… to tag it)', { required: true, max_length: 2000 }),
    opt(OPTION.STRING, 'tag', 'Which bucket it goes in', { choices: PICKABLE_TAGS.map(choice) }),
  ]),

  { type: 3, name: SAVE_AS_NOTE, ...GUILD_ONLY },

  slash('decide', 'Log a decision the team made, and why', [
    opt(OPTION.STRING, 'decision', 'What was decided', { required: true, max_length: 1000 }),
    opt(OPTION.STRING, 'why', 'The reason, so future-you remembers', { max_length: 1000 }),
  ]),

  slash('todo', 'Create an action item for someone', [
    opt(OPTION.STRING, 'task', 'What needs doing', { required: true, max_length: 1000 }),
    opt(OPTION.USER, 'owner', 'Who owns it (default: you)'),
    opt(OPTION.STRING, 'due', 'When, e.g. "Friday" or "Nov 20"', { max_length: 40 }),
  ]),

  slash('todos', 'Show open action items', [opt(OPTION.USER, 'owner', 'Only this person’s items')]),

  slash('notes', 'Find notes', [
    sub('search', 'Search every note', [opt(OPTION.STRING, 'query', 'Words to look for', { required: true })]),
    sub('recent', 'The latest notes'),
    sub('tag', 'Notes with one tag', [opt(OPTION.STRING, 'tag', 'Which tag', { required: true, choices: TAG_KEYS.map(choice) })]),
    sub('delete', 'Delete a note', [opt(OPTION.INTEGER, 'id', 'The note number, e.g. 12', { required: true, min_value: 1 })]),
  ]),

  slash('digest', 'Post this week’s round-up of notes, decisions and action items here'),

  slash('meeting', 'Meeting summaries you can ask questions about', [
    sub('summarize', 'Summarize a meeting from a transcript file or this channel', [
      opt(OPTION.ATTACHMENT, 'file', 'Transcript (.vtt, .srt, .txt or .md) from Zoom, Meet, Teams, Otter…'),
      opt(OPTION.INTEGER, 'hours', 'Or: summarize the last N hours of messages in this channel', { min_value: 1, max_value: 24 }),
      opt(OPTION.STRING, 'title', 'Meeting name (optional)', { max_length: 100 }),
    ]),
    sub('ask', 'Ask a question about a meeting', [
      opt(OPTION.STRING, 'question', 'What you want to know', { required: true, max_length: 500 }),
      opt(OPTION.INTEGER, 'id', 'Meeting number (default: this thread’s meeting, or the latest)', { min_value: 1 }),
    ]),
    sub('list', 'Recent meetings'),
    sub('notes', 'Get the full numbered notes of a meeting', [opt(OPTION.INTEGER, 'id', 'Meeting number', { required: true, min_value: 1 })]),
  ]),

  slash('setup', 'Create the bot’s channels (or pick existing ones)', [
    opt(OPTION.CHANNEL, 'forum', 'Forum for notes (default: create #notes)', { channel_types: [CHANNEL_TYPE.FORUM] }),
    opt(OPTION.CHANNEL, 'meetings_channel', 'Where meeting summaries go (default: create #meeting-notes)', { channel_types: [CHANNEL_TYPE.TEXT] }),
    opt(OPTION.CHANNEL, 'digest_channel', 'Where the Monday digest goes (default: create #weekly-digest)', { channel_types: [CHANNEL_TYPE.TEXT] }),
  ], { default_member_permissions: String(1 << 5) }),
];
