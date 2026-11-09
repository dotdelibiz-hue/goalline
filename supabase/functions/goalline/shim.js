// Node 向けコードを Supabase Edge(Deno) で動かすための下準備。
// Supabase では環境変数を書き換えられないので、書き換え可能なコピーを process.env として見せる
import { Buffer } from 'node:buffer';
import nodeProcess from 'node:process';

const env = { ...nodeProcess.env };
const proc = new Proxy(nodeProcess, { get: (t, k) => (k === 'env' ? env : Reflect.get(t, k)) });
Object.defineProperty(globalThis, 'process', { value: proc, configurable: true, writable: true });
globalThis.Buffer ??= Buffer;

// GoalLine の固定設定(秘密ではないもの)
const SUPA = 'https://bufuycdrptcymmmdubex.supabase.co';
env.DB_SCHEMA = 'goalline';
env.BASE_URL = `${SUPA}/functions/v1/goalline`;
env.ALLOWED_ORIGINS = 'https://dotdelibiz-hue.github.io';
// AIキーは GoalLine 専用の GL_OPENAI_API_KEY だけを使う(同居プロジェクトの別キーを使わない)
env.OPENAI_API_KEY = env.GL_OPENAI_API_KEY || '';
env.ANTHROPIC_API_KEY = env.GL_ANTHROPIC_API_KEY || '';
delete env.ANTHROPIC_AUTH_TOKEN;
env.AI_PROVIDER = 'openai';
