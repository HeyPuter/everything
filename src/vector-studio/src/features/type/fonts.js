/**
 * Fonts: the bundled catalog, on-demand loading, local system fonts and
 * parsed fonts for outline conversion.
 *
 * Bundled faces load the first time a layout uses them (text-layout calls
 * textHooks.ensureFont), so the app starts without downloading any. A face
 * is fetched once; the same bytes become a FontFace for display and, when
 * needed, an opentype.js Font for Create Outlines and SVG/PDF export. When
 * a face finishes loading, layouts and cached bounds are invalidated and
 * every canvas redraws.
 *
 * Local fonts come from the Local Font Access API (queryLocalFonts) when the
 * browser has it and the user grants access; canvas can draw them by family
 * name, and their bytes (FontData.blob) can be parsed for outlines.
 */
import { UserError } from '../../lib/errors.js';
import { BUNDLED_FONTS } from './font-files.js';
import { textHooks, invalidateTextLayout } from '../../model/text-layout.js';
import { styledRuns } from '../../model/text-runs.js';
import { clearGeometryCache } from '../../model/geometry.js';
import { Emitter } from '../../lib/emitter.js';

export const fontEvents = new Emitter();

/** opentype.js loads only when outlines are first needed. */
async function parseFont(buf) {
  const m = await import('opentype.js');
  return (m.parse || m.default?.parse)(buf);
}

/** Weight names in the order the Font Style menu lists them. */
export const WEIGHT_NAMES = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

export function styleName(weight, style) {
  const w = WEIGHT_NAMES[weight] || String(weight);
  if (style === 'italic') return w === 'Regular' ? 'Italic' : `${w} Italic`;
  return w;
}

/** Parse a style name like "Bold Italic" or "SemiBold" into { weight, style }. */
export function parseStyleName(name) {
  const s = String(name || '').toLowerCase();
  const italic = /italic|oblique/.test(s);
  let weight = 400;
  const order = [
    [/extra\s*light|ultra\s*light/, 200],
    [/semi\s*bold|demi\s*bold/, 600],
    [/extra\s*bold|ultra\s*bold/, 800],
    [/thin|hairline/, 100],
    [/light/, 300],
    [/medium/, 500],
    [/black|heavy/, 900],
    [/bold/, 700],
  ];
  for (const [re, w] of order) {
    if (re.test(s)) {
      weight = w;
      break;
    }
  }
  return { weight, style: italic ? 'italic' : 'normal' };
}

const bundled = new Map(BUNDLED_FONTS.map((f) => [f.family.toLowerCase(), f]));
const local = new Map(); // family lower -> { family, faces: [{ weight, style, data (FontData) }] }
const faceState = new Map(); // key -> { status: 'loading'|'loaded'|'error', promise, buffer }
const otCache = new Map(); // key -> Promise<opentype.Font>
const otReady = new Map(); // key -> opentype.Font | null, once the promise has settled
let pending = 0;
let redrawTimer = 0;

export function bundledFamilies() {
  return BUNDLED_FONTS;
}

export function localFamilies() {
  return [...local.values()].sort((a, b) => a.family.localeCompare(b.family));
}

/** Every family the picker offers: bundled first, then local. */
export function allFamilies() {
  return [...BUNDLED_FONTS.map((f) => ({ ...f, source: 'bundled' })), ...localFamilies().map((f) => ({ ...f, source: 'local' }))];
}

export function familyInfo(family) {
  const k = String(family || '').toLowerCase();
  if (bundled.has(k)) return { ...bundled.get(k), source: 'bundled' };
  if (local.has(k)) return { ...local.get(k), source: 'local' };
  return null;
}

/** Faces available for a family as [{ weight, style }] (Regular only when unknown). */
export function familyFaces(family) {
  const info = familyInfo(family);
  if (!info) return [{ weight: 400, style: 'normal' }];
  const seen = new Set();
  const out = [];
  for (const f of info.faces) {
    const k = `${f.weight}|${f.style}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ weight: f.weight, style: f.style });
  }
  return out.sort((a, b) => a.weight - b.weight || (a.style === 'italic') - (b.style === 'italic'));
}

/** Nearest face of a family for a weight/style. */
export function nearestFace(info, weight = 400, style = 'normal') {
  let best = null;
  let bestD = Infinity;
  const w = Number(weight) || 400;
  for (const f of info.faces) {
    const d = Math.abs(f.weight - w) + (f.style === (style === 'italic' ? 'italic' : 'normal') ? 0 : 1000);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

const keyOf = (family, f) => `${family.toLowerCase()}|${f.weight}|${f.style}`;

function scheduleRedraw() {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => {
    invalidateTextLayout();
    clearGeometryCache();
    fontEvents.emit('loaded');
  }, 16);
}

// A face that failed to download (offline, a dropped connection) is tried
// again after a delay that doubles with each failure, and when the browser
// comes back online.
const RETRY_MS = 15000;
const RETRY_MAX_MS = 300000;
let retryTimer = 0;
let autoRetry = false;

function retryFailedFaces() {
  clearTimeout(retryTimer);
  retryTimer = 0;
  for (const st of faceState.values()) if (st.status === 'error') loadBundledFace(st.info, st.face, true);
}

/** Fetch and register a bundled face; resolves when it can be drawn. */
function loadBundledFace(info, face, retryNow = false) {
  const key = keyOf(info.family, face);
  const prev = faceState.get(key);
  if (prev && !(prev.status === 'error' && (retryNow || Date.now() >= prev.retryAt))) return prev.promise;
  const st = { status: 'loading', buffer: null, promise: null, info, face, failures: prev?.failures || 0 };
  faceState.set(key, st);
  pending++;
  st.promise = (async () => {
    try {
      const res = await fetch(face.url);
      if (!res.ok) throw new Error(`Font ${info.family} failed to load`);
      const buf = await res.arrayBuffer();
      st.buffer = buf;
      if (typeof FontFace !== 'undefined' && typeof document !== 'undefined' && document.fonts) {
        const ff = new FontFace(info.family, buf.slice(0), { weight: String(face.weight), style: face.style, display: 'block' });
        await ff.load();
        document.fonts.add(ff);
      }
      st.status = 'loaded';
      scheduleRedraw();
    } catch (err) {
      st.status = 'error';
      const delay = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** st.failures++);
      st.retryAt = Date.now() + delay;
      if (autoRetry && !retryTimer) {
        retryTimer = setTimeout(retryFailedFaces, delay);
        retryTimer.unref?.();
      }
      console.warn(err);
    } finally {
      pending--;
      if (!pending) fontEvents.emit('idle');
    }
    return st;
  })();
  return st.promise;
}

/** Make sure the font a character style uses is (being) loaded. */
export function ensureStyleFont(style) {
  const info = familyInfo(style.fontFamily);
  if (!info || info.source !== 'bundled') return Promise.resolve(null);
  const face = nearestFace(info, style.fontWeight, style.fontStyle);
  return face ? loadBundledFace(info, face) : Promise.resolve(null);
}

/** Load a whole family (all bundled faces), e.g. for picker previews. */
export function ensureFamily(family, weight = 400, style = 'normal') {
  return ensureStyleFont({ fontFamily: family, fontWeight: weight, fontStyle: style });
}

export function isFontLoaded(family, weight = 400, style = 'normal') {
  const info = familyInfo(family);
  if (!info) return true;
  if (info.source === 'local') return true;
  const face = nearestFace(info, weight, style);
  return faceState.get(keyOf(info.family, face))?.status === 'loaded';
}

/** Promise that resolves when every requested font has loaded (or failed). */
export function fontsIdle() {
  if (!pending) return Promise.resolve();
  return new Promise((resolve) => {
    const off = fontEvents.on('idle', () => {
      off?.();
      resolve();
    });
  });
}

/**
 * The opentype.js Font for a style (nearest bundled or local face), or
 * null when the family is unknown or cannot be parsed.
 */
export async function otFontFor(style) {
  const info = familyInfo(style.fontFamily);
  if (!info) return null;
  const face = nearestFace(info, style.fontWeight, style.fontStyle);
  if (!face) return null;
  const key = keyOf(info.family, face);
  if (!otCache.has(key)) {
    otCache.set(
      key,
      (async () => {
        let buf;
        if (info.source === 'bundled') {
          const st = await loadBundledFace(info, face);
          buf = st?.buffer;
        } else if (face.data?.blob) {
          buf = await (await face.data.blob()).arrayBuffer();
        }
        if (!buf && info.source === 'bundled') {
          // Not downloaded: let a later Create Outlines or export try again.
          otCache.delete(key);
          return undefined;
        }
        if (!buf) return null;
        try {
          return await parseFont(buf);
        } catch (err) {
          console.warn(`Cannot read outlines of ${info.family}`, err);
          return null;
        }
      })().then((font) => {
        if (font !== undefined) otReady.set(key, font || null);
        return font || null;
      }),
    );
  }
  return otCache.get(key);
}

/**
 * The parsed outline font for a style when it is already available:
 * a Font, null when it has no outlines, or undefined while it has not been
 * loaded yet (otFontFor() loads it).
 */
export function otFontIfReady(style) {
  const info = familyInfo(style.fontFamily);
  if (!info) return null;
  const face = nearestFace(info, style.fontWeight, style.fontStyle);
  if (!face) return null;
  return otReady.get(keyOf(info.family, face));
}

/** Register a parsed font directly (tests, or fonts read from disk). */
export function registerOutlineFont(family, weight, style, font) {
  const info = familyInfo(family) || { family, faces: [] };
  const face = { weight, style };
  if (!bundled.has(family.toLowerCase()) && !local.has(family.toLowerCase())) {
    local.set(family.toLowerCase(), { family, faces: [face] });
  }
  const key = keyOf(info.family || family, nearestFace(familyInfo(family), weight, style) || face);
  otCache.set(key, Promise.resolve(font));
  otReady.set(key, font);
}

export function localFontsSupported() {
  return typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function';
}

/** Ask for local fonts (needs a user gesture). Returns the number of families found. */
export async function loadLocalFonts() {
  if (!localFontsSupported()) throw new UserError('This browser cannot list local fonts.');
  const list = await window.queryLocalFonts();
  for (const data of list) {
    const k = data.family.toLowerCase();
    if (bundled.has(k)) continue;
    let fam = local.get(k);
    if (!fam) {
      fam = { family: data.family, faces: [], category: 'local' };
      local.set(k, fam);
    }
    const { weight, style } = parseStyleName(data.style);
    fam.faces.push({ weight, style, data, name: data.style });
  }
  fontEvents.emit('local');
  return local.size;
}

/** Install the layout hook and redraw everything when fonts arrive. */
export function installFonts(app) {
  textHooks.ensureFont = (style) => {
    ensureStyleFont(style);
  };
  autoRetry = true;
  if (typeof window !== 'undefined') window.addEventListener('online', retryFailedFaces);
  fontEvents.on('loaded', () => {
    for (const v of app.views.values()) v.invalidate();
    app.editor?.emit('overlay');
    app.dock?.update();
  });
  // Exporters can wait for every face a document uses before rasterizing.
  app.textFontsReady = (doc = app.editor?.doc) => fontsReadyFor(doc);
}

/** Load every bundled face the document's text uses; resolves once layouts measure with them. */
export async function fontsReadyFor(doc) {
  const waits = [];
  if (doc) for (const n of doc.leaves()) if (n.type === 'text') for (const r of styledRuns(n)) waits.push(ensureStyleFont(r.style));
  await Promise.all(waits);
  await fontsIdle();
  // Let the cache invalidation scheduled by the last load run first.
  await new Promise((r) => setTimeout(r, 32));
}
