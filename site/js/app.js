// NIMRA front end: plain JavaScript, no build step. Everything dynamic goes through html`` which escapes it.
const API = window.NIMRA_API;
const $app = document.getElementById('app');
let me = null;
let flash = null;

// ---------------------------------------------------------------- helpers
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => {
  const v = vals[i - 1];
  const piece = v instanceof Raw ? v.s : Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('') : esc(v);
  return out + piece + s;
}));
const money = (n) => (n == null ? '-' : 'K ' + Number(n).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const date = (s) => (s ? String(s).slice(0, 10) : '');
const STATUS = { NOTIFIED: 'Waiting for items', ITEMS_RECORDED: 'Under review', RETURNED: 'Returned', APPROVED: 'Approved', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };

async function api(method, path, data, form) {
  const opts = { method, credentials: 'include', headers: {} };
  if (form) opts.body = form;
  else if (data !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(data); }
  let res;
  try { res = await fetch(API + path, opts); } catch { throw new Error('Cannot reach the server. Check your internet connection.'); }
  const out = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { me = null; location.hash = '#/login'; throw new Error('Please sign in.'); }
  if (!res.ok) throw new Error(out.error || 'Something went wrong.');
  return out;
}
const setFlash = (kind, text) => { flash = { kind, text }; };
const flashHtml = () => { const f = flash; flash = null; return f ? html`<div class="flash ${f.kind}">${f.text}</div>` : ''; };
const formData = (form) => Object.fromEntries(new FormData(form).entries());

// ---------------------------------------------------------------- shell (orange app tags, same idea as the main app)
function menu() {
  const r = me.role;
  const items = [{ tag: 'Procurement' }, { to: '#/notices', label: 'Procurements' }];
  if (r === 'Institution') items.push({ to: '#/new', label: 'Notify a procurement' }, { to: '#/wastage', label: 'Wastage' });
  if (r === 'Admin') items.push({ to: '#/wastage', label: 'Wastage' });
  items.push({ tag: 'Market research' }, { to: '#/prices', label: 'Reference prices' });
  if (r === 'Admin') items.push({ tag: 'People' }, { to: '#/accounts', label: 'Accounts' });
  if (r === 'Institution') items.push({ tag: 'Settings' }, { to: '#/settings', label: 'Limits' });
  return items;
}
function shell(title, content) {
  const cur = location.hash.split('?')[0];
  const nav = menu().map((i) => i.tag ? html`<div class="tag">${i.tag}</div>` : html`<a class="nl ${cur === i.to ? 'on' : ''}" href="${i.to}">${i.label}</a>`);
  $app.innerHTML = html`<div class="shell">
    <aside class="side" id="side"><div class="brand"><span class="logo">N</span> NIMRA</div><nav>${nav}</nav>
      <div class="foot">${me.name}<br><span class="muted" style="color:#9fd3c0">${me.org}</span><button data-act="logout">Sign out</button></div></aside>
    <div class="main"><div class="top"><button class="burger" data-act="menu" aria-label="Menu">&#9776;</button><h2 style="margin:0">${title}</h2>
      <a class="bell" href="#/notifications">Notifications${me.unread ? html`<span class="n">${me.unread}</span>` : ''}</a></div>
      <div class="page">${flashHtml()}${content}</div></div></div>`.s;
}

// ---------------------------------------------------------------- pages
const pages = {};

pages.login = async () => {
  $app.innerHTML = html`<div class="login"><div style="width:100%;max-width:400px"><h1>NIMRA</h1><p class="lead">National Independent Market Research Agency</p>
    <div class="card">${flashHtml()}<form id="f"><label>Phone number</label><input name="phone" inputmode="tel" autocomplete="username" placeholder="0971 234 567" required>
      <label>PIN</label><input name="pin" type="password" inputmode="numeric" autocomplete="current-password" required>
      <p><button style="width:100%">Sign in</button></p></form></div></div></div>`.s;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/login', formData(e.target)); location.hash = '#/notices'; route(); }
    catch (err) { setFlash('err', err.message); pages.login(); }
  };
};

pages.notices = async (q) => {
  const status = q.get('status') || '';
  const list = await api('GET', '/api/notices' + (status ? `?status=${status}` : ''));
  const chips = ['', ...Object.keys(STATUS)].map((s) => html`<a class="chip ${s === status ? 'on' : ''}" href="#/notices${s ? '?status=' + s : ''}">${s ? STATUS[s] : 'All'}</a>`);
  shell('Procurements', html`<div class="chips">${chips}</div><div class="card scroll"><table><thead><tr><th>#</th><th>Item</th><th>${me.role === 'Supplier' ? 'Institution' : 'Supplier'}</th><th>Qty</th><th>Needed by</th><th>Status</th><th>Next</th></tr></thead><tbody>
    ${list.map((n) => html`<tr><td><a href="#/notice/${n.id}">${n.id}</a></td><td><a href="#/notice/${n.id}">${n.title}</a></td><td>${me.role === 'Supplier' ? n.institution : n.supplier}</td><td>${n.quantity} ${n.unit}</td><td>${n.needed_by}</td><td><span class="pill ${n.status}">${STATUS[n.status]}</span></td><td class="muted">${n.next}</td></tr>`)}
    ${list.length ? '' : html`<tr><td colspan="7" class="muted">Nothing here yet.</td></tr>`}</tbody></table></div>`);
};

pages.new = async () => {
  const sup = await api('GET', '/api/suppliers');
  shell('Notify a procurement', html`<div class="card"><form id="f"><div class="row">
    <div><label>What are you buying?</label><input name="title" required></div>
    <div><label>Supplier</label><select name="supplierId" required><option value="">Choose...</option>${sup.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></div>
    <div><label>Quantity</label><input name="quantity" inputmode="decimal" required></div>
    <div><label>Unit</label><input name="unit" placeholder="ream, box, each" required></div>
    <div><label>Needed by</label><input name="neededBy" type="date" required></div></div>
    <p><button>Notify</button></p></form></div>`);
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await api('POST', '/api/notices', formData(e.target)); setFlash('ok', 'Procurement notified. The supplier has been told.'); location.hash = '#/notice/' + r.id; }
    catch (err) { setFlash('err', err.message); pages.new(); }
  };
};

const lineRow = (l = {}) => html`<tr class="ln"><td><input name="description" value="${l.description ?? ''}" required></td><td><input name="quantity" inputmode="decimal" value="${l.quantity ?? ''}" required style="min-width:70px"></td>
  <td><input name="unitCost" inputmode="decimal" value="${l.unit_cost ?? ''}" required style="min-width:80px"></td><td><input name="unitPrice" inputmode="decimal" value="${l.unit_price ?? ''}" required style="min-width:80px"></td>
  <td><input name="barcode" value="${l.barcode ?? ''}" placeholder="optional" style="min-width:110px"></td><td><button type="button" class="ghost sm" data-act="rmline">x</button></td></tr>`;

pages.notice = async (q, id) => {
  const d = await api('GET', `/api/notices/${id}`);
  const n = d.notice; const role = me.role;
  const canRecord = role === 'Supplier' && ['NOTIFIED', 'RETURNED'].includes(n.status);
  const lastReturn = [...d.events].reverse().find((e) => e.kind === 'RETURNED');
  let body = html`<div class="next"><b>Next:</b> ${n.next}</div>
    ${d.waitingForResearch && role === 'Institution' ? html`<div class="flash ok">NIMRA is researching market prices for these items. You will be told when the research is published.</div>` : ''}
    ${n.status === 'RETURNED' && lastReturn ? html`<div class="flash err"><b>NIMRA's comment:</b> ${lastReturn.comment}</div>` : ''}
    <div class="card"><div class="row"><div><span class="muted">Item</span><br><b>${n.title}</b></div><div><span class="muted">Quantity</span><br>${n.quantity} ${n.unit}</div>
      <div><span class="muted">Institution</span><br>${n.institution}</div><div><span class="muted">Supplier</span><br>${n.supplier}</div><div><span class="muted">Needed by</span><br>${n.needed_by}</div>
      <div><span class="muted">Status</span><br><span class="pill ${n.status}">${STATUS[n.status]}</span></div></div></div>`;
  if (canRecord) {
    body = html`${body}<div class="card"><h3>Items you will supply</h3><p class="muted">Give the cost to you and the price you charge, for one item. The institution allows a margin of at most ${d.marginLimitPercent}% over your cost. A barcode is optional.</p>
      <form id="items"><div id="itemsErr" class="flash err" style="display:none"></div><div class="scroll"><table><thead><tr><th>Item</th><th>Qty</th><th>Cost per item</th><th>Price per item</th><th>Barcode</th><th></th></tr></thead><tbody id="lines">
      ${(d.lines.length ? d.lines : [{ description: n.title, quantity: n.quantity }]).map(lineRow)}</tbody></table></div>
      <label>Comment (optional)</label><input name="comment" maxlength="500"><p><button type="button" class="ghost" data-act="addline">Add an item</button> <button>Send to NIMRA</button></p></form></div>`;
  } else if (d.lines.length) {
    body = html`${body}<div class="card scroll"><h3>Items</h3><table><thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Price per item</th><th class="right">Market price</th><th class="right">Margin %</th><th class="right">Margin made</th><th class="right">Waste</th></tr></thead><tbody>
      ${d.lines.map((l) => html`<tr><td>${l.description}${l.barcode ? html`<br><span class="muted">${l.barcode}</span>` : ''}</td><td class="right">${l.quantity}</td><td class="right">${money(l.unit_price)}</td>
        <td class="right">${l.benchmark == null ? html`<span class="muted">no research yet</span>` : money(l.benchmark)}</td><td class="right">${l.markupPercent == null ? '-' : l.markupPercent + '%'}</td>
        <td class="right margin">${money(l.marginMade)}</td><td class="right waste">${l.waste == null ? '-' : money(l.waste)}</td></tr>`)}</tbody></table></div>`;
  }
  if (d.research.length) body = html`${body}<div class="card scroll"><h3>Market research (price of one item)</h3><table><thead><tr><th>Item</th><th class="right">Price per item</th><th>Source</th><th>Document</th>${role === 'Admin' ? html`<th>Shown</th>` : ''}</tr></thead><tbody>
    ${d.research.map((r) => html`<tr><td>${r.item_name}</td><td class="right">${money(r.unit_price)}</td><td>${r.source_name}${r.source_link ? html`<br><a href="${r.source_link}" target="_blank" rel="noopener">link</a>` : ''}${r.source_contact ? html`<br><span class="muted">${r.source_contact}</span>` : ''}</td>
      <td>${r.file_name ? html`<a href="#" data-act="pdf" data-id="${r.id}">${r.file_name}</a>` : ''}</td>${role === 'Admin' ? html`<td>${r.published ? 'Yes' : 'No'}</td>` : ''}</tr>`)}</tbody></table></div>`;
  if (role === 'Admin' && n.status === 'ITEMS_RECORDED') body = html`${body}<div class="card"><h3>Review</h3>
    <form id="approve"><label>Comment (optional)</label><input name="comment"><p><button>Approve</button></p></form>
    <form id="return"><label>Return to the supplier with a comment</label><textarea name="comment" rows="2" required placeholder="What must the supplier change?"></textarea><p><button class="warn">Return with comment</button></p></form></div>`;
  if (role === 'Admin') body = html`${body}<div class="card"><h3>Add market research for this procurement</h3>${priceForm(n.id, n.title)}</div>`;
  if (role === 'Institution' && n.status === 'APPROVED') body = html`${body}<div class="card"><button data-act="complete">Mark as completed</button></div>`;
  if (role === 'Institution' && ['NOTIFIED', 'RETURNED', 'ITEMS_RECORDED'].includes(n.status)) body = html`${body}<div class="card"><form id="cancel"><label>Cancel this procurement</label><input name="reason" placeholder="Reason" required><p><button class="warn">Cancel</button></p></form></div>`;
  body = html`${body}<div class="card"><h3>History</h3>${d.events.map((e) => html`<div><span class="muted">${e.created_at}</span> <b>${e.kind.replace('_', ' ').toLowerCase()}</b> ${e.by ? 'by ' + e.by : ''}${e.comment ? ' - ' + e.comment : ''}</div>`)}</div>`;
  shell(`Procurement #${n.id}`, body);

  const lines = document.getElementById('lines');
  const act = async (fn, okMsg) => { try { await fn(); setFlash('ok', okMsg); await refreshMe(); route(); } catch (err) { setFlash('err', err.message); route(); } };
  const items = document.getElementById('items');
  if (items) items.onsubmit = async (e) => { e.preventDefault(); const ls = [...lines.querySelectorAll('tr.ln')].map((tr) => Object.fromEntries([...tr.querySelectorAll('input')].map((i) => [i.name, i.value])));
    const box = document.getElementById('itemsErr'); box.textContent = ''; box.style.display = 'none';
    try { await api('POST', `/api/notices/${id}/items`, { lines: ls, comment: items.comment.value }); setFlash('ok', 'Items sent to NIMRA.'); await refreshMe(); route(); }
    catch (err) { box.textContent = err.message; box.style.display = 'block'; box.scrollIntoView({ block: 'center' }); } }; // keep what the supplier typed
  const ap = document.getElementById('approve'); if (ap) ap.onsubmit = (e) => { e.preventDefault(); act(() => api('POST', `/api/notices/${id}/approve`, formData(ap)), 'Approved.'); };
  const rt = document.getElementById('return'); if (rt) rt.onsubmit = (e) => { e.preventDefault(); act(() => api('POST', `/api/notices/${id}/return`, formData(rt)), 'Returned to the supplier with your comment.'); };
  const cn = document.getElementById('cancel'); if (cn) cn.onsubmit = (e) => { e.preventDefault(); if (confirm('Cancel this procurement?')) act(() => api('POST', `/api/notices/${id}/cancel`, formData(cn)), 'Cancelled.'); };
  wirePriceForm(() => route());
};

function priceForm(noticeId, itemName) {
  return html`<form class="pf" enctype="multipart/form-data"><input type="hidden" name="noticeId" value="${noticeId ?? ''}"><div class="row">
    <div><label>Item name</label><input name="itemName" value="${itemName ?? ''}" required></div>
    <div><label>Price of ONE single item (K)</label><input name="unitPrice" inputmode="decimal" required></div>
    <div><label>Unit</label><input name="unit" placeholder="each"></div>
    <div><label>Source name</label><input name="sourceName" required></div>
    <div><label>Source link</label><input name="sourceLink" placeholder="https://..."></div>
    <div><label>or source contact</label><input name="sourceContact" placeholder="phone or email"></div>
    <div><label>Notes</label><input name="notes"></div>
    <div><label>Research PDF (optional)</label><input name="file" type="file" accept="application/pdf"></div></div>
    <label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" name="published" value="true" style="width:auto" checked> Show to the institution and supplier</label>
    <p><button>Add price</button></p></form>`;
}
function wirePriceForm(after) {
  document.querySelectorAll('form.pf').forEach((f) => {
    f.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(f); if (!fd.get('published')) fd.set('published', 'false');
      try { await api('POST', '/api/prices', undefined, fd); setFlash('ok', 'Price added.'); } catch (err) { setFlash('err', err.message); }
      after();
    };
  });
}

pages.prices = async (q) => {
  const term = q.get('q') || '';
  const list = await api('GET', '/api/prices' + (term ? `?q=${encodeURIComponent(term)}` : ''));
  shell('Reference prices', html`<p class="muted">Every price here is for <b>one single item</b>.</p>
    <form id="s" class="card" style="display:flex;gap:.5rem"><input name="q" value="${term}" placeholder="Search an item"><button>Search</button></form>
    ${me.role === 'Admin' ? html`<div class="card"><h3>Add a price</h3>${priceForm(null, '')}</div>` : ''}
    <div class="card scroll"><table><thead><tr><th>Item</th><th class="right">Price per item</th><th>Source</th><th>Date</th><th>Document</th>${me.role === 'Admin' ? html`<th>Shown</th>` : ''}</tr></thead><tbody>
    ${list.map((p) => html`<tr><td>${p.itemName}${p.noticeId ? html`<br><a class="muted" href="#/notice/${p.noticeId}">procurement #${p.noticeId}</a>` : ''}</td><td class="right">${money(p.unitPrice)}<br><span class="muted">per ${p.unit || 'item'}</span></td>
      <td>${p.sourceName}${p.sourceLink ? html`<br><a href="${p.sourceLink}" target="_blank" rel="noopener">link</a>` : ''}${p.sourceContact ? html`<br><span class="muted">${p.sourceContact}</span>` : ''}</td><td>${date(p.createdAt)}</td>
      <td>${p.fileName ? html`<a href="#" data-act="pdf" data-id="${p.id}">${p.fileName}</a>` : ''}${me.role === 'Admin' ? html`<br><label class="sm" style="font-weight:400">${p.fileName ? 'Replace' : 'Attach'} PDF <input type="file" accept="application/pdf" data-act="attach" data-id="${p.id}" style="width:auto"></label>` : ''}</td>
      ${me.role === 'Admin' ? html`<td><button class="ghost sm" data-act="publish" data-id="${p.id}" data-pub="${p.published ? 0 : 1}">${p.published ? 'Hide' : 'Show'}</button></td>` : ''}</tr>`)}
    ${list.length ? '' : html`<tr><td colspan="6" class="muted">No prices yet.</td></tr>`}</tbody></table></div>`);
  document.getElementById('s').onsubmit = (e) => { e.preventDefault(); location.hash = '#/prices?q=' + encodeURIComponent(e.target.q.value); };
  wirePriceForm(() => route());
};

pages.wastage = async (q) => {
  const year = q.get('year') || '';
  const d = await api('GET', '/api/wastage' + (year ? `?year=${year}` : ''));
  const max = Math.max(1, ...d.suppliers.map((s) => Math.max(s.waste, s.margin)));
  shell('Wastage', html`<div class="chips">${d.years.map((y) => html`<a class="chip ${String(d.year) === y ? 'on' : ''}" href="#/wastage?year=${y}">${y}</a>`)}</div>
    <div class="kpis"><div class="kpi">Quoted<b>${money(d.total.quoted)}</b></div><div class="kpi w">Waste (charged above market)<b>${money(d.total.waste)}</b></div><div class="kpi m">Supplier margin made<b>${money(d.total.margin)}</b></div></div>
    <div class="card bars"><h3>By supplier, ${d.year}</h3><p class="legend muted"><span style="background:var(--bad)"></span>Waste <span style="background:var(--brown);margin-left:.8rem"></span>Margin made</p>
    ${d.suppliers.map((s) => html`<div style="margin:.8rem 0"><b>${s.supplier}</b> <span class="muted">${s.notices} procurement(s), quoted ${money(s.quoted)}${s.wastePercent == null ? '' : ', waste ' + s.wastePercent + '%'}</span>
      ${s.wastePercent != null && s.wastePercent > d.thresholdPercent ? html`<span class="pill RETURNED">above ${d.thresholdPercent}% limit</span>` : ''}
      <div class="b waste" style="width:${(s.waste / max) * 100}%;min-width:2px"></div><span class="waste">${money(s.waste)}</span>
      <div class="b margin" style="width:${(s.margin / max) * 100}%;min-width:2px"></div><span class="margin">${money(s.margin)}</span></div>`)}
    ${d.suppliers.length ? '' : html`<p class="muted">No approved procurements in ${d.year}.</p>`}</div>`);
};

pages.settings = async () => {
  const s = await api('GET', '/api/institution/settings');
  shell('Limits', html`<div class="card"><form id="f"><div class="row">
    <div><label>Supplier margin limit (% over the supplier's cost)</label><input name="marginLimitPercent" inputmode="decimal" value="${s.marginLimitPercent ?? ''}" placeholder="${s.globalMargin} (NIMRA default)"></div>
    <div><label>Wastage limit (%)</label><input name="wastageThresholdPercent" inputmode="decimal" value="${s.wastageThresholdPercent ?? ''}" placeholder="${s.globalWastage} (NIMRA default)"></div></div>
    <p class="muted">Suppliers cannot send you items priced above the margin limit. Leave empty to use NIMRA's default.</p><p><button>Save</button></p></form></div>`);
  document.getElementById('f').onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/api/institution/settings', formData(e.target)); setFlash('ok', 'Saved.'); } catch (err) { setFlash('err', err.message); } route(); };
};

pages.accounts = async () => {
  const rows = await api('GET', '/api/accounts');
  shell('Accounts', html`<div class="card"><h3>New account</h3><form id="f"><div class="row">
    <div><label>Type</label><select name="kind"><option>Institution</option><option>Supplier</option></select></div>
    <div><label>Organisation name</label><input name="org" required></div><div><label>Contact name</label><input name="name" required></div>
    <div><label>Phone</label><input name="phone" inputmode="tel" required></div><div><label>PIN (4 to 8 digits)</label><input name="pin" inputmode="numeric" required></div></div><p><button>Create</button></p></form></div>
    <div class="card scroll"><table><thead><tr><th>Organisation</th><th>Type</th><th>Contact</th><th>Phone</th><th></th></tr></thead><tbody>
    ${rows.map((r) => html`<tr><td>${r.org}</td><td>${r.kind}</td><td>${r.name}</td><td>${r.phone}</td><td><button class="ghost sm" data-act="active" data-id="${r.orgId}" data-on="${r.orgActive ? 0 : 1}">${r.orgActive ? 'Disable' : 'Enable'}</button></td></tr>`)}</tbody></table></div>`);
  document.getElementById('f').onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/api/accounts', formData(e.target)); setFlash('ok', 'Account created.'); } catch (err) { setFlash('err', err.message); } route(); };
};

pages.notifications = async () => {
  const list = await api('GET', '/api/notifications');
  await api('POST', '/api/notifications/read'); await refreshMe();
  shell('Notifications', html`<div class="card">${list.map((n) => html`<div style="padding:.5rem 0;border-bottom:1px solid #e3f0ea;${n.readAt ? 'opacity:.65' : 'font-weight:600'}">${n.link ? html`<a href="${n.link}">${n.message}</a>` : n.message}<br><span class="muted" style="font-weight:400">${n.createdAt}</span></div>`)}${list.length ? '' : html`<p class="muted">No notifications.</p>`}</div>`);
};

// ---------------------------------------------------------------- events and router
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act;
  if (act === 'menu') document.getElementById('side').classList.toggle('open');
  if (act === 'logout') { await api('POST', '/api/logout').catch(() => {}); me = null; location.hash = '#/login'; route(); }
  if (act === 'addline') { const tb = document.getElementById('lines'); tb.insertAdjacentHTML('beforeend', lineRow().s); }
  if (act === 'rmline') { const tb = document.getElementById('lines'); if (tb.rows.length > 1) el.closest('tr').remove(); }
  if (act === 'pdf') { e.preventDefault(); openPdf(el.dataset.id); }
  if (act === 'complete') { try { await api('POST', `/api/notices/${location.hash.split('/')[2]}/complete`, {}); setFlash('ok', 'Marked as completed.'); } catch (err) { setFlash('err', err.message); } route(); }
  if (act === 'publish') { await api('POST', `/api/prices/${el.dataset.id}/publish`, { published: el.dataset.pub === '1' }); route(); }
  if (act === 'active') { await api('POST', `/api/accounts/${el.dataset.id}/active`, { active: el.dataset.on === '1' }); route(); }
});
document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-act="attach"]'); if (!el || !el.files[0]) return;
  const fd = new FormData(); fd.set('file', el.files[0]);
  try { await api('POST', `/api/prices/${el.dataset.id}/file`, undefined, fd); setFlash('ok', 'PDF attached.'); } catch (err) { setFlash('err', err.message); }
  route();
});
// the PDF needs the sign-in cookie, so fetch it and open the blob
async function openPdf(id) {
  const res = await fetch(`${API}/api/prices/${id}/file`, { credentials: 'include' });
  if (!res.ok) { setFlash('err', 'The document could not be opened.'); return route(); }
  window.open(URL.createObjectURL(await res.blob()), '_blank');
}
async function refreshMe() { try { me = await api('GET', '/api/me'); } catch { me = null; } }

async function route() {
  const [path, qs] = (location.hash || '#/').slice(2).split('?');
  const q = new URLSearchParams(qs || '');
  const [name, arg] = path.split('/');
  if (name === 'login') return pages.login();
  if (!me) { await refreshMe(); if (!me) { location.hash = '#/login'; return pages.login(); } }
  const page = pages[name || 'notices'];
  try { if (!page) { location.hash = '#/notices'; return; } await page(q, arg); }
  catch (err) { if (me) { setFlash('err', err.message); shell('Something went wrong', html``); } }
}
window.addEventListener('hashchange', () => route());
route();
