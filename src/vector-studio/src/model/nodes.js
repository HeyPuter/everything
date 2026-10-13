/**
 * Node factories and the shared style fields.
 *
 * Nodes are plain JSON-safe objects and are treated as immutable: every
 * change goes through VDocument.update(), which replaces the object. That
 * makes undo snapshots free (the old object is the snapshot) and lets caches
 * (Path2D, bounds) key on object identity in WeakMaps.
 *
 * Types:
 *   root      { children: [layerId], artboards, guides, swatches, units, ... }
 *   layer     { name, color, children, hidden, locked, template }
 *   group     { children, clip }          clip: the last child masks the rest
 *   path      { anchors, closed, shape? } shape: live-shape params
 *   compound  { children: [pathId], fillRule }
 *   text      { text, kind: 'point'|'area'|'path', x, y, width, height, transform, char, para,
 *               runs?, paras?, vertical?, areaPath?, areaOptions?, pathAnchors?, pathClosed?, pathOptions? }
 *             `char` is the default character style; `runs` ([{ len, ...overrides }],
 *             covering the text) override it per character range, including fill
 *             and stroke. `paras` holds per-paragraph overrides of `para`.
 *             See model/text-runs.js and model/text-layout.js.
 *             Threaded area type: frames link with threadNext/threadPrev ids; the
 *             first frame holds the story (text, runs, paras), the others hold
 *             none and show the part that flows into them. Any object can carry
 *             textWrap { offset, invert } to push area type below it aside.
 *   image     { asset, width, height, transform }
 *   instance  { symbol, transform }  a placed symbol (see features/symbols)
 *
 * Groups and leaves can be live artwork (node.live = { kind, ...params },
 * or a blend's node.blend): what draws is generated from their contents,
 * see model/live.js.
 *
 * Paintable nodes (path, compound, text) carry the style fields below. A
 * paint is null (None), { type: 'solid', color: '#rrggbb' }, or a gradient
 * { type: 'linear'|'radial', stops: [{ offset, color, opacity }], angle,
 *   aspect, x1, y1, x2, y2 } where the end points are optional (absent means
 * "fit the object's bounds at `angle`").
 */
import { uid } from '../lib/ids.js';
import { liveDef } from './live.js';

export const LAYER_COLORS = ['#4f80ff', '#ff4f4f', '#4fc24f', '#4fb8ff', '#ff4fd8', '#ffc34f', '#9b6bff', '#ff8a3d', '#3dd1b8'];

export const DEFAULT_STYLE = Object.freeze({
  fill: Object.freeze({ type: 'solid', color: '#ffffff' }),
  stroke: Object.freeze({ type: 'solid', color: '#000000' }),
  strokeWidth: 1,
  strokeCap: 'butt',
  strokeJoin: 'miter',
  miterLimit: 10,
  strokeAlign: 'center',
  dash: Object.freeze([]),
  dashOffset: 0,
  arrowStart: null,
  arrowEnd: null,
  opacity: 1,
  blendMode: 'normal',
  effects: Object.freeze([]),
});

export const STYLE_KEYS = Object.keys(DEFAULT_STYLE);

/** Copy just the style fields of a node (for the eyedropper, paste style, graphic styles). */
export function pickStyle(node) {
  const out = {};
  for (const k of STYLE_KEYS) if (node[k] !== undefined) out[k] = node[k];
  return out;
}

export function isContainer(node) {
  return node && (node.type === 'root' || node.type === 'layer' || node.type === 'group' || node.type === 'compound');
}

export function isPaintable(node) {
  return node && (node.type === 'path' || node.type === 'compound' || node.type === 'text');
}

export function createLayer(name, color) {
  return { id: uid('l'), type: 'layer', name, color: color || LAYER_COLORS[0], children: [], hidden: false, locked: false };
}

export function createGroup(children = [], extra = {}) {
  return { id: uid('g'), type: 'group', name: '', children, clip: false, hidden: false, locked: false, ...extra };
}

export function createPath(anchors, closed, style = {}, extra = {}) {
  return {
    id: uid('p'),
    type: 'path',
    name: '',
    anchors,
    closed: Boolean(closed),
    hidden: false,
    locked: false,
    ...DEFAULT_STYLE,
    ...style,
    ...extra,
  };
}

export function createCompound(children = [], style = {}, extra = {}) {
  return {
    id: uid('c'),
    type: 'compound',
    name: '',
    children,
    fillRule: 'nonzero',
    hidden: false,
    locked: false,
    ...DEFAULT_STYLE,
    ...style,
    ...extra,
  };
}

export const DEFAULT_CHAR = Object.freeze({
  fontFamily: 'Inter',
  fontWeight: 400,
  fontStyle: 'normal',
  fontSize: 12,
  leading: null, // null = auto (120% of the size)
  tracking: 0, // thousandths of an em
  baselineShift: 0,
  horizontalScale: 100,
  verticalScale: 100,
  underline: false,
  strike: false,
  caps: 'normal', // normal | all | small
  kerning: 0, // manual kerning before this character, thousandths of an em
  kernMode: 'metrics', // automatic kerning: metrics (the font's pairs) | optical (from the outlines) | none
  fractionalWidths: true, // false rounds character advances to whole points
  noBreak: false, // keep these characters on one line
  rotation: 0, // character rotation in degrees
  position: 'normal', // normal | super | sub
  // OpenType features (applied where the font has them, see features/type/shaping.js).
  ligatures: true, // standard ligatures (liga)
  contextual: true, // contextual alternates and ligatures (calt, clig)
  discretionary: false, // discretionary ligatures (dlig)
  swash: false, // swsh
  stylistic: false, // stylistic alternates (salt)
  stylisticSets: null, // [1..20] -> ss01..ss20
  titling: false, // titl
  ordinals: false, // ordn
  fractions: false, // frac
  figures: 'default', // default | tabular-lining | proportional-lining | proportional-oldstyle | tabular-oldstyle
  otPosition: 'default', // default | sups | subs | numr | dnom
  altGlyph: null, // a specific glyph (font glyph index) for these characters, from the Glyphs panel
  charStyle: null, // character style id (doc.root.charStyles) the attributes came from
});

export const DEFAULT_PARA = Object.freeze({
  align: 'left', // left | center | right | justify | justify-center | justify-right | justify-all
  indentLeft: 0,
  indentRight: 0,
  indentFirst: 0,
  spaceBefore: 0,
  spaceAfter: 0,
  tabs: null, // [{ pos, align: 'left'|'center'|'right'|'decimal', leader, decimal }] from the frame's left edge
  list: null, // { kind: 'bullet'|'number', bullet, format: '1'|'a'|'A'|'i'|'I', suffix, start } bullets and numbering
  opticalMargin: false, // hang punctuation outside the margins
  hangingPunctuation: false, // hang punctuation fully outside the margins (this paragraph)
  hyphenate: false, // automatic hyphenation
  hyphenation: null, // { minWord, minBefore, minAfter, limit, zone, capitalized } (see model/hyphenate.js)
  justification: null, // { wordMin/Desired/Max, letterMin/Desired/Max, glyphMin/Desired/Max (%), autoLeading (%), singleWord }
  composer: 'single', // single: fill line by line | every: choose the breaks of the whole paragraph together
  paraStyle: null, // paragraph style id (doc.root.paraStyles) the attributes came from
});

export function createText(text, x, y, extra = {}) {
  return {
    id: uid('t'),
    type: 'text',
    name: '',
    kind: 'point',
    text,
    x,
    y,
    width: 0,
    height: 0,
    transform: [1, 0, 0, 1, 0, 0],
    char: { ...DEFAULT_CHAR },
    para: { ...DEFAULT_PARA },
    hidden: false,
    locked: false,
    ...DEFAULT_STYLE,
    fill: { type: 'solid', color: '#000000' },
    stroke: null,
    ...extra,
  };
}

export function createImage(asset, width, height, transform = [1, 0, 0, 1, 0, 0], extra = {}) {
  return {
    id: uid('i'),
    type: 'image',
    name: '',
    asset,
    width,
    height,
    transform,
    opacity: 1,
    blendMode: 'normal',
    effects: [],
    hidden: false,
    locked: false,
    ...extra,
  };
}

/** Human label for the Layers panel when a node has no name, like "<Rectangle>". */
export function defaultLabel(node) {
  if (node.name) return node.name;
  const live = liveDef(node);
  if (live?.label) return typeof live.label === 'function' ? live.label(node) : live.label;
  switch (node.type) {
    case 'path':
      if (node.shape?.kind === 'rect') return '<Rectangle>';
      if (node.shape?.kind === 'ellipse') return '<Ellipse>';
      if (node.shape?.kind === 'polygon') return '<Polygon>';
      if (node.shape?.kind === 'star') return '<Star>';
      if (node.shape?.kind === 'line') return '<Line>';
      return '<Path>';
    case 'compound':
      return '<Compound Path>';
    case 'group':
      return node.blend ? '<Blend>' : node.clip ? '<Clip Group>' : node.compoundShape ? '<Compound Shape>' : '<Group>';
    case 'text':
      return (node.text || '').split('\n')[0].slice(0, 40) || '<Text>';
    case 'image':
      return '<Image>';
    case 'layer':
      return 'Layer';
    default:
      return node.type;
  }
}
