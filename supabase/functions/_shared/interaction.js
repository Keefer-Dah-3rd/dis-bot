// Reading Discord interactions (commands, buttons, menus, forms) and building replies.

export const TYPE = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 };
export const RESPONSE = { PONG: 1, MESSAGE: 4, DEFER: 5, DEFER_UPDATE: 6, UPDATE: 7, MODAL: 9 };
export const EPHEMERAL = 64;
export const PERMISSION = { MANAGE_GUILD: 1n << 5n, MANAGE_MESSAGES: 1n << 13n };

// Checks Discord's signature on a request, so nobody else can pretend to be Discord.
const keys = new Map();
export async function verifySignature(publicKeyHex, signatureHex, timestamp, body) {
  if (!publicKeyHex || !signatureHex || !timestamp) return false;
  try {
    let key = keys.get(publicKeyHex);
    if (!key) {
      key = await crypto.subtle.importKey('raw', hex(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
      keys.set(publicKeyHex, key);
    }
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, hex(signatureHex), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

function hex(s) {
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(s.substr(i * 2, 2), 16);
  return bytes;
}

// A friendlier view of the raw interaction.
export function readInteraction(raw) {
  const data = raw.data ?? {};
  let options = data.options ?? [];
  let sub = null;
  if (options[0]?.type === 1) {
    sub = options[0].name;
    options = options[0].options ?? [];
  }
  const values = Object.fromEntries(options.map((o) => [o.name, o.value]));
  const resolved = data.resolved ?? {};
  const user = raw.member?.user ?? raw.user ?? {};

  return {
    raw,
    type: raw.type,
    token: raw.token,
    guildId: raw.guild_id,
    channelId: raw.channel_id,
    channel: raw.channel,
    user,
    userId: user.id,
    permissions: BigInt(raw.member?.permissions ?? '0'),
    name: data.name,
    sub,
    customId: data.custom_id,
    selected: data.values ?? [],
    message: raw.message,
    targetMessage: data.target_id ? resolved.messages?.[data.target_id] : null,
    opt: (name) => values[name] ?? null,
    optUser: (name) => (values[name] ? resolved.users?.[values[name]] ?? { id: values[name] } : null),
    optChannel: (name) => (values[name] ? resolved.channels?.[values[name]] ?? { id: values[name] } : null),
    optAttachment: (name) => (values[name] ? resolved.attachments?.[values[name]] ?? null : null),
    field: (customId) => findField(data.components ?? [], customId),
  };
}

function findField(components, customId) {
  for (const c of components) {
    if (c.custom_id === customId && 'value' in c) return c.value;
    const inner = c.components ?? (c.component ? [c.component] : []);
    const found = findField(inner, customId);
    if (found != null) return found;
  }
  return null;
}

// ---------- what a handler returns ----------
// response: sent straight back to Discord (must happen within 3 seconds).
// work:     slow follow-up (AI, posting) that runs after the response; its
//           return value, if any, replaces the "thinking…" message.
// after:    background chores (filing a note in the forum).

export const reply = (data, { ephemeral = false } = {}) => ({
  response: { type: RESPONSE.MESSAGE, data: { allowed_mentions: { parse: [] }, ...data, ...(ephemeral ? { flags: EPHEMERAL } : {}) } },
});
export const update = (data) => ({ response: { type: RESPONSE.UPDATE, data } });
export const defer = (work, { ephemeral = false } = {}) => ({
  response: { type: RESPONSE.DEFER, data: ephemeral ? { flags: EPHEMERAL } : {} },
  work,
});
export const modal = (data) => ({ response: { type: RESPONSE.MODAL, data } });

// ---------- component builders ----------
export const row = (...components) => ({ type: 1, components });
export const button = ({ customId, label, emoji, style = 1 }) => ({ type: 2, style, label, custom_id: customId, ...(emoji ? { emoji: { name: emoji } } : {}) });
export const select = ({ customId, placeholder, options }) => ({ type: 3, custom_id: customId, placeholder, options });
