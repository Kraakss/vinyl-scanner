// Lecture des codes-barres avec la caméra (bibliothèque html5-qrcode, chargée dans index.html).
// Sur Android/Chrome, l'API native BarcodeDetector est utilisée si elle existe (plus rapide).

let scanner = null;
let running = false;
let lastCode = '';
let lastCount = 0;

/** Vérifie la clé de contrôle EAN-13 / UPC-A / EAN-8 pour éviter les lectures erronées. */
export function isValidEan(code) {
  if (!/^\d{8}$|^\d{12,13}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function getScanner(elementId) {
  if (scanner) return scanner;
  const F = window.Html5QrcodeSupportedFormats;
  scanner = new window.Html5Qrcode(elementId, {
    verbose: false,
    formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
  });
  return scanner;
}

/**
 * Démarre la caméra arrière. onCode(code) est appelé une seule fois, quand un
 * code fiable est lu (clé de contrôle valide, ou même code lu 2 fois de suite).
 */
export async function startCamera(elementId, onCode) {
  if (!window.Html5Qrcode) throw new Error('Le module de scan ne s\'est pas chargé. Recharge la page.');
  if (running) return;
  const s = getScanner(elementId);
  lastCode = '';
  lastCount = 0;
  const config = {
    fps: 12,
    qrbox: (w, h) => ({ width: Math.floor(Math.min(w * 0.88, 420)), height: Math.floor(Math.min(h * 0.45, 200)) }),
    aspectRatio: 1.333,
  };
  await s.start({ facingMode: 'environment' }, config, (text) => {
    const code = String(text).trim();
    // Code EAN/UPC avec clé de contrôle valide : fiable immédiatement.
    // Sinon (Code 128, UPC-E…), on exige 2 lectures identiques de suite.
    if (!isValidEan(code)) {
      if (code === lastCode) lastCount += 1; else { lastCode = code; lastCount = 1; }
      if (lastCount < 2) return;
    }
    stopCamera().finally(() => {
      if (navigator.vibrate) navigator.vibrate(80);
      onCode(code);
    });
  }, () => { /* aucune détection sur cette image : normal */ });
  running = true;
}

export async function stopCamera() {
  if (!scanner || !running) return;
  running = false;
  try { await scanner.stop(); } catch { /* déjà arrêtée */ }
  try { scanner.clear(); } catch { /* rien */ }
}

export const isRunning = () => running;

/** Lit un code-barres dans une photo (solution de secours si la caméra en direct coince). */
export async function scanImageFile(elementId, file) {
  await stopCamera();
  const s = getScanner(elementId);
  try {
    const text = await s.scanFile(file, false);
    return String(text).trim();
  } catch {
    return null;
  }
}

/** Traduit les erreurs caméra en français. */
export function cameraErrorMessage(err) {
  const msg = String(err?.message || err || '');
  if (/NotAllowed|Permission|denied/i.test(msg)) {
    return 'Accès à la caméra refusé. Autorise la caméra pour ce site dans les réglages du navigateur, puis réessaie.';
  }
  if (/NotFound|Requested device not found|no camera/i.test(msg)) return 'Aucune caméra trouvée sur cet appareil.';
  if (/NotReadable|in use|Could not start/i.test(msg)) return 'La caméra est utilisée par une autre application. Ferme-la et réessaie.';
  if (/secure|https/i.test(msg)) return 'La caméra nécessite une connexion sécurisée (HTTPS).';
  return 'Impossible de démarrer la caméra : ' + msg;
}
