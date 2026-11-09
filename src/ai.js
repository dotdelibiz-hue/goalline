// AIクライアント。ChatGPT(OpenAI) と Claude(Anthropic) のどちらでも動く。
//   OPENAI_API_KEY があれば ChatGPT、ANTHROPIC_API_KEY があれば Claude。
//   両方あるときは AI_PROVIDER=openai|anthropic で選ぶ(未指定なら openai)。
// 呼び出し側は ai.json({ system, user, schema }) だけを使う。結果は schema で検証済みのオブジェクト、失敗時は例外。
import { z } from 'zod';

let cached;
export async function getAi(env = process.env) {
  if (cached !== undefined) return cached;
  cached = createAi(env);
  return cached;
}

export function createAi(env = process.env, { fetch: f = globalThis.fetch } = {}) {
  const hasOpenAi = Boolean(env.OPENAI_API_KEY);
  const hasClaude = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const want = String(env.AI_PROVIDER || '').toLowerCase();
  if (hasOpenAi && (want !== 'anthropic' || !hasClaude)) return openAi(env, f);
  if (hasClaude) return claude(env);
  return null;
}

// zod → OpenAI Structured Outputs(strict) 用の JSON Schema
export function strictSchema(schema) {
  const js = z.toJSONSchema(schema);
  delete js.$schema;
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'object' && n.properties) {
      n.additionalProperties = false;
      n.required = Object.keys(n.properties);
    }
    if (n.type === 'integer') { delete n.minimum; delete n.maximum; } // zodが付ける安全整数の範囲は不要

    for (const v of Object.values(n)) Array.isArray(v) ? v.forEach(walk) : walk(v);
  };
  walk(js);
  return js;
}

function openAi(env, fetchFn) {
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const models = { plan: env.PLANNER_MODEL || env.OPENAI_MODEL || 'gpt-5-mini', reply: env.REPLY_MODEL || env.OPENAI_MODEL || 'gpt-5-mini' };
  return {
    provider: 'openai',
    models,
    async json({ system, user, schema, name = 'result', model, maxTokens = 4000, effort = 'low', timeout = 40_000 }) {
      const res = await fetchFn(`${base}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model || models.plan,
          instructions: system,
          input: user,
          max_output_tokens: maxTokens,
          reasoning: { effort },
          store: false,
          text: { format: { type: 'json_schema', name, strict: true, schema: strictSchema(schema) } },
        }),
        signal: AbortSignal.timeout(timeout),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body.error?.message || 'request failed'}`);
      const parts = (body.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []);
      if (parts.some((p) => p.type === 'refusal')) throw new Error('OpenAI refused');
      const text = parts.filter((p) => p.type === 'output_text').map((p) => p.text).join('');
      if (!text) throw new Error(`OpenAI empty output (${body.status || 'unknown'})`);
      return schema.parse(JSON.parse(text));
    },
  };
}

function claude(env) {
  let sdk;
  const models = { plan: env.PLANNER_MODEL || 'claude-sonnet-5-5', reply: env.REPLY_MODEL || 'claude-sonnet-5-5' };
  return {
    provider: 'anthropic',
    models,
    async json({ system, user, schema, model, maxTokens = 4000, effort = 'low', timeout = 40_000, thinking }) {
      if (!sdk) {
        const [{ default: Anthropic }, { zodOutputFormat }] = await Promise.all([
          import('@anthropic-ai/sdk'), import('@anthropic-ai/sdk/helpers/zod'),
        ]);
        sdk = { client: new Anthropic(), zodOutputFormat };
      }
      const res = await sdk.client.messages.parse({
        model: model || models.plan,
        max_tokens: maxTokens,
        ...(thinking ? { thinking: { type: 'adaptive' } } : {}),
        output_config: { effort, format: sdk.zodOutputFormat(schema) },
        system,
        messages: [{ role: 'user', content: user }],
      }, { timeout, maxRetries: 0 });
      if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error('Claude returned no output');
      return res.parsed_output;
    },
  };
}
