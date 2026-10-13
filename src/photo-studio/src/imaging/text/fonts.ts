// Font manager: bundled OFL typefaces (public/fonts, see docs/third-party.md),
// optional local fonts via the Local Font Access API, and a curated list of
// common system families detected by measurement. Works in windows and
// workers (FontFaceSet is `document.fonts` or `self.fonts`).
//
// Bundled files were subset to Latin with fontTools (MIT, build-time only):
//   pyftsubset IN.ttf --unicodes=<Latin + Latin-1 + Latin Extended-A + punctuation>
//     --layout-features=kern,liga,... --flavor=woff2|woff
// WOFF2 is what the browser loads; the WOFF twin (zlib, trivially decoded)
// is read by outlines.ts for text-to-shape conversion.

import type { TextLayerData } from './model';
import { invalidateMeasurements } from './layout';
import { faceFeatures, featureSettings } from './feature-list';

export type FontCategory = 'sans-serif' | 'serif' | 'monospace' | 'display' | 'handwriting';
export type FontFamilyInfo = {
  family: string;
  source: 'bundled' | 'local' | 'system';
  category?: FontCategory;
  weights: number[]; // weights offered in the UI
  weightRange?: [number, number]; // variable fonts accept any weight in range
  italic: boolean; // a true italic exists
  styles?: string[]; // local font style names
  license?: string;
};
type BundledFace = { file: string; italic: boolean; weight: [number, number] };
export type BundledFont = { family: string; category: FontCategory; dir: string; faces: BundledFace[]; version: string; license: 'OFL-1.1'; upstream: string };

export const BUNDLED_FONTS: BundledFont[] = [
  {
    family: 'Inter', category: 'sans-serif', dir: 'inter', version: '4.001', license: 'OFL-1.1', upstream: 'https://github.com/rsms/inter',
    faces: [{ file: 'Inter-Variable', italic: false, weight: [100, 900] }, { file: 'Inter-Italic-Variable', italic: true, weight: [100, 900] }],
  },
  {
    family: 'Crimson Pro', category: 'serif', dir: 'crimson-pro', version: '1.003', license: 'OFL-1.1', upstream: 'https://github.com/Fonthausen/CrimsonPro',
    faces: [{ file: 'CrimsonPro-Variable', italic: false, weight: [200, 900] }, { file: 'CrimsonPro-Italic-Variable', italic: true, weight: [200, 900] }],
  },
  {
    family: 'JetBrains Mono', category: 'monospace', dir: 'jetbrains-mono', version: '2.211', license: 'OFL-1.1', upstream: 'https://github.com/JetBrains/JetBrainsMono',
    faces: [{ file: 'JetBrainsMono-Variable', italic: false, weight: [100, 800] }, { file: 'JetBrainsMono-Italic-Variable', italic: true, weight: [100, 800] }],
  },
  {
    family: 'Bebas Neue', category: 'display', dir: 'bebas-neue', version: '2.000', license: 'OFL-1.1', upstream: 'https://github.com/dharmatype/Bebas-Neue',
    faces: [{ file: 'BebasNeue-Regular', italic: false, weight: [400, 400] }],
  },
  {
    family: 'Caveat', category: 'handwriting', dir: 'caveat', version: '2.000', license: 'OFL-1.1', upstream: 'https://github.com/googlefonts/caveat',
    faces: [{ file: 'Caveat-Variable', italic: false, weight: [400, 700] }],
  },
];

// Common families worth offering when installed (no files are shipped).
export const SYSTEM_FAMILIES: { family: string; category: FontCategory }[] = [
  ...['Arial', 'Helvetica', 'Helvetica Neue', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Segoe UI', 'Calibri', 'Gill Sans', 'Futura', 'Avenir', 'Avenir Next', 'Optima', 'Roboto', 'Noto Sans', 'Open Sans', 'Ubuntu', 'DejaVu Sans', 'Liberation Sans', 'Lucida Grande', 'San Francisco', 'system-ui']
    .map((family) => ({ family, category: 'sans-serif' as const })),
  ...['Times New Roman', 'Times', 'Georgia', 'Cambria', 'Palatino', 'Palatino Linotype', 'Book Antiqua', 'Garamond', 'Baskerville', 'Didot', 'Hoefler Text', 'Charter', 'Constantia', 'Noto Serif', 'DejaVu Serif', 'Liberation Serif']
    .map((family) => ({ family, category: 'serif' as const })),
  ...['Courier New', 'Courier', 'Menlo', 'Monaco', 'Consolas', 'SF Mono', 'Lucida Console', 'DejaVu Sans Mono', 'Liberation Mono', 'Ubuntu Mono']
    .map((family) => ({ family, category: 'monospace' as const })),
  ...['Impact', 'Copperplate', 'Rockwell', 'Chalkduster', 'American Typewriter']
    .map((family) => ({ family, category: 'display' as const })),
  ...['Comic Sans MS', 'Brush Script MT', 'Snell Roundhand', 'Bradley Hand', 'Segoe Script', 'Marker Felt']
    .map((family) => ({ family, category: 'handwriting' as const })),
];

let baseUrl: string | undefined;
// Where `public/` is served from; defaults to Vite's BASE_URL.
export function setFontBaseUrl(url: string) { baseUrl = url.endsWith('/') ? url : url + '/'; }
function base(): string {
  if (baseUrl) return baseUrl;
  let b = '/';
  try { b = import.meta.env?.BASE_URL ?? '/'; } catch { /* not under Vite */ }
  const origin = (globalThis as { location?: { href: string } }).location?.href;
  return origin ? new URL(b, origin).href : b;
}
export function bundledFontUrl(font: BundledFont, face: BundledFace, format: 'woff2' | 'woff' = 'woff2') {
  return `${base()}fonts/${font.dir}/${face.file}.${format}`;
}
export const findBundled = (family: string) => BUNDLED_FONTS.find((f) => f.family.toLowerCase() === family.toLowerCase());
export function bundledFace(family: string, italic: boolean): { font: BundledFont; face: BundledFace } | undefined {
  const font = findBundled(family);
  if (!font) return undefined;
  const face = font.faces.find((f) => f.italic === italic) ?? font.faces[0];
  return { font, face };
}

type FontSet = FontFaceSet & { add(face: FontFace): void };
function fontSet(): FontSet | undefined {
  const g = globalThis as { document?: { fonts?: FontSet }; fonts?: FontSet };
  return g.document?.fonts ?? g.fonts;
}

const loading = new Map<string, Promise<boolean>>();
// Loads a bundled face (all weights of a variable font at once). Resolves
// true when the family is usable for drawing at that weight/style.
export function ensureFont(family: string, weight = 400, italic = false): Promise<boolean> {
  const hit = bundledFace(family, italic);
  const set = fontSet();
  if (!hit || !set || typeof FontFace === 'undefined') return Promise.resolve(isFontAvailable(family));
  const key = `${hit.font.family}/${hit.face.file}`;
  let p = loading.get(key);
  if (!p) {
    const face = new FontFace(hit.font.family, `url("${bundledFontUrl(hit.font, hit.face)}") format("woff2")`, {
      weight: hit.face.weight[0] === hit.face.weight[1] ? String(hit.face.weight[0]) : `${hit.face.weight[0]} ${hit.face.weight[1]}`,
      style: hit.face.italic ? 'italic' : 'normal',
      display: 'block',
    });
    p = face.load().then(
      (f) => { set.add(f); invalidateMeasurements(); return true; },
      () => { loading.delete(key); return false; },
    );
    loading.set(key, p);
  }
  void weight; // variable faces cover their whole range
  return p;
}

// OpenType features: the same bundled file under an alias family whose face
// carries the feature settings (canvas text has no font-feature-settings).
/** Alias family for a bundled family with features, or undefined. */
export function featureFamily(family: string, features: string | undefined): string | undefined {
  const f = faceFeatures(features);
  const b = f ? findBundled(family) : undefined;
  return b ? `${b.family} ~${f.replace(/ /g, '~')}` : undefined;
}
export function ensureFeatureFont(family: string, italic: boolean, features: string): Promise<boolean> {
  const alias = featureFamily(family, features);
  const hit = bundledFace(family, italic);
  const set = fontSet();
  if (!alias || !hit || !set || typeof FontFace === 'undefined') return Promise.resolve(false);
  const key = `${alias}/${hit.face.file}`;
  let p = loading.get(key);
  if (!p) {
    const face = new FontFace(alias, `url("${bundledFontUrl(hit.font, hit.face)}") format("woff2")`, {
      weight: hit.face.weight[0] === hit.face.weight[1] ? String(hit.face.weight[0]) : `${hit.face.weight[0]} ${hit.face.weight[1]}`,
      style: hit.face.italic ? 'italic' : 'normal',
      display: 'block',
      featureSettings: featureSettings(features),
    });
    p = face.load().then(
      (f) => { set.add(f); invalidateMeasurements(); return true; },
      () => { loading.delete(key); return false; },
    );
    loading.set(key, p);
  }
  return p;
}

// Loads every face a text layer uses; call before renderText/layout.
export async function prepareFonts(data: TextLayerData): Promise<void> {
  const want = new Map<string, [string, number, boolean, string]>();
  for (const p of data.content.paragraphs)
    for (const r of p.runs) want.set(`${r.style.family}|${r.style.weight}|${r.style.italic}|${r.style.features ?? ''}`, [r.style.family, r.style.weight, r.style.italic, r.style.features ?? '']);
  await Promise.all([...want.values()].map(([f, w, i, feat]) => Promise.all([ensureFont(f, w, i), feat ? ensureFeatureFont(f, i, feat) : true])));
}

// The Type menu's OpenType features a bundled face implements (from its GSUB
// table); other fonts report none, since their files cannot be read.
const supportCache = new Map<string, Set<string>>();
const setNameCache = new Map<string, Map<string, string>>();
const supportLoading = new Set<string>();
/** Names a bundled face gives its stylistic sets (after fontFeatureSupport loaded it). */
export function stylisticSetNamesOf(family: string, italic: boolean): Map<string, string> | undefined {
  const b = findBundled(family);
  return b ? setNameCache.get(`${b.family}|${italic}`) : undefined;
}
export function fontFeatureSupport(family: string, italic: boolean, onLoad?: () => void): Set<string> | undefined {
  const b = findBundled(family);
  if (!b) return new Set();
  const key = `${b.family}|${italic}`;
  const hit = supportCache.get(key);
  if (hit) return hit;
  if (!supportLoading.has(key)) {
    supportLoading.add(key);
    void Promise.all([loadFontFile(b.family, italic), import('./font-features')]).then(
      ([buf, { featureSupport, stylisticSetNames }]) => {
        setNameCache.set(key, stylisticSetNames(buf));
        supportCache.set(key, featureSupport(buf));
        onLoad?.();
      },
      () => supportLoading.delete(key),
    );
  }
  return undefined;
}

// Installed-font detection by measurement: a family is present when text set
// in it differs from every generic fallback. (FontFaceSet.check() reports
// true for unknown families, so it cannot be used alone.)
let probe: { measureText(t: string): { width: number }; font: string } | null | undefined;
export function isFontAvailable(family: string): boolean {
  const bundled = findBundled(family);
  if (bundled && [...loading.keys()].some((k) => k.startsWith(bundled.family + '/'))) return true;
  if (probe === undefined) {
    try {
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4) : (globalThis as { document?: Document }).document?.createElement('canvas');
      probe = (c?.getContext('2d') as unknown as typeof probe) ?? null;
    } catch { probe = null; }
  }
  if (!probe) return false;
  if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/.test(family)) return true;
  const sample = 'mmmmmmmmmmlli1WQ@#';
  const quoted = `"${family.replace(/"/g, '\\"')}"`;
  for (const generic of ['monospace', 'serif', 'sans-serif']) {
    probe.font = `72px ${generic}`;
    const a = probe.measureText(sample).width;
    probe.font = `72px ${quoted}, ${generic}`;
    if (probe.measureText(sample).width !== a) return true;
  }
  return false;
}

const STYLE_WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100], [/extra\s*light|ultra\s*light/i, 200], [/light/i, 300], [/medium/i, 500],
  [/semi\s*bold|demi\s*bold/i, 600], [/extra\s*bold|ultra\s*bold/i, 800], [/black|heavy/i, 900], [/bold/i, 700],
];
export function weightFromStyleName(style: string): number {
  for (const [re, w] of STYLE_WEIGHTS) if (re.test(style)) return w;
  return 400;
}

type LocalFontData = { family: string; fullName: string; postscriptName: string; style: string; blob?: () => Promise<Blob> };
// One face per local family, kept for reading localized names.
const localFaces = new Map<string, LocalFontData>();
let localized: Promise<Map<string, string>> | undefined;
/** Local families' names in `lang` where the font provides one (read once). */
export function localizedFamilies(lang: string): Promise<Map<string, string>> {
  localized ??= (async () => {
    const { localizedFamilyName, readNameTable } = await import('./font-names');
    const out = new Map<string, string>();
    for (const [family, face] of localFaces) {
      try {
        const table = face.blob ? await readNameTable(await face.blob()) : undefined;
        const name = table && localizedFamilyName(table, lang);
        if (name && name !== family) out.set(family, name);
      } catch {
        /* Unreadable font: keep the English name. */
      }
    }
    return out;
  })();
  return localized;
}
// Local Font Access API (Chromium; needs a user gesture and permission).
export const localFontAccessSupported = () => typeof (globalThis as { queryLocalFonts?: unknown }).queryLocalFonts === 'function';
export async function queryLocalFamilies(): Promise<FontFamilyInfo[]> {
  const q = (globalThis as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts;
  if (!q) return [];
  let fonts: LocalFontData[];
  try { fonts = await q(); } catch { return []; }
  const byFamily = new Map<string, LocalFontData[]>();
  for (const f of fonts) byFamily.set(f.family, [...(byFamily.get(f.family) ?? []), f]);
  for (const [family, faces] of byFamily) localFaces.set(family, faces.find((f) => /regular|normal|book/i.test(f.style)) ?? faces[0]);
  localized = undefined;
  return [...byFamily].map(([family, faces]) => ({
    family,
    source: 'local' as const,
    weights: [...new Set(faces.map((f) => weightFromStyleName(f.style)))].sort((a, b) => a - b),
    italic: faces.some((f) => /italic|oblique/i.test(f.style)),
    styles: faces.map((f) => f.style),
  }));
}

const STANDARD_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
function bundledInfo(f: BundledFont): FontFamilyInfo {
  const lo = Math.min(...f.faces.map((x) => x.weight[0])), hi = Math.max(...f.faces.map((x) => x.weight[1]));
  return {
    family: f.family, source: 'bundled', category: f.category, license: f.license,
    weights: STANDARD_WEIGHTS.filter((w) => w >= lo && w <= hi),
    weightRange: lo === hi ? undefined : [lo, hi],
    italic: f.faces.some((x) => x.italic),
  };
}

// Families for the font menu: bundled first, then local (when permitted and
// requested), then detected system families. Synthetic bold/italic covers
// missing styles for system fonts.
// `pause` (awaited every few families) lets callers spread detection over
// idle periods instead of one long task.
export async function fontFamilies(opts: { local?: boolean; pause?: () => Promise<void> } = {}): Promise<FontFamilyInfo[]> {
  const out = BUNDLED_FONTS.map(bundledInfo);
  const seen = new Set(out.map((f) => f.family.toLowerCase()));
  if (opts.local && localFontAccessSupported())
    for (const f of await queryLocalFamilies()) if (!seen.has(f.family.toLowerCase())) { seen.add(f.family.toLowerCase()); out.push(f); }
  let checked = 0;
  for (const s of SYSTEM_FAMILIES) {
    if (opts.pause && ++checked % 6 === 0) await opts.pause();
    if (seen.has(s.family.toLowerCase()) || s.family === 'system-ui' || !isFontAvailable(s.family)) continue;
    seen.add(s.family.toLowerCase());
    out.push({ family: s.family, source: 'system', category: s.category, weights: [400, 700], italic: true });
  }
  return out;
}

// Raw font file for outline extraction (bundled WOFF twin).
const fileCache = new Map<string, Promise<ArrayBuffer>>();
export function loadFontFile(family: string, italic = false): Promise<ArrayBuffer> {
  const hit = bundledFace(family, italic);
  if (!hit) return Promise.reject(new Error(`No outline data for "${family}". Only bundled fonts can be converted to shapes.`));
  const url = bundledFontUrl(hit.font, hit.face, 'woff');
  let p = fileCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${url} (${r.status}).`);
      return r.arrayBuffer();
    });
    p.catch(() => fileCache.delete(url));
    fileCache.set(url, p);
  }
  return p;
}
