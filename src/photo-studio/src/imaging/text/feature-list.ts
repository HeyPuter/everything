// OpenType feature lists stored in character styles ("liga -calt frac"):
// the Type menu's features, toggling them and their CSS settings. Which
// features a font file implements is read in font-features.ts.

// Stylistic sets ss01–ss20; fonts may name them (font-features.ts).
export const STYLISTIC_SETS = Array.from({ length: 20 }, (_, i) => `ss${String(i + 1).padStart(2, '0')}`) as readonly string[];
// Features offered in the Type menu: ligatures, contextual, stylistic,
// titling and justification alternates, swash, ornaments, small capitals,
// figure styles (lining or oldstyle, proportional or tabular), slashed zero,
// case-sensitive forms, superscript and subscript, ordinals, fractions and
// the stylistic sets.
export const OPENTYPE_FEATURES = [
  'liga', 'dlig', 'calt', 'swsh', 'onum', 'salt', 'titl', 'ordn', 'frac',
  'ornm', 'jalt', 'smcp', 'c2sc', 'lnum', 'pnum', 'tnum', 'zero', 'case', 'sups', 'subs',
  ...STYLISTIC_SETS,
] as const;
export type OpenTypeFeature = string;
// Features that exclude each other: turning one on turns the others off.
export const EXCLUSIVE_FEATURES: readonly (readonly string[])[] = [
  ['lnum', 'onum'],
  ['pnum', 'tnum'],
  ['sups', 'subs'],
];
// Features text shapers apply without being asked; styles store them as
// "-tag" when switched off.
export const DEFAULT_ON_FEATURES = new Set<string>(['liga', 'calt', 'clig']);

/** Canonical feature list: known tags ("tag" on, "-tag" off for default
 * features), deduplicated and sorted, space-separated. */
export function normalizeFeatures(features: string | undefined): string {
  const out = new Set<string>();
  for (const t of (features ?? '').split(/\s+/)) {
    const off = t.startsWith('-');
    const tag = off ? t.slice(1) : t;
    if (!/^[a-z0-9]{4}$/.test(tag)) continue;
    if (off && !DEFAULT_ON_FEATURES.has(tag)) continue;
    if (!off && DEFAULT_ON_FEATURES.has(tag)) continue;
    out.add(off ? `-${tag}` : tag);
  }
  return [...out].sort().join(' ');
}
/** Toggle one menu feature in a feature list. */
export function toggleFeature(features: string | undefined, tag: string, on: boolean): string {
  const list = new Set(normalizeFeatures(features).split(' ').filter(Boolean));
  list.delete(tag);
  list.delete(`-${tag}`);
  if (on) for (const group of EXCLUSIVE_FEATURES) if (group.includes(tag)) for (const other of group) list.delete(other);
  if (DEFAULT_ON_FEATURES.has(tag)) {
    if (!on) list.add(`-${tag}`);
  } else if (on) list.add(tag);
  return normalizeFeatures([...list].join(' '));
}
/** Whether a feature is in effect for a feature list. */
export function featureOn(features: string | undefined, tag: string): boolean {
  const list = normalizeFeatures(features).split(' ');
  return DEFAULT_ON_FEATURES.has(tag) ? !list.includes(`-${tag}`) : list.includes(tag);
}
// Fractions are not switched on for whole runs (that would raise every
// digit): layout turns a slash between digits into the fraction slash and
// the shaper applies the font's fraction forms around it.
const LAYOUT_ONLY = new Set(['frac']);
/** CSS font-feature-settings value for a feature list ('' when none). */
export function featureSettings(features: string | undefined): string {
  const n = normalizeFeatures(features).split(' ').filter((t) => t && !LAYOUT_ONLY.has(t));
  return n.map((t) => (t.startsWith('-') ? `"${t.slice(1)}" 0` : `"${t}" 1`)).join(', ');
}
/** The feature list a font face needs (layout-only features removed). */
export const faceFeatures = (features: string | undefined) => normalizeFeatures(features).split(' ').filter((t) => t && !LAYOUT_ONLY.has(t)).join(' ');
