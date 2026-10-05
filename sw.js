/* ALPAC: actualización al abrir/recargar; copia offline y cola intactas.
 * Reemplazar sólo sw.js junto a index.html y outbox.js.
 * Compatible con IndexedDB alpac-fichadas-v2: no cambia su esquema.
 */
importScripts('./outbox.js');
const API_URL = 'https://script.google.com/macros/s/AKfycbwRCWTP1T0NXAJqH5TLxcktca52nRsv52D8R6vdeAfTGwAcVL9puHqL4fG7OCkXEeDNdA/exec';
const CACHE = 'alpac-shell-auto-v1-' + new URL(self.registration.scope).pathname;
const SHELL = ['./index.html', './outbox.js'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map(path => new Request(new URL(path, self.location), { cache: 'reload' })));
    // Esta actualización sólo cambia la estrategia de archivos; no migra datos.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  // No borrar caches ajenas, IndexedDB ni localStorage. Tampoco forzar navegación
  // de una pantalla abierta: podría haber alguien ingresando su PIN o fichando.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const directory = new URL('./', self.location).pathname;
  const entry = new URL('./index.html', self.location).pathname;
  const script = new URL('./outbox.js', self.location).pathname;
  const isEntry = event.request.mode === 'navigate' && (url.pathname === directory || url.pathname === entry);
  const isScript = url.pathname === script;
  if (!isEntry && !isScript) return;
  const key = new URL(isEntry ? './index.html' : './outbox.js', self.location).href;
  const cachePromise = caches.open(CACHE);
  const controller = new AbortController();
  const hardTimeout = setTimeout(() => controller.abort(), 15000);
  const network = fetch(event.request, { cache: 'no-store', signal: controller.signal }).then(response => {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response;
  });
  // Si la conexión es lenta, la descarga puede actualizar la copia en segundo
  // plano aunque la pantalla ya haya abierto la versión offline.
  event.waitUntil(network.then(async response => {
    const copy = response.clone();
    const cache = await cachePromise;
    await cache.put(key, copy);
  }).catch(() => {}).finally(() => clearTimeout(hardTimeout)));
  event.respondWith((async () => {
    let timeout;
    try {
      return await Promise.race([
        network,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Conexión lenta')), 3000); })
      ]);
    } catch (_) {
      const cache = await cachePromise;
      const saved = await cache.match(key);
      if (saved) return saved;
      return new Response('No se pudo cargar la aplicación. Volvé a abrirla con conexión.', {
        status: 503, headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
      });
    } finally { clearTimeout(timeout); }
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
