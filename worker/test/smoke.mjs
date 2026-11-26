// End-to-end smoke test. Runs the real Worker code with a fake MySQL connection (SQLite underneath). Not a MySQL test.
import assert from 'node:assert/strict';
import worker from '../src/index.js';

import './shim.mjs';
const env = { ALLOWED_ORIGINS: 'https://app.example.com', COOKIE_DOMAIN: '.example.com', SETUP_TOKEN: 'secret-setup' };
const ORIGIN = 'https://app.example.com';

function client() {
  let sid = '';
  return async (method, path, data, raw) => {
    const headers = { origin: ORIGIN };
    if (sid) headers.cookie = `sid=${sid}`;
    let bodyInit;
    if (raw) bodyInit = raw; else if (data !== undefined) { headers['content-type'] = 'application/json'; bodyInit = JSON.stringify(data); }
    const res = await worker.fetch(new Request('https://api.example.com' + path, { method, headers, body: bodyInit }), env);
    const sc = res.headers.get('set-cookie'); if (sc) { const m = /sid=([^;]*)/.exec(sc); sid = m ? m[1] : ''; }
    const ct = res.headers.get('content-type') || '';
    const out = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: out, headers: res.headers };
  };
}
const ok = (r, label) => assert.equal(r.status, 200, `${label}: ${r.status} ${JSON.stringify(r.body)}`);
const step = (s) => console.log('  ✓', s);

const admin = client(), inst = client(), supp = client(), anon = client();

// setup + sign in
assert.equal((await anon('POST', '/api/setup', { token: 'wrong', phone: '0971000000', pin: '1234' })).status, 403); step('setup refuses a wrong token');
ok(await anon('POST', '/api/setup', { token: 'secret-setup', phone: '0971000000', pin: '1234', name: 'Admin' }), 'setup'); step('first admin created');
assert.equal((await anon('POST', '/api/setup', { token: 'secret-setup', phone: '0971000001', pin: '1234' })).status, 403); step('setup works only once');
assert.equal((await admin('GET', '/api/me')).status, 401); step('not signed in = 401');
assert.equal((await admin('POST', '/api/login', { phone: '0971000000', pin: '9999' })).status, 401); step('wrong PIN rejected');
const lg = await admin('POST', '/api/login', { phone: '+260 971 000 000', pin: '1234' }); ok(lg, 'login'); assert.match(lg.headers.get('set-cookie'), /HttpOnly.*Secure.*SameSite=Lax.*Domain=\.example\.com/); step('admin signs in (phone formats match, secure cookie)');
assert.equal((await admin('POST', '/api/accounts', { kind: 'Supplier', org: 'X', name: 'Y', phone: '0977', pin: '1111' })).status, 400); step('bad phone rejected');
const evil = await worker.fetch(new Request('https://api.example.com/api/logout', { method: 'POST', headers: { origin: 'https://evil.com' } }), env); assert.equal(evil.status, 403); step('writes from another site are refused');

// accounts
ok(await admin('POST', '/api/accounts', { kind: 'Institution', org: 'Ministry of Health', name: 'Mary', phone: '0972000001', pin: '2222' }), 'inst'); 
ok(await admin('POST', '/api/accounts', { kind: 'Supplier', org: 'Lusaka Supplies', name: 'Sam', phone: '0973000001', pin: '3333' }), 'supp');
ok(await inst('POST', '/api/login', { phone: '0972000001', pin: '2222' }), 'inst login'); ok(await supp('POST', '/api/login', { phone: '0973000001', pin: '3333' }), 'supp login'); step('institution and supplier accounts created');
assert.equal((await inst('GET', '/api/accounts')).status, 403); step('institution cannot list accounts');

// institution margin limit
ok(await inst('POST', '/api/institution/settings', { marginLimitPercent: '20', wastageThresholdPercent: '' }), 'limit'); step('institution sets its supplier margin limit (20%)');

// notice
const suppliers = (await inst('GET', '/api/suppliers')).body; assert.equal(suppliers.length, 1);
const nres = await inst('POST', '/api/notices', { title: 'A4 paper ream', quantity: 100, unit: 'ream', neededBy: '2026-12-31', supplierId: suppliers[0].id }); ok(nres, 'notice'); const nid = nres.body.id; step('institution notifies a procurement');
assert.equal((await supp('GET', '/api/notifications')).body.length, 1); step('supplier is notified');

// supplier items: over limit blocked, barcode optional
const over = await supp('POST', `/api/notices/${nid}/items`, { lines: [{ description: 'A4 paper ream', quantity: 100, unitCost: 50, unitPrice: 80 }] });
assert.equal(over.status, 400); assert.match(over.body.error, /at most 20%/); step('price over the institution margin limit is refused');
assert.equal((await supp('POST', `/api/notices/${nid}/items`, { lines: [{ description: 'A4 paper ream', quantity: 100, unitCost: 50, unitPrice: 55, barcode: '12' }] })).status, 400); step('a malformed barcode is refused');
ok(await supp('POST', `/api/notices/${nid}/items`, { lines: [{ description: 'A4 paper ream', quantity: 100, unitCost: 50, unitPrice: 58, barcode: '' }] }), 'items'); step('supplier records items without a barcode');
const instNotes = (await inst('GET', '/api/notifications')).body; assert.ok(instNotes.some((n) => n.kind === 'WAITING_RESEARCH' && /researching market prices/.test(n.message))); step('institution is told NIMRA is researching');
let d = (await inst('GET', `/api/notices/${nid}`)).body; assert.equal(d.waitingForResearch, true); assert.equal(d.notice.status, 'ITEMS_RECORDED'); step('notice shows "waiting for research"');

// admin research with PDF
const form = new FormData();
for (const [k, v] of Object.entries({ itemName: 'a4 PAPER ream', unit: 'ream', unitPrice: '45.50', sourceName: 'Shoprite', sourceLink: 'https://example.com/p', noticeId: String(nid), published: 'true' })) form.append(k, v);
form.append('file', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'research.pdf');
const pr = await admin('POST', '/api/prices', undefined, form); ok(pr, 'price'); step('admin adds a reference price with a PDF (stored in the database)');
assert.equal((await admin('POST', '/api/prices', { itemName: 'x', unitPrice: 1, sourceName: 's' })).status, 400); step('a price needs a link or contact');
const file = await inst('GET', `/api/prices/${pr.body.id}/file`); ok(file, 'file'); assert.equal(file.headers.get('content-type'), 'application/pdf'); assert.match(file.body.toString(), /%PDF/); step('institution downloads the published PDF');
d = (await supp('GET', `/api/notices/${nid}`)).body; assert.equal(d.lines[0].benchmark, 45.5); assert.equal(d.research.length, 1); assert.equal(d.waitingForResearch, false); step('benchmark matches the item name (case-insensitive)');

// reject with comment, resubmit, approve
assert.equal((await admin('POST', `/api/notices/${nid}/return`, { comment: '' })).status, 400);
ok(await admin('POST', `/api/notices/${nid}/return`, { comment: 'Price is above the market; lower it.' }), 'return'); step('admin returns the items with a comment');
assert.ok((await supp('GET', '/api/notifications')).body.some((n) => n.kind === 'RETURNED' && /above the market/.test(n.message))); step('supplier sees the comment');
ok(await supp('POST', `/api/notices/${nid}/items`, { lines: [{ description: 'A4 paper ream', quantity: 100, unitCost: 50, unitPrice: 52 }] }), 'resubmit'); step('supplier fixes and resubmits');
ok(await admin('POST', `/api/notices/${nid}/approve`, {}), 'approve'); step('admin approves');
assert.equal((await supp('POST', `/api/notices/${nid}/items`, { lines: [{ description: 'x', quantity: 1, unitCost: 1, unitPrice: 1 }] })).status, 400); step('no changes after approval');
ok(await inst('POST', `/api/notices/${nid}/complete`, {}), 'complete'); step('institution completes');

// wastage with year filter
const w = (await inst('GET', '/api/wastage')).body;
const yr = new Date().getUTCFullYear(); assert.equal(w.year, yr); assert.ok(w.years.includes(String(yr)));
assert.equal(w.suppliers.length, 1); assert.equal(w.suppliers[0].waste, 650); assert.equal(w.suppliers[0].margin, 200); step('wastage page: waste K650 and margin K200 for the supplier; year = current year');
const old = (await inst('GET', `/api/wastage?year=${yr - 1}`)).body; assert.equal(old.suppliers.length, 0); step('other years are empty');
assert.equal((await supp('GET', '/api/wastage')).status, 403); step('supplier cannot open wastage');

// visibility
const other = client(); ok(await admin('POST', '/api/accounts', { kind: 'Institution', org: 'Other Inst', name: 'O', phone: '0972000002', pin: '2222' }), 'o'); ok(await other('POST', '/api/login', { phone: '0972000002', pin: '2222' }), 'ol');
assert.equal((await other('GET', `/api/notices/${nid}`)).status, 404); assert.equal((await other('GET', '/api/notices')).body.length, 0); step('another institution cannot see this procurement');

// lock out
const l = client(); for (let i = 0; i < 5; i++) await l('POST', '/api/login', { phone: '0972000002', pin: '0000' });
assert.equal((await l('POST', '/api/login', { phone: '0972000002', pin: '2222' })).status, 429); step('5 wrong PINs lock the account for 15 minutes');
console.log('\nALL CHECKS PASSED');
