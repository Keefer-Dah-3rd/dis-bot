// Turns meeting notes into numbered segments ([S1], [S2] …) so summaries and
// answers can point at exactly where something was said.
//
// Understands: .vtt (Zoom, Google Meet, Teams), .srt, "Name: text" lines,
// Otter-style "Name  0:42" headers, plain notes, and Discord messages.

const MAX_SEGMENT_CHARS = 1200;
const MAX_MERGE_GAP_SECONDS = 30; // keep separate timestamps for things said further apart

export function parseTranscript(raw = '') {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const segments = text.includes('-->') ? parseCues(text) : parsePlain(text);
  return number(merge(segments));
}

// Messages from a Discord channel, oldest first.
export function fromMessages(messages) {
  return number(merge(messages
    .map((m) => ({
      time: clock(m.createdAt),
      speaker: m.speaker,
      text: [m.content?.trim(), ...(m.attachments ?? []).map((a) => `[attached ${a}]`)].filter(Boolean).join(' '),
    }))
    .filter((s) => s.text)));
}

// The text the AI reads (and people can download): one numbered line per segment.
export function renderSegments(segments) {
  return segments.map((s) => `${label(s)} ${s.speaker ? `${s.speaker}: ` : ''}${s.text}`).join('\n');
}

// What Claude reads: no timestamps (the bot adds them back when it shows a
// citation) and no "um"/"uh" filler. Saves tokens on every summary and question.
export function renderForModel(segments) {
  return segments.map((s) => `[S${s.n}] ${s.speaker ? `${s.speaker}: ` : ''}${stripFiller(s.text)}`).join('\n');
}

const FILLER = /(?:,\s*)?\b(?:u+m+|u+h+|e+r+m+|h+m+)\b[,.]?/gi;
export function stripFiller(text) {
  const cleaned = text.replace(FILLER, ' ').replace(/\s{2,}/g, ' ').replace(/\s+([,.;!?])/g, '$1').replace(/^[,.;\s]+/, '').trim();
  return cleaned || text; // never blank out a line that was only filler
}

export function label(segment) {
  return `[S${segment.n}${segment.time ? ` · ${segment.time}` : ''}]`;
}

// ---------- parsing ----------

function parseCues(text) {
  const out = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const timing = lines.findIndex((l) => l.includes('-->'));
    if (timing === -1) continue; // WEBVTT header, NOTE blocks, stray numbers
    const body = lines.slice(timing + 1).join(' ');
    if (!body) continue;
    out.push({ time: shortTime(lines[timing].split('-->')[0]), ...splitSpeaker(stripVoiceTags(body)) });
  }
  return out;
}

function parsePlain(text) {
  const out = [];
  let header = null; // Otter-style "Alice  0:42" line that names the speaker of what follows
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line) continue;

    const h = line.match(/^([^\d:\s[(][^:]{0,39}?)\s+\(?((?:\d{1,2}:)?\d{1,2}:\d{2})\)?$/);
    if (h) {
      header = { speaker: h[1].trim(), time: shortTime(h[2]) };
      continue;
    }

    let time = null;
    const lead = line.match(/^[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})(?:[.,]\d+)?[\])]?\s*[-–]?\s*/);
    if (lead && lead[0].length < line.length) {
      time = shortTime(lead[1]);
      line = line.slice(lead[0].length);
    }

    const said = splitSpeaker(line);
    if (said.speaker) {
      out.push({ time, ...said });
      header = null;
    } else if (header) {
      out.push({ time: time ?? header.time, speaker: header.speaker, text: line });
    } else {
      out.push({ time, speaker: null, text: line });
    }
  }
  return out;
}

function stripVoiceTags(s) {
  const voice = s.match(/^<v(?:\.[^\s>]+)?\s+([^>]+)>(.*)$/);
  return (voice ? `${voice[1]}: ${voice[2]}` : s).replace(/<\/?[^>]+>/g, '').trim();
}

function splitSpeaker(line) {
  const m = line.match(/^([^\d:\s[(<][^:]{0,39}):\s+(.+)$/);
  if (m && m[1].split(/\s+/).length <= 4) return { speaker: m[1].trim(), text: m[2].trim() };
  return { speaker: null, text: line.trim() };
}

// Joins back-to-back lines from the same person so segments read naturally,
// but only when they were said close together, so citations stay precise.
function merge(segments) {
  const out = [];
  for (const s of segments) {
    const prev = out[out.length - 1];
    const sameSpeaker = prev && s.speaker && prev.speaker === s.speaker;
    const close = prev && (s.time == null || prev.lastTime == null || seconds(s.time) - seconds(prev.lastTime) <= MAX_MERGE_GAP_SECONDS);
    if (sameSpeaker && close && prev.text.length + s.text.length < MAX_SEGMENT_CHARS) {
      prev.text += ` ${s.text}`;
      prev.lastTime = s.time ?? prev.lastTime;
    } else {
      out.push({ time: s.time ?? null, speaker: s.speaker ?? null, text: s.text, lastTime: s.time ?? null });
    }
  }
  return out.map(({ lastTime, ...seg }) => seg);
}

function seconds(t) {
  return String(t).split(':').map(Number).reduce((acc, p) => acc * 60 + p, 0);
}

function number(segments) {
  return segments.map((s, i) => ({ n: i + 1, ...s }));
}

// "00:01:02.500" → "1:02", "01:15:00" → "1:15:00"
export function shortTime(t) {
  const parts = String(t).trim().split(/[.,]/)[0].split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  while (parts.length > 2 && parts[0] === 0) parts.shift();
  const [first, ...rest] = parts;
  return [String(first), ...rest.map((p) => String(p).padStart(2, '0'))].join(':');
}

function clock(date) {
  if (!(date instanceof Date)) return null;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
