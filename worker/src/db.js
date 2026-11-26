// MySQL access from a Worker through Cloudflare Hyperdrive.
// Hyperdrive pools connections near your database; the Worker opens one connection per request and closes it afterwards.
// The small prepare/bind/first/all/run/batch API below keeps the route code short and always uses ? placeholders.
let connector = null;
export const setConnector = (fn) => { connector = fn; };          // tests only

async function connect(env) {
  if (connector) return connector(env);
  const { createConnection } = await import('mysql2/promise');
  const h = env.HYPERDRIVE;
  if (!h) throw new Error('The HYPERDRIVE binding is missing. See README step 3.');
  const conn = await createConnection({
    host: h.host, user: h.user, password: h.password, database: h.database, port: h.port,
    disableEval: true,        // Workers do not allow eval()
    dateStrings: true,        // DATETIME comes back as 'YYYY-MM-DD HH:MM:SS', not a Date
    decimalNumbers: true,     // DECIMAL comes back as a number, not a string
  });
  await conn.query("SET time_zone = '+00:00'");   // all stored times are UTC
  return conn;
}

const clean = (a) => a.map((v) => (v === undefined ? null : v));

function statement(conn, sql, args = []) {
  const s = {
    sql, args,
    bind: (...a) => statement(conn, sql, clean(a)),
    first: async () => { const [rows] = await conn.query(sql, args); return rows[0] ?? null; },
    all: async () => { const [rows] = await conn.query(sql, args); return { results: rows }; },
    run: async () => { const [r] = await conn.query(sql, args); return { meta: { last_row_id: Number(r.insertId), changes: r.affectedRows } }; },
  };
  return s;
}

// Opens a connection and returns { db, close }. batch() is a real transaction: all statements or none.
export async function openDb(env) {
  const conn = await connect(env);
  const db = {
    prepare: (sql) => statement(conn, sql),
    batch: async (list) => {
      await conn.query('START TRANSACTION');
      try { for (const s of list) await conn.query(s.sql, s.args); await conn.query('COMMIT'); }
      catch (e) { try { await conn.query('ROLLBACK'); } catch { /* connection already gone */ } throw e; }
    },
  };
  return { db, close: async () => { try { await conn.end(); } catch { /* ignore */ } } };
}
