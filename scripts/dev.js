// ローカル確認用: public/ を配信し、それ以外を app.handle に渡す
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { getPool } from '../src/db.js';
import { createApp } from '../src/app.js';

const app = createApp({ db: await getPool() });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!/^\/(api|webhook|r)\/|^\/cv$/.test(url.pathname)) {
    let p = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    if (!extname(p)) p += p === '/app' ? '/index.html' : '.html';
    try { const b = await readFile(join('public', p)); res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream' }); return res.end(b); }
    catch { res.writeHead(404); return res.end('not found'); }
  }
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await app.handle(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(Number(process.env.PORT || 8888));
const port = Number(process.env.PORT || 8888);
console.log(`http://localhost:${port}`);
