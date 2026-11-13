// Caméra commune à toutes les collections (codes-barres et n° de catalogue en direct).
//
//  • Choisit automatiquement l'objectif arrière PRINCIPAL (pas l'ultra grand-angle ni le
//    téléobjectif, qui font souvent la mise au point de travers de près).
//  • Bouton pour passer à une autre caméra ; le choix est mémorisé sur le téléphone.
//  • Bonne résolution (1920×1080 si possible, 1280×720 au minimum), autofocus continu,
//    mise au point au toucher, zoom et lampe quand le téléphone les propose.

const PREF_KEY = 'camera_pref';
const instances = new Set();

const ICON_SWITCH = '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><path d="M9.5 12.5a2.5 2.5 0 0 1 4.3-1.7M14.5 13.5a2.5 2.5 0 0 1-4.3 1.7M14 9.8v1.4h-1.4M10 16.2v-1.4h1.4"/></svg>';
const ICON_TORCH = '<svg viewBox="0 0 24 24"><path d="M9 2h6l-1 7h3l-7 13 1-9H8z"/></svg>';

// ---------- Choix de l'objectif ----------

/**
 * Note un objectif d'après son nom. Exemples de noms :
 *  iPhone : « Caméra arrière » / « Back Camera » (principal), « … ultra grand-angle … »,
 *           « … téléobjectif … », « Caméra double/triple arrière » (virtuelles)
 *  Android : « camera2 0, facing back » (principal), « camera2 2, facing back »…
 */
export function scoreCamera(label = '') {
  const l = String(label).toLowerCase();
  let s = 0;
  if (/back|rear|arri[eè]re|environment|facing back|dos/.test(l)) s += 10;
  if (/front|avant|user|facing front|selfie|frontale/.test(l)) s -= 30;
  if (/ultra|wide|grand[- ]?angle|0[,.]5x/.test(l)) s -= 8;
  if (/tele|t[ée]l[ée]objectif|zoom|periscope|p[ée]riscope/.test(l)) s -= 8;
  if (/depth|profondeur|infra|\bir\b|macro|virtual|obs |droidcam/.test(l)) s -= 12;
  if (/dual|triple|double/.test(l)) s -= 3;
  const m = l.match(/camera2? ?(\d+)/);
  if (m) s -= Number(m[1]) * 0.5; // Android : le n°0 est presque toujours l'objectif principal
  return s;
}

/** Caméras triées de la meilleure à la moins bonne pour scanner. */
export function rankCameras(devices) {
  return devices.map((d, i) => ({ d, s: scoreCamera(d.label), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.d);
}

async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'videoinput');
}

function loadPref() { try { return JSON.parse(localStorage.getItem(PREF_KEY) || 'null'); } catch { return null; } }
function savePref(device) { try { localStorage.setItem(PREF_KEY, JSON.stringify({ deviceId: device.deviceId, label: device.label })); } catch { /* rien */ } }

const BASE = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };

async function openStream(deviceId) {
  const tries = [];
  if (deviceId) tries.push({ ...BASE, deviceId: { exact: deviceId } });
  tries.push({ ...BASE, facingMode: { ideal: 'environment' } }, { facingMode: { ideal: 'environment' } }, true);
  let last;
  for (const video of tries) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      last = e;
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e; // refus : inutile d'insister
    }
  }
  throw last;
}

// ---------- Une caméra affichée dans une zone de l'écran ----------

/**
 * createCamera(hôte, { frame }) : construit la vidéo, le cadre de visée et les boutons.
 * frame = taille du cadre de visée (part de la largeur / hauteur de l'image affichée).
 */
export function createCamera(host, { frame = { w: 0.86, h: 0.4 }, frameClass = '' } = {}) {
  host.innerHTML = `
    <div class="cam">
      <video playsinline muted autoplay></video>
      <div class="cam-frame ${frameClass}" style="width:${frame.w * 100}%;height:${frame.h * 100}%"><span></span></div>
      <div class="cam-focus" hidden></div>
      <div class="cam-tools">
        <button type="button" class="cam-btn cam-switch" hidden aria-label="Changer de caméra">${ICON_SWITCH}</button>
        <button type="button" class="cam-btn cam-torch" hidden aria-label="Lampe torche">${ICON_TORCH}</button>
      </div>
      <div class="cam-zoom" hidden><span>−</span><input type="range" aria-label="Zoom" step="0.1"><span>+</span></div>
      <div class="cam-label" aria-live="polite"></div>
    </div>`;
  const video = host.querySelector('video');
  const btnSwitch = host.querySelector('.cam-switch');
  const btnTorch = host.querySelector('.cam-torch');
  const zoomBox = host.querySelector('.cam-zoom');
  const zoom = zoomBox.querySelector('input');
  const focusRing = host.querySelector('.cam-focus');
  const labelBox = host.querySelector('.cam-label');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let stream = null;
  let track = null;
  let caps = {};
  let devices = [];
  let running = false;
  let want = false; // dernière demande : allumée ou éteinte
  let torchOn = false;
  let labelTimer;

  const stopTracks = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; track = null; };
  const showLabel = (text) => {
    labelBox.textContent = text;
    labelBox.classList.add('show');
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => labelBox.classList.remove('show'), 2500);
  };

  async function start() {
    want = true;
    if (running) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Caméra indisponible : l\'appli doit être ouverte en HTTPS.');
    const pref = loadPref();
    let s = await openStream(pref?.deviceId);
    devices = await listCameras().catch(() => []);
    let currentId = s.getVideoTracks()[0]?.getSettings?.().deviceId;
    // Choix enregistré mais identifiant changé : on retrouve la caméra par son nom
    let target = null;
    if (pref && !devices.some((d) => d.deviceId === pref.deviceId)) target = devices.find((d) => d.label && d.label === pref.label) || null;
    // Pas de choix enregistré : on prend le meilleur objectif (les noms sont lisibles maintenant)
    if (!pref) target = rankCameras(devices)[0] || null;
    if (target && target.deviceId && target.deviceId !== currentId) {
      s.getTracks().forEach((t) => t.stop());
      s = await openStream(target.deviceId).catch(() => openStream());
      currentId = s.getVideoTracks()[0]?.getSettings?.().deviceId;
    }
    if (!want) { s.getTracks().forEach((t) => t.stop()); return; } // arrêtée entre-temps
    stream = s;
    track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    await video.play().catch(() => {});
    running = true;
    host.classList.add('on');
    instances.add(api);
    await setupCapabilities();
  }

  async function setupCapabilities() {
    caps = {};
    try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch { caps = {}; }
    // Autofocus continu + résolution d'au moins 1280×720 si possible
    if (caps.focusMode?.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
    const set = track.getSettings ? track.getSettings() : {};
    if ((set.width || 0) < 1280 && (caps.width?.max || 0) >= 1280) {
      await track.applyConstraints({ width: { min: 1280, ideal: 1920 }, height: { min: 720, ideal: 1080 } }).catch(() => {});
    }
    btnTorch.hidden = !caps.torch;
    btnTorch.classList.toggle('on', false);
    torchOn = false;
    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      zoom.min = caps.zoom.min;
      zoom.max = Math.min(caps.zoom.max, caps.zoom.min * 8);
      zoom.step = caps.zoom.step || 0.1;
      zoom.value = (track.getSettings?.().zoom) ?? caps.zoom.min;
      zoomBox.hidden = false;
    } else {
      zoomBox.hidden = true;
    }
    btnSwitch.hidden = devices.length < 2;
  }

  function stop() {
    want = false;
    running = false;
    torchOn = false;
    stopTracks();
    video.srcObject = null;
    host.classList.remove('on');
    instances.delete(api);
  }

  async function switchCamera() {
    if (!devices.length) devices = await listCameras().catch(() => []);
    if (devices.length < 2) return;
    const ranked = rankCameras(devices);
    const currentId = track?.getSettings?.().deviceId;
    const idx = ranked.findIndex((d) => d.deviceId === currentId);
    const next = ranked[(idx + 1) % ranked.length];
    savePref(next);
    stopTracks();
    running = false;
    await start();
    showLabel(track?.label || next.label || 'Autre caméra');
  }

  /** Mise au point sur le point touché (si le téléphone le permet). */
  async function focusAt(event) {
    const r = video.getBoundingClientRect();
    focusRing.style.left = `${event.clientX - r.left}px`;
    focusRing.style.top = `${event.clientY - r.top}px`;
    focusRing.hidden = false;
    focusRing.classList.remove('pulse');
    void focusRing.offsetWidth;
    focusRing.classList.add('pulse');
    setTimeout(() => { focusRing.hidden = true; }, 900);
    if (!track) return;
    const p = toVideoPoint(event.clientX - r.left, event.clientY - r.top);
    const sup = navigator.mediaDevices.getSupportedConstraints ? navigator.mediaDevices.getSupportedConstraints() : {};
    const modes = caps.focusMode || [];
    const adv = {};
    if (sup.pointsOfInterest && p) adv.pointsOfInterest = [p];
    if (modes.includes('single-shot')) adv.focusMode = 'single-shot';
    else if (modes.includes('continuous')) adv.focusMode = 'continuous';
    if (!Object.keys(adv).length) return;
    try { await track.applyConstraints({ advanced: [adv] }); } catch { /* non supporté */ }
    if (adv.focusMode === 'single-shot' && modes.includes('continuous')) {
      setTimeout(() => track?.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}), 3000);
    }
  }

  /** Point affiché → point de l'image réelle (0 à 1), en tenant compte du recadrage. */
  function toVideoPoint(x, y) {
    const vw = video.videoWidth; const vh = video.videoHeight; const bw = video.clientWidth; const bh = video.clientHeight;
    if (!vw || !vh || !bw || !bh) return null;
    const scale = Math.max(bw / vw, bh / vh);
    const offX = (bw - vw * scale) / 2; const offY = (bh - vh * scale) / 2;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    return { x: clamp((x - offX) / scale / vw), y: clamp((y - offY) / scale / vh) };
  }

  /** Découpe la zone du cadre de visée dans l'image vidéo (pour la lecture). */
  function grabRegion(maxWidth = 1000, minWidth = 0) {
    const vw = video.videoWidth; const vh = video.videoHeight; const bw = video.clientWidth; const bh = video.clientHeight;
    if (!vw || !vh || !bw || !bh) return null;
    const scale = Math.max(bw / vw, bh / vh);
    const offX = (bw - vw * scale) / 2; const offY = (bh - vh * scale) / 2;
    const fw = bw * frame.w; const fh = bh * frame.h;
    const sx = Math.max(0, ((bw - fw) / 2 - offX) / scale);
    const sy = Math.max(0, ((bh - fh) / 2 - offY) / scale);
    const sw = Math.min(vw - sx, fw / scale);
    const sh = Math.min(vh - sy, fh / scale);
    const outW = Math.round(Math.max(minWidth, Math.min(maxWidth, sw)));
    const outH = Math.round(outW * (sh / sw));
    canvas.width = outW;
    canvas.height = outH;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);
    return { canvas, ctx };
  }

  btnSwitch.addEventListener('click', (e) => { e.stopPropagation(); switchCamera().catch(() => {}); });
  btnTorch.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
      torchOn = !torchOn;
      btnTorch.classList.toggle('on', torchOn);
    } catch { btnTorch.hidden = true; }
  });
  zoom.addEventListener('input', () => { track?.applyConstraints({ advanced: [{ zoom: Number(zoom.value) }] }).catch(() => {}); });
  video.addEventListener('pointerdown', (e) => { focusAt(e); });

  const api = {
    start, stop, video, grabRegion, switchCamera,
    isRunning: () => running,
    info: () => ({ label: track?.label || '', settings: track?.getSettings?.() || {}, caps, devices: devices.map((d) => d.label) }),
  };
  return api;
}

/** Éteint toutes les caméras (appli mise en arrière-plan…). */
export function stopAllCameras() { [...instances].forEach((c) => c.stop()); }

// ---------- Signal sonore et vibration à la détection ----------

let audioCtx = null;
const BEEP_KEY = 'scan_beep';
export const beepEnabled = () => { try { return localStorage.getItem(BEEP_KEY) !== 'off'; } catch { return true; } };
export const setBeepEnabled = (on) => { try { localStorage.setItem(BEEP_KEY, on ? 'on' : 'off'); } catch { /* rien */ } };

// Le son n'est autorisé qu'après un premier toucher : on prépare l'audio à ce moment-là
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* pas d'audio */ }
}
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  document.addEventListener('keydown', unlockAudio, { passive: true });
}

export function detectionFeedback() {
  if (navigator.vibrate) navigator.vibrate(70);
  if (!beepEnabled()) return;
  try {
    unlockAudio();
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1320, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.13);
  } catch { /* pas d'audio */ }
}
