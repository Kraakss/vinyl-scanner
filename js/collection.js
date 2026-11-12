// Gestion de la collection : import Record Scanner, tris, filtres, statistiques, export CSV.
// Les fonctions "pures" (sans base de données) sont testables séparément.

// ---------- Outils ----------

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

/** Minuscules sans accents, pour la recherche. */
export const normalize = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const pick = (row, name) => {
  const v = row[name];
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
};

/** "Rock, Folk, World, & Country" → ["Rock", "Folk, World, & Country"] */
export function splitGenres(text) {
  const KEEP = 'Folk, World, & Country';
  const ph = '\u0000FWC\u0000';
  return String(text || '')
    .replace(KEEP, ph)
    .split(/\s*[,;|]\s*/)
    .map((g) => g.replace(ph, KEEP).trim())
    .filter(Boolean);
}

/** "A1. Titre\nA2. Autre" → [{ position: 'A1', title: 'Titre' }, …] */
export function parseTracklist(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([A-Z]{1,2}\d{1,3}[a-z]?|[A-Z]|\d{1,3}[a-z]?)\.\s+(.*)$/);
      return m ? { position: m[1], title: m[2], duration: '' } : { position: '', title: line, duration: '' };
    });
}

/** "Barcode: 0 42281 86331 8 (Text)" → "0 42281 86331 8" */
function parseBarcodes(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((l) => /^barcode\s*:/i.test(l.trim()))
    .map((l) => l.replace(/^barcode\s*:\s*/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim())
    .filter(Boolean);
}

/** "7.75" ou "7,75" → 7.75 ; vide ou illisible → null */
export function parsePrice(text) {
  const t = String(text ?? '').replace(/\s|€/g, '').replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

/** "2024-04-28 17:33:05" → horodatage (heure locale) ; illisible → null */
export function parseDate(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const d = new Date(t.includes('T') ? t : t.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** Identifiant Discogs : "4704137", "r4704137" ou une URL → 4704137 ; sinon null */
export function parseReleaseId(text) {
  const m = String(text || '').match(/(\d{1,10})/);
  const n = m ? Number(m[1]) : 0;
  return n > 0 ? n : null;
}

// ---------- Import Record Scanner ----------

export const RS_REQUIRED = 'DiscogsReleaseId';

/** Transforme une ligne du CSV en fiche (sans les données de collection fusionnées). */
export function rowToRecord(row, now = Date.now()) {
  const id = parseReleaseId(pick(row, 'DiscogsReleaseId'));
  if (!id) return { error: 'DiscogsReleaseId manquant ou invalide' };

  const artist = pick(row, 'Artist');
  let title = pick(row, 'AlbumTitle');
  const fullTitle = pick(row, 'Title');
  if (!title && fullTitle) title = artist && fullTitle.startsWith(`${artist} - `) ? fullTitle.slice(artist.length + 3) : fullTitle;
  const label = pick(row, 'Label');
  const catno = pick(row, 'CatNo');
  const released = pick(row, 'Released');
  const yearMatch = released.match(/(1[89]\d\d|20\d\d)/);
  const currency = (pick(row, 'Currency') || 'EUR').toUpperCase();
  const price = parsePrice(pick(row, 'Price'));
  const addedAt = parseDate(pick(row, 'AddedAt')) || now;
  const format = pick(row, 'Format');
  const uniqueId = pick(row, 'UniqueId')
    || `ligne:${[artist, title, catno, pick(row, 'AddedAt')].join('|')}`; // à défaut d'identifiant

  const record = {
    id,
    schemaVersion: 1,
    artist,
    artistSort: (pick(row, 'ArtistSort') || artist).toLocaleLowerCase('fr'),
    title,
    year: yearMatch ? Number(yearMatch[1]) : null,
    released,
    country: pick(row, 'Country'),
    labels: label || catno ? [{ name: label, catno }] : [],
    label,
    catno,
    formats: [],
    formatText: format,
    genres: splitGenres(pick(row, 'Genres')),
    styles: [],
    tracklist: parseTracklist(pick(row, 'Tracklist')),
    barcodes: parseBarcodes(pick(row, 'Identifiers')),
    coverUrl: '',
    thumbUrl: '',
    discogsUrl: `https://www.discogs.com/release/${id}`,
    estimatedValue: currency === 'EUR' ? price : null,
    valueInfo: price !== null && currency === 'EUR' ? { source: 'recordscanner', updatedAt: now, previous: null } : null,
    firstSeenAt: now,
    lastSeenAt: addedAt,
    viewCount: 0,
    inCollection: 1,
    collection: {
      addedAt,
      quantity: 1,
      condition: '',
      sleeveCondition: '',
      notes: pick(row, 'Notes'),
      shelf: pick(row, 'Shelf'),
      positionInShelf: pick(row, 'PositionInShelf'),
      format,
      source: 'recordscanner',
      importPrice: price,
      importCurrency: currency,
      rsUniqueIds: [uniqueId],
      tags: pick(row, 'Tags'),
      color: pick(row, 'Color'),
    },
  };
  return { id, record, uniqueId };
}

const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** Fusionne une fiche importée dans une fiche existante sans écraser ce qui a été saisi ou récupéré. */
function mergeImported(existing, imported) {
  const rec = { ...existing };
  // Infos descriptives : on ne complète que les champs vides (Discogs reste prioritaire).
  for (const key of ['artist', 'artistSort', 'title', 'year', 'released', 'country', 'labels', 'label', 'catno',
    'formatText', 'genres', 'tracklist', 'barcodes', 'discogsUrl']) {
    if (isEmpty(rec[key])) rec[key] = imported[key];
  }
  if (rec.estimatedValue === null || rec.estimatedValue === undefined) {
    rec.estimatedValue = imported.estimatedValue;
    rec.valueInfo = imported.valueInfo;
  }
  const ic = imported.collection;
  if (existing.inCollection && existing.collection) {
    const c = { ...existing.collection };
    const ids = new Set([...(c.rsUniqueIds || []), ...ic.rsUniqueIds]);
    c.rsUniqueIds = [...ids];
    c.quantity = Math.max(c.quantity || 1, ids.size);
    c.addedAt = Math.min(c.addedAt || ic.addedAt, ic.addedAt);
    for (const key of ['shelf', 'positionInShelf', 'format', 'notes', 'tags', 'color']) {
      if (isEmpty(c[key])) c[key] = ic[key];
    }
    if (c.importPrice === null || c.importPrice === undefined) {
      c.importPrice = ic.importPrice;
      c.importCurrency = ic.importCurrency;
    }
    rec.collection = c;
  } else {
    rec.collection = { ...ic };
  }
  rec.inCollection = 1;
  return rec;
}

/**
 * Prépare l'import : renvoie les fiches à écrire et un résumé.
 * existing : Map id → fiche déjà présente sur le téléphone.
 */
export function prepareImport(rows, existing, now = Date.now()) {
  const summary = { rows: rows.length, imported: 0, created: 0, updated: 0, unchanged: 0, duplicates: 0, errors: 0, errorDetails: [] };
  const out = new Map(); // id → fiche finale
  const seenUnique = new Set();

  rows.forEach((row, i) => {
    const res = rowToRecord(row, now);
    if (res.error) {
      summary.errors += 1;
      const name = [pick(row, 'Artist'), pick(row, 'AlbumTitle') || pick(row, 'Title')].filter(Boolean).join(' – ');
      summary.errorDetails.push(`Ligne ${i + 2}${name ? ` (${name})` : ''} : ${res.error}`);
      return;
    }
    const { id, record, uniqueId } = res;

    if (out.has(id)) {
      // Même disque plusieurs fois dans le fichier → un seul disque, quantité augmentée.
      summary.duplicates += 1;
      const rec = out.get(id);
      if (!seenUnique.has(uniqueId)) {
        const ids = new Set([...rec.collection.rsUniqueIds, uniqueId]);
        rec.collection.rsUniqueIds = [...ids];
        rec.collection.quantity = Math.max(rec.collection.quantity || 1, ids.size);
      }
      seenUnique.add(uniqueId);
      return;
    }
    seenUnique.add(uniqueId);

    const before = existing.get(id);
    if (!before) {
      summary.created += 1;
      out.set(id, record);
    } else {
      const alreadyImported = before.inCollection && (before.collection?.rsUniqueIds || []).includes(uniqueId);
      if (alreadyImported) summary.unchanged += 1;
      else summary.updated += 1;
      out.set(id, mergeImported(before, record));
    }
    summary.imported += 1;
  });

  return { records: [...out.values()], summary };
}

// ---------- Valeurs ----------

export const quantityOf = (r) => Math.max(1, Number(r.collection?.quantity) || 1);
export const valueOf = (r) => (typeof r.estimatedValue === 'number' ? r.estimatedValue : null);

/** Écart entre la valeur actuelle et la valeur précédente (null si inconnu). */
export function valueDelta(r) {
  const prev = r.valueInfo?.previous;
  const cur = valueOf(r);
  if (cur === null || prev === null || prev === undefined) return null;
  return Math.round((cur - prev) * 100) / 100;
}

/** Catégorie de format pour les filtres. */
export function formatOf(r) {
  return r.collection?.format || r.formatText || 'Autre';
}

// ---------- Tri, filtres, recherche ----------

export const SORTS = {
  'value-desc': 'Valeur (décroissante)',
  'value-asc': 'Valeur (croissante)',
  artist: 'Artiste A → Z',
  title: 'Titre A → Z',
  'year-asc': 'Année (plus ancien)',
  'year-desc': 'Année (plus récent)',
  'added-desc': 'Ajout (plus récent)',
  'added-asc': 'Ajout (plus ancien)',
};

function nullsLast(a, b, cmp) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  return cmp(a, b);
}

export function sortItems(items, sort) {
  const byArtist = (a, b) => collator.compare(a.artistSort || a.artist || '', b.artistSort || b.artist || '')
    || (a.year || 0) - (b.year || 0) || collator.compare(a.title || '', b.title || '');
  const cmp = {
    'value-desc': (a, b) => nullsLast(valueOf(a), valueOf(b), (x, y) => y - x) || byArtist(a, b),
    'value-asc': (a, b) => nullsLast(valueOf(a), valueOf(b), (x, y) => x - y) || byArtist(a, b),
    artist: byArtist,
    title: (a, b) => collator.compare(a.title || '', b.title || '') || byArtist(a, b),
    'year-asc': (a, b) => nullsLast(a.year, b.year, (x, y) => x - y) || byArtist(a, b),
    'year-desc': (a, b) => nullsLast(a.year, b.year, (x, y) => y - x) || byArtist(a, b),
    'added-desc': (a, b) => (b.collection?.addedAt || 0) - (a.collection?.addedAt || 0),
    'added-asc': (a, b) => (a.collection?.addedAt || 0) - (b.collection?.addedAt || 0),
  }[sort] || byArtist;
  return [...items].sort(cmp);
}

export function filterItems(items, { q = '', genre = '', format = '', shelf = '' } = {}) {
  const words = normalize(q).split(/\s+/).filter(Boolean);
  return items.filter((r) => {
    if (genre && !(r.genres || []).includes(genre)) return false;
    if (format && formatOf(r) !== format) return false;
    if (shelf && String(r.collection?.shelf ?? '') !== shelf) return false;
    if (!words.length) return true;
    const hay = normalize([
      r.artist, r.title, r.label, r.catno,
      ...(r.labels || []).flatMap((l) => [l.name, l.catno]),
    ].join(' '));
    const hayCompact = hay.replace(/[\s\-_.\/]/g, '');
    return words.every((w) => hay.includes(w) || hayCompact.includes(w.replace(/[\s\-_.\/]/g, '')));
  });
}

/** Valeurs disponibles pour les listes de filtres. */
export function filterOptions(items) {
  const genres = new Set();
  const formats = new Set();
  const shelves = new Set();
  for (const r of items) {
    (r.genres || []).forEach((g) => genres.add(g));
    formats.add(formatOf(r));
    if (r.collection?.shelf !== undefined && r.collection?.shelf !== '') shelves.add(String(r.collection.shelf));
  }
  return {
    genres: [...genres].sort(collator.compare),
    formats: [...formats].sort(collator.compare),
    shelves: [...shelves].sort(collator.compare),
  };
}

// ---------- Statistiques ----------

export function computeStats(items) {
  let discs = 0;
  let total = 0;
  let valued = 0;
  let previousTotal = 0;
  let comparable = 0;
  const genres = new Map();
  const decades = new Map();
  let unknownYear = 0;

  for (const r of items) {
    const q = quantityOf(r);
    discs += q;
    const v = valueOf(r);
    if (v !== null) {
      total += v * q;
      valued += q;
    }
    const d = valueDelta(r);
    if (d !== null) {
      previousTotal += r.valueInfo.previous * q;
      comparable += q;
    }
    for (const g of r.genres?.length ? r.genres : ['Non renseigné']) genres.set(g, (genres.get(g) || 0) + q);
    if (r.year && r.year > 1800) {
      const dec = Math.floor(r.year / 10) * 10;
      decades.set(dec, (decades.get(dec) || 0) + q);
    } else {
      unknownYear += q;
    }
  }

  const top = items.filter((r) => valueOf(r) !== null).sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 10);
  const decadeList = [...decades.entries()].sort((a, b) => a[0] - b[0]);
  return {
    references: items.length,
    discs,
    total: Math.round(total * 100) / 100,
    average: valued ? Math.round((total / valued) * 100) / 100 : null,
    valued,
    comparable,
    previousTotal: Math.round(previousTotal * 100) / 100,
    top,
    genres: [...genres.entries()].sort((a, b) => b[1] - a[1]),
    decades: decadeList,
    unknownYear,
  };
}

// ---------- Export CSV (Excel en français : point-virgule, virgule décimale, UTF-8 avec BOM) ----------

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const frNumber = (n) => (typeof n === 'number' ? String(n.toFixed(2)).replace('.', ',') : '');
const frDate = (ts) => (ts ? new Date(ts).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '');

export function collectionToCsv(items) {
  const cols = [
    ['Artiste', (r) => r.artist],
    ['Titre', (r) => r.title],
    ['Label', (r) => r.label],
    ['N° catalogue', (r) => r.catno],
    ['Format', (r) => formatOf(r)],
    ['Pays', (r) => r.country],
    ['Année', (r) => r.year || ''],
    ['Genres', (r) => (r.genres || []).join(', ')],
    ['Styles', (r) => (r.styles || []).join(', ')],
    ['Quantité', (r) => quantityOf(r)],
    ['État disque', (r) => r.collection?.condition],
    ['État pochette', (r) => r.collection?.sleeveCondition],
    ['Étagère', (r) => r.collection?.shelf],
    ['Position', (r) => r.collection?.positionInShelf],
    ['Note', (r) => r.collection?.notes],
    ['Valeur estimée (€)', (r) => frNumber(valueOf(r))],
    ['Valeur précédente (€)', (r) => frNumber(r.valueInfo?.previous ?? null)],
    ['Écart (€)', (r) => frNumber(valueDelta(r))],
    ['Valeur mise à jour le', (r) => frDate(r.valueInfo?.updatedAt)],
    ['En vente sur Discogs', (r) => r.market?.numForSale ?? ''],
    ['Membres qui l\'ont', (r) => r.community?.have ?? ''],
    ['Membres qui le recherchent', (r) => r.community?.want ?? ''],
    ['Rareté', (r) => r.rarity?.label || ''],
    ['Ajouté le', (r) => frDate(r.collection?.addedAt)],
    ['Discogs ID', (r) => r.id],
    ['Lien Discogs', (r) => r.discogsUrl],
  ];
  const lines = [cols.map(([h]) => csvCell(h)).join(';')];
  for (const r of items) lines.push(cols.map(([, f]) => csvCell(f(r))).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}
