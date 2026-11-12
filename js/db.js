// Stockage local (IndexedDB) — pensé pour la future gestion de collection.
//
// Base "vinyl-scanner", version 1 :
//
//  • releases  (clé : id Discogs)  → un document par vinyle consulté
//      {
//        id, schemaVersion,
//        artist, artistSort, title, year, country, released,
//        labels: [{ name, catno }], catno, label,
//        formats: [{ name, qty, descriptions, text }], formatText,
//        genres: [], styles: [],
//        tracklist: [{ position, title, duration }],
//        barcodes: [], coverUrl, thumbUrl, discogsUrl, masterId,
//        community: { have, want, ratingAvg, ratingCount },
//        market: { lowestPrice, currency, numForSale, blockedFromSale,
//                  suggestions: { "VG+": { value, currency }, ... }, fetchedAt },
//        rarity: { level, label, score },
//        estimatedValue,          // valeur retenue (prix suggéré VG+ sinon prix le plus bas)
//        firstSeenAt, lastSeenAt, viewCount,
//        // --- réservé à la future collection ---
//        inCollection: 0 | 1,     // nombre (0/1) car IndexedDB n'indexe pas les booléens
//        collection: { addedAt, condition, sleeveCondition, purchasePrice, notes, copies }
//      }
//      index : lastSeenAt, inCollection, artistSort, title, genres (multiEntry), estimatedValue
//
//  • history   (clé auto) → une ligne par recherche aboutie
//      { id, releaseId, at, method: 'barcode' | 'catno' | 'ocr' | 'history', query }
//      index : at, releaseId

const DB_NAME = 'vinyl-scanner';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('releases')) {
        const s = db.createObjectStore('releases', { keyPath: 'id' });
        s.createIndex('lastSeenAt', 'lastSeenAt');
        s.createIndex('inCollection', 'inCollection');
        s.createIndex('artistSort', 'artistSort');
        s.createIndex('title', 'title');
        s.createIndex('genres', 'genres', { multiEntry: true });
        s.createIndex('estimatedValue', 'estimatedValue');
      }
      if (!db.objectStoreNames.contains('history')) {
        const h = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        h.createIndex('at', 'at');
        h.createIndex('releaseId', 'releaseId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function getRelease(id) {
  return reqToPromise((await store('releases')).get(Number(id)));
}

/** Enregistre (ou met à jour) un vinyle en conservant les données de collection existantes. */
export async function saveRelease(release) {
  const existing = await getRelease(release.id);
  const now = Date.now();
  const merged = {
    inCollection: 0,
    collection: null,
    firstSeenAt: now,
    viewCount: 0,
    ...existing,
    ...release,
    lastSeenAt: now,
  };
  if (existing) {
    merged.firstSeenAt = existing.firstSeenAt;
    merged.inCollection = existing.inCollection;
    merged.collection = existing.collection;
  }
  merged.viewCount = (existing?.viewCount || 0) + 1;
  await reqToPromise((await store('releases', 'readwrite')).put(merged));
  return merged;
}

export async function addHistory(entry) {
  return reqToPromise((await store('history', 'readwrite')).add({ at: Date.now(), ...entry }));
}

/** Derniers scans (les plus récents d'abord), dédoublonnés par vinyle. */
export async function getHistory(limit = 50) {
  const s = await store('history');
  const items = [];
  const seen = new Set();
  await new Promise((resolve, reject) => {
    const req = s.index('at').openCursor(null, 'prev');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur || items.length >= limit) return resolve();
      if (!seen.has(cur.value.releaseId)) {
        seen.add(cur.value.releaseId);
        items.push(cur.value);
      }
      cur.continue();
    };
  });
  const releases = await Promise.all(items.map((h) => getRelease(h.releaseId)));
  return items.map((h, i) => ({ ...h, release: releases[i] })).filter((h) => h.release);
}

export async function clearHistory() {
  await reqToPromise((await store('history', 'readwrite')).clear());
}

export async function countReleases() {
  return reqToPromise((await store('releases')).count());
}

/** Export complet (sauvegarde JSON). */
export async function exportAll() {
  const releases = await reqToPromise((await store('releases')).getAll());
  const history = await reqToPromise((await store('history')).getAll());
  return { app: 'vinyl-scanner', dbVersion: DB_VERSION, exportedAt: new Date().toISOString(), releases, history };
}
