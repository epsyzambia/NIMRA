// TiDB Cloud Serverless over HTTPS (driver: @tidbcloud/serverless). No TCP sockets, no Hyperdrive.
// The secret DATABASE_URL looks like  mysql://USER:PASSWORD@HOST/nimra   (no port needed).
// A small prepare/bind/first/all/run/batch API keeps the route code short and always uses ? placeholders.
let connector = null;
export const setConnector = (fn) => { connector = fn; };          // tests only

const NUMERIC = /^(NEW)?DECIMAL$|^(DOUBLE|FLOAT|REAL)$|INT(EGER)?(\sUNSIGNED)?$|^(TINY|SHORT|LONG|LONGLONG|INT24|YEAR)$/i;
function normalise(rows, types) {
  return (rows || []).map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'string' && types && NUMERIC.test(String(types[k] || '')) && v.trim() !== '' && !Number.isNaN(Number(v))) out[k] = Number(v);
      else if (v instanceof Date) out[k] = v.toISOString().replace('T', ' ').slice(0, 19);
      else out[k] = v;
    }
    return out;
  });
}

async function tidb(env) {
  const rawUrl = (env.DATABASE_URL || '').trim();
  if (!rawUrl || rawUrl.includes('@://')) {
    throw new Error('DATABASE_URL is missing or malformed.');
  }
  const { connect } = await import('@tidbcloud/serverless');
  const conn = connect({ url: rawUrl, fullResult: true });
  const wrap = (x) => ({
    run: async (sql, args) => {
      const r = await x.execute(sql, args);
      return { rows: normalise(r.rows, r.types), insertId: Number(r.lastInsertId || 0), affected: Number(r.rowsAffected || 0) };
    },
  });
  return {
    ...wrap(conn),
    begin: async () => { const tx = await conn.begin(); return { ...wrap(tx), commit: () => tx.commit(), rollback: () => tx.rollback() }; },
  };
}

const clean = (a) => a.map((v) => (v === undefined ? null : v));

function statement(c, sql, args = []) {
  return {
    sql, args,
    bind: (...a) => statement(c, sql, clean(a)),
    first: async () => (await c.run(sql, args)).rows[0] ?? null,
    all: async () => ({ results: (await c.run(sql, args)).rows }),
    run: async () => { const r = await c.run(sql, args); return { meta: { last_row_id: r.insertId, changes: r.affected } }; },
  };
}

// Returns { db, close }. batch() is a real transaction: every statement or none.
export async function openDb(env) {
  const c = await (connector ? connector(env) : tidb(env));
  const db = {
    prepare: (sql) => statement(c, sql),
    batch: async (list) => {
      const tx = await c.begin();
      try { for (const s of list) await tx.run(s.sql, s.args); await tx.commit(); }
      catch (e) { try { await tx.rollback(); } catch { /* already gone */ } throw e; }
    },
  };
  return { db, close: async () => {} };
}
