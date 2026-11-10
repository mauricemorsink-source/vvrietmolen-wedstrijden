// Lokale testserver (zonder Vercel-account). Gebruikt een lokaal SQLite-bestand (local.db)
// tenzij TURSO_DATABASE_URL is ingesteld.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { handleRequest } from '../src/app.js';
import { makeEnv } from '../src/db.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const port = parseInt(process.env.PORT || '3000', 10);

createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const request = new Request('http://' + (req.headers.host || 'localhost:' + port) + req.url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) || !body.length ? undefined : body,
    });
    const env = await makeEnv();
    const pending = [];
    const response = await handleRequest(request, env, { waitUntil: (p) => pending.push(Promise.resolve(p).catch(console.error)) });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    await Promise.all(pending);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
}).listen(port, () => console.log('Draait op http://localhost:' + port + '  (beheer: /admin)'));
