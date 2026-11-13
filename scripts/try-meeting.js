// Try meeting notes in the terminal, without Discord:
//
//   npm run try-meeting                          (uses samples/sample-meeting.vtt)
//   npm run try-meeting -- path/to/transcript.vtt
//   npm run try-meeting -- transcript.txt "Who owns the checklist?"
//
// Uses ANTHROPIC_API_KEY from .env, so it spends real API credits (a few cents).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAi } from '../supabase/functions/_shared/ai.js';
import { answerQuestion, normalizeSummary, summarizeMeeting } from '../supabase/functions/_shared/meetings.js';
import { label, parseTranscript } from '../supabase/functions/_shared/transcript.js';

const [fileArg, ...questionArgs] = process.argv.slice(2);
const file = fileArg ?? fileURLToPath(new URL('../samples/sample-meeting.vtt', import.meta.url));
const questions = questionArgs.length
  ? questionArgs
  : ['What changed in this meeting, and who owns what?', 'What is the marketing budget?'];

const ai = createAi({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL });
if (!ai) {
  console.error('\nAI is off: paste your Anthropic API key after ANTHROPIC_API_KEY= in .env, then run this again.\n');
  process.exit(1);
}

const raw = readFileSync(file, 'utf8');
const segments = parseTranscript(raw);
if (!segments.length) {
  console.error(`\nNo text found in ${file}.\n`);
  process.exit(1);
}

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const at = (refs) => (refs.length ? dim(` (${refs.slice(0, 3).map((n) => label(segments[n - 1]).slice(1, -1)).join(', ')})`) : '');

console.log(`\nReading ${basename(file)}: ${segments.length} segments. Asking ${ai.model} for meeting notes…\n`);
const started = Date.now();
const summary = normalizeSummary(await summarizeMeeting(ai, { title: '', segments, earlierDecisions: [] }), segments);

console.log(bold(`🎙️  ${summary.title}`));
console.log(`${summary.overview}\n`);
console.log(bold('⭐ IMPORTANT'));
if (summary.important.key_points.length) console.log('  Key points');
for (const k of summary.important.key_points) console.log(`   • ${k.text}${at(k.refs)}`);
if (summary.important.decisions.length) console.log('  Decisions');
for (const d of summary.important.decisions) console.log(`   • ${d.text}${d.why ? ` — ${d.why}` : ''}${at(d.refs)}`);
if (summary.important.action_items.length) console.log('  Action items');
for (const a of summary.important.action_items) console.log(`   • ${a.owner || 'unassigned'}: ${a.task}${a.due ? ` · due ${a.due}` : ''}${at(a.refs)}`);
console.log(`\n${bold('🔄 CHANGES')}`);
if (!summary.changes.length) console.log('   No changes to earlier plans or decisions.');
for (const c of summary.changes) console.log(`   • ${c.what ? `${c.what}: ` : ''}${c.before || '?'} → ${c.after}${at(c.refs)}`);
if (summary.open_questions.length) {
  console.log(`\n${bold('❓ OPEN QUESTIONS')}`);
  for (const q of summary.open_questions) console.log(`   • ${q.text}${at(q.refs)}`);
}
console.log(dim(`\n(summary took ${((Date.now() - started) / 1000).toFixed(1)}s)`));

// Questions, the same way the bot answers them in a meeting's thread.
const meeting = { id: 1, title: summary.title, source: `file: ${basename(file)}`, segments, summary };
const history = [];
for (const q of questions) {
  const { text, covered } = await answerQuestion(ai, meeting, history.slice(-3), q);
  history.push({ question: q, answer: text });
  console.log(`\n${bold(`❔ ${q}`)}\n   ${text}${covered ? '' : dim('  [not covered by the notes]')}`);
}

// What it cost, at the default model's list prices (Claude Opus 5.5: $4 in / $20 out per million tokens,
// cache writes $5, cache reads $0.20). Output includes the model's thinking.
const t = ai.usageLog.reduce((sum, u) => ({
  input: sum.input + (u.input_tokens ?? 0),
  output: sum.output + (u.output_tokens ?? 0),
  cacheWrite: sum.cacheWrite + (u.cache_creation_input_tokens ?? 0),
  cacheRead: sum.cacheRead + (u.cache_read_input_tokens ?? 0),
}), { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const dollars = (t.input * 4 + t.output * 20 + t.cacheWrite * 5 + t.cacheRead * 0.2) / 1e6;
console.log(dim(`\n${ai.usageLog.length} requests · ${t.input} input, ${t.output} output, ${t.cacheWrite} cache-write, ${t.cacheRead} cache-read tokens`));
console.log(dim(ai.model === 'claude-opus-5-5' ? `≈ $${dollars.toFixed(3)} at Opus 5.5 list prices\n` : '(cost estimate only shown for the default model)\n'));
