// 毎分、期限の来たステップ配信を送る
import { getPool } from '../../src/db.js';
import { getAi } from '../../src/ai.js';
import { tick } from '../../src/engine.js';

export default async () => {
  const sent = await tick(await getPool(), { baseUrl: (process.env.BASE_URL || process.env.URL || '').replace(/\/$/, ''), ai: await getAi() });
  console.log(`[tick] sent=${sent}`);
};

export const config = { schedule: '* * * * *' };
