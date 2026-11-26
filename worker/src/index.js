// NIMRA procurement API for Cloudflare Workers.  MySQL (through Hyperdrive) = database, including the research PDFs.
import { openDb } from './db.js';
import { HttpError, bad, forbidden, notFound, json, randomHex, sha256, hashPin, timingSafeEqual, normalisePhone, parseCookies, round2, num, text } from './lib.js';

const SESSION_DAYS = 14;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const MAX_PDF = 5 * 1024 * 1024;
// PDFs are kept in the database (table price_files), so no file-storage service is needed.
async function readPdf(file) {
  if (file.size > MAX_PDF) throw bad('The PDF is larger than 5 MB.');
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) throw bad('Attach a PDF file.');
  const data = Buffer.from(await file.arrayBuffer());
  if (data.subarray(0, 5).toString('latin1') !== '%PDF-') throw bad('That file is not a PDF.');
  return data;
}

// ---------------------------------------------------------------- routing
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

export default {
  async fetch(request, env, execCtx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let conn = null;
    try {
      if (!url.pathname.startsWith('/api/')) return json({ ok: true, service: 'nimra-api' }, 200, cors);
      // writes only from our own site (cookies are SameSite=Lax as well)
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const origin = request.headers.get('origin');
        if (origin && !allowedOrigins(env).includes(origin)) throw forbidden('Request not allowed from this site.');
      }
      for (const r of routes) {
        if (r.method !== request.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        conn = await openDb(env);
        const ctx = { request, env, url, params, db: conn.db, user: null, setCookie: null };
        const res = await r.handler(ctx);
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        if (ctx.setCookie) headers.append('set-cookie', ctx.setCookie);
        return new Response(res.body, { status: res.status, headers });
      }
      throw notFound('No such API call.');
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      console.error(e);
      return json({ error: 'Something went wrong on the server.' }, 500, cors);
    } finally {
      // close the database connection after the response has been sent
      if (conn) { const p = conn.close(); if (execCtx?.waitUntil) execCtx.waitUntil(p); else await p; }
    }
  },
};

function allowedOrigins(env) { return String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean); }
function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  const h = { vary: 'Origin' };
  if (origin && allowedOrigins(env).includes(origin)) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-credentials'] = 'true';
    h['access-control-allow-methods'] = 'GET,POST,OPTIONS';
    h['access-control-allow-headers'] = 'content-type';
    h['access-control-max-age'] = '600';
  }
  return h;
}

// ---------------------------------------------------------------- auth
async function currentUser(ctx, roles) {
  const sid = parseCookies(ctx.request.headers.get('cookie')).sid;
  if (!sid) throw new HttpError(401, 'Please sign in.');
  const row = await ctx.db.prepare(
    `SELECT u.id, u.name, u.role, u.org_id, o.name AS org_name, o.active AS org_active, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN organisations o ON o.id = u.org_id
      WHERE s.token_hash = ? AND s.expires_at > NOW()`).bind(await sha256(sid)).first();
  if (!row || !row.active || !row.org_active) throw new HttpError(401, 'Please sign in.');
  if (roles && !roles.includes(row.role)) throw forbidden();
  ctx.user = row;
  return row;
}
const authed = (roles, handler) => async (ctx) => { await currentUser(ctx, roles); return handler(ctx); };
const body = async (ctx) => { try { return await ctx.request.json(); } catch { throw bad('Send the form as JSON.'); } };

const cookie = (value, maxAge, env) =>
  `sid=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}` + (env.COOKIE_DOMAIN ? `; Domain=${env.COOKIE_DOMAIN}` : '');

async function audit(db, userId, action, entity, entityId, detail) {
  await db.prepare('INSERT INTO audit_log(user_id,action,entity,entity_id,detail) VALUES(?,?,?,?,?)').bind(userId, action, entity, entityId ?? null, detail ?? null).run();
}
async function notifyOrg(db, orgId, kind, message, link) {
  await db.prepare(`INSERT INTO notifications(user_id,kind,message,link) SELECT id,?,?,? FROM users WHERE org_id=? AND active=1`).bind(kind, message, link ?? null, orgId).run();
}
async function notifyAdmins(db, kind, message, link) {
  await db.prepare(`INSERT INTO notifications(user_id,kind,message,link) SELECT id,?,?,? FROM users WHERE role='Admin' AND active=1`).bind(kind, message, link ?? null).run();
}
async function setting(db, key, fallback) {
  const r = await db.prepare('SELECT v FROM settings WHERE k=?').bind(key).first();
  return r ? Number(r.v) : fallback;
}

route('GET', '/api/health', async () => json({ ok: true }));

// first admin: only works while there are no users and only with the SETUP_TOKEN secret
route('POST', '/api/setup', async (ctx) => {
  const b = await body(ctx);
  if (!ctx.env.SETUP_TOKEN || b.token !== ctx.env.SETUP_TOKEN) throw forbidden('Wrong setup token.');
  const n = await ctx.db.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (n.n > 0) throw forbidden('Setup is already done.');
  const phone = normalisePhone(b.phone);
  const pin = String(b.pin || '');
  if (!/^\d{4,8}$/.test(pin)) throw bad('The PIN must be 4 to 8 digits.');
  const org = await ctx.db.prepare("INSERT INTO organisations(name,kind,code) VALUES(?, 'Admin', 'NIMRA')").bind(text(b.org || 'NIMRA', 'Organisation')).run();
  const salt = randomHex(16);
  await ctx.db.prepare("INSERT INTO users(org_id,name,phone,pin_hash,pin_salt,role) VALUES(?,?,?,?,?, 'Admin')")
    .bind(org.meta.last_row_id, text(b.name || 'Administrator', 'Name'), phone, await hashPin(pin, salt), salt).run();
  return json({ ok: true });
});

route('POST', '/api/login', async (ctx) => {
  const b = await body(ctx);
  const phone = normalisePhone(b.phone);
  const lock = await ctx.db.prepare("SELECT fails, locked_until FROM login_attempts WHERE phone=?").bind(phone).first();
  if (lock?.locked_until && lock.locked_until > new Date().toISOString().replace('T', ' ').slice(0, 19))
    throw new HttpError(429, `Too many wrong attempts. Wait ${LOCK_MINUTES} minutes and try again.`);
  const u = await ctx.db.prepare('SELECT u.*, o.active AS org_active FROM users u JOIN organisations o ON o.id=u.org_id WHERE u.phone=?').bind(phone).first();
  const ok = u && u.active && u.org_active && timingSafeEqual(await hashPin(String(b.pin || ''), u.pin_salt), u.pin_hash);
  if (!ok) {
    const fails = (lock?.fails || 0) + 1;
    const until = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString().replace('T', ' ').slice(0, 19) : null;
    await ctx.db.prepare('INSERT INTO login_attempts(phone,fails,locked_until) VALUES(?,?,?) ON DUPLICATE KEY UPDATE fails=VALUES(fails), locked_until=VALUES(locked_until)')
      .bind(phone, until ? 0 : fails, until).run();
    throw new HttpError(401, 'Wrong phone number or PIN.');
  }
  await ctx.db.prepare('DELETE FROM login_attempts WHERE phone=?').bind(phone).run();
  const token = randomHex(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  await ctx.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(token), u.id, expires).run();
  await ctx.db.prepare("DELETE FROM sessions WHERE expires_at < NOW()").run();
  ctx.setCookie = cookie(token, SESSION_DAYS * 86400, ctx.env);
  return json({ ok: true });
});

route('POST', '/api/logout', async (ctx) => {
  const sid = parseCookies(ctx.request.headers.get('cookie')).sid;
  if (sid) await ctx.db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(sid)).run();
  ctx.setCookie = cookie('', 0, ctx.env);
  return json({ ok: true });
});

route('GET', '/api/me', authed(null, async (ctx) => {
  const u = ctx.user;
  const n = await ctx.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL').bind(u.id).first();
  return json({ id: u.id, name: u.name, role: u.role, orgId: u.org_id, org: u.org_name, unread: n.n });
}));

// ---------------------------------------------------------------- accounts (admin)
route('GET', '/api/accounts', authed(['Admin'], async (ctx) => {
  const { results } = await ctx.db.prepare(
    `SELECT o.id AS orgId, o.name AS org, o.kind, o.active AS orgActive, u.id AS userId, u.name, u.phone, u.active
       FROM organisations o LEFT JOIN users u ON u.org_id=o.id WHERE o.kind <> 'Admin' ORDER BY o.kind, o.name, u.id`).all();
  return json(results);
}));

route('POST', '/api/accounts', authed(['Admin'], async (ctx) => {
  const b = await body(ctx);
  const kind = b.kind === 'Supplier' ? 'Supplier' : b.kind === 'Institution' ? 'Institution' : null;
  if (!kind) throw bad('Choose Institution or Supplier.');
  const name = text(b.org, 'Organisation name', { max: 200 });
  const userName = text(b.name, 'Contact name', { max: 120 });
  const phone = normalisePhone(b.phone);
  const pin = String(b.pin || '');
  if (!/^\d{4,8}$/.test(pin)) throw bad('The PIN must be 4 to 8 digits.');
  if (await ctx.db.prepare('SELECT 1 FROM users WHERE phone=?').bind(phone).first()) throw bad('That phone number already has an account.');
  const code = (kind === 'Supplier' ? 'SUP-' : 'INS-') + randomHex(3).toUpperCase();
  const org = await ctx.db.prepare('INSERT INTO organisations(name,kind,code) VALUES(?,?,?)').bind(name, kind, code).run();
  const salt = randomHex(16);
  await ctx.db.prepare('INSERT INTO users(org_id,name,phone,pin_hash,pin_salt,role) VALUES(?,?,?,?,?,?)')
    .bind(org.meta.last_row_id, userName, phone, await hashPin(pin, salt), salt, kind).run();
  await audit(ctx.db, ctx.user.id, 'ACCOUNT_CREATED', 'organisations', org.meta.last_row_id, `${kind} ${name}`);
  return json({ ok: true, code });
}));

route('POST', '/api/accounts/:id/active', authed(['Admin'], async (ctx) => {
  const b = await body(ctx);
  await ctx.db.prepare("UPDATE organisations SET active=? WHERE id=? AND kind<>'Admin'").bind(b.active ? 1 : 0, ctx.params.id).run();
  await audit(ctx.db, ctx.user.id, b.active ? 'ACCOUNT_ENABLED' : 'ACCOUNT_DISABLED', 'organisations', Number(ctx.params.id), null);
  return json({ ok: true });
}));

route('GET', '/api/suppliers', authed(['Admin', 'Institution'], async (ctx) => {
  const { results } = await ctx.db.prepare("SELECT id, name, code FROM organisations WHERE kind='Supplier' AND active=1 ORDER BY name").all();
  return json(results);
}));

// ---------------------------------------------------------------- notices
const NOTICE_SELECT = `SELECT n.*, i.name AS institution, s.name AS supplier, (SELECT COUNT(*) FROM quote_lines l WHERE l.notice_id=n.id) AS lineCount
  FROM notices n JOIN organisations i ON i.id=n.institution_id JOIN organisations s ON s.id=n.supplier_id`;

function scope(u) {
  if (u.role === 'Admin') return { sql: '1=1', args: [] };
  if (u.role === 'Institution') return { sql: 'n.institution_id=?', args: [u.org_id] };
  return { sql: 'n.supplier_id=?', args: [u.org_id] };
}
async function loadNotice(ctx, id) {
  const sc = scope(ctx.user);
  const n = await ctx.db.prepare(`${NOTICE_SELECT} WHERE n.id=? AND ${sc.sql}`).bind(id, ...sc.args).first();
  if (!n) throw notFound('That procurement was not found.');
  return n;
}
const nextStep = (n, role) => {
  const s = n.status;
  if (s === 'NOTIFIED') return role === 'Supplier' ? 'Record the items you will buy, with your cost and your price.' : role === 'Admin' ? 'Waiting for the supplier to record the items.' : 'Waiting for the supplier to record the items.';
  if (s === 'ITEMS_RECORDED') return role === 'Admin' ? 'Review the items against market prices. Approve, or return to the supplier with comments.' : role === 'Institution' ? 'NIMRA is researching market prices and reviewing the items.' : 'NIMRA is reviewing your items.';
  if (s === 'RETURNED') return role === 'Supplier' ? 'NIMRA returned your items with comments. Fix them and send again.' : 'Returned to the supplier for changes.';
  if (s === 'APPROVED') return role === 'Institution' ? 'Approved. Complete the procurement once the goods are received.' : 'Approved by NIMRA.';
  return s === 'COMPLETED' ? 'Completed.' : 'Cancelled.';
};

route('GET', '/api/notices', authed(null, async (ctx) => {
  const sc = scope(ctx.user);
  const status = ctx.url.searchParams.get('status');
  const { results } = await ctx.db.prepare(`${NOTICE_SELECT} WHERE ${sc.sql}${status ? ' AND n.status=?' : ''} ORDER BY n.id DESC LIMIT 500`)
    .bind(...sc.args, ...(status ? [status] : [])).all();
  return json(results.map((n) => ({ ...n, next: nextStep(n, ctx.user.role) })));
}));

route('POST', '/api/notices', authed(['Institution'], async (ctx) => {
  const b = await body(ctx);
  const title = text(b.title, 'Item description');
  const quantity = num(b.quantity, 'Quantity', { allowZero: false });
  const unit = text(b.unit, 'Unit', { max: 30 });
  const neededBy = text(b.neededBy, 'Needed by date', { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(neededBy)) throw bad('Enter the needed-by date.');
  const sup = await ctx.db.prepare("SELECT id,name FROM organisations WHERE id=? AND kind='Supplier' AND active=1").bind(Number(b.supplierId)).first();
  if (!sup) throw bad('Choose a registered supplier.');
  const r = await ctx.db.prepare('INSERT INTO notices(institution_id,supplier_id,title,quantity,unit,needed_by,created_by) VALUES(?,?,?,?,?,?,?)')
    .bind(ctx.user.org_id, sup.id, title, quantity, unit, neededBy, ctx.user.id).run();
  const id = r.meta.last_row_id;
  await ctx.db.prepare("INSERT INTO notice_events(notice_id,kind,comment,user_id) VALUES(?, 'NOTIFIED', NULL, ?)").bind(id, ctx.user.id).run();
  await notifyOrg(ctx.db, sup.id, 'NOTICE', `${ctx.user.org_name} will buy "${title}" from you. Record the items.`, `#/notice/${id}`);
  await notifyAdmins(ctx.db, 'NOTICE', `${ctx.user.org_name} notified a procurement: ${title}.`, `#/notice/${id}`);
  await audit(ctx.db, ctx.user.id, 'NOTICE_CREATED', 'notices', id, title);
  return json({ id });
}));

// benchmark = average of published single-item reference prices with the same item name (case-insensitive)
async function benchmarks(db, names) {
  const out = {};
  for (const name of [...new Set(names.map((s) => s.toLowerCase()))]) {
    const r = await db.prepare('SELECT AVG(unit_price) AS p, COUNT(*) AS n FROM reference_prices WHERE published=1 AND item_name=?').bind(name).first();
    out[name] = r && r.n > 0 ? { price: round2(r.p), sources: r.n } : null;
  }
  return out;
}
async function marginLimitFor(db, institutionId) {
  const own = await db.prepare('SELECT margin_limit_percent AS m FROM institution_settings WHERE org_id=?').bind(institutionId).first();
  return own && own.m != null ? Number(own.m) : await setting(db, 'MarkupMaxPercent', 30);
}

route('GET', '/api/notices/:id', authed(null, async (ctx) => {
  const n = await loadNotice(ctx, Number(ctx.params.id));
  const lines = (await ctx.db.prepare('SELECT * FROM quote_lines WHERE notice_id=? ORDER BY id').bind(n.id).all()).results;
  const events = (await ctx.db.prepare(
    `SELECT e.kind, e.comment, e.created_at, u.name AS byName FROM notice_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.notice_id=? ORDER BY e.id`).bind(n.id).all()).results.map(({ byName, ...e }) => ({ ...e, by: byName }));
  const bm = await benchmarks(ctx.db, lines.map((l) => l.description));
  const priced = lines.map((l) => {
    const b = bm[l.description.toLowerCase()];
    const markup = l.unit_cost > 0 ? round2(((l.unit_price - l.unit_cost) / l.unit_cost) * 100) : null;
    return { ...l, benchmark: b?.price ?? null, benchmarkSources: b?.sources ?? 0, markupPercent: markup,
             marginMade: round2((l.unit_price - l.unit_cost) * l.quantity),
             waste: b ? round2(Math.max(0, l.unit_price - b.price) * l.quantity) : null };
  });
  const research = (await ctx.db.prepare(
    `SELECT id, item_name, unit, unit_price, source_name, source_link, source_contact, notes, published, file_name, created_at
       FROM reference_prices WHERE notice_id=? ${ctx.user.role === 'Admin' ? '' : 'AND published=1'} ORDER BY id DESC`).bind(n.id).all()).results;
  const limit = await marginLimitFor(ctx.db, n.institution_id);
  return json({ notice: { ...n, next: nextStep(n, ctx.user.role) }, lines: priced, events, research, marginLimitPercent: limit,
                waitingForResearch: n.status === 'ITEMS_RECORDED' && research.filter((r) => r.published).length === 0 });
}));

route('POST', '/api/notices/:id/items', authed(['Supplier'], async (ctx) => {
  const n = await loadNotice(ctx, Number(ctx.params.id));
  if (!['NOTIFIED', 'RETURNED'].includes(n.status)) throw bad('Items can only be recorded before NIMRA approves.');
  const b = await body(ctx);
  if (!Array.isArray(b.lines) || b.lines.length === 0) throw bad('Add at least one item.');
  if (b.lines.length > 200) throw bad('Too many items (most 200).');
  const limit = await marginLimitFor(ctx.db, n.institution_id);
  const lines = []; const over = [];
  b.lines.forEach((l, i) => {
    const row = i + 1;
    const description = text(l.description, `Item ${row} description`);
    const quantity = num(l.quantity, `Item ${row} quantity`, { allowZero: false });
    const unitCost = num(l.unitCost, `Item ${row} cost per item`);
    const unitPrice = num(l.unitPrice, `Item ${row} price per item`, { allowZero: false });
    const barcode = text(l.barcode, `Item ${row} barcode`, { max: 14, required: false }); // never mandatory
    if (barcode && !/^\d{8,14}$/.test(barcode)) throw bad(`Item ${row}: a barcode is 8 to 14 digits, or leave it empty.`);
    if (unitCost > 0) { const m = ((unitPrice - unitCost) / unitCost) * 100; if (m > limit) over.push(`${description} (${round2(m)}%)`); }
    lines.push([description, quantity, unitCost, unitPrice, barcode]);
  });
  if (over.length) throw bad(`${n.institution} allows a margin of at most ${limit}% over your cost. Over the limit: ${over.join(', ')}.`);
  const stmts = [ctx.db.prepare('DELETE FROM quote_lines WHERE notice_id=?').bind(n.id),
    ...lines.map((l) => ctx.db.prepare('INSERT INTO quote_lines(notice_id,description,quantity,unit_cost,unit_price,barcode) VALUES(?,?,?,?,?,?)').bind(n.id, ...l)),
    ctx.db.prepare("UPDATE notices SET status='ITEMS_RECORDED', quote_version=quote_version+1, items_recorded_at=NOW() WHERE id=?").bind(n.id),
    ctx.db.prepare("INSERT INTO notice_events(notice_id,kind,comment,user_id) VALUES(?, 'ITEMS_RECORDED', ?, ?)").bind(n.id, text(b.comment, 'Comment', { required: false, max: 500 }), ctx.user.id)];
  await ctx.db.batch(stmts);
  const researched = await ctx.db.prepare(`SELECT COUNT(*) AS c FROM reference_prices WHERE published=1 AND notice_id=?`).bind(n.id).first();
  await notifyOrg(ctx.db, n.institution_id, 'WAITING_RESEARCH',
    researched.c > 0 ? `${n.supplier} recorded the items for "${n.title}". NIMRA is reviewing them.` : `${n.supplier} recorded the items for "${n.title}". NIMRA is now researching market prices.`, `#/notice/${n.id}`);
  await notifyAdmins(ctx.db, 'REVIEW', `${n.supplier} recorded items for "${n.title}". Review them.`, `#/notice/${n.id}`);
  await audit(ctx.db, ctx.user.id, 'ITEMS_RECORDED', 'notices', n.id, `${lines.length} items`);
  return json({ ok: true });
}));

route('POST', '/api/notices/:id/return', authed(['Admin'], async (ctx) => {
  const n = await loadNotice(ctx, Number(ctx.params.id));
  if (n.status !== 'ITEMS_RECORDED') throw bad('Only items that are waiting for review can be returned.');
  const b = await body(ctx);
  const comment = text(b.comment, 'Comment for the supplier', { max: 1000 });
  await ctx.db.batch([
    ctx.db.prepare("UPDATE notices SET status='RETURNED' WHERE id=?").bind(n.id),
    ctx.db.prepare("INSERT INTO notice_events(notice_id,kind,comment,user_id) VALUES(?, 'RETURNED', ?, ?)").bind(n.id, comment, ctx.user.id)]);
  await notifyOrg(ctx.db, n.supplier_id, 'RETURNED', `NIMRA returned your items for "${n.title}": ${comment}`, `#/notice/${n.id}`);
  await notifyOrg(ctx.db, n.institution_id, 'RETURNED', `NIMRA returned the supplier's items for "${n.title}" for changes.`, `#/notice/${n.id}`);
  await audit(ctx.db, ctx.user.id, 'NOTICE_RETURNED', 'notices', n.id, comment);
  return json({ ok: true });
}));

route('POST', '/api/notices/:id/approve', authed(['Admin'], async (ctx) => {
  const n = await loadNotice(ctx, Number(ctx.params.id));
  if (n.status !== 'ITEMS_RECORDED') throw bad('Only items that are waiting for review can be approved.');
  const b = await body(ctx);
  await ctx.db.batch([
    ctx.db.prepare("UPDATE notices SET status='APPROVED', approved_at=NOW() WHERE id=?").bind(n.id),
    ctx.db.prepare("INSERT INTO notice_events(notice_id,kind,comment,user_id) VALUES(?, 'APPROVED', ?, ?)").bind(n.id, text(b.comment, 'Comment', { required: false, max: 500 }), ctx.user.id)]);
  await notifyOrg(ctx.db, n.institution_id, 'APPROVED', `NIMRA approved the items for "${n.title}".`, `#/notice/${n.id}`);
  await notifyOrg(ctx.db, n.supplier_id, 'APPROVED', `NIMRA approved your items for "${n.title}".`, `#/notice/${n.id}`);
  await audit(ctx.db, ctx.user.id, 'NOTICE_APPROVED', 'notices', n.id, null);
  return json({ ok: true });
}));

route('POST', '/api/notices/:id/complete', authed(['Institution'], async (ctx) => {
  const n = await loadNotice(ctx, Number(ctx.params.id));
  if (n.status !== 'APPROVED') throw bad('Only an approved procurement can be completed.');
  await ctx.db.batch([
    ctx.db.prepare("UPDATE notices SET status='COMPLETED', completed_at=NOW() WHERE id=?").bind(n.id),
    ctx.db.prepare("INSERT INTO notice_events(notice_id,kind,user_id) VALUES(?, 'COMPLETED', ?)").bind(n.id, ctx.user.id)]);
  await notifyOrg(ctx.db, n.supplier_id, 'COMPLETED', `${n.institution} marked "${n.title}" as completed.`, `#/notice/${n.id}`);
  await audit(ctx.db, ctx.user.id, 'NOTICE_COMPLETED', 'notices', n.id, null);
  return json({ ok: true });
}));

route('POST', '/api/notices/:id/cancel', authed(['Institution'], async (ctx) => {
  const n = await loadNotice(ctx, Number(ctx.params.id));
  if (!['NOTIFIED', 'RETURNED', 'ITEMS_RECORDED'].includes(n.status)) throw bad('This procurement can no longer be cancelled.');
  const b = await body(ctx);
  const reason = text(b.reason, 'Reason', { max: 500 });
  await ctx.db.batch([
    ctx.db.prepare("UPDATE notices SET status='CANCELLED', cancel_reason=? WHERE id=?").bind(reason, n.id),
    ctx.db.prepare("INSERT INTO notice_events(notice_id,kind,comment,user_id) VALUES(?, 'CANCELLED', ?, ?)").bind(n.id, reason, ctx.user.id)]);
  await notifyOrg(ctx.db, n.supplier_id, 'CANCELLED', `${n.institution} cancelled "${n.title}": ${reason}`, `#/notice/${n.id}`);
  return json({ ok: true });
}));

// ---------------------------------------------------------------- reference prices + PDF research (stored in the database)
route('GET', '/api/prices', authed(null, async (ctx) => {
  const q = (ctx.url.searchParams.get('q') || '').trim().toLowerCase();
  const adminSeesAll = ctx.user.role === 'Admin';
  const { results } = await ctx.db.prepare(
    `SELECT id, notice_id AS noticeId, item_name AS itemName, unit, unit_price AS unitPrice, source_name AS sourceName, source_link AS sourceLink,
            source_contact AS sourceContact, notes, published, file_name AS fileName, created_at AS createdAt
       FROM reference_prices WHERE (? OR published=1) AND (? = '' OR item_name LIKE ?) ORDER BY id DESC LIMIT 500`)
    .bind(adminSeesAll ? 1 : 0, q, `%${q}%`).all();
  return json(results);
}));

route('POST', '/api/prices', authed(['Admin'], async (ctx) => {
  const ct = ctx.request.headers.get('content-type') || '';
  let f; let file = null;
  if (ct.includes('multipart/form-data')) {
    const form = await ctx.request.formData();
    f = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string'));
    const up = form.get('file');
    if (up && typeof up !== 'string' && up.size > 0) file = up;
  } else f = await body(ctx);
  const itemName = text(f.itemName, 'Item name');
  const unitPrice = num(f.unitPrice, 'Price of one item', { allowZero: false });
  const sourceName = text(f.sourceName, 'Source name', { max: 200 });
  const sourceLink = text(f.sourceLink, 'Source link', { max: 500, required: false });
  const sourceContact = text(f.sourceContact, 'Source contact', { max: 200, required: false });
  if (!sourceLink && !sourceContact) throw bad('Give a link or a contact for the source, so the price can be checked.');
  const noticeId = f.noticeId ? Number(f.noticeId) : null;
  if (noticeId && !(await ctx.db.prepare('SELECT 1 FROM notices WHERE id=?').bind(noticeId).first())) throw bad('That procurement was not found.');
  let pdf = null; const fileName = file ? file.name.slice(-120) : null;
  if (file) pdf = await readPdf(file);
  const published = f.published === true || f.published === 'true' || f.published === 'on' ? 1 : 0;
  const r = await ctx.db.prepare(
    `INSERT INTO reference_prices(notice_id,item_name,unit,unit_price,source_name,source_link,source_contact,notes,published,file_name,added_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(noticeId, itemName, text(f.unit, 'Unit', { max: 30, required: false }), unitPrice, sourceName, sourceLink, sourceContact,
      text(f.notes, 'Notes', { max: 500, required: false }), published, fileName, ctx.user.id).run();
  if (pdf) await ctx.db.prepare('INSERT INTO price_files(price_id,data) VALUES(?,?)').bind(r.meta.last_row_id, pdf).run();
  if (noticeId && published) {
    const n = await ctx.db.prepare('SELECT institution_id, title FROM notices WHERE id=?').bind(noticeId).first();
    await notifyOrg(ctx.db, n.institution_id, 'RESEARCH', `Market research was published for "${n.title}".`, `#/notice/${noticeId}`);
  }
  await audit(ctx.db, ctx.user.id, 'PRICE_ADDED', 'reference_prices', r.meta.last_row_id, `${itemName} @ ${unitPrice}`);
  return json({ id: r.meta.last_row_id });
}));

route('POST', '/api/prices/:id/publish', authed(['Admin'], async (ctx) => {
  const b = await body(ctx);
  await ctx.db.prepare('UPDATE reference_prices SET published=? WHERE id=?').bind(b.published ? 1 : 0, ctx.params.id).run();
  return json({ ok: true });
}));

route('POST', '/api/prices/:id/file', authed(['Admin'], async (ctx) => {
  const form = await ctx.request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string' || file.size === 0) throw bad('Choose a PDF file.');
  const p = await ctx.db.prepare('SELECT id FROM reference_prices WHERE id=?').bind(ctx.params.id).first();
  if (!p) throw notFound();
  const pdf = await readPdf(file);
  await ctx.db.batch([
    ctx.db.prepare('REPLACE INTO price_files(price_id,data) VALUES(?,?)').bind(p.id, pdf),
    ctx.db.prepare('UPDATE reference_prices SET file_name=? WHERE id=?').bind(file.name.slice(-120), p.id)]);
  return json({ ok: true });
}));

route('GET', '/api/prices/:id/file', authed(null, async (ctx) => {
  const p = await ctx.db.prepare('SELECT file_name, published FROM reference_prices WHERE id=?').bind(ctx.params.id).first();
  if (!p || !p.file_name) throw notFound('No document.');
  if (ctx.user.role !== 'Admin' && !p.published) throw notFound('No document.');
  const f = await ctx.db.prepare('SELECT data FROM price_files WHERE price_id=?').bind(ctx.params.id).first();
  if (!f) throw notFound('The file is missing.');
  return new Response(f.data, { headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${p.file_name.replace(/[^\w.\- ]/g, '_')}"`, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' } });
}));

// ---------------------------------------------------------------- institution settings and wastage
route('GET', '/api/institution/settings', authed(['Institution'], async (ctx) => {
  const s = await ctx.db.prepare('SELECT wastage_threshold_percent AS wastage, margin_limit_percent AS margin FROM institution_settings WHERE org_id=?').bind(ctx.user.org_id).first();
  return json({ wastageThresholdPercent: s?.wastage ?? null, marginLimitPercent: s?.margin ?? null,
    globalWastage: await setting(ctx.db, 'WastageThresholdPercent', 10), globalMargin: await setting(ctx.db, 'MarkupMaxPercent', 30) });
}));
route('POST', '/api/institution/settings', authed(['Institution'], async (ctx) => {
  const b = await body(ctx);
  const opt = (v, label) => (v === '' || v == null ? null : num(v, label, { min: 0 }));
  const w = opt(b.wastageThresholdPercent, 'The wastage limit'); const m = opt(b.marginLimitPercent, 'The supplier margin limit');
  if ((w != null && w > 1000) || (m != null && m > 1000)) throw bad('That percentage is too large.');
  await ctx.db.prepare(`INSERT INTO institution_settings(org_id,wastage_threshold_percent,margin_limit_percent) VALUES(?,?,?)
    ON DUPLICATE KEY UPDATE wastage_threshold_percent=VALUES(wastage_threshold_percent), margin_limit_percent=VALUES(margin_limit_percent)`).bind(ctx.user.org_id, w, m).run();
  await audit(ctx.db, ctx.user.id, 'INSTITUTION_LIMITS', 'organisations', ctx.user.org_id, `wastage ${w} margin ${m}`);
  return json({ ok: true });
}));

// Waste = what was charged above the market price. Margin = what the supplier made over its own cost.
// The year defaults to the current year, so it rolls over by itself on 1 January.
route('GET', '/api/wastage', authed(['Institution', 'Admin'], async (ctx) => {
  const now = new Date().getUTCFullYear();
  let year = Math.trunc(Number(ctx.url.searchParams.get('year'))) || now;
  if (year < 2000 || year > 2100) year = now;
  const orgFilter = ctx.user.role === 'Institution' ? ctx.user.org_id : Number(ctx.url.searchParams.get('institution')) || null;
  const where = `n.status IN ('APPROVED','COMPLETED') AND COALESCE(n.completed_at, n.approved_at) >= ? AND COALESCE(n.completed_at, n.approved_at) < ?${orgFilter ? ' AND n.institution_id=?' : ''}`;
  const args = [`${year}-01-01`, `${year + 1}-01-01`, ...(orgFilter ? [orgFilter] : [])];
  const { results: lines } = await ctx.db.prepare(
    `SELECT n.id AS noticeId, n.title, n.supplier_id AS supplierId, s.name AS supplier, n.institution_id AS institutionId, l.description, l.quantity, l.unit_cost AS unitCost, l.unit_price AS unitPrice,
            (SELECT AVG(p.unit_price) FROM reference_prices p WHERE p.published=1 AND p.item_name=l.description) AS benchmark
       FROM quote_lines l JOIN notices n ON n.id=l.notice_id JOIN organisations s ON s.id=n.supplier_id WHERE ${where}`).bind(...args).all();
  const bySupplier = new Map();
  for (const l of lines) {
    const e = bySupplier.get(l.supplierId) || { supplierId: l.supplierId, supplier: l.supplier, notices: new Set(), quoted: 0, waste: 0, margin: 0, benchmarked: 0 };
    e.notices.add(l.noticeId);
    e.quoted += l.quantity * l.unitPrice;
    e.margin += (l.unitPrice - l.unitCost) * l.quantity;
    if (l.benchmark != null) { e.waste += Math.max(0, l.unitPrice - l.benchmark) * l.quantity; e.benchmarked += l.quantity * l.benchmark; }
    bySupplier.set(l.supplierId, e);
  }
  const threshold = orgFilter ? ((await ctx.db.prepare('SELECT wastage_threshold_percent AS w FROM institution_settings WHERE org_id=?').bind(orgFilter).first())?.w ?? await setting(ctx.db, 'WastageThresholdPercent', 10)) : await setting(ctx.db, 'WastageThresholdPercent', 10);
  const suppliers = [...bySupplier.values()].map((e) => ({ supplierId: e.supplierId, supplier: e.supplier, notices: e.notices.size, quoted: round2(e.quoted), waste: round2(e.waste), margin: round2(e.margin),
    wastePercent: e.benchmarked > 0 ? round2((e.waste / e.benchmarked) * 100) : null })).sort((a, b) => b.waste - a.waste);
  const total = suppliers.reduce((t, s) => ({ quoted: t.quoted + s.quoted, waste: t.waste + s.waste, margin: t.margin + s.margin }), { quoted: 0, waste: 0, margin: 0 });
  const { results: yrs } = await ctx.db.prepare(
    `SELECT DISTINCT YEAR(COALESCE(completed_at, approved_at)) AS y FROM notices n WHERE n.status IN ('APPROVED','COMPLETED')${orgFilter ? ' AND n.institution_id=?' : ''} ORDER BY y DESC`).bind(...(orgFilter ? [orgFilter] : [])).all();
  const years = [...new Set([String(now), ...yrs.map((r) => String(r.y)).filter((y) => y !== 'null')])].sort().reverse();
  return json({ year, years, thresholdPercent: threshold, suppliers, total: { quoted: round2(total.quoted), waste: round2(total.waste), margin: round2(total.margin) } });
}));

// ---------------------------------------------------------------- notifications
route('GET', '/api/notifications', authed(null, async (ctx) => {
  const { results } = await ctx.db.prepare('SELECT id, kind, message, link, read_at AS readAt, created_at AS createdAt FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100').bind(ctx.user.id).all();
  return json(results);
}));
route('POST', '/api/notifications/read', authed(null, async (ctx) => {
  await ctx.db.prepare("UPDATE notifications SET read_at=NOW() WHERE user_id=? AND read_at IS NULL").bind(ctx.user.id).run();
  return json({ ok: true });
}));
