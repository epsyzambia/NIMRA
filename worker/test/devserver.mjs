// Local demo: API on :8788 (real Worker code + fake MySQL connection) and the site on :8080.   Run:  npm run demo
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import worker from '../src/index.js';
import { FILES } from './shim.mjs';

const SITE = new URL('../../site/', import.meta.url).pathname;
const env = { FILES, ALLOWED_ORIGINS: 'http://localhost:8080', COOKIE_DOMAIN: '', SETUP_TOKEN: 'demo' };

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request('http://localhost:8788' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks), duplex: 'half' }), env);
  const h = {}; r.headers.forEach((v, k) => { h[k] = v; }); const sc = r.headers.getSetCookie?.(); if (sc?.length) h['set-cookie'] = sc;
  res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8788);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname; if (p === '/') p = '/index.html';
  const f = join(SITE, p);
  if (!f.startsWith(SITE) || !existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  let body = readFileSync(f);
  if (p === '/js/config.js') body = "window.NIMRA_API='http://localhost:8788';";
  res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream' }); res.end(body);
}).listen(8080);

// demo data: admin 0971000000/1234, institution 0972000001/2222, supplier 0973000001/3333
const api = async (m, p, data, cookie) => { const r = await worker.fetch(new Request('http://localhost:8788' + p, { method: m, headers: { origin: 'http://localhost:8080', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: data ? JSON.stringify(data) : undefined }), env); return r; };
await api('POST', '/api/setup', { token: 'demo', phone: '0971000000', pin: '1234', name: 'Admin' });
const l = await api('POST', '/api/login', { phone: '0971000000', pin: '1234' }); const ck = l.headers.get('set-cookie').split(';')[0];
await api('POST', '/api/accounts', { kind: 'Institution', org: 'Ministry of Health', name: 'Mary', phone: '0972000001', pin: '2222' }, ck);
await api('POST', '/api/accounts', { kind: 'Supplier', org: 'Lusaka Supplies', name: 'Sam', phone: '0973000001', pin: '3333' }, ck);
console.log('Site http://localhost:8080   API http://localhost:8788\nAdmin 0971000000/1234  Institution 0972000001/2222  Supplier 0973000001/3333');
