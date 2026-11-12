// Vinyl Scanner — logique de l'interface (navigation, écrans, rendu).

import * as api from './discogs.js';
import * as db from './db.js';
import * as scanner from './scanner.js';
import { RARITY_LEVELS } from './rarity.js';

const $ = (sel) => document.querySelector(sel);
const CACHE_MAX_AGE = 12 * 60 * 60 * 1000; // une fiche de moins de 12 h n'est pas re-téléchargée

// ---------- Utilitaires ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(value, currency = 'EUR') {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}
const num = (n) => (n === null || n === undefined ? '—' : new Intl.NumberFormat('fr-FR').format(n));

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  if (s < 86400 * 7) return `il y a ${Math.round(s / 86400)} j`;
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

let toastTimer;
function toast(message, type = '') {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast ${type}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, type === 'error' ? 5000 : 3000);
}

function setLoading(on, text = 'Recherche sur Discogs…') {
  $('#loader').hidden = !on;
  $('#loader-text').textContent = text;
}

function setStatus(el, text, type = '') {
  el.textContent = text;
  el.className = `status ${type}`;
}

api.setWaitListener((ms) => toast(`Limite Discogs atteinte : reprise dans ${Math.ceil(ms / 1000)} s…`));

// ---------- Navigation (par #hash, compatible bouton Retour du téléphone) ----------

const TABS = ['scan', 'catno', 'photo', 'history', 'settings'];
let currentView = null;
let searchState = null; // { result, items, label, method, query }
let pendingSource = null; // origine de la prochaine fiche ouverte (pour l'historique)

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const [, name = 'scan', param] = location.hash.replace(/^#\/?/, '#/').split('/');
  const view = ['results', 'release', ...TABS].includes(name) ? name : 'scan';

  if (currentView === 'scan' && view !== 'scan') await scanner.stopCamera().then(updateCamUi);
  currentView = view;

  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  setLoading(false);
  const section = $(`#view-${view}`);
  $('#page-title').textContent = section.dataset.title;
  $('#back-btn').hidden = TABS.includes(view);
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === view));
  $('#token-banner').hidden = !!api.getToken() || view === 'settings' || view === 'history';
  window.scrollTo(0, 0);

  if (view === 'history') renderHistory();
  if (view === 'settings') renderSettings();
  if (view === 'results') renderResults();
  if (view === 'release') openRelease(param);
}

window.addEventListener('hashchange', route);
$('#back-btn').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else go('#/scan');
});

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
  const on = scanner.isRunning();
  $('.camera').classList.toggle('on', on);
  camToggle.textContent = on ? 'Arrêter la caméra' : 'Démarrer la caméra';
  camToggle.className = on ? 'btn ghost' : 'btn primary';
}

function searchBarcode(code, method = 'barcode') {
  return runSearch(() => api.searchBarcode(code), { label: `code-barres ${code}`, method, query: code });
}

camToggle.addEventListener('click', async () => {
  if (scanner.isRunning()) {
    await scanner.stopCamera();
    updateCamUi();
    setStatus(scanStatus, '');
    return;
  }
  camToggle.disabled = true;
  setStatus(scanStatus, "Ouverture de la caméra… (autorise l'accès si le téléphone le demande)");
  try {
    await scanner.startCamera('reader', (code) => {
      updateCamUi();
      setStatus(scanStatus, `Code lu : ${code}`, 'ok');
      searchBarcode(code);
    });
    setStatus(scanStatus, 'Vise le code-barres, bien à plat et éclairé.');
  } catch (e) {
    setStatus(scanStatus, scanner.cameraErrorMessage(e), 'error');
  } finally {
    camToggle.disabled = false;
    updateCamUi();
  }
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

function resultItem(r) {
  const meta = [
    r.country && `<span>${esc(r.country)}</span>`,
    r.year && `<span><b>${esc(r.year)}</b></span>`,
    r.label && `<span>${esc(r.label)}</span>`,
    r.catno && r.catno !== 'none' && `<span>${esc(r.catno)}</span>`,
  ].filter(Boolean).join('');
  return `<li><a class="item" href="#/release/${r.id}" data-id="${r.id}">
    <img class="thumb" src="${esc(r.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.removeAttribute('src')">
    <div class="item-body">
      <div class="item-title">${esc(r.title)}</div>
      <div class="item-artist">${esc(r.artist)}</div>
      <div class="item-meta">${meta}</div>
      <div class="item-meta">${esc(r.format)}</div>
    </div>
  </a></li>`;
}

function renderResults() {
  if (!searchState) {
    $('#results-summary').textContent = 'Aucune recherche en cours.';
    $('#results-list').innerHTML = '';
    $('#results-more').hidden = true;
    $('#results-empty').hidden = true;
    return;
  }
  const { result, items, label } = searchState;
  const n = result.total;
  const vinylOnly = result.query?.format === 'Vinyl';
  $('#results-summary').textContent = n
    ? `${num(n)} version${n > 1 ? 's' : ''} ${vinylOnly ? 'vinyle ' : ''}trouvée${n > 1 ? 's' : ''} pour ${label}. Choisis la tienne :`
    : '';
  $('#results-list').innerHTML = items.map(resultItem).join('');
  $('#results-empty').hidden = n > 0;
  $('#results-more').hidden = result.page >= result.pages;
}

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
    $('#results-list').insertAdjacentHTML('beforeend', next.items.map(resultItem).join(''));
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
  const fresh = release?.market?.fetchedAt && Date.now() - release.market.fetchedAt < CACHE_MAX_AGE;

  if (release) renderRelease(release);
  else container.innerHTML = '';

  if (!release || !fresh || force) {
    if (!release) setLoading(true, 'Chargement de la fiche…');
    try {
      const data = await api.fetchRelease(releaseId);
      if (currentView !== 'release' || location.hash !== `#/release/${releaseId}`) return; // l'utilisateur est parti
      release = await db.saveRelease(data);
      renderRelease(release);
      if (force) toast('Prix mis à jour.');
    } catch (e) {
      if (!release) container.innerHTML = `<div class="empty"><p>${esc(e.message)}</p><button class="btn primary" id="retry-btn">Réessayer</button></div>`;
      else {
        renderRelease(release);
        toast(`${e.message} (données affichées : ${timeAgo(release.market?.fetchedAt || release.lastSeenAt)})`, 'error');
      }
      $('#retry-btn')?.addEventListener('click', () => openRelease(releaseId));
      return;
    } finally {
      setLoading(false);
    }
  } else {
    release = await db.saveRelease(release); // met à jour "vu le…" et le compteur
  }

  if (source) db.addHistory({ releaseId, method: source.method, query: source.query }).catch(() => {});
}

function renderRelease(r) {
  $('#page-title').textContent = r.artist || 'Fiche';
  const m = r.market || {};
  const level = r.rarity?.level || 'common';
  const sugg = m.suggestions;
  const suggCurrency = sugg ? Object.values(sugg)[0]?.currency : null;

  const labelsTxt = (r.labels || []).map((l) => `${esc(l.name)}${l.catno && l.catno !== 'none' ? ` – ${esc(l.catno)}` : ''}`).join('<br>');
  const grades = sugg
    ? `<table class="grades">${api.CONDITION_ORDER.filter((k) => sugg[k]).map((k) => `<tr><td><span class="abbr">${k}</span>${api.CONDITION_LABELS[k]}</td><td>${money(sugg[k].value, sugg[k].currency)}</td></tr>`).join('')}</table>
       ${suggCurrency && suggCurrency !== 'EUR' ? `<p class="help">Ces prix sont dans la devise de ton compte Discogs (${esc(suggCurrency)}). Choisis EUR dans tes paramètres vendeur Discogs pour les avoir en euros.</p>` : ''}`
    : `<p class="help">Prix suggérés par état indisponibles. Discogs ne les fournit qu'aux comptes ayant rempli leurs <a href="https://www.discogs.com/settings/seller/" target="_blank" rel="noopener">paramètres vendeur</a>.</p>`;

  const tracks = (r.tracklist || []).map((t) => (t.heading
    ? `<li class="heading">${esc(t.title)}</li>`
    : `<li><span class="pos">${esc(t.position)}</span><span>${esc(t.title)}</span><span class="dur">${esc(t.duration)}</span></li>`)).join('');

  $('#release-content').innerHTML = `
    <div class="hero">
      <img class="cover" src="${esc(r.coverUrl)}" alt="Pochette" referrerpolicy="no-referrer" onerror="this.removeAttribute('src')">
      <div class="hero-text">
        <div class="artist">${esc(r.artist)}</div>
        <h2>${esc(r.title)}</h2>
      </div>
    </div>

    <div class="card">
      <h2>Prix &amp; rareté</h2>
      <div class="price-main">
        <span class="value">${m.blockedFromSale ? '—' : money(m.lowestPrice, m.currency || 'EUR')}</span>
        <span class="label">${m.blockedFromSale ? 'vente interdite sur Discogs' : m.lowestPrice != null ? 'prix le plus bas actuel' : 'aucun exemplaire en vente'}</span>
      </div>
      <div class="stats">
        <div class="stat"><b>${num(m.numForSale)}</b><span>en vente</span></div>
        <div class="stat"><b>${num(r.community?.have)}</b><span>l'ont</span></div>
        <div class="stat"><b>${num(r.community?.want)}</b><span>le recherchent</span></div>
      </div>
      <div class="meter ${level}"><i></i><i></i><i></i></div>
      <span class="rarity ${level}">${esc(RARITY_LEVELS[level].label)}</span>
      <span class="help">&nbsp;${esc(RARITY_LEVELS[level].hint)}</span>
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
    <p class="updated">Données Discogs du ${new Date(m.fetchedAt || r.lastSeenAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</p>
  `;
  $('#refresh-btn').addEventListener('click', (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Actualisation…';
    openRelease(r.id, { force: true });
  });
}

// ---------- 7. Historique ----------

const METHOD_LABELS = { barcode: 'Code-barres', catno: 'N° cat.', ocr: 'Photo' };

async function renderHistory() {
  const list = $('#history-list');
  let items = [];
  try { items = await db.getHistory(60); } catch { /* base indisponible (navigation privée…) */ }
  if (currentView !== 'history') return;
  list.innerHTML = items.map(({ release: r, at, method }) => `
    <li><a class="item" href="#/release/${r.id}">
      <img class="thumb" src="${esc(r.thumbUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.removeAttribute('src')">
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

// ---------- Réglages ----------

async function renderSettings() {
  const input = $('#token-input');
  input.value = api.getToken();
  setStatus($('#token-status'), api.getToken() ? 'Jeton enregistré sur ce téléphone.' : 'Aucun jeton enregistré.');
  try {
    const n = await db.countReleases();
    $('#data-stats').textContent = `${num(n)} vinyle${n > 1 ? 's' : ''} enregistré${n > 1 ? 's' : ''} sur ce téléphone.`;
  } catch {
    $('#data-stats').textContent = 'Stockage local indisponible (navigation privée ?).';
  }
}

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

$('#export-btn').addEventListener('click', async () => {
  try {
    const data = await db.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vinyles-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) {
    toast(`Export impossible : ${e.message}`, 'error');
  }
});

// ---------- Démarrage ----------

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
// Demande au navigateur de ne pas effacer la base locale si l'espace manque.
navigator.storage?.persist?.().catch(() => {});

if (!api.getToken() && !location.hash) location.hash = '#/settings';
route();
