// Puts the bot on Supabase and points Discord at it:
//
//   npm run deploy
//
// Running this is the go-ahead to change the linked Supabase project (hence --yes).
// Needs SUPABASE_ACCESS_TOKEN in .env and `npx supabase link` once (see README).
// Reads DISCORD_TOKEN (and optionally ANTHROPIC_API_KEY etc.) from .env.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { commandDefs } from '../supabase/functions/_shared/commands.js';
import { createDiscord } from '../supabase/functions/_shared/discord-api.js';

const root = new URL('..', import.meta.url).pathname;
const step = (s) => console.log(`\n▶ ${s}`);
const supabase = (...args) => execFileSync('npx', ['supabase', ...args], { cwd: root, stdio: 'inherit' });

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error('No DISCORD_TOKEN in .env.');
  process.exit(1);
}

// The project this folder is linked to (from `npx supabase link`).
let ref;
try {
  ref = readFileSync(new URL('../supabase/.temp/project-ref', import.meta.url), 'utf8').trim();
} catch {
  console.error('This folder isn’t linked to a Supabase project yet. Run: npx supabase link');
  process.exit(1);
}
const url = `https://${ref}.supabase.co/functions/v1/discord-bot`;

step('Asking Discord for the bot’s app ID and public key');
const bootstrap = createDiscord({ token, appId: '' });
const app = await bootstrap.call('GET', '/applications/@me');
console.log(`  ${app.name} (${app.id})`);

// A random secret only Supabase's timer knows, kept in .env so redeploys reuse it.
let cronSecret = process.env.CRON_SECRET?.trim();
if (!cronSecret) {
  cronSecret = randomBytes(24).toString('hex');
  appendFileSync(new URL('../.env', import.meta.url), `\n# Lets Supabase's timer wake the bot (made by npm run deploy).\nCRON_SECRET=${cronSecret}\n`);
}

step('Saving the bot’s settings in Supabase (secrets)');
const secrets = {
  DISCORD_TOKEN: token,
  DISCORD_APP_ID: app.id,
  DISCORD_PUBLIC_KEY: app.verify_key,
  CRON_SECRET: cronSecret,
  DIGEST_DAY: process.env.DIGEST_DAY,
  DIGEST_HOUR: process.env.DIGEST_HOUR,
  DIGEST_TZ: process.env.DIGEST_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
};
const secretsFile = new URL('../.env.secrets', import.meta.url).pathname;
writeFileSync(secretsFile, Object.entries(secrets).filter(([, v]) => v?.trim()).map(([k, v]) => `${k}=${v.trim()}`).join('\n'), { mode: 0o600 });
try {
  supabase('secrets', 'set', '--env-file', secretsFile, '--yes');
} finally {
  rmSync(secretsFile, { force: true });
}

step('Uploading the bot to Supabase');
supabase('functions', 'deploy', 'discord-bot', '--no-verify-jwt', '--use-api', '--yes');

step('Registering the slash commands in each server');
const discord = createDiscord({ token, appId: app.id });
for (const guild of await discord.myGuilds()) {
  await discord.registerCommands(guild.id, commandDefs);
  console.log(`  ${guild.name}`);
}

step('Pointing Discord at the bot (Discord checks it answers before saving)');
await discord.call('PATCH', '/applications/@me', { body: { interactions_endpoint_url: url } });
console.log(`  ${url}`);

console.log('\n✔ Deployed. In Discord, run /setup once so the Monday timer is set.\n');
