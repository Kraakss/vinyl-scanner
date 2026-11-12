// Tâche de fond générique : traite une liste d'éléments un par un, à un rythme
// limité, avec progression, pause et reprise (même après fermeture de l'appli).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * createJob({ key, msPerItem, listIds, processOne, isFatal })
 *  - listIds() → liste d'identifiants à traiter (au lancement)
 *  - processOne(id) → traite un élément (lance une erreur en cas d'échec)
 *  - isFatal(err) → true si l'erreur doit mettre en pause (réseau, quota…)
 */
export function createJob({ key, msPerItem = 1500, listIds, processOne, isFatal = () => true, onDone }) {
  let state = null;
  try {
    state = JSON.parse(localStorage.getItem(key) || 'null');
    if (state && state.status === 'running') state.status = 'paused'; // appli fermée pendant la tâche
  } catch { state = null; }
  let running = false;
  let stopRequested = false;
  let runStart = null;
  let wakeLock = null;
  const listeners = new Set();

  const save = () => { try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* plein */ } };
  const getState = () => {
    if (!state) return null;
    let per = msPerItem / 1000;
    if (running && runStart && state.index - runStart.index >= 3) per = (Date.now() - runStart.at) / 1000 / (state.index - runStart.index);
    return { ...state, running, remainingSeconds: Math.round((state.ids.length - state.index) * per) };
  };
  const emit = () => listeners.forEach((fn) => { try { fn(getState()); } catch { /* rien */ } });

  async function lock() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch { /* non supporté */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (running && document.visibilityState === 'visible' && (!wakeLock || wakeLock.released)) lock();
  });

  async function start({ resume = true } = {}) {
    if (running) return;
    if (!resume || !state || state.status === 'done') {
      const ids = await listIds();
      if (!ids.length) throw new Error('Rien à mettre à jour.');
      state = { ids, index: 0, updated: 0, failed: 0, startedAt: Date.now(), finishedAt: null, lastError: '', lastCompletedAt: state?.lastCompletedAt || null, status: 'running' };
    }
    state.status = 'running';
    state.lastError = '';
    running = true;
    stopRequested = false;
    runStart = { at: Date.now(), index: state.index };
    save(); emit(); lock();
    while (state.index < state.ids.length && !stopRequested) {
      const t0 = Date.now();
      try {
        await processOne(state.ids[state.index]);
        state.updated += 1;
      } catch (e) {
        if (isFatal(e)) { state.status = 'paused'; state.lastError = e.message || 'Erreur'; break; }
        state.failed += 1;
      }
      state.index += 1;
      save(); emit();
      const wait = msPerItem - (Date.now() - t0);
      if (wait > 0 && state.index < state.ids.length && !stopRequested) await sleep(wait);
    }
    if (state.index >= state.ids.length) {
      state.status = 'done';
      state.finishedAt = Date.now();
      state.lastCompletedAt = state.finishedAt;
      if (onDone) { try { await onDone(state); } catch { /* rien */ } }
    } else if (state.status === 'running') {
      state.status = 'paused';
    }
    running = false;
    try { await wakeLock?.release(); } catch { /* rien */ }
    wakeLock = null;
    save(); emit();
  }

  return {
    start,
    pause: () => { if (running) stopRequested = true; },
    getState,
    isRunning: () => running,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
