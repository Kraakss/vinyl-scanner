// Jeux vidéo : plateformes + estimation de prix à partir des annonces eBay.fr en cours.
// Fonctions "pures" (sans réseau) : faciles à tester et à ajuster.

export const normalize = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (s) => normalize(s).replace(/[^a-z0-9]+/g, ' ').trim();

// key : identifiant interne · igdb : noms IGDB acceptés · ebay : mot ajouté à la recherche eBay
// kw : façons dont la plateforme est écrite dans les annonces (du plus précis au plus général)
export const PLATFORMS = [
  { key: 'ps5', name: 'PlayStation 5', igdb: ['PlayStation 5'], ebay: 'PS5', kw: ['ps5', 'playstation 5'] },
  { key: 'ps4', name: 'PlayStation 4', igdb: ['PlayStation 4'], ebay: 'PS4', kw: ['ps4', 'playstation 4'] },
  { key: 'ps3', name: 'PlayStation 3', igdb: ['PlayStation 3'], ebay: 'PS3', kw: ['ps3', 'playstation 3'] },
  { key: 'ps2', name: 'PlayStation 2', igdb: ['PlayStation 2'], ebay: 'PS2', kw: ['ps2', 'playstation 2'] },
  { key: 'ps1', name: 'PlayStation (PS1)', igdb: ['PlayStation'], ebay: 'PS1', kw: ['ps1', 'psx', 'psone', 'ps one', 'playstation 1'] },
  { key: 'psp', name: 'PSP', igdb: ['PlayStation Portable'], ebay: 'PSP', kw: ['psp'] },
  { key: 'vita', name: 'PS Vita', igdb: ['PlayStation Vita'], ebay: 'PS Vita', kw: ['ps vita', 'psvita', 'vita'] },
  { key: 'switch2', name: 'Nintendo Switch 2', igdb: ['Nintendo Switch 2'], ebay: 'Switch 2', kw: ['switch 2', 'switch2'] },
  { key: 'switch', name: 'Nintendo Switch', igdb: ['Nintendo Switch'], ebay: 'Switch', kw: ['switch'] },
  { key: 'wiiu', name: 'Wii U', igdb: ['Wii U'], ebay: 'Wii U', kw: ['wii u', 'wiiu'] },
  { key: 'wii', name: 'Wii', igdb: ['Wii'], ebay: 'Wii', kw: ['wii'] },
  { key: 'gc', name: 'GameCube', igdb: ['Nintendo GameCube'], ebay: 'GameCube', kw: ['gamecube', 'game cube', 'ngc'] },
  { key: 'n64', name: 'Nintendo 64', igdb: ['Nintendo 64'], ebay: 'N64', kw: ['nintendo 64', 'n64'] },
  { key: 'snes', name: 'Super Nintendo', igdb: ['Super Nintendo Entertainment System', 'Super Famicom'], ebay: 'Super Nintendo', kw: ['super nintendo', 'super nes', 'snes', 'super famicom'] },
  { key: 'nes', name: 'NES', igdb: ['Nintendo Entertainment System', 'Family Computer'], ebay: 'NES', kw: ['nes', 'famicom'] },
  { key: '3ds', name: 'Nintendo 3DS', igdb: ['Nintendo 3DS', 'New Nintendo 3DS'], ebay: '3DS', kw: ['3ds', '2ds'] },
  { key: 'ds', name: 'Nintendo DS', igdb: ['Nintendo DS'], ebay: 'DS', kw: ['nintendo ds', 'nds', 'ds'] },
  { key: 'gba', name: 'Game Boy Advance', igdb: ['Game Boy Advance'], ebay: 'Game Boy Advance', kw: ['game boy advance', 'gameboy advance', 'gba'] },
  { key: 'gbc', name: 'Game Boy Color', igdb: ['Game Boy Color'], ebay: 'Game Boy Color', kw: ['game boy color', 'gameboy color', 'gbc'] },
  { key: 'gb', name: 'Game Boy', igdb: ['Game Boy'], ebay: 'Game Boy', kw: ['game boy', 'gameboy'] },
  { key: 'xsx', name: 'Xbox Series X|S', igdb: ['Xbox Series X|S'], ebay: 'Xbox Series X', kw: ['xbox series', 'series x', 'series s'] },
  { key: 'xone', name: 'Xbox One', igdb: ['Xbox One'], ebay: 'Xbox One', kw: ['xbox one'] },
  { key: 'x360', name: 'Xbox 360', igdb: ['Xbox 360'], ebay: 'Xbox 360', kw: ['xbox 360', 'x360'] },
  { key: 'xbox', name: 'Xbox (1re génération)', igdb: ['Xbox'], ebay: 'Xbox', kw: ['xbox'] },
  { key: 'dc', name: 'Dreamcast', igdb: ['Dreamcast'], ebay: 'Dreamcast', kw: ['dreamcast'] },
  { key: 'saturn', name: 'Saturn', igdb: ['Sega Saturn'], ebay: 'Saturn', kw: ['saturn'] },
  { key: 'md', name: 'Mega Drive', igdb: ['Sega Mega Drive/Genesis'], ebay: 'Mega Drive', kw: ['mega drive', 'megadrive', 'genesis'] },
  { key: 'ms', name: 'Master System', igdb: ['Sega Master System/Mark III'], ebay: 'Master System', kw: ['master system'] },
  { key: 'gg', name: 'Game Gear', igdb: ['Sega Game Gear'], ebay: 'Game Gear', kw: ['game gear'] },
  { key: 'pc', name: 'PC', igdb: ['PC (Microsoft Windows)', 'DOS'], ebay: 'PC', kw: ['pc', 'windows', 'cd rom'] },
];
export const platformByKey = (key) => PLATFORMS.find((p) => p.key === key) || null;

/** La plateforme IGDB (nom) correspond-elle à notre plateforme ? */
export const igdbMatches = (platform, igdbName) => platform.igdb.some((n) => normalize(n) === normalize(igdbName));

/** Plateformes citées dans un texte (« Switch 2 » ne compte pas comme « Switch », etc.). */
export function detectPlatforms(text) {
  let t = ` ${words(text)} `;
  const found = [];
  const all = PLATFORMS.flatMap((p) => p.kw.map((kw) => ({ p, kw }))).sort((a, b) => b.kw.length - a.kw.length);
  for (const { p, kw } of all) {
    const pat = ` ${kw} `;
    if (t.includes(pat)) {
      if (!found.includes(p.key)) found.push(p.key);
      t = t.split(pat).join(' '); // on retire pour ne pas compter aussi la version courte
    }
  }
  return found;
}

// ---------- Filtrage des annonces ----------

const STOP = new Set(['le', 'la', 'les', 'l', 'un', 'une', 'des', 'de', 'du', 'd', 'et', 'the', 'of', 'a', 'an', 'and', 'to', 'in', 'on', 'for', 'edition', 'version']);

const LOT = /\b(lot|lots|bundle|pack de|packs|collection de|\d+\s?jeux|plusieurs jeux|x\s?\d{1,2})\b/;
const NOT_A_GAME = [
  'boite vide', 'boitier vide', 'boitier seul', 'boite seule', 'jaquette seule', 'jaquette de remplacement', 'jaquette custom',
  'notice seule', 'manuel seul', 'notice uniquement', 'sans jeu', 'sans le jeu', 'case only', 'empty case', 'empty box',
  'cover only', 'manette', 'controller', 'console', 'chargeur', 'cable', 'housse', 'sacoche', 'support', 'skin', 'sticker',
  'figurine', 'amiibo', 'carte memoire', 'memory card', 'code', 'dlc', 'dematerialise', 'telechargement', 'guide', 'soluce',
  'strategy guide', 'artbook', 'art book', 'poster', 'affiche', 't shirt', 'tee shirt', 'goodies', 'steelbook seul', 'ost',
  'bande originale', 'vinyle', 'precommande', 'pre commande', 'preorder', 'reproduction', 'repro', 'pochette', 'etui',
];
const FOREIGN = /\b(ntsc|ntsc j|ntsc u|jap|japon|japan|japonais|import us|import jap|usa|us version|asian|asie)\b/;
const NEW = /\b(neuf|blister|sous blister|scelle|sealed|new|sous film|jamais ouvert)\b/;
const LOOSE = /\b(loose|sans boite|cartouche seule|cartridge only|disque seul|cd seul|jeu seul|cartouche nue|sans boitier)\b/;

function titleTokens(title) {
  return words(title).split(' ').filter((w) => w && !STOP.has(w));
}

/**
 * Classe une annonce : renvoie { ok, reason, bucket } avec bucket = 'new' | 'loose' | 'complete'.
 */
export function classifyListing(listing, { title, platformKey, region = 'PAL' }) {
  const t = ` ${words(listing.title)} `;
  const gameWords = new Set(titleTokens(title));
  if (listing.currency && listing.currency !== 'EUR') return { ok: false, reason: 'devise' };
  if (typeof listing.price !== 'number' || !(listing.price > 0)) return { ok: false, reason: 'prix' };
  if (LOT.test(t) && !LOT.test(` ${words(title)} `)) return { ok: false, reason: 'lot' };
  const notGame = NOT_A_GAME.find((kw) => t.includes(` ${kw} `) && !kw.split(' ').every((w) => gameWords.has(w)));
  if (notGame) return { ok: false, reason: 'hors sujet', detail: notGame };
  if (region === 'PAL' && FOREIGN.test(t)) return { ok: false, reason: 'région' };

  // Plateforme : l'annonce ne doit pas viser une autre console
  const plats = detectPlatforms(listing.title);
  if (plats.length && !plats.includes(platformKey)) return { ok: false, reason: 'autre plateforme' };

  // Pertinence : les mots du titre doivent être présents (tous les nombres, et 70 % des mots)
  const toks = [...gameWords];
  const nums = toks.filter((w) => /^\d+$/.test(w));
  if (nums.some((n) => !t.includes(` ${n} `))) return { ok: false, reason: 'autre jeu' };
  const wordsOnly = toks.filter((w) => !/^\d+$/.test(w));
  if (wordsOnly.length) {
    const present = wordsOnly.filter((w) => t.includes(` ${w} `)).length;
    if (present / wordsOnly.length < 0.7) return { ok: false, reason: 'autre jeu' };
  }
  // Une suite (« 2 », « II ») présente dans l'annonce mais pas dans le titre = autre jeu
  const gameHasNum = nums.length > 0;
  if (!gameHasNum) {
    const titleRe = new RegExp(` ${wordsOnly.slice(-1)[0] || '#'} (\\d{1,2}|ii|iii|iv) `);
    if (titleRe.test(t)) return { ok: false, reason: 'autre jeu' };
  }

  const newWordInTitle = [...gameWords].some((w) => ['new', 'neuf'].includes(w));
  const isNew = listing.conditionId === '1000' || (!newWordInTitle && NEW.test(t));
  const bucket = LOOSE.test(t) ? 'loose' : isNew ? 'new' : 'complete';
  return { ok: true, bucket };
}

// ---------- Statistiques ----------

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const round2 = (n) => (n === null ? null : Math.round(n * 100) / 100);

/** Retire les valeurs aberrantes (méthode des quartiles + garde-fou ×3 / ÷3 autour de la médiane). */
export function removeOutliers(prices) {
  const s = [...prices].sort((a, b) => a - b);
  if (s.length < 4) return s;
  const q1 = quantile(s, 0.25);
  const q3 = quantile(s, 0.75);
  const iqr = q3 - q1;
  const med = quantile(s, 0.5);
  return s.filter((p) => p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr && p >= med / 3 && p <= med * 3);
}

function summarize(prices) {
  const kept = removeOutliers(prices);
  if (!kept.length) return null;
  return {
    median: round2(quantile(kept, 0.5)),
    low: round2(quantile(kept, 0.25)),
    high: round2(quantile(kept, 0.75)),
    min: round2(kept[0]),
    max: round2(kept[kept.length - 1]),
    count: kept.length,
    outliers: prices.length - kept.length,
  };
}

export const COMPLETENESS = {
  complet: 'Complet (boîte + notice)',
  'sans-notice': 'Boîte sans notice',
  loose: 'Loose (jeu seul)',
  neuf: 'Neuf sous blister',
};

/**
 * Estimation à partir des annonces eBay.
 * completeness : 'complet' | 'sans-notice' | 'loose' | 'neuf' (choisit le groupe d'annonces de référence).
 */
export function estimatePrice(listings, { title, platformKey, region = 'PAL', completeness = 'complet' }) {
  const groups = { complete: [], loose: [], new: [] };
  const excluded = {};
  for (const l of listings) {
    const c = classifyListing(l, { title, platformKey, region });
    if (!c.ok) { excluded[c.reason] = (excluded[c.reason] || 0) + 1; continue; }
    groups[c.bucket].push(l.price);
  }
  const buckets = { complete: summarize(groups.complete), loose: summarize(groups.loose), new: summarize(groups.new) };
  const used = summarize([...groups.complete, ...groups.loose]);
  const all = summarize([...groups.complete, ...groups.loose, ...groups.new]);

  const wanted = completeness === 'neuf' ? 'new' : completeness === 'loose' ? 'loose' : 'complete';
  let basis = wanted;
  let chosen = buckets[wanted];
  if (!chosen || chosen.count < 3) {
    if (wanted !== 'new' && used && used.count >= 3) { chosen = used; basis = 'used'; }
    else if (all) { chosen = all; basis = 'all'; }
  }
  return {
    ok: !!chosen,
    median: chosen?.median ?? null,
    low: chosen?.low ?? null,
    high: chosen?.high ?? null,
    count: chosen?.count ?? 0,
    basis, // groupe d'annonces utilisé
    buckets,
    considered: listings.length,
    excluded,
  };
}

export const BASIS_LABELS = {
  complete: 'annonces « complet »',
  loose: 'annonces « loose »',
  new: 'annonces « neuf »',
  used: 'annonces d\'occasion (complet + loose)',
  all: 'toutes les annonces retenues',
};

/** Requête eBay : titre + plateforme. */
export function ebayQuery(title, platformKey) {
  const p = platformByKey(platformKey);
  return `${String(title).replace(/[:™®©]/g, ' ').replace(/\s+/g, ' ').trim()} ${p ? p.ebay : ''}`.trim();
}
