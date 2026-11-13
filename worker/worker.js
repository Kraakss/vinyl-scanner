// Vinyl Scanner — intermédiaire Cloudflare Worker (gratuit).
//
// Rôle : appeler pour l'appli les services qui refusent les appels directs
// depuis un navigateur, en gardant les clés secrètes ICI (jamais dans l'appli).
//
//   GET  /health                 → quels services sont configurés
//   POST /igdb/<endpoint>        → IGDB (jeux vidéo), corps = requête IGDB
//   GET  /ebay/search?q=…&gtin=… → eBay.fr, annonces en cours (Browse API)
//   GET  /ean/<code>             → titre d'un produit à partir de son code-barres
//   GET  /tmdb/<chemin>?…        → TMDB (films, séries, affiches)
//
// Secrets à créer dans Cloudflare (Settings → Variables and Secrets) :
//   TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET   (IGDB)
//   EBAY_CLIENT_ID, EBAY_CLIENT_SECRET       (eBay, clés "Production")
//   TMDB_TOKEN                               (TMDB : "API Read Access Token" ou "API Key")
// Variable facultative :
//   ALLOWED_ORIGINS  (par défaut https://kraakss.github.io) — sites autorisés à utiliser ce Worker

const VERSION = 2;
const IGDB_ENDPOINTS = new Set(['games', 'platforms', 'covers', 'genres', 'search']);
const TMDB_PATHS = /^(search\/(movie|tv|multi)|movie\/\d+(\/release_dates)?|tv\/\d+|configuration)$/;

// Jetons d'accès gardés en mémoire (renouvelés automatiquement)
const tokens = { twitch: null, twitchExp: 0, ebay: null, ebayExp: 0 };

class HttpError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

function corsHeaders(origin, allowed) {
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : allowed[0] || '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// ---------- Mise en cache (économise les quotas des services) ----------

async function cached(request, ttlSeconds, ctx, producer) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(request.url, { method: 'GET' });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit.json();
  }
  const data = await producer();
  if (cache) {
    const res = new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttlSeconds}` } });
    const put = cache.put(key, res);
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
  }
  return data;
}

// ---------- IGDB (via Twitch) ----------

async function twitchToken(env, force = false) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) throw new HttpError('IGDB non configuré dans le Worker (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET).', 503);
  if (!force && tokens.twitch && Date.now() < tokens.twitchExp) return tokens.twitch;
  const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(env.TWITCH_CLIENT_ID)}&client_secret=${encodeURIComponent(env.TWITCH_CLIENT_SECRET)}&grant_type=client_credentials`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) throw new HttpError(`Twitch refuse les identifiants IGDB (${res.status}). Vérifie TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET.`, 502);
  const data = await res.json();
  tokens.twitch = data.access_token;
  tokens.twitchExp = Date.now() + Math.max(60, (data.expires_in || 3600) - 300) * 1000;
  return tokens.twitch;
}

async function igdb(endpoint, body, env) {
  if (!IGDB_ENDPOINTS.has(endpoint)) throw new HttpError('Requête IGDB non autorisée.', 400);
  if (!body || body.length > 4000) throw new HttpError('Requête IGDB invalide.', 400);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await twitchToken(env, attempt > 0);
    const res = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
      method: 'POST',
      headers: { 'Client-ID': env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'text/plain' },
      body,
    });
    if (res.status === 401 && attempt === 0) continue; // jeton expiré : on en redemande un
    if (res.status === 429) throw new HttpError('IGDB : trop de requêtes, réessaie dans quelques secondes.', 429);
    if (!res.ok) throw new HttpError(`IGDB a répondu ${res.status}.`, 502);
    return res.json();
  }
  throw new HttpError('IGDB refuse l\'accès.', 502);
}

// ---------- eBay (Browse API, eBay.fr) ----------

async function ebayToken(env) {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) throw new HttpError('eBay non configuré dans le Worker (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET).', 503);
  if (tokens.ebay && Date.now() < tokens.ebayExp) return tokens.ebay;
  const basic = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  if (!res.ok) throw new HttpError(`eBay refuse les identifiants (${res.status}). Vérifie EBAY_CLIENT_ID et EBAY_CLIENT_SECRET (clés « Production »).`, 502);
  const data = await res.json();
  tokens.ebay = data.access_token;
  tokens.ebayExp = Date.now() + Math.max(60, (data.expires_in || 7200) - 300) * 1000;
  return tokens.ebay;
}

function trimEbayItem(it) {
  return {
    title: it.title || '',
    price: it.price ? Number(it.price.value) : null,
    currency: it.price?.currency || '',
    shipping: it.shippingOptions?.[0]?.shippingCost ? Number(it.shippingOptions[0].shippingCost.value) : null,
    condition: it.condition || '',
    conditionId: it.conditionId || '',
    buyingOptions: it.buyingOptions || [],
    url: it.itemWebUrl || '',
    image: it.image?.imageUrl || '',
  };
}

async function ebaySearch({ q, gtin, limit }, env) {
  const token = await ebayToken(env);
  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  if (q) url.searchParams.set('q', q.slice(0, 300));
  if (gtin) url.searchParams.set('gtin', gtin);
  url.searchParams.set('limit', String(Math.min(200, Math.max(1, Number(limit) || 100))));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_FR', 'Accept-Language': 'fr-FR', Accept: 'application/json' },
  });
  if (res.status === 401) { tokens.ebay = null; throw new HttpError('eBay : jeton refusé, réessaie.', 502); }
  if (res.status === 429) throw new HttpError('eBay : quota du jour atteint.', 429);
  if (!res.ok) throw new HttpError(`eBay a répondu ${res.status}.`, 502);
  const data = await res.json();
  return { total: data.total || 0, items: (data.itemSummaries || []).map(trimEbayItem), fetchedAt: new Date().toISOString() };
}

// ---------- Code-barres → titre du produit ----------

async function eanLookup(code, env) {
  const titles = [];
  const add = (title, source) => {
    const t = String(title || '').trim();
    if (t && !titles.some((x) => x.title.toLowerCase() === t.toLowerCase())) titles.push({ title: t, source });
  };
  try {
    const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`, {
      headers: { Accept: 'application/json', 'User-Agent': `VinylScanner/${VERSION}` },
    });
    if (res.ok) {
      const data = await res.json();
      (data.items || []).forEach((it) => add(it.title, 'UPCitemdb'));
    }
  } catch { /* service indisponible : on essaie eBay */ }
  if (titles.length < 3 && env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) {
    try {
      const r = await ebaySearch({ gtin: code, limit: 20 }, env);
      r.items.forEach((it) => add(it.title, 'eBay'));
    } catch { /* rien */ }
  }
  return { code, titles: titles.slice(0, 10) };
}

// ---------- TMDB ----------

async function tmdb(path, searchParams, env) {
  if (!env.TMDB_TOKEN) throw new HttpError('TMDB non configuré dans le Worker (TMDB_TOKEN).', 503);
  if (!TMDB_PATHS.test(path)) throw new HttpError('Requête TMDB non autorisée.', 400);
  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  for (const [k, v] of searchParams) if (k !== 'api_key') url.searchParams.set(k, v);
  const headers = { Accept: 'application/json' };
  const t = env.TMDB_TOKEN.trim();
  if (t.length > 40) headers.Authorization = `Bearer ${t}`; // "API Read Access Token"
  else url.searchParams.set('api_key', t); // "API Key" (courte)
  const res = await fetch(url, { headers });
  if (res.status === 401) throw new HttpError('TMDB refuse la clé (TMDB_TOKEN).', 502);
  if (res.status === 404) throw new HttpError('Introuvable sur TMDB.', 404);
  if (!res.ok) throw new HttpError(`TMDB a répondu ${res.status}.`, 502);
  return res.json();
}

// ---------- Point d'entrée ----------

export default {
  async fetch(request, env = {}, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || 'https://kraakss.github.io').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = corsHeaders(origin, allowed);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Vérification ouverte (utile pour tester le Worker dans le navigateur)
    if (path === '/' || path === '/health') {
      return json({
        ok: true, version: VERSION,
        igdb: !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET),
        ebay: !!(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET),
        tmdb: !!env.TMDB_TOKEN,
      }, 200, cors);
    }

    // Le reste n'est accessible qu'à l'appli (site autorisé)
    if (!allowed.includes('*') && !allowed.includes(origin)) {
      return json({ error: 'Site non autorisé à utiliser ce Worker (ALLOWED_ORIGINS).' }, 403, cors);
    }

    try {
      let m;
      if ((m = path.match(/^\/igdb\/([a-z_]+)$/)) && request.method === 'POST') {
        const body = await request.text();
        return json(await igdb(m[1], body, env), 200, cors);
      }
      if (path === '/ebay/search' && request.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        const gtin = (url.searchParams.get('gtin') || '').replace(/\D/g, '');
        if (!q && !gtin) throw new HttpError('Paramètre q ou gtin requis.', 400);
        const data = await cached(request, 6 * 3600, ctx, () => ebaySearch({ q, gtin, limit: url.searchParams.get('limit') }, env));
        return json(data, 200, cors);
      }
      if ((m = path.match(/^\/ean\/(\d{8,14})$/)) && request.method === 'GET') {
        const data = await cached(request, 30 * 86400, ctx, () => eanLookup(m[1], env));
        return json(data, 200, cors);
      }
      if ((m = path.match(/^\/tmdb\/(.+)$/)) && request.method === 'GET') {
        const data = await cached(request, 7 * 86400, ctx, () => tmdb(m[1], url.searchParams, env));
        return json(data, 200, cors);
      }
      return json({ error: 'Adresse inconnue.' }, 404, cors);
    } catch (e) {
      return json({ error: e.message || 'Erreur du Worker.' }, e.status || 502, cors);
    }
  },
};
