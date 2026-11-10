/**
 * Page Layout ▸ Themes ▸ Effects: the theme's effect scheme, the three effect styles (subtle, moderate,
 * intense) that shapes refer to by number (`a:effectRef idx="1".."3"`). A text box, WordArt or equation
 * whose style names a theme effect (`style.effectRef`) is drawn with the workbook's scheme, and changes
 * when the scheme does. The scheme is written into theme1.xml's `a:fmtScheme/a:effectStyleLst`.
 *
 * Each style is a list of effects: { shadow: { blur, dist, dir, alpha } } (lengths in points, dir in
 * degrees, black at alpha), { glow: { rad, alpha } } (in the effect's colour), { bevel: { w, h } }.
 */
import { effectiveColorPalette } from './font-color.js';
import { t } from '../i18n/index.js';

export const DEFAULT_EFFECTS_NAME = 'Office';

const shadow = (blur, dist, dir, alpha) => ({ shadow: { blur, dist, dir, alpha } });
const glow = (rad, alpha) => ({ glow: { rad, alpha } });
const bevel = (w, h) => ({ bevel: { w, h } });

/** The schemes the gallery offers. Office is what the app's default theme part carries. */
export const EFFECT_SCHEMES = Object.freeze([
  { name: 'Office', styles: [[shadow(3.15, 1.57, 90, 0.38)], [shadow(3.15, 1.81, 90, 0.35)], [shadow(3.15, 1.81, 90, 0.35), bevel(5, 2)]] },
  { name: 'Flat', styles: [[], [], []] },
  { name: 'Soft Shadow', styles: [[shadow(3, 1, 90, 0.25)], [shadow(5, 2, 90, 0.3)], [shadow(8, 3, 90, 0.4)]] },
  { name: 'Lifted', styles: [[shadow(1, 2, 45, 0.3)], [shadow(1.5, 3.5, 45, 0.35)], [shadow(2, 5, 45, 0.4)]] },
  { name: 'Halo', styles: [[glow(3, 0.4)], [glow(5, 0.4)], [glow(8, 0.5)]] },
  { name: 'Chiselled', styles: [[bevel(2, 1)], [bevel(3, 2), shadow(2, 1, 90, 0.25)], [bevel(5, 2), shadow(4, 2, 90, 0.35)]] },
]);
const EFFECT_LEVEL_KEYS = ['coreThemeEffects.level.subtle', 'coreThemeEffects.level.moderate', 'coreThemeEffects.level.intense'];
/** The three effect styles' names ("Subtle Effect"…), in the interface language each time one is read. */
export const EFFECT_LEVELS = Object.freeze(EFFECT_LEVEL_KEYS.reduce((list, key, i) => Object.defineProperty(list, i, { get: () => t(key), enumerable: true }), []));

// The schemes' names on screen; files keep the names above.
const EFFECT_NAME_KEYS = {
  Office: 'coreThemeEffects.scheme.office', Flat: 'coreThemeEffects.scheme.flat', 'Soft Shadow': 'coreThemeEffects.scheme.softShadow',
  Lifted: 'coreThemeEffects.scheme.lifted', Halo: 'coreThemeEffects.scheme.halo', Chiselled: 'coreThemeEffects.scheme.chiselled',
};
/** An effect scheme's name in the interface language, or the name itself when the app does not know it. */
export const effectSchemeName = name => (Object.hasOwn(EFFECT_NAME_KEYS, name) ? t(EFFECT_NAME_KEYS[name]) : name);

export const effectScheme = name => EFFECT_SCHEMES.find(s => s.name === name) || null;
/** The workbook's effect scheme (Office when it names none). */
export const workbookEffects = wb => effectScheme(wb?.themeInfo?.effects) || effectScheme(DEFAULT_EFFECTS_NAME);

export const normalizeEffectRef = v => (Number.isInteger(v) && v >= 1 && v <= 3 ? v : 0);

/* ---------- Theme part ---------- */

const EMU = 12700;
const emu = pt => Math.round(pt * EMU);
const pct = a => Math.round(a * 100000);
function effectStyleXml(style) {
  const g = style.find(e => e.glow)?.glow, s = style.find(e => e.shadow)?.shadow, b = style.find(e => e.bevel)?.bevel;
  // CT_EffectList orders glow before outerShdw.
  const list = [
    g && `<a:glow rad="${emu(g.rad)}"><a:schemeClr val="phClr"><a:alpha val="${pct(g.alpha)}"/></a:schemeClr></a:glow>`,
    s && `<a:outerShdw blurRad="${emu(s.blur)}" dist="${emu(s.dist)}" dir="${Math.round(s.dir * 60000)}" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="${pct(s.alpha)}"/></a:srgbClr></a:outerShdw>`,
  ].filter(Boolean).join('');
  const threeD = b ? '<a:scene3d><a:camera prst="orthographicFront"><a:rot lat="0" lon="0" rev="0"/></a:camera><a:lightRig rig="threePt" dir="t"><a:rot lat="0" lon="0" rev="1200000"/></a:lightRig></a:scene3d>'
    + `<a:sp3d><a:bevelT w="${emu(b.w)}" h="${emu(b.h)}"/></a:sp3d>` : '';
  return `<a:effectStyle>${list ? `<a:effectLst>${list}</a:effectLst>` : '<a:effectLst/>'}${threeD}</a:effectStyle>`;
}
export const effectStyleListXml = scheme => `<a:effectStyleLst>${scheme.styles.map(effectStyleXml).join('')}</a:effectStyleLst>`;

/** Write `name`'s effect styles (and its name) into a theme1.xml part. Office leaves the part as it is. */
export function writeEffectScheme(xml, name) {
  const scheme = effectScheme(name);
  if (!scheme || name === DEFAULT_EFFECTS_NAME || typeof xml !== 'string') return xml;
  return xml.replace(/<a:effectStyleLst\b[^>]*>[\s\S]*?<\/a:effectStyleLst>/, effectStyleListXml(scheme))
    .replace(/(<a:fmtScheme\b[^>]*?\bname\s*=\s*)(?:"[^"]*"|'[^']*')/, `$1"${name}"`);
}

/** The effect scheme a theme1.xml part names, when it is one the gallery knows (Office included). */
export function readEffectSchemeName(xml) {
  if (typeof xml !== 'string') return null;
  const open = xml.match(/<(?:[\w.-]+:)?fmtScheme\b[^>]*>/)?.[0];
  const name = open && /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(open);
  const value = name ? (name[1] ?? name[2]) : null;
  return effectScheme(value) ? value : null;
}

/* ---------- Drawing ---------- */

const rgba = (hex, a) => `rgba(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')}, ${a})`;
const PX = 4 / 3;
/**
 * The CSS that draws theme effect `ref` (1–3) of `scheme` in `color` (the effect's colour: glows take it),
 * at `scale`. A drop-shadow filter follows what is drawn: the box when it is filled, the letters when not.
 */
export function themeEffectCss(scheme, ref, color = '#4f81bd', { scale = 1, filled = false } = {}) {
  const style = scheme?.styles?.[normalizeEffectRef(ref) - 1];
  if (!style?.length) return {};
  const filters = [], insets = [];
  for (const e of style) {
    if (e.glow) filters.push(`drop-shadow(0 0 ${(e.glow.rad * PX * scale).toFixed(2)}px ${rgba(color, e.glow.alpha)})`);
    if (e.shadow) {
      const d = e.shadow.dist * PX * scale, rad = e.shadow.dir * Math.PI / 180;
      filters.push(`drop-shadow(${(Math.cos(rad) * d).toFixed(2)}px ${(Math.sin(rad) * d).toFixed(2)}px ${(e.shadow.blur * PX * scale / 2).toFixed(2)}px ${rgba('#000000', e.shadow.alpha)})`);
    }
    if (e.bevel && filled) {
      const w = Math.max(1, e.bevel.w * PX * scale / 2);
      insets.push(`inset ${w.toFixed(2)}px ${w.toFixed(2)}px ${w.toFixed(2)}px rgba(255, 255, 255, 0.55)`, `inset -${w.toFixed(2)}px -${w.toFixed(2)}px ${w.toFixed(2)}px rgba(0, 0, 0, 0.3)`);
    }
  }
  return { ...(filters.length ? { filter: filters.join(' ') } : {}), ...(insets.length ? { boxShadow: insets.join(', ') } : {}) };
}

/** The `xdr:style` a text box carries for theme effect `ref`, in Accent 1, as Office writes shape styles. */
export const effectRefStyleXml = ref => normalizeEffectRef(ref)
  ? `<xdr:style><a:lnRef idx="0"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="${normalizeEffectRef(ref)}"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></xdr:style>`
  : '';

/** The theme effect CSS for a text box, WordArt or equation `obj` in workbook `wb` (Accent 1 for glows). */
export function textBoxEffectCss(wb, obj, scale = 1) {
  const ref = normalizeEffectRef(obj?.style?.effectRef);
  if (!ref) return {};
  const accent = effectiveColorPalette(wb?.colorPalette).theme[4];
  return themeEffectCss(workbookEffects(wb), ref, accent, { scale, filled: !!obj.style?.bg });
}
