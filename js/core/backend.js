// Appels vers le Cloudflare Worker (intermédiaire pour IGDB, eBay, TMDB et les codes-barres).
// L'adresse du Worker est saisie dans Réglages et gardée sur le téléphone ; les clés
// secrètes, elles, restent dans le Worker.

const KEY = 'worker_url';

export class BackendError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

export function getWorkerUrl() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

/** Accepte « mon-worker.xxx.workers.dev » ou l'adresse complète. */
export function setWorkerUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  if (u) localStorage.setItem(KEY, u); else localStorage.removeItem(KEY);
  return u;
}

export const isConfigured = () => !!getWorkerUrl();

async function call(path, { method = 'GET', body, params } = {}) {
  const base = getWorkerUrl();
  if (!base) throw new BackendError('Ajoute l\'adresse de ton serveur (Cloudflare Worker) dans Réglages.', 0);
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  let res;
  try {
    // text/plain : requête « simple », sans aller-retour CORS supplémentaire
    res = await fetch(url, { method, body, headers: body ? { 'Content-Type': 'text/plain' } : undefined });
  } catch {
    throw new BackendError(navigator.onLine === false ? 'Pas de connexion internet.' : 'Serveur (Worker) injoignable. Vérifie son adresse dans Réglages.', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* réponse vide */ }
  if (!res.ok) throw new BackendError(data?.error || `Erreur du serveur (${res.status}).`, res.status);
  return data;
}

/** État du Worker : { ok, igdb, ebay, tmdb } */
export const health = () => call('/health');

/** Requête IGDB (langage « apicalypse »). */
export const igdb = (endpoint, query) => call(`/igdb/${endpoint}`, { method: 'POST', body: query });

/** Annonces eBay.fr en cours. */
export const ebaySearch = ({ q, gtin, limit = 100 }) => call('/ebay/search', { params: { q, gtin, limit } });

/** Titres possibles d'un produit à partir de son code-barres. */
export const eanLookup = (code) => call(`/ean/${encodeURIComponent(String(code).replace(/\D/g, ''))}`);

/** TMDB (films / séries). path ex. 'search/movie'. */
export const tmdb = (path, params = {}) => call(`/tmdb/${path}`, { params: { language: 'fr-FR', ...params } });

export const tmdbImage = (path, size = 'w342') => (path ? `https://image.tmdb.org/t/p/${size}${path}` : '');

// ---------- Nettoyage d'un titre de produit (code-barres → recherche) ----------

const NOISE = [
  'dvd', 'blu ray', 'bluray', 'blu-ray', '4k', 'uhd', 'ultra hd', '3d', 'edition', 'collector', 'collectors', 'steelbook', 'limited',
  'limitee', 'speciale', 'special', 'definitive', 'neuf', 'new', 'sealed', 'sous blister', 'blister', 'vf', 'vost', 'vostfr', 'fr', 'francais',
  'version francaise', 'pal', 'zone 2', 'region 2', 'region b', 'import', 'coffret', 'box set', 'jeu', 'jeux', 'video game', 'game', 'videogame',
  'occasion', 'tres bon etat', 'bon etat', 'complet', 'notice', 'boite', 'cd', 'disque', 'film', 'movie', 'walt disney', 'disney',
  'classique', 'classiques', 'les grands classiques', 'pixar', 'integrale', 'digibook', 'combo', 'nintendo', 'sony', 'microsoft',
];

/** "Le Roi Lion [DVD] - Walt Disney - Neuf" → "Le Roi Lion" */
export function cleanProductTitle(title, extraNoise = []) {
  let t = ` ${String(title || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()} `;
  t = t.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[|/_,;:!?"«»]+/g, ' ').replace(/\s-\s/g, ' ');
  for (const w of [...extraNoise, ...NOISE].sort((a, b) => b.length - a.length)) {
    t = t.split(` ${w} `).join(' ');
  }
  return t.replace(/\s+/g, ' ').trim();
}

/** Versions de plus en plus courtes d'une requête (si la recherche complète ne donne rien). */
export function queryVariants(q) {
  const ws = String(q).split(/\s+/).filter(Boolean);
  const out = [ws.join(' ')];
  for (const n of [5, 4, 3, 2]) if (ws.length > n) out.push(ws.slice(0, n).join(' '));
  return [...new Set(out)].filter(Boolean);
}
