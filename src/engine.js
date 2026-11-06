// 配信エンジン(アカウント単位): 友だち追加 → キュー投入 → 予定時刻に送信 → ゴール達成で自動停止
import { z } from 'zod';
import { GOAL_TAG, CLICK_TAG } from './planner.js';
import { q, one } from './db.js';
import { token as randomToken, unseal } from './secret.js';
import { Line } from './line.js';

const JST = 9 * 3600_000;
const DAY = 86400_000;

export function dueAt(joinedAt, step, index) {
  if (step.hour == null) return joinedAt + index;
  const midnight = Math.floor((joinedAt + JST) / DAY) * DAY - JST;
  const t = midnight + step.day * DAY + step.hour * 3600_000;
  return Math.max(t, joinedAt) + index; // index で同時刻でも順序を保つ
}

export class Engine {
  constructor({ db, accountId, line, baseUrl, ai = null, replyModel }) {
    Object.assign(this, { db, accountId: Number(accountId), line, baseUrl, ai, replyModel: replyModel || process.env.REPLY_MODEL || 'claude-sonnet-5-5' });
  }

  static async forAccount(db, account, { baseUrl, ai = null, line } = {}) {
    return new Engine({ db, accountId: account.id, line: line || new Line(unseal(account.line_token)), baseUrl, ai });
  }

  q(sql, params) { return q(this.db, sql, params); }
  one(sql, params) { return one(this.db, sql, params); }

  async scenario(id) {
    if (id == null) return null;
    return (await this.one('SELECT * FROM scenarios WHERE id = $1 AND account_id = $2', [id, this.accountId])) || null;
  }

  async live() {
    return (await this.one("SELECT * FROM scenarios WHERE account_id = $1 AND status = 'live' ORDER BY published_at DESC LIMIT 1", [this.accountId])) || null;
  }

  friend(userId) { return this.one('SELECT * FROM friends WHERE account_id = $1 AND user_id = $2', [this.accountId, userId]); }
  async hasTag(userId, tag) { return !!(await this.one('SELECT 1 FROM tags WHERE account_id = $1 AND user_id = $2 AND tag = $3', [this.accountId, userId, tag])); }
  addTag(userId, tag, now = Date.now()) { return this.q('INSERT INTO tags (account_id, user_id, tag, at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [this.accountId, userId, tag, now]); }
  log(scenarioId, userId, kind, now = Date.now()) { return this.q('INSERT INTO events (account_id, scenario_id, user_id, kind, at) VALUES ($1, $2, $3, $4, $5)', [this.accountId, scenarioId, userId, kind, now]); }

  // ---------- 公開 ----------
  async publish(id, png) {
    const sc = await this.scenario(id);
    if (!sc) throw new Error('シナリオが見つかりません');
    try { if (!/^https?:$/.test(new URL(sc.plan.cta.url).protocol)) throw 0; } catch { throw new Error('ゴールのリンク先URL(https://〜)を入れてください'); }
    let richMenuId = null;
    if (png && this.line.token) {
      richMenuId = await this.line.createRichMenu(richMenuBody(sc.plan), png);
      const old = await this.live();
      if (old?.rich_menu_id) await this.line.deleteRichMenu(old.rich_menu_id).catch(() => {});
    }
    const now = Date.now();
    await this.q("UPDATE scenarios SET status = 'archived' WHERE account_id = $1 AND status = 'live'", [this.accountId]);
    await this.q("UPDATE scenarios SET status = 'live', published_at = $1, rich_menu_id = $2 WHERE id = $3 AND account_id = $4", [now, richMenuId, id, this.accountId]);
    // シナリオ公開前に追加された友だちもここから配信に乗せる
    const waiting = await this.q('SELECT user_id FROM friends WHERE account_id = $1 AND scenario_id IS NULL AND NOT blocked', [this.accountId]);
    for (const f of waiting) {
      await this.q('UPDATE friends SET scenario_id = $1, joined_at = $2 WHERE account_id = $3 AND user_id = $4', [id, now, this.accountId, f.user_id]);
      await this.log(id, f.user_id, 'join', now);
      await this.enqueue(sc, f.user_id, now);
    }
    return this.scenario(id);
  }

  // ---------- Webhook ----------
  async handle(event, now = Date.now()) {
    const userId = event.source?.userId;
    if (!userId) return;
    if (event.type === 'follow') return this.onFollow(userId, event.replyToken, now);
    if (event.type === 'unfollow') {
      await this.q('UPDATE friends SET blocked = TRUE WHERE account_id = $1 AND user_id = $2', [this.accountId, userId]);
      return this.log((await this.friend(userId))?.scenario_id ?? null, userId, 'block', now);
    }
    let f = await this.friend(userId);
    if (!f) { await this.onFollow(userId, null, now); f = await this.friend(userId); }
    if (!f) return;
    if (event.type === 'postback') {
      const p = new URLSearchParams(event.postback?.data || '');
      if (p.get('goal')) {
        await this.markGoal(f, now);
        return this.line.reply(event.replyToken, [{ type: 'text', text: 'ありがとうございます。ご案内はここで止めますね。' }]);
      }
      if (p.get('cta')) {
        const sc = (await this.scenario(f.scenario_id)) || (await this.live());
        if (sc) return this.line.reply(event.replyToken, [this.ctaMessage(sc, f, sc.plan.cta.label)]);
        return;
      }
      const tag = p.get('tag');
      if (tag) {
        await this.addTag(userId, tag, now);
        return this.line.reply(event.replyToken, [{ type: 'text', text: '了解しました。あなたに合う内容だけをお送りします。' }]);
      }
    }
    if (event.type === 'message' && event.message?.type === 'text') return this.onText(f, event.message.text, event.replyToken, now);
  }

  async onFollow(userId, replyToken, now) {
    const sc = await this.live();
    const f = await this.friend(userId);
    if (f) {
      await this.q('UPDATE friends SET blocked = FALSE WHERE account_id = $1 AND user_id = $2', [this.accountId, userId]);
      return; // 再追加: 続きから再開(重複配信しない)
    }
    await this.q('INSERT INTO friends (account_id, user_id, token, scenario_id, joined_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
      [this.accountId, userId, randomToken(9), sc?.id ?? null, now]);
    if (!sc) return;
    await this.log(sc.id, userId, 'join', now);
    await this.enqueue(sc, userId, now);
    // 1通目はリプライで即時送信(無料枠を消費しない)
    const first = sc.plan.steps[0];
    if (replyToken && first.hour == null) {
      await this.line.reply(replyToken, [this.stepMessage(sc, await this.friend(userId), first)]);
      await this.q("UPDATE queue SET state = 'sent', done_at = $1 WHERE account_id = $2 AND user_id = $3 AND scenario_id = $4 AND step_id = $5",
        [now, this.accountId, userId, sc.id, first.id]);
    }
  }

  async enqueue(sc, userId, now) {
    for (const [i, s] of sc.plan.steps.entries()) {
      await this.q('INSERT INTO queue (account_id, user_id, scenario_id, step_id, due_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
        [this.accountId, userId, sc.id, s.id, dueAt(now, s, i)]);
    }
  }

  async markGoal(f, now = Date.now()) {
    if (f.goal_at) return;
    await this.q('UPDATE friends SET goal_at = $1 WHERE account_id = $2 AND user_id = $3', [now, this.accountId, f.user_id]);
    await this.addTag(f.user_id, GOAL_TAG, now);
    await this.q("UPDATE queue SET state = 'skipped', done_at = $1 WHERE account_id = $2 AND user_id = $3 AND state = 'wait'", [now, this.accountId, f.user_id]);
    await this.log(f.scenario_id, f.user_id, 'goal', now);
  }

  async click(f, now = Date.now()) {
    const sc = (await this.scenario(f.scenario_id)) || (await this.live());
    if (!sc) return null;
    if (!(await this.hasTag(f.user_id, CLICK_TAG))) await this.log(sc.id, f.user_id, 'click', now);
    await this.addTag(f.user_id, CLICK_TAG, now);
    const u = new URL(sc.plan.cta.url);
    u.searchParams.set('lsid', f.token);
    return u.toString();
  }

  // ---------- 自由入力への自動返信 ----------
  async onText(f, text, replyToken, now) {
    const sc = (await this.scenario(f.scenario_id)) || (await this.live());
    if (!sc) return;
    await this.log(sc.id, f.user_id, 'reply', now);
    let answer = { text: 'メッセージありがとうございます。内容を確認してご連絡します。', cta: false };
    if (this.ai) {
      try {
        const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
        const res = await this.ai.messages.parse({
          model: this.replyModel,
          max_tokens: 1000,
          output_config: { effort: 'low', format: zodOutputFormat(z.object({ text: z.string(), cta: z.boolean() })) },
          system: `LINE公式アカウントの自動返信。${sc.plan.replyPersona}\nこのアカウントのゴール: ${sc.goal}\nゴール行動: ${sc.plan.cta.label}\n配信内容の要約: ${sc.plan.steps.map((s) => s.text).join(' / ').slice(0, 1500)}\n返信は100文字以内。URLは書かない。ゴール行動を勧めるのが自然なら cta を true にする(リンクはシステムが付ける)。知らない事実は作らない。`,
          messages: [{ role: 'user', content: text.slice(0, 1000) }],
        });
        if (res.stop_reason !== 'refusal' && res.parsed_output?.text) answer = res.parsed_output;
      } catch (err) {
        console.error('[reply] AI返信に失敗:', err.message);
      }
    }
    const msgs = [{ type: 'text', text: answer.text.slice(0, 500) }];
    if (answer.cta && !f.goal_at) msgs.push(this.ctaMessage(sc, f, sc.plan.cta.label));
    return this.line.reply(replyToken, msgs);
  }

  // ---------- メッセージ組み立て ----------
  link(f) { return `${this.baseUrl}/r/${f.token}`; }

  ctaMessage(sc, f, text) {
    return {
      type: 'flex',
      altText: text,
      contents: {
        type: 'bubble',
        body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text, wrap: true, weight: 'bold' }] },
        footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', action: { type: 'uri', label: sc.plan.cta.label.slice(0, 20), uri: this.link(f) } }] },
      },
      quickReply: doneReply(),
    };
  }

  stepMessage(sc, f, step) {
    if (step.cta) {
      const m = this.ctaMessage(sc, f, step.text);
      m.contents.body.contents[0].weight = 'regular';
      m.altText = step.text.slice(0, 400);
      return m;
    }
    const msg = { type: 'text', text: step.text };
    if (step.buttons.length) {
      msg.quickReply = { items: step.buttons.map((b) => ({ type: 'action', action: { type: 'postback', label: b.label, data: `tag=${b.tag}`, displayText: b.label } })) };
    }
    return msg;
  }

  // 1件送る。戻り値: 'sent' | 'skipped' | 'failed' | 'retry'
  async deliver(item) {
    const f = await this.friend(item.user_id);
    const sc = await this.scenario(item.scenario_id);
    const step = sc?.plan.steps.find((s) => s.id === item.step_id);
    if (!f || !step || f.blocked || f.goal_at || (step.onlyTag && !(await this.hasTag(f.user_id, step.onlyTag)))) return 'skipped';
    try {
      await this.line.push(f.user_id, [this.stepMessage(sc, f, step)]);
      return 'sent';
    } catch (err) {
      console.error('[deliver]', err.message);
      return err.status === 429 || err.status >= 500 ? 'retry' : 'failed';
    }
  }

  async stats(id) {
    const n = async (kind) => (await this.one('SELECT COUNT(DISTINCT user_id)::int n FROM events WHERE account_id = $1 AND scenario_id = $2 AND kind = $3', [this.accountId, id, kind])).n;
    const joins = await n('join');
    const clicks = await n('click');
    const goals = await n('goal');
    return { joins, clicks, goals, rate: joins ? Math.round((goals / joins) * 1000) / 10 : 0 };
  }
}

// ---------- 送信ワーカー(全アカウント共通、毎分) ----------
// 期限の来た配信を取り出して 'sending' にし、二重送信を防ぐ
export async function tick(db, { now = Date.now(), baseUrl, ai = null, lineFor } = {}) {
  const due = await q(db, `UPDATE queue SET state = 'sending', done_at = $1
    WHERE id IN (SELECT id FROM queue WHERE (state = 'wait' AND due_at <= $1) OR (state = 'sending' AND done_at < $1 - 300000)
                 ORDER BY due_at LIMIT 300 FOR UPDATE SKIP LOCKED)
    RETURNING *`, [now]);
  const engines = new Map();
  let sent = 0;
  for (const item of due.sort((a, b) => a.due_at - b.due_at)) {
    let eng = engines.get(item.account_id);
    if (!eng) {
      const acc = await one(db, 'SELECT * FROM accounts WHERE id = $1', [item.account_id]);
      eng = acc && (await Engine.forAccount(db, acc, { baseUrl, ai, line: lineFor?.(acc) }));
      engines.set(item.account_id, eng);
    }
    const result = eng ? await eng.deliver(item) : 'skipped';
    if (result === 'sent') sent++;
    await q(db, 'UPDATE queue SET state = $1, done_at = $2 WHERE id = $3', [result === 'retry' ? 'wait' : result, now, item.id]);
  }
  return sent;
}

function doneReply() {
  return { items: [{ type: 'action', action: { type: 'postback', label: 'もう済ませた', data: 'goal=1', displayText: 'もう済ませました' } }] };
}

export function richMenuBody(plan) {
  const W = 2500, H = 843, w = Math.floor(W / 3);
  return {
    size: { width: W, height: H },
    selected: true,
    name: plan.title.slice(0, 300),
    chatBarText: plan.richMenu[0].label.slice(0, 14) || 'メニュー',
    areas: plan.richMenu.map((m, i) => ({
      bounds: { x: i * w, y: 0, width: i === 2 ? W - 2 * w : w, height: H },
      action: m.type === 'cta'
        ? { type: 'postback', data: 'cta=1', displayText: m.label }
        : { type: 'message', text: m.text || m.label },
    })),
  };
}
