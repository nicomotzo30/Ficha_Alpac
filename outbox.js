/* Compartido por la página y el service worker. Sin dependencias externas. */
(function (root) {
  'use strict';
  let opening;
  const DB_NAME = 'alpac-fichadas-v2';
  const TIMEOUT = 20000;
  function db() {
    if (!opening) opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('queue', { keyPath: 'id' });
        req.result.createObjectStore('last', { keyPath: 'nombre' });
        req.result.createObjectStore('meta');
      };
      req.onerror = () => { opening = null; reject(req.error); };
      req.onblocked = () => { opening = null; reject(new Error('Cerrá las otras pestañas para habilitar el almacenamiento.')); };
      req.onsuccess = () => {
        const connection = req.result;
        connection.onversionchange = () => { connection.close(); opening = null; };
        resolve(connection);
      };
    });
    return opening;
  }
  async function transaction(stores, mode, action) {
    const connection = await db();
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = connection.transaction(stores, mode, { durability: 'strict' }); }
      catch (_) { tx = connection.transaction(stores, mode); }
      let result, error;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(error || tx.error || new Error('No se pudo guardar localmente.'));
      tx.onerror = () => {};
      try { action(tx, value => { result = value; }, err => { error = err; tx.abort(); }); }
      catch (err) { error = err; tx.abort(); }
    });
  }
  const list = () => transaction(['queue'], 'readonly', (tx, done) => {
    tx.objectStore('queue').getAll().onsuccess = e => done(e.target.result.sort((a,b) =>
      String(a.timestampCliente).localeCompare(String(b.timestampCliente)) || a.id.localeCompare(b.id)));
  });
  const last = nombre => transaction(['last'], 'readonly', (tx, done) => {
    tx.objectStore('last').get(nombre).onsuccess = e => done(e.target.result);
  });
  function elapsed(record, now) {
    if (!record || record.fecha !== now.toLocaleDateString('es-AR')) return null;
    if (record.timestampCliente) return (now - new Date(record.timestampCliente)) / 60000;
    const parts = String(record.hora || '').split(':').map(Number);
    if (parts.length < 2 || parts.some(n => !Number.isFinite(n))) return null;
    const date = new Date(now); date.setHours(parts[0], parts[1], parts[2] || 0, 0);
    return (now - date) / 60000;
  }
  // La cola y el cooldown se confirman juntos; también serializa dos pestañas.
  const enqueue = (item, minimum) => transaction(['queue', 'last'], 'readwrite', (tx, done, fail) => {
    const store = tx.objectStore('last');
    store.get(item.nombre).onsuccess = e => {
      const now = new Date(item.timestampCliente);
      const minutes = elapsed(e.target.result, now);
      if (minutes !== null && minutes < minimum) {
        fail(new Error('Esperá ' + Math.ceil(minimum - minutes) + ' min antes de volver a fichar.')); return;
      }
      tx.objectStore('queue').add({ ...item, attempts: 0, nextAt: 0 });
      store.put({ nombre: item.nombre, timestampCliente: item.timestampCliente,
        fecha: now.toLocaleDateString('es-AR'), hora: now.toLocaleTimeString('es-AR') });
      done(item);
    };
  });
  // Un marcador transaccional hace que recargar durante la migración sea seguro.
  async function migrate(storage) {
    const migrated = await transaction(['meta'], 'readonly', (tx, done) => {
      tx.objectStore('meta').get('legacy-v1').onsuccess = e => done(e.target.result);
    });
    if (migrated) return;
    const queue = JSON.parse(storage.getItem('fichada_cola') || '[]');
    const previous = JSON.parse(storage.getItem('fichada_ultima_local') || '{}');
    if (!Array.isArray(queue) || !previous || Array.isArray(previous) || typeof previous !== 'object')
      throw new Error('Los datos anteriores requieren recuperación; no se borraron.');
    await transaction(['queue','last','meta'], 'readwrite', (tx, done, fail) => {
      tx.objectStore('meta').get('legacy-v1').onsuccess = e => {
        if (e.target.result) return;
        for (const item of queue) {
          if (!item || typeof item.id !== 'string' || !item.id) {
            fail(new Error('Hay una fichada anterior sin ID. Conservamos la cola original para revisión.')); return;
          }
          // add detecta IDs repetidos sin sobrescribir una ficha diferente.
          tx.objectStore('queue').add({ ...item, attempts: 0, nextAt: 0 });
        }
        for (const [nombre, value] of Object.entries(previous)) tx.objectStore('last').put({ ...value, nombre });
        tx.objectStore('meta').put(true, 'legacy-v1');
      };
    });
    // No borrar el original: respaldo de migración, nunca vuelve a importarse.
  }
  async function claim(id, owner) {
    return transaction(['queue'], 'readwrite', (tx, done) => {
      const store = tx.objectStore('queue');
      store.get(id).onsuccess = e => {
        const item = e.target.result;
        if (!item || item.nextAt > Date.now() || item.leaseUntil > Date.now()) return done(null);
        item.owner = owner; item.leaseUntil = Date.now() + 45000;
        store.put(item); done(item);
      };
    });
  }
  async function settle(item, accepted, error, review) {
    return transaction(['queue'], 'readwrite', (tx) => {
      const store = tx.objectStore('queue');
      store.get(item.id).onsuccess = e => {
        const current = e.target.result;
        if (!current || current.owner !== item.owner) return;
        if (accepted) { store.delete(item.id); return; }
        current.attempts = (current.attempts || 0) + 1;
        current.nextAt = Date.now() + Math.min(300000, 2000 * Math.pow(2, Math.min(current.attempts, 8))) * (0.75 + Math.random() / 2);
        current.error = String(error).slice(0, 500); current.review = !!review;
        current.leaseUntil = 0; delete current.owner;
        store.put(current);
      };
    });
  }
  async function send(url, item) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetch(url, { method: 'POST', redirect: 'follow',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify({ id: item.id, nombre: item.nombre, tipo: item.tipo, timestampCliente: item.timestampCliente }),
            signal: controller.signal });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return await response.json();
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error('Tiempo de espera agotado; se reintentará con el mismo ID.'));
        }, TIMEOUT); })
      ]);
    } finally { clearTimeout(timer); }
  }
  async function sync(url, changed = () => {}) {
    const owner = crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random();
    // Snapshot sólo para elegir candidatos. Nunca se vuelve a escribir la lista completa.
    for (const candidate of await list()) {
      const item = await claim(candidate.id, owner);
      if (!item) continue;
      try {
        const data = await send(url, item);
        const ack = data && data.status === 'ok' && data.id === item.id;
        await settle(item, ack, data && data.mensaje || 'Respuesta sin confirmación del ID; revisar versión del backend.', data && (data.retryable === false || (data.status === 'ok' && !ack)));
      } catch (err) { await settle(item, false, err.message, false); }
      await changed();
    }
  }
  const retry = () => transaction(['queue'], 'readwrite', tx => {
    const store = tx.objectStore('queue');
    store.openCursor().onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { cursor.update({ ...cursor.value, nextAt: 0 }); cursor.continue(); }
    };
  });
  root.AlpacQueue = { db, list, last, elapsed, enqueue, migrate, sync, retry };
})(typeof self !== 'undefined' ? self : globalThis);
