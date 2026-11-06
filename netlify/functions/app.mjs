import { getPool } from '../../src/db.js';
import { getAi } from '../../src/ai.js';
import { createApp } from '../../src/app.js';

let app;
export default async (req, context) => {
  app ||= createApp({ db: await getPool(), ai: await getAi() });
  return app.handle(req, { waitUntil: (p) => context.waitUntil(p) });
};

export const config = { path: ['/api/*', '/webhook/*', '/r/*', '/cv'] };
