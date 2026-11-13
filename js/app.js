// Vinyl Scanner — logique de l'interface (navigation, écrans, rendu).

import * as api from './discogs.js';
import * as db from './db.js';
import * as scanner from './scanner.js';
import { RARITY_LEVELS } from './rarity.js';
import * as coll from './collection.js';
import * as refresh from './refresh.js';
import * as backend from './core/backend.js';
import { games, priceJob, gamesCsv, refreshMissingGameInfo } from './games.js';
import { dvd, dvdCsv } from './dvd.js';
import { disney, disneyCsv, migrateLegacy as migrateDisney, fetchMissingPosters as fetchDisneyPosters } from './disney.js';
import { LIVE_CATNO, APP_VERSION } from './config.js';
import { regionFilterOn, setRegionFilter, regionToggleHtml, discogsCountryRank, importWarning } from './core/region.js';
import { setBeepEnabled, beepEnabled } from './core/camera.js';

const CACHE_MAX_AGE = 12 * 60 * 60 * 1000; // une fiche de moins de 12 h n'est pas re-téléchargée

import { $, esc, money, num, thumbHtml, deltaHtml, dateFr, download, timeAgo, toast, setLoading as setLoadingBase, setStatus } from './core/ui.js';
const setLoading = (on, text = 'Recherche sur Discogs…') => setLoadingBase(on, text);

api.setWaitListener((ms) => toast(`Limite Discogs atteinte : reprise dans ${Math.ceil(ms / 1000)} s…`));

// ---------- Navigation (par #hash, compatible bouton Retour du téléphone) ----------

const TABS = ['home', 'scan', 'catno', 'collection', 'history', 'settings'];
let collectionScroll = 0;
// Fiche ouverte depuis la collection (ou les stats) : inutile d'afficher l'alerte de possession.
let releaseFromCollection = false;
let currentView = null;
let searchState = null; // { result, items, label, method, query }
let pendingSource = null; // origine de la prochaine fiche ouverte (pour l'historique)

// ---------- Les 4 collections ----------

const SECTIONS = { games, dvd, disney };
let activeSection = null; // section Jeux / DVD / Disney affichée
let lastSection = 'home'; // pour la barre d'onglets de Réglages
let routeKey = null; // ex. 'games/collection'
const scrollMemory = {};

const ICON_HOME = '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>';
const ICON_SETTINGS = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
const ICON_VINYL = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>';
const ICON_GAME = '<svg viewBox="0 0 24 24"><path d="M6 9h12a4 4 0 0 1 4 4v1a3 3 0 0 1-5.2 2L15 14H9l-1.8 2A3 3 0 0 1 2 14v-1a4 4 0 0 1 4-4z"/></svg>';
const ICON_DVD = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 24 24"><path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z"/></svg>';
const ICON_SCAN = '<svg viewBox="0 0 24 24"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M16 8v8"/></svg>';
const ICON_HASH = '<svg viewBox="0 0 24 24"><path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"/></svg>';
const ICON_COLL = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="4" height="16" rx="1"/><rect x="9" y="4" width="4" height="16" rx="1"/><path d="M15.5 5.2l3.8-1 3.2 15.3-3.8 1z"/></svg>';
const ICON_CLOCK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

const SECTION_TABS = {
  home: [
    { tab: 'vinyl', href: '#/scan', label: 'Vinyles', icon: ICON_VINYL },
    { tab: 'games', href: '#/games/scan', label: 'Jeux', icon: ICON_GAME },
    { tab: 'dvd', href: '#/dvd/scan', label: 'DVD', icon: ICON_DVD },
    { tab: 'disney', href: '#/disney', label: 'Disney', icon: ICON_STAR },
  ],
  vinyl: [
    { tab: 'scan', href: '#/scan', label: 'Scanner', icon: ICON_SCAN },
    { tab: 'catno', href: '#/catno', label: 'N° cat.', icon: ICON_HASH },
    { tab: 'collection', href: '#/collection', label: 'Collection', icon: ICON_COLL },
    { tab: 'history', href: '#/history', label: 'Historique', icon: ICON_CLOCK },
  ],
  games: games.tabs,
  dvd: dvd.tabs,
  disney: disney.tabs,
};

function renderTabbar(section, activeTab) {
  const tabs = [{ tab: 'home', href: '#/home', label: 'Accueil', icon: ICON_HOME }, ...(SECTION_TABS[section] || []), { tab: 'settings', href: '#/settings', label: 'Réglages', icon: ICON_SETTINGS }];
  const nav = $('#tabbar');
  nav.style.gridTemplateColumns = `repeat(${tabs.length}, minmax(0, 1fr))`;
  nav.dataset.section = section;
  nav.innerHTML = tabs.map((t) => `<a href="${t.href}" data-tab="${t.tab}"${t.tab === activeTab ? ' class="active" aria-current="page"' : ''}>${t.icon}<span>${esc(t.label)}</span></a>`).join('');
}

function showView(el, title, isRoot) {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v !== el; });
  setLoading(false);
  $('#page-title').textContent = title;
  $('#back-btn').hidden = isRoot;
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter((p, i) => p || i === 0);
  const first = parts[0] || 'home';
  const prevKey = routeKey;
  routeKey = parts.slice(0, 2).join('/') || 'home';
  if (prevKey && /\/collection$|^collection$/.test(prevKey)) scrollMemory[prevKey] = window.scrollY;

  // On éteint toute caméra en changeant d'écran
  if (live?.isRunning() && first !== 'catno') live.stop();
  if (activeSection && activeSection !== SECTIONS[first]) { await activeSection.leave(); activeSection = null; }

  if (SECTIONS[first]) {
    if (currentView === 'scan') await scanner.stopCamera().then(updateCamUi);
    if (currentView === 'collection') collectionScroll = window.scrollY;
    currentView = `ext:${first}`;
    activeSection = SECTIONS[first];
    lastSection = first;
    const res = await activeSection.route(parts.slice(1), prevKey);
    if (location.hash.replace(/^#\/?/, '').split('/')[0] !== first) return; // l'utilisateur est déjà ailleurs
    showView(res.el, res.title, res.isRoot);
    renderTabbar(first, res.tab);
    $('#token-banner').hidden = true;
    window.scrollTo(0, 0);
    // Retour d'une fiche vers la collection : on retrouve sa position dans la liste
    if (/\/collection$/.test(routeKey) && prevKey && prevKey.startsWith(`${first}/item`)) {
      setTimeout(() => window.scrollTo(0, scrollMemory[routeKey] || 0), 250);
    }
    return;
  }

  const name = first === 'photo' ? 'photo' : first;
  const param = parts[1];
  const view = ['results', 'release', 'stats', 'photo', ...TABS].includes(name) ? name : 'home';

  if (currentView === 'scan' && view !== 'scan') await scanner.stopCamera().then(updateCamUi);
  if (currentView === 'collection' && view !== 'collection') collectionScroll = window.scrollY;
  const backToCollection = currentView === 'release' && view === 'collection';
  if (view === 'release' && currentView !== 'release') releaseFromCollection = ['collection', 'stats'].includes(currentView);
  currentView = view;

  const sectionEl = $(`#view-${view}`);
  showView(sectionEl, sectionEl.dataset.title, TABS.includes(view));
  const section = view === 'home' ? 'home' : view === 'settings' ? lastSection : 'vinyl';
  if (section !== 'home' && view !== 'settings') lastSection = 'vinyl';
  if (view === 'home') lastSection = 'home';
  const tab = view === 'stats' ? 'collection' : view === 'photo' ? 'catno' : view;
  renderTabbar(section, tab);
  $('#token-banner').hidden = !!api.getToken() || !['scan', 'catno', 'photo'].includes(view);
  window.scrollTo(0, 0);

  if (view === 'home') renderHome();
  if (view === 'scan') startVinylCam(); // la caméra démarre tout de suite
  if (view === 'collection') renderCollection().then(() => { if (backToCollection) window.scrollTo(0, collectionScroll); });
  if (view === 'stats') renderStats();

  if (view === 'history') renderHistory();
  if (view === 'settings') renderSettings();
  if (view === 'results') renderResults();
  if (view === 'release') openRelease(param);
}

window.addEventListener('hashchange', route);
$('#back-btn').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else go('#/home');
});

// ---------- Accueil ----------

async function renderHome() {
  try {
    const items = await db.getCollection();
    const s = coll.computeStats(items);
    $('#home-vinyl').textContent = items.length ? `${num(s.discs)} vinyle${s.discs > 1 ? 's' : ''} · ${money(s.total)}` : 'Aucun vinyle pour l\'instant';
  } catch { $('#home-vinyl').textContent = '—'; }
  const [g, d, dn] = await Promise.all([games.summary(), dvd.summary(), disney.summary()]);
  $('#home-games').textContent = g.count ? `${num(g.count)} jeu${g.count > 1 ? 'x' : ''} · ${money(g.total)}` : 'Aucun jeu pour l\'instant';
  $('#home-dvd').textContent = d.count ? `${num(d.count)} film${d.count > 1 ? 's' : ''}` : 'Aucun film pour l\'instant';
  $('#home-disney').textContent = dn.total ? `${num(dn.have)} / ${num(dn.total)} numérotés · ${num(dn.haveHors)} / ${num(dn.totalHors)} hors n°` : 'Classiques Disney';
  $('#home-disney-bar').style.width = `${dn.total ? (dn.have / dn.total) * 100 : 0}%`;
  $('#home-worker-banner').hidden = backend.isConfigured();
}

// ---------- Scan du n° de catalogue en direct (module isolé, voir js/config.js) ----------

let live = null;
if (LIVE_CATNO) {
  $('#live-catno-card').hidden = false;
  import('./livecatno.js').then(({ createLiveCatno }) => {
    live = createLiveCatno($('#live-catno'), {
      onPick: (value) => {
        $('#catno-input').value = value;
        searchCatno({ catno: value, artist: $('#catno-artist').value.trim(), label: $('#catno-label').value.trim() }, 'ocr');
      },
      onStatus: (text, type) => setStatus($('#live-status'), text, type),
    });
  }).catch(() => { $('#live-catno-card').hidden = true; });
}

// ---------- Indicateur « mise à jour des prix en cours » (vinyles ou jeux) ----------

function updatePill() {
  const vinylRunning = refresh.isRunning();
  const gamesRunning = priceJob.isRunning();
  const st = vinylRunning ? refresh.getState() : gamesRunning ? priceJob.getState() : null;
  const pct = st && st.ids?.length ? Math.round((st.index / st.ids.length) * 100) : 0;
  $('#job-pill').hidden = !st;
  $('#job-line').hidden = !st;
  $('#job-pill').href = gamesRunning && !vinylRunning ? '#/games/collection' : '#/collection';
  $('#job-pill-text').textContent = `${gamesRunning && !vinylRunning ? 'jeux ' : ''}${pct} %`;
  $('#job-line-bar').style.width = `${pct}%`;
}
window.addEventListener('jobprogress', updatePill);
priceJob.onChange(updatePill);

// ---------- Recherche commune ----------

async function runSearch(fn, { label, method, query }) {
  if (!api.getToken()) {
    toast('Ajoute d\'abord ton jeton Discogs dans Réglages.', 'error');
    go('#/settings');
    return;
  }
  document.querySelectorAll('.view').forEach((v) => { v.hidden = true; });
  setLoading(true);
  try {
    const result = await fn();
    searchState = { result, items: result.items, label, method, query };
    if (result.items.length === 1) {
      pendingSource = { method, query };
      go(`#/release/${result.items[0].id}`);
    } else {
      go('#/results');
    }
  } catch (e) {
    setLoading(false);
    route();
    toast(e.message || 'Erreur pendant la recherche.', 'error');
  }
}

// ---------- 1. Scan code-barres ----------

const camToggle = $('#cam-toggle');
const scanStatus = $('#scan-status');

function updateCamUi() {
  const on = scanner.isRunning('reader');
  $('#view-scan .camera').classList.toggle('on', on);
  camToggle.textContent = on ? 'Arrêter la caméra' : 'Démarrer la caméra';
  camToggle.className = on ? 'btn ghost' : 'btn primary';
}

function searchBarcode(code, method = 'barcode') {
  return runSearch(() => api.searchBarcode(code), { label: `code-barres ${code}`, method, query: code });
}

/** Allume la caméra de l'onglet Scanner (appelé dès l'ouverture de l'onglet). */
async function startVinylCam() {
  if (scanner.isRunning('reader')) return;
  camToggle.disabled = true;
  setStatus(scanStatus, "Ouverture de la caméra… (autorise l'accès si le téléphone le demande)");
  try {
    await scanner.startCamera('reader', (code) => {
      setStatus(scanStatus, `Code lu : ${code}`, 'ok');
      searchBarcode(code);
    }, { onState: updateCamUi });
    if (scanner.isRunning('reader')) setStatus(scanStatus, "Vise le code-barres. Touche l'image pour faire la mise au point.");
  } catch (e) {
    setStatus(scanStatus, scanner.cameraErrorMessage(e), 'error');
  } finally {
    camToggle.disabled = false;
    updateCamUi();
  }
}

camToggle.addEventListener('click', async () => {
  if (scanner.isRunning('reader')) {
    await scanner.stopCamera();
    updateCamUi();
    setStatus(scanStatus, 'Caméra arrêtée.');
    return;
  }
  startVinylCam();
});

$('#barcode-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  setStatus(scanStatus, 'Lecture de la photo…');
  const code = await scanner.scanImageFile('reader', file);
  updateCamUi();
  if (code) {
    setStatus(scanStatus, `Code lu : ${code}`, 'ok');
    searchBarcode(code);
  } else {
    setStatus(scanStatus, 'Aucun code-barres trouvé sur la photo. Rapproche-toi et évite les reflets.', 'error');
  }
});

$('#barcode-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#barcode-input').value.replace(/\s+/g, '');
  if (code) searchBarcode(code);
});

// ---------- 2. N° de catalogue ----------

function searchCatno({ catno, artist, label }, method) {
  const extra = [artist, label].filter(Boolean).join(' · ');
  return runSearch(() => api.searchCatno({ catno, artist, label }), {
    label: `« ${catno} »${extra ? ` (${extra})` : ''}`,
    method,
    query: catno,
  });
}

$('#catno-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const catno = $('#catno-input').value.trim();
  if (!catno) return;
  searchCatno({ catno, artist: $('#catno-artist').value.trim(), label: $('#catno-label').value.trim() }, 'catno');
});

// ---------- 3. Photo + lecture de texte (OCR) ----------

let ocrModule = null;

$('#ocr-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const img = $('#ocr-img');
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(file);
  $('#ocr-preview').hidden = false;
  $('#ocr-form').hidden = true;
  $('#ocr-progress').hidden = false;
  const bar = $('#ocr-bar');
  const status = $('#ocr-status');
  bar.style.width = '0%';
  try {
    ocrModule = ocrModule || (await import('./ocr.js'));
    const { text, candidates } = await ocrModule.recognize(file, ({ status: s, progress }) => {
      status.textContent = s;
      bar.style.width = `${Math.round((progress || 0) * 100)}%`;
    });
    $('#ocr-progress').hidden = true;
    $('#ocr-raw').textContent = text || '(aucun texte détecté)';
    const chips = $('#ocr-chips');
    chips.innerHTML = candidates.map((c, i) => `<button type="button" class="chip${i === 0 ? ' active' : ''}">${esc(c)}</button>`).join('');
    $('#ocr-chips-wrap').hidden = !candidates.length;
    $('#ocr-input').value = candidates[0] || text.split('\n')[0] || '';
    $('#ocr-form').hidden = false;
    if (!text) toast('Aucun texte lu. Reprends la photo plus près, avec plus de lumière.', 'error');
  } catch (err) {
    $('#ocr-progress').hidden = true;
    toast(err.message || 'La lecture de la photo a échoué.', 'error');
  }
});

$('#ocr-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  document.querySelectorAll('#ocr-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
  $('#ocr-input').value = chip.textContent;
});

$('#ocr-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('#ocr-input').value.trim();
  if (!value) return;
  const digits = value.replace(/[\s-]/g, '');
  if (/^\d{12,13}$/.test(digits)) return searchBarcode(digits, 'ocr');
  return searchCatno({ catno: value, artist: $('#ocr-artist').value.trim(), label: $('#ocr-label').value.trim() }, 'ocr');
});

// ---------- 4. Liste des résultats ----------

// Possession : rempli à l'affichage de la liste, utilisé aussi par « Afficher plus ».
let resultsOwnedById = new Map();

function resultItem(r) {
  const meta = [
    r.country && `<span>${esc(r.country)}</span>`,
    r.year && `<span><b>${esc(r.year)}</b></span>`,
    r.label && `<span>${esc(r.label)}</span>`,
    r.catno && r.catno !== 'none' && `<span>${esc(r.catno)}</span>`,
  ].filter(Boolean).join('');
  const mine = resultsOwnedById.get(r.id);
  const badge = mine ? `<span class="owned-badge">✓ Possédé${coll.quantityOf(mine) > 1 ? ` ×${coll.quantityOf(mine)}` : ''}</span>` : '';
  return `<li><a class="item${mine ? ' owned' : ''}" href="#/release/${r.id}" data-id="${r.id}">
    ${thumbHtml(r.thumb)}
    <div class="item-body">
      ${badge}
      <div class="item-title">${esc(r.title)}</div>
      <div class="item-artist">${esc(r.artist)}</div>
      <div class="item-meta">${meta}</div>
      <div class="item-meta">${esc(r.format)}</div>
    </div>
  </a></li>`;
}

/** Liste cliquable de mes versions d'un album. */
function versionsListHtml(items) {
  return `<ul>${items.map((v) => `<li><a href="#/release/${v.id}"><span>${esc(coll.versionLabel(v))}${coll.quantityOf(v) > 1 ? ` (×${coll.quantityOf(v)})` : ''}</span></a></li>`).join('')}</ul>`;
}

/** Bandeau rouge / orange / indicateur vert. */
function ownershipBannerHtml({ level, quantity, others }) {
  if (level === 'same') {
    return `<div class="own-banner same" role="alert">
      <strong>Vous avez déjà ce vinyle (même version) — quantité : ${quantity}</strong>
      ${others.length ? `Vous avez aussi ${others.length > 1 ? 'ces autres versions' : 'cette autre version'} :${versionsListHtml(others)}` : ''}
    </div>`;
  }
  if (level === 'album') {
    return `<div class="own-banner album" role="alert">
      <strong>Vous avez déjà cet album, mais dans une autre version</strong>
      ${others.length > 1 ? 'Vos versions' : 'Votre version'} :${versionsListHtml(others)}
    </div>`;
  }
  return '<div class="own-pill">Pas dans votre collection</div>';
}

async function renderResults() {
  if (!searchState) {
    $('#results-summary').textContent = 'Aucune recherche en cours.';
    $('#results-own').innerHTML = '';
    $('#results-list').innerHTML = '';
    $('#results-more').hidden = true;
    $('#results-empty').hidden = true;
    return;
  }
  const { result, label } = searchState;
  // Pressages français d'abord, puis européens ; hors Europe masqués si le filtre est activé
  const regionOn = regionFilterOn('vinyl');
  const sorted = searchState.items.map((r, i) => ({ r, i, k: discogsCountryRank(r.country) }))
    .sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.r);
  const items = regionOn ? sorted.filter((r) => discogsCountryRank(r.country) < 3) : sorted;
  const hidden = sorted.length - items.length;
  $('#results-region').innerHTML = sorted.length ? regionToggleHtml('vinyl', regionOn, hidden) : '';
  const n = result.total;
  const vinylOnly = result.query?.format === 'Vinyl';
  const warn = searchState.method === 'barcode' ? importWarning(searchState.query) : null;
  $('#results-summary').textContent = n
    ? `${warn ? `⚠ ${warn} ` : ''}${num(n)} version${n > 1 ? 's' : ''} ${vinylOnly ? 'vinyle ' : ''}trouvée${n > 1 ? 's' : ''} pour ${label}.${items.length ? ' Choisis la tienne :' : ' Aucune pressée en France ou en Europe : désactive le filtre pour les voir.'}`
    : '';

  let mine = [];
  try { mine = await db.getCollection(); } catch { /* base indisponible */ }
  if (currentView !== 'results') return;
  const own = coll.ownershipForResults(items, mine);
  resultsOwnedById = new Map(own.owned.map((r) => [r.id, r]));
  let banner = '';
  if (items.length) {
    if (own.owned.length) {
      const q = own.owned.reduce((s, r) => s + coll.quantityOf(r), 0);
      banner = ownershipBannerHtml({ level: 'same', quantity: q, others: own.others });
    } else if (own.others.length) {
      banner = ownershipBannerHtml({ level: 'album', others: own.others });
    } else {
      banner = ownershipBannerHtml({ level: 'none' });
    }
  }
  $('#results-own').innerHTML = banner;
  $('#results-list').innerHTML = items.map(resultItem).join('');
  $('#results-empty').hidden = n > 0;
  $('#results-more').hidden = result.page >= result.pages;
}

$('#results-region').addEventListener('click', (e) => {
  if (!e.target.closest('[data-region-toggle]')) return;
  setRegionFilter('vinyl', !regionFilterOn('vinyl'));
  renderResults();
});

$('#results-list').addEventListener('click', (e) => {
  if (e.target.closest('.item') && searchState) pendingSource = { method: searchState.method, query: searchState.query };
});

$('#results-more').addEventListener('click', async () => {
  const btn = $('#results-more');
  btn.disabled = true;
  btn.textContent = 'Chargement…';
  try {
    const next = await api.searchMore(searchState.result.query, searchState.result.page + 1);
    searchState.items = searchState.items.concat(next.items);
    searchState.result = { ...next, total: searchState.result.total };
    await renderResults(); // retri : pressages français d'abord
    btn.hidden = next.page >= next.pages;
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Afficher plus de résultats';
  }
});

// ---------- 5 & 6. Fiche du vinyle ----------

async function openRelease(id, { force = false } = {}) {
  const container = $('#release-content');
  const releaseId = Number(id);
  if (!releaseId) { go('#/scan'); return; }
  const source = pendingSource;
  pendingSource = null;

  let release = await db.getRelease(releaseId).catch(() => null);
  // Fiche complète (avec prix par état) de moins de 12 h : pas besoin de la retélécharger.
  const fresh = release?.detailFetchedAt && Date.now() - release.detailFetchedAt < CACHE_MAX_AGE;

  if (release) renderRelease(release);
  else container.innerHTML = '';

  if (!release || !fresh || force) {
    if (!release) setLoading(true, 'Chargement de la fiche…');
    try {
      const data = await api.fetchRelease(releaseId);
      if (currentView !== 'release' || location.hash !== `#/release/${releaseId}`) {
        await db.saveRelease(data); // l'utilisateur est parti : on garde quand même les données
        return;
      }
      release = await db.saveRelease(data);
      renderRelease(release);
      if (force) toast('Prix mis à jour.');
    } catch (e) {
      if (!release) container.innerHTML = `<div class="empty"><p>${esc(e.message)}</p><button class="btn primary" id="retry-btn">Réessayer</button></div>`;
      else {
        renderRelease(release);
        const when = release.market?.fetchedAt ? ` (données du ${dateFr(release.market.fetchedAt)})` : '';
        toast(`${e.message}${when}`, 'error');
      }
      $('#retry-btn')?.addEventListener('click', () => openRelease(releaseId));
      return;
    } finally {
      setLoading(false);
    }
  } else {
    await db.touchRelease(releaseId); // met à jour "vu le…" et le compteur
  }

  if (source) db.addHistory({ releaseId, method: source.method, query: source.query }).catch(() => {});
}

const CONDITION_KEYS = ['', ...api.CONDITION_ORDER];
const conditionOptions = (current) => CONDITION_KEYS.map((k) => `<option value="${k}"${k === (current || '') ? ' selected' : ''}>${k ? `${k} – ${api.CONDITION_LABELS[k]}` : 'Non renseigné'}</option>`).join('');

function collectionCardHtml(r) {
  if (!r.inCollection) {
    return `<button class="btn primary block" id="coll-add">
      <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg> Ajouter à ma collection</button>`;
  }
  const c = r.collection || {};
  const v = coll.valueOf(r);
  const info = r.valueInfo || {};
  const sourceTxt = info.source === 'recordscanner' ? 'prix importé de Record Scanner'
    : info.source === 'discogs' ? `prix le plus bas Discogs du ${dateFr(info.updatedAt)}` : '';
  const prevTxt = info.previous !== null && info.previous !== undefined
    ? `<p class="help">Valeur précédente : ${money(info.previous)}${info.previousAt ? ` (${dateFr(info.previousAt)})` : ''}</p>` : '';
  const noneTxt = info.noneForSale ? '<p class="help">Aucun exemplaire en vente lors du dernier contrôle : valeur conservée.</p>' : '';
  const q = coll.quantityOf(r);
  return `<form class="card form coll-form" id="coll-form" autocomplete="off">
    <h2><span class="badge-in">✓ Dans ma collection</span></h2>
    <div class="coll-value"><span class="value">${v !== null ? money(v) : '—'}</span>${deltaHtml(coll.valueDelta(r))}</div>
    <p class="help">${esc(sourceTxt)}${q > 1 && v !== null ? ` · ${q} exemplaires = ${money(v * q)}` : ''}</p>
    ${prevTxt}${noneTxt}
    <div class="grid2">
      <div><label for="c-cond">État du disque</label><select id="c-cond">${conditionOptions(c.condition)}</select></div>
      <div><label for="c-sleeve">État de la pochette</label><select id="c-sleeve">${conditionOptions(c.sleeveCondition)}</select></div>
      <div><label for="c-shelf">Étagère</label><input id="c-shelf" value="${esc(c.shelf ?? '')}"></div>
      <div><label for="c-pos">Position</label><input id="c-pos" value="${esc(c.positionInShelf ?? '')}"></div>
      <div><label for="c-qty">Quantité</label><input id="c-qty" type="number" min="1" max="99" inputmode="numeric" value="${q}"></div>
      <div><label for="c-added">Ajouté le</label><input id="c-added" value="${esc(dateFr(c.addedAt))}" disabled></div>
    </div>
    <label for="c-notes">Note perso</label>
    <textarea id="c-notes" rows="3" placeholder="ex. acheté en brocante, pochette signée…">${esc(c.notes || '')}</textarea>
    <button class="btn primary block" type="submit">Enregistrer</button>
    <button class="btn ghost block danger" type="button" id="coll-remove">Retirer de ma collection</button>
  </form>`;
}

function renderRelease(r) {
  $('#page-title').textContent = r.artist || 'Fiche';
  const m = r.market || {};
  const hasMarket = m.fetchedAt !== undefined;
  const level = r.rarity?.level;
  const sugg = m.suggestions;
  const suggCurrency = sugg ? Object.values(sugg)[0]?.currency : null;

  const labelsTxt = (r.labels || []).map((l) => `${esc(l.name)}${l.catno && l.catno !== 'none' ? ` – ${esc(l.catno)}` : ''}`).join('<br>');
  let grades;
  if (sugg) {
    grades = `<table class="grades">${api.CONDITION_ORDER.filter((k) => sugg[k]).map((k) => `<tr><td><span class="abbr">${k}</span>${api.CONDITION_LABELS[k]}</td><td>${money(sugg[k].value, sugg[k].currency)}</td></tr>`).join('')}</table>
       ${suggCurrency && suggCurrency !== 'EUR' ? `<p class="help">Ces prix sont dans la devise de ton compte Discogs (${esc(suggCurrency)}). Choisis EUR dans tes paramètres vendeur Discogs pour les avoir en euros.</p>` : ''}`;
  } else if (!r.detailFetchedAt) {
    grades = '<p class="help">Pas encore récupérés depuis Discogs (connexion nécessaire).</p>';
  } else {
    grades = '<p class="help">Prix suggérés par état indisponibles. Discogs ne les fournit qu\'aux comptes ayant rempli leurs <a href="https://www.discogs.com/settings/seller/" target="_blank" rel="noopener">paramètres vendeur</a>.</p>';
  }

  const tracks = (r.tracklist || []).map((t) => (t.heading
    ? `<li class="heading">${esc(t.title)}</li>`
    : `<li><span class="pos">${esc(t.position)}</span><span>${esc(t.title)}</span><span class="dur">${esc(t.duration)}</span></li>`)).join('');

  const hasLowest = m.lowestPrice !== null && m.lowestPrice !== undefined;
  const priceLabel = m.blockedFromSale ? 'vente interdite sur Discogs'
    : hasLowest ? `prix le plus bas actuel${m.currency && m.currency !== 'EUR' ? ` (${esc(m.currency)})` : ''}`
      : 'aucun exemplaire en vente';

  const priceCard = hasMarket ? `
      <div class="price-main">
        <span class="value">${m.blockedFromSale ? '—' : money(m.lowestPrice, m.currency || 'EUR')}</span>
        <span class="label">${priceLabel}</span>
      </div>
      <div class="stats">
        <div class="stat"><b>${num(m.numForSale)}</b><span>en vente</span></div>
        <div class="stat"><b>${num(r.community?.have)}</b><span>l'ont</span></div>
        <div class="stat"><b>${num(r.community?.want)}</b><span>le recherchent</span></div>
      </div>
      ${level ? `<div class="meter ${level}"><i></i><i></i><i></i></div>
      <span class="rarity ${level}">${esc(RARITY_LEVELS[level].label)}</span>
      <span class="help">&nbsp;${esc(RARITY_LEVELS[level].hint)}</span>` : ''}`
    : '<p class="help">Prix Discogs pas encore récupérés (connexion nécessaire).</p>';

  $('#release-content').innerHTML = `
    <div class="hero">
      ${r.coverUrl
    ? `<img class="cover" src="${esc(r.coverUrl)}" alt="Pochette" referrerpolicy="no-referrer" onerror="this.removeAttribute('src')">`
    : '<div class="cover placeholder" aria-hidden="true"></div>'}
      <div class="hero-text">
        <div class="artist">${esc(r.artist)}</div>
        <h2>${esc(r.title)}</h2>
      </div>
    </div>

    <div id="own-slot"></div>

    ${collectionCardHtml(r)}

    <div class="card">
      <h2>Prix &amp; rareté</h2>
      ${priceCard}
    </div>

    <div class="card">
      <h2>Prix suggérés par état</h2>
      ${grades}
    </div>

    <div class="card">
      <h2>Détails</h2>
      <dl class="facts">
        <dt>Label</dt><dd>${labelsTxt || '—'}</dd>
        <dt>Pays</dt><dd>${esc(r.country) || '—'}</dd>
        <dt>Sortie</dt><dd>${esc(r.released || r.year) || '—'}</dd>
        <dt>Format</dt><dd>${esc(r.formatText) || '—'}</dd>
        ${r.barcodes?.length ? `<dt>Code-barres</dt><dd>${r.barcodes.map(esc).join('<br>')}</dd>` : ''}
        ${r.genres?.length ? `<dt>Genres</dt><dd><div class="tags">${r.genres.map((g) => `<span class="tag">${esc(g)}</span>`).join('')}</div></dd>` : ''}
        ${r.styles?.length ? `<dt>Styles</dt><dd><div class="tags">${r.styles.map((s) => `<span class="tag style">${esc(s)}</span>`).join('')}</div></dd>` : ''}
      </dl>
    </div>

    ${tracks ? `<div class="card"><h2>Titres</h2><ol class="tracks">${tracks}</ol></div>` : ''}

    <a class="btn primary block" href="${esc(r.discogsUrl)}" target="_blank" rel="noopener">Voir sur Discogs</a>
    <button class="btn ghost block" id="refresh-btn">Actualiser les prix</button>
    ${hasMarket ? `<p class="updated">Prix Discogs du ${new Date(m.fetchedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</p>` : ''}
  `;
  $('#refresh-btn').addEventListener('click', (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Actualisation…';
    openRelease(r.id, { force: true });
  });
  bindCollectionCard(r);
  renderOwnership(r);
}

/** Compare la fiche à la collection et affiche le bandeau rouge / orange / vert. */
async function renderOwnership(r) {
  if (releaseFromCollection) return;
  let mine = [];
  try { mine = await db.getCollection(); } catch { return; }
  const slot = $('#own-slot');
  if (!slot || currentView !== 'release' || location.hash !== `#/release/${r.id}`) return;
  slot.innerHTML = ownershipBannerHtml(coll.ownership(r, mine));
}

function bindCollectionCard(r) {
  $('#coll-add')?.addEventListener('click', async () => {
    const rec = await db.updateRelease(r.id, (x) => {
      if (!x) return null;
      x.inCollection = 1;
      x.collection = {
        addedAt: Date.now(), quantity: 1, condition: '', sleeveCondition: '', notes: '',
        shelf: '', positionInShelf: '', format: api.formatCategory(x.formats) || x.formatText || '',
        source: 'app', importPrice: null, importCurrency: null, rsUniqueIds: [], tags: '', color: '',
      };
      return x;
    });
    if (rec) {
      toast('Ajouté à ta collection.');
      renderRelease(rec);
    }
  });

  $('#coll-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const qty = Math.min(99, Math.max(1, parseInt($('#c-qty').value, 10) || 1));
    const rec = await db.updateRelease(r.id, (x) => {
      if (!x?.collection) return null;
      Object.assign(x.collection, {
        condition: $('#c-cond').value,
        sleeveCondition: $('#c-sleeve').value,
        shelf: $('#c-shelf').value.trim(),
        positionInShelf: $('#c-pos').value.trim(),
        quantity: qty,
        notes: $('#c-notes').value.trim(),
      });
      return x;
    });
    if (rec) {
      toast('Modifications enregistrées.');
      renderRelease(rec);
    }
  });

  $('#coll-remove')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = 'Toucher encore pour confirmer';
      setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = 'Retirer de ma collection'; } }, 4000);
      return;
    }
    const rec = await db.updateRelease(r.id, (x) => {
      if (!x) return null;
      x.inCollection = 0;
      x.collection = null;
      return x;
    });
    toast('Retiré de ta collection.');
    if (rec) renderRelease(rec);
  });
}

// ---------- Collection ----------

const VIEW_KEY = 'collection_view';
let collView = { q: '', sort: 'artist', genre: '', format: '', shelf: '', layout: 'list' };
try { collView = { ...collView, ...JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') }; } catch { /* rien */ }
const saveCollView = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(collView)); } catch { /* rien */ } };
let collItems = [];

function fillSelect(sel, options, current, allLabel) {
  const opts = (allLabel ? [`<option value="">${allLabel}</option>`] : [])
    .concat(options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`));
  sel.innerHTML = opts.join('');
  sel.value = options.some(([v]) => v === current) ? current : (allLabel ? '' : options[0]?.[0] ?? '');
  if (allLabel) sel.classList.toggle('active', !!sel.value);
  return sel.value;
}

function collectionItemHtml(r) {
  const v = coll.valueOf(r);
  const q = coll.quantityOf(r);
  return `<li><a class="item" href="#/release/${r.id}">
    ${thumbHtml(r.thumbUrl)}
    <div class="item-body">
      <div class="item-title">${esc(r.title)}</div>
      <div class="item-artist">${esc(r.artist)}</div>
      <div class="item-meta">${r.year ? `<span><b>${esc(r.year)}</b></span>` : ''}<span>${esc(coll.formatOf(r))}</span>${q > 1 ? `<span class="qty">×${q}</span>` : ''}${r.collection?.condition ? `<span>${esc(r.collection.condition)}</span>` : ''}</div>
    </div>
    <div class="item-side">
      <div class="val">${v !== null ? money(v) : '—'}</div>
      <div>${deltaHtml(coll.valueDelta(r))}</div>
    </div>
  </a></li>`;
}

async function renderCollection() {
  try { collItems = await db.getCollection(); } catch { collItems = []; }
  if (currentView !== 'collection') return;
  const stats = coll.computeStats(collItems);
  $('#coll-total').textContent = collItems.length ? money(stats.total) : '—';
  $('#coll-count').textContent = collItems.length
    ? `${num(stats.discs)} vinyle${stats.discs > 1 ? 's' : ''} · valeur estimée totale`
    : 'Aucun vinyle pour l\'instant';
  $('#job-card').hidden = !collItems.length;
  $('.toolbar').hidden = !collItems.length;

  const opts = coll.filterOptions(collItems);
  collView.sort = fillSelect($('#coll-sort'), Object.entries(coll.SORTS), collView.sort, '');
  collView.genre = fillSelect($('#coll-genre'), opts.genres.map((g) => [g, g]), collView.genre, 'Tous les genres');
  collView.format = fillSelect($('#coll-format'), opts.formats.map((f) => [f, f]), collView.format, 'Tous les formats');
  collView.shelf = fillSelect($('#coll-shelf'), opts.shelves.map((s) => [s, `Étagère ${s}`]), collView.shelf, 'Toutes les étagères');
  $('#coll-search').value = collView.q;
  renderCollectionList();
  renderJob(refresh.getState());
}

function collectionCardGridHtml(r) {
  const v = coll.valueOf(r);
  return `<li><a class="gcard" href="#/release/${r.id}">
    ${thumbHtml(r.coverUrl || r.thumbUrl, 'thumb gcover')}
    <div class="gtitle">${esc(r.title)}</div>
    <div class="gartist">${esc(r.artist)}</div>
    <div class="gmeta"><span>${esc(r.year || '')}</span><b>${v !== null ? money(v) : '—'}</b></div>
  </a></li>`;
}

function renderCollectionList() {
  const filters = { q: collView.q, genre: collView.genre, format: collView.format, shelf: collView.shelf };
  const shown = coll.sortItems(coll.filterItems(collItems, filters), collView.sort);
  const grid = collView.layout === 'grid';
  $('#coll-list').classList.toggle('grid', grid);
  document.querySelectorAll('#coll-layout button').forEach((b) => b.classList.toggle('on', b.dataset.layout === collView.layout));
  $('#coll-list').innerHTML = shown.map(grid ? collectionCardGridHtml : collectionItemHtml).join('');
  const filtered = !!(filters.q || filters.genre || filters.format || filters.shelf);
  $('#coll-reset').hidden = !filtered;
  $('#coll-empty').hidden = collItems.length > 0;
  if (!collItems.length) $('#coll-shown').textContent = '';
  else if (filtered) {
    const total = shown.reduce((s, r) => s + (coll.valueOf(r) ?? 0) * coll.quantityOf(r), 0);
    $('#coll-shown').textContent = shown.length
      ? `${num(shown.length)} résultat${shown.length > 1 ? 's' : ''} · ${money(total)}`
      : 'Aucun disque ne correspond.';
  } else {
    $('#coll-shown').textContent = `${num(shown.length)} références`;
  }
}

let searchTimer;
$('#coll-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { collView.q = e.target.value; saveCollView(); renderCollectionList(); }, 150);
});
[['#coll-sort', 'sort'], ['#coll-genre', 'genre'], ['#coll-format', 'format'], ['#coll-shelf', 'shelf']].forEach(([sel, key]) => {
  $(sel).addEventListener('change', (e) => {
    collView[key] = e.target.value;
    if (key !== 'sort') e.target.classList.toggle('active', !!e.target.value);
    saveCollView();
    renderCollectionList();
  });
});
$('#coll-layout').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-layout]');
  if (!b) return;
  collView.layout = b.dataset.layout;
  saveCollView();
  renderCollectionList();
});
$('#coll-reset').addEventListener('click', () => {
  Object.assign(collView, { q: '', genre: '', format: '', shelf: '' });
  saveCollView();
  ['#coll-genre', '#coll-format', '#coll-shelf'].forEach((s) => { $(s).value = ''; $(s).classList.remove('active'); });
  $('#coll-search').value = '';
  renderCollectionList();
});

// ---------- Mise à jour des prix de la collection ----------

function renderJob(st) {
  const running = refresh.isRunning();
  const pct = st && st.ids?.length ? Math.round((st.index / st.ids.length) * 100) : 0;
  // Indicateur visible sur tous les écrans pendant la mise à jour
  updatePill();

  if (currentView !== 'collection') return;
  const btn = $('#job-btn');
  const text = $('#job-text');
  $('#job-progress').hidden = !(st && (running || st.status === 'paused'));
  $('#job-bar').style.width = `${pct}%`;
  if (running) {
    const minutes = Math.max(1, Math.round((st.remainingSeconds || 0) / 60));
    text.textContent = `Mise à jour : ${st.index} / ${st.ids.length} — environ ${minutes} min restante${minutes > 1 ? 's' : ''}. Tu peux utiliser l'appli, mais garde-la ouverte.`;
    btn.textContent = 'Pause';
    btn.className = 'btn ghost';
  } else if (st?.status === 'paused') {
    text.textContent = `En pause : ${st.index} / ${st.ids.length} disques faits.${st.lastError ? ` ${st.lastError}` : ''}`;
    btn.textContent = 'Reprendre';
    btn.className = 'btn primary';
  } else if (refresh.getFillState().running) {
    const f = refresh.getFillState();
    text.textContent = `Récupération des pochettes et infos Discogs en arrière-plan : ${f.done} / ${f.total}. Tu peux utiliser l'appli normalement.`;
    btn.textContent = 'Actualiser les prix';
    btn.className = 'btn primary';
  } else {
    const last = st?.lastCompletedAt;
    let txt = last ? `Dernière mise à jour : ${new Date(last).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Prix jamais mis à jour depuis Discogs.';
    if (st?.status === 'done' && typeof st.totalAfter === 'number' && typeof st.totalBefore === 'number') {
      const d = Math.round((st.totalAfter - st.totalBefore) * 100) / 100;
      txt += ` · total ${money(st.totalBefore)} → ${money(st.totalAfter)} (${d >= 0 ? '+' : '−'}${money(Math.abs(d))})`;
      if (st.failed) txt += ` · ${st.failed} introuvable${st.failed > 1 ? 's' : ''} sur Discogs`;
    }
    text.textContent = txt;
    btn.textContent = 'Actualiser les prix';
    btn.className = 'btn primary';
  }
}

let jobRenderTimer;
refresh.onChange((st) => {
  renderJob(st);
  if (!st) return;
  // On rafraîchit la liste de temps en temps pendant la mise à jour (pas à chaque disque).
  if (currentView === 'collection' && (!refresh.isRunning() || st.index % 10 === 0)) {
    clearTimeout(jobRenderTimer);
    jobRenderTimer = setTimeout(() => {
      if (currentView !== 'collection') return;
      const y = window.scrollY;
      renderCollection().then(() => window.scrollTo(0, y));
    }, 300);
  }
  if (!refresh.isRunning() && st.status === 'done') toast('Mise à jour des prix terminée.');
  if (!refresh.isRunning() && st.status === 'paused' && st.lastError) toast(`Mise à jour en pause : ${st.lastError}`, 'error');
});

$('#job-btn').addEventListener('click', async () => {
  if (refresh.isRunning()) { refresh.pause(); toast('Pause après le disque en cours…'); return; }
  const st = refresh.getState();
  try {
    await refresh.start({ resume: st?.status === 'paused' });
  } catch (e) {
    toast(e.message, 'error');
  }
});

// ---------- Statistiques ----------

async function renderStats() {
  const box = $('#stats-content');
  let items = [];
  try { items = await db.getCollection(); } catch { /* rien */ }
  if (currentView !== 'stats') return;
  if (!items.length) {
    box.innerHTML = '<div class="empty"><p>Ta collection est vide.</p></div>';
    return;
  }
  const s = coll.computeStats(items);
  const st = refresh.getState();
  const totalDelta = s.comparable
    ? Math.round(items.reduce((acc, r) => acc + (coll.valueDelta(r) ?? 0) * coll.quantityOf(r), 0) * 100) / 100
    : null;

  const maxG = Math.max(...s.genres.map(([, n]) => n), 1);
  const genres = s.genres.map(([g, n]) => `<div class="hbar" title="${esc(g)} : ${n}">
      <span class="name">${esc(g)}</span>
      <span class="track"><span class="fill" style="display:block;width:${(n / maxG) * 100}%"></span></span>
      <span class="n">${n}</span></div>`).join('');

  const maxD = Math.max(...s.decades.map(([, n]) => n), 1);
  const decadesBars = s.decades.map(([d, n]) => `<div class="vbar" title="Années ${d} : ${n}">
      <span class="n">${n}</span><span class="fill" style="height:${(n / maxD) * 100}%"></span></div>`).join('');
  const decadesLabels = s.decades.map(([d]) => `<span>${d}</span>`).join('');

  const top = s.top.map((r) => `<li><a href="#/release/${r.id}">
      ${thumbHtml(r.thumbUrl)}
      <span class="t"><div>${esc(r.title)}</div><div class="a">${esc(r.artist)}${r.year ? ` · ${r.year}` : ''}</div></span>
      <span class="p">${money(coll.valueOf(r))}</span></a></li>`).join('');

  box.innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="k">Vinyles</div><div class="v">${num(s.discs)}</div><div class="s">${num(s.references)} références</div></div>
      <div class="tile"><div class="k">Valeur totale</div><div class="v">${money(s.total)}</div><div class="s">${totalDelta !== null ? `${deltaHtml(totalDelta)} vs avant` : 'estimée'}</div></div>
      <div class="tile"><div class="k">Valeur moyenne</div><div class="v">${s.average !== null ? money(s.average) : '—'}</div><div class="s">par vinyle</div></div>
      <div class="tile"><div class="k">Prix mis à jour</div><div class="v" style="font-size:1.05rem">${st?.lastCompletedAt ? dateFr(st.lastCompletedAt) : 'Jamais'}</div><div class="s">${s.valued < s.discs ? `${num(s.discs - s.valued)} sans prix` : 'tous ont un prix'}</div></div>
    </div>

    <div class="card">
      <h2>Top 10 des plus chers</h2>
      <ol class="top10">${top}</ol>
    </div>

    <div class="card">
      <h2>Par genre</h2>
      <div class="hbars">${genres}</div>
      <p class="help">Nombre de vinyles. Un disque peut avoir plusieurs genres.</p>
    </div>

    <div class="card">
      <h2>Par décennie</h2>
      ${s.decades.length ? `<div class="vbars">${decadesBars}</div><div class="vlabels">${decadesLabels}</div>` : ''}
      <p class="help">Nombre de vinyles par décennie de sortie${s.unknownYear ? ` · ${num(s.unknownYear)} sans année connue` : ''}.</p>
    </div>
  `;
}

// ---------- 7. Historique ----------

const METHOD_LABELS = { barcode: 'Code-barres', catno: 'N° cat.', ocr: 'Lecture n°' };

async function renderHistory() {
  const list = $('#history-list');
  let items = [];
  try { items = await db.getHistory(60); } catch { /* base indisponible (navigation privée…) */ }
  if (currentView !== 'history') return;
  list.innerHTML = items.map(({ release: r, at, method }) => `
    <li><a class="item" href="#/release/${r.id}">
      ${thumbHtml(r.thumbUrl)}
      <div class="item-body">
        <div class="item-title">${esc(r.title)}</div>
        <div class="item-artist">${esc(r.artist)}</div>
        <div class="item-meta"><span>${esc([r.country, r.year].filter(Boolean).join(' · '))}</span><span>${esc(r.catno && r.catno !== 'none' ? r.catno : '')}</span></div>
      </div>
      <div class="item-side">
        <div><b>${r.market?.lowestPrice != null ? money(r.market.lowestPrice, r.market.currency) : ''}</b></div>
        <div>${esc(METHOD_LABELS[method] || '')}</div>
        <div>${esc(timeAgo(at))}</div>
      </div>
    </a></li>`).join('');
  $('#history-empty').hidden = items.length > 0;
  $('#history-clear').hidden = items.length === 0;
}

$('#history-clear').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = 'Toucher encore pour confirmer';
    setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = "Effacer l'historique"; }, 4000);
    return;
  }
  btn.dataset.confirm = '';
  btn.textContent = "Effacer l'historique";
  await db.clearHistory();
  toast('Historique effacé. Les fiches restent enregistrées pour ta future collection.');
  renderHistory();
});

// ---------- Import Record Scanner ----------

function parseCsvFile(file) {
  return new Promise((resolve, reject) => {
    if (!window.Papa) { reject(new Error('Le module de lecture CSV ne s\'est pas chargé. Recharge la page.')); return; }
    window.Papa.parse(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.replace(/^﻿/, '').trim(),
      complete: (res) => resolve(res),
      error: (err) => reject(new Error(`Fichier illisible : ${err.message || err}`)),
    });
  });
}

$('#rs-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const box = $('#rs-result');
  box.hidden = false;
  box.innerHTML = '<p class="help">Lecture du fichier…</p>';
  try {
    const { data, meta, errors } = await parseCsvFile(file);
    if (!meta.fields?.includes(coll.RS_REQUIRED)) {
      throw new Error('Ce fichier ne ressemble pas à un export Record Scanner (colonne « DiscogsReleaseId » absente).');
    }
    const existing = await db.getAllReleasesMap();
    const { records, summary } = coll.prepareImport(data, existing);
    await db.putMany(records);
    // Lignes que le lecteur CSV n'a pas pu découper correctement
    const parseErrors = errors.filter((er) => er.type !== 'Delimiter');
    const errorsTotal = summary.errors + parseErrors.length;
    const details = [
      ...summary.errorDetails,
      ...parseErrors.map((er) => `Ligne ${er.row !== undefined ? er.row + 2 : '?'} : ${er.message}`),
    ];
    box.innerHTML = `
      <div class="import-nums">
        <div class="stat"><b>${num(summary.imported)}</b><span>importés</span></div>
        <div class="stat"><b>${num(summary.duplicates)}</b><span>doublons</span></div>
        <div class="stat${errorsTotal ? ' err' : ''}"><b>${num(errorsTotal)}</b><span>erreurs</span></div>
      </div>
      <p class="help">${num(summary.rows)} lignes lues : ${num(summary.created)} nouveaux disques, ${num(summary.updated)} complétés, ${num(summary.unchanged)} déjà importés (inchangés).
      ${summary.duplicates ? 'Les doublons (même disque plusieurs fois) sont regroupés en un seul disque avec une quantité.' : ''}</p>
      ${details.length ? `<ul>${details.slice(0, 20).map((d) => `<li>${esc(d)}</li>`).join('')}${details.length > 20 ? `<li>… et ${details.length - 20} autres</li>` : ''}</ul>` : ''}
      <a class="btn ghost block" href="#/collection">Voir ma collection</a>`;
    renderSettingsStats();
    refresh.startBackgroundFill();
  } catch (err) {
    box.innerHTML = `<p class="status error">${esc(err.message || 'Import impossible.')}</p>`;
  }
});

// ---------- Sauvegarde ----------

const today = () => new Date().toISOString().slice(0, 10);

$('#export-csv-btn').addEventListener('click', async () => {
  try {
    const items = coll.sortItems(await db.getCollection(), 'artist');
    if (!items.length) { setStatus($('#backup-status'), 'Ta collection est vide.', 'error'); return; }
    download(`ma-collection-vinyles-${today()}.csv`, coll.collectionToCsv(items), 'text/csv;charset=utf-8');
    setStatus($('#backup-status'), `${num(items.length)} disques exportés en CSV.`, 'ok');
  } catch (e) {
    setStatus($('#backup-status'), `Export impossible : ${e.message}`, 'error');
  }
});

$('#export-btn').addEventListener('click', async () => {
  try {
    const data = await db.exportAll();
    download(`sauvegarde-complete-${today()}.json`, JSON.stringify(data), 'application/json');
    setStatus($('#backup-status'), `Sauvegarde créée (${num(data.releases.length)} fiches). Garde-la en lieu sûr (Drive, mail…).`, 'ok');
  } catch (e) {
    setStatus($('#backup-status'), `Export impossible : ${e.message}`, 'error');
  }
});

$('#restore-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const status = $('#backup-status');
  setStatus(status, 'Restauration…');
  try {
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('Ce fichier n\'est pas un JSON valide.'); }
    const res = await db.importBackup(data);
    await migrateDisney().catch(() => {}); // ancienne sauvegarde Disney (v2.0) : rattachement à la nouvelle liste
    const parts = [];
    if (res.releases) parts.push(`${num(res.releases)} fiches vinyles (dont ${num(res.inCollection)} en collection)`);
    if (res.games) parts.push(`${num(res.games)} jeux`);
    if (res.dvds) parts.push(`${num(res.dvds)} DVD`);
    if (res.disney) parts.push(`${num(res.disney)} films Disney`);
    setStatus(status, `✓ Restauré : ${parts.join(', ') || 'rien à restaurer'}.`, 'ok');
    renderSettingsStats();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

// ---------- Réglages ----------

async function renderSettingsStats() {
  try {
    const [n, items, g, d, dn] = await Promise.all([db.countReleases(), db.getCollection(), games.summary(), dvd.summary(), disney.summary()]);
    const discs = items.reduce((s, r) => s + coll.quantityOf(r), 0);
    $('#data-stats').textContent = `Sur ce téléphone : ${num(discs)} vinyle${discs > 1 ? 's' : ''} (${num(n)} fiches), ${num(g.count)} jeu${g.count > 1 ? 'x' : ''}, ${num(d.count)} DVD, ${num(dn.have + dn.haveHors)} films Disney.`;
  } catch {
    $('#data-stats').textContent = 'Stockage local indisponible (navigation privée ?).';
  }
}

async function renderSettings() {
  const input = $('#token-input');
  input.value = api.getToken();
  setStatus($('#token-status'), api.getToken() ? 'Jeton enregistré sur ce téléphone.' : 'Aucun jeton enregistré.');
  $('#worker-input').value = backend.getWorkerUrl();
  $('#beep-toggle').checked = beepEnabled();
  renderSettingsStats();
  db.getSnapshot().then((snap) => { $('#snapshot-btn').hidden = !snap; }).catch(() => {});
}

$('#beep-toggle').addEventListener('change', (e) => { setBeepEnabled(e.target.checked); toast(e.target.checked ? 'Bip activé.' : 'Bip désactivé.'); });

// ---------- Serveur (Cloudflare Worker) ----------

const checkLine = (ok, label, hint) => `<div class="wcheck ${ok ? 'ok' : 'ko'}"><span aria-hidden="true">${ok ? '✓' : '✗'}</span><div><b>${esc(label)}</b>${ok ? '' : `<small>${esc(hint)}</small>`}</div></div>`;

$('#worker-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = backend.setWorkerUrl($('#worker-input').value);
  $('#worker-input').value = url;
  const box = $('#worker-checks');
  if (!url) { box.innerHTML = '<p class="status">Adresse effacée de ce téléphone.</p>'; return; }
  box.innerHTML = '<p class="status">Test du serveur…</p>';
  let h;
  try {
    h = await backend.health();
  } catch (err) {
    box.innerHTML = checkLine(false, 'Serveur injoignable', `${err.message} Vérifie l'adresse (elle se termine par .workers.dev).`);
    return;
  }
  // On fait un vrai petit appel à chaque service pour vérifier les clés
  const test = async (enabled, fn) => { if (!enabled) return 'Clé absente du Worker.'; try { await fn(); return ''; } catch (err) { return err.message; } };
  const [igdbErr, ebayErr, tmdbErr] = await Promise.all([
    test(h.igdb, () => backend.igdb('games', 'fields name; limit 1;')),
    test(h.ebay, () => backend.ebaySearch({ q: 'zelda switch', limit: 1 })),
    test(h.tmdb, () => backend.tmdb('configuration')),
  ]);
  box.innerHTML = checkLine(true, 'Serveur joignable', '')
    + checkLine(!igdbErr, 'IGDB — infos et jaquettes des jeux', `${igdbErr} (TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET)`)
    + checkLine(!ebayErr, 'eBay — prix des jeux', `${ebayErr} (EBAY_CLIENT_ID et EBAY_CLIENT_SECRET)`)
    + checkLine(!tmdbErr, 'TMDB — DVD et affiches Disney', `${tmdbErr} (TMDB_TOKEN)`);
  if (!igdbErr && !ebayErr && !tmdbErr) toast('Serveur prêt : tout fonctionne !');
  if (!tmdbErr) fetchDisneyPosters(); // affiches Disney récupérées en arrière-plan
});

// ---------- Sauvegardes par collection ----------

const SECTION_NAMES = { vinyl: 'vinyles', game: 'jeux-video', dvd: 'dvd', disney: 'disney' };

document.querySelectorAll('[data-export]').forEach((btn) => btn.addEventListener('click', async () => {
  const section = btn.dataset.export;
  try {
    const data = await db.exportAll(section);
    download(`sauvegarde-${SECTION_NAMES[section]}-${today()}.json`, JSON.stringify(data), 'application/json');
    setStatus($('#backup-status'), 'Sauvegarde créée. Garde-la en lieu sûr (Drive, mail…).', 'ok');
  } catch (e) {
    setStatus($('#backup-status'), `Export impossible : ${e.message}`, 'error');
  }
}));

document.querySelectorAll('[data-csv]').forEach((btn) => btn.addEventListener('click', async () => {
  const section = btn.dataset.csv;
  try {
    let csv;
    if (section === 'disney') csv = await disneyCsv();
    else {
      const items = await db.getItems(section, { ownedOnly: true });
      if (!items.length) { setStatus($('#backup-status'), 'Cette collection est vide.', 'error'); return; }
      csv = section === 'game' ? gamesCsv(items) : dvdCsv(items);
    }
    download(`ma-collection-${SECTION_NAMES[section]}-${today()}.csv`, csv, 'text/csv;charset=utf-8');
    setStatus($('#backup-status'), 'Fichier CSV créé.', 'ok');
  } catch (e) {
    setStatus($('#backup-status'), `Export impossible : ${e.message}`, 'error');
  }
}));

$('#snapshot-btn').addEventListener('click', async () => {
  const snap = await db.getSnapshot();
  if (!snap) return;
  // Même format qu'une sauvegarde v1 : restaurable tel quel
  const data = { app: 'vinyl-scanner', dbVersion: 1, exportedAt: new Date(snap.createdAt).toISOString(), releases: snap.releases, history: snap.history };
  download(`copie-securite-vinyles-avant-v2-${today()}.json`, JSON.stringify(data), 'application/json');
  setStatus($('#backup-status'), `Copie de sécurité du ${dateFr(snap.createdAt)} : ${num(snap.releases.length)} fiches vinyles.`, 'ok');
});

$('#token-show').addEventListener('click', () => {
  const input = $('#token-input');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('#token-show').textContent = show ? 'Masquer' : 'Voir';
});

$('#token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#token-status');
  const value = $('#token-input').value.trim();
  if (!value) { setStatus(status, 'Colle d\'abord ton jeton.', 'error'); return; }
  if (/\s/.test(value)) { setStatus(status, 'Le jeton ne doit pas contenir d\'espace.', 'error'); return; }
  const previous = api.getToken();
  api.setToken(value);
  setStatus(status, 'Vérification auprès de Discogs…');
  try {
    const user = await api.checkToken();
    setStatus(status, `✓ Jeton valide — connecté en tant que ${user}.`, 'ok');
    refresh.startBackgroundFill();
    $('#token-banner').hidden = true;
  } catch (err) {
    if (err.status === 401) {
      api.setToken(previous);
      setStatus(status, 'Jeton refusé par Discogs. Vérifie que tu l\'as copié en entier.', 'error');
    } else {
      setStatus(status, `Jeton enregistré, mais vérification impossible : ${err.message}`, 'error');
    }
  }
});

$('#token-delete').addEventListener('click', () => {
  api.setToken('');
  $('#token-input').value = '';
  setStatus($('#token-status'), 'Jeton supprimé de ce téléphone.');
});

// ---------- Démarrage ----------

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
// Demande au navigateur de ne pas effacer la base locale si l'espace manque.
navigator.storage?.persist?.().catch(() => {});

// Les écrans Jeux vidéo, DVD et Disney sont construits au démarrage
[games, dvd, disney].forEach((sec) => sec.mount($('#main')));
db.onBlocked(() => toast('Mise à jour de la base en attente : ferme les autres onglets ou fenêtres de l\'appli.', 'error'));
$('#app-version').textContent = `Vinyl Scanner · v${APP_VERSION} · Discogs, IGDB, eBay, TMDB`;
if (!location.hash) location.hash = '#/home';
route();
renderJob(refresh.getState());
// Récupère tranquillement les pochettes / masters manquants quelques secondes après l'ouverture.
setTimeout(() => refresh.startBackgroundFill(), 4000);
// Affiches Disney manquantes (si le serveur est configuré), gardées en cache sur le téléphone
setTimeout(() => fetchDisneyPosters(), 8000);
// Jaquettes et titres français manquants des jeux déjà enregistrés
setTimeout(() => refreshMissingGameInfo(), 12000);
