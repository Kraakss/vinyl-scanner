// Collection « Disney » : la numérotation officielle française (Classiques Disney /
// Disney Pixar, numéro sur la tranche des DVD) + les autres films d'animation Disney
// « hors numérotation ». Sans prix.
// La liste vient du fichier data/disney-classiques.json (facile à compléter).
// Chaque film a un identifiant texte (« id ») qui ne change jamais : c'est lui qui relie
// tes films possédés et tes codes-barres, même si un numéro est corrigé plus tard.

import * as db from './db.js';
import * as scanner from './scanner.js';
import * as backend from './core/backend.js';
import { $, esc, num, dateFr, toast, setStatus, confirmTap, simplify, toCsv, today } from './core/ui.js';
import { detectFormat } from './dvd.js';
import { LEGACY_V20 } from './disney-legacy.js';
import { regionFilterOn, setRegionFilter, regionToggleHtml, importWarning } from './core/region.js';

const DATA_URL = 'data/disney-classiques.json';
const POSTERS_KEY = 'disney_posters_v2';
const FORMATS = [['DVD', 'DVD'], ['Blu-ray', 'Blu-ray'], ['Blu-ray 4K', 'Blu-ray 4K Ultra HD'], ['Blu-ray 3D', 'Blu-ray 3D'], ['VHS', 'VHS'], ['Autre', 'Autre']];
const CONDITIONS = [['', 'Non renseigné'], ['neuf', 'Neuf (sous blister)'], ['tres-bon', 'Très bon'], ['bon', 'Bon'], ['moyen', 'Moyen'], ['abime', 'Abîmé']];
export const TYPES = { classique: 'Classique', pixar: 'Pixar', suite: 'Suite', autre: 'Autre' };
const ICON_SCAN = '<svg viewBox="0 0 24 24"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M16 8v8"/></svg>';
const ICON_GRID = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24" class="lock"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

let films = []; // { id, n (ou null), section: 'num' | 'hors', titre, annee, type, en, sortie?, incertain?, aVerifier?, support? }
let dataPromise = null;
let posters = {}; // id → { path, at, miss }
let current = null;
const VIEW_KEY = 'disney_view';
let view = { filter: 'all', type: '', q: '' };
// Filtres retenus d'une fois sur l'autre ; la recherche, elle, repart de zéro à chaque ouverture
try { const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}'); view = { ...view, filter: saved.filter || 'all', type: saved.type || '' }; } catch { /* rien */ }
const saveView = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify({ filter: view.filter, type: view.type })); } catch { /* rien */ } };
let justUnlocked = null;

export const tabs = [
  { tab: 'scan', href: '#/disney/scan', label: 'Scanner', icon: ICON_SCAN },
  { tab: 'grid', href: '#/disney', label: 'Classiques', icon: ICON_GRID },
];

export const isReleased = (f) => !f.sortie || f.sortie <= today();
const filmById = (id) => films.find((f) => f.id === String(id));
const filmByNum = (n) => films.find((f) => f.n === Number(n));
const href = (f) => `#/disney/f/${f.id}`;
const label = (f) => (f.n ? `N°${f.n}${f.incertain ? ' ?' : ''} — ${f.titre}` : `${f.titre} (${f.annee})`);

// ---------- Chargement de la liste (+ migration des données de la v2.0) ----------

let migrated = null;
async function ensureMigrated() {
  if (!migrated) {
    migrated = db.migrateDisneyKeys((n) => LEGACY_V20[n] || null)
      .then((r) => { if (r.films || r.barcodes) console.info('[Disney] données rattachées à la nouvelle liste', r); return r; })
      .catch((e) => { migrated = null; throw e; });
  }
  return migrated;
}

/** Utilisable après une restauration de sauvegarde ancienne. */
export async function migrateLegacy() {
  migrated = null;
  return ensureMigrated();
}

export function parseFilms(data) {
  const numbered = (data.numerotes || []).filter((f) => f && f.id && f.titre && f.n)
    .map((f) => ({ ...f, n: Number(f.n), section: 'num' })).sort((a, b) => a.n - b.n);
  const hors = (data.horsNumerotation || []).filter((f) => f && f.id && f.titre)
    .map((f) => ({ ...f, n: null, section: 'hors' })).sort((a, b) => (a.annee - b.annee) || a.titre.localeCompare(b.titre, 'fr'));
  return [...numbered, ...hors];
}

export async function loadFilms() {
  if (!dataPromise) {
    dataPromise = fetch(DATA_URL, { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error('Liste Disney introuvable.'); return r.json(); })
      .then(async (d) => { films = parseFilms(d); await ensureMigrated().catch(() => {}); return films; })
      .catch((e) => { dataPromise = null; throw e; });
  }
  return dataPromise;
}

async function loadPosters() {
  try { posters = (await db.getMeta(POSTERS_KEY)) || {}; } catch { posters = {}; }
}

const posterUrl = (id, size = 'w342') => (posters[id]?.path ? backend.tmdbImage(posters[id].path, size) : '');

// ---------- Affiches (TMDB, en arrière-plan, gardées en cache sur le téléphone) ----------

let postersRunning = false;
export async function fetchMissingPosters() {
  if (postersRunning || !backend.isConfigured()) return;
  postersRunning = true;
  try {
    await loadFilms();
    await loadPosters();
    const weekAgo = Date.now() - 7 * 86400 * 1000;
    const todo = films.filter((f) => !posters[f.id]?.path && !(posters[f.id]?.miss && posters[f.id].at > weekAgo));
    for (const f of todo) {
      if (document.visibilityState !== 'visible') break;
      let path = null;
      try {
        if (f.tmdbId) {
          path = (await backend.tmdb(`movie/${f.tmdbId}`)).poster_path;
        } else {
          for (const [query, year] of [[f.titre, f.annee], [f.en, f.annee], [f.en, '']]) {
            if (!query) continue;
            const res = await backend.tmdb('search/movie', { query, year });
            const list = (res.results || []).filter((r) => r.poster_path);
            const close = list.find((r) => Math.abs(Number(String(r.release_date || '').slice(0, 4)) - f.annee) <= 1);
            const hit = close || (year ? null : list[0]);
            if (hit) { path = hit.poster_path; break; }
          }
        }
      } catch (e) {
        if (!e.status || e.status === 503 || e.status === 429) break; // pas de réseau / TMDB non configuré
      }
      posters[f.id] = path ? { path, at: Date.now() } : { miss: true, at: Date.now() };
      await db.setMeta(POSTERS_KEY, posters);
      if (path && current === 'grid') updateTilePoster(f.id);
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    postersRunning = false;
  }
}

function updateTilePoster(id) {
  const tile = document.querySelector(`.dtile[data-id="${id}"] .dposter`);
  const url = posterUrl(id, 'w185');
  if (tile && url && !tile.querySelector('img')) tile.insertAdjacentHTML('afterbegin', `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`);
}

// ---------- Écrans ----------

export function mount(main) {
  main.insertAdjacentHTML('beforeend', `
  <section class="view" id="view-disney-grid" hidden>
    <div class="dhead card">
      <div class="dsec">
        <div class="dsec-t"><b>Numérotation officielle</b><span id="disney-count-num">0 / 0</span></div>
        <div class="progress"><div class="bar"><span id="disney-bar-num"></span></div></div>
      </div>
      <div class="dsec">
        <div class="dsec-t"><b>Hors numérotation</b><span id="disney-count-hors">0 / 0</span></div>
        <div class="progress"><div class="bar"><span id="disney-bar-hors"></span></div></div>
      </div>
    </div>
    <div class="toolbar">
      <input type="search" id="disney-search" placeholder="Rechercher : titre ou numéro" autocomplete="off">
      <div class="selects">
        <select id="disney-type" aria-label="Type de film">
          <option value="">Tous les types</option><option value="classique">Classiques</option><option value="pixar">Pixar</option>
          <option value="suite">Suites</option><option value="autre">Autres</option><option value="hors">Hors numérotation</option>
        </select>
        <div class="seg dfilter" id="disney-filter" role="group" aria-label="Filtrer">
          <button type="button" data-f="all">Tous</button><button type="button" data-f="owned">Possédés</button><button type="button" data-f="missing">Manquants</button>
        </div>
      </div>
    </div>
    <p class="summary" id="disney-shown"></p>
    <h2 class="dgrid-title" id="disney-title-num">Numérotation officielle</h2>
    <ul class="dgrid" id="disney-grid-num"></ul>
    <h2 class="dgrid-title" id="disney-title-hors">Hors numérotation</h2>
    <ul class="dgrid" id="disney-grid-hors"></ul>
    <p class="help center" id="disney-source"></p>
  </section>

  <section class="view" id="view-disney-scan" hidden>
    <div class="camera"><div id="disney-reader" class="reader"></div>
      <div class="camera-idle">${ICON_SCAN.replace('<svg', '<svg class="big-icon"')}<p>Scan en série : la caméra reste allumée</p></div></div>
    <p class="status" id="disney-scan-status" role="status"></p>
    <div class="actions"><button class="btn primary" id="disney-cam">Démarrer la caméra</button></div>
    <div id="disney-region"></div>
    <div id="disney-answer"></div>
    <form class="card form" id="disney-code-form" autocomplete="off">
      <label for="disney-code-input">Ou tape le code-barres</label>
      <div class="row"><input id="disney-code-input" inputmode="numeric" placeholder="ex. 8717418356820" required><button class="btn primary" type="submit">OK</button></div>
    </form>
  </section>

  <section class="view" id="view-disney-film" hidden><div id="disney-film"></div></section>`);
  bind();
}

export async function route(parts) {
  const [name, arg] = parts;
  await Promise.all([loadFilms().catch(() => []), loadPosters()]);
  // Anciennes adresses « #/disney/n/32 » : on retrouve le film par son numéro officiel
  let filmId = name === 'f' ? arg : null;
  if (name === 'n' && Number(arg)) filmId = filmByNum(arg)?.id || null;
  const v = name === 'scan' ? 'scan' : filmId ? 'film' : 'grid';
  if (current === 'scan' && v !== 'scan') await leave();
  current = v;
  setTimeout(() => {
    if (v === 'grid') { renderGrid(); fetchMissingPosters(); }
    if (v === 'film') renderFilm(filmId);
    if (v === 'scan') { updateCamUi(); renderRegionBar(); startCam(); } // la caméra démarre tout de suite
  }, 0);
  const titles = { grid: 'Classiques Disney', scan: 'Disney · Scanner', film: 'Disney' };
  return { el: $(`#view-disney-${v}`), title: titles[v], tab: v === 'film' ? null : v, isRoot: v !== 'film' };
}

export async function leave() {
  await scanner.stopCamera();
  updateCamUi();
}

// ---------- Grille ----------

async function ownedMap() {
  const all = await db.getDisneyAll().catch(() => []);
  return new Map(all.filter((d) => typeof d.num === 'string').map((d) => [d.num, d]));
}

/** Filtre de recherche : un numéro (« 38 ») ou des mots du titre (français ou original). */
export function matchesQuery(f, q) {
  const t = String(q || '').trim();
  if (!t) return true;
  if (/^n?°?\s*\d{1,3}$/i.test(t)) return f.n === Number(t.replace(/\D/g, ''));
  const hay = simplify(`${f.titre} ${f.en || ''} ${f.annee}`);
  return simplify(t).split(' ').every((w) => hay.includes(w));
}

function tileHtml(f, d) {
  const owned = !!d?.owned;
  const cls = owned ? 'owned' : isReleased(f) ? 'missing' : 'upcoming';
  const url = posterUrl(f.id, 'w185');
  const badge = f.n ? `<span class="dnum${f.incertain ? ' unsure' : ''}">${f.n}${f.incertain ? '?' : ''}</span>` : `<span class="dnum year">${f.annee}</span>`;
  return `<li><a class="dtile ${cls}${justUnlocked === f.id ? ' unlock' : ''}" data-id="${esc(f.id)}" href="${href(f)}" aria-label="${esc(label(f))}${owned ? ' (possédé)' : ''}">
    <div class="dposter">${url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="dph">${esc(f.titre)}</span>
      ${badge}${owned ? '<span class="dcheck">✓</span>' : cls === 'missing' ? LOCK : '<span class="dsoon">À venir</span>'}</div>
    <div class="dtitle">${esc(f.titre)}</div></a></li>`;
}

async function renderGrid() {
  const owned = await ownedMap();
  if (current !== 'grid') return;
  const has = (f) => !!owned.get(f.id)?.owned;
  const counter = (section) => {
    const list = films.filter((f) => f.section === section && isReleased(f));
    const have = list.filter(has).length;
    return { have, total: list.length };
  };
  const cNum = counter('num');
  const cHors = counter('hors');
  $('#disney-count-num').textContent = `${num(cNum.have)} / ${num(cNum.total)}`;
  $('#disney-bar-num').style.width = `${cNum.total ? (cNum.have / cNum.total) * 100 : 0}%`;
  $('#disney-count-hors').textContent = `${num(cHors.have)} / ${num(cHors.total)}`;
  $('#disney-bar-hors').style.width = `${cHors.total ? (cHors.have / cHors.total) * 100 : 0}%`;

  document.querySelectorAll('#disney-filter button').forEach((b) => b.classList.toggle('on', b.dataset.f === view.filter));
  $('#disney-type').value = view.type;
  $('#disney-type').classList.toggle('active', !!view.type);
  $('#disney-search').value = view.q;

  const keep = (f) => {
    if (view.filter === 'owned' && !has(f)) return false;
    if (view.filter === 'missing' && (has(f) || !isReleased(f))) return false;
    if (view.type === 'hors' && f.section !== 'hors') return false;
    if (view.type && view.type !== 'hors' && f.type !== view.type) return false;
    return matchesQuery(f, view.q);
  };
  const shownNum = films.filter((f) => f.section === 'num' && keep(f));
  const shownHors = films.filter((f) => f.section === 'hors' && keep(f));
  $('#disney-grid-num').innerHTML = shownNum.map((f) => tileHtml(f, owned.get(f.id))).join('');
  $('#disney-grid-hors').innerHTML = shownHors.map((f) => tileHtml(f, owned.get(f.id))).join('');
  $('#disney-title-num').hidden = !shownNum.length;
  $('#disney-title-hors').hidden = !shownHors.length;
  const filtered = view.filter !== 'all' || view.type || view.q;
  $('#disney-shown').textContent = !shownNum.length && !shownHors.length ? 'Aucun film ne correspond.'
    : filtered ? `${num(shownNum.length + shownHors.length)} film${shownNum.length + shownHors.length > 1 ? 's' : ''}` : '';
  justUnlocked = null;
  const upcoming = films.filter((f) => !isReleased(f)).length;
  const unsure = films.filter((f) => f.incertain).map((f) => f.n);
  $('#disney-source').textContent = films.length
    ? `Liste : ${films.filter((f) => f.section === 'num').length} films numérotés et ${films.filter((f) => f.section === 'hors').length} hors numérotation${upcoming ? ` (dont ${upcoming} à venir)` : ''}. Numéros à confirmer (« ? ») : ${unsure.join(', ') || 'aucun'}. Fichier : data/disney-classiques.json.`
    : '';
}

// ---------- Fiche ----------

async function renderFilm(id) {
  const f = filmById(id);
  const box = $('#disney-film');
  if (!f) { box.innerHTML = '<div class="empty"><p>Film introuvable.</p></div>'; return; }
  const d = (await ownedMap()).get(f.id) || { num: f.id, owned: 0, barcodes: [] };
  if (current !== 'film') return;
  $('#page-title').textContent = f.n ? `Classique n°${f.n}` : 'Hors numérotation';
  const url = posterUrl(f.id, 'w342');
  const opts = (list, val) => list.map(([v, l]) => `<option value="${esc(v)}"${v === (val || '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const kicker = [f.n ? `N°${f.n}${f.incertain ? ' (à confirmer)' : ''}` : 'Hors numérotation', TYPES[f.type], f.annee, f.support].filter(Boolean).join(' · ');
  box.innerHTML = `
    <div class="hero portrait">
      <div class="dposter big ${d.owned ? 'owned' : 'missing'}${justUnlocked === f.id ? ' unlock' : ''}">${url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="dph">${esc(f.titre)}</span>
        ${f.n ? `<span class="dnum${f.incertain ? ' unsure' : ''}">${f.n}${f.incertain ? '?' : ''}</span>` : `<span class="dnum year">${f.annee}</span>`}${d.owned ? '<span class="dcheck">✓</span>' : LOCK}</div>
      <div class="hero-text">
        <div class="artist">${esc(kicker)}</div>
        <h2>${esc(f.titre)}</h2>
        ${f.en ? `<p class="help">${esc(f.en)}</p>` : ''}
        ${!isReleased(f) ? `<p class="help">Sortie prévue le ${esc(new Date(f.sortie).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }))}</p>` : ''}
      </div>
    </div>
    ${f.incertain ? `<p class="help note-unsure">⚠ Numéro à confirmer : ${esc(f.incertain)}</p>` : ''}
    ${f.aVerifier ? `<p class="help note-unsure">ℹ ${esc(f.aVerifier)}</p>` : ''}
    ${d.owned
    ? `<div class="own-banner same"><strong>Vous l'avez${f.n ? ` (n°${f.n})` : ''}</strong>${d.addedAt ? `Ajouté le ${esc(dateFr(d.addedAt))}` : ''}</div>`
    : '<div class="own-pill">Pas dans votre collection</div>'}
    <form class="card form coll-form" id="disney-form" autocomplete="off">
      <div class="grid2">
        <div><label for="disney-f-format">Format</label><select id="disney-f-format">${opts(FORMATS, d.format || 'DVD')}</select></div>
        <div><label for="disney-f-cond">État</label><select id="disney-f-cond">${opts(CONDITIONS, d.condition)}</select></div>
      </div>
      <label for="disney-f-edition">Édition</label><input id="disney-f-edition" value="${esc(d.edition || '')}" placeholder="ex. Édition Exclusive, Collector">
      <label for="disney-f-notes">Note perso</label><textarea id="disney-f-notes" rows="2">${esc(d.notes || '')}</textarea>
      ${d.owned
    ? `<button class="btn primary block" type="submit">Enregistrer</button>
         <button class="btn ghost block danger" type="button" id="disney-remove">Je ne l'ai plus</button>`
    : '<button class="btn primary block big" type="button" id="disney-add">Je l\'ai</button>'}
    </form>
    ${d.barcodes?.length ? `<div class="card"><h2>Codes-barres associés</h2><p class="help">${d.barcodes.map(esc).join('<br>')}</p></div>` : ''}`;
  justUnlocked = null;
  const read = () => ({
    format: $('#disney-f-format').value, condition: $('#disney-f-cond').value,
    edition: $('#disney-f-edition').value.trim(), notes: $('#disney-f-notes').value.trim(),
  });
  $('#disney-add')?.addEventListener('click', async () => {
    await setOwned(f.id, true, read());
    toast(`${f.n ? `N°${f.n}` : f.titre} ajouté à ta collection !`);
    renderFilm(f.id);
  });
  $('#disney-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await db.updateDisney(f.id, (x) => ({ ...x, ...read() }));
    toast('Modifications enregistrées.');
  });
  $('#disney-remove')?.addEventListener('click', async (e) => {
    if (!confirmTap(e.currentTarget, 'Je ne l\'ai plus')) return;
    await setOwned(f.id, false);
    toast('Retiré de ta collection.');
    renderFilm(f.id);
  });
}

async function setOwned(id, owned, fields = {}) {
  const rec = await db.updateDisney(id, (x) => ({
    ...x, ...fields, id, num: id, owned: owned ? 1 : 0, addedAt: owned ? (x.owned ? x.addedAt : Date.now()) : null,
  }));
  if (owned) justUnlocked = id;
  return rec;
}

// ---------- Scan ultra rapide ----------

const STOP = new Set(['le', 'la', 'les', 'l', 'et', 'des', 'de', 'du', 'd', 'un', 'une', 'the', 'and', 'of', 'a', 'au', 'aux', 'pays']);
const ROMAN = { ii: '2', iii: '3', iv: '4' };
const tokens = (s) => simplify(s).split(' ').filter((w) => w && !STOP.has(w)).map((w) => ROMAN[w] || w);
/** Titre court : « Le Roi lion 2 : L'Honneur de la tribu » → « Le Roi lion 2 » */
const shortTitle = (t) => String(t || '').split(/\s:\s|\s-\s|:\s/)[0];

/** Score de ressemblance entre un titre de produit et un film de la liste (0 à 1). */
export function matchScore(productTitle, film) {
  const p = new Set(tokens(backend.cleanProductTitle(productTitle)));
  let best = 0;
  for (const title of new Set([film.titre, film.en, shortTitle(film.titre), shortTitle(film.en)].filter(Boolean))) {
    const t = tokens(title);
    if (!t.length) continue;
    let score = t.filter((w) => p.has(w)).length / t.length;
    // « Le Roi Lion 2 » n'est pas « Le Roi Lion » : un numéro de suite en trop pénalise
    const extraNums = [...p].filter((w) => /^\d+$/.test(w) && !t.includes(w) && Number(w) < 10);
    if (extraNums.length) score *= 0.3;
    best = Math.max(best, score);
  }
  return best;
}

export function bestMatches(titles, list = films) {
  const scored = list.map((f) => ({ f, s: Math.max(...titles.map((t) => matchScore(t, f))) }))
    .filter((x) => x.s >= 0.6).sort((a, b) => b.s - a.s || (a.f.n || 999) - (b.f.n || 999));
  return scored.slice(0, 3).map((x) => x.f);
}

/** Allume la caméra du scan en série (appelé dès l'ouverture de l'onglet). */
async function startCam() {
  if (scanner.isRunning('disney-reader')) return;
  const status = $('#disney-scan-status');
  $('#disney-cam').disabled = true;
  setStatus(status, 'Ouverture de la caméra… (autorise l\'accès si le téléphone le demande)');
  try {
    await scanner.startCamera('disney-reader', handleCode, { continuous: true, onState: updateCamUi });
    if (scanner.isRunning('disney-reader')) setStatus(status, 'Vise le code-barres : la réponse s\'affiche tout de suite. Touche l\'image pour faire le point.');
  } catch (e) {
    setStatus(status, scanner.cameraErrorMessage(e), 'error');
  } finally {
    $('#disney-cam').disabled = false;
    updateCamUi();
  }
}

function updateCamUi() {
  const btn = $('#disney-cam');
  if (!btn) return;
  const on = scanner.isRunning('disney-reader');
  btn.closest('section').querySelector('.camera').classList.toggle('on', on);
  btn.textContent = on ? 'Arrêter la caméra' : 'Démarrer la caméra';
  btn.className = on ? 'btn ghost' : 'btn primary';
}

async function handleCode(code) {
  await loadFilms();
  setStatus($('#disney-scan-status'), `Code lu : ${code}`, 'ok');
  const link = await db.getBarcode(code).catch(() => null);
  if (link?.kind === 'disney' && filmById(link.ref)) { showAnswer(code, String(link.ref)); return; }
  // Code inconnu : on cherche le titre du produit pour proposer le film probable
  const box = $('#disney-answer');
  box.innerHTML = '<div class="card"><p class="help">Code inconnu, recherche du titre…</p></div>';
  let titles = [];
  if (backend.isConfigured()) {
    try { titles = (await backend.eanLookup(code)).titles.map((t) => t.title); } catch { /* pas de réseau */ }
  }
  const guesses = titles.length ? bestMatches(titles) : [];
  const released = films.filter(isReleased);
  const option = (f) => `<option value="${esc(f.id)}">${esc(f.n ? `${f.n}. ${f.titre}` : `${f.titre} (${f.annee})`)}</option>`;
  const warnAsk = regionFilterOn('disney') ? importWarning(code) : null;
  box.innerHTML = `${warnAsk ? `<p class="import-warn">⚠ ${esc(warnAsk)}</p>` : ''}<div class="card dask">
    <strong>Quel film Disney est-ce ?</strong>
    ${titles.length ? `<p class="help">Produit trouvé : « ${esc(titles[0])} »</p>` : `<p class="help">${backend.isConfigured() ? 'Produit introuvable dans les bases gratuites.' : 'Serveur non configuré : choisis dans la liste.'}</p>`}
    ${guesses.map((f) => `<button class="btn primary block" data-pick="${esc(f.id)}">${esc(label(f))}</button>`).join('')}
    <label for="disney-pick">${guesses.length ? 'Ce n\'est pas ça ? Choisis :' : 'Choisis le film :'}</label>
    <div class="row"><select id="disney-pick"><option value="">Choisir…</option>
      <optgroup label="Numérotation officielle">${released.filter((f) => f.n).map(option).join('')}</optgroup>
      <optgroup label="Hors numérotation">${released.filter((f) => !f.n).map(option).join('')}</optgroup>
    </select>
    <button class="btn ghost" id="disney-pick-ok">OK</button></div>
    <button class="linklike" id="disney-not">Ce n'est pas un film Disney de la liste</button>
  </div>`;
  const pick = async (id) => {
    const f = filmById(id);
    if (!f) return;
    await db.setBarcode(code, { kind: 'disney', ref: f.id, title: titles[0] || f.titre });
    await db.updateDisney(f.id, (x) => ({ ...x, id: f.id, num: f.id, barcodes: [...new Set([...(x.barcodes || []), code])], format: x.format || (titles.length ? detectFormat(titles.join(' ')) : x.format) }));
    showAnswer(code, f.id, titles);
  };
  box.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => pick(b.dataset.pick)));
  $('#disney-pick-ok').addEventListener('click', () => pick($('#disney-pick').value));
  $('#disney-not').addEventListener('click', () => { box.innerHTML = ''; setStatus($('#disney-scan-status'), 'Ignoré. Prêt pour le suivant.'); });
}

function renderRegionBar() {
  const on = regionFilterOn('disney');
  $('#disney-region').innerHTML = `${regionToggleHtml('disney', on)}<p class="help region-help">${on ? "Activé : l'appli te prévient quand un code-barres vient d'une édition étrangère (import)." : "Désactivé : pas d'avertissement pour les éditions importées."}</p>`;
}

async function showAnswer(code, id, titles = []) {
  const f = filmById(id);
  const d = (await ownedMap()).get(id);
  const url = posterUrl(id, 'w185');
  const box = $('#disney-answer');
  const badge = f.n ? `<span class="dnum">${f.n}</span>` : `<span class="dnum year">${f.annee}</span>`;
  const poster = (cls) => `<div class="dposter mini ${cls}">${url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="dph">${esc(f.titre)}</span>${badge}${cls.startsWith('owned') ? '<span class="dcheck">✓</span>' : LOCK}</div>`;
  const where = f.n ? `n°${f.n}` : 'hors numérotation';
  if (d?.owned) {
    box.innerHTML = `${warnHtml(code)}<div class="answer same" role="alert">${poster('owned')}<div><strong>Vous l'avez déjà (${where})</strong><span>${esc(f.titre)}${d.format ? ` · ${esc(d.format)}` : ''}</span>
      <a class="linklike" href="${href(f)}">Voir la fiche</a></div></div>`;
    if (navigator.vibrate) navigator.vibrate([60, 60, 60]);
  } else {
    box.innerHTML = `${warnHtml(code)}<div class="answer new" role="alert">${poster('missing')}<div><strong>Vous ne l'avez pas</strong><span>${esc(label(f))}</span>
      <button class="btn primary" id="disney-answer-add">Ajouter</button></div></div>`;
    $('#disney-answer-add').addEventListener('click', async () => {
      await setOwned(id, true, { format: d?.format || (titles.length ? detectFormat(titles.join(' ')) : 'DVD') });
      box.innerHTML = `<div class="answer added" role="status">${poster('owned unlock')}<div><strong>Ajouté ! ${f.n ? `N°${f.n} déverrouillé` : 'Déverrouillé'}</strong><span>${esc(f.titre)}</span>
        <a class="linklike" href="${href(f)}">Préciser format / édition</a></div></div>`;
      if (navigator.vibrate) navigator.vibrate(120);
    });
  }
  setStatus($('#disney-scan-status'), scanner.isRunning('disney-reader') ? 'Prêt pour le suivant : vise un autre code-barres.' : '');
}

const warnHtml = (code) => {
  const w = regionFilterOn('disney') ? importWarning(code) : null;
  return w ? `<p class="import-warn">⚠ ${esc(w)}</p>` : '';
};

function bind() {
  $('#disney-region').addEventListener('click', (e) => {
    if (!e.target.closest('[data-region-toggle]')) return;
    setRegionFilter('disney', !regionFilterOn('disney'));
    renderRegionBar();
  });
  $('#disney-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    view.filter = b.dataset.f;
    view.q = $('#disney-search').value; // texte en cours de frappe pris en compte tout de suite
    saveView();
    renderGrid();
  });
  $('#disney-type').addEventListener('change', (e) => { view.type = e.target.value; view.q = $('#disney-search').value; saveView(); renderGrid(); });
  let t;
  $('#disney-search').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { view.q = e.target.value; saveView(); renderGrid(); }, 150); });
  $('#disney-cam').addEventListener('click', async () => {
    if (scanner.isRunning('disney-reader')) { await leave(); setStatus($('#disney-scan-status'), 'Caméra arrêtée.'); return; }
    startCam();
  });
  $('#disney-code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#disney-code-input').value.replace(/\s+/g, '');
    if (code) { handleCode(code); $('#disney-code-input').value = ''; }
  });
}

/** Résumé pour l'écran d'accueil et les réglages. */
export async function summary() {
  try { await loadFilms(); } catch { return { have: 0, total: 0, haveHors: 0, totalHors: 0 }; }
  const owned = await ownedMap();
  const count = (section) => {
    const list = films.filter((f) => f.section === section && isReleased(f));
    return [list.filter((f) => owned.get(f.id)?.owned).length, list.length];
  };
  const [have, total] = count('num');
  const [haveHors, totalHors] = count('hors');
  return { have, total, haveHors, totalHors };
}

export async function disneyCsv() {
  await loadFilms();
  const owned = await ownedMap();
  const lab = (list, v) => (list.find(([k]) => k === v) || [, ''])[1];
  const g = (f) => owned.get(f.id) || {};
  return toCsv([
    ['N°', (f) => (f.n ? `${f.n}${f.incertain ? ' (à confirmer)' : ''}` : 'hors numérotation')], ['Titre', (f) => f.titre], ['Titre original', (f) => f.en || ''],
    ['Année', (f) => f.annee], ['Type', (f) => TYPES[f.type] || ''], ['Possédé', (f) => (g(f).owned ? 'oui' : 'non')],
    ['Format', (f) => g(f).format || ''], ['Édition', (f) => g(f).edition || ''], ['État', (f) => lab(CONDITIONS, g(f).condition)],
    ['Note', (f) => g(f).notes || ''], ['Codes-barres', (f) => (g(f).barcodes || []).join(' ')], ['Ajouté le', (f) => (g(f).addedAt ? dateFr(g(f).addedAt) : '')],
  ], films);
}

export const disney = { id: 'disney', tabs, mount, route, leave, summary };
