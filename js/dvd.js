// Collection « DVD » (et Blu-ray) : infos et affiches TMDB, sans estimation de prix.

import * as backend from './core/backend.js';
import { createMediaSection } from './core/media.js';
import { esc, num, dateFr, thumbHtml, hbarsHtml, vbarsHtml, tilesHtml, simplify, toCsv } from './core/ui.js';

const FORMATS = [['DVD', 'DVD'], ['Blu-ray', 'Blu-ray'], ['Blu-ray 4K', 'Blu-ray 4K Ultra HD'], ['Blu-ray 3D', 'Blu-ray 3D'], ['VHS', 'VHS'], ['Autre', 'Autre']];
const CONDITIONS = [['', 'Non renseigné'], ['neuf', 'Neuf (sous blister)'], ['tres-bon', 'Très bon'], ['bon', 'Bon'], ['moyen', 'Moyen'], ['abime', 'Abîmé']];
const conditionLabel = (v) => (CONDITIONS.find(([k]) => k === v) || [, ''])[1];
const yearOf = (d) => (d ? Number(String(d).slice(0, 4)) || null : null);

/** Format probable d'après le titre trouvé par le code-barres. */
export function detectFormat(text) {
  const t = simplify(text);
  if (/\b(4k|uhd|ultra hd)\b/.test(t)) return 'Blu-ray 4K';
  if (/\b3d\b/.test(t) && /blu ?ray/.test(t)) return 'Blu-ray 3D';
  if (/blu ?ray/.test(t)) return 'Blu-ray';
  if (/\bvhs\b/.test(t)) return 'VHS';
  return 'DVD';
}
let scannedFormat = '';

const byTitle = (a, b) => (a.sortTitle || a.title || '').localeCompare(b.sortTitle || b.title || '', 'fr', { sensitivity: 'base', numeric: true });
const nullsLast = (a, b, cmp) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : cmp(a, b));

export const dvd = createMediaSection({
  id: 'dvd',
  kind: 'dvd',
  label: 'DVD',
  noun: 'film',
  nounPlural: 'films',
  collectionTitle: 'Mes DVD',
  priced: false,
  defaultSort: 'title',
  searchPlaceholder: 'Rechercher : titre, réalisateur, genre…',
  texts: { same: 'Vous avez déjà ce titre', album: 'Vous avez déjà un titre du même nom' },

  contextFromTitles: (titles) => { scannedFormat = detectFormat(titles.join(' ')); return {}; },
  searchFormHtml: () => `
    <label>Titre du film ou de la série</label><input name="title" placeholder="ex. Le Seigneur des anneaux" required>
    <label>Année <span class="opt">(optionnel)</span></label><input name="year" inputmode="numeric" placeholder="ex. 2001">`,
  readSearchForm: (form) => ({ title: form.elements.title.value.trim(), year: form.elements.year.value.trim() }),
  fillSearchForm: (form, q) => { form.elements.title.value = q.title || ''; form.elements.year.value = q.year || ''; },
  validateQuery: (q) => (!q.title ? 'Indique un titre.' : ''),

  async search({ title, year }) {
    const data = await backend.tmdb('search/multi', { query: title, include_adult: 'false' });
    const y = Number(year) || null;
    const results = (data.results || []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv').map((r) => {
      const type = r.media_type;
      const ry = yearOf(type === 'movie' ? r.release_date : r.first_air_date);
      return {
        sourceId: `${type}-${r.id}`,
        title: r.title || r.name,
        year: ry,
        thumb: backend.tmdbImage(r.poster_path, 'w154'),
        subtitle: `${type === 'movie' ? 'Film' : 'Série'}${ry ? ` · ${ry}` : ''}`,
        meta: [(r.original_title || r.original_name) !== (r.title || r.name) ? (r.original_title || r.original_name) : ''],
      };
    });
    if (y) results.sort((a, b) => (b.year === y) - (a.year === y));
    return { results };
  },

  keyFor: (sourceId) => `dvd-${sourceId}`,
  resultHref: (r) => `#/dvd/item/${r.sourceId}`,
  itemHref: (it) => `#/dvd/item/${it.sourceId}`,
  ctxFromRoute: ([sid]) => (/^(movie|tv)-\d+$/.test(sid || '') ? { sourceId: sid } : null),

  async fetchDetails(sourceId) {
    const [type, id] = sourceId.split('-');
    const d = await backend.tmdb(`${type}/${id}`, { append_to_response: 'credits' });
    const people = type === 'movie'
      ? (d.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name)
      : (d.created_by || []).map((c) => c.name);
    const title = d.title || d.name;
    return {
      mediaType: type,
      title,
      sortTitle: simplify(title),
      originalTitle: d.original_title || d.original_name || '',
      year: yearOf(type === 'movie' ? d.release_date : d.first_air_date),
      coverUrl: backend.tmdbImage(d.poster_path, 'w342'),
      thumbUrl: backend.tmdbImage(d.poster_path, 'w154'),
      genres: (d.genres || []).map((g) => g.name),
      summary: d.overview || '',
      people,
      runtime: d.runtime || (d.episode_run_time || [])[0] || null,
      seasons: d.number_of_seasons || null,
      tmdbUrl: `https://www.themoviedb.org/${type}/${id}`,
    };
  },

  fields: [
    { name: 'format', label: 'Format', type: 'select', options: FORMATS, get default() { return scannedFormat || 'DVD'; } },
    { name: 'edition', label: 'Édition', type: 'text', placeholder: 'ex. Collector, Steelbook' },
    { name: 'condition', label: 'État', type: 'select', options: CONDITIONS, default: '' },
  ],

  heroKicker: (it) => [it.mediaType === 'tv' ? 'Série' : 'Film', it.year, it.collection?.format].filter(Boolean).join(' · '),
  factsHtml: (it) => `
    ${it.originalTitle && it.originalTitle !== it.title ? `<dt>Titre original</dt><dd>${esc(it.originalTitle)}</dd>` : ''}
    <dt>Année</dt><dd>${esc(it.year || '—')}</dd>
    ${it.people?.length ? `<dt>${it.mediaType === 'tv' ? 'Créé par' : 'Réalisation'}</dt><dd>${esc(it.people.join(', '))}</dd>` : ''}
    ${it.runtime ? `<dt>Durée</dt><dd>${esc(it.runtime)} min${it.mediaType === 'tv' ? ' / épisode' : ''}</dd>` : ''}
    ${it.seasons ? `<dt>Saisons</dt><dd>${esc(it.seasons)}</dd>` : ''}
    ${it.genres?.length ? `<dt>Genres</dt><dd><div class="tags">${it.genres.map((g) => `<span class="tag">${esc(g)}</span>`).join('')}</div></dd>` : ''}
    ${it.barcodes?.length ? `<dt>Code-barres</dt><dd>${it.barcodes.map(esc).join('<br>')}</dd>` : ''}`,
  externalLink: (it) => it.tmdbUrl,
  externalLabel: 'Voir sur TMDB',

  sameWork: (o, it) => o.sourceId !== it.sourceId && !!simplify(o.title) && simplify(o.title) === simplify(it.title) && (!o.year || !it.year || o.year === it.year),
  otherLabel: (o) => [o.title, o.year, o.collection?.format, o.collection?.edition].filter(Boolean).join(' · '),

  subtitle: (it) => [it.collection?.format, it.collection?.edition].filter(Boolean).join(' · '),
  badge: (it) => it.collection?.format || '',
  metaChips: (it) => [conditionLabel(it.collection?.condition)].filter(Boolean),
  searchText: (it) => [it.title, it.originalTitle, ...(it.people || []), ...(it.genres || []), it.collection?.edition].join(' '),
  sorts: {
    title: { label: 'Titre A → Z', cmp: byTitle },
    'year-desc': { label: 'Année (plus récent)', cmp: (a, b) => nullsLast(a.year, b.year, (x, y) => y - x) || byTitle(a, b) },
    'year-asc': { label: 'Année (plus ancien)', cmp: (a, b) => nullsLast(a.year, b.year, (x, y) => x - y) || byTitle(a, b) },
    format: { label: 'Format', cmp: (a, b) => (a.collection?.format || '').localeCompare(b.collection?.format || '', 'fr') || byTitle(a, b) },
    'added-desc': { label: 'Ajout (plus récent)', cmp: (a, b) => (b.collection?.addedAt || 0) - (a.collection?.addedAt || 0) },
  },
  filters: [
    { name: 'format', label: 'Format', all: 'Tous les formats', get: (it) => it.collection?.format },
    { name: 'genre', label: 'Genre', all: 'Tous les genres', get: (it) => it.genres },
    { name: 'type', label: 'Film ou série', all: 'Films et séries', get: (it) => (it.mediaType === 'tv' ? 'Série' : 'Film') },
  ],

  statsHtml(items, { qtyOf }) {
    const count = items.reduce((s, it) => s + qtyOf(it), 0);
    const by = (fn) => {
      const m = new Map();
      items.forEach((it) => [].concat(fn(it) || 'Non renseigné').forEach((k) => m.set(k, (m.get(k) || 0) + qtyOf(it))));
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const decades = new Map();
    items.forEach((it) => { if (it.year) { const d = Math.floor(it.year / 10) * 10; decades.set(d, (decades.get(d) || 0) + qtyOf(it)); } });
    const formats = by((it) => it.collection?.format);
    return `
      ${tilesHtml([
        { k: 'Films et séries', v: num(count), s: `${num(items.length)} titres` },
        { k: 'Format principal', v: formats[0]?.[0] || '—', s: formats[0] ? `${num(formats[0][1])} exemplaire${formats[0][1] > 1 ? "s" : ""}` : '' },
      ])}
      <div class="card"><h2>Par format</h2>${hbarsHtml(formats)}</div>
      <div class="card"><h2>Par genre</h2>${hbarsHtml(by((it) => (it.genres?.length ? it.genres : null)))}<p class="help">Un film peut avoir plusieurs genres.</p></div>
      ${decades.size ? `<div class="card"><h2>Par décennie</h2>${vbarsHtml([...decades.entries()].sort((a, b) => a[0] - b[0]))}</div>` : ''}`;
  },
});

export function dvdCsv(items) {
  return toCsv([
    ['Titre', (it) => it.title], ['Titre original', (it) => it.originalTitle || ''], ['Type', (it) => (it.mediaType === 'tv' ? 'Série' : 'Film')],
    ['Année', (it) => it.year || ''], ['Format', (it) => it.collection?.format || ''], ['Édition', (it) => it.collection?.edition || ''],
    ['État', (it) => conditionLabel(it.collection?.condition)], ['Quantité', (it) => it.collection?.quantity || 1], ['Note', (it) => it.collection?.notes || ''],
    ['Réalisation', (it) => (it.people || []).join(', ')], ['Genres', (it) => (it.genres || []).join(', ')],
    ['Codes-barres', (it) => (it.barcodes || []).join(' ')], ['Ajouté le', (it) => dateFr(it.collection?.addedAt)], ['TMDB', (it) => it.tmdbUrl || ''],
  ], items);
}

export { thumbHtml };
