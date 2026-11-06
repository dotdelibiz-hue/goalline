// 実際のPostgresに対して、登録から配信・ゴール停止までを通しで確認する
// 実行: DATABASE_URL=postgres://... npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { tick, dueAt } from '../src/engine.js';
import { draftPlan, normalize, templatePlan, extractUrl } from '../src/planner.js';
import { seal, unseal } from '../src/secret.js';
import '../src/db.js';

const BASE = 'https://app.test';
const GOAL_URL = 'https://example.com/reserve';
let db;
const lines = new Map(); // token -> FakeLine

class FakeLine {
  calls = [];
  constructor(token) { this.token = token; }
  async reply(_, messages) { this.calls.push({ kind: 'reply', messages }); }
  async push(to, messages) { this.calls.push({ kind: 'push', to, messages }); }
  async botInfo() { if (this.token === 'bad') throw new Error('401'); return { basicId: '@abc' }; }
  async setWebhook(url) { this.webhook = url; }
  async createRichMenu() { return 'rm1'; }
  async deleteRichMenu() {}
}
const lineFor = (acc) => {
  const t = unseal(acc.line_token);
  if (!lines.has(t)) lines.set(t, new FakeLine(t));
  return lines.get(t);
};

before(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL を設定してください');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.query(readFileSync(new URL('../netlify/database/migrations/20261107000000_init.sql', import.meta.url), 'utf8'));
  await admin.end();
  db = new pg.Pool({ connectionString: url });
});
after(() => db.end());

function client(app) {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await app.handle(new Request(BASE + path, {
      method, headers: { cookie, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }), { waitUntil: (p) => pending.push(p) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, res, body: type.includes('json') ? await res.json() : null };
  };
  const pending = [];
  call.settle = async () => { await Promise.all(pending.splice(0)); };
  return call;
}

test('テンプレート下書きと正規化', async () => {
  assert.equal(extractUrl(`整体院の予約を増やしたい ${GOAL_URL}`), GOAL_URL);
  const plan = await draftPlan(`整体院の予約を増やしたい ${GOAL_URL}`);
  assert.equal(plan.source, 'template');
  assert.equal(plan.cta.url, GOAL_URL);
  assert.equal(plan.richMenu[0].type, 'cta');
  const raw = templatePlan('x');
  raw.steps[2].onlyTag = 'unknown';
  assert.equal(normalize(raw).steps[2].onlyTag, null);
  const join = Date.parse('2026-11-04T23:30:00+09:00');
  assert.equal(new Date(dueAt(join, { day: 1, hour: 20 }, 0)).toISOString(), '2026-11-05T11:00:00.000Z');
});

test('LINEトークンは暗号化して保存できる', () => {
  process.env.APP_SECRET = 'k';
  const s = seal('abc');
  assert.ok(s.startsWith('e1:'));
  assert.equal(unseal(s), 'abc');
});

test('登録→ログイン必須→LINE接続→設計→編集→公開→配信→ゴールで停止', async () => {
  process.env.APP_SECRET = 'k';
  const app = createApp({ db, lineFor, baseUrl: BASE });
  const call = client(app);

  assert.equal((await call('GET', '/api/state')).status, 401);
  assert.equal((await call('POST', '/api/signup', { email: 'a@example.com', password: 'short' })).status, 400);
  let r = await call('POST', '/api/signup', { email: 'A@example.com', password: 'password123' });
  assert.equal(r.status, 200);
  assert.equal(r.body.email, 'a@example.com');
  assert.equal((await call('POST', '/api/signup', { email: 'a@example.com', password: 'password123' })).status, 409);

  // 別サイトからの書き込みは拒否
  assert.equal((await call('POST', '/api/draft', { goal: 'x' }, { origin: 'https://evil.test' })).status, 403);

  // LINE接続: 不正トークンは弾き、正しければWebhookも自動設定
  assert.equal((await call('POST', '/api/line', { secret: 'sec', token: 'bad' })).status, 400);
  r = await call('POST', '/api/line', { secret: 'sec', token: 'tokA' });
  assert.equal(r.body.line, true);
  assert.equal(r.body.friendUrl, 'https://line.me/R/ti/p/%40abc');
  assert.equal(lines.get('tokA').webhook, r.body.webhookUrl);
  const stored = (await db.query('SELECT line_token FROM accounts')).rows[0].line_token;
  assert.ok(stored.startsWith('e1:'), 'トークンは平文で保存しない');

  r = await call('POST', '/api/draft', { goal: `パーソナルジムの体験予約を増やしたい ${GOAL_URL}` });
  const draft = r.body.draft;
  assert.equal(draft.plan.cta.url, GOAL_URL);
  draft.plan.steps[1].text = '編集した本文';
  r = await call('PUT', `/api/draft/${draft.id}`, { plan: draft.plan });
  assert.equal(r.body.draft.plan.steps[1].text, '編集した本文');
  r = await call('POST', `/api/publish/${draft.id}`, { png: 'data:image/png;base64,AAAA' });
  assert.equal(r.status, 200);
  assert.equal(r.body.live.rich_menu_id, 'rm1');

  // Webhook: 署名が違えば401、正しければ友だち追加→1通目をリプライ
  const hook = new URL(r.body.webhookUrl).pathname;
  const ev = (events) => JSON.stringify({ events });
  const sig = (b) => createHmac('sha256', 'sec').update(b).digest('base64');
  let b = ev([{ type: 'follow', source: { userId: 'U1' }, replyToken: 'r1' }]);
  assert.equal((await call('POST', hook, b, { 'x-line-signature': 'bad' })).status, 401);
  assert.equal((await call('POST', hook, b, { 'x-line-signature': sig(b) })).status, 200);
  await call.settle();
  const line = lines.get('tokA');
  assert.equal(line.calls[0].kind, 'reply');
  assert.equal(line.calls[0].messages[0].quickReply.items.length, 3);

  b = ev([{ type: 'postback', source: { userId: 'U1' }, replyToken: 'r2', postback: { data: 'tag=hot' } }]);
  await call('POST', hook, b, { 'x-line-signature': sig(b) });
  await call.settle();

  // 未来時刻で毎分ワーカーを回す: 関心「hot」向けと全員向けが届く
  const joined = (await db.query("SELECT joined_at FROM friends WHERE user_id = 'U1'")).rows[0].joined_at;
  const sent = await tick(db, { now: joined + 2 * 86400_000, baseUrl: BASE, lineFor });
  assert.ok(sent >= 2);
  assert.equal(await tick(db, { now: joined + 2 * 86400_000, baseUrl: BASE, lineFor }), 0, '二重送信しない');
  const cta = line.calls.find((c) => c.kind === 'push' && c.messages[0].type === 'flex');
  const link = cta.messages[0].contents.footer.contents[0].action.uri;
  assert.ok(link.startsWith(`${BASE}/r/`));

  // クリック計測 → 達成タグ → 以降は止まる
  r = await call('GET', new URL(link).pathname);
  assert.equal(r.status, 302);
  const lsid = new URL(r.res.headers.get('location')).searchParams.get('lsid');
  assert.ok(lsid);
  assert.equal((await call('GET', `/cv?lsid=${lsid}`)).status, 200);
  assert.equal(await tick(db, { now: joined + 60 * 86400_000, baseUrl: BASE, lineFor }), 0);
  r = await call('GET', '/api/state');
  assert.deepEqual({ ...r.body.live.stats }, { joins: 1, clicks: 1, goals: 1, rate: 100 });

  // ログアウト後は見られない
  await call('POST', '/api/logout', {});
  assert.equal((await call('GET', '/api/state')).status, 401);
  r = await call('POST', '/api/login', { email: 'a@example.com', password: 'wrongpass' });
  assert.equal(r.status, 401);
  r = await call('POST', '/api/login', { email: 'a@example.com', password: 'password123' });
  assert.equal(r.body.live.stats.goals, 1);
});

test('アカウント同士のデータは混ざらない', async () => {
  const app = createApp({ db, lineFor, baseUrl: BASE });
  const a = client(app);
  const b = client(app);
  let r = await a('POST', '/api/signup', { email: 'x1@example.com', password: 'password123' });
  await a('POST', '/api/draft', { goal: `予約 ${GOAL_URL}` });
  r = await b('POST', '/api/signup', { email: 'x2@example.com', password: 'password123' });
  assert.equal(r.body.draft, null);
  const aDraft = (await a('GET', '/api/state')).body.draft;
  // 他人の下書きは編集できない
  const plan = { ...aDraft.plan, title: '乗っ取り' };
  await b('PUT', `/api/draft/${aDraft.id}`, { plan });
  assert.notEqual((await a('GET', '/api/state')).body.draft.plan.title, '乗っ取り');
  assert.notEqual((await a('GET', '/api/state')).body.webhookUrl, (await b('GET', '/api/state')).body.webhookUrl);
});

test('ログイン試行は回数制限される', async () => {
  const app = createApp({ db, lineFor, baseUrl: BASE });
  const c = client(app);
  let last;
  for (let i = 0; i < 11; i++) last = await c('POST', '/api/login', { email: 'nobody@example.com', password: 'xxxxxxxx' });
  assert.equal(last.status, 429);
});
