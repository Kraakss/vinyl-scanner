// Lecture de texte sur photo, 100 % sur le téléphone, avec Tesseract.js (gratuit).
// La bibliothèque (~5 Mo avec le modèle anglais) n'est téléchargée qu'à la
// première utilisation, puis mise en cache par le navigateur.

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let loading = null;
let worker = null;
let progressCb = () => {};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Téléchargement du module de lecture impossible (connexion ?).'));
    document.head.appendChild(s);
  });
}

export async function getWorker(onProgress) {
  if (onProgress) progressCb = onProgress;
  if (worker) return worker;
  if (!loading) {
    loading = (async () => {
      if (!window.Tesseract) await loadScript(TESSERACT_URL);
      progressCb({ status: 'Préparation du moteur de lecture…', progress: 0 });
      worker = await window.Tesseract.createWorker('eng', 1, {
        logger: (m) => {
          const labels = {
            'loading tesseract core': 'Chargement du moteur…',
            'initializing tesseract': 'Initialisation…',
            'loading language traineddata': 'Chargement du modèle de langue…',
            'initializing api': 'Initialisation…',
            'recognizing text': 'Lecture du texte…',
          };
          progressCb({ status: labels[m.status] || 'Traitement…', progress: m.progress || 0 });
        },
      });
      return worker;
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

/** Réduit la photo, la passe en niveaux de gris et renforce le contraste (meilleure lecture). */
async function preprocess(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Image illisible.'));
      i.src = url;
    });
    const max = 1800;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    // Niveaux de gris + étirement du contraste (2 % – 98 %)
    const hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) {
      const g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
      px[i] = g;
      hist[g] += 1;
    }
    const total = w * h;
    let lo = 0; let hi = 255; let acc = 0;
    for (let v = 0; v < 256; v += 1) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v -= 1) { acc += hist[v]; if (acc > total * 0.02) { hi = v; break; } }
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < px.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((px[i] - lo) * 255) / range));
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(data, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function recognize(file, onProgress) {
  progressCb = onProgress || (() => {});
  progressCb({ status: 'Préparation de la photo…', progress: 0 });
  const canvas = await preprocess(file);
  const w = await getWorker();
  const { data } = await w.recognize(canvas);
  const text = (data.text || '').replace(/[|]/g, 'I').trim();
  return { text, candidates: extractCandidates(text) };
}

const NOISE = /^(19|20)\d\d$|^\d{1,2}$|RPM|STEREO|MONO|SIDE|FACE|LONG PLAY|MADE IN|℗|©/i;

/**
 * Repère dans le texte ce qui ressemble à un numéro de catalogue :
 * ex. "PB 41447", "2C 068-04324", "SHVL 804", "TOCP-1234", "6.23123 AP".
 */
export function extractCandidates(text) {
  const out = [];
  const add = (s) => {
    const v = s.replace(/\s+/g, ' ').replace(/^[^\w]+|[^\w]+$/g, '').trim();
    if (v.length < 3 || v.length > 24 || !/\d/.test(v) || NOISE.test(v)) return;
    if (!out.some((o) => o.toUpperCase() === v.toUpperCase())) out.push(v);
  };
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const re = /\b(?:[A-Z]{1,6}[ .\-]?)?\d[\dA-Z]*(?:[ .\-/]\d[\dA-Z]*){0,3}(?:[ \-]?[A-Z]{1,3})?\b/gi;
  for (const line of lines) {
    for (const m of line.matchAll(re)) add(m[0]);
  }
  // On met en premier les candidats qui mélangent lettres et chiffres (format le plus fréquent).
  out.sort((a, b) => Number(/[A-Z]/i.test(b)) - Number(/[A-Z]/i.test(a)));
  // Puis les lignes courtes complètes contenant des chiffres (au cas où la découpe aurait raté).
  for (const line of lines) if (line.length <= 24) add(line);
  return out.slice(0, 10);
}
