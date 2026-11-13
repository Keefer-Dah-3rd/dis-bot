import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export class AiError extends Error {}

// AI is off unless ANTHROPIC_API_KEY is in .env. The key is passed explicitly so
// the bot never falls back to some other Anthropic login on this computer and
// spends credits nobody agreed to.
export function createAi({ apiKey = process.env.ANTHROPIC_API_KEY?.trim(), model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL } = {}) {
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey });
  // Haiku has no server-side fallback; every other current model does.
  const fallback = model.startsWith('claude-haiku') ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

  const usageLog = [];
  return {
    model,
    usageLog, // token counts of every request, for cost checks
    // One request that must come back as JSON matching `schema`.
    async json({ system, messages, schema, effort = 'medium', maxTokens = 16000 }) {
      let res;
      try {
        res = await client.beta.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages,
          output_config: { effort, format: { type: 'json_schema', schema } },
          ...fallback,
        });
      } catch (err) {
        throw friendlyError(err);
      }
      usageLog.push(res.usage);
      if (res.stop_reason === 'refusal') throw new AiError('Claude declined to work on this one.');
      if (res.stop_reason === 'max_tokens') throw new AiError('The answer ran too long and got cut off.');
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      try {
        return { data: JSON.parse(text), usage: res.usage };
      } catch {
        throw new AiError('Claude’s reply wasn’t in the expected format. Try again.');
      }
    },
  };
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new AiError('The Anthropic API key in .env wasn’t accepted.');
  if (err instanceof Anthropic.PermissionDeniedError) return new AiError('The Anthropic API key doesn’t have access to this model.');
  if (err instanceof Anthropic.RateLimitError) return new AiError('Too many AI requests right now (or the credit balance ran out). Try again in a minute.');
  if (err instanceof Anthropic.BadRequestError) return new AiError(`The AI request was rejected: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new AiError('Couldn’t reach the Anthropic API. Check the internet connection.');
  if (err instanceof Anthropic.APIError) return new AiError(`The Anthropic API had a problem (${err.status}). Try again.`);
  return err;
}
