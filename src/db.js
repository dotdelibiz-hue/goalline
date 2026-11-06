// Postgres接続。本番は Netlify Database、テストは DATABASE_URL の素のPostgres
import pg from 'pg';

// BIGINT(ミリ秒)を数値で受け取る
pg.types.setTypeParser(20, (v) => Number(v));

let pool;
export async function getPool() {
  if (pool) return pool;
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  } else {
    const { getDatabase } = await import('@netlify/database');
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
