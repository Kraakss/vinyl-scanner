// Collection « Disney » : les Grands Classiques numérotés (sans prix).
// La liste vient du fichier data/disney-classiques.json (facile à compléter).

import * as db from './db.js';
import * as scanner from './scanner.js';
import * as backend from './core/backend.js';
import { $, esc, num, dateFr, toast, setStatus, confirmTap, simplify, toCsv, today } from './core/ui.js';
import { detectFormat } from './dvd.js';

const DATA_URL = 'data/disney-classiques.json';
const POSTERS_KEY = 'disney_posters';
const FORMATS = [['DVD', 'DVD'], ['Blu-ray', 'Blu-ray'], ['Blu-ray 4K', 'Blu-ray 4K Ultra HD'], ['Blu-ray 3D', 'Blu-ray 3D'], ['VHS', 'VHS'], ['Autre', 'Autre']];
const CONDITIONS = [['', 'Non renseigné'], ['neuf', 'Neuf (sous blister)'], ['tres-bon', 'Très bon'], ['bon', 'Bon'], ['moyen', 'Moyen'], ['abime', 'Abîmé']];
const ICON_SCAN = '<svg viewBox="0 0 24 24"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M16 8v8"/></svg>';
const ICON_GRID = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24" class="lock"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

let films = []; // { n, titre, annee, en, sortie?, tmdbId? }
let dataPromise = null;
let posters = {}; // n → { path, at, miss }
let current = null;
let filter = 'all';
try { filter = localStorage.getItem('disney_filter') || 'all'; } catch { /* rien */ }
let lastScan = null; // { code, num }
let justUnlocked = null;

export const tabs = [
  { tab: 'scan', href: '#/disney/scan', label: 'Scanner', icon: ICON_SCAN },
  { tab: 'grid', href: '#/disney', label: 'Classiques', icon: ICON_GRID },
];

const isReleased = (f) => !f.sortie || f.sortie <= today();
const filmByNum = (n) => films.find((f) => f.n === Number(n));

export async function loadFilms() {
  if (!dataPromise) {
    dataPromise = fetch(DATA_URL, { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error('Liste Disney introuvable.'); return r.json(); })
      .then((d) => { films = (d.films || []).filter((f) => f && f.n && f.titre).sort((a, b) => a.n - b.n); return films; })
      .catch((e) => { dataPromise = null; throw e; });
  }
  return dataPromise;
}

async function loadPosters() {
  try { posters = (await db.getMeta(POSTERS_KEY)) || {}; } catch { posters = {}; }
}

const posterUrl = (n, size = 'w342') => (posters[n]?.path ? backend.tmdbImage(posters[n].path, size) : '');

// ---------- Affiches (TMDB, en arrière-plan) ----------

let postersRunning = false;
async function fetchMissingPosters() {
  if (postersRunning || !backend.isConfigured()) return;
  postersRunning = true;
  try {
    await loadFilms();
    const weekAgo = Date.now() - 7 * 86400 * 1000;
    const todo = films.filter((f) => !posters[f.n]?.path && !(posters[f.n]?.miss && posters[f.n].at > weekAgo));
    for (const f of todo) {
      if (document.visibilityState !== 'visible') break;
      let path = null;
      try {
        if (f.tmdbId) {
          path = (await backend.tmdb(`movie/${f.tmdbId}`)).poster_path;
        } else {
          for (const query of [f.titre, f.en]) {
            const res = await backend.tmdb('search/movie', { query, year: f.annee });
            const hit = (res.results || []).find((r) => String(r.release_date || '').startsWith(String(f.annee))) || (res.results || [])[0];
            if (hit?.poster_path) { path = hit.poster_path; break; }
          }
        }
      } catch (e) {
        if (!e.status || e.status === 503 || e.status === 429) break; // pas de réseau / TMDB non configuré
      }
      posters[f.n] = path ? { path, at: Date.now() } : { miss: true, at: Date.now() };
      await db.setMeta(POSTERS_KEY, posters);
      if (current === 'grid') updateTilePoster(f.n);
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    postersRunning = false;
  }
}

function updateTilePoster(n) {
  const tile = document.querySelector(`.dtile[data-n="${n}"] .dposter`);
  const url = posterUrl(n, 'w185');
  if (tile && url && !tile.querySelector('img')) tile.insertAdjacentHTML('afterbegin', `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`);
}

// ---------- Écrans ----------

export function mount(main) {
  main.insertAdjacentHTML('beforeend', `
  <section class="view" id="view-disney-grid" hidden>
    <div class="dhead card">
      <div class="dcount"><b id="disney-count">0</b><span id="disney-total">/ 0</span></div>
      <div class="help" id="disney-sub">Grands Classiques Disney</div>
      <div class="progress"><div class="bar"><span id="disney-bar"></span></div></div>
      <div class="seg dfilter" id="disney-filter" role="group" aria-label="Filtrer">
        <button type="button" data-f="all">Tous</button><button type="button" data-f="owned">Possédés</button><button type="button" data-f="missing">Manquants</button>
      </div>
    </div>
    <ul class="dgrid" id="disney-grid"></ul>
    <p class="help center" id="disney-source"></p>
  </section>

  <section class="view" id="view-disney-scan" hidden>
    <div class="camera"><div id="disney-reader" class="reader"></div>
      <div class="camera-idle">${ICON_SCAN.replace('<svg', '<svg class="big-icon"')}<p>Scan en série : la caméra reste allumée</p></div></div>
    <p class="status" id="disney-scan-status" role="status"></p>
    <div class="actions"><button class="btn primary" id="disney-cam">Démarrer la caméra</button></div>
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
  const [name, n] = parts;
  const v = name === 'scan' ? 'scan' : name === 'n' && Number(n) ? 'film' : 'grid';
  if (current === 'scan' && v !== 'scan') await leave();
  current = v;
  await Promise.all([loadFilms().catch(() => []), loadPosters()]);
  setTimeout(() => {
    if (v === 'grid') { renderGrid(); fetchMissingPosters(); }
    if (v === 'film') renderFilm(Number(n));
    if (v === 'scan') updateCamUi();
  }, 0);
  const titles = { grid: 'Grands Classiques Disney', scan: 'Disney · Scanner', film: 'Grand Classique' };
  return { el: $(`#view-disney-${v}`), title: titles[v], tab: v === 'film' ? null : v, isRoot: v !== 'film' };
}

export async function leave() {
  await scanner.stopCamera();
  updateCamUi();
}

// ---------- Grille ----------

async function renderGrid() {
  let owned = [];
  try { owned = await db.getDisneyAll(); } catch { /* rien */ }
  if (current !== 'grid') return;
  const ownedSet = new Set(owned.filter((d) => d.owned).map((d) => d.num));
  const released = films.filter(isReleased);
  const have = released.filter((f) => ownedSet.has(f.n)).length;
  $('#disney-count').textContent = num(have);
  $('#disney-total').textContent = `/ ${num(released.length)}`;
  $('#disney-bar').style.width = `${released.length ? (have / released.length) * 100 : 0}%`;
  const formats = new Map();
  owned.filter((d) => d.owned).forEach((d) => formats.set(d.format || 'Format ?', (formats.get(d.format || 'Format ?') || 0) + 1));
  $('#disney-sub').textContent = have
    ? `${Math.round((have / released.length) * 100)} % des Grands Classiques · ${[...formats.entries()].map(([k, v]) => `${v} ${k}`).join(' · ')}`
    : 'Grands Classiques Disney — touche un film pour l\'ajouter';
  document.querySelectorAll('#disney-filter button').forEach((b) => b.classList.toggle('on', b.dataset.f === filter));
  const shown = films.filter((f) => (filter === 'owned' ? ownedSet.has(f.n) : filter === 'missing' ? !ownedSet.has(f.n) && isReleased(f) : true));
  $('#disney-grid').innerHTML = shown.map((f) => {
    const isOwned = ownedSet.has(f.n);
    const cls = isOwned ? 'owned' : isReleased(f) ? 'missing' : 'upcoming';
    const url = posterUrl(f.n, 'w185');
    return `<li><a class="dtile ${cls}${justUnlocked === f.n ? ' unlock' : ''}" data-n="${f.n}" href="#/disney/n/${f.n}" aria-label="N°${f.n} ${esc(f.titre)}${isOwned ? ' (possédé)' : ''}">
      <div class="dposter">${url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="dph">${esc(f.titre)}</span>
        <span class="dnum">${f.n}</span>${isOwned ? '<span class="dcheck">✓</span>' : cls === 'missing' ? LOCK : '<span class="dsoon">À venir</span>'}</div>
      <div class="dtitle">${esc(f.titre)}</div></a></li>`;
  }).join('') || '<li class="empty">Aucun film dans ce filtre.</li>';
  justUnlocked = null;
  $('#disney-source').textContent = films.length ? `Liste : ${films.length} films (dont ${films.length - released.length} à venir). Mise à jour : fichier data/disney-classiques.json.` : '';
}

// ---------- Fiche ----------

async function renderFilm(n) {
  const f = filmByNum(n);
  const box = $('#disney-film');
  if (!f) { box.innerHTML = '<div class="empty"><p>Film introuvable.</p></div>'; return; }
  const d = (await db.getDisneyAll().catch(() => [])).find((x) => x.num === n) || { num: n, owned: 0, barcodes: [] };
  if (current !== 'film') return;
  $('#page-title').textContent = `Grand Classique n°${n}`;
  const url = posterUrl(n, 'w342');
  const opts = (list, val) => list.map(([v, l]) => `<option value="${esc(v)}"${v === (val || '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
  box.innerHTML = `
    <div class="hero portrait">
      <div class="dposter big ${d.owned ? 'owned' : 'missing'}${justUnlocked === n ? ' unlock' : ''}">${url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="dph">${esc(f.titre)}</span>
        <span class="dnum">${n}</span>${d.owned ? '<span class="dcheck">✓</span>' : LOCK}</div>
      <div class="hero-text">
        <div class="artist">Grand Classique n°${n} · ${f.annee}</div>
        <h2>${esc(f.titre)}</h2>
        ${f.en ? `<p class="help">${esc(f.en)}</p>` : ''}
        ${!isReleased(f) ? `<p class="help">Sortie prévue le ${esc(new Date(f.sortie).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }))}</p>` : ''}
      </div>
    </div>
    ${d.owned
    ? `<div class="own-banner same"><strong>Vous l'avez (n°${n})</strong>${d.addedAt ? `Ajouté le ${esc(dateFr(d.addedAt))}` : ''}</div>`
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
    await setOwned(n, true, read());
    toast(`N°${n} ajouté à ta collection !`);
    renderFilm(n);
  });
  $('#disney-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await db.updateDisney(n, (x) => ({ ...x, ...read() }));
    toast('Modifications enregistrées.');
  });
  $('#disney-remove')?.addEventListener('click', async (e) => {
    if (!confirmTap(e.currentTarget, 'Je ne l\'ai plus')) return;
    await setOwned(n, false);
    toast('Retiré de ta collection.');
    renderFilm(n);
  });
}

async function setOwned(n, owned, fields = {}) {
  const rec = await db.updateDisney(n, (x) => ({
    ...x, ...fields, owned: owned ? 1 : 0, addedAt: owned ? (x.owned ? x.addedAt : Date.now()) : null,
  }));
  if (owned) justUnlocked = n;
  return rec;
}

// ---------- Scan ultra rapide ----------

const STOP = new Set(['le', 'la', 'les', 'l', 'et', 'des', 'de', 'du', 'd', 'un', 'une', 'the', 'and', 'of', 'a', 'au', 'aux', 'pays']);
const ROMAN = { ii: '2', iii: '3', iv: '4' };
const tokens = (s) => simplify(s).split(' ').filter((w) => w && !STOP.has(w)).map((w) => ROMAN[w] || w);

/** Score de ressemblance entre un titre de produit et un film de la liste (0 à 1). */
export function matchScore(productTitle, film) {
  const p = new Set(tokens(backend.cleanProductTitle(productTitle)));
  let best = 0;
  for (const title of [film.titre, film.en].filter(Boolean)) {
    const t = tokens(title);
    if (!t.length) continue;
    let score = t.filter((w) => p.has(w)).length / t.length;
    // « Le Roi Lion 2 » n'est pas « Le Roi Lion » (les suites ne sont pas des Grands Classiques)
    const extraNums = [...p].filter((w) => /^\d+$/.test(w) && !t.includes(w) && Number(w) < 10);
    if (extraNums.length) score *= 0.3;
    best = Math.max(best, score);
  }
  return best;
}

export function bestMatches(titles, list = films) {
  const scored = list.map((f) => ({ f, s: Math.max(...titles.map((t) => matchScore(t, f))) }))
    .filter((x) => x.s >= 0.6).sort((a, b) => b.s - a.s || a.f.n - b.f.n);
  return scored.slice(0, 3).map((x) => x.f);
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
  if (link?.kind === 'disney' && filmByNum(link.ref)) { showAnswer(code, Number(link.ref)); return; }
  // Code inconnu : on cherche le titre du produit pour proposer le film probable
  const box = $('#disney-answer');
  box.innerHTML = '<div class="card"><p class="help">Code inconnu, recherche du titre…</p></div>';
  let titles = [];
  if (backend.isConfigured()) {
    try { titles = (await backend.eanLookup(code)).titles.map((t) => t.title); } catch { /* pas de réseau */ }
  }
  const guesses = titles.length ? bestMatches(titles) : [];
  const released = films.filter(isReleased);
  box.innerHTML = `<div class="card dask">
    <strong>Quel Grand Classique est-ce ?</strong>
    ${titles.length ? `<p class="help">Produit trouvé : « ${esc(titles[0])} »</p>` : `<p class="help">${backend.isConfigured() ? 'Produit introuvable dans les bases gratuites.' : 'Serveur non configuré : choisis dans la liste.'}</p>`}
    ${guesses.map((f) => `<button class="btn primary block" data-pick="${f.n}">N°${f.n} — ${esc(f.titre)}</button>`).join('')}
    <label for="disney-pick">${guesses.length ? 'Ce n\'est pas ça ? Choisis :' : 'Choisis le film :'}</label>
    <div class="row"><select id="disney-pick"><option value="">Numéro…</option>${released.map((f) => `<option value="${f.n}">${f.n}. ${esc(f.titre)}</option>`).join('')}</select>
    <button class="btn ghost" id="disney-pick-ok">OK</button></div>
    <button class="linklike" id="disney-not">Ce n'est pas un Grand Classique</button>
  </div>`;
  const pick = async (n) => {
    if (!n) return;
    await db.setBarcode(code, { kind: 'disney', ref: n, title: titles[0] || filmByNum(n).titre });
    await db.updateDisney(n, (x) => ({ ...x, barcodes: [...new Set([...(x.barcodes || []), code])], format: x.format || (titles.length ? detectFormat(titles.join(' ')) : x.format) }));
    showAnswer(code, n, titles);
  };
  box.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => pick(Number(b.dataset.pick))));
  $('#disney-pick-ok').addEventListener('click', () => pick(Number($('#disney-pick').value)));
  $('#disney-not').addEventListener('click', () => { box.innerHTML = ''; setStatus($('#disney-scan-status'), 'Ignoré. Prêt pour le suivant.'); });
}

async function showAnswer(code, n, titles = []) {
  const f = filmByNum(n);
  const d = (await db.getDisneyAll().catch(() => [])).find((x) => x.num === n);
  lastScan = { code, num: n };
  const url = posterUrl(n, 'w185');
  const box = $('#disney-answer');
  const poster = (cls) => `<div class="dposter mini ${cls}">${url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="dph">${esc(f.titre)}</span><span class="dnum">${n}</span>${cls === 'owned' ? '<span class="dcheck">✓</span>' : LOCK}</div>`;
  if (d?.owned) {
    box.innerHTML = `<div class="answer same" role="alert">${poster('owned')}<div><strong>Vous l'avez déjà (n°${n})</strong><span>${esc(f.titre)}${d.format ? ` · ${esc(d.format)}` : ''}</span>
      <a class="linklike" href="#/disney/n/${n}">Voir la fiche</a></div></div>`;
    if (navigator.vibrate) navigator.vibrate([60, 60, 60]);
  } else {
    box.innerHTML = `<div class="answer new" role="alert">${poster('missing')}<div><strong>Vous ne l'avez pas</strong><span>N°${n} — ${esc(f.titre)}</span>
      <button class="btn primary" id="disney-answer-add">Ajouter</button></div></div>`;
    $('#disney-answer-add').addEventListener('click', async () => {
      await setOwned(n, true, { format: d?.format || (titles.length ? detectFormat(titles.join(' ')) : 'DVD') });
      box.innerHTML = `<div class="answer added" role="status">${poster('owned unlock')}<div><strong>Ajouté ! N°${n} déverrouillé</strong><span>${esc(f.titre)}</span>
        <a class="linklike" href="#/disney/n/${n}">Préciser format / édition</a></div></div>`;
      if (navigator.vibrate) navigator.vibrate(120);
    });
  }
  setStatus($('#disney-scan-status'), scanner.isRunning('disney-reader') ? 'Prêt pour le suivant : vise un autre code-barres.' : '');
}

function bind() {
  $('#disney-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    filter = b.dataset.f;
    try { localStorage.setItem('disney_filter', filter); } catch { /* rien */ }
    renderGrid();
  });
  $('#disney-cam').addEventListener('click', async () => {
    const status = $('#disney-scan-status');
    if (scanner.isRunning('disney-reader')) { await leave(); setStatus(status, ''); return; }
    $('#disney-cam').disabled = true;
    setStatus(status, 'Ouverture de la caméra… (autorise l\'accès si le téléphone le demande)');
    try {
      await scanner.startCamera('disney-reader', handleCode, { continuous: true });
      setStatus(status, 'Vise le code-barres : la réponse s\'affiche tout de suite.');
    } catch (e) {
      setStatus(status, scanner.cameraErrorMessage(e), 'error');
    } finally {
      $('#disney-cam').disabled = false;
      updateCamUi();
    }
  });
  $('#disney-code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#disney-code-input').value.replace(/\s+/g, '');
    if (code) { handleCode(code); $('#disney-code-input').value = ''; }
  });
}

/** Résumé pour l'écran d'accueil. */
export async function summary() {
  try { await loadFilms(); } catch { return { have: 0, total: 0 }; }
  const owned = new Set((await db.getDisneyAll().catch(() => [])).filter((d) => d.owned).map((d) => d.num));
  const released = films.filter(isReleased);
  return { have: released.filter((f) => owned.has(f.n)).length, total: released.length };
}

export async function disneyCsv() {
  await loadFilms();
  const owned = await db.getDisneyAll();
  const byNum = new Map(owned.map((d) => [d.num, d]));
  const label = (list, v) => (list.find(([k]) => k === v) || [, ''])[1];
  return toCsv([
    ['N°', (f) => f.n], ['Titre', (f) => f.titre], ['Année', (f) => f.annee], ['Possédé', (f) => (byNum.get(f.n)?.owned ? 'oui' : 'non')],
    ['Format', (f) => byNum.get(f.n)?.format || ''], ['Édition', (f) => byNum.get(f.n)?.edition || ''],
    ['État', (f) => label(CONDITIONS, byNum.get(f.n)?.condition)], ['Note', (f) => byNum.get(f.n)?.notes || ''],
    ['Codes-barres', (f) => (byNum.get(f.n)?.barcodes || []).join(' ')], ['Ajouté le', (f) => (byNum.get(f.n)?.addedAt ? dateFr(byNum.get(f.n).addedAt) : '')],
  ], films);
}

export const disney = { id: 'disney', tabs, mount, route, leave, summary };
