// Node 向けコードを Deno で動かすための最小限の下準備
import { Buffer } from 'node:buffer';
import process from 'node:process';
globalThis.Buffer ??= Buffer;
globalThis.process ??= process;

// GoalLine の固定設定(秘密ではないもの)
const SUPA = 'https://bufuycdrptcymmmdubex.supabase.co';
process.env.DB_SCHEMA = 'goalline';
process.env.BASE_URL = `${SUPA}/functions/v1/goalline`;
process.env.ALLOWED_ORIGINS = 'https://dotdelibiz-hue.github.io';
// AIキーは GoalLine 専用の GL_OPENAI_API_KEY だけを使う(同居プロジェクトの別キーを使わない)
process.env.OPENAI_API_KEY = process.env.GL_OPENAI_API_KEY || '';
process.env.ANTHROPIC_API_KEY = process.env.GL_ANTHROPIC_API_KEY || '';
delete process.env.ANTHROPIC_AUTH_TOKEN;
process.env.AI_PROVIDER = 'openai';
