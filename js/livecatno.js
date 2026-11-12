// Scan du numéro de catalogue EN DIRECT (vinyles).
//
// La caméra filme ; plusieurs fois par seconde, la zone du cadre est découpée,
// améliorée (gris + contraste) et lue par Tesseract.js dans un « worker » (le
// téléphone reste fluide). Les textes qui ressemblent à un n° de catalogue
// apparaissent en boutons : un toucher lance la recherche Discogs.
//
// Module isolé : pour le retirer, mettre LIVE_CATNO à false dans js/config.js
// (le mode « photo » reste disponible), voire supprimer ce fichier.

import { getWorker, extractCandidates } from './ocr.js';

const WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./ ';
const FRAME = { w: 0.86, h: 0.3 }; // taille du cadre de visée (part de la zone vidéo)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createLiveCatno(root, { onPick, onStatus = () => {} }) {
  root.innerHTML = `
    <div class="live-cam" hidden>
      <video playsinline muted autoplay></video>
      <div class="live-frame" style="width:${FRAME.w * 100}%;height:${FRAME.h * 100}%"><span></span></div>
      <button type="button" class="live-torch" hidden aria-label="Lampe torche">
        <svg viewBox="0 0 24 24"><path d="M9 2h6l-1 7h3l-7 13 1-9H8z"/></svg></button>
    </div>
    <div class="live-chips chips" aria-live="polite"></div>
    <button type="button" class="btn primary block live-toggle">Scanner le n° en direct</button>`;
  const cam = root.querySelector('.live-cam');
  const video = root.querySelector('video');
  const chipsBox = root.querySelector('.live-chips');
  const toggle = root.querySelector('.live-toggle');
  const torchBtn = root.querySelector('.live-torch');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let stream = null;
  let running = false;
  let worker = null;
  let torchOn = false;
  let seen = new Map(); // texte → { count, last }
  let frames = 0;

  async function start() {
    if (running) return;
    if (!navigator.mediaDevices?.getUserMedia) { onStatus('Caméra non disponible sur ce navigateur.', 'error'); return; }
    toggle.disabled = true;
    onStatus('Ouverture de la caméra… (autorise l\'accès si le téléphone le demande)');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      video.srcObject = stream;
      cam.hidden = false;
      await video.play().catch(() => {});
      running = true;
      setupTorch();
      onStatus('Préparation de la lecture (la 1re fois : ~5 Mo à télécharger)…');
      worker = await getWorker(({ status }) => onStatus(status));
      if (!running) return;
      await worker.setParameters({ tessedit_char_whitelist: WHITELIST, tessedit_pageseg_mode: '6' });
      onStatus('Place le n° de catalogue dans le cadre. Touche le bon numéro quand il apparaît.');
      seen = new Map();
      frames = 0;
      loop();
    } catch (e) {
      console.warn('[scan n° en direct]', e);
      const msg = String(e?.message || e);
      onStatus(/NotAllowed|Permission|denied/i.test(msg) ? 'Accès à la caméra refusé. Autorise-la dans les réglages du navigateur.' : `Impossible de démarrer : ${msg}`, 'error');
      await stop();
    } finally {
      toggle.disabled = false;
      updateUi();
    }
  }

  function setupTorch() {
    const track = stream?.getVideoTracks?.()[0];
    let caps = {};
    try { caps = track?.getCapabilities?.() || {}; } catch { /* non supporté */ }
    torchBtn.hidden = !caps.torch;
  }

  async function setTorch(on) {
    const track = stream?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: on }] });
      torchOn = on;
      torchBtn.classList.toggle('on', on);
    } catch { torchBtn.hidden = true; }
  }

  /** Découpe la zone du cadre dans l'image vidéo (en tenant compte du recadrage « cover »). */
  function grabFrame() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const bw = video.clientWidth;
    const bh = video.clientHeight;
    if (!vw || !vh || !bw || !bh) return false;
    const scale = Math.max(bw / vw, bh / vh);
    const offX = (bw - vw * scale) / 2;
    const offY = (bh - vh * scale) / 2;
    const fw = bw * FRAME.w;
    const fh = bh * FRAME.h;
    const sx = ((bw - fw) / 2 - offX) / scale;
    const sy = ((bh - fh) / 2 - offY) / scale;
    const sw = fw / scale;
    const sh = fh / scale;
    // Taille de travail : assez grande pour lire, assez petite pour aller vite
    const outW = Math.min(1100, Math.max(600, sw));
    const outH = Math.round(outW * (sh / sw));
    canvas.width = outW;
    canvas.height = outH;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);
    // Gris + contraste
    const img = ctx.getImageData(0, 0, outW, outH);
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
    return true;
  }

  async function loop() {
    if (!running) return;
    if (document.visibilityState === 'visible' && grabFrame()) {
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
    setTimeout(loop, 120);
  }

  let shownKey = '';
  function renderChips() {
    // Un texte vu au moins 2 fois est affiché (évite les lectures fantaisistes).
    // Ordre stable (ordre d'apparition) et pas de réaffichage si rien ne change :
    // un bouton ne doit jamais bouger sous le doigt.
    const list = [...seen.entries()].filter(([, v]) => v.count >= 2).slice(0, 6).map(([t]) => t);
    const key = list.join('\u0000');
    if (key === shownKey) return;
    shownKey = key;
    const existing = new Map([...chipsBox.querySelectorAll('.live-chip')].map((b) => [b.dataset.v, b]));
    existing.forEach((b, v) => { if (!list.includes(v)) b.remove(); });
    list.forEach((t) => {
      if (!existing.has(t)) chipsBox.insertAdjacentHTML('beforeend', `<button type="button" class="chip live-chip" data-v="${esc(t)}">${esc(t)}</button>`);
    });
  }

  async function stop() {
    running = false;
    if (torchOn) await setTorch(false);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    cam.hidden = true;
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
  torchBtn.addEventListener('click', () => setTorch(!torchOn));
  chipsBox.addEventListener('click', async (e) => {
    const chip = e.target.closest('.live-chip');
    if (!chip) return;
    const value = chip.dataset.v;
    await stop();
    onPick(value);
  });

  return { start, stop, isRunning: () => running };
}
