import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAi, strictSchema } from '../src/ai.js';
import { draftPlan, PlanSchema } from '../src/planner.js';

const fakePlan = {
  title: '初回予約', chain: [{ stage: '興味', state: '腰痛を治したい' }],
  cta: { label: '予約する', url: '' }, segments: [{ tag: 'back', label: '腰' }],
  steps: [
    { id: 'x', day: 0, hour: null, text: 'ようこそ', buttons: [{ label: '腰', tag: 'back' }], cta: false, onlyTag: null },
    { id: 'y', day: 1, hour: 20, text: '予約はこちら', buttons: [], cta: true, onlyTag: null },
  ],
  richMenu: [{ label: '予約', type: 'cta', text: '' }, { label: '料金', type: 'message', text: '料金' }, { label: '場所', type: 'message', text: '場所' }],
  replyPersona: '丁寧に。施術の範囲で答える。',
};

function mockFetch(payload, calls = []) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify({ status: 'completed', output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] },
    ] }), { status: 200 });
  };
}

test('strictSchema: 全objectが additionalProperties:false かつ全キー必須', () => {
  const js = strictSchema(PlanSchema);
  const check = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'object') {
      assert.equal(n.additionalProperties, false);
      assert.deepEqual(n.required.sort(), Object.keys(n.properties).sort());
    }
    Object.values(n).forEach((v) => (Array.isArray(v) ? v.forEach(check) : check(v)));
  };
  check(js);
  assert.equal(js.$schema, undefined);
});

test('OPENAI_API_KEY があれば ChatGPT で下書きする', async () => {
  const calls = [];
  const ai = createAi({ OPENAI_API_KEY: 'sk-test' }, { fetch: mockFetch(fakePlan, calls) });
  assert.equal(ai.provider, 'openai');
  const plan = await draftPlan('整体院の予約を増やしたい https://example.com/r', { client: ai });
  assert.equal(plan.source, 'ai');
  assert.equal(plan.provider, 'openai');
  assert.equal(plan.cta.url, 'https://example.com/r');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].headers.authorization, 'Bearer sk-test');
  assert.equal(calls[0].body.text.format.type, 'json_schema');
  assert.equal(calls[0].body.text.format.strict, true);
  assert.equal(calls[0].body.model, 'gpt-5-mini');
});

test('ChatGPT がエラーでもテンプレートで下書きできる', async () => {
  const ai = createAi({ OPENAI_API_KEY: 'sk-test' }, { fetch: async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }) });
  const plan = await draftPlan('整体院の予約を増やしたい', { client: ai });
  assert.equal(plan.source, 'template');
});

test('プロバイダの選び方', () => {
  assert.equal(createAi({}), null);
  assert.equal(createAi({ ANTHROPIC_API_KEY: 'a' }).provider, 'anthropic');
  assert.equal(createAi({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }).provider, 'openai');
  assert.equal(createAi({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', AI_PROVIDER: 'anthropic' }).provider, 'anthropic');
  assert.equal(createAi({ OPENAI_API_KEY: 'o', OPENAI_MODEL: 'gpt-x' }).models.reply, 'gpt-x');
});
