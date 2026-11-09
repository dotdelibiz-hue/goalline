// Postgres接続。Supabase は SUPABASE_DB_URL、テストは DATABASE_URL の素のPostgres、Netlify は Netlify Database
import pg from 'pg';

// BIGINT(ミリ秒)を数値で受け取る
pg.types.setTypeParser(20, (v) => Number(v));

let pool;
export async function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (url) {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    // Supabase では専用スキーマ(DB_SCHEMA=goalline)に閉じ込める
    const schema = process.env.DB_SCHEMA;
    if (schema) pool.on('connect', (c) => c.query(`SET search_path TO "${schema.replace(/"/g, '')}"`));
  } else {
    const mod = '@netlify/database';
    const { getDatabase } = await import(mod);
    pool = getDatabase().pool;
  }
  return pool;
}

export async function q(db, text, params = []) {
  const { rows } = await db.query(text, params);
  return rows;
}

export async function one(db, text, params = []) {
  return (await q(db, text, params))[0];
}
