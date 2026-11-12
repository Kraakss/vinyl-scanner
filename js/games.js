// Collection « Jeux vidéo » : infos et jaquettes IGDB, estimation de prix eBay.fr.

import * as backend from './core/backend.js';
import * as db from './db.js';
import { createJob } from './core/job.js';
import { createMediaSection } from './core/media.js';
import { esc, money, num, dateFr, dateTimeFr, deltaHtml, thumbHtml, hbarsHtml, tilesHtml, simplify, toCsv, frNumber } from './core/ui.js';
import {
  PLATFORMS, platformByKey, igdbMatches, detectPlatforms, estimatePrice, ebayQuery, COMPLETENESS, BASIS_LABELS,
} from './games-pricing.js';

const cover = (imageId, size = 't_cover_big') => (imageId ? `https://images.igdb.com/igdb/image/upload/${size}/${imageId}.jpg` : '');
const yearOf = (ts) => (ts ? new Date(ts * 1000).getUTCFullYear() : null);
const igdbString = (s) => String(s).replace(/["\\]/g, ' ').trim();

const PLATFORM_OPTIONS = PLATFORMS.map((p) => [p.key, p.name]);
const CONDITIONS = [['', 'Non renseigné'], ['neuf', 'Neuf'], ['tres-bon', 'Très bon'], ['bon', 'Bon'], ['moyen', 'Moyen'], ['abime', 'Abîmé']];
const REGIONS = [['PAL', 'PAL (Europe)'], ['PAL-FR', 'PAL FR'], ['NTSC-U', 'NTSC-U (USA)'], ['NTSC-J', 'NTSC-J (Japon)'], ['autre', 'Autre']];
const conditionLabel = (v) => (CONDITIONS.find(([k]) => k === v) || [, ''])[1];

const LAST_PLATFORM = 'games_last_platform';
const lastPlatform = () => { try { return localStorage.getItem(LAST_PLATFORM) || ''; } catch { return ''; } };
const rememberPlatform = (p) => { try { if (p) localStorage.setItem(LAST_PLATFORM, p); } catch { /* rien */ } };

function platformSelect(name, selected, { required = true, autoLabel = '' } = {}) {
  return `<select name="${name}" ${required ? 'required' : ''}>
    <option value="">${esc(autoLabel || 'Choisis la plateforme…')}</option>
    ${PLATFORM_OPTIONS.map(([k, l]) => `<option value="${k}"${k === selected ? ' selected' : ''}>${esc(l)}</option>`).join('')}
  </select>`;
}

// ---------- Prix ----------

async function fetchPrice(item) {
  const q = ebayQuery(item.title, item.platform);
  const res = await backend.ebaySearch({ q, limit: 150 });
  const region = !item.collection?.region || item.collection.region.startsWith('PAL') ? 'PAL' : 'other';
  const est = estimatePrice(res.items || [], { title: item.title, platformKey: item.platform, region, completeness: item.collection?.completeness || 'complet' });
  return { ...est, query: q, totalListings: res.total || 0, fetchedAt: Date.now() };
}

function setValue(x, newValue, source) {
  const now = Date.now();
  x.valueInfo = { previous: x.estimatedValue ?? null, previousAt: x.valueInfo?.updatedAt ?? null, updatedAt: now, source };
  x.estimatedValue = newValue;
}

function applyPrice(x, price) {
  x.price = price;
  if (typeof x.manualValue === 'number') return x; // la valeur corrigée à la main reste prioritaire
  if (price.ok && typeof price.median === 'number') setValue(x, price.median, 'ebay');
  return x;
}

function applyManualValue(x, value) {
  x.manualValue = value;
  const v = value ?? (x.price?.ok ? x.price.median : null);
  if (v !== (x.estimatedValue ?? null)) setValue(x, v, value === null ? 'ebay' : 'manuel');
  return x;
}

function priceHtml(item) {
  const p = item.price;
  const manual = typeof item.manualValue === 'number';
  const v = typeof item.estimatedValue === 'number' ? item.estimatedValue : null;
  const prev = item.valueInfo?.previous;
  const delta = v !== null && typeof prev === 'number' ? Math.round((v - prev) * 100) / 100 : null;
  const buckets = p?.buckets ? [['complete', 'Complet'], ['loose', 'Loose'], ['new', 'Neuf']]
    .filter(([k]) => p.buckets[k]).map(([k, l]) => `<tr><td>${l}</td><td>${money(p.buckets[k].median)} <span class="help">(${p.buckets[k].count})</span></td></tr>`).join('') : '';
  const excluded = p?.excluded ? Object.values(p.excluded).reduce((s, n) => s + n, 0) : 0;
  return `
    <h2>Estimation eBay</h2>
    <div class="price-main"><span class="value">${v !== null ? money(v) : '—'}</span>${deltaHtml(delta)}
      <span class="label">${manual ? 'valeur corrigée à la main' : p?.ok ? 'prix médian des annonces en cours' : p ? 'pas assez d\'annonces' : 'pas encore estimé'}</span></div>
    ${p?.ok ? `<p class="help">Fourchette habituelle : <b>${money(p.low)} – ${money(p.high)}</b> · ${num(p.count)} annonce${p.count > 1 ? 's' : ''} utilisée${p.count > 1 ? 's' : ''} (${esc(BASIS_LABELS[p.basis] || '')}) · eBay.fr, ${esc(dateTimeFr(p.fetchedAt))}</p>` : ''}
    ${p && !p.ok ? `<p class="help">Aucune annonce exploitable sur eBay.fr (${esc(dateTimeFr(p.fetchedAt))}). Tu peux saisir une valeur à la main.</p>` : ''}
    ${buckets ? `<table class="grades">${buckets}</table>` : ''}
    ${p ? `<p class="help">${num(p.considered)} annonces examinées${excluded ? `, ${num(excluded)} écartées (lots, accessoires, boîtes vides, autres plateformes, imports…)` : ''}. Prix demandés hors frais de port, pas des ventes conclues.</p>` : ''}
    <button class="btn ghost block" type="button" id="games-price-refresh">Actualiser le prix</button>
    <form class="row manual" id="games-manual-form" autocomplete="off">
      <input id="games-manual-value" inputmode="decimal" placeholder="Corriger la valeur (€)" value="${manual ? esc(String(item.manualValue).replace('.', ',')) : ''}" aria-label="Valeur corrigée à la main">
      <button class="btn ghost" type="submit">${manual ? 'Modifier' : 'Valider'}</button>
    </form>
    ${manual ? '<p class="help">Vide le champ et valide pour revenir à l\'estimation eBay.</p>' : ''}`;
}

// ---------- Tâche « Actualiser les prix » ----------

export const priceJob = createJob({
  key: 'games_price_job',
  msPerItem: 1500, // 40 requêtes / minute maximum
  listIds: async () => {
    const items = await db.getItems('game', { ownedOnly: true });
    items.sort((a, b) => (a.price?.fetchedAt || 0) - (b.price?.fetchedAt || 0));
    return items.map((i) => i.key);
  },
  processOne: async (key) => {
    const item = await db.getItem(key);
    if (!item || !item.inCollection) return;
    const price = await fetchPrice(item);
    await db.updateItem(key, (x) => (x ? applyPrice(x, price) : null));
  },
  // Pause si plus de réseau, quota atteint ou serveur non configuré ; on passe au suivant sinon
  isFatal: (e) => !e.status || [401, 403, 429, 503].includes(e.status),
});

// ---------- Configuration de la section ----------

const valueOf = (it) => (typeof it.estimatedValue === 'number' ? it.estimatedValue : null);
const nullsLast = (a, b, cmp) => (a === null || a === undefined ? (b === null || b === undefined ? 0 : 1) : b === null || b === undefined ? -1 : cmp(a, b));
const byTitle = (a, b) => (a.sortTitle || a.title || '').localeCompare(b.sortTitle || b.title || '', 'fr', { sensitivity: 'base', numeric: true });

export const games = createMediaSection({
  id: 'games',
  kind: 'game',
  label: 'Jeux vidéo',
  noun: 'jeu',
  nounPlural: 'jeux',
  collectionTitle: 'Mes jeux vidéo',
  priced: true,
  job: priceJob,
  defaultSort: 'title',
  searchPlaceholder: 'Rechercher : titre, plateforme, genre…',
  texts: { same: 'Vous avez déjà ce jeu (même plateforme)', album: 'Vous avez déjà ce jeu, mais sur une autre plateforme' },

  scanExtraHtml: () => `<label>Plateforme <span class="opt">(si le code ne l'indique pas)</span></label>${platformSelect('platform', lastPlatform(), { required: false, autoLabel: 'Détecter automatiquement' })}`,
  readScanExtra: (form) => ({ platform: form.elements.platform.value }),
  contextFromTitles: (titles, extra) => {
    const found = titles.flatMap((t) => detectPlatforms(t));
    return { platform: found[0] || extra.platform || '' };
  },
  cleanNoise: PLATFORMS.flatMap((p) => p.kw).concat(['playstation', 'xbox', 'nintendo switch', 'pal fr', 'pal']),

  searchFormHtml: () => `
    <label>Titre du jeu</label><input name="title" placeholder="ex. Mario Kart 8 Deluxe" required>
    <label>Plateforme</label>${platformSelect('platform', lastPlatform())}`,
  readSearchForm: (form) => ({ title: form.elements.title.value.trim(), platform: form.elements.platform.value }),
  fillSearchForm: (form, q) => { form.elements.title.value = q.title || ''; form.elements.platform.value = q.platform || ''; },
  onSearchView: (form) => { if (!form.elements.platform.value) form.elements.platform.value = lastPlatform(); },
  validateQuery: (q) => (!q.title ? 'Indique le titre du jeu.' : !q.platform ? 'Choisis la plateforme (PS4, Switch…).' : ''),
  queryLabel: (q) => ` sur ${platformByKey(q.platform)?.name || '?'}`,

  async search({ title, platform }) {
    rememberPlatform(platform);
    const data = await backend.igdb('games', `search "${igdbString(title)}"; fields name,first_release_date,cover.image_id,platforms.name; limit 40;`);
    const p = platformByKey(platform);
    const onPlatform = data.filter((g) => (g.platforms || []).some((pl) => igdbMatches(p, pl.name)));
    const list = onPlatform.length ? onPlatform : data;
    return {
      note: data.length && !onPlatform.length ? `Aucun jeu indiqué sur ${p.name} : voici tous les jeux trouvés.` : '',
      results: list.map((g) => ({
        sourceId: g.id,
        title: g.name,
        year: yearOf(g.first_release_date),
        thumb: cover(g.cover?.image_id, 't_cover_small'),
        subtitle: (g.platforms || []).map((pl) => pl.name).slice(0, 4).join(', '),
        meta: [yearOf(g.first_release_date)],
      })),
    };
  },

  keyFor: (sourceId, ctx) => `game-${sourceId}-${ctx.platform}`,
  resultHref: (r, q) => `#/games/item/${r.sourceId}/${q.platform}`,
  itemHref: (it) => `#/games/item/${it.sourceId}/${it.platform}`,
  ctxFromRoute: ([sid, platform]) => (/^\d+$/.test(sid || '') && platformByKey(platform) ? { sourceId: Number(sid), platform } : null),
  ctxFields: (ctx) => ({ platform: ctx.platform, platformName: platformByKey(ctx.platform).name }),

  async fetchDetails(id) {
    const [g] = await backend.igdb('games', `fields name,first_release_date,cover.image_id,platforms.name,genres.name,summary,url,involved_companies.company.name,involved_companies.developer,involved_companies.publisher; where id = ${Number(id)};`);
    if (!g) throw new Error('Jeu introuvable sur IGDB.');
    const companies = g.involved_companies || [];
    return {
      title: g.name,
      sortTitle: simplify(g.name),
      year: yearOf(g.first_release_date),
      coverUrl: cover(g.cover?.image_id, 't_cover_big'),
      thumbUrl: cover(g.cover?.image_id, 't_cover_small'),
      genres: (g.genres || []).map((x) => x.name),
      summary: g.summary || '',
      developers: companies.filter((c) => c.developer).map((c) => c.company?.name).filter(Boolean),
      publishers: companies.filter((c) => c.publisher).map((c) => c.company?.name).filter(Boolean),
      allPlatforms: (g.platforms || []).map((p) => p.name),
      igdbUrl: g.url || '',
    };
  },

  fields: [
    { name: 'completeness', label: 'Complet ou loose', type: 'select', options: Object.entries(COMPLETENESS), default: 'complet' },
    { name: 'condition', label: 'État', type: 'select', options: CONDITIONS, default: '' },
    { name: 'region', label: 'Région', type: 'select', options: REGIONS, default: 'PAL' },
  ],
  onFieldsChanged: (x) => { if (x.price) x.price.fetchedAt = 0; return x; }, // l'estimation sera recalculée

  heroKicker: (it) => [it.platformName, it.year].filter(Boolean).join(' · '),
  factsHtml: (it) => `
    <dt>Plateforme</dt><dd>${esc(it.platformName || '—')}</dd>
    <dt>Sortie</dt><dd>${esc(it.year || '—')}</dd>
    ${it.genres?.length ? `<dt>Genres</dt><dd><div class="tags">${it.genres.map((g) => `<span class="tag">${esc(g)}</span>`).join('')}</div></dd>` : ''}
    ${it.developers?.length ? `<dt>Développeur</dt><dd>${esc(it.developers.join(', '))}</dd>` : ''}
    ${it.publishers?.length ? `<dt>Éditeur</dt><dd>${esc(it.publishers.join(', '))}</dd>` : ''}
    ${it.barcodes?.length ? `<dt>Code-barres</dt><dd>${it.barcodes.map(esc).join('<br>')}</dd>` : ''}`,
  externalLink: (it) => it.igdbUrl || `https://www.igdb.com/search?type=1&q=${encodeURIComponent(it.title)}`,
  externalLabel: 'Voir sur IGDB',

  fetchPrice,
  applyPrice,
  applyManualValue,
  priceHtml,

  sameWork: (o, it) => o.sourceId === it.sourceId || (simplify(o.title) && simplify(o.title) === simplify(it.title)),
  otherLabel: (o) => [o.platformName, COMPLETENESS[o.collection?.completeness], o.collection?.region].filter(Boolean).join(' · '),

  subtitle: (it) => it.platformName || '',
  metaChips: (it) => [COMPLETENESS[it.collection?.completeness]?.split(' (')[0], conditionLabel(it.collection?.condition)].filter(Boolean),
  searchText: (it) => [it.title, it.platformName, ...(it.genres || []), ...(it.developers || []), ...(it.publishers || [])].join(' '),
  sorts: {
    title: { label: 'Titre A → Z', cmp: byTitle },
    'value-desc': { label: 'Valeur (décroissante)', cmp: (a, b) => nullsLast(valueOf(a), valueOf(b), (x, y) => y - x) || byTitle(a, b) },
    'value-asc': { label: 'Valeur (croissante)', cmp: (a, b) => nullsLast(valueOf(a), valueOf(b), (x, y) => x - y) || byTitle(a, b) },
    platform: { label: 'Plateforme', cmp: (a, b) => (a.platformName || '').localeCompare(b.platformName || '', 'fr') || byTitle(a, b) },
    'year-desc': { label: 'Année (plus récent)', cmp: (a, b) => nullsLast(a.year, b.year, (x, y) => y - x) || byTitle(a, b) },
    'year-asc': { label: 'Année (plus ancien)', cmp: (a, b) => nullsLast(a.year, b.year, (x, y) => x - y) || byTitle(a, b) },
    'added-desc': { label: 'Ajout (plus récent)', cmp: (a, b) => (b.collection?.addedAt || 0) - (a.collection?.addedAt || 0) },
  },
  filters: [
    { name: 'platform', label: 'Plateforme', all: 'Toutes les plateformes', get: (it) => it.platformName },
    { name: 'genre', label: 'Genre', all: 'Tous les genres', get: (it) => it.genres },
    { name: 'completeness', label: 'Complet / loose', all: 'Complet ou loose', get: (it) => it.collection?.completeness, format: (v) => COMPLETENESS[v] || v },
  ],

  statsHtml(items, { valueOf: val, qtyOf, valueDelta, job }) {
    const count = items.reduce((s, it) => s + qtyOf(it), 0);
    const valued = items.filter((it) => val(it) !== null);
    const total = valued.reduce((s, it) => s + val(it) * qtyOf(it), 0);
    const nValued = valued.reduce((s, it) => s + qtyOf(it), 0);
    const comparable = items.filter((it) => valueDelta(it) !== null);
    const totalDelta = comparable.length ? Math.round(comparable.reduce((s, it) => s + valueDelta(it) * qtyOf(it), 0) * 100) / 100 : null;
    const by = (fn) => {
      const m = new Map();
      items.forEach((it) => [].concat(fn(it) || 'Non renseigné').forEach((k) => m.set(k, (m.get(k) || 0) + qtyOf(it))));
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const top = valued.sort((a, b) => val(b) - val(a)).slice(0, 10);
    return `
      ${tilesHtml([
        { k: 'Jeux', v: num(count), s: `${num(items.length)} titres` },
        { k: 'Valeur totale', v: money(total), sHtml: totalDelta !== null ? `${deltaHtml(totalDelta)} vs avant` : 'estimée (eBay)' },
        { k: 'Valeur moyenne', v: nValued ? money(total / nValued) : '—', s: 'par jeu' },
        { k: 'Prix mis à jour', v: job?.lastCompletedAt ? dateFr(job.lastCompletedAt) : 'Jamais', small: true, s: nValued < count ? `${num(count - nValued)} sans prix` : 'tous ont un prix' },
      ])}
      ${top.length ? `<div class="card"><h2>Top 10 des plus chers</h2><ol class="top10">${top.map((it) => `<li><a href="#/games/item/${it.sourceId}/${it.platform}">
        ${thumbHtml(it.thumbUrl, 'thumb poster-thumb')}<span class="t"><div>${esc(it.title)}</div><div class="a">${esc(it.platformName)}</div></span>
        <span class="p">${money(val(it))}</span></a></li>`).join('')}</ol></div>` : ''}
      <div class="card"><h2>Par plateforme</h2>${hbarsHtml(by((it) => it.platformName))}</div>
      <div class="card"><h2>Par genre</h2>${hbarsHtml(by((it) => (it.genres?.length ? it.genres : null)))}<p class="help">Un jeu peut avoir plusieurs genres.</p></div>`;
  },
});

export function gamesCsv(items) {
  return toCsv([
    ['Titre', (it) => it.title], ['Plateforme', (it) => it.platformName], ['Année', (it) => it.year || ''],
    ['Complet / loose', (it) => COMPLETENESS[it.collection?.completeness] || ''], ['État', (it) => conditionLabel(it.collection?.condition)],
    ['Région', (it) => it.collection?.region || ''], ['Quantité', (it) => it.collection?.quantity || 1], ['Note', (it) => it.collection?.notes || ''],
    ['Valeur estimée (€)', (it) => frNumber(it.estimatedValue)], ['Valeur corrigée à la main', (it) => (typeof it.manualValue === 'number' ? 'oui' : '')],
    ['Médiane eBay (€)', (it) => frNumber(it.price?.median)], ['Fourchette basse (€)', (it) => frNumber(it.price?.low)], ['Fourchette haute (€)', (it) => frNumber(it.price?.high)],
    ['Annonces utilisées', (it) => it.price?.count ?? ''], ['Prix du', (it) => (it.price?.fetchedAt ? dateTimeFr(it.price.fetchedAt) : '')],
    ['Genres', (it) => (it.genres || []).join(', ')], ['Développeur', (it) => (it.developers || []).join(', ')], ['Éditeur', (it) => (it.publishers || []).join(', ')],
    ['Codes-barres', (it) => (it.barcodes || []).join(' ')], ['Ajouté le', (it) => dateFr(it.collection?.addedAt)], ['IGDB', (it) => it.igdbUrl || ''],
  ], items);
}
