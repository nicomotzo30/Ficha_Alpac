/* Publicar junto a index.html y outbox.js en el MISMO origen HTTPS. */
importScripts('./outbox.js');
const API_URL = 'https://script.google.com/macros/s/AKfycbwRCWTP1T0NXAJqH5TLxcktca52nRsv52D8R6vdeAfTGwAcVL9puHqL4fG7OCkXEeDNdA/exec';
const CACHE = 'alpac-shell-v2-2';
const SHELL = ['./index.html', './outbox.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  // Sin skipWaiting: no mezclar una pestaña vieja con un worker nuevo.
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('alpac-shell-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const entry = new URL('./index.html', self.location).pathname;
  const directory = new URL('./', self.location).pathname;
  const isEntry = event.request.mode === 'navigate' && (url.pathname === entry || url.pathname === directory);
  const isScript = url.pathname === new URL('./outbox.js', self.location).pathname;
  if (!isEntry && !isScript) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(isEntry ? './index.html' : './outbox.js');
    return saved || fetch(event.request);
  })());
});
self.addEventListener('sync', event => {
  if (event.tag !== 'alpac-fichadas') return;
  event.waitUntil((async () => {
    await AlpacQueue.sync(API_URL);
    for (const client of await self.clients.matchAll()) client.postMessage({ type: 'queue-changed' });
    if ((await AlpacQueue.list()).length) throw new Error('Aún quedan fichadas pendientes; reintentar.');
  })());
});
