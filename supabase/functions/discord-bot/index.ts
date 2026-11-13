// Supabase entry point. Supabase starts this when a request arrives and lets it
// sleep when there's nothing to do. All the bot's logic is in ../_shared.
import postgres from 'postgres';
import { createAi } from '../_shared/ai.js';
import { createApp } from '../_shared/app.js';
import { createRepo } from '../_shared/db.js';
import { createDiscord } from '../_shared/discord-api.js';
import { scheduleTimers } from '../_shared/setup.js';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const env = Deno.env.toObject();

// Supabase provides SUPABASE_DB_URL. `prepare: false` suits its connection pooler.
const sql = postgres(env.SUPABASE_DB_URL, { prepare: false, max: Number(env.DB_POOL_SIZE ?? 3), idle_timeout: 20 });
type Params = unknown[];
const adapter = (q: typeof sql) => ({ query: (text: string, params: Params = []) => q.unsafe(text, params as never[]) });
const db = {
  ...adapter(sql),
  transaction: (fn: (tx: ReturnType<typeof adapter>) => Promise<unknown>) => sql.begin((tx) => fn(adapter(tx as unknown as typeof sql))),
};

const app = createApp({
  env,
  repo: createRepo(db),
  discord: createDiscord({ token: env.DISCORD_TOKEN, appId: env.DISCORD_APP_ID }),
  ai: createAi({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL }),
  schedule: (opts: { url: string; secret: string; day: number; hour: number; timeZone: string }) => scheduleTimers(db, opts),
  waitUntil: (p: Promise<unknown>) => EdgeRuntime.waitUntil(p),
});

Deno.serve((req) => app.handle(req));
