// Sends a recorded meeting's transcript to the bot, which summarizes it and
// posts the notes in #meeting-notes (with the Ask button), like /meeting summarize:
//
//   npm run post-meeting -- path/to/for-bot.txt
//   npm run post-meeting -- path/to/for-bot.txt "Monday sync"
//
// The summary uses AI, so this spends a few cents of API credit. Sending the
// same transcript twice doesn't: the bot points to the notes it already made.
// Uses CRON_SECRET from .env (the bot only accepts transcripts that carry it).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [file, title] = process.argv.slice(2);
if (!file) {
  console.error('\nWhich transcript? For example: npm run post-meeting -- meeting/for-bot.txt "Monday sync"\n');
  process.exit(1);
}
const secret = process.env.CRON_SECRET?.trim();
if (!secret) {
  console.error('\nNo CRON_SECRET in .env. Run `npm run deploy` once; it creates one.\n');
  process.exit(1);
}

let ref;
try {
  ref = readFileSync(new URL('../supabase/.temp/project-ref', import.meta.url), 'utf8').trim();
} catch {
  console.error('\nThis folder isn’t linked to a Supabase project yet. Run: npx supabase link\n');
  process.exit(1);
}

const transcript = readFileSync(file, 'utf8');
const lines = transcript.split('\n').filter((l) => l.trim()).length;
console.log(`\nSending ${basename(file)} (${lines} lines) to the bot. The summary usually takes under a minute…`);

const res = await fetch(`https://${ref}.supabase.co/functions/v1/discord-bot/ingest`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret },
  body: JSON.stringify({ transcript, title: title || undefined, source: `recorded call: ${basename(file)}` }),
  signal: AbortSignal.timeout(170_000),
}).catch((err) => {
  console.error(`\nCouldn’t reach the bot: ${err.message}\n`);
  process.exit(1);
});

const text = await res.text();
let out = null;
try {
  out = JSON.parse(text);
} catch {
  // Not JSON: an older bot (no /ingest yet) or a Supabase error page.
}
if (!out?.ok) {
  const why = out?.error
    ?? (res.status === 401 ? 'The bot didn’t accept the secret. Run `npm run deploy` so the bot and .env match.' : `The bot answered ${res.status}. If it hasn’t been deployed since this script was added, run \`npm run deploy\`.`);
  console.error(`\n✖ Not posted. ${why}\n`);
  process.exit(1);
}
console.log(out.already
  ? `\n✔ That meeting was already posted as #${out.meeting_id}, “${out.title}”:\n  ${out.url}\n`
  : `\n✔ Posted meeting #${out.meeting_id}, “${out.title}”:\n  ${out.url}\n`);
