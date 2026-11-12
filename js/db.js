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

//  ---- Ajouts de la version 2 (v2.0.0 de l'appli) : AUCUNE donnée existante n'est modifiée ----
//
//  • items     (clé : key) → jeux vidéo et DVD (kind = 'game' | 'dvd')
//      { key, kind, sourceId, title, sortTitle, year, coverUrl, thumbUrl, genres, summary,
//        platform, platformName (jeux), mediaType (DVD : 'movie' | 'tv'), people,
//        inCollection: 0|1, collection: { addedAt, quantity, notes, condition, completeness, region, format, edition },
//        price: { median, low, high, count, basis, fetchedAt, … } (jeux), manualValue, estimatedValue, valueInfo,
//        barcodes: [], firstSeenAt, lastSeenAt, detailFetchedAt }
//  • disney    (clé : num) → { num, owned: 0|1, format, edition, condition, notes, addedAt, barcodes: [] }
//      Depuis la v2.1, « num » contient l'identifiant texte du film (ex. 'le-roi-lion'),
//      qui ne change jamais même si le numéro officiel du film est corrigé.
//  • barcodes  (clé : code) → lien code-barres → objet : { code, kind, ref, title, at }
//  • meta      (clé : key) → petites données diverses (affiches Disney en cache…)
//  • snapshots (clé : id)  → copie de sécurité des vinyles faite automatiquement avant la migration

const DB_NAME = 'vinyl-scanner';
const DB_VERSION = 2;
export const SNAPSHOT_ID = 'avant-v2';
let dbPromise = null;
let blockedListener = () => {};
export function onBlocked(fn) { blockedListener = fn; }

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Une ancienne version de l'appli ouverte ailleurs empêche la mise à jour de la base
    req.onblocked = () => blockedListener();
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      const oldVersion = event.oldVersion || 0;
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
      // ---- Version 2 : nouveaux espaces de stockage (les vinyles ne sont pas touchés) ----
      if (!db.objectStoreNames.contains('items')) {
        const it = db.createObjectStore('items', { keyPath: 'key' });
        it.createIndex('kind', 'kind');
        it.createIndex('kindColl', ['kind', 'inCollection']);
        it.createIndex('sourceId', 'sourceId');
      }
      if (!db.objectStoreNames.contains('disney')) db.createObjectStore('disney', { keyPath: 'num' });
      if (!db.objectStoreNames.contains('barcodes')) db.createObjectStore('barcodes', { keyPath: 'code' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' });

      // Copie de sécurité des vinyles au passage de la version 1 à la version 2
      if (oldVersion >= 1 && oldVersion < 2) {
        const rel = tx.objectStore('releases').getAll();
        rel.onsuccess = () => {
          const hist = tx.objectStore('history').getAll();
          hist.onsuccess = () => {
            tx.objectStore('snapshots').put({
              id: SNAPSHOT_ID,
              createdAt: Date.now(),
              fromVersion: oldVersion,
              app: 'vinyl-scanner',
              dbVersion: 1,
              releases: rel.result,
              history: hist.result,
            });
          };
        };
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Si une future version de l'appli veut mettre la base à jour, on la laisse faire.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
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

// ---------- Sauvegardes JSON ----------
//
// Format (compatible avec la v1) :
//   { app: 'vinyl-scanner', dbVersion, exportedAt, releases: [], history: [],
//     items: [], disney: [], barcodes: [] }        ← ces 3 tableaux sont nouveaux et facultatifs
// Une sauvegarde v1 (releases + history seulement) se restaure toujours.
// Une ancienne version de l'appli sait lire une sauvegarde v2 (elle ignore les nouveaux tableaux).

const getAllOf = async (name) => reqToPromise((await store(name)).getAll());

/** Sauvegarde : 'all' ou une seule collection ('vinyl' | 'game' | 'dvd' | 'disney'). */
export async function exportAll(section = 'all') {
  const out = { app: 'vinyl-scanner', dbVersion: DB_VERSION, exportedAt: new Date().toISOString(), section };
  if (section === 'all' || section === 'vinyl') {
    out.releases = await getAllOf('releases');
    out.history = await getAllOf('history');
  }
  if (section === 'all' || section === 'game' || section === 'dvd') {
    const items = await getAllOf('items');
    out.items = section === 'all' ? items : items.filter((i) => i.kind === section);
  }
  if (section === 'all' || section === 'disney') out.disney = await getAllOf('disney');
  const barcodes = await getAllOf('barcodes');
  out.barcodes = section === 'all' ? barcodes : barcodes.filter((b) => b.kind === section);
  return out;
}

/**
 * Restaure une sauvegarde JSON (complète ou d'une seule collection). Les éléments du
 * fichier remplacent ceux du téléphone ayant le même identifiant ; les autres sont conservés.
 */
export async function importBackup(data) {
  const arrays = ['releases', 'items', 'disney', 'barcodes'].filter((k) => Array.isArray(data?.[k]));
  if (!data || data.app !== 'vinyl-scanner' || !arrays.length) {
    throw new Error('Ce fichier n\'est pas une sauvegarde Vinyl Scanner.');
  }
  const releases = (data.releases || []).filter((r) => r && Number.isFinite(Number(r.id)) && Number(r.id) > 0)
    .map((r) => ({ ...r, id: Number(r.id), inCollection: r.inCollection ? 1 : 0 }));
  const existingHistory = await getAllOf('history');
  const seen = new Set(existingHistory.map((h) => `${h.at}|${h.releaseId}`));
  const history = (Array.isArray(data.history) ? data.history : [])
    .filter((h) => h && h.releaseId && h.at && !seen.has(`${h.at}|${h.releaseId}`))
    .map(({ id, ...h }) => h); // nouvel identifiant attribué automatiquement
  const items = (data.items || []).filter((i) => i && typeof i.key === 'string' && ['game', 'dvd'].includes(i.kind))
    .map((i) => ({ ...i, inCollection: i.inCollection ? 1 : 0 }));
  const disney = (data.disney || []).filter((d) => d && (typeof d.num === 'string' ? d.num : Number.isFinite(Number(d.num))))
    .map((d) => ({ ...d, num: disneyKey(d.num), owned: d.owned ? 1 : 0 }));
  const barcodes = (data.barcodes || []).filter((b) => b && typeof b.code === 'string' && b.kind);

  const db = await open();
  const tx = db.transaction(['releases', 'history', 'items', 'disney', 'barcodes'], 'readwrite');
  releases.forEach((r) => tx.objectStore('releases').put(r));
  history.forEach((h) => tx.objectStore('history').add(h));
  items.forEach((i) => tx.objectStore('items').put(i));
  disney.forEach((d) => tx.objectStore('disney').put(d));
  barcodes.forEach((b) => tx.objectStore('barcodes').put(b));
  await txDone(tx);
  return {
    releases: releases.length,
    inCollection: releases.filter((r) => r.inCollection).length,
    history: history.length,
    games: items.filter((i) => i.kind === 'game' && i.inCollection).length,
    dvds: items.filter((i) => i.kind === 'dvd' && i.inCollection).length,
    disney: disney.filter((d) => d.owned).length,
    barcodes: barcodes.length,
  };
}

/** Copie de sécurité faite automatiquement avant la migration v2 (ou null). */
export async function getSnapshot() {
  try { return await reqToPromise((await store('snapshots')).get(SNAPSHOT_ID)); } catch { return null; }
}

// ---------- Jeux vidéo et DVD ----------

export async function getItem(key) {
  return reqToPromise((await store('items')).get(key));
}

/** Lecture-modification-écriture d'un jeu / DVD dans une seule transaction. */
export async function updateItem(key, mutator) {
  const db = await open();
  const tx = db.transaction('items', 'readwrite');
  const s = tx.objectStore('items');
  let result = null;
  const get = s.get(key);
  get.onsuccess = () => {
    const next = mutator(get.result ? structuredClone(get.result) : undefined);
    if (next) { result = next; s.put(next); } else { result = get.result || null; }
  };
  await txDone(tx);
  return result;
}

/** Tous les jeux (ou DVD) ; ownedOnly = seulement ceux de la collection. */
export async function getItems(kind, { ownedOnly = false } = {}) {
  const s = await store('items');
  if (ownedOnly) return reqToPromise(s.index('kindColl').getAll([kind, 1]));
  return reqToPromise(s.index('kind').getAll(kind));
}

export async function getItemsBySource(sourceId) {
  return reqToPromise((await store('items')).index('sourceId').getAll(sourceId));
}

// ---------- Disney ----------

export async function getDisneyAll() {
  return reqToPromise((await store('disney')).getAll());
}

/** Clé d'un film Disney : identifiant texte (v2.1) ou ancien numéro (v2.0). */
export const disneyKey = (k) => (typeof k === 'number' || /^\d+$/.test(String(k)) ? Number(k) : String(k));

export async function updateDisney(num, mutator) {
  const key = disneyKey(num);
  const db = await open();
  const tx = db.transaction('disney', 'readwrite');
  const s = tx.objectStore('disney');
  let result = null;
  const get = s.get(key);
  get.onsuccess = () => {
    const next = mutator(get.result ? structuredClone(get.result) : { num: key, id: key, owned: 0, barcodes: [] });
    if (next) { result = next; s.put(next); } else { result = get.result || null; }
  };
  await txDone(tx);
  return result;
}

/**
 * Migration Disney v2.0 → v2.1 : les films étaient rangés sous leur numéro de la
 * liste Wikipédia (1 à 65) ; ils sont maintenant rangés sous un identifiant texte.
 * mapOld(numéro) → identifiant. Tout se fait dans UNE transaction (tout ou rien),
 * après une copie de sécurité. Renvoie le nombre de fiches et de codes déplacés.
 */
export async function migrateDisneyKeys(mapOld) {
  const db = await open();
  const tx = db.transaction(['disney', 'barcodes', 'snapshots'], 'readwrite');
  const ds = tx.objectStore('disney');
  const bs = tx.objectStore('barcodes');
  const result = { films: 0, barcodes: 0, unknown: [] };
  const allD = ds.getAll();
  allD.onsuccess = () => {
    const legacy = allD.result.filter((d) => typeof d.num === 'number');
    const allB = bs.getAll();
    allB.onsuccess = () => {
      const legacyB = allB.result.filter((b) => b.kind === 'disney' && typeof b.ref === 'number');
      if (!legacy.length && !legacyB.length) return;
      tx.objectStore('snapshots').put({ id: 'disney-avant-v2.1', createdAt: Date.now(), disney: allD.result, barcodes: allB.result.filter((b) => b.kind === 'disney') });
      const byKey = new Map(allD.result.map((d) => [d.num, d]));
      for (const d of legacy) {
        const id = mapOld(d.num);
        if (!id) { result.unknown.push(d.num); continue; } // gardé tel quel, rien n'est perdu
        const cur = byKey.get(id);
        const merged = cur
          ? { ...d, ...cur, owned: cur.owned || d.owned ? 1 : 0, addedAt: cur.addedAt || d.addedAt || null,
            barcodes: [...new Set([...(cur.barcodes || []), ...(d.barcodes || [])])],
            format: cur.format || d.format, edition: cur.edition || d.edition, condition: cur.condition || d.condition, notes: cur.notes || d.notes }
          : { ...d };
        merged.num = id;
        merged.id = id;
        merged.legacyNum = d.num;
        byKey.set(id, merged);
        ds.put(merged);
        ds.delete(d.num);
        result.films += 1;
      }
      for (const b of legacyB) {
        const id = mapOld(b.ref);
        if (!id) continue;
        bs.put({ ...b, ref: id, legacyRef: b.ref });
        result.barcodes += 1;
      }
    };
  };
  await txDone(tx);
  return result;
}

// ---------- Codes-barres mémorisés ----------

export async function getBarcode(code) {
  return reqToPromise((await store('barcodes')).get(String(code)));
}
export async function setBarcode(code, link) {
  return reqToPromise((await store('barcodes', 'readwrite')).put({ code: String(code), at: Date.now(), ...link }));
}
export async function deleteBarcode(code) {
  return reqToPromise((await store('barcodes', 'readwrite')).delete(String(code)));
}

// ---------- Divers ----------

export async function getMeta(key) {
  const r = await reqToPromise((await store('meta')).get(key));
  return r ? r.value : undefined;
}
export async function setMeta(key, value) {
  return reqToPromise((await store('meta', 'readwrite')).put({ key, value }));
}
