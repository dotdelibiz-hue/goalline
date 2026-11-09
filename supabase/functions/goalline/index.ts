// Supabase Edge Function の入口。API・LINE Webhook・計測リダイレクト・毎分の配信(/tick)をまとめて受ける
import './shim.js';
import { getPool } from './src/db.js';
import { getAi } from './src/ai.js';
import { createApp } from './src/app.js';
import { tick } from './src/engine.js';

const BASE = (Deno.env.get('BASE_URL') || '').replace(/\/$/, '');
const ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);

let app: { handle: (req: Request, o?: unknown) => Promise<Response> } | undefined;

function cors(req: Request, res: Response) {
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
  // /functions/v1/goalline/xxx → /xxx
  const u = new URL(req.url);
  const path = u.pathname.replace(/^\/(functions\/v1\/)?goalline/, '') || '/';
  if (req.method === 'OPTIONS') return cors(req, new Response(null, { status: 204 }));

  if (path === '/tick' && req.method === 'POST') {
    if (req.headers.get('x-cron-key') !== Deno.env.get('CRON_KEY')) return new Response('forbidden', { status: 403 });
    const sent = await tick(await getPool(), { baseUrl: BASE, ai: await getAi() });
    return Response.json({ sent });
  }

  app ||= createApp({ db: await getPool(), ai: await getAi(), baseUrl: BASE });
  const inner = new Request(BASE + path + u.search, req);
  // @ts-ignore EdgeRuntime はSupabaseの実行環境が用意する
  const res = await app.handle(inner, { waitUntil: (p: Promise<unknown>) => EdgeRuntime.waitUntil(p) });
  return cors(req, res);
});
