// Local stand-ins so the real Worker code runs on your computer WITHOUT MySQL:
//  - a fake TiDB connection backed by node:sqlite (translates the few MySQL-only bits the Worker uses)
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
  q = q.replace(/\bREPLACE INTO\b/, 'INSERT OR REPLACE INTO');
  const m = /INSERT INTO (\w+)[\s\S]*ON DUPLICATE KEY UPDATE/.exec(q);
  if (m) q = q.replace('ON DUPLICATE KEY UPDATE', `ON CONFLICT(${conflictKey[m[1]]}) DO UPDATE SET`).replace(/VALUES\((\w+)\)/g, 'excluded.$1');
  q = q.replace(/YEAR\(([^()]*(?:\([^()]*\))?[^()]*)\)/g, "CAST(strftime('%Y', $1) AS INTEGER)");
  return q;
}
const run = async (sql, args = []) => {
  const q = translate(sql).replace(/\bHEX\(data\)/, 'hex(data)').replace(/UNHEX\(\?\)/, '?');
  if (/^\s*(SELECT|WITH)/i.test(q)) return { rows: sqlite.prepare(q).all(...args), insertId: 0, affected: 0 };
  // UNHEX(?) is mimicked: hex text in -> bytes
  const a = /price_files/.test(q) && /INSERT/i.test(q) ? [args[0], Buffer.from(args[1], 'hex')] : args;
  const r = sqlite.prepare(q).run(...a);
  return { rows: [], insertId: Number(r.lastInsertRowid), affected: Number(r.changes) };
};
setConnector(async () => ({
  run,
  begin: async () => { sqlite.exec('BEGIN'); return { run, commit: async () => sqlite.exec('COMMIT'), rollback: async () => sqlite.exec('ROLLBACK') }; },
}));
