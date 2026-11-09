// Supabase Edge Function の本体。API・LINE Webhook・計測リダイレクト・毎分の配信(/tick)をまとめて受ける
import './shim.js';
import { getPool } from '../../../src/db.js';
import { getAi } from '../../../src/ai.js';
import { createApp } from '../../../src/app.js';
import { tick } from '../../../src/engine.js';

const BASE = (process.env.BASE_URL || '').replace(/\/$/, '');
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);

// 秘密の値(APP_SECRET・CRON_KEY・OPENAI_API_KEY)は goalline.config テーブルから読む。
// プロジェクト共通のEdge Function Secretsを汚さないため
let loaded;
const loadConfig = () => (loaded ||= (async () => {
  const { rows } = await (await getPool()).query('SELECT key, value FROM config');
  for (const r of rows) process.env[r.key] = r.value;
})().catch((e) => { loaded = undefined; throw e; }));

let app;

function cors(req, res) {
  const origin = req.headers.get('origin') || '';
  if (!ORIGINS.includes(origin)) return res;
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Access-Control-Allow-Headers', 'content-type, x-gl-token');
  h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers: h });
}

Deno.serve(async (req) => {
  try { return await serve(req); } catch (e) {
    console.error('[goalline]', e?.stack || e);
    return cors(req, Response.json({ error: 'サーバーでエラーが起きました。時間をおいてお試しください' }, { status: 500 }));
  }
});

async function serve(req) {
  // /functions/v1/goalline/xxx → /xxx
  const u = new URL(req.url);
  const path = u.pathname.replace(/^\/(functions\/v1\/)?goalline/, '') || '/';
  if (req.method === 'OPTIONS') return cors(req, new Response(null, { status: 204 }));

  await loadConfig();
  if (path === '/tick' && req.method === 'POST') {
    if (!process.env.CRON_KEY || req.headers.get('x-cron-key') !== process.env.CRON_KEY) return new Response('forbidden', { status: 403 });
    const sent = await tick(await getPool(), { baseUrl: BASE, ai: await getAi() });
    return Response.json({ sent });
  }

  app ||= createApp({ db: await getPool(), ai: await getAi(), baseUrl: BASE });
  const inner = new Request(new URL(BASE).origin + path + u.search, req);
  // EdgeRuntime はSupabaseの実行環境が用意する
  const res = await app.handle(inner, { waitUntil: (p) => EdgeRuntime.waitUntil(p) });
  return cors(req, res);
}
