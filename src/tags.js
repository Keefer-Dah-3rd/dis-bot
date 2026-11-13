// The buckets notes get sorted into. Each tag gets its own post in the notes forum.
export const TAGS = {
  general: { label: 'General', emoji: '📝', color: 0x9ca3af },
  idea: { label: 'Ideas', emoji: '💡', color: 0xfacc15 },
  design: { label: 'Design', emoji: '🎨', color: 0xec4899 },
  bug: { label: 'Bugs', emoji: '🐛', color: 0xef4444 },
  feedback: { label: 'Feedback', emoji: '💬', color: 0x3b82f6 },
  decision: { label: 'Decisions', emoji: '✅', color: 0x22c55e },
  todo: { label: 'Action items', emoji: '📋', color: 0xf97316 },
};

export const TAG_KEYS = Object.keys(TAGS);

// Tags offered in the "change tag" picker. Action items have their own command
// (/todo) because they need an owner.
export const PICKABLE_TAGS = ['general', 'idea', 'design', 'bug', 'feedback', 'decision'];

// Lets people tag by writing #idea, #bugs, #design… anywhere in the text.
const HASHTAG = /#(idea|design|bug|feedback|decision|todo)s?\b/i;

export function tagFromText(text = '') {
  const match = text.match(HASHTAG);
  return match ? match[1].toLowerCase() : null;
}

export function tagInfo(tag) {
  return TAGS[tag] ?? TAGS.general;
}

export function tagLine(tag) {
  const t = tagInfo(tag);
  return `${t.emoji} ${t.label}`;
}
