// Section « collection d'objets » générique (Jeux vidéo, DVD) : scan, recherche, résultats,
// fiche, collection (liste/grille, tris, filtres, recherche), statistiques, alerte « déjà possédé ».
// Chaque section ne fournit que sa configuration (source de données, champs, prix…).

import * as db from '../db.js';
import * as scanner from '../scanner.js';
import * as backend from './backend.js';
import {
  $, esc, money, num, thumbHtml, deltaHtml, dateFr, dateTimeFr, toast, setStatus, fillSelect, confirmTap,
  normalize, ownershipBannerHtml,
} from './ui.js';

const DETAIL_MAX_AGE = 7 * 86400 * 1000;

const ICON_SCAN = '<svg viewBox="0 0 24 24"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M16 8v8"/></svg>';
const ICON_SEARCH = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
const ICON_COLL = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="4" height="16" rx="1"/><rect x="9" y="4" width="4" height="16" rx="1"/><path d="M15.5 5.2l3.8-1 3.2 15.3-3.8 1z"/></svg>';

export function createMediaSection(cfg) {
  const id = cfg.id; // 'games' | 'dvd'
  const P = (name) => `${id}-${name}`; // préfixe des identifiants HTML
  let current = null; // vue affichée
  let searchState = null; // { query, results, note, fromBarcode }
  let pendingBarcode = null; // code scanné en attente d'association à un objet
  let fromCollection = false;
  let collItems = [];
  const VIEW_KEY = `${id}_collection_view`;
  let view = { q: '', sort: cfg.defaultSort || 'title', layout: 'grid', filters: {} };
  try { view = { ...view, ...JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') }; } catch { /* rien */ }
  const saveView = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* rien */ } };

  const tabs = [
    { tab: 'scan', href: `#/${id}/scan`, label: 'Scanner', icon: ICON_SCAN },
    { tab: 'search', href: `#/${id}/search`, label: 'Recherche', icon: ICON_SEARCH },
    { tab: 'collection', href: `#/${id}/collection`, label: 'Collection', icon: ICON_COLL },
  ];

  // ---------- Construction des écrans ----------

  function mount(main) {
    const html = `
    <section class="view" id="view-${P('scan')}" hidden>
      <div class="camera"><div id="${P('reader')}" class="reader"></div>
        <div class="camera-idle">${ICON_SCAN.replace('<svg', '<svg class="big-icon"')}<p>Vise le code-barres au dos de la boîte</p></div></div>
      <p class="status" id="${P('scan-status')}" role="status"></p>
      <div class="actions">
        <button class="btn primary" id="${P('cam')}">Démarrer la caméra</button>
        <label class="btn ghost">Scanner depuis une photo<input type="file" accept="image/*" id="${P('scan-file')}" hidden></label>
      </div>
      <form class="card form" id="${P('code-form')}" autocomplete="off">
        ${cfg.scanExtraHtml ? cfg.scanExtraHtml() : ''}
        <label for="${P('code-input')}">Ou tape le code-barres</label>
        <div class="row"><input id="${P('code-input')}" inputmode="numeric" placeholder="ex. 3700664516557" required><button class="btn primary" type="submit">OK</button></div>
      </form>
    </section>

    <section class="view" id="view-${P('search')}" hidden>
      <form class="card form" id="${P('search-form')}" autocomplete="off">
        ${cfg.searchFormHtml()}
        <button class="btn primary block" type="submit">Rechercher</button>
      </form>
    </section>

    <section class="view" id="view-${P('results')}" hidden>
      <div id="${P('results-own')}"></div>
      <p class="summary" id="${P('results-summary')}"></p>
      <ul class="list" id="${P('results-list')}"></ul>
      <div class="empty" id="${P('results-empty')}" hidden><p>Aucun résultat.</p><p class="help">Essaie avec moins de mots, ou une autre orthographe.</p></div>
      <form class="card form refine" id="${P('refine-form')}" autocomplete="off">
        <p class="help" style="margin-top:0">Pas le bon ? Corrige la recherche :</p>
        ${cfg.searchFormHtml('refine')}
        <button class="btn ghost block" type="submit">Relancer la recherche</button>
      </form>
    </section>

    <section class="view" id="view-${P('item')}" hidden><div id="${P('item-content')}"></div></section>

    <section class="view" id="view-${P('collection')}" hidden>
      <div class="coll-summary">
        <div><div class="coll-total" id="${P('coll-total')}">—</div><div class="help" id="${P('coll-count')}"></div></div>
        <a class="btn ghost" href="#/${id}/stats"><svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>Stats</a>
      </div>
      ${cfg.priced ? `<div class="card job" id="${P('job-card')}">
        <div class="job-head"><div><strong>Prix eBay</strong><div class="help" id="${P('job-text')}"></div></div>
        <button class="btn primary" id="${P('job-btn')}">Actualiser les prix</button></div>
        <div class="progress" id="${P('job-progress')}" hidden><div class="bar"><span id="${P('job-bar')}"></span></div></div>
      </div>` : ''}
      <div class="toolbar" id="${P('toolbar')}">
        <input type="search" id="${P('coll-search')}" placeholder="${esc(cfg.searchPlaceholder || 'Rechercher…')}" autocomplete="off">
        <div class="selects">
          <select id="${P('coll-sort')}" aria-label="Trier"></select>
          ${cfg.filters.map((f) => `<select id="${P(`filter-${f.name}`)}" data-filter="${f.name}" aria-label="${esc(f.label)}"></select>`).join('')}
        </div>
        <div class="toolbar-row">
          <div class="seg" id="${P('layout')}" role="group" aria-label="Affichage">
            <button type="button" data-layout="list"><svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>Liste</button>
            <button type="button" data-layout="grid"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>Grille</button>
          </div>
          <button class="linklike" id="${P('reset')}" hidden>Effacer les filtres</button>
        </div>
      </div>
      <p class="summary" id="${P('coll-shown')}"></p>
      <ul class="list" id="${P('coll-list')}"></ul>
      <div class="empty" id="${P('coll-empty')}" hidden>
        <p>Ta collection de ${esc(cfg.nounPlural)} est vide.</p>
        <p class="help">Scanne un code-barres ou fais une recherche, puis touche « Ajouter à ma collection ».</p>
      </div>
    </section>

    <section class="view" id="view-${P('stats')}" hidden><div id="${P('stats-content')}"></div></section>`;
    main.insertAdjacentHTML('beforeend', html);
    bind();
  }

  // ---------- Navigation ----------

  /** parts : ce qui suit #/<id>/ dans l'adresse. Renvoie la vue à afficher. */
  async function route(parts, prevView) {
    const [name = 'scan', ...rest] = parts;
    const v = ['scan', 'search', 'results', 'item', 'collection', 'stats'].includes(name) ? name : 'scan';
    if (current === 'scan' && v !== 'scan') await stopCamera();
    if (v === 'item' && current !== 'item') fromCollection = [`${id}/collection`, `${id}/stats`].includes(prevView);
    current = v;
    const titles = { scan: `${cfg.label} · Scanner`, search: `${cfg.label} · Recherche`, results: 'Résultats', item: 'Fiche', collection: cfg.collectionTitle || `Mes ${cfg.nounPlural}`, stats: 'Statistiques' };
    const tab = v === 'stats' ? 'collection' : ['results', 'item'].includes(v) ? null : v;
    setTimeout(() => {
      if (v === 'results') renderResults();
      if (v === 'item') openItem(rest);
      if (v === 'collection') renderCollection();
      if (v === 'stats') renderStats();
      if (v === 'search') cfg.onSearchView?.($(`#${P('search-form')}`));
    }, 0);
    return { el: $(`#view-${P(v)}`), title: titles[v], tab, isRoot: ['scan', 'search', 'collection'].includes(v) };
  }

  async function stopCamera() {
    await scanner.stopCamera();
    updateCamUi();
  }

  const go = (hash) => { if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = hash; };

  // ---------- Scan ----------

  function updateCamUi() {
    const btn = $(`#${P('cam')}`);
    if (!btn) return;
    const on = scanner.isRunning(P('reader'));
    btn.closest('section').querySelector('.camera').classList.toggle('on', on);
    btn.textContent = on ? 'Arrêter la caméra' : 'Démarrer la caméra';
    btn.className = on ? 'btn ghost' : 'btn primary';
  }

  async function handleCode(code) {
    const status = $(`#${P('scan-status')}`);
    setStatus(status, `Code lu : ${code}`, 'ok');
    // 1. Code déjà connu : on ouvre directement la fiche
    const link = await db.getBarcode(code).catch(() => null);
    if (link && link.kind === cfg.kind && link.ref) {
      const item = await db.getItem(link.ref);
      if (item) { pendingBarcode = null; go(cfg.itemHref(item)); return; }
    }
    // 2. Sinon : titre du produit via le code-barres, puis recherche
    if (!backend.isConfigured()) {
      setStatus(status, 'Pour reconnaître un code-barres, configure le serveur (Worker) dans Réglages. En attendant, utilise la recherche par titre.', 'error');
      return;
    }
    $('#loader').hidden = false;
    $('#loader-text').textContent = 'Recherche du produit…';
    try {
      const { titles } = await backend.eanLookup(code);
      if (!titles?.length) {
        $('#loader').hidden = true;
        setStatus(status, 'Code-barres inconnu des bases gratuites. Cherche par titre.', 'error');
        pendingBarcode = code;
        go(`#/${id}/search`);
        return;
      }
      const ctx = cfg.contextFromTitles ? cfg.contextFromTitles(titles.map((t) => t.title), readScanExtra()) : {};
      const cleaned = backend.cleanProductTitle(titles[0].title, cfg.cleanNoise || []);
      pendingBarcode = code;
      await runSearch({ ...ctx, title: cleaned }, { fromBarcode: { code, title: titles[0].title, source: titles[0].source } });
    } catch (e) {
      setStatus(status, e.message, 'error');
    } finally {
      $('#loader').hidden = true;
    }
  }

  function readScanExtra() {
    return cfg.readScanExtra ? cfg.readScanExtra($(`#${P('code-form')}`)) : {};
  }

  // ---------- Recherche ----------

  async function runSearch(query, { fromBarcode = null } = {}) {
    if (!backend.isConfigured()) { toast('Configure d\'abord le serveur (Worker) dans Réglages.', 'error'); go('#/settings'); return; }
    const v = cfg.validateQuery?.(query);
    if (v) {
      // On garde ce qui a été trouvé et on demande l'information manquante
      cfg.fillSearchForm($(`#${P('search-form')}`), query);
      go(`#/${id}/search`);
      toast(v, 'error');
      return;
    }
    $('#loader').hidden = false;
    $('#loader-text').textContent = 'Recherche…';
    try {
      let res = { results: [], note: '' };
      for (const q of backend.queryVariants(query.title)) {
        res = await cfg.search({ ...query, title: q });
        if (res.results.length) { query = { ...query, title: q }; break; }
      }
      searchState = { query, results: res.results, note: res.note || '', fromBarcode };
      go(`#/${id}/results`);
    } catch (e) {
      toast(e.message || 'Erreur de recherche.', 'error');
    } finally {
      $('#loader').hidden = true;
    }
  }

  async function renderResults() {
    const list = $(`#${P('results-list')}`);
    if (!searchState) {
      $(`#${P('results-summary')}`).textContent = 'Aucune recherche en cours.';
      list.innerHTML = '';
      $(`#${P('results-own')}`).innerHTML = '';
      return;
    }
    const { query, results, note, fromBarcode } = searchState;
    cfg.fillSearchForm($(`#${P('refine-form')}`), query);
    const n = results.length;
    $(`#${P('results-summary')}`).textContent = `${fromBarcode ? `Code ${fromBarcode.code} → « ${fromBarcode.title} ». ` : ''}${n ? `${n} résultat${n > 1 ? 's' : ''} pour « ${query.title} »${cfg.queryLabel ? cfg.queryLabel(query) : ''}. Choisis le bon :` : ''}${note ? ` ${note}` : ''}`;
    $(`#${P('results-empty')}`).hidden = n > 0;
    const owned = await db.getItems(cfg.kind, { ownedOnly: true }).catch(() => []);
    if (current !== 'results') return;
    const keys = new Set(owned.map((o) => o.key));
    list.innerHTML = results.map((r) => {
      const key = cfg.keyFor(r.sourceId, query);
      const mine = owned.find((o) => o.key === key);
      return `<li><a class="item${mine ? ' owned' : ''}" href="${esc(cfg.resultHref(r, query))}">
        ${thumbHtml(r.thumb)}
        <div class="item-body">
          ${mine ? `<span class="owned-badge">✓ Possédé${(mine.collection?.quantity || 1) > 1 ? ` ×${mine.collection.quantity}` : ''}</span>` : ''}
          <div class="item-title">${esc(r.title)}</div>
          <div class="item-artist">${esc(r.subtitle || '')}</div>
          <div class="item-meta">${(r.meta || []).filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join('')}</div>
        </div></a></li>`;
    }).join('');
    // Bandeau global : version possédée / même œuvre ailleurs / rien
    if (!n) { $(`#${P('results-own')}`).innerHTML = ''; return; }
    const ownedHere = results.filter((r) => keys.has(cfg.keyFor(r.sourceId, query)));
    let banner;
    if (ownedHere.length) {
      const mine = owned.filter((o) => ownedHere.some((r) => cfg.keyFor(r.sourceId, query) === o.key));
      const q = mine.reduce((s, o) => s + (o.collection?.quantity || 1), 0);
      banner = ownershipBannerHtml({ level: 'same', sameText: cfg.texts.same, quantity: q, others: [], otherLabel: cfg.otherLabel, hrefOf: cfg.itemHref });
    } else {
      const others = owned.filter((o) => results.some((r) => cfg.sameWork(o, { ...r, ...query })));
      banner = ownershipBannerHtml({ level: others.length ? 'album' : 'none', albumText: cfg.texts.album, others, otherLabel: cfg.otherLabel, hrefOf: cfg.itemHref });
    }
    $(`#${P('results-own')}`).innerHTML = banner;
  }

  // ---------- Fiche ----------

  async function openItem(rest) {
    const ctx = cfg.ctxFromRoute(rest);
    const box = $(`#${P('item-content')}`);
    if (ctx) box.dataset.key = cfg.keyFor(ctx.sourceId, ctx);
    if (!ctx) { box.innerHTML = '<div class="empty"><p>Fiche introuvable.</p></div>'; return; }
    const key = cfg.keyFor(ctx.sourceId, ctx);
    let item = await db.getItem(key).catch(() => null);
    if (item) render(item); else box.innerHTML = '';
    const stale = !item || !item.detailFetchedAt || Date.now() - item.detailFetchedAt > DETAIL_MAX_AGE;
    if (stale) {
      if (!item) { $('#loader').hidden = false; $('#loader-text').textContent = 'Chargement de la fiche…'; }
      try {
        const details = await cfg.fetchDetails(ctx.sourceId, ctx);
        item = await db.updateItem(key, (x) => {
          const now = Date.now();
          const base = x || { key, kind: cfg.kind, sourceId: ctx.sourceId, inCollection: 0, collection: null, barcodes: [], firstSeenAt: now };
          return { ...base, ...cfg.ctxFields?.(ctx), ...details, key, kind: cfg.kind, sourceId: ctx.sourceId, detailFetchedAt: now, lastSeenAt: now };
        });
        if (isShowing(key)) render(item);
      } catch (e) {
        if (!item) box.innerHTML = `<div class="empty"><p>${esc(e.message)}</p><button class="btn primary" id="${P('retry')}">Réessayer</button></div>`;
        else toast(e.message, 'error');
        $(`#${P('retry')}`)?.addEventListener('click', () => openItem(rest));
        return;
      } finally {
        $('#loader').hidden = true;
      }
    }
    // Code-barres scanné juste avant : si l'objet est déjà possédé, on retient le lien
    if (pendingBarcode && item?.inCollection) await linkBarcode(item);
    // Prix (jeux) : mis à jour s'il a plus d'un jour
    if (cfg.priced && item && backend.isConfigured() && (!item.price?.fetchedAt || Date.now() - item.price.fetchedAt > 86400 * 1000)) {
      refreshPrice(item.key, { quiet: true });
    }
  }

  const isShowing = (key) => current === 'item' && decodeURIComponent(location.hash).includes(`/${id}/item/`) && $(`#${P('item-content')}`).dataset.key === key;

  async function linkBarcode(item) {
    const code = pendingBarcode;
    pendingBarcode = null;
    if (!code) return;
    await db.setBarcode(code, { kind: cfg.kind, ref: item.key, title: item.title });
    await db.updateItem(item.key, (x) => { if (!x) return null; x.barcodes = [...new Set([...(x.barcodes || []), code])]; return x; });
  }

  async function refreshPrice(key, { quiet = false } = {}) {
    try {
      const item = await db.getItem(key);
      const price = await cfg.fetchPrice(item);
      const rec = await db.updateItem(key, (x) => (x ? cfg.applyPrice(x, price) : null));
      if (isShowing(key)) render(rec);
      if (!quiet) toast('Prix mis à jour.');
    } catch (e) {
      if (!quiet) toast(e.message, 'error');
      else if (isShowing(key)) { const el = $(`#${P('price-note')}`); if (el) el.textContent = `Prix indisponible : ${e.message}`; }
    }
  }

  function render(item) {
    const box = $(`#${P('item-content')}`);
    box.dataset.key = item.key;
    $('#page-title').textContent = cfg.label;
    const c = item.collection || {};
    const fieldsHtml = cfg.fields.map((f) => {
      const val = c[f.name] ?? f.default ?? '';
      if (f.type === 'select') {
        return `<div><label for="${P(`f-${f.name}`)}">${esc(f.label)}</label><select id="${P(`f-${f.name}`)}">${f.options.map(([v, l]) => `<option value="${esc(v)}"${v === val ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
      }
      return `<div><label for="${P(`f-${f.name}`)}">${esc(f.label)}</label><input id="${P(`f-${f.name}`)}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}"></div>`;
    }).join('');
    const collCard = item.inCollection ? `
      <form class="card form coll-form" id="${P('coll-form')}" autocomplete="off">
        <h2><span class="badge-in">✓ Dans ma collection</span></h2>
        <div class="grid2">
          ${fieldsHtml}
          <div><label for="${P('f-qty')}">Quantité</label><input id="${P('f-qty')}" type="number" min="1" max="99" inputmode="numeric" value="${c.quantity || 1}"></div>
          <div><label>Ajouté le</label><input value="${esc(dateFr(c.addedAt))}" disabled></div>
        </div>
        <label for="${P('f-notes')}">Note perso</label>
        <textarea id="${P('f-notes')}" rows="3">${esc(c.notes || '')}</textarea>
        <button class="btn primary block" type="submit">Enregistrer</button>
        <button class="btn ghost block danger" type="button" id="${P('remove')}">Retirer de ma collection</button>
      </form>`
      : `<div class="card form coll-form">
          <div class="grid2">${fieldsHtml}</div>
          <button class="btn primary block" id="${P('add')}"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg> Ajouter à ma collection</button>
        </div>`;
    box.innerHTML = `
      <div class="hero portrait">
        ${item.coverUrl ? `<img class="cover poster" src="${esc(item.coverUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.removeAttribute('src')">` : '<div class="cover poster placeholder" aria-hidden="true"></div>'}
        <div class="hero-text">
          <div class="artist">${esc(cfg.heroKicker(item))}</div>
          <h2>${esc(item.title)}</h2>
        </div>
      </div>
      <div id="${P('own-slot')}"></div>
      ${cfg.priced ? `<div class="card" id="${P('price-card')}">${cfg.priceHtml(item)}<p class="help" id="${P('price-note')}"></p></div>` : ''}
      ${collCard}
      <div class="card"><h2>Détails</h2><dl class="facts">${cfg.factsHtml(item)}</dl></div>
      ${item.summary ? `<div class="card"><h2>Résumé</h2><p class="summary-text">${esc(item.summary)}</p></div>` : ''}
      ${cfg.externalLink ? `<a class="btn ghost block" href="${esc(cfg.externalLink(item))}" target="_blank" rel="noopener">${esc(cfg.externalLabel)}</a>` : ''}
    `;
    bindItem(item);
    renderOwnership(item);
  }

  async function renderOwnership(item) {
    const slot = $(`#${P('own-slot')}`);
    if (!slot || fromCollection) return;
    const owned = await db.getItems(cfg.kind, { ownedOnly: true }).catch(() => []);
    if (!isShowing(item.key)) return;
    const same = owned.find((o) => o.key === item.key);
    const others = owned.filter((o) => o.key !== item.key && cfg.sameWork(o, item));
    const level = same ? 'same' : others.length ? 'album' : 'none';
    slot.innerHTML = ownershipBannerHtml({
      level, sameText: cfg.texts.same, albumText: cfg.texts.album, quantity: same ? (same.collection?.quantity || 1) : 0,
      others, otherLabel: cfg.otherLabel, hrefOf: cfg.itemHref,
    });
  }

  function readFields() {
    const out = {};
    for (const f of cfg.fields) {
      const el = $(`#${P(`f-${f.name}`)}`);
      if (el) out[f.name] = el.value.trim();
    }
    return out;
  }

  function bindItem(item) {
    $(`#${P('add')}`)?.addEventListener('click', async () => {
      const fields = readFields();
      const rec = await db.updateItem(item.key, (x) => {
        if (!x) return null;
        x.inCollection = 1;
        x.collection = { addedAt: Date.now(), quantity: 1, notes: '', ...fields };
        return x;
      });
      if (pendingBarcode) await linkBarcode(rec);
      toast('Ajouté à ta collection.');
      render(await db.getItem(item.key));
    });
    $(`#${P('coll-form')}`)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const qty = Math.min(99, Math.max(1, parseInt($(`#${P('f-qty')}`).value, 10) || 1));
      const rec = await db.updateItem(item.key, (x) => {
        if (!x?.collection) return null;
        Object.assign(x.collection, readFields(), { quantity: qty, notes: $(`#${P('f-notes')}`).value.trim() });
        return cfg.onFieldsChanged ? cfg.onFieldsChanged(x) : x;
      });
      toast('Modifications enregistrées.');
      render(rec);
      if (cfg.priced && backend.isConfigured()) refreshPrice(item.key, { quiet: true });
    });
    $(`#${P('remove')}`)?.addEventListener('click', async (e) => {
      if (!confirmTap(e.currentTarget, 'Retirer de ma collection')) return;
      const rec = await db.updateItem(item.key, (x) => { if (!x) return null; x.inCollection = 0; x.collection = null; return x; });
      toast('Retiré de ta collection.');
      render(rec);
    });
    if (cfg.priced) {
      $(`#${P('price-refresh')}`)?.addEventListener('click', (e) => {
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = 'Recherche des annonces…';
        refreshPrice(item.key);
      });
      $(`#${P('manual-form')}`)?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const raw = $(`#${P('manual-value')}`).value.replace(',', '.').replace(/[^\d.]/g, '');
        const value = raw === '' ? null : Math.round(Number(raw) * 100) / 100;
        const rec = await db.updateItem(item.key, (x) => (x ? cfg.applyManualValue(x, Number.isFinite(value) ? value : null) : null));
        toast(value === null ? 'Valeur manuelle retirée : l\'estimation eBay est utilisée.' : 'Valeur corrigée.');
        render(rec);
      });
    }
  }

  // ---------- Collection ----------

  const valueOf = (it) => (typeof it.estimatedValue === 'number' ? it.estimatedValue : null);
  const qtyOf = (it) => Math.max(1, Number(it.collection?.quantity) || 1);

  async function renderCollection() {
    try { collItems = await db.getItems(cfg.kind, { ownedOnly: true }); } catch { collItems = []; }
    if (current !== 'collection') return;
    const count = collItems.reduce((s, it) => s + qtyOf(it), 0);
    const total = collItems.reduce((s, it) => s + (valueOf(it) ?? 0) * qtyOf(it), 0);
    $(`#${P('coll-total')}`).textContent = !collItems.length ? '—' : cfg.priced ? money(total) : `${num(count)} ${count > 1 ? cfg.nounPlural : cfg.noun}`;
    $(`#${P('coll-count')}`).textContent = !collItems.length ? `Aucun ${cfg.noun} pour l'instant` : cfg.priced ? `${num(count)} ${count > 1 ? cfg.nounPlural : cfg.noun} · valeur estimée totale` : `${num(collItems.length)} titres différents`;
    $(`#${P('toolbar')}`).hidden = !collItems.length;
    if (cfg.priced) { $(`#${P('job-card')}`).hidden = !collItems.length; renderJob(); }
    view.sort = fillSelect($(`#${P('coll-sort')}`), Object.entries(cfg.sorts).map(([k, s]) => [k, s.label]), view.sort, '');
    for (const f of cfg.filters) {
      const values = [...new Set(collItems.flatMap((it) => [].concat(f.get(it) || [])).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'fr'));
      view.filters[f.name] = fillSelect($(`#${P(`filter-${f.name}`)}`), values.map((v) => [v, f.format ? f.format(v) : v]), view.filters[f.name] || '', f.all);
    }
    $(`#${P('coll-search')}`).value = view.q;
    renderCollectionList();
  }

  function renderCollectionList() {
    const words = normalize(view.q).split(/\s+/).filter(Boolean);
    let shown = collItems.filter((it) => cfg.filters.every((f) => !view.filters[f.name] || [].concat(f.get(it) || []).includes(view.filters[f.name])));
    if (words.length) shown = shown.filter((it) => { const hay = normalize(cfg.searchText(it)); return words.every((w) => hay.includes(w)); });
    shown = [...shown].sort(cfg.sorts[view.sort]?.cmp || cfg.sorts[Object.keys(cfg.sorts)[0]].cmp);
    const grid = view.layout === 'grid';
    const list = $(`#${P('coll-list')}`);
    list.classList.toggle('grid', grid);
    list.classList.toggle('posters', grid);
    document.querySelectorAll(`#${P('layout')} button`).forEach((b) => b.classList.toggle('on', b.dataset.layout === view.layout));
    list.innerHTML = shown.map((it) => {
      const v = valueOf(it);
      const right = cfg.priced ? (v !== null ? money(v) : '—') : (cfg.badge ? cfg.badge(it) : '');
      if (grid) {
        return `<li><a class="gcard" href="${esc(cfg.itemHref(it))}">${thumbHtml(it.coverUrl || it.thumbUrl, 'thumb gcover poster')}
          <div class="gtitle">${esc(it.title)}</div><div class="gartist">${esc(cfg.subtitle(it))}</div>
          <div class="gmeta"><span>${esc(it.year || '')}</span><b>${esc(right)}</b></div></a></li>`;
      }
      return `<li><a class="item" href="${esc(cfg.itemHref(it))}">${thumbHtml(it.thumbUrl || it.coverUrl, 'thumb poster-thumb')}
        <div class="item-body"><div class="item-title">${esc(it.title)}</div><div class="item-artist">${esc(cfg.subtitle(it))}</div>
        <div class="item-meta">${it.year ? `<span><b>${esc(it.year)}</b></span>` : ''}${qtyOf(it) > 1 ? `<span class="qty">×${qtyOf(it)}</span>` : ''}${(cfg.metaChips?.(it) || []).map((m) => `<span>${esc(m)}</span>`).join('')}</div></div>
        <div class="item-side"><div class="val">${esc(right)}</div>${cfg.priced ? `<div>${deltaHtml(valueDelta(it))}</div>` : ''}</div></a></li>`;
    }).join('');
    const filtered = !!(view.q || Object.values(view.filters).some(Boolean));
    $(`#${P('reset')}`).hidden = !filtered;
    $(`#${P('coll-empty')}`).hidden = collItems.length > 0;
    const total = shown.reduce((s, it) => s + (valueOf(it) ?? 0) * qtyOf(it), 0);
    $(`#${P('coll-shown')}`).textContent = !collItems.length ? '' : filtered
      ? (shown.length ? `${num(shown.length)} résultat${shown.length > 1 ? 's' : ''}${cfg.priced ? ` · ${money(total)}` : ''}` : 'Aucun résultat.')
      : `${num(shown.length)} titre${shown.length > 1 ? 's' : ''}`;
  }

  function valueDelta(it) {
    const prev = it.valueInfo?.previous;
    const cur = valueOf(it);
    if (cur === null || prev === null || prev === undefined) return null;
    return Math.round((cur - prev) * 100) / 100;
  }

  // ---------- Mise à jour des prix de toute la collection ----------

  function renderJob() {
    if (!cfg.priced || !cfg.job) return;
    const st = cfg.job.getState();
    const running = cfg.job.isRunning();
    const pct = st && st.ids?.length ? Math.round((st.index / st.ids.length) * 100) : 0;
    window.dispatchEvent(new CustomEvent('jobprogress', { detail: { id, running, pct } }));
    if (current !== 'collection') return;
    const btn = $(`#${P('job-btn')}`);
    const text = $(`#${P('job-text')}`);
    $(`#${P('job-progress')}`).hidden = !(st && (running || st.status === 'paused'));
    $(`#${P('job-bar')}`).style.width = `${pct}%`;
    if (running) {
      const minutes = Math.max(1, Math.round((st.remainingSeconds || 0) / 60));
      text.textContent = `Mise à jour : ${st.index} / ${st.ids.length} — environ ${minutes} min. Tu peux utiliser l'appli, garde-la ouverte.`;
      btn.textContent = 'Pause'; btn.className = 'btn ghost';
    } else if (st?.status === 'paused') {
      text.textContent = `En pause : ${st.index} / ${st.ids.length}.${st.lastError ? ` ${st.lastError}` : ''}`;
      btn.textContent = 'Reprendre'; btn.className = 'btn primary';
    } else {
      text.textContent = st?.lastCompletedAt ? `Dernière mise à jour : ${dateTimeFr(st.lastCompletedAt)}${st.failed ? ` · ${st.failed} sans résultat` : ''}` : 'Prix jamais mis à jour.';
      btn.textContent = 'Actualiser les prix'; btn.className = 'btn primary';
    }
  }

  // ---------- Statistiques ----------

  async function renderStats() {
    const items = await db.getItems(cfg.kind, { ownedOnly: true }).catch(() => []);
    if (current !== 'stats') return;
    const box = $(`#${P('stats-content')}`);
    box.innerHTML = items.length ? cfg.statsHtml(items, { valueOf, qtyOf, valueDelta, job: cfg.job?.getState() }) : `<div class="empty"><p>Ta collection de ${esc(cfg.nounPlural)} est vide.</p></div>`;
  }

  // ---------- Événements ----------

  function bind() {
    $(`#${P('cam')}`).addEventListener('click', async () => {
      const btn = $(`#${P('cam')}`);
      const status = $(`#${P('scan-status')}`);
      if (scanner.isRunning(P('reader'))) { await stopCamera(); setStatus(status, ''); return; }
      btn.disabled = true;
      setStatus(status, 'Ouverture de la caméra… (autorise l\'accès si le téléphone le demande)');
      try {
        await scanner.startCamera(P('reader'), (code) => { updateCamUi(); handleCode(code); });
        setStatus(status, 'Vise le code-barres, bien à plat et éclairé.');
      } catch (e) {
        setStatus(status, scanner.cameraErrorMessage(e), 'error');
      } finally {
        btn.disabled = false;
        updateCamUi();
      }
    });
    $(`#${P('scan-file')}`).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const code = await scanner.scanImageFile(P('reader'), file);
      updateCamUi();
      if (code) handleCode(code); else setStatus($(`#${P('scan-status')}`), 'Aucun code-barres trouvé sur la photo.', 'error');
    });
    $(`#${P('code-form')}`).addEventListener('submit', (e) => {
      e.preventDefault();
      const code = $(`#${P('code-input')}`).value.replace(/\s+/g, '');
      if (code) handleCode(code);
    });
    $(`#${P('search-form')}`).addEventListener('submit', (e) => { e.preventDefault(); runSearch(cfg.readSearchForm(e.target)); });
    $(`#${P('refine-form')}`).addEventListener('submit', (e) => {
      e.preventDefault();
      runSearch(cfg.readSearchForm(e.target), { fromBarcode: searchState?.fromBarcode || null });
    });
    $(`#${P('results-list')}`).addEventListener('click', () => { fromCollection = false; });

    let t;
    $(`#${P('coll-search')}`).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { view.q = e.target.value; saveView(); renderCollectionList(); }, 150); });
    $(`#${P('coll-sort')}`).addEventListener('change', (e) => { view.sort = e.target.value; saveView(); renderCollectionList(); });
    for (const f of cfg.filters) {
      $(`#${P(`filter-${f.name}`)}`).addEventListener('change', (e) => {
        view.filters[f.name] = e.target.value; e.target.classList.toggle('active', !!e.target.value); saveView(); renderCollectionList();
      });
    }
    $(`#${P('layout')}`).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-layout]');
      if (!b) return;
      view.layout = b.dataset.layout; saveView(); renderCollectionList();
    });
    $(`#${P('reset')}`).addEventListener('click', () => {
      view.q = ''; view.filters = {}; saveView(); renderCollection();
    });
    if (cfg.priced && cfg.job) {
      $(`#${P('job-btn')}`).addEventListener('click', async () => {
        if (cfg.job.isRunning()) { cfg.job.pause(); toast('Pause après le jeu en cours…'); return; }
        if (!backend.isConfigured()) { toast('Configure d\'abord le serveur (Worker) dans Réglages.', 'error'); return; }
        const st = cfg.job.getState();
        try { await cfg.job.start({ resume: st?.status === 'paused' }); } catch (err) { toast(err.message, 'error'); }
      });
      let timer;
      cfg.job.onChange((st) => {
        renderJob();
        if (current === 'collection' && st && (!cfg.job.isRunning() || st.index % 10 === 0)) {
          clearTimeout(timer);
          timer = setTimeout(() => { if (current === 'collection') { const y = window.scrollY; renderCollection().then(() => window.scrollTo(0, y)); } }, 300);
        }
        if (st && !cfg.job.isRunning() && st.status === 'done') toast('Mise à jour des prix terminée.');
        if (st && !cfg.job.isRunning() && st.status === 'paused' && st.lastError) toast(`Mise à jour en pause : ${st.lastError}`, 'error');
      });
    }
  }

  /** Résumé pour l'écran d'accueil. */
  async function summary() {
    const items = await db.getItems(cfg.kind, { ownedOnly: true }).catch(() => []);
    const count = items.reduce((s, it) => s + qtyOf(it), 0);
    const total = items.reduce((s, it) => s + (valueOf(it) ?? 0) * qtyOf(it), 0);
    return { count, total, priced: !!cfg.priced };
  }

  return { id, tabs, mount, route, leave: stopCamera, summary, renderJob };
}
