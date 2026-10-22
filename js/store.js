// IndexedDB persistence for the host: the game state (one record) and the photo bytes (per upload id).
// If IndexedDB is unavailable (private mode, etc.) everything falls back to memory so the game still runs.

const DB_NAME = 'findmyguessr';
const DB_VERSION = 1;
const GAME = 'game', PHOTOS = 'photos', GAME_KEY = 'current';

let dbPromise = null;
const mem = { game: null, photos: new Map() };
let useMem = false;

function openDb() {
  if (useMem) return Promise.reject(new Error('no idb'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('no idb'));
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(GAME)) db.createObjectStore(GAME);
        if (!db.objectStoreNames.contains(PHOTOS)) db.createObjectStore(PHOTOS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb open failed'));
      req.onblocked = () => reject(new Error('idb blocked'));
    }).catch((e) => { useMem = true; dbPromise = null; throw e; });
  }
  return dbPromise;
}

// Run fn(objectStore) inside one transaction; resolves with the request result of fn (if any) after commit.
async function run(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    let result;
    const r = fn(tx.objectStore(storeName));
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('idb aborted'));
  });
}

async function withFallback(idbOp, memOp) {
  if (!useMem) {
    try { return await idbOp(); } catch (e) { if (!useMem) console.warn('[store]', e); }
  }
  return memOp();
}

export async function saveGame(state) {
  const snap = JSON.parse(JSON.stringify(state));
  snap.savedAt = Date.now();
  return withFallback(
    () => run(GAME, 'readwrite', (st) => st.put(snap, GAME_KEY)),
    () => { mem.game = snap; },
  ).catch(() => {});
}

export async function loadGame() {
  const rec = await withFallback(
    () => run(GAME, 'readonly', (st) => st.get(GAME_KEY)),
    () => mem.game,
  ).catch(() => null);
  return rec && rec.code && Array.isArray(rec.teams) ? rec : null;
}

export async function clearGame() {
  return withFallback(
    () => run(GAME, 'readwrite', (st) => st.delete(GAME_KEY)),
    () => { mem.game = null; },
  ).catch(() => {});
}

// { full: ArrayBuffer, guess: ArrayBuffer }
export async function putPhoto(uploadId, { full, guess }) {
  return withFallback(
    () => run(PHOTOS, 'readwrite', (st) => st.put({ full, guess }, uploadId)),
    () => { mem.photos.set(uploadId, { full, guess }); },
  );
}

export async function getPhoto(uploadId) {
  const rec = await withFallback(
    () => run(PHOTOS, 'readonly', (st) => st.get(uploadId)),
    () => mem.photos.get(uploadId),
  ).catch(() => null);
  return rec || null;
}

export async function deletePhoto(uploadId) {
  return withFallback(
    () => run(PHOTOS, 'readwrite', (st) => st.delete(uploadId)),
    () => { mem.photos.delete(uploadId); },
  ).catch(() => {});
}

export async function clearPhotos() {
  return withFallback(
    () => run(PHOTOS, 'readwrite', (st) => st.clear()),
    () => { mem.photos.clear(); },
  ).catch(() => {});
}
