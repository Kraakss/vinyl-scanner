// Petits outils d'affichage partagés par toutes les collections.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function money(value, currency = 'EUR') {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export const num = (n) => (n === null || n === undefined ? '—' : new Intl.NumberFormat('fr-FR').format(n));

/** Vignette : image si on a une URL, sinon un disque gris. */
export const thumbHtml = (url, cls = 'thumb') => (url
  ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.removeAttribute('src')">`
  : `<div class="${cls}" aria-hidden="true"></div>`);

/** "▲ +1,20 €" en vert, "▼ −0,50 €" en rouge */
export function deltaHtml(d) {
  if (d === null || d === undefined) return '';
  if (Math.abs(d) < 0.005) return '<span class="delta same">= stable</span>';
  const sign = d > 0 ? '+' : '−';
  return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${sign}${money(Math.abs(d))}</span>`;
}

export const dateFr = (ts) => (ts ? new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const dateTimeFr = (ts) => (ts ? new Date(ts).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const today = () => new Date().toISOString().slice(0, 10);

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  if (s < 86400 * 7) return `il y a ${Math.round(s / 86400)} j`;
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

let toastTimer;
export function toast(message, type = '') {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast ${type}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, type === 'error' ? 5000 : 3000);
}

export function setLoading(on, text = 'Recherche…') {
  $('#loader').hidden = !on;
  $('#loader-text').textContent = text;
}

export function setStatus(el, text, type = '') {
  el.textContent = text;
  el.className = `status ${type}`;
}

/** Remplit une liste déroulante ; renvoie la valeur retenue. */
export function fillSelect(sel, options, current, allLabel) {
  const opts = (allLabel ? [`<option value="">${esc(allLabel)}</option>`] : [])
    .concat(options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`));
  sel.innerHTML = opts.join('');
  sel.value = options.some(([v]) => v === current) ? current : (allLabel ? '' : options[0]?.[0] ?? '');
  if (allLabel) sel.classList.toggle('active', !!sel.value);
  return sel.value;
}

/** Bouton qui demande un 2e toucher pour confirmer (suppression…). Renvoie true au 2e toucher. */
export function confirmTap(btn, label) {
  if (btn.dataset.confirm === '1') { btn.dataset.confirm = ''; btn.textContent = label; return true; }
  btn.dataset.confirm = '1';
  btn.textContent = 'Toucher encore pour confirmer';
  setTimeout(() => { if (btn.isConnected && btn.dataset.confirm === '1') { btn.dataset.confirm = ''; btn.textContent = label; } }, 4000);
  return false;
}

/** Minuscules sans accents ni ponctuation (comparaisons, recherche). */
export const normalize = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const simplify = (s) => normalize(s).replace(/[^a-z0-9]+/g, ' ').trim();

/** Échappe une cellule CSV (Excel français : point-virgule). */
export const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const frNumber = (n) => (typeof n === 'number' ? n.toFixed(2).replace('.', ',') : '');
export function toCsv(cols, rows) {
  const lines = [cols.map(([h]) => csvCell(h)).join(';')];
  for (const r of rows) lines.push(cols.map(([, f]) => csvCell(f(r))).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ---------- Graphiques simples (barres), partagés par les statistiques ----------

export function hbarsHtml(entries) {
  const max = Math.max(...entries.map(([, n]) => n), 1);
  return `<div class="hbars">${entries.map(([label, n]) => `<div class="hbar" title="${esc(label)} : ${n}">
      <span class="name">${esc(label)}</span>
      <span class="track"><span class="fill" style="display:block;width:${(n / max) * 100}%"></span></span>
      <span class="n">${n}</span></div>`).join('')}</div>`;
}

export function vbarsHtml(entries) {
  if (!entries.length) return '';
  const max = Math.max(...entries.map(([, n]) => n), 1);
  const short = entries.length > 7;
  return `<div class="vbars">${entries.map(([label, n]) => `<div class="vbar" title="${esc(label)} : ${n}">
      <span class="n">${n}</span><span class="fill" style="height:${(n / max) * 100}%"></span></div>`).join('')}</div>
    <div class="vlabels">${entries.map(([label]) => `<span>${esc(short && /^\d{4}$/.test(String(label)) ? `'${String(label).slice(2)}` : label)}</span>`).join('')}</div>`;
}

export function tilesHtml(tiles) {
  return `<div class="tiles">${tiles.map((t) => `<div class="tile"><div class="k">${esc(t.k)}</div><div class="v"${t.small ? ' style="font-size:1.05rem"' : ''}>${t.vHtml ?? esc(t.v)}</div><div class="s">${t.sHtml ?? esc(t.s || '')}</div></div>`).join('')}</div>`;
}

/** Bandeau rouge / orange / indicateur vert « déjà dans ma collection ». */
export function ownershipBannerHtml({ level, sameText, albumText, quantity, others = [], otherLabel, hrefOf }) {
  const list = (items) => `<ul>${items.map((v) => `<li><a href="${esc(hrefOf(v))}"><span>${esc(otherLabel(v))}</span></a></li>`).join('')}</ul>`;
  if (level === 'same') {
    return `<div class="own-banner same" role="alert"><strong>${esc(sameText)}${quantity ? ` — quantité : ${quantity}` : ''}</strong>
      ${others.length ? `Vous avez aussi :${list(others)}` : ''}</div>`;
  }
  if (level === 'album') {
    return `<div class="own-banner album" role="alert"><strong>${esc(albumText)}</strong>
      ${others.length > 1 ? 'Vos versions' : 'Votre version'} :${list(others)}</div>`;
  }
  return '<div class="own-pill">Pas dans votre collection</div>';
}
