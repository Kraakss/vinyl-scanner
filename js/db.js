// Stockage local (IndexedDB) : tout reste sur le téléphone.
//
// Base "vinyl-scanner", version 1 :
//
//  • releases  (clé : id Discogs)  → un document par vinyle consulté ou possédé
//      {
//        id, schemaVersion,
//        artist, artistSort, title, year, country, released,
//        labels: [{ name, catno }], catno, label,
//        formats: [{ name, qty, descriptions, text }], formatText,
//        genres: [], styles: [],
//        tracklist: [{ position, title, duration }],
//        barcodes: [], coverUrl, thumbUrl, discogsUrl, masterId,
//        community: { have, want, ratingAvg, ratingCount },
//        market: { lowestPrice, currency, numForSale, blockedFromSale, suggestions, fetchedAt },
//        rarity: { level, label, score },
//        basicFetchedAt,           // date de la dernière lecture de la fiche Discogs
//        detailFetchedAt,          // date de la dernière fiche complète (avec prix par état)
//        estimatedValue,           // valeur retenue en € (prix Record Scanner, puis prix le plus bas Discogs)
//        valueInfo: { source, updatedAt, checkedAt, previous, previousAt, noneForSale },
//        firstSeenAt, lastSeenAt, viewCount,
//        inCollection: 0 | 1,      // nombre (0/1) car IndexedDB n'indexe pas les booléens
//        collection: {
//          addedAt, quantity, condition, sleeveCondition, notes,
//          shelf, positionInShelf, format, source: 'app' | 'recordscanner',
//          importPrice, importCurrency, rsUniqueIds: [], tags, color
//        }
//      }
//      index : lastSeenAt, inCollection, artistSort, title, genres (multiEntry), estimatedValue
//
//  • history   (clé auto) → une ligne par recherche aboutie
//      { id, releaseId, at, method: 'barcode' | 'catno' | 'ocr', query }

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

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction annulée'));
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function getRelease(id) {
  return reqToPromise((await store('releases')).get(Number(id)));
}

/**
 * Lit, modifie et réécrit un vinyle dans une seule transaction (pas de conflit
 * si la mise à jour des prix tourne en même temps). mutator(existant) renvoie
 * le nouvel objet, ou null pour ne rien changer.
 */
export async function updateRelease(id, mutator) {
  const db = await open();
  const tx = db.transaction('releases', 'readwrite');
  const s = tx.objectStore('releases');
  let result = null;
  const get = s.get(Number(id));
  get.onsuccess = () => {
    const next = mutator(get.result ? structuredClone(get.result) : undefined);
    if (next) {
      result = next;
      s.put(next);
    } else {
      result = get.result || null;
    }
  };
  await txDone(tx);
  return result;
}

/**
 * Met à jour la valeur estimée avec un nouveau prix le plus bas (en €).
 * L'ancienne valeur est conservée dans valueInfo.previous pour afficher l'écart.
 */
export function applyLowestPrice(rec, market, now = Date.now()) {
  if (!market || market.currency !== 'EUR' || market.blockedFromSale) return rec;
  const info = rec.valueInfo || {};
  if (market.lowestPrice === null || market.lowestPrice === undefined) {
    // Aucun exemplaire en vente : on garde la valeur connue.
    rec.valueInfo = { ...info, checkedAt: now, noneForSale: true };
    return rec;
  }
  rec.valueInfo = {
    source: 'discogs',
    updatedAt: now,
    checkedAt: now,
    previous: rec.estimatedValue ?? null,
    previousAt: info.updatedAt ?? null,
    noneForSale: false,
  };
  rec.estimatedValue = market.lowestPrice;
  return rec;
}

/** Enregistre une fiche complète venant de Discogs, sans toucher aux données de collection. */
export async function saveRelease(release) {
  return updateRelease(release.id, (existing) => {
    const now = Date.now();
    const rec = { inCollection: 0, collection: null, firstSeenAt: now, viewCount: 0, ...existing, ...release, lastSeenAt: now };
    if (existing) {
      rec.firstSeenAt = existing.firstSeenAt ?? now;
      rec.inCollection = existing.inCollection || 0;
      rec.collection = existing.collection || null;
      rec.estimatedValue = existing.estimatedValue ?? null;
      rec.valueInfo = existing.valueInfo || null;
    } else {
      rec.estimatedValue = null;
      rec.valueInfo = null;
    }
    rec.viewCount = (existing?.viewCount || 0) + 1;
    if (release.market) applyLowestPrice(rec, release.market, now);
    return rec;
  });
}

/** Note simplement qu'une fiche a été consultée. */
export async function touchRelease(id) {
  return updateRelease(id, (rec) => {
    if (!rec) return null;
    rec.lastSeenAt = Date.now();
    rec.viewCount = (rec.viewCount || 0) + 1;
    return rec;
  });
}

/** Tous les disques de la collection. */
export async function getCollection() {
  return reqToPromise((await store('releases')).index('inCollection').getAll(1));
}

/** Toutes les fiches, sous forme de Map id → fiche. */
export async function getAllReleasesMap() {
  const all = await reqToPromise((await store('releases')).getAll());
  return new Map(all.map((r) => [r.id, r]));
}

/** Écrit beaucoup de fiches d'un coup (import). */
export async function putMany(records) {
  const db = await open();
  const tx = db.transaction('releases', 'readwrite');
  const s = tx.objectStore('releases');
  for (const r of records) s.put(r);
  await txDone(tx);
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

/** Sauvegarde complète (JSON). */
export async function exportAll() {
  const releases = await reqToPromise((await store('releases')).getAll());
  const history = await reqToPromise((await store('history')).getAll());
  return { app: 'vinyl-scanner', dbVersion: DB_VERSION, exportedAt: new Date().toISOString(), releases, history };
}

/**
 * Restaure une sauvegarde JSON. Les fiches du fichier remplacent celles du
 * téléphone ayant le même id ; les autres sont conservées. Pas de doublon d'historique.
 */
export async function importBackup(data) {
  if (!data || data.app !== 'vinyl-scanner' || !Array.isArray(data.releases)) {
    throw new Error('Ce fichier n\'est pas une sauvegarde Vinyl Scanner.');
  }
  const releases = data.releases.filter((r) => r && Number.isFinite(Number(r.id)) && Number(r.id) > 0)
    .map((r) => ({ ...r, id: Number(r.id), inCollection: r.inCollection ? 1 : 0 }));
  const existingHistory = await reqToPromise((await store('history')).getAll());
  const seen = new Set(existingHistory.map((h) => `${h.at}|${h.releaseId}`));
  const history = (Array.isArray(data.history) ? data.history : [])
    .filter((h) => h && h.releaseId && h.at && !seen.has(`${h.at}|${h.releaseId}`))
    .map(({ id, ...h }) => h); // nouvel identifiant attribué automatiquement

  const db = await open();
  const tx = db.transaction(['releases', 'history'], 'readwrite');
  const rs = tx.objectStore('releases');
  const hs = tx.objectStore('history');
  releases.forEach((r) => rs.put(r));
  history.forEach((h) => hs.add(h));
  await txDone(tx);
  return { releases: releases.length, inCollection: releases.filter((r) => r.inCollection).length, history: history.length };
}
