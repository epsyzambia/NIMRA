// Local stand-ins so the real Worker code runs on your computer WITHOUT MySQL:
//  - a fake "mysql2" connection backed by node:sqlite (translates the few MySQL-only bits the Worker uses)
//  - a Map for R2.
// This checks the application logic. It does NOT check the MySQL SQL or the migration: run those against a real MySQL.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { setConnector } from '../src/db.js';

export const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('./sqlite-schema.sql', import.meta.url), 'utf8'));

const conflictKey = { login_attempts: 'phone', institution_settings: 'org_id' };
function translate(sql) {
  let q = sql.replace(/`/g, '').replace(/\bNOW\(\)/g, "datetime('now')").replace(/\bUTC_TIMESTAMP\(\)/g, "datetime('now')");
  q = q.replace(/\bINSERT IGNORE\b/, 'INSERT OR IGNORE');
  q = q.replace(/\bSTART TRANSACTION\b/, 'BEGIN');
  const m = /INSERT INTO (\w+)[\s\S]*ON DUPLICATE KEY UPDATE/.exec(q);
  if (m) q = q.replace('ON DUPLICATE KEY UPDATE', `ON CONFLICT(${conflictKey[m[1]]}) DO UPDATE SET`).replace(/VALUES\((\w+)\)/g, 'excluded.$1');
  q = q.replace(/YEAR\(([^()]*(?:\([^()]*\))?[^()]*)\)/g, "CAST(strftime('%Y', $1) AS INTEGER)");
  return q;
}
const fakeConn = {
  query: async (sql, args = []) => {
    const q = translate(sql);
    if (/^\s*SET time_zone/i.test(q)) return [[]];
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(q)) { sqlite.exec(q); return [[]]; }
    const st = sqlite.prepare(q);
    if (/^\s*(SELECT|WITH)/i.test(q)) return [st.all(...args)];
    const r = st.run(...args);
    return [{ insertId: Number(r.lastInsertRowid), affectedRows: Number(r.changes) }];
  },
  end: async () => {},
};
setConnector(async () => fakeConn);

export const store = new Map();
export const FILES = {
  put: async (k, stream) => { store.set(k, Buffer.from(await new Response(stream).arrayBuffer())); },
  get: async (k) => (store.has(k) ? { body: store.get(k) } : null),
  delete: async (k) => { store.delete(k); },
};
