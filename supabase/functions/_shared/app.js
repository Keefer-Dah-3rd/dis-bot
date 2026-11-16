// The bot's front door. Supabase wakes it for each request:
//   POST /discord-bot        → a Discord interaction (command, button, menu, form)
//   POST /discord-bot/cron   → the timer (Monday digest + daily check-in)
//   POST /discord-bot/ingest → a transcript from the meeting recorder, to summarize and post
//   GET  /discord-bot        → "is it up?"
import { AiError } from './ai.js';
import { buildDigest, digestSlot } from './digest.js';
import { DiscordError } from './discord-api.js';
import { readInteraction, reply, RESPONSE, TYPE, verifySignature } from './interaction.js';
import { createMeetingHandlers, NO_HOME } from './meeting-handlers.js';
import { createNotesHandlers, digestEmbed, digestSettings } from './notes-handlers.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function errorText(err) {
  if (err instanceof AiError) return `⚠️ ${err.message}`;
  if (err instanceof DiscordError && err.code === 50013) return '⚠️ I’m missing a Discord permission for that. Check my role’s permissions in the server settings.';
  return '⚠️ Something went wrong. The details are in the bot’s logs in Supabase.';
}

/**
 * @param {{
 *   env: Record<string, string | undefined>, repo: any, discord: any, ai: any,
 *   schedule?: (opts: any) => Promise<unknown>, fetchText?: (url: string) => Promise<string>,
 *   waitUntil?: (p: Promise<unknown>) => unknown, log?: { error: (...args: unknown[]) => void }, now?: () => Date,
 * }} deps
 */
export function createApp({ env, repo, discord, ai, schedule, fetchText, waitUntil = (p) => p, log = console, now = () => new Date() }) {
  const notes = createNotesHandlers({ repo, discord, env, schedule });
  const meetings = createMeetingHandlers({ repo, discord, ai, fetchText });
  const commandHandlers = { ...notes.commands, ...meetings.commands };
  const componentHandlers = { ...notes.components, ...meetings.components };
  const modalHandlers = { ...meetings.modals };

  function route(c) {
    if (c.type === TYPE.COMMAND) return commandHandlers[c.name]?.(c);
    const [kind, arg] = String(c.customId ?? '').split(':');
    if (c.type === TYPE.COMPONENT) return componentHandlers[kind]?.(c, arg);
    if (c.type === TYPE.MODAL_SUBMIT) return modalHandlers[kind]?.(c, arg);
    return null;
  }

  // Slow work happens after Discord has its answer: the AI call, posting, filing.
  async function later(c, result) {
    if (result.work) {
      try {
        const out = await result.work();
        if (out) {
          const { files, ...body } = out;
          await discord.editOriginal(c.token, { allowed_mentions: { parse: [] }, ...body }, files);
        }
      } catch (err) {
        if (!(err instanceof AiError)) log.error('work failed:', err);
        await discord.editOriginal(c.token, { content: errorText(err), embeds: [], components: [] }).catch(() => {});
      }
    }
    if (result.after) {
      try {
        await result.after();
      } catch (err) {
        log.error('background task failed:', err);
      }
    }
  }

  async function interaction(request) {
    const body = await request.text();
    const ok = await verifySignature(
      env.DISCORD_PUBLIC_KEY,
      request.headers.get('x-signature-ed25519'),
      request.headers.get('x-signature-timestamp'),
      body,
    );
    if (!ok) return new Response('invalid request signature', { status: 401 });

    const raw = JSON.parse(body);
    if (raw.type === TYPE.PING) return json({ type: RESPONSE.PONG });
    if (!raw.guild_id) return json(reply({ content: 'I only work inside a server.' }, { ephemeral: true }).response);

    const c = readInteraction(raw);
    let result;
    try {
      result = await route(c);
    } catch (err) {
      log.error('handler failed:', err);
      result = reply({ content: errorText(err) }, { ephemeral: true });
    }
    result ??= reply({ content: 'I don’t know that one yet.' }, { ephemeral: true });
    if (result.work || result.after) waitUntil(later(c, result));
    return json(result.response);
  }

  // The timer: posts the digest when it's the right hour on the team's clock.
  // Every call also reads the database, which keeps Supabase's free plan from
  // pausing it.
  async function cron(request) {
    if (!env.CRON_SECRET || request.headers.get('x-cron-secret') !== env.CRON_SECRET) return new Response('unauthorized', { status: 401 });
    const { day, hour, timeZone } = digestSettings(env);
    const slot = digestSlot(now(), day, hour, timeZone);
    const posted = [];
    for (const guildId of await repo.guildsWithSetting('digest_channel')) {
      if (!slot || await repo.getSetting(guildId, 'last_digest') === slot) continue;
      await repo.setSetting(guildId, 'last_digest', slot);
      const d = await buildDigest(repo, guildId, now().getTime());
      if (!d) continue;
      try {
        await discord.send(await repo.getSetting(guildId, 'digest_channel'), { embeds: [digestEmbed(d)], allowed_mentions: { parse: [] } });
        posted.push(guildId);
      } catch (err) {
        log.error('digest failed:', err);
      }
    }
    return json({ ok: true, slot, posted: posted.length });
  }

  // A recorded call's transcript, sent from the team's own computer with the
  // same secret the timer uses. Answers once the summary is posted (or says why not).
  async function ingest(request) {
    if (!env.CRON_SECRET || request.headers.get('x-cron-secret') !== env.CRON_SECRET) return new Response('unauthorized', { status: 401 });
    let body;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    if (typeof body?.transcript !== 'string' || !body.transcript.trim()) return json({ ok: false, error: 'Send JSON with a "transcript".' }, 400);

    const guilds = await repo.guildsWithSetting('meetings_channel');
    const guildId = body.guild_id ?? guilds[0];
    if (!guildId || !guilds.includes(guildId)) return json({ ok: false, error: NO_HOME }, 409);
    try {
      const out = await meetings.ingest({ guildId, userId: discord.appId, transcript: body.transcript, title: body.title, source: body.source });
      return json(out, out.ok ? 200 : 422);
    } catch (err) {
      if (!(err instanceof AiError)) log.error('ingest failed:', err);
      return json({ ok: false, error: errorText(err) }, 502);
    }
  }

  return {
    async handle(request) {
      const { pathname } = new URL(request.url);
      if (request.method === 'GET') return new Response('Mibbit Notes is ready.');
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (pathname.endsWith('/cron')) return cron(request);
      if (pathname.endsWith('/ingest')) return ingest(request);
      return interaction(request);
    },
  };
}
