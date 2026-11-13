// Shared test helpers: a real Postgres database (PGlite, in memory) with the
// bot's tables, and fakes for Discord and Claude. Nothing here touches the internet.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createRepo } from '../supabase/functions/_shared/db.js';

const TABLES = readFileSync(new URL('../supabase/migrations/20261113000000_tables.sql', import.meta.url), 'utf8');

// Starting Postgres takes a few seconds, so each test file starts it once and
// every test gets the tables emptied and numbering reset.
let shared;
export async function freshDb() {
  if (!shared) {
    shared = await PGlite.create();
    await shared.exec(TABLES);
  } else {
    await shared.exec('truncate notes, settings, meeting_questions, meetings restart identity cascade');
  }
  const pg = shared;
  const adapter = (q) => ({ query: async (text, params = []) => (await q.query(text, params)).rows });
  const db = { ...adapter(pg), transaction: (fn) => pg.transaction((tx) => fn(adapter(tx))) };
  return { pg, db, repo: createRepo(db) };
}

// Records every Discord API call and answers like Discord would.
export function fakeDiscord({ channels = [], messages = {} } = {}) {
  let nextId = 5000;
  const id = () => String(nextId++);
  const state = { calls: [], channels: new Map(channels.map((c) => [c.id, { ...c }])), messages: new Map(), deleted: [], edits: [], webhooks: [] };
  for (const [channelId, list] of Object.entries(messages)) state.messages.set(channelId, list);
  const posts = (channelId) => [...state.messages.values()].flat().filter((m) => m.channel_id === channelId);

  const api = {
    state,
    posts,
    appId: 'app',
    async editOriginal(token, body, files) {
      state.webhooks.push({ kind: 'edit', token, body, files });
      return { id: `orig-${token}`, channel_id: 'interaction-channel', ...body };
    },
    async followup(token, body, files) {
      state.webhooks.push({ kind: 'followup', token, body, files });
      return { id: id(), channel_id: 'interaction-channel', ...body };
    },
    async getChannel(channelId) {
      state.calls.push(['getChannel', channelId]);
      const c = state.channels.get(channelId);
      if (!c) throw Object.assign(new Error('Unknown Channel'), { status: 404, code: 10003 });
      return c;
    },
    async guildChannels() { return [...state.channels.values()].filter((c) => !c.thread_metadata); },
    async activeThreads() { return { threads: [...state.channels.values()].filter((c) => c.thread_metadata && !c.thread_metadata.archived) }; },
    async createChannel(guildId, body) {
      const c = { id: id(), guild_id: guildId, ...body };
      state.channels.set(c.id, c);
      return c;
    },
    async createForumPost(forumId, { name, message }) {
      const t = { id: id(), parent_id: forumId, name, thread_metadata: { archived: false } };
      state.channels.set(t.id, t);
      state.messages.set(t.id, [{ id: t.id, channel_id: t.id, ...message }]);
      return t;
    },
    async unarchive(threadId) {
      state.calls.push(['unarchive', threadId]);
      state.channels.get(threadId).thread_metadata.archived = false;
    },
    async send(channelId, body, files) {
      if (!state.channels.has(channelId)) throw Object.assign(new Error('Unknown Channel'), { status: 404, code: 10003 });
      const m = { id: id(), channel_id: channelId, ...body, files };
      state.messages.set(m.id, [m]);
      return m;
    },
    async edit(channelId, messageId, body) {
      const m = state.messages.get(messageId)?.[0];
      if (!m) throw Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
      Object.assign(m, body);
      state.edits.push({ channelId, messageId, body });
      return m;
    },
    async remove(channelId, messageId) {
      state.deleted.push(messageId);
      state.messages.delete(messageId);
    },
    async messages(channelId, { before } = {}) {
      const list = (state.messages.get(`history:${channelId}`) ?? []);
      if (!before) return list.slice(0, 100);
      const at = list.findIndex((m) => m.id === before);
      return list.slice(at + 1, at + 101);
    },
    async startThread(channelId, messageId, { name }) {
      const t = { id: id(), parent_id: channelId, name, thread_metadata: { archived: false }, from: messageId };
      state.channels.set(t.id, t);
      return t;
    },
    async registerCommands(guildId, defs) { state.calls.push(['registerCommands', guildId, defs.length]); },
  };
  return api;
}

// Stands in for Claude: records each request and replies with canned JSON.
export function fakeAi(...replies) {
  const calls = [];
  return {
    calls,
    model: 'fake',
    usageLog: [],
    async json(req) {
      calls.push(req);
      const next = replies.length > 1 ? replies.shift() : replies[0];
      return { data: typeof next === 'function' ? next(req) : structuredClone(next) };
    },
  };
}

// ---------- driving the whole bot the way Discord does ----------
import { createApp } from '../supabase/functions/_shared/app.js';

let keyPair;
async function keys() {
  if (!keyPair) {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const pub = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex');
    keyPair = { ...pair, pub };
  }
  return keyPair;
}

export async function sign(body, timestamp = String(Math.floor(Date.now() / 1000))) {
  const { privateKey } = await keys();
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(timestamp + body));
  return { 'x-signature-ed25519': Buffer.from(sig).toString('hex'), 'x-signature-timestamp': timestamp };
}

// A bot wired to a fresh database, a fake Discord and (optionally) a fake Claude.
export async function makeBot({ ai = null, discord = fakeDiscord(), env = {}, fetchText, schedule, now } = {}) {
  const { repo, db } = await freshDb();
  const pending = [];
  const errors = [];
  const app = createApp({
    env: { DISCORD_PUBLIC_KEY: (await keys()).pub, ...env },
    repo, discord, ai, fetchText, schedule, ...(now ? { now } : {}),
    waitUntil: (p) => pending.push(p),
    log: { error: (...a) => errors.push(a) },
  });

  // Sends one signed interaction; waits for the background work to finish.
  async function send(raw) {
    const body = JSON.stringify(raw);
    const res = await app.handle(new Request('https://bot.test/functions/v1/discord-bot', { method: 'POST', body, headers: await sign(body) }));
    const response = res.status === 200 ? await res.json() : null;
    await Promise.all(pending.splice(0));
    return { status: res.status, response, data: response?.data };
  }
  return { app, repo, db, discord, ai, send, errors };
}

// Builds interactions like the ones Discord sends.
const base = (extra) => ({
  id: 'i1', application_id: 'app', token: `tok-${Math.random().toString(36).slice(2)}`, version: 1,
  guild_id: 'g', channel_id: 'general', channel: { id: 'general', name: 'general' },
  member: { user: { id: 'u1', username: 'ana' }, permissions: '0' },
  ...extra,
});
export const command = (name, options = {}, { sub, resolved, ...extra } = {}) => {
  const opts = Object.entries(options).map(([n, value]) => ({ name: n, value }));
  return base({ type: 2, data: { type: 1, name, options: sub ? [{ type: 1, name: sub, options: opts }] : opts, resolved }, ...extra });
};
export const messageCommand = (name, message, extra = {}) =>
  base({ type: 2, data: { type: 3, name, target_id: message.id, resolved: { messages: { [message.id]: message } } }, ...extra });
export const click = (customId, { values, message, ...extra } = {}) =>
  base({ type: 3, data: { custom_id: customId, component_type: values ? 3 : 2, ...(values ? { values } : {}) }, message: message ?? { id: 'clicked-msg' }, ...extra });
export const submitForm = (customId, fields, extra = {}) =>
  base({ type: 5, data: { custom_id: customId, components: Object.entries(fields).map(([id, value]) => ({ type: 1, components: [{ type: 4, custom_id: id, value }] })) }, ...extra });
