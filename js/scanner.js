// Lecture des codes-barres avec la caméra.
//  • Détecteur natif du navigateur (BarcodeDetector, Android/Chrome) quand il existe :
//    plus rapide et plus fiable. Sinon bibliothèque ZXing (iPhone…), chargée à la demande.
//  • La caméra (objectif, mise au point, zoom, lampe) est gérée par core/camera.js.
//  • Une seule caméra allumée à la fois ; elle s'éteint quand l'appli passe en arrière-plan
//    et se rallume au retour si l'écran de scan est toujours affiché.

import { createCamera, detectionFeedback } from './core/camera.js';

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'];
const sessions = new Map(); // id de la zone → caméra
let active = null; // { id, cam, onCode, opts, stopped, timer }
let paused = null; // session mise en pause par le passage en arrière-plan

/** Vérifie la clé de contrôle EAN-13 / UPC-A / EAN-8 pour éviter les lectures erronées. */
export function isValidEan(code) {
  if (!/^\d{8}$|^\d{12,13}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

// ---------- Détecteurs ----------

let detectorPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Module de lecture des codes-barres introuvable.'));
    document.head.appendChild(s);
  });
}

async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = FORMATS.filter((f) => supported.includes(f));
    if (!formats.includes('ean_13')) return null;
    const det = new window.BarcodeDetector({ formats });
    return {
      kind: 'natif',
      async fromCamera(cam) {
        if (cam.video.readyState < 2) return null;
        const found = await det.detect(cam.video);
        return found[0]?.rawValue || null;
      },
      async fromImage(bitmap) {
        const found = await det.detect(bitmap);
        return found[0]?.rawValue || null;
      },
    };
  } catch {
    return null;
  }
}

async function zxingDetector() {
  if (!window.ZXing) await loadScript('vendor/zxing.min.js');
  const Z = window.ZXing;
  const hints = new Map();
  const F = Z.BarcodeFormat;
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const decodeCanvas = (canvas) => {
    try {
      const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
      return reader.decode(bitmap, hints).getText();
    } catch {
      return null; // rien trouvé sur cette image
    } finally {
      reader.reset();
    }
  };
  return {
    kind: 'zxing',
    async fromCamera(cam) {
      const region = cam.grabRegion(1000);
      return region ? decodeCanvas(region.canvas) : null;
    },
    async fromImage(bitmap) {
      const c = document.createElement('canvas');
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      c.width = Math.round(bitmap.width * scale);
      c.height = Math.round(bitmap.height * scale);
      c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
      const found = decodeCanvas(c);
      if (found) return found;
      // Code-barres vertical sur la photo : on essaie l'image tournée
      const r = document.createElement('canvas');
      r.width = c.height;
      r.height = c.width;
      const rc = r.getContext('2d');
      rc.translate(r.width / 2, r.height / 2);
      rc.rotate(Math.PI / 2);
      rc.drawImage(c, -c.width / 2, -c.height / 2);
      return decodeCanvas(r);
    },
  };
}

export function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => (await nativeDetector()) || zxingDetector())()
      .catch((e) => { detectorPromise = null; throw e; });
  }
  return detectorPromise;
}

// ---------- Scan en direct ----------

/**
 * Démarre la caméra dans la zone elementId.
 * onCode(code) est appelé quand un code fiable est lu (clé de contrôle valide,
 * ou même code lu 2 fois de suite).
 * continuous = true : la caméra reste allumée (scan en série) ; un même code
 * n'est signalé qu'une fois toutes les 4 secondes.
 * onState(allumée) : prévenu quand la caméra s'allume ou s'éteint.
 */
export async function startCamera(elementId, onCode, opts = {}) {
  if (active && active.id === elementId && active.cam.isRunning()) return;
  await stopCamera();
  paused = null;
  const host = document.getElementById(elementId);
  if (!host) return;
  let cam = sessions.get(elementId);
  if (!cam || !host.querySelector('.cam')) {
    cam = createCamera(host, { frame: { w: 0.86, h: 0.42 }, frameClass: 'barcode' });
    sessions.set(elementId, cam);
  }
  const session = { id: elementId, cam, onCode, opts, stopped: false, timer: null };
  active = session;
  let detector;
  try {
    [detector] = await Promise.all([getDetector(), cam.start()]);
  } catch (e) {
    if (active === session) active = null;
    cam.stop();
    opts.onState?.(false);
    throw e;
  }
  if (session.stopped) { cam.stop(); return; }
  opts.onState?.(true);
  loop(session, detector);
}

function loop(session, detector) {
  let lastCode = '';
  let count = 0;
  let lastEmitted = { code: '', at: 0 };
  const tick = async () => {
    if (session.stopped || !session.cam.isRunning()) return;
    let code = null;
    if (document.visibilityState === 'visible') {
      try { code = await detector.fromCamera(session.cam); } catch { code = null; }
    }
    if (session.stopped) return;
    if (code) {
      code = String(code).trim();
      // Code EAN/UPC avec clé de contrôle valide : fiable immédiatement.
      // Sinon (Code 128, UPC-E…), on exige 2 lectures identiques de suite.
      let ok = isValidEan(code);
      if (!ok) {
        if (code === lastCode) count += 1; else { lastCode = code; count = 1; }
        ok = count >= 2;
      }
      if (ok) {
        if (session.opts.continuous) {
          const now = Date.now();
          if (code !== lastEmitted.code || now - lastEmitted.at > 4000) {
            lastEmitted = { code, at: now };
            detectionFeedback();
            session.onCode(code);
          }
        } else {
          detectionFeedback();
          await stopCamera();
          session.onCode(code);
          return;
        }
      }
    }
    session.timer = setTimeout(tick, detector.kind === 'natif' ? 60 : 110);
  };
  tick();
}

export async function stopCamera() {
  const s = active;
  if (!s) return;
  active = null;
  s.stopped = true;
  clearTimeout(s.timer);
  s.cam.stop();
  s.opts.onState?.(false);
}

export const isRunning = (elementId) => !!active && active.cam.isRunning() && (!elementId || active.id === elementId);

/** Caméra en cours d'utilisation (pour les tests et le diagnostic). */
export const activeCamera = () => active?.cam || null;

// Appli en arrière-plan → caméra éteinte (batterie) ; retour → rallumée si l'écran de scan est affiché
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && active) {
      paused = { id: active.id, onCode: active.onCode, opts: active.opts };
      stopCamera();
    } else if (document.visibilityState === 'visible' && paused) {
      const p = paused;
      paused = null;
      const el = document.getElementById(p.id);
      if (el && el.offsetParent !== null) startCamera(p.id, p.onCode, p.opts).catch(() => {});
    }
  });
  window.addEventListener('pagehide', () => { paused = null; stopCamera(); });
}

/** Lit un code-barres dans une photo (solution de secours). */
export async function scanImageFile(elementId, file) {
  await stopCamera();
  try {
    const detector = await getDetector();
    const bitmap = await createImageBitmap(file);
    const code = await detector.fromImage(bitmap);
    if (code) detectionFeedback();
    return code ? String(code).trim() : null;
  } catch {
    return null;
  }
}

/** Traduit les erreurs caméra en français. */
export function cameraErrorMessage(err) {
  const msg = String(err?.name || '') + ' ' + String(err?.message || err || '');
  if (/NotAllowed|Permission|denied/i.test(msg)) {
    return 'Accès à la caméra refusé. Autorise la caméra pour ce site dans les réglages du navigateur, puis touche « Démarrer la caméra ».';
  }
  if (/NotFound|Requested device not found|no camera/i.test(msg)) return 'Aucune caméra trouvée sur cet appareil.';
  if (/NotReadable|in use|Could not start/i.test(msg)) return 'La caméra est utilisée par une autre application. Ferme-la et réessaie.';
  if (/secure|https/i.test(msg)) return 'La caméra nécessite une connexion sécurisée (HTTPS).';
  return 'Impossible de démarrer la caméra : ' + msg.trim();
}
