const CACHE = 'snapfeed-v1';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'vendor/jszip.min.js', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
function idbInbox(files) {
  return new Promise((res, rej) => {
    const r = indexedDB.open('snapfeed', 1);
    r.onupgradeneeded = () => { const d = r.result; for (const s of ['shots', 'blobs', 'tags', 'inbox']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); };
    r.onsuccess = async () => { const bufs = await Promise.all(files.map(f => f.arrayBuffer())); const tx = r.result.transaction('inbox', 'readwrite'); files.forEach((f, i) => tx.objectStore('inbox').put({ id: Date.now() + '-' + i, buf: bufs[i], type: f.type, name: f.name, lastModified: f.lastModified })); tx.oncomplete = res; tx.onerror = rej; };
    r.onerror = rej;
  });
}
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method === 'POST' && u.pathname.endsWith('/share-target')) {
    e.respondWith((async () => { const fd = await e.request.formData(); await idbInbox(fd.getAll('images').filter(f => f && f.size)); return Response.redirect('./?shared=1', 303); })());
    return;
  }
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: u.pathname.endsWith('/') }).then(r => r || fetch(e.request)));
});
