// HTTPの入口(Web標準の Request → Response)。Netlify Functions からもテストからも同じものを呼ぶ
import { q, one } from './db.js';
import { Line, verifySignature } from './line.js';
import { Engine } from './engine.js';
import { draftPlan, normalize } from './planner.js';
import { hashPassword, checkPassword, token, sha, seal, unseal } from './secret.js';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const SESSION_DAYS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

export function createApp({ db, ai = null, lineFor = (acc) => new Line(unseal(acc.line_token)), baseUrl: fixedBase } = {}) {
  const baseOf = (req) => (fixedBase || process.env.BASE_URL || process.env.URL || new URL(req.url).origin).replace(/\/$/, '');

  // 回数制限(ログイン試行・AI設計の乱用防止)
  async function limit(key, max, windowMs) {
    const now = Date.now();
    const row = await one(db, `INSERT INTO login_attempts (key, n, reset_at) VALUES ($1, 1, $2)
      ON CONFLICT (key) DO UPDATE SET n = CASE WHEN login_attempts.reset_at < $3 THEN 1 ELSE login_attempts.n + 1 END,
        reset_at = CASE WHEN login_attempts.reset_at < $3 THEN $2 ELSE login_attempts.reset_at END
      RETURNING n`, [key, now + windowMs, now]);
    if (row.n > max) throw new HttpError(429, '短時間に操作が多すぎます。しばらくしてからお試しください');
  }

  async function startSession(accountId, req) {
    const t = token();
    await q(db, 'INSERT INTO sessions (id, account_id, expires_at) VALUES ($1, $2, $3)', [sha(t), accountId, Date.now() + SESSION_DAYS * 86400_000]);
    const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
    return `gl_sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`;
  }

  async function currentAccount(req) {
    const m = /(?:^|;\s*)gl_sid=([^;]+)/.exec(req.headers.get('cookie') || '');
    if (!m) return null;
    return (await one(db, `SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id = $1 AND s.expires_at > $2`, [sha(m[1]), Date.now()])) || null;
  }

  async function state(acc, req) {
    const eng = new Engine({ db, accountId: acc.id });
    const live = await eng.live();
    const draft = await one(db, "SELECT * FROM scenarios WHERE account_id = $1 AND status = 'draft' ORDER BY id DESC LIMIT 1", [acc.id]);
    return {
      email: acc.email,
      line: Boolean(acc.line_secret && acc.line_token),
      ai: Boolean(ai),
      friendUrl: acc.friend_url || '',
      webhookUrl: `${baseOf(req)}/webhook/${acc.hook_key}`,
      cvTag: `<img src="${baseOf(req)}/cv?lsid=LSID" width="1" height="1" alt="">`,
      live: live ? { ...live, stats: await eng.stats(live.id) } : null,
      draft: draft || null,
    };
  }

  const body = async (req) => {
    const text = await req.text();
    if (text.length > 3_000_000) throw new HttpError(413, 'データが大きすぎます');
    try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, '不正なリクエストです'); }
  };

  async function handle(req, { waitUntil = (p) => p } = {}) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    let m;
    try {
      // ---------- 公開エンドポイント(LINE・計測) ----------
      if (method === 'POST' && (m = /^\/webhook\/([\w-]+)$/.exec(path))) {
        const acc = await one(db, 'SELECT * FROM accounts WHERE hook_key = $1', [m[1]]);
        const raw = Buffer.from(await req.arrayBuffer());
        if (!acc || !verifySignature(raw, unseal(acc.line_secret), req.headers.get('x-line-signature'))) return new Response('bad signature', { status: 401 });
        const { events = [] } = JSON.parse(raw.toString() || '{}');
        const eng = await Engine.forAccount(db, acc, { baseUrl: baseOf(req), ai, line: lineFor(acc) });
        // LINEには即時200を返し、処理はレスポンス後に続ける
        waitUntil((async () => { for (const ev of events) await eng.handle(ev).catch((e) => console.error('[webhook]', e.message)); })());
        return new Response('ok');
      }
      if (method === 'GET' && (m = /^\/r\/([\w-]+)$/.exec(path))) {
        const f = await one(db, 'SELECT * FROM friends WHERE token = $1', [m[1]]);
        const to = f && (await new Engine({ db, accountId: f.account_id }).click(f));
        return to ? new Response(null, { status: 302, headers: { Location: to } }) : new Response('not found', { status: 404 });
      }
      if (method === 'GET' && path === '/cv') {
        const f = await one(db, 'SELECT * FROM friends WHERE token = $1', [url.searchParams.get('lsid') || '']);
        if (f) await new Engine({ db, accountId: f.account_id }).markGoal(f);
        return new Response(GIF, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
      }
      if (path === '/api/health') return json({ ok: true });

      if (!path.startsWith('/api/')) return new Response('not found', { status: 404 });

      // 別サイトからの書き込みを拒否
      if (method !== 'GET') {
        const origin = req.headers.get('origin');
        if (origin && origin !== url.origin && origin !== baseOf(req)) throw new HttpError(403, '不正なリクエスト元です');
      }

      // ---------- 登録・ログイン ----------
      if (method === 'POST' && (path === '/api/signup' || path === '/api/login')) {
        const { email: rawEmail, password } = await body(req);
        const email = String(rawEmail || '').trim().toLowerCase();
        const pw = String(password || '');
        if (!EMAIL_RE.test(email) || email.length > 200) throw new HttpError(400, 'メールアドレスを確認してください');
        const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || '';
        await limit(`auth:${email}`, 10, 15 * 60_000);
        if (ip) await limit(`auth-ip:${ip}`, 50, 15 * 60_000);
        let acc;
        if (path === '/api/signup') {
          if (pw.length < 8) throw new HttpError(400, 'パスワードは8文字以上にしてください');
          if (await one(db, 'SELECT 1 FROM accounts WHERE email = $1', [email])) throw new HttpError(409, 'このメールアドレスは登録済みです。ログインしてください');
          acc = await one(db, 'INSERT INTO accounts (email, pw_hash, hook_key, created_at) VALUES ($1, $2, $3, $4) RETURNING *', [email, await hashPassword(pw), token(18), Date.now()]);
        } else {
          acc = await one(db, 'SELECT * FROM accounts WHERE email = $1', [email]);
          if (!acc || !(await checkPassword(pw, acc.pw_hash))) throw new HttpError(401, 'メールアドレスかパスワードが違います');
        }
        return json(await state(acc, req), 200, { 'Set-Cookie': await startSession(acc.id, req) });
      }
      if (method === 'POST' && path === '/api/logout') {
        const c = /(?:^|;\s*)gl_sid=([^;]+)/.exec(req.headers.get('cookie') || '');
        if (c) await q(db, 'DELETE FROM sessions WHERE id = $1', [sha(c[1])]);
        return json({ ok: true }, 200, { 'Set-Cookie': 'gl_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
      }

      // ---------- ログイン後 ----------
      const acc = await currentAccount(req);
      if (!acc) throw new HttpError(401, 'ログインしてください');

      if (method === 'GET' && path === '/api/state') return json(await state(acc, req));

      if (method === 'POST' && path === '/api/line') {
        const { secret, token: tk } = await body(req);
        const s = String(secret || '').trim();
        const t = String(tk || '').trim();
        if (!s || !t) throw new HttpError(400, 'チャネルシークレットとアクセストークンを入れてください');
        const line = lineFor({ line_token: t });
        let info;
        try { info = await line.botInfo(); } catch { throw new HttpError(400, 'アクセストークンが正しくないようです。LINE Developers で再発行してコピーしてください'); }
        try { await line.setWebhook(`${baseOf(req)}/webhook/${acc.hook_key}`); } catch (e) { console.error('[line] webhook設定に失敗', e.message); }
        const friendUrl = info.basicId ? `https://line.me/R/ti/p/${encodeURIComponent(info.basicId)}` : '';
        const next = await one(db, 'UPDATE accounts SET line_secret = $1, line_token = $2, friend_url = $3 WHERE id = $4 RETURNING *', [seal(s), seal(t), friendUrl, acc.id]);
        return json(await state(next, req));
      }

      if (method === 'POST' && path === '/api/draft') {
        const { goal } = await body(req);
        await limit(`draft:${acc.id}`, 30, 86400_000);
        const plan = await draftPlan(goal, { client: ai });
        await q(db, "DELETE FROM scenarios WHERE account_id = $1 AND status = 'draft'", [acc.id]);
        await q(db, 'INSERT INTO scenarios (account_id, goal, plan, created_at) VALUES ($1, $2, $3, $4)', [acc.id, String(goal).trim().slice(0, 500), plan, Date.now()]);
        return json(await state(acc, req));
      }
      if (method === 'PUT' && (m = /^\/api\/draft\/(\d+)$/.exec(path))) {
        const { plan } = await body(req);
        let fixed;
        try { fixed = { ...normalize(plan), source: plan.source }; } catch { throw new HttpError(400, '下書きの形式が正しくありません'); }
        await q(db, "UPDATE scenarios SET plan = $1 WHERE id = $2 AND account_id = $3 AND status = 'draft'", [fixed, Number(m[1]), acc.id]);
        return json(await state(acc, req));
      }
      if (method === 'POST' && (m = /^\/api\/publish\/(\d+)$/.exec(path))) {
        const { png } = await body(req);
        if (!acc.line_secret || !acc.line_token) throw new HttpError(400, '先にLINE公式アカウントを接続してください');
        const eng = await Engine.forAccount(db, acc, { baseUrl: baseOf(req), line: lineFor(acc) });
        try {
          await eng.publish(Number(m[1]), png ? Buffer.from(String(png).replace(/^data:image\/png;base64,/, ''), 'base64') : null);
        } catch (e) { throw new HttpError(400, e.message); }
        return json(await state(acc, req));
      }
      if (method === 'DELETE' && path === '/api/account') {
        await q(db, 'DELETE FROM accounts WHERE id = $1', [acc.id]);
        return json({ ok: true }, 200, { 'Set-Cookie': 'gl_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error('[http]', err);
      return json({ error: 'サーバーでエラーが起きました。時間をおいてお試しください' }, 500);
    }
  }

  return { handle };
}
