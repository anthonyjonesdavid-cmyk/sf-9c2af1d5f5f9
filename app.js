'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// All 9 reach >= 6.5:1 contrast with black text (checked with WCAG relative luminance).
const COLORS = ['#ff5c7a', '#ffb547', '#ffe066', '#7ee787', '#4fc3f7', '#6b9bff', '#c4a3ff', '#ff8cd9', '#b4bac4'];
const OLD_COLORS = { '#4f8cff': '#6b9bff', '#b48cff': '#c4a3ff', '#9aa1ad': '#b4bac4' };
const WIDE = matchMedia('(min-width:1100px) and (orientation:landscape)');

/* ---------- IndexedDB ---------- */
let dbp;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('snapfeed', 1);
    r.onupgradeneeded = () => { const d = r.result; for (const s of ['shots', 'blobs', 'tags', 'inbox']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode); let out;
    Promise.resolve(fn(...[].concat(stores).map(s => t.objectStore(s)))).then(v => out = v);
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const getAll = s => tx(s, 'readonly', st => req(st.getAll()));
const put = (s, v) => tx(s, 'readwrite', st => { st.put(v); });
const getOne = (s, id) => tx(s, 'readonly', st => req(st.get(id)));
// Images are stored as ArrayBuffers (Blobs in IndexedDB fail in some WebKit modes).
const asBlobs = r => r && ({ id: r.id, full: r.full instanceof Blob ? r.full : new Blob([r.full], { type: r.ftype || 'image/png' }), thumb: r.thumb instanceof Blob ? r.thumb : new Blob([r.thumb], { type: 'image/jpeg' }) });
const getBlobs = id => getOne('blobs', id).then(asBlobs);

/* ---------- state ---------- */
const S = { home: true, shots: [], tags: [], filter: null, q: '', grid: false, select: false, sel: new Set(), cur: null, view: [] };
const thumbURL = new Map();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const tagById = id => S.tags.find(t => t.id === id);

/* ---------- EXIF / dates ---------- */
function exifDate(buf) {
  try {
    const v = new DataView(buf);
    let tiff = -1;
    if (v.getUint16(0) === 0xFFD8) {
      let o = 2;
      while (o < v.byteLength - 4) {
        const m = v.getUint16(o), len = v.getUint16(o + 2);
        if (m === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) { tiff = o + 10; break; }
        if ((m & 0xFF00) !== 0xFF00 || m === 0xFFDA) break;
        o += 2 + len;
      }
    } else if (v.getUint32(0) === 0x89504E47) {
      let o = 8;
      while (o < v.byteLength - 8) {
        const len = v.getUint32(o), type = v.getUint32(o + 4);
        if (type === 0x65584966) { tiff = o + 8; break; } // eXIf
        if (type === 0x49444154) break; // IDAT
        o += 12 + len;
      }
    }
    if (tiff < 0) return null;
    const le = v.getUint16(tiff) === 0x4949;
    const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
    const readIfd = (off, want) => {
      const n = u16(tiff + off); const out = {};
      for (let i = 0; i < n; i++) { const e = tiff + off + 2 + i * 12; const tag = u16(e); if (want.includes(tag)) out[tag] = { type: u16(e + 2), cnt: u32(e + 4), val: u32(e + 8) }; }
      return out;
    };
    const ifd0 = readIfd(u32(tiff + 4), [0x8769, 0x0132]);
    let ent = null;
    if (ifd0[0x8769]) { const ex = readIfd(ifd0[0x8769].val, [0x9003, 0x9004]); ent = ex[0x9003] || ex[0x9004]; }
    ent ||= ifd0[0x0132];
    if (!ent) return null;
    let s = ''; for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(tiff + ent.val + i));
    const m = s.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
    if (!m || m[1] === '0000') return null;
    return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  } catch { return null; }
}
async function sha(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function loadImg(blob) {
  if (self.createImageBitmap) { try { return await createImageBitmap(blob); } catch {} }
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(blob); });
}
async function makeThumb(blob) {
  const img = await loadImg(blob);
  const w = img.width, h = img.height, tw = Math.min(600, w), th = Math.round(h * tw / w);
  const c = document.createElement('canvas'); c.width = tw; c.height = th;
  c.getContext('2d').drawImage(img, 0, 0, tw, th);
  img.close?.();
  const t = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
  return { thumb: t, w, h };
}

/* ---------- import ---------- */
async function importFiles(files, opts = {}) {
  files = [...files].filter(f => f && (f.type.startsWith('image/') || /\.(png|jpe?g|heic|gif|webp)$/i.test(f.name || '')));
  if (!files.length) return;
  const hashes = new Set(S.shots.map(s => s.hash));
  let added = 0, dup = 0, bad = 0;
  for (let i = 0; i < files.length; i++) {
    status(`Importing ${i + 1} of ${files.length}…`);
    const f = files[i];
    try {
      const buf = await f.arrayBuffer();
      const hash = await sha(buf);
      if (hashes.has(hash)) { dup++; continue; }
      const blob = new Blob([buf], { type: f.type || 'image/png' });
      const { thumb, w, h } = await makeThumb(blob);
      const tbuf = await thumb.arrayBuffer();
      const now = Date.now();
      const ex = exifDate(buf);
      const meta = opts.meta || {};
      const shot = {
        id: meta.id || uid(), hash, w, h, type: blob.type, name: f.name || '',
        date: meta.date || ex || (f.lastModified && f.lastModified < now - 2000 ? f.lastModified : null) || now,
        dateSrc: meta.dateSrc || (ex ? 'exif' : f.lastModified && f.lastModified < now - 2000 ? 'file' : 'import'),
        added: meta.added || now, caption: meta.caption || '', tags: meta.tags || [], pinned: !!meta.pinned, ocr: meta.ocr ?? null, dismissed: meta.dismissed || []
      };
      await tx(['shots', 'blobs'], 'readwrite', (a, b) => { a.put(shot); b.put({ id: shot.id, full: buf, ftype: blob.type, thumb: tbuf }); });
      hashes.add(hash); S.shots.push(shot); added++;
    } catch (e) { console.error(e); bad++; }
  }
  status('');
  render();
  toast(`Added ${added}` + (dup ? `, skipped ${dup} duplicate${dup > 1 ? 's' : ''}` : '') + (bad ? `, ${bad} failed` : ''));
  return { added, dup, bad };
}
async function drainInbox() {
  const items = await getAll('inbox');
  if (!items.length) return;
  await importFiles(items.map(i => new File([i.buf], i.name || 'shared.png', { type: i.type || 'image/png', lastModified: i.lastModified })));
  await tx('inbox', 'readwrite', st => { st.clear(); });
  history.replaceState(null, '', location.pathname);
}

/* ---------- derived ---------- */
function visible() {
  const q = S.q.trim().toLowerCase();
  let list = S.shots.filter(s => {
    if (S.filter === '__untagged') { if (s.tags.length) return false; }
    else if (S.filter === '__pinned') { if (!s.pinned) return false; }
    else if (S.filter && !s.tags.includes(S.filter)) return false;
    if (!q) return true;
    const hay = [s.caption, s.ocr || '', s.name, ...s.tags.map(t => tagById(t)?.name || '')].join(' ').toLowerCase();
    return q.split(/\s+/).every(w => hay.includes(w));
  });
  list.sort((a, b) => (S.grid ? 0 : (b.pinned - a.pinned)) || b.date - a.date || b.added - a.added);
  return list;
}
const fmtDate = t => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
function getThumb(id) {
  if (thumbURL.has(id)) return Promise.resolve(thumbURL.get(id));
  return getBlobs(id).then(b => { const u = b ? URL.createObjectURL(b.thumb) : ''; thumbURL.set(id, u); return u; });
}
async function fullURL(id) { const b = await getBlobs(id); return b ? URL.createObjectURL(b.full) : ''; }
function sortedTags() { return [...S.tags].sort((a, b) => (b.pinned - a.pinned) || a.name.localeCompare(b.name)); }
const chipHTML = (t, cls = '') => `<span class="chip filled ${cls}" style="--c:${t.color}" data-tag="${t.id}"><span class="dot" style="background:${t.color}"></span>${esc(t.name)}</span>`;


/* ---------- smart tag suggestions (on-device keyword rules) ---------- */
const RULES = [
  ['Receipts', [/\b(sub)?total\b/i, /\border\s*(#|no\.?|number)/i, /\breceipt\b/i, /\btax\b/i, /\$\s?\d+[.,]\d\d/, /\bqty\b/i, /\bpurchase/i], 2],
  ['Shipping', [/\btracking\b/i, /\bUPS\b/, /\bUSPS\b/i, /\bfed\s?ex\b/i, /\bDHL\b/, /\bdelivered\b/i, /\bshipped\b/i, /\bout for delivery\b/i, /\b1Z[0-9A-Z]{8,}/, /\bpackage\b/i], 1],
  ['Recipes', [/\bcups?\b/i, /\btbsp\b/i, /\btsp\b/i, /\bpreheat\b/i, /\bingredients?\b/i, /\brecipe\b/i, /\boven\b/i, /\b\d+\s?(oz|lb|g)\b/i, /\bbake\b/i], 2],
  ['Travel', [/\bflight\b/i, /\bgate\b/i, /\bboarding\b/i, /\bconfirmation\b/i, /\bdepart(s|ure)?\b/i, /\bterminal\b/i, /\bseat\b/i, /\bhotel\b/i, /\bcheck-?in\b/i, /\b[A-Z]{3}\s?(to|→|-)\s?[A-Z]{3}\b/], 2],
  ['Messages', [/\bimessage\b/i, /\btext message\b/i, /\bread \d/i, /\btyping\b/i, /\btoday \d{1,2}:\d\d/i, /\byesterday\b/i, /\blol\b/i, /\bsee you\b/i, /\bdinner\b/i, /\?\s*$/m], 2],
  ['Maps', [/\bdirections?\b/i, /\b\d+(\.\d)?\s?mi\b/i, /\baddress\b/i, /\broute\b/i, /\b(st|ave|rd|blvd|hwy)\b\.?/i, /\b\d+\s?min drive\b/i, /\bpark\b/i, /\bnavigat/i], 2],
  ['Codes', [/\bverification code\b/i, /\bOTP\b/, /\bpasscode\b/i, /\bpassword\b/i, /\bone-time\b/i, /\bcode is\b/i, /\bwi-?fi\b/i, /\bPIN\b/], 1],
  ['Social', [/\blikes?\b/i, /\bretweets?\b/i, /\breposts?\b/i, /\bfollowers?\b/i, /\bfollow\b/i, /(^|\s)@\w{2,}/, /\bcomments?\b/i, /\bviews\b/i], 2],
  ['Money', [/\bbalance\b/i, /\bpayment\b/i, /\bdeposit\b/i, /\btransfer\b/i, /\bvenmo\b/i, /\bzelle\b/i, /\bavailable\b/i, /\bstatement\b/i, /\bchecking\b/i], 2],
];
const wordRe = n => new RegExp('(^|[^a-z0-9])' + n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/s$/, '') + 's?($|[^a-z0-9])', 'i');
function suggestFor(s) {
  const text = s.ocr; if (!text) return [];
  const have = new Set(s.tags.map(t => tagById(t)?.name.toLowerCase()).filter(Boolean));
  const dis = new Set((s.dismissed || []).map(x => x.toLowerCase()));
  const out = [];
  const add = n => { const k = n.toLowerCase(); if (!have.has(k) && !dis.has(k) && !out.some(o => o.toLowerCase() === k)) out.push(n); };
  for (const t of S.tags) if (t.name.length >= 3 && wordRe(t.name).test(text)) add(t.name);
  const tall = s.h / s.w > 1.7; // phone-shaped screenshot: chat layouts are almost always this
  for (const [name, res, need] of RULES) {
    let hits = res.filter(r => r.test(text)).length;
    if (name === 'Messages' && tall && text.split('\n').filter(l => l.trim().length && l.trim().length < 28).length >= 6) hits++;
    if (hits >= need) add(S.tags.find(t => t.name.toLowerCase() === name.toLowerCase())?.name || name);
  }
  return out;
}
function suggestAll() { S.sugg = new Map(); for (const s of S.shots) { const g = suggestFor(s); if (g.length) S.sugg.set(s.id, g); } }
const suggOf = id => S.sugg?.get(id) || [];
const sugCount = () => [...(S.sugg || new Map()).values()].reduce((a, b) => a + b.length, 0);
const sugHTML = (id, n) => `<span class="chip sm sug" data-sid="${id}" data-sug="${esc(n)}" role="button" aria-label="Accept suggested tag ${esc(n)}">＋ ${esc(n)}<button class="sx" data-x aria-label="Dismiss suggestion">×</button></span>`;
async function acceptSug(ids, name) {
  const t = await createTag(name);
  await setTagOn(ids, t.id, true);
}
async function dismissSug(ids, name) {
  const ch = S.shots.filter(s => ids.includes(s.id));
  ch.forEach(s => { s.dismissed = [...new Set([...(s.dismissed || []), name.toLowerCase()])]; });
  await tx('shots', 'readwrite', st => ch.forEach(s => st.put(s)));
}
async function afterSug() { suggestAll(); render(); if (!$('#viewer').hidden) vUpdate(); if (!$('#sheet').hidden && $('#sheetBox .review')) reviewSheet(); }
document.addEventListener('click', async e => {
  const c = e.target.closest('.chip.sug'); if (!c || S.select) return;
  e.stopPropagation(); e.preventDefault();
  const id = c.dataset.sid, n = c.dataset.sug;
  if (e.target.closest('[data-x]')) { await dismissSug([id], n); toast(`Won't suggest ${n} for this one`); }
  else { await acceptSug([id], n); toast(`Tagged ${n}`); }
  afterSug();
}, true);
function reviewSheet() {
  const groups = new Map();
  for (const [id, names] of S.sugg) for (const n of names) (groups.get(n) || groups.set(n, []).get(n)).push(id);
  const exists = n => S.tags.some(t => t.name.toLowerCase() === n.toLowerCase());
  const body = [...groups].sort((a, b) => b[1].length - a[1].length).map(([n, ids]) => `<div class="rg"><div class="rgh"><b>${esc(n)}</b><span class="mut">${ids.length}${exists(n) ? '' : ' · new tag'}</span><span class="sp"></span><button class="btn" data-ra="dismissall" data-n="${esc(n)}">Dismiss all</button><button class="btn primary" data-ra="acceptall" data-n="${esc(n)}">Accept all</button></div>
    <div class="rgrid">${ids.map(id => `<div class="ri"><img data-id="${id}" alt=""><div class="rib"><button class="ib" data-ra="no" data-n="${esc(n)}" data-id="${id}" aria-label="Dismiss">✕</button><button class="ib ok" data-ra="yes" data-n="${esc(n)}" data-id="${id}" aria-label="Accept">✓</button></div></div>`).join('')}</div></div>`).join('');
  sheet(`<div class="review"><h2>Review suggestions<button class="ib" data-act="close">✕</button></h2>
    <p class="mut" style="margin:0 0 8px;font-size:13px">Suggested from each screenshot's recognised text, on this device. Nothing is tagged until you accept.</p>
    ${body || '<div class="empty" style="padding:30px">No suggestions right now. Run Scan text in Settings to find more.</div>'}</div>`, async e => {
    const b = e.target.closest('[data-ra],[data-act]'); if (!b) return;
    if (b.dataset.act === 'close') return closeSheet();
    const n = b.dataset.n, ids = b.dataset.id ? [b.dataset.id] : groups.get(n);
    if (b.dataset.ra === 'yes' || b.dataset.ra === 'acceptall') await acceptSug(ids, n); else await dismissSug(ids, n);
    afterSug();
  });
  $('#sheetBox').classList.add('big'); lazyImgs($('#sheetBox'));
}

/* ---------- render ---------- */
let io;
function lazyImgs(root) {
  io ||= new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { const im = e.target; io.unobserve(im); getThumb(im.dataset.id).then(u => im.src = u); } }), { rootMargin: '800px' });
  root.querySelectorAll('img[data-id]').forEach(im => thumbURL.has(im.dataset.id) ? im.src = thumbURL.get(im.dataset.id) : io.observe(im));
}
function cardHTML(s) {
  const tags = s.tags.map(tagById).filter(Boolean);
  if (S.grid) return `<div class="card${S.sel.has(s.id) ? ' sel' : ''}" data-id="${s.id}"><img data-id="${s.id}" alt=""></div>`;
  return `<div class="card${S.sel.has(s.id) ? ' sel' : ''}${S.cur === s.id && WIDE.matches ? ' cur' : ''}" data-id="${s.id}">
    <img data-id="${s.id}" alt="" width="${s.w}" height="${s.h}" style="aspect-ratio:${s.w}/${s.h}">
    ${s.pinned ? '<span class="pinb">📌</span>' : ''}
    <div class="meta"><div class="d">${fmtDate(s.date)}</div>
    ${s.caption ? `<div class="cap">${esc(s.caption)}</div>` : ''}
    <div class="chiprow">${tags.map(t => chipHTML(t, 'sm')).join('')}${suggOf(s.id).map(n => sugHTML(s.id, n)).join('')}<button class="tagb" data-act="tag" aria-label="Edit tags">＋#</button></div></div></div>`;
}
function ncols() {
  const w = $('#feedWrap').clientWidth;
  if (!WIDE.matches) return 1;
  return w >= 900 ? 3 : 2;
}
function homeHTML() {
  const latest = f => S.shots.filter(f).sort((a, b) => b.date - a.date)[0];
  const tile = (filter, label, color, f, extra = '') => { const l = latest(f), n = S.shots.filter(f).length;
    return `<button class="tile${extra}" data-filter="${filter}" style="--c:${color}">${l ? `<img data-id="${l.id}" alt="">` : '<div class="noimg"></div>'}<div class="tl"><span class="dot"></span><span class="tn">${label}</span><span class="tc">${n}</span></div></button>`; };
  const sc = sugCount();
  return `<div class="homeh"><h2>Tags</h2>${sc ? `<button class="btn sugbtn" data-act="review">✨ Review ${sc} suggestion${sc === 1 ? '' : 's'}</button>` : ''}</div><div class="tiles">` +
    tile('', 'All screenshots', '#ffffff', () => true) + tile('__pinned', '📌 Pinned', '#e3e5e9', s => s.pinned) + tile('__untagged', 'Untagged', '#c9cdd4', s => !s.tags.length) +
    sortedTags().map(t => tile(t.id, (t.pinned ? '📌 ' : '') + esc(t.name), t.color, s => s.tags.includes(t.id))).join('') +
    `<button class="tile newtile" data-act="newtag"><div class="noimg">＋</div><div class="tl"><span class="tn">New tag</span></div></button></div>`;
}
function setHome(on) {
  S.home = on; $('#app').classList.toggle('home', on); $('#backBtn').hidden = on;
  if (!on && history.state?.feed !== true) history.pushState({ feed: true }, '');
}
function goHome() { if (history.state?.feed) history.back(); else { setHome(true); render(); } }
function renderFeed() {
  const feed = $('#feed');
  $('#app').classList.toggle('home', S.home); $('#backBtn').hidden = S.home;
  if (S.home && S.shots.length && !S.q && !S.select) { S.view = []; feed.innerHTML = homeHTML(); lazyImgs(feed); return; }
  const list = S.view = visible();
  $('#app').classList.toggle('selmode', S.select);
  if (!S.shots.length) {
    feed.innerHTML = `<div class="empty"><div style="font-size:42px">🖼️</div><div>No screenshots yet.</div><div style="font-size:13px;margin-top:6px">Tap Import and pick screenshots from Photos (open the Screenshots album to grab many).</div><button class="btn primary" onclick="document.getElementById('fileIn').click()">Import screenshots</button></div>`;
    return;
  }
  if (!list.length) { feed.innerHTML = `<div class="empty">Nothing matches.</div>`; return; }
  if (S.grid) {
    const groups = new Map();
    for (const s of list) { const k = new Date(s.date).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); (groups.get(k) || groups.set(k, []).get(k)).push(s); }
    feed.innerHTML = [...groups].map(([k, arr]) => `<div class="month"><h3>${k} · ${arr.length}</h3><div class="grid">${arr.map(cardHTML).join('')}</div></div>`).join('');
  } else {
    const n = ncols(), cols = Array.from({ length: n }, () => ({ h: 0, html: [] }));
    for (const s of list) { const c = cols.reduce((a, b) => b.h < a.h - 1 ? b : a); c.html.push(cardHTML(s)); c.h += s.h / s.w + 0.25; }
    feed.innerHTML = `<div class="cols">${cols.map(c => `<div class="col">${c.html.join('')}</div>`).join('')}</div>`;
  }
  lazyImgs(feed);
}
function renderSidebar() {
  const count = id => S.shots.filter(s => s.tags.includes(id)).length;
  const row = (id, label, n, color) => `<button class="srow${color ? ' filled' : ''}${S.filter === id ? ' on' : ''}" ${color ? `style="--c:${color}"` : ''} data-filter="${id ?? ''}">${color ? `<span class="dot" style="background:${color}"></span>` : ''}<span>${label}</span><span class="n">${n}</span></button>`;
  $('#sidebar').innerHTML = row(null, '🖼️ All screenshots', S.shots.length) +
    row('__pinned', '📌 Pinned', S.shots.filter(s => s.pinned).length) +
    row('__untagged', '◌ Untagged', S.shots.filter(s => !s.tags.length).length) +
    (sugCount() ? `<button class="srow sugrow" data-act="review"><span>✨ Review suggestions</span><span class="n">${sugCount()}</span></button>` : '') +
    `<div class="side-h"><span>Tags</span><button class="btn" data-act="manage">Edit</button></div>` +
    sortedTags().map(t => row(t.id, (t.pinned ? '📌 ' : '') + esc(t.name), count(t.id), t.color)).join('') +
    `<button class="srow" data-act="newtag" style="color:var(--acc)">＋ New tag</button>`;
  $('#chips').innerHTML = (sugCount() ? `<span class="chip sugrow" data-act="review">✨ ${sugCount()} suggested</span>` : '') + (S.tags.length ? `<span class="chip${!S.filter ? ' on' : ''}" data-filter="">All</span><span class="chip${S.filter === '__pinned' ? ' on' : ''}" data-filter="__pinned">📌 Pinned</span>` + sortedTags().map(t => chipHTML(t, S.filter === t.id ? 'on' : '').replace('data-tag', 'data-filter')).join('') : '');
}
async function renderDetail() {
  const el = $('#detail');
  const s = S.shots.find(x => x.id === S.cur);
  if (!WIDE.matches) return;
  if (!s) { el.innerHTML = `<div class="empty" style="padding:40px 10px">Select a screenshot to see it here.</div>`; return; }
  const tags = s.tags.map(tagById).filter(Boolean);
  el.innerHTML = `<img id="dImg" alt="">
   <div class="row"><button class="btn" data-act="open">Open</button><button class="btn" data-act="tag">Tags</button><button class="btn" data-act="pin">${s.pinned ? 'Unpin' : 'Pin'}</button><button class="btn danger" data-act="del">Delete</button></div>
   <div class="card-d" style="color:var(--mut);font-size:13px">${fmtDate(s.date)} <span style="opacity:.7">(${{ exif: 'from photo data', file: 'file date', import: 'import time' }[s.dateSrc] || ''})</span></div>
   <div class="chiprow" style="margin:8px 0">${tags.map(t => chipHTML(t, 'sm')).join('') || (suggOf(s.id).length ? '' : '<span style="color:var(--mut);font-size:13px">No tags</span>')}${suggOf(s.id).map(n => sugHTML(s.id, n)).join('')}</div>
   <textarea id="dCap" placeholder="Add a caption">${esc(s.caption)}</textarea>
   ${s.ocr ? `<div style="color:var(--mut);font-size:12px;margin-top:10px">Recognised text</div><div class="ocr">${esc(s.ocr)}</div>` : ''}`;
  const id = s.id;
  getThumb(id).then(u => { const im = $('#dImg'); if (im && S.cur === id) im.src = u; });
  fullURL(id).then(u => { const im = $('#dImg'); if (im && S.cur === id) { im.onload = () => {}; im.src = u; } });
  $('#dCap').onchange = e => setCaption(id, e.target.value);
}
function render() { if (S.sugg) suggestAll(); renderSidebar(); renderFeed(); renderDetail(); updSel(); $('#viewBtn').classList.toggle('on', S.grid); $('#selectBtn').classList.toggle('on', S.select); }
function status(t) { $('#status').textContent = t; }
let tt; function toast(t) { const e = $('#toast'); e.textContent = t; e.hidden = false; clearTimeout(tt); tt = setTimeout(() => e.hidden = true, 2600); }

/* ---------- mutations ---------- */
async function saveShot(s) { await put('shots', s); }
async function setCaption(id, v) { const s = S.shots.find(x => x.id === id); s.caption = v.trim(); await saveShot(s); renderFeed(); }
async function togglePin(id) { const s = S.shots.find(x => x.id === id); s.pinned = !s.pinned; await saveShot(s); render(); if (!$('#viewer').hidden) vUpdate(); }
async function deleteShots(ids) {
  await tx(['shots', 'blobs'], 'readwrite', (a, b) => ids.forEach(id => { a.delete(id); b.delete(id); }));
  ids.forEach(id => { URL.revokeObjectURL(thumbURL.get(id)); thumbURL.delete(id); S.sel.delete(id); });
  S.shots = S.shots.filter(s => !ids.includes(s.id));
  if (ids.includes(S.cur)) S.cur = null;
  render();
}
async function createTag(name) {
  name = (name || '').trim(); if (!name) return null;
  const ex = S.tags.find(t => t.name.toLowerCase() === name.toLowerCase()); if (ex) return ex;
  const t = { id: uid(), name, color: COLORS[S.tags.length % COLORS.length], pinned: false };
  S.tags.push(t); await put('tags', t); return t;
}
async function setTagOn(ids, tagId, on) {
  const ch = [];
  for (const s of S.shots) if (ids.includes(s.id)) { const has = s.tags.includes(tagId); if (on && !has) { s.tags.push(tagId); ch.push(s); } if (!on && has) { s.tags = s.tags.filter(x => x !== tagId); ch.push(s); } }
  await tx('shots', 'readwrite', st => ch.forEach(s => st.put(s)));
}

/* ---------- sheets ---------- */
function sheet(html, onClick) {
  $('#sheetBox').innerHTML = html; $('#sheet').hidden = false;
  $('#sheetBox').onclick = onClick || null;
}
function closeSheet() { $('#sheetBox').style.cssText = ''; $('#sheet').style.cssText = ''; $('#sheetBox').classList.remove('big'); $('#sheet').hidden = true; $('#sheetBox').innerHTML = ''; }
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

function tagSheet(ids) {
  const draw = () => {
    const shots = S.shots.filter(s => ids.includes(s.id));
    sheet(`<h2>Tags${ids.length > 1 ? ` · ${ids.length} items` : ''}<button class="ib" data-act="close">✕</button></h2>
      <div class="trow"><input type="text" id="newTagName" placeholder="New tag name"><button class="btn primary" data-act="add">Add</button></div>
      ${sortedTags().map(t => { const n = shots.filter(s => s.tags.includes(t.id)).length; const st = n === shots.length && n ? 'on' : n ? 'mixed' : ''; return `<div class="trow"><div class="name" data-t="${t.id}" data-st="${st}"><span class="check ${st}"></span><span class="dot" style="width:12px;height:12px;border-radius:50%;background:${t.color}"></span>${esc(t.name)}</div></div>`; }).join('') || '<p style="color:var(--mut)">No tags yet. Create one above.</p>'}
      <div style="text-align:right;margin-top:10px"><button class="btn primary" data-act="close">Done</button></div>`, async e => {
      const a = e.target.closest('[data-act]')?.dataset.act, row = e.target.closest('[data-t]');
      if (a === 'close') { closeSheet(); render(); if (!$('#viewer').hidden) vUpdate(); }
      else if (a === 'add') { const t = await createTag($('#newTagName').value); if (t) { await setTagOn(ids, t.id, true); draw(); } }
      else if (row) { await setTagOn(ids, row.dataset.t, row.dataset.st !== 'on'); draw(); }
    });
    const inp = $('#newTagName'); inp.onkeydown = async e => { if (e.key === 'Enter') { const t = await createTag(inp.value); if (t) { await setTagOn(ids, t.id, true); draw(); } } };
  };
  draw();
}
function manageTags(editId) {
  const draw = () => {
    sheet(`<h2>Edit tags<button class="ib" data-act="close">✕</button></h2>
      ${sortedTags().map(t => t.id === editId ? `<div class="trow"><input type="text" id="rn" value="${esc(t.name)}"><button class="btn primary" data-act="save" data-t="${t.id}">Save</button></div><div class="swatches">${COLORS.map(c => `<span class="sw${c === t.color ? ' on' : ''}" style="background:${c}" data-c="${c}" data-t="${t.id}"></span>`).join('')}</div>` :
      `<div class="trow"><div class="name" data-act="edit" data-t="${t.id}"><span class="dot" style="width:14px;height:14px;border-radius:50%;background:${t.color}"></span>${esc(t.name)}</div>
        <button class="ib${t.pinned ? ' on' : ''}" data-act="pin" data-t="${t.id}" aria-label="Pin to top">📌</button><button class="ib" data-act="edit" data-t="${t.id}" aria-label="Rename">✎</button><button class="ib" data-act="del" data-t="${t.id}" aria-label="Delete">🗑</button></div>`).join('') || '<p style="color:var(--mut)">No tags yet.</p>'}
      <div class="trow"><input type="text" id="newTagName" placeholder="New tag name"><button class="btn primary" data-act="add">Add</button></div>`, async e => {
      const el = e.target.closest('[data-act],[data-c]'); if (!el) return;
      const t = tagById(el.dataset.t), a = el.dataset.act;
      if (el.dataset.c) { const pend = $('#rn')?.value; t.color = el.dataset.c; await put('tags', t); draw(); if (pend != null && $('#rn')) $('#rn').value = pend; renderSidebar(); renderFeed(); return; }
      if (0) {  await put('tags', t); draw(); renderSidebar(); renderFeed(); return; }
      if (a === 'close') { closeSheet(); render(); }
      else if (a === 'edit') { editId = t.id; draw(); $('#rn')?.focus(); }
      else if (a === 'save') { const v = $('#rn').value.trim(); if (v) { t.name = v; await put('tags', t); } editId = null; draw(); render(); }
      else if (a === 'pin') { t.pinned = !t.pinned; await put('tags', t); draw(); renderSidebar(); }
      else if (a === 'add') { await createTag($('#newTagName').value); draw(); renderSidebar(); }
      else if (a === 'del') {
        const n = S.shots.filter(s => s.tags.includes(t.id)).length;
        if (!confirm(`Delete tag "${t.name}"?` + (n ? ` It will be removed from ${n} screenshot${n > 1 ? 's' : ''}; the screenshots stay.` : ''))) return;
        await setTagOn(S.shots.map(s => s.id), t.id, false);
        S.tags = S.tags.filter(x => x !== t); await tx('tags', 'readwrite', st => { st.delete(t.id); });
        if (S.filter === t.id) S.filter = null; draw(); render();
      }
    });
    const r = $('#rn'); if (r) r.onkeydown = e => { if (e.key === 'Enter') $('[data-act=save]').click(); };
  };
  draw();
}
async function settingsSheet() {
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
  const mb = b => (b / 1048576).toFixed(1) + ' MB';
  const unscanned = S.shots.filter(s => s.ocr == null).length;
  sheet(`<h2>Settings<button class="ib" data-act="close">✕</button></h2>
    <div class="set-sec"><b>Scan text</b><p>Reads the text in your screenshots on this device so search can find it. ${unscanned} of ${S.shots.length} not scanned yet. The first scan downloads the text reader (about 10 MB).</p>
      <button class="btn primary" data-act="scan" ${unscanned ? '' : 'disabled'}>Scan ${unscanned} screenshot${unscanned === 1 ? '' : 's'}</button> <button class="btn" data-act="rescan" ${S.shots.length ? '' : 'disabled'}>Rescan all</button>
      <div class="prog" id="scanProg" hidden><i></i></div><p id="scanTxt"></p><button class="btn" data-act="review">Review tag suggestions (${sugCount()})</button></div>
    <div class="set-sec"><b>Backup</b><p>A zip with every screenshot plus your tags, captions and dates.</p>
      <button class="btn" data-act="export" ${S.shots.length ? '' : 'disabled'}>Export backup</button> <button class="btn" data-act="restore">Import backup</button><input type="file" id="zipIn" accept=".zip,application/zip" hidden><p id="bkTxt"></p></div>
    <div class="set-sec"><b>Storage</b><p>${S.shots.length} screenshots, ${S.tags.length} tags. ${est ? `Using ${mb(est.usage || 0)}${est.quota ? ` of about ${mb(est.quota)} available` : ''}.` : ''}</p></div>
    <div class="set-sec"><b>Delete all</b><p>Removes every screenshot and tag from Snapfeed. Your Photos library isn't touched.</p><button class="btn danger" data-act="nuke" ${S.shots.length || S.tags.length ? '' : 'disabled'}>Delete all…</button></div>
    <div class="set-sec"><p style="font-size:12px">Snapfeed prototype · your screenshots stay on this device.</p></div>`, async e => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'close') closeSheet();
    else if (a === 'review') reviewSheet();
    else if (a === 'scan' || a === 'rescan') runScan(a === 'rescan');
    else if (a === 'export') exportBackup();
    else if (a === 'restore') $('#zipIn').click();
    else if (a === 'nuke') {
      if (!confirm(`Delete all ${S.shots.length} screenshots and ${S.tags.length} tags from Snapfeed? This can't be undone.`)) return;
      await tx(['shots', 'blobs', 'tags'], 'readwrite', (a, b, c) => { a.clear(); b.clear(); c.clear(); });
      thumbURL.forEach(u => URL.revokeObjectURL(u)); thumbURL.clear();
      S.shots = []; S.tags = []; S.filter = null; S.cur = null; S.sel.clear(); closeSheet(); render(); toast('Everything deleted');
    }
  });
  $('#zipIn').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); };
}

/* ---------- OCR ---------- */
let scanning = false;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); }); }
async function getRecognizer() {
  if (window.__mockOCR) return { recognize: window.__mockOCR, terminate() {} };
  if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  const w = await Tesseract.createWorker('eng');
  return { recognize: async blob => (await w.recognize(blob)).data.text, terminate: () => w.terminate() };
}
async function runScan(all) {
  if (scanning) return; scanning = true;
  const todo = S.shots.filter(s => all || s.ocr == null);
  const prog = $('#scanProg'), txt = $('#scanTxt'), bar = prog?.firstElementChild;
  const upd = (i, m) => { if (prog && prog.isConnected) { prog.hidden = false; bar.style.width = (100 * i / todo.length) + '%'; txt.textContent = m; } status(m); };
  try {
    upd(0, 'Loading text reader…');
    const rec = await getRecognizer();
    for (let i = 0; i < todo.length; i++) {
      upd(i, `Scanning ${i + 1} of ${todo.length}…`);
      const b = await getBlobs(todo[i].id);
      const text = (await rec.recognize(b.full, todo[i])) || '';
      todo[i].ocr = text.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim(); await saveShot(todo[i]);
    }
    await rec.terminate();
    suggestAll(); render(); upd(todo.length, `Done. Scanned ${todo.length}. ${sugCount()} tag suggestion${sugCount() === 1 ? '' : 's'} to review.`); toast(`Scanned ${todo.length} screenshot${todo.length === 1 ? '' : 's'}`);
  } catch (e) { console.error(e); upd(0, 'Scan stopped: ' + e.message); }
  scanning = false; setTimeout(() => status(''), 1500); renderDetail();
}

/* ---------- backup ---------- */
async function exportBackup() {
  const t = $('#bkTxt'); t.textContent = 'Building zip…';
  const zip = new JSZip();
  const ext = ty => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp', 'image/gif': 'gif' }[ty] || 'img');
  const blobs = (await getAll('blobs')).map(asBlobs); const bm = new Map(blobs.map(b => [b.id, b]));
  const shots = S.shots.map(s => ({ ...s, file: `images/${s.id}.${ext(s.type)}` }));
  shots.forEach(s => bm.get(s.id) && zip.file(s.file, bm.get(s.id).full));
  zip.file('snapfeed.json', JSON.stringify({ app: 'snapfeed', version: 1, exported: new Date().toISOString(), tags: S.tags, shots }, null, 1));
  const out = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const name = `snapfeed-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  const file = new File([out], name, { type: 'application/zip' });
  if (navigator.canShare?.({ files: [file] }) && !window.__noShare) { try { await navigator.share({ files: [file] }); t.textContent = 'Backup shared.'; return; } catch (e) { if (e.name === 'AbortError') { t.textContent = ''; return; } } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(out); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  t.textContent = `Saved ${name} (${(out.size / 1048576).toFixed(1)} MB).`;
}
async function importBackup(f) {
  const t = $('#bkTxt'); if (t) t.textContent = 'Reading backup…';
  try {
    const zip = await JSZip.loadAsync(f);
    const data = JSON.parse(await zip.file('snapfeed.json').async('string'));
    const tagMap = {};
    for (const tg of data.tags || []) {
      if (OLD_COLORS[tg.color]) tg.color = OLD_COLORS[tg.color];
      const ex = S.tags.find(x => x.id === tg.id || x.name.toLowerCase() === tg.name.toLowerCase());
      if (ex) tagMap[tg.id] = ex.id; else { S.tags.push(tg); await put('tags', tg); tagMap[tg.id] = tg.id; }
    }
    const files = [], metas = [];
    for (const s of data.shots || []) { const zf = zip.file(s.file); if (!zf) continue; const b = await zf.async('blob'); files.push(new File([b], s.name || s.file, { type: s.type })); metas.push(s); }
    let added = 0, dup = 0;
    for (let i = 0; i < files.length; i++) {
      const s = metas[i];
      if (S.shots.some(x => x.id === s.id)) s.id = uid();
      const r = await importFiles([files[i]], { meta: { ...s, tags: (s.tags || []).map(x => tagMap[x]).filter(Boolean) } });
      added += r?.added || 0; dup += r?.dup || 0;
      status(`Restoring ${i + 1} of ${files.length}…`);
    }
    status(''); render();
    const m = `Restored ${added} screenshot${added === 1 ? '' : 's'}${dup ? `, ${dup} already here` : ''}.`;
    if (t && t.isConnected) t.textContent = m; toast(m);
  } catch (e) { console.error(e); if (t) t.textContent = 'That file isn\u2019t a Snapfeed backup.'; }
}

/* ---------- viewer ---------- */
let vIdx = 0; const vURLs = new Map();
function openViewer(id) {
  vIdx = Math.max(0, S.view.findIndex(s => s.id === id));
  $('#vTrack').innerHTML = S.view.map((s, i) => `<div class="slide" data-i="${i}"><img alt=""></div>`).join('');
  $('#viewer').hidden = false; $('#viewer').style.cssText = '';
  const tr = $('#vTrack'); tr.scrollLeft = vIdx * tr.clientWidth;
  vLoad(); vUpdate();
}
function vLoad() {
  const slides = $('#vTrack').children;
  for (let i = 0; i < slides.length; i++) {
    const s = S.view[i], im = slides[i].firstElementChild, near = Math.abs(i - vIdx) <= 2;
    if (near && !im.src) { getThumb(s.id).then(u => { if (!im.dataset.full) im.src = u; }); fullURL(s.id).then(u => { vURLs.set(s.id, u); im.dataset.full = 1; im.src = u; }); }
    else if (!near && im.dataset.full) { URL.revokeObjectURL(vURLs.get(s.id)); vURLs.delete(s.id); im.removeAttribute('src'); delete im.dataset.full; }
  }
}
function vUpdate() {
  const s = S.view[vIdx]; if (!s) return closeViewer();
  $('#vDate').textContent = `${fmtDate(s.date)} · ${vIdx + 1}/${S.view.length}`;
  $('#vCap').value = s.caption; $('#vPin').classList.toggle('on', s.pinned);
  $('#vChips').innerHTML = s.tags.map(tagById).filter(Boolean).map(t => chipHTML(t, 'sm')).join('') + suggOf(s.id).map(n => sugHTML(s.id, n)).join('') || '<span style="color:var(--mut);font-size:13px">No tags · tap # to add</span>';
  if (S.cur !== s.id) { S.cur = s.id; }
}
function closeViewer(fromPop) { $('#viewer').style.cssText = ''; $('#vTrack').style.cssText = ''; $('#viewer').hidden = true; vURLs.forEach(u => URL.revokeObjectURL(u)); vURLs.clear(); $('#vTrack').innerHTML = ''; render(); }
let vst; $('#vTrack').addEventListener('scroll', () => { clearTimeout(vst); vst = setTimeout(() => { const tr = $('#vTrack'); const i = Math.round(tr.scrollLeft / tr.clientWidth); if (i !== vIdx) { vIdx = i; vLoad(); vUpdate(); } }, 80); });
$('#vClose').onclick = closeViewer;
$('#vPin').onclick = () => togglePin(S.view[vIdx].id);
$('#vTag').onclick = () => tagSheet([S.view[vIdx].id]);
$('#vDel').onclick = async () => { const s = S.view[vIdx]; if (!confirm('Delete this screenshot from Snapfeed?')) return; await deleteShots([s.id]); if (!S.view.length) return closeViewer(); openViewer(S.view[Math.min(vIdx, S.view.length - 1)].id); };
$('#vCap').onchange = e => setCaption(S.view[vIdx].id, e.target.value);
document.addEventListener('keydown', e => { if ($('#viewer').hidden || e.target.tagName === 'INPUT') return; const tr = $('#vTrack'); if (e.key === 'ArrowRight') tr.scrollBy({ left: tr.clientWidth }); if (e.key === 'ArrowLeft') tr.scrollBy({ left: -tr.clientWidth }); if (e.key === 'Escape') closeViewer(); });

/* ---------- selection ---------- */
function updSel() { $('#selBar').hidden = !S.select; $('#selCount').textContent = `${S.sel.size} selected`; $('#selTag').disabled = $('#selDel').disabled = !S.sel.size; }
$('#selectBtn').onclick = () => { if (S.home && !S.select) { S.filter = null; setHome(false); } S.select = !S.select; S.sel.clear(); render(); };
$('#selDone').onclick = () => { S.select = false; S.sel.clear(); render(); };
$('#selAll').onclick = () => { const all = S.view.every(s => S.sel.has(s.id)); S.view.forEach(s => all ? S.sel.delete(s.id) : S.sel.add(s.id)); renderFeed(); updSel(); };
$('#selTag').onclick = () => tagSheet([...S.sel]);
$('#selDel').onclick = async () => { const n = S.sel.size; if (!confirm(`Delete ${n} screenshot${n > 1 ? 's' : ''} from Snapfeed?`)) return; await deleteShots([...S.sel]); S.select = false; render(); };

/* ---------- events ---------- */
$('#importBtn').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = async e => { const f = [...e.target.files]; e.target.value = ''; await importFiles(f); };
$('#settingsBtn').onclick = settingsSheet;
$('#viewBtn').onclick = () => { S.grid = !S.grid; renderFeed(); $('#viewBtn').classList.toggle('on', S.grid); $('#feedWrap').scrollTop = 0; };
$('#menuBtn').onclick = () => $('#app').classList.toggle('drawer');
let sq; $('#search').oninput = e => { clearTimeout(sq); sq = setTimeout(() => { S.q = e.target.value; if (S.q && S.home) { S.filter = null; setHome(false); } renderFeed(); }, 120); };
$('#backBtn').onclick = goHome; $('#homeTitle').onclick = () => { if (!S.home) goHome(); };
addEventListener('popstate', () => { if (!$('#viewer').hidden) { closeViewer(true); return; } if (!$('#sheet').hidden) closeSheet(); if (!S.home) { S.q = ''; $('#search').value = ''; S.home = true; S.select = false; S.sel.clear(); render(); } });
function onFilterClick(e) {
  const a = e.target.closest('[data-act]')?.dataset.act;
  if (a === 'review') { $('#app').classList.remove('drawer'); return reviewSheet(); }
  if (a === 'manage') { $('#app').classList.remove('drawer'); return manageTags(); }
  if (a === 'newtag') { const n = prompt('New tag name'); if (n) createTag(n).then(renderSidebar); return; }
  const f = e.target.closest('[data-filter]'); if (!f) return;
  const v = f.dataset.filter || null;
  S.filter = (S.filter === v && v && !S.home) ? null : v; setHome(false);
  $('#app').classList.remove('drawer'); renderSidebar(); renderFeed(); $('#feedWrap').scrollTop = 0;
}
$('#sidebar').onclick = onFilterClick; $('#chips').onclick = onFilterClick;
document.addEventListener('click', e => { if ($('#app').classList.contains('drawer') && !e.target.closest('#sidebar,#menuBtn')) $('#app').classList.remove('drawer'); }, true);
$('#feed').onclick = e => {
  if (S.home) { if (e.target.closest('[data-act=review]')) return reviewSheet(); if (e.target.closest('[data-act=newtag]')) { const n = prompt('New tag name'); if (n) createTag(n).then(render); return; } const t = e.target.closest('.tile[data-filter]'); if (t) { S.filter = t.dataset.filter || null; setHome(false); renderSidebar(); renderFeed(); $('#feedWrap').scrollTop = 0; } return; }
  const card = e.target.closest('.card'); if (!card) return;
  const id = card.dataset.id;
  if (S.select) { S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); card.classList.toggle('sel'); updSel(); return; }
  const chip = e.target.closest('.chip[data-tag]');
  if (chip) { S.filter = chip.dataset.tag; renderSidebar(); renderFeed(); return; }
  if (e.target.closest('[data-act=tag]')) return tagSheet([id]);
  if (WIDE.matches && !S.grid && S.cur !== id) { S.cur = id; document.querySelectorAll('.card.cur').forEach(c => c.classList.remove('cur')); card.classList.add('cur'); renderDetail(); return; }
  openViewer(id);
};
$('#detail').onclick = e => {
  const a = e.target.closest('[data-act]')?.dataset.act, id = S.cur; if (!id) return;
  if (a === 'open' || e.target.id === 'dImg') openViewer(id);
  else if (a === 'tag') tagSheet([id]);
  else if (a === 'pin') togglePin(id);
  else if (a === 'del') { if (confirm('Delete this screenshot from Snapfeed?')) deleteShots([id]); }
  const chip = e.target.closest('.chip[data-tag]'); if (chip) { S.filter = chip.dataset.tag; renderSidebar(); renderFeed(); }
};
let rz, lastCols; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { const c = ncols() + '' + WIDE.matches; if (c !== lastCols) { lastCols = c; render(); } }, 150); });

/* ---------- boot ---------- */
(async function boot() {
  [S.shots, S.tags] = await Promise.all([getAll('shots'), getAll('tags')]);
  for (const t of S.tags) if (OLD_COLORS[t.color]) { t.color = OLD_COLORS[t.color]; put('tags', t); }
  suggestAll();
  lastCols = ncols() + '' + WIDE.matches;
  render();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  drainInbox().catch(console.error);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
window.__sf = { S, importFiles, render, importBackup, exportBackup };

/* ---------- gestures: swipe down / left-edge swipe to dismiss ---------- */
function dragDismiss(handle, { axis, target, fade, onClose, canStart = () => true }) {
  // Touch events are the primary path (iOS Safari/standalone hands pointer streams to native
  // scrolling and fires pointercancel); pointer events remain only for mouse/pen.
  let st = null;
  const begin = (x, y, e) => {
    if (!canStart(e)) return;
    st = { x, y, t: performance.now(), mode: axis === 'x' ? 'go' : null, d: 0 };
    if (axis === 'x') target().style.transition = 'none';
  };
  const move = (x, y, e) => {
    if (!st) return;
    const dx = x - st.x, dy = y - st.y;
    if (!st.mode) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) { if (dy > 0 && dy >= Math.abs(dx) && e.cancelable) e.preventDefault(); return; }
      if (dy > 0 && dy > Math.abs(dx)) { st.mode = 'go'; target().style.transition = 'none'; if (pid != null) try { handle.setPointerCapture(pid); } catch {} }
      else { st = null; return; }   // horizontal/upward: leave it to the pager or scrolling
    }
    if (e.cancelable) e.preventDefault();
    st.d = Math.max(0, axis === 'x' ? dx : dy);
    target().style.transform = axis === 'x' ? `translateX(${st.d}px)` : `translateY(${st.d}px) scale(${1 - Math.min(st.d, 400) / 2400})`;
    if (fade) fade().style.backgroundColor = `rgba(0,0,0,${Math.max(0, 1 - st.d / 400)})`;
  };
  const finish = cancelled => {
    if (!st) return;
    const s = st; st = null; if (s.mode !== 'go') return;
    const v = s.d / Math.max(1, performance.now() - s.t), el = target();
    el.style.transition = 'transform .18s ease-out';
    if (!cancelled && (s.d > 110 || (v > 0.6 && s.d > 30))) {
      el.style.transform = axis === 'x' ? 'translateX(100vw)' : 'translateY(100vh)';
      setTimeout(onClose, 170);
    } else { el.style.transform = ''; if (fade) fade().style.backgroundColor = ''; }
  };
  let tid = null;
  handle.addEventListener('touchstart', e => { if (e.touches.length !== 1) { st = null; return; } const t = e.touches[0]; tid = t.identifier; begin(t.clientX, t.clientY, e); }, { passive: true });
  handle.addEventListener('touchmove', e => { if (!st) return; if (e.touches.length !== 1) { finish(true); return; } const t = [...e.touches].find(t => t.identifier === tid) || e.touches[0]; move(t.clientX, t.clientY, e); }, { passive: false });
  handle.addEventListener('touchend', () => finish(false));
  // touchcancel (e.g. iOS took the gesture): commit if we were already clearly past the threshold, else snap back
  handle.addEventListener('touchcancel', () => { if (st && st.mode === 'go' && st.d > 110) finish(false); else finish(true); });
  let pid = null;
  handle.addEventListener('pointerdown', e => { if (e.pointerType === 'touch' || e.button > 0) return; pid = e.pointerId; begin(e.clientX, e.clientY, e); if (st && axis === 'x') try { handle.setPointerCapture(pid); } catch {} });
  handle.addEventListener('pointermove', e => { if (e.pointerType !== 'touch' && e.pointerId === pid) move(e.clientX, e.clientY, e); });
  handle.addEventListener('pointerup', e => { if (e.pointerType !== 'touch' && e.pointerId === pid) { pid = null; finish(false); } });
  handle.addEventListener('pointercancel', e => { if (e.pointerType !== 'touch' && e.pointerId === pid) { pid = null; finish(true); } });
}
// Viewer: vertical drag on the image track (horizontal stays the item swiper), and a left-edge strip.
dragDismiss($('#vTrack'), { axis: 'y', target: () => $('#vTrack'), fade: () => $('#viewer'), onClose: () => closeViewer() });
dragDismiss($('#vEdge'), { axis: 'x', target: () => $('#viewer'), onClose: () => closeViewer() });
// Sheets: drag down on the sheet when it's scrolled to the top, left-edge strip, and the backdrop tap (above).
dragDismiss($('#sheetBox'), { axis: 'y', target: () => $('#sheetBox'), fade: () => $('#sheet'), onClose: () => closeSheet(), canStart: e => $('#sheetBox').scrollTop <= 0 && !e.target.closest('input,textarea') });
dragDismiss($('#sheetEdge'), { axis: 'x', target: () => $('#sheetBox'), onClose: () => closeSheet() });
// Feed: left-edge swipe goes back to Tags.
dragDismiss($('#edge'), { axis: 'x', target: () => $('#feed'), canStart: () => !S.home, onClose: () => { $('#feed').style.cssText = ''; goHome(); } });
