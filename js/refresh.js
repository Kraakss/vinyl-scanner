// Mise à jour des prix de toute la collection, en tâche de fond.
//
//  • 1 requête par disque (prix le plus bas en €), + 1 la première fois pour
//    récupérer la pochette et la fiche Discogs complète.
//  • Rythme : ~50 requêtes/minute maximum, pour rester sous la limite Discogs
//    (60/min) et laisser de la marge aux recherches faites pendant ce temps.
//  • L'avancement est sauvegardé après chaque disque : si l'appli est fermée
//    ou la connexion coupée, on reprend là où on s'était arrêté.

import * as api from './discogs.js';
import * as db from './db.js';
import { computeRarity } from './rarity.js';
import { valueOf, quantityOf } from './collection.js';

const KEY = 'price_refresh_job';
const MS_PER_REQUEST = 1200; // 50 requêtes / minute

let state = load();
let running = false;
let stopRequested = false;
let runStart = null; // { at, index } : pour estimer le temps restant
let wakeLock = null;
const listeners = new Set();

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    // Si l'appli a été fermée pendant la mise à jour, elle est "en pause".
    if (s && s.status === 'running') s.status = 'paused';
    return s;
  } catch {
    return null;
  }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* stockage plein */ }
}
function emit() { listeners.forEach((fn) => { try { fn(getState()); } catch { /* écouteur fautif */ } }); }

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getState() {
  if (!state) return null;
  // Secondes par disque mesurées (2,4 s par défaut : 2 requêtes au 1er passage)
  let secondsPerDisc = 2.4;
  if (running && runStart && state.index - runStart.index >= 3) {
    secondsPerDisc = (Date.now() - runStart.at) / 1000 / (state.index - runStart.index);
  }
  const remainingSeconds = Math.round((state.ids.length - state.index) * secondsPerDisc);
  return { ...state, running, remainingSeconds };
}
export const isRunning = () => running;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lockScreen() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* non supporté : pas grave */ }
}
document.addEventListener('visibilitychange', () => {
  if (running && document.visibilityState === 'visible' && (!wakeLock || wakeLock.released)) lockScreen();
});

async function collectionTotal() {
  const items = await db.getCollection();
  return items.reduce((sum, r) => sum + (valueOf(r) ?? 0) * quantityOf(r), 0);
}

/** Met à jour un disque. Renvoie le nombre de requêtes faites. */
async function refreshOne(id) {
  const current = await db.getRelease(id);
  if (!current || !current.inCollection) return 0;
  const needsDetails = !current.basicFetchedAt || !current.coverUrl;
  const [stats, basic] = await Promise.all([
    api.fetchStats(id),
    needsDetails ? api.fetchReleaseBasic(id).catch((e) => { if (e.status === 401 || !e.status) throw e; return null; }) : null,
  ]);
  const now = Date.now();
  await db.updateRelease(id, (rec) => {
    if (!rec) return null;
    if (basic) {
      // Les infos Discogs remplacent les infos importées, mais la collection et la valeur restent.
      const keep = { collection: rec.collection, inCollection: rec.inCollection, estimatedValue: rec.estimatedValue,
        valueInfo: rec.valueInfo, firstSeenAt: rec.firstSeenAt, lastSeenAt: rec.lastSeenAt, viewCount: rec.viewCount,
        market: rec.market, detailFetchedAt: rec.detailFetchedAt };
      rec = { ...rec, ...basic, ...keep };
      if (!rec.collection.format) rec.collection.format = api.formatCategory(basic.formats);
    }
    rec.market = { ...(rec.market || {}), ...stats, fetchedAt: now };
    if (rec.community) {
      rec.rarity = computeRarity({ have: rec.community.have, want: rec.community.want, numForSale: stats.numForSale });
    }
    db.applyLowestPrice(rec, rec.market, now);
    return rec;
  });
  return needsDetails ? 2 : 1;
}

/** Lance (ou reprend) la mise à jour. */
export async function start({ resume = true } = {}) {
  if (running) return;
  if (!api.getToken()) throw new Error('Ajoute ton jeton Discogs dans Réglages.');
  if (!resume || !state || state.status === 'done') {
    const items = await db.getCollection();
    if (!items.length) throw new Error('Ta collection est vide.');
    // Les disques jamais mis à jour (ou les plus anciens) d'abord.
    items.sort((a, b) => (a.market?.fetchedAt || 0) - (b.market?.fetchedAt || 0));
    state = {
      ids: items.map((r) => r.id),
      index: 0,
      updated: 0,
      failed: 0,
      startedAt: Date.now(),
      finishedAt: null,
      totalBefore: Math.round(items.reduce((s, r) => s + (valueOf(r) ?? 0) * quantityOf(r), 0) * 100) / 100,
      totalAfter: null,
      lastError: '',
      lastCompletedAt: state?.lastCompletedAt || null,
      status: 'running',
    };
  }
  state.status = 'running';
  state.lastError = '';
  running = true;
  stopRequested = false;
  runStart = { at: Date.now(), index: state.index };
  save();
  emit();
  lockScreen();

  while (state.index < state.ids.length && !stopRequested) {
    const id = state.ids[state.index];
    const t0 = Date.now();
    let requests = 1;
    try {
      requests = await refreshOne(id);
      state.updated += 1;
    } catch (e) {
      if (e.status === 401 || e.status === 429 || !e.status) {
        // Jeton refusé, limite dépassée ou plus de réseau : on met en pause sans perdre l'avancement.
        state.status = 'paused';
        state.lastError = e.message;
        break;
      }
      state.failed += 1; // ex. disque supprimé de Discogs : on passe au suivant
    }
    state.index += 1;
    save();
    emit();
    const wait = requests * MS_PER_REQUEST - (Date.now() - t0);
    if (wait > 0 && state.index < state.ids.length && !stopRequested) await sleep(wait);
  }

  if (state.index >= state.ids.length) {
    state.status = 'done';
    state.finishedAt = Date.now();
    state.lastCompletedAt = state.finishedAt;
    state.totalAfter = Math.round((await collectionTotal()) * 100) / 100;
  } else if (state.status === 'running') {
    state.status = 'paused';
  }
  running = false;
  try { await wakeLock?.release(); } catch { /* déjà libéré */ }
  wakeLock = null;
  save();
  emit();
}

/** Met en pause (le disque en cours se termine d'abord). */
export function pause() {
  if (running) stopRequested = true;
}
