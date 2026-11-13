// Priorité aux versions françaises / européennes, dans toutes les collections.

// ---------- Filtre « France / Europe uniquement » (un par collection, activé par défaut) ----------

const KEY = (section) => `region_filter_${section}`;
export function regionFilterOn(section) {
  try { return localStorage.getItem(KEY(section)) !== 'off'; } catch { return true; }
}
export function setRegionFilter(section, on) {
  try { localStorage.setItem(KEY(section), on ? 'on' : 'off'); } catch { /* rien */ }
}

/** Interrupteur affiché au-dessus des résultats. hidden = nombre de résultats masqués. */
export function regionToggleHtml(section, on, hidden = 0) {
  return `<div class="region-bar">
    <button type="button" class="chip-toggle${on ? ' on' : ''}" data-region-toggle="${section}" aria-pressed="${on}">
      <span class="flag" aria-hidden="true"></span>France / Europe uniquement</button>
    ${on && hidden ? `<span class="help">${hidden} version${hidden > 1 ? 's' : ''} hors Europe masquée${hidden > 1 ? 's' : ''}</span>` : ''}
  </div>`;
}

// ---------- Pays européens ----------

/** Codes pays ISO (TMDB : dates de sortie par pays). */
export const EU_ISO = new Set(['FR', 'BE', 'CH', 'LU', 'MC', 'DE', 'AT', 'IT', 'ES', 'PT', 'NL', 'GB', 'IE', 'DK', 'SE', 'NO', 'FI',
  'IS', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR', 'HR', 'SI', 'EE', 'LV', 'LT', 'CY', 'MT', 'RS', 'BA', 'ME', 'MK', 'AL', 'AD', 'LI', 'SM']);

/** Noms de pays tels qu'écrits par Discogs. */
const DISCOGS_EU = ['france', 'europe', 'uk', 'united kingdom', 'england', 'scotland', 'wales', 'germany', 'west germany', 'east germany',
  'german democratic republic', 'belgium', 'netherlands', 'benelux', 'italy', 'spain', 'portugal', 'switzerland', 'austria', 'sweden',
  'norway', 'denmark', 'finland', 'scandinavia', 'greece', 'ireland', 'poland', 'czech republic', 'czechoslovakia', 'slovakia', 'hungary',
  'romania', 'bulgaria', 'yugoslavia', 'croatia', 'slovenia', 'serbia', 'luxembourg', 'monaco', 'iceland', 'estonia', 'latvia',
  'lithuania', 'malta', 'cyprus', 'andorra'];

/**
 * Rang d'un pays de pressage Discogs : 0 = France, 1 = Europe, 2 = inconnu, 3 = hors Europe.
 * « France & Benelux » → 0 ; « UK & Europe » → 1 ; « US » → 3.
 */
export function discogsCountryRank(country) {
  const c = ` ${String(country || '').toLowerCase().replace(/[^a-z]+/g, ' ')} `;
  if (!c.trim()) return 2;
  if (c.includes(' france ')) return 0;
  return DISCOGS_EU.some((n) => c.includes(` ${n} `)) ? 1 : 3;
}

// ---------- Pays d'origine d'un code-barres (préfixe GS1) ----------

// [début, fin, pays, européen]
const GS1 = [
  [0, 19, 'États-Unis / Canada', false], [30, 39, 'États-Unis', false], [60, 139, 'États-Unis / Canada', false],
  [300, 379, 'France', true], [380, 380, 'Bulgarie', true], [383, 383, 'Slovénie', true], [385, 385, 'Croatie', true], [387, 387, 'Bosnie', true],
  [389, 389, 'Monténégro', true], [400, 440, 'Allemagne', true], [450, 459, 'Japon', false], [460, 469, 'Russie', false],
  [471, 471, 'Taïwan', false], [474, 474, 'Estonie', true], [475, 475, 'Lettonie', true], [477, 477, 'Lituanie', true],
  [480, 480, 'Philippines', false], [489, 489, 'Hong Kong', false], [490, 499, 'Japon', false], [500, 509, 'Royaume-Uni', true],
  [520, 521, 'Grèce', true], [529, 529, 'Chypre', true], [531, 531, 'Macédoine du Nord', true], [535, 535, 'Malte', true],
  [539, 539, 'Irlande', true], [540, 549, 'Belgique / Luxembourg', true], [560, 560, 'Portugal', true], [569, 569, 'Islande', true],
  [570, 579, 'Danemark', true], [590, 590, 'Pologne', true], [594, 594, 'Roumanie', true], [599, 599, 'Hongrie', true],
  [600, 601, 'Afrique du Sud', false], [640, 649, 'Finlande', true], [690, 699, 'Chine', false], [700, 709, 'Norvège', true],
  [729, 729, 'Israël', false], [730, 739, 'Suède', true], [750, 750, 'Mexique', false], [754, 755, 'Canada', false],
  [760, 769, 'Suisse', true], [779, 779, 'Argentine', false], [789, 790, 'Brésil', false], [800, 839, 'Italie', true],
  [840, 849, 'Espagne', true], [858, 858, 'Slovaquie', true], [859, 859, 'Tchéquie', true], [860, 860, 'Serbie', true],
  [868, 869, 'Turquie', false], [870, 879, 'Pays-Bas', true], [880, 880, 'Corée du Sud', false], [885, 885, 'Thaïlande', false],
  [888, 888, 'Singapour', false], [890, 890, 'Inde', false], [900, 919, 'Autriche', true], [930, 939, 'Australie', false],
  [940, 949, 'Nouvelle-Zélande', false], [955, 955, 'Malaisie', false],
];

/** Pays d'enregistrement d'un code EAN/UPC (indice d'import), ou null si inconnu. */
export function eanOrigin(code) {
  let digits = String(code || '').replace(/\D/g, '');
  if (digits.length === 12) digits = `0${digits}`; // UPC-A = EAN-13 commençant par 0
  if (digits.length !== 13) return null;
  const p = Number(digits.slice(0, 3));
  const hit = GS1.find(([a, b]) => p >= a && p <= b);
  return hit ? { country: hit[2], european: hit[3] } : null;
}

/** Message d'avertissement si le code-barres vient de hors d'Europe (null sinon). */
export function importWarning(code) {
  const o = eanOrigin(code);
  return o && !o.european ? `Code-barres enregistré hors d'Europe (${o.country}) : probablement une édition importée.` : null;
}
