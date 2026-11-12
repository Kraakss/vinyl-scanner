// Vinyl Scanner — logique de l'interface (navigation, écrans, rendu).

import * as api from './discogs.js';
import * as db from './db.js';
import * as scanner from './scanner.js';
import { RARITY_LEVELS } from './rarity.js';
import * as coll from './collection.js';
import * as refresh from './refresh.js';

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
/** Vignette : image si on a une URL, sinon un disque gris. */
const thumbHtml = (url, cls = 'thumb') => (url
  ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.removeAttribute('src')">`
  : `<div class="${cls}" aria-hidden="true"></div>`);

/** "▲ +1,20 €" en vert, "▼ −0,50 €" en rouge */
function deltaHtml(d) {
  if (d === null || d === undefined) return '';
  if (Math.abs(d) < 0.005) return '<span class="delta same">= stable</span>';
  const sign = d > 0 ? '+' : '−';
  return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${sign}${money(Math.abs(d))}</span>`;
}

const dateFr = (ts) => (ts ? new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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

const TABS = ['scan', 'catno', 'photo', 'collection', 'history', 'settings'];
let collectionScroll = 0;
let currentView = null;
let searchState = null; // { result, items, label, method, query }
let pendingSource = null; // origine de la prochaine fiche ouverte (pour l'historique)

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const [, name = 'scan', param] = location.hash.replace(/^#\/?/, '#/').split('/');
  const view = ['results', 'release', 'stats', ...TABS].includes(name) ? name : 'scan';

  if (currentView === 'scan' && view !== 'scan') await scanner.stopCamera().then(updateCamUi);
  if (currentView === 'collection' && view !== 'collection') collectionScroll = window.scrollY;
  const backToCollection = currentView === 'release' && view === 'collection';
  currentView = view;

  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  setLoading(false);
  const section = $(`#view-${view}`);
  $('#page-title').textContent = section.dataset.title;
  $('#back-btn').hidden = TABS.includes(view);
  const tab = view === 'stats' ? 'collection' : view;
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  $('#token-banner').hidden = !!api.getToken() || !['scan', 'catno', 'photo'].includes(view);
  window.scrollTo(0, 0);

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
    ${thumbHtml(r.thumb)}
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
let collView = { q: '', sort: 'artist', genre: '', format: '', shelf: '' };
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

function renderCollectionList() {
  const filters = { q: collView.q, genre: collView.genre, format: collView.format, shelf: collView.shelf };
  const shown = coll.sortItems(coll.filterItems(collItems, filters), collView.sort);
  $('#coll-list').innerHTML = shown.map(collectionItemHtml).join('');
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
  $('#job-pill').hidden = !running;
  $('#job-line').hidden = !running;
  $('#job-pill-text').textContent = `${pct} %`;
  $('#job-line-bar').style.width = `${pct}%`;

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

const METHOD_LABELS = { barcode: 'Code-barres', catno: 'N° cat.', ocr: 'Photo' };

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
    download(`sauvegarde-vinyles-${today()}.json`, JSON.stringify(data), 'application/json');
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
    setStatus(status, `✓ Restauré : ${num(res.releases)} fiches, dont ${num(res.inCollection)} dans la collection.`, 'ok');
    renderSettingsStats();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

// ---------- Réglages ----------

async function renderSettingsStats() {
  try {
    const [n, items] = await Promise.all([db.countReleases(), db.getCollection()]);
    const discs = items.reduce((s, r) => s + coll.quantityOf(r), 0);
    $('#data-stats').textContent = `Sur ce téléphone : ${num(discs)} vinyle${discs > 1 ? 's' : ''} dans ta collection, ${num(n)} fiche${n > 1 ? 's' : ''} au total.`;
  } catch {
    $('#data-stats').textContent = 'Stockage local indisponible (navigation privée ?).';
  }
}

async function renderSettings() {
  const input = $('#token-input');
  input.value = api.getToken();
  setStatus($('#token-status'), api.getToken() ? 'Jeton enregistré sur ce téléphone.' : 'Aucun jeton enregistré.');
  renderSettingsStats();
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

// ---------- Démarrage ----------

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
// Demande au navigateur de ne pas effacer la base locale si l'espace manque.
navigator.storage?.persist?.().catch(() => {});

if (!api.getToken() && !location.hash) location.hash = '#/settings';
route();
renderJob(refresh.getState());
