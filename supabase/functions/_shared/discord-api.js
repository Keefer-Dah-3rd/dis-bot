// Talks to Discord over plain web requests (no live connection). Used both for
// answering interactions and for posting into channels.

export class DiscordError extends Error {
  constructor(status, body) {
    super(`Discord ${status}: ${body?.message ?? 'error'}`);
    this.status = status;
    this.code = body?.code;
  }
}

export const CHANNEL = { TEXT: 0, CATEGORY: 4, FORUM: 15 };
export const messageUrl = (guildId, channelId, messageId) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createDiscord({ token, appId, fetch: doFetch = globalThis.fetch, api = 'https://discord.com/api/v10' }) {
  async function call(method, path, { body, files, auth = true } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers = { 'User-Agent': 'DiscordBot (mibbit-notes, 0.2)' };
      if (auth) headers.Authorization = `Bot ${token}`;
      let payload;
      if (files?.length) {
        const form = new FormData();
        form.append('payload_json', JSON.stringify({ ...body, attachments: files.map((f, n) => ({ id: n, filename: f.name })) }));
        files.forEach((f, n) => form.append(`files[${n}]`, new Blob([f.data], { type: f.type ?? 'text/plain' }), f.name));
        payload = form;
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await doFetch(`${api}${path}`, { method, headers, body: payload });
      if (res.status === 429) {
        const wait = (await res.json().catch(() => ({}))).retry_after ?? 1;
        await sleep(Math.min(wait * 1000, 5000));
        continue;
      }
      if (res.status === 204) return null;
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new DiscordError(res.status, data);
      return data;
    }
    throw new DiscordError(429, { message: 'rate limited' });
  }

  const webhook = `/webhooks/${appId}`;
  return {
    appId,
    call,
    // Replies to an interaction after a "thinking…" response (valid for 15 minutes).
    editOriginal: (interactionToken, body, files) => call('PATCH', `${webhook}/${interactionToken}/messages/@original`, { body, files, auth: false }),
    followup: (interactionToken, body, files) => call('POST', `${webhook}/${interactionToken}`, { body, files, auth: false }),

    getChannel: (id) => call('GET', `/channels/${id}`),
    guildChannels: (guildId) => call('GET', `/guilds/${guildId}/channels`),
    activeThreads: (guildId) => call('GET', `/guilds/${guildId}/threads/active`),
    createChannel: (guildId, body) => call('POST', `/guilds/${guildId}/channels`, { body }),
    createForumPost: (forumId, body) => call('POST', `/channels/${forumId}/threads`, { body }),
    unarchive: (threadId) => call('PATCH', `/channels/${threadId}`, { body: { archived: false } }),
    send: (channelId, body, files) => call('POST', `/channels/${channelId}/messages`, { body, files }),
    edit: (channelId, messageId, body) => call('PATCH', `/channels/${channelId}/messages/${messageId}`, { body }),
    remove: (channelId, messageId) => call('DELETE', `/channels/${channelId}/messages/${messageId}`),
    messages: (channelId, { before, limit = 100 } = {}) =>
      call('GET', `/channels/${channelId}/messages?limit=${limit}${before ? `&before=${before}` : ''}`),
    startThread: (channelId, messageId, body) => call('POST', `/channels/${channelId}/messages/${messageId}/threads`, { body }),
    registerCommands: (guildId, defs) => call('PUT', `/applications/${appId}/guilds/${guildId}/commands`, { body: defs }),
    myGuilds: () => call('GET', '/users/@me/guilds'),
  };
}
