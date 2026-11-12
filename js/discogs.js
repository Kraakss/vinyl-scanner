// Client de l'API Discogs.
//
// Règles respectées :
//  • Authentification par jeton personnel (stocké sur le téléphone uniquement).
//    Le jeton est passé en paramètre "token" plutôt qu'en en-tête Authorization :
//    c'est une méthode documentée par Discogs, et ça évite une requête CORS
//    "preflight" (OPTIONS) en plus, qui compte elle aussi dans la limite.
//  • Limite : 60 requêtes / minute (fenêtre glissante). On s'arrête à 55 par
//    sécurité, et en cas de réponse 429 on patiente puis on réessaie.
//  • User-Agent : un navigateur n'a pas le droit de le modifier ; il envoie le sien,
//    ce que Discogs accepte pour les applications web.

import { computeRarity } from './rarity.js';

const API = 'https://api.discogs.com';
const MAX_PER_MINUTE = 55;
const WINDOW_MS = 60_000;
const CURRENCY = 'EUR';

const TOKEN_KEY = 'discogs_token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
export function setToken(token) {
  const t = (token || '').trim();
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export class DiscogsError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

// ---------- Limitation du débit ----------
const sent = []; // horodatages des requêtes de la dernière minute
let chain = Promise.resolve();
let onWait = () => {};
export function setWaitListener(fn) { onWait = fn || (() => {}); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slot() {
  // Les requêtes passent une par une dans cette file pour garder un compte exact.
  const p = chain.then(async () => {
    for (;;) {
      const now = Date.now();
      while (sent.length && now - sent[0] > WINDOW_MS) sent.shift();
      if (sent.length < MAX_PER_MINUTE) break;
      const wait = WINDOW_MS - (now - sent[0]) + 50;
      onWait(wait);
      await sleep(wait);
    }
    sent.push(Date.now());
  });
  chain = p.catch(() => {});
  return p;
}

async function request(path, params = {}, { auth = true, retries = 2 } = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  if (auth) {
    const token = getToken();
    if (!token) throw new DiscogsError('Ajoute ton jeton Discogs dans Réglages pour lancer une recherche.', 401);
    url.searchParams.set('token', token);
  }

  await slot();
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/vnd.discogs.v2.discogs+json' } });
  } catch {
    throw new DiscogsError(navigator.onLine === false
      ? 'Pas de connexion internet.'
      : 'Impossible de joindre Discogs. Vérifie ta connexion et réessaie.');
  }

  if (res.status === 429 && retries > 0) {
    onWait(10_000);
    await sleep(10_000);
    return request(path, params, { auth, retries: retries - 1 });
  }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* corps non JSON */ }
    if (res.status === 401) throw new DiscogsError('Jeton Discogs refusé. Vérifie-le dans Réglages.', 401);
    if (res.status === 404) throw new DiscogsError('Introuvable sur Discogs.', 404);
    if (res.status === 429) throw new DiscogsError('Trop de requêtes vers Discogs. Patiente une minute.', 429);
    throw new DiscogsError(msg || `Erreur Discogs (${res.status}).`, res.status);
  }
  return res.json();
}

// ---------- Utilitaires de mise en forme ----------

/** "Daft Punk (2)" → "Daft Punk" */
export const cleanName = (s = '') => s.replace(/\s\(\d+\)$/, '').replace(/\*$/, '').trim();

function joinArtists(artists = []) {
  if (!artists.length) return '';
  return artists
    .map((a, i) => cleanName(a.anv || a.name) + (i < artists.length - 1 ? (a.join ? ` ${a.join} ` : ', ') : ''))
    .join('')
    .replace(/\s+,/g, ',')
    .trim();
}

function formatText(formats = []) {
  return formats
    .map((f) => {
      const qty = f.qty && f.qty !== '1' ? `${f.qty}× ` : '';
      const desc = [...(f.descriptions || []), f.text].filter(Boolean).join(', ');
      return `${qty}${f.name}${desc ? ` (${desc})` : ''}`;
    })
    .join(' + ');
}

/** Résultat de recherche → objet simple pour la liste */
function mapSearchResult(r) {
  const [artist, ...rest] = (r.title || '').split(' - ');
  const labels = [...new Set(r.label || [])];
  return {
    id: r.id,
    artist: cleanName(rest.length ? artist : ''),
    title: rest.length ? rest.join(' - ') : r.title,
    year: r.year || '',
    country: r.country || '',
    label: labels[0] || '',
    catno: r.catno || '',
    format: (r.format || []).join(', '),
    thumb: r.thumb || r.cover_image || '',
    have: r.community?.have ?? null,
    want: r.community?.want ?? null,
  };
}

// ---------- Recherches ----------

async function search(params, page = 1) {
  const data = await request('/database/search', { type: 'release', per_page: 50, page, ...params });
  return {
    items: (data.results || []).map(mapSearchResult),
    page: data.pagination?.page || page,
    pages: data.pagination?.pages || 1,
    total: data.pagination?.items ?? (data.results || []).length,
  };
}

/** Recherche par code-barres. Essaie d'abord les vinyles, puis tous formats, puis la variante UPC/EAN. */
export async function searchBarcode(code, page = 1) {
  const digits = String(code).replace(/\D/g, '');
  const raw = String(code).trim();
  const variants = [digits || raw];
  if (digits.length === 13 && digits.startsWith('0')) variants.push(digits.slice(1)); // EAN-13 → UPC-A
  if (digits.length === 12) variants.push('0' + digits); // UPC-A → EAN-13
  for (const v of variants) {
    const vinyl = await search({ barcode: v, format: 'Vinyl' }, page);
    if (vinyl.total) return { ...vinyl, query: { kind: 'barcode', code: v, format: 'Vinyl' } };
  }
  const all = await search({ barcode: variants[0] }, page);
  return { ...all, query: { kind: 'barcode', code: variants[0] } };
}

/** Recherche par n° de catalogue (+ artiste / label optionnels). */
export async function searchCatno({ catno, artist, label }, page = 1) {
  const extra = { artist: artist || undefined, label: label || undefined };
  const c = catno.trim();
  let r = await search({ catno: c, format: 'Vinyl', ...extra }, page);
  if (r.total) return { ...r, query: { kind: 'catno', catno: c, ...extra, format: 'Vinyl' } };
  // Variante sans espaces / tirets (ex. "PB-41447" vs "PB 41447")
  const compact = c.replace(/[\s\-_.]+/g, '');
  if (compact !== c) {
    r = await search({ catno: compact, format: 'Vinyl', ...extra }, page);
    if (r.total) return { ...r, query: { kind: 'catno', catno: compact, ...extra, format: 'Vinyl' } };
  }
  // Recherche libre en dernier recours
  r = await search({ q: c, format: 'Vinyl', ...extra }, page);
  return { ...r, query: { kind: 'q', q: c, ...extra, format: 'Vinyl' } };
}

/** Page suivante d'une recherche déjà faite (on rejoue exactement la même requête). */
export async function searchMore(query, page) {
  const { kind, code, catno, q, ...rest } = query;
  const params = { ...rest };
  if (kind === 'barcode') params.barcode = code;
  if (kind === 'catno') params.catno = catno;
  if (kind === 'q') params.q = q;
  const r = await search(params, page);
  return { ...r, query };
}

// ---------- Fiche détaillée + marché ----------

const CONDITIONS = [
  ['Mint (M)', 'M', 'Neuf'],
  ['Near Mint (NM or M-)', 'NM', 'Quasi neuf'],
  ['Very Good Plus (VG+)', 'VG+', 'Très bon +'],
  ['Very Good (VG)', 'VG', 'Très bon'],
  ['Good Plus (G+)', 'G+', 'Bon +'],
  ['Good (G)', 'G', 'Bon'],
  ['Fair (F)', 'F', 'Passable'],
  ['Poor (P)', 'P', 'Mauvais'],
];
export const CONDITION_LABELS = Object.fromEntries(CONDITIONS.map(([, k, fr]) => [k, fr]));
export const CONDITION_ORDER = CONDITIONS.map(([, k]) => k);

async function fetchMarket(id) {
  const [stats, suggestions] = await Promise.allSettled([
    request(`/marketplace/stats/${id}`, { curr_abbr: CURRENCY }),
    request(`/marketplace/price_suggestions/${id}`),
  ]);
  const market = { fetchedAt: Date.now(), suggestions: null, suggestionsError: null };
  if (stats.status === 'fulfilled') {
    const s = stats.value;
    market.lowestPrice = s.lowest_price?.value ?? null;
    market.currency = s.lowest_price?.currency || CURRENCY;
    market.numForSale = s.num_for_sale ?? 0;
    market.blockedFromSale = !!s.blocked_from_sale;
  }
  if (suggestions.status === 'fulfilled' && suggestions.value && typeof suggestions.value === 'object') {
    const out = {};
    for (const [en, key] of CONDITIONS) {
      const v = suggestions.value[en];
      if (v && typeof v.value === 'number') out[key] = { value: v.value, currency: v.currency || CURRENCY };
    }
    market.suggestions = Object.keys(out).length ? out : null;
    if (!market.suggestions) market.suggestionsError = 'none';
  } else if (suggestions.status === 'rejected') {
    // Discogs n'envoie ces prix qu'aux comptes ayant rempli leurs "paramètres vendeur".
    market.suggestionsError = 'unavailable';
  }
  return market;
}

/** Transforme une fiche brute Discogs en objet propre (sans les prix). */
function mapRelease(r) {
  const images = r.images || [];
  const primary = images.find((i) => i.type === 'primary') || images[0];
  const labels = (r.labels || []).map((l) => ({ name: cleanName(l.name), catno: l.catno }));
  const artist = joinArtists(r.artists) || cleanName(r.artists_sort || '');
  return {
    id: r.id,
    schemaVersion: 1,
    artist,
    artistSort: (r.artists_sort || artist).toLocaleLowerCase('fr'),
    title: r.title || '',
    year: r.year || null,
    released: r.released_formatted || r.released || '',
    country: r.country || '',
    labels,
    label: labels[0]?.name || '',
    catno: labels[0]?.catno || '',
    formats: (r.formats || []).map((f) => ({ name: f.name, qty: f.qty, descriptions: f.descriptions || [], text: f.text || '' })),
    formatText: formatText(r.formats),
    genres: r.genres || [],
    styles: r.styles || [],
    tracklist: (r.tracklist || [])
      .filter((t) => t.type_ !== 'index' || t.sub_tracks)
      .flatMap((t) => (t.sub_tracks?.length ? t.sub_tracks : [t]).map((x) => ({
        position: x.position || '', title: x.title || '', duration: x.duration || '', heading: x.type_ === 'heading',
      }))),
    barcodes: (r.identifiers || []).filter((i) => i.type === 'Barcode').map((i) => i.value),
    coverUrl: primary?.uri || r.thumb || '',
    thumbUrl: primary?.uri150 || r.thumb || '',
    discogsUrl: r.uri || `https://www.discogs.com/release/${r.id}`,
    masterId: r.master_id || null,
    community: {
      have: r.community?.have ?? 0,
      want: r.community?.want ?? 0,
      ratingAvg: r.community?.rating?.average ?? null,
      ratingCount: r.community?.rating?.count ?? 0,
    },
    basicFetchedAt: Date.now(),
  };
}

/** Récupère la fiche complète + les prix (3 requêtes), et calcule la rareté. */
export async function fetchRelease(id) {
  const [r, market] = await Promise.all([request(`/releases/${id}`), fetchMarket(id)]);
  if (market.numForSale === undefined) market.numForSale = r.num_for_sale ?? 0;
  if (market.lowestPrice === undefined) {
    // Secours : le prix de la fiche Discogs est toujours en dollars.
    market.lowestPrice = r.lowest_price ?? null;
    market.currency = 'USD';
  }
  const release = mapRelease(r);
  return {
    ...release,
    market,
    rarity: computeRarity({ have: release.community.have, want: release.community.want, numForSale: market.numForSale }),
    detailFetchedAt: Date.now(),
  };
}

/** Fiche sans les prix (1 requête) : pochette, titres, genres, chiffres communauté. */
export async function fetchReleaseBasic(id) {
  return mapRelease(await request(`/releases/${id}`));
}

/** Prix le plus bas actuel en euros + nombre en vente (1 requête). */
export async function fetchStats(id) {
  const s = await request(`/marketplace/stats/${id}`, { curr_abbr: CURRENCY });
  return {
    lowestPrice: s.lowest_price?.value ?? null,
    currency: s.lowest_price?.currency || CURRENCY,
    numForSale: s.num_for_sale ?? 0,
    blockedFromSale: !!s.blocked_from_sale,
  };
}

/** Catégorie de format simple et stable, ex. 'Vinyl 12"', 'Vinyl 7"', 'Box Set'. */
export function formatCategory(formats = []) {
  if (!formats.length) return '';
  const all = formats.flatMap((f) => [f.name, ...(f.descriptions || [])]);
  if (all.includes('Box Set')) return 'Box Set';
  const f = formats[0];
  const d = f.descriptions || [];
  const size = ['12"', '10"', '7"'].find((x) => d.includes(x)) || (d.includes('LP') ? '12"' : '');
  return size ? `${f.name} ${size}` : f.name;
}

/** Vérifie le jeton : renvoie le nom d'utilisateur Discogs. */
export async function checkToken() {
  const me = await request('/oauth/identity');
  return me.username;
}
