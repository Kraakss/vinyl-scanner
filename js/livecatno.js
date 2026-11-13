// Scan du numéro de catalogue EN DIRECT (vinyles).
//
// La caméra filme ; plusieurs fois par seconde, la zone du cadre est découpée,
// améliorée (gris + contraste) et lue par Tesseract.js dans un « worker » (le
// téléphone reste fluide). Les textes qui ressemblent à un n° de catalogue
// apparaissent en boutons : un toucher lance la recherche Discogs.
// La caméra (bon objectif, autofocus, mise au point au toucher, zoom, lampe) est
// celle de core/camera.js, commune à toute l'appli.
//
// Module isolé : pour le retirer, mettre LIVE_CATNO à false dans js/config.js
// (le mode « photo » reste disponible), voire supprimer ce fichier.

import { getWorker, extractCandidates } from './ocr.js';
import { createCamera, detectionFeedback } from './core/camera.js';

const WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./ ';
const FRAME = { w: 0.86, h: 0.3 }; // taille du cadre de visée (part de la zone vidéo)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createLiveCatno(root, { onPick, onStatus = () => {} }) {
  root.innerHTML = `
    <div class="live-cam" hidden></div>
    <div class="live-chips chips" aria-live="polite"></div>
    <button type="button" class="btn primary block live-toggle">Scanner le n° en direct</button>`;
  const camBox = root.querySelector('.live-cam');
  const chipsBox = root.querySelector('.live-chips');
  const toggle = root.querySelector('.live-toggle');
  const cam = createCamera(camBox, { frame: FRAME, frameClass: 'text' });

  let running = false;
  let worker = null;
  let seen = new Map(); // texte → { count, last }
  let frames = 0;
  let loopTimer = null;

  async function start() {
    if (running) return;
    toggle.disabled = true;
    onStatus('Ouverture de la caméra… (autorise l\'accès si le téléphone le demande)');
    try {
      camBox.hidden = false;
      running = true;
      await cam.start();
      if (!running) { cam.stop(); return; }
      onStatus('Préparation de la lecture (la 1re fois : ~5 Mo à télécharger)…');
      worker = await getWorker(({ status }) => onStatus(status));
      if (!running) return;
      await worker.setParameters({ tessedit_char_whitelist: WHITELIST, tessedit_pageseg_mode: '6' });
      onStatus('Place le n° de catalogue dans le cadre. Touche l\'image pour faire le point. Touche le bon numéro quand il apparaît.');
      seen = new Map();
      frames = 0;
      loop();
    } catch (e) {
      console.warn('[scan n° en direct]', e);
      const msg = `${e?.name || ''} ${e?.message || e}`;
      onStatus(/NotAllowed|Permission|denied/i.test(msg) ? 'Accès à la caméra refusé. Autorise-la dans les réglages du navigateur.' : `Impossible de démarrer : ${msg.trim()}`, 'error');
      await stop();
    } finally {
      toggle.disabled = false;
      updateUi();
    }
  }

  /** Zone du cadre, en gris contrasté, à la bonne taille pour la lecture. */
  function grabFrame() {
    const region = cam.grabRegion(1100, 600);
    if (!region) return null;
    const { canvas, ctx } = region;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = img.data;
    let min = 255; let max = 0;
    for (let i = 0; i < px.length; i += 4) {
      const g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
      px[i] = g;
      if (g < min) min = g;
      if (g > max) max = g;
    }
    const range = Math.max(1, max - min);
    for (let i = 0; i < px.length; i += 4) {
      const v = ((px[i] - min) * 255) / range;
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  async function loop() {
    if (!running) return;
    const canvas = document.visibilityState === 'visible' && cam.isRunning() ? grabFrame() : null;
    if (canvas) {
      try {
        const { data } = await worker.recognize(canvas);
        if (!running) return;
        frames += 1;
        for (const c of extractCandidates(data.text || '')) {
          const s = seen.get(c) || { count: 0, last: 0 };
          seen.set(c, { count: s.count + 1, last: frames });
        }
        // On oublie ce qui n'a pas été revu depuis un moment
        for (const [k, v] of seen) if (frames - v.last > 12) seen.delete(k);
        renderChips();
      } catch { /* image illisible : on continue */ }
    }
    loopTimer = setTimeout(loop, 120);
  }

  let shownKey = '';
  function renderChips() {
    // Un texte vu au moins 2 fois est affiché (évite les lectures fantaisistes).
    // Ordre stable (ordre d'apparition) et pas de réaffichage si rien ne change :
    // un bouton ne doit jamais bouger sous le doigt.
    const list = [...seen.entries()].filter(([, v]) => v.count >= 2).slice(0, 6).map(([t]) => t);
    const key = list.join('\u0000');
    if (key === shownKey) return;
    const added = list.some((t) => !shownKey.split('\u0000').includes(t));
    shownKey = key;
    const existing = new Map([...chipsBox.querySelectorAll('.live-chip')].map((b) => [b.dataset.v, b]));
    existing.forEach((b, v) => { if (!list.includes(v)) b.remove(); });
    list.forEach((t) => {
      if (!existing.has(t)) chipsBox.insertAdjacentHTML('beforeend', `<button type="button" class="chip live-chip" data-v="${esc(t)}">${esc(t)}</button>`);
    });
    if (added && navigator.vibrate) navigator.vibrate(30);
  }

  async function stop() {
    running = false;
    clearTimeout(loopTimer);
    cam.stop();
    camBox.hidden = true;
    chipsBox.innerHTML = '';
    shownKey = '';
    // Le moteur sert aussi au mode photo : on retire la liste de caractères autorisés
    try { await worker?.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '3' }); } catch { /* rien */ }
    updateUi();
  }

  function updateUi() {
    toggle.textContent = running ? 'Arrêter la caméra' : 'Scanner le n° en direct';
    toggle.className = `btn block live-toggle ${running ? 'ghost' : 'primary'}`;
  }

  toggle.addEventListener('click', () => (running ? stop() : start()));
  chipsBox.addEventListener('click', async (e) => {
    const chip = e.target.closest('.live-chip');
    if (!chip) return;
    const value = chip.dataset.v;
    detectionFeedback();
    await stop();
    onPick(value);
  });
  // Appli en arrière-plan : caméra éteinte (batterie)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && running) stop(); });

  return { start, stop, isRunning: () => running };
}
