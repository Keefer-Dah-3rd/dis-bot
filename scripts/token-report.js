// Estimates what the meeting AI sends to Claude, without calling it (costs nothing):
//
//   npm run token-report
//
// Builds the real summary and question requests for the sample meeting and for a
// generated 1-hour, Zoom-style transcript, then estimates tokens as characters ÷ 4.
// That ratio is approximate; use it to compare versions, not as an exact bill.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildQuestionRequest, buildSummaryRequest, normalizeSummary, SUMMARY_SCHEMA, ANSWER_SCHEMA } from '../supabase/functions/_shared/meetings.js';
import { parseTranscript } from '../supabase/functions/_shared/transcript.js';

const tokens = (x) => Math.round((typeof x === 'string' ? x : JSON.stringify(x)).length / 4);
const textOf = (content) => (typeof content === 'string' ? content : content.map((b) => b.text).join(''));

// ---------- a realistic 1-hour transcript: short Zoom cues, filler words ----------
function hourLongVtt() {
  const people = ['Ana', 'Ben', 'Chloe', 'Dev'];
  const lines = [
    'Um, so I think the, uh, onboarding flow is mostly there, we just need the first sound to feel right.',
    'Yeah, I agree, like, the pad grid feels good but the waveform editor is still dropping frames on older iPads.',
    "Okay so, uh, should we push the beta a week? I'd rather not ship something that stutters.",
    'Right, right. And, um, who is taking the sampler redesign now that it needs engineering time?',
    "I can take it, but then I'll need someone else on the sound pack art, you know?",
    'Hmm, okay. What about pricing for the sound packs, did we land anywhere on that?',
    "Not yet, I think we park it and ask the testers what they'd pay.",
    'Cool, and the TestFlight build, is Thursday still realistic or, uh, is that too tight?',
  ];
  let vtt = 'WEBVTT\n\n';
  let t = 0;
  let cue = 1;
  const stamp = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000`;
  while (t < 3600) {
    const who = people[cue % people.length === 0 ? 0 : (Math.floor(cue / 3) % people.length)];
    const words = lines[cue % lines.length].split(' ');
    // Zoom splits speech into cues of a few seconds each.
    for (let i = 0; i < words.length && t < 3600; i += 7) {
      vtt += `${cue}\n${stamp(t)} --> ${stamp(t + 3)}\n<v ${who}>${words.slice(i, i + 7).join(' ')}</v>\n\n`;
      t += 3;
      cue += 1;
    }
    t += 2;
  }
  return vtt;
}

// A summary about the size a real one comes back at.
function typicalSummary(segments) {
  const n = segments.length;
  const r = (k) => [Math.max(1, Math.floor((n * k) / 10))];
  return normalizeSummary({
    title: 'Beta timing and sampler handover',
    overview: 'The team pushed the beta a week to fix waveform performance and moved the sampler redesign to engineering.',
    important: {
      key_points: [1, 2, 3, 4, 5].map((k) => ({ text: `Key point number ${k} about the beta, the sampler and onboarding.`, refs: r(k) })),
      decisions: [1, 2, 3].map((k) => ({ text: `Decision ${k}: the beta moves and onboarding starts with a sound.`, why: 'Performance on older iPads.', refs: r(k) })),
      action_items: [1, 2, 3, 4].map((k) => ({ task: `Action item ${k}: ship the TestFlight build`, owner: 'Ben', due: 'Thursday', refs: r(k) })),
    },
    changes: [1, 2].map((k) => ({ what: `Change ${k}`, before: 'December 1', after: 'December 8', refs: r(k) })),
    open_questions: [{ text: 'Sound pack pricing is undecided.', refs: r(9) }],
  }, segments);
}

const earlierDecisions = Array.from({ length: 40 }, (_, k) => ({
  id: k + 1,
  content: `Earlier decision ${k + 1}: we agreed to keep the pad grid at 4x4 and revisit the layout after the beta.`,
  why: 'It tested better with the first group of testers and keeps the screen calm.',
  created_at: Date.UTC(2026, 9, 1 + (k % 28)),
}));

const history = [
  { question: 'When is the beta now?', answer: 'December 8 [S12 · 0:22], moved from December 1 so the waveform editor stops dropping frames [S11 · 0:12].' },
  { question: 'Who owns the sampler?', answer: 'Ben took over the sampler redesign [S20 · 1:20].' },
  { question: 'And the sound pack art?', answer: 'Ana keeps the sound pack art and onboarding [S20 · 1:20].' },
  { question: 'Is Thursday realistic for TestFlight?', answer: 'Ben said Thursday [S30 · 2:40]; nobody raised a concern.' },
];

function report(name, raw) {
  const segments = parseTranscript(raw);
  const summaryReq = buildSummaryRequest({ title: '', segments, earlierDecisions });
  const meeting = { id: 1, title: 'Meeting', segments, summary: typicalSummary(segments) };
  const qa = buildQuestionRequest(meeting, history.slice(-3), 'What did we decide about pricing?'); // the bot sends at most 3 recent Q&As
  const cachedPart = qa.system.filter((b) => b.cache_control).map((b) => b.text).join('');
  const uncachedSystem = qa.system.filter((b) => !b.cache_control).map((b) => b.text).join('');
  const uncached = tokens(uncachedSystem) + qa.messages.reduce((sum, m) => sum + tokens(textOf(m.content)), 0);

  const summaryIn = tokens(summaryReq.system) + tokens(textOf(summaryReq.messages[0].content));
  // Opus 5.5 list prices per token: input $4/M, cache write (5 min) $5/M, cache read $0.20/M.
  const firstQ = (cachedPart.length / 4) * 5e-6 + uncached * 4e-6;
  const laterQ = (cachedPart.length / 4) * 0.2e-6 + uncached * 4e-6;

  console.log(`\n${name}: ${segments.length} segments, ${raw.length.toLocaleString()} chars of transcript`);
  console.log(`  summary request:   ~${summaryIn.toLocaleString()} input tokens  (≈ $${(summaryIn * 4e-6).toFixed(3)} before output)`);
  console.log(`    of which earlier decisions: ~${tokens(summaryReq.messages[0].content.split('</earlier_decisions>')[0]).toLocaleString()}`);
  console.log(`  question request:  ~${tokens(cachedPart).toLocaleString()} cached (notes + summary) + ~${uncached.toLocaleString()} uncached (instructions, history, question)`);
  console.log(`    of which summary in context: ~${tokens(cachedPart.split('<meeting_notes>')[0]).toLocaleString()}`);
  console.log(`    first question ≈ $${firstQ.toFixed(4)}, follow-ups within 5 min ≈ $${laterQ.toFixed(4)} (input only)`);
}

const sample = readFileSync(fileURLToPath(new URL('../samples/sample-meeting.vtt', import.meta.url)), 'utf8');
console.log('Token estimate (characters ÷ 4). Output tokens, including thinking, come on top.');
report('Sample meeting (4 min)', sample);
report('1-hour Zoom-style meeting', hourLongVtt());
console.log(`\nJSON schemas: summary ~${tokens(SUMMARY_SCHEMA)} tokens, answer ~${tokens(ANSWER_SCHEMA)} tokens\n`);
