// Geometry and data helpers for editable text layers (no DOM).
//
// A text layer keeps its typography in `textData`, expressed in the text's own
// local space (the engine's "document pixels" before placement). `textFrame`
// is a rectangle in that local space and `transform` is where that rectangle
// sits in the document, so moving, scaling and rotating with the ordinary
// transform tools keeps the text editable. The mapping between the two
// spaces is the similarity-plus-scale `textMatrix`; content edits refit the
// frame to the new bounds without changing that mapping.

import { allLayers, type Layer, type PhotoDocument, type Rect, type Transform } from './document';
import {
  defaultCharStyle,
  fromPlainText,
  plainText,
  pxToPt,
  type CharStyle,
  type ParagraphStyle,
  type TextContent,
  type TextLayerData,
} from '../imaging/text/model';

export type Affine = [number, number, number, number, number, number]; // x' = a x + c y + e, y' = b x + d y + f

export function documentPpi(doc: Pick<PhotoDocument, 'resolution'>): number {
  const r = doc.resolution;
  if (!r || !(r.horizontalResolution > 0)) return 72;
  return r.horizontalResolutionUnit === 'PPCM' ? r.horizontalResolution * 2.54 : r.horizontalResolution;
}

export function textFrameOf(l: Layer): Rect {
  const t = l.transform;
  const f = l.textFrame;
  return f && f.width > 0 && f.height > 0 ? f : { x: t.x, y: t.y, width: t.width, height: t.height };
}

export function textScale(l: Layer): [number, number] {
  const f = textFrameOf(l);
  return [l.transform.width / f.width, l.transform.height / f.height];
}

// Local text space -> document.
export function textMatrix(l: Layer): Affine {
  const t = l.transform,
    f = textFrameOf(l);
  const sx = t.width / f.width,
    sy = t.height / f.height;
  const r = (t.rotation * Math.PI) / 180,
    cos = Math.cos(r),
    sin = Math.sin(r);
  const a = cos * sx,
    b = sin * sx,
    c = -sin * sy,
    d = cos * sy;
  const fcx = f.x + f.width / 2,
    fcy = f.y + f.height / 2;
  const tcx = t.x + t.width / 2,
    tcy = t.y + t.height / 2;
  return [a, b, c, d, tcx - (a * fcx + c * fcy), tcy - (b * fcx + d * fcy)];
}
export const applyAffine = (m: Affine, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function invertAffine(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / det,
    b = -m[1] / det,
    c = -m[2] / det,
    d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

// Document placement of a rectangle given in local text space.
export function placeTextRect(l: Layer, r: Rect): Transform {
  const m = textMatrix(l);
  const [sx, sy] = textScale(l);
  const [cx, cy] = applyAffine(m, r.x + r.width / 2, r.y + r.height / 2);
  const width = Math.max(1e-3, r.width * sx),
    height = Math.max(1e-3, r.height * sy);
  return { x: cx - width / 2, y: cy - height / 2, width, height, rotation: l.transform.rotation };
}

// Refits the layer's frame and transform to new local bounds, keeping the
// local->document mapping (so the text does not jump while it is edited).
export function fitTextFrame(l: Layer, local: Rect) {
  const r = { x: local.x, y: local.y, width: Math.max(1, local.width), height: Math.max(1, local.height) };
  l.transform = placeTextRect(l, r);
  l.textFrame = r;
  l.sourceWidth = Math.max(1, Math.min(8192, Math.round(r.width)));
  l.sourceHeight = Math.max(1, Math.min(8192, Math.round(r.height)));
}

// Uniform scaling from the transform tools becomes a type size change;
// non-uniform scaling stays in the transform.
export function bakeTextScale(l: Layer): boolean {
  if (!l.textData) return false;
  const [sx, sy] = textScale(l);
  if (!Number.isFinite(sx) || Math.abs(sx - sy) > 1e-3 * Math.max(sx, sy) || Math.abs(sx - 1) < 1e-4) return false;
  const f = textFrameOf(l);
  const cx = f.x + f.width / 2,
    cy = f.y + f.height / 2;
  l.textData = scaleTextData(l.textData, sx, cx, cy);
  // Same center; the frame takes the transform's size so the scale is exactly 1.
  const { width, height } = l.transform;
  l.textFrame = { x: cx - width / 2, y: cy - height / 2, width, height };
  return true;
}

const round = (v: number, step = 1000) => Math.round(v * step) / step;
// Attributes in points; partial styles (style definitions) keep what they omit.
const charPoints = ['size', 'leading', 'baselineShift'] as const;
const paragraphPoints = ['indentLeft', 'indentRight', 'indentFirst', 'spaceBefore', 'spaceAfter'] as const;
function scalePoints<T extends object>(style: T, keys: readonly string[], s: number): T {
  const out = { ...style } as Record<string, unknown>;
  for (const k of keys) if (typeof out[k] === 'number') out[k] = round((out[k] as number) * s);
  if (Array.isArray(out.color)) out.color = [...out.color];
  return out as T;
}
/** Type with its point sizes (size, leading, shift, indents, spacing) scaled. */
function scaleContent(c: TextContent, s: number): TextContent {
  return { paragraphs: c.paragraphs.map((p) => ({ style: scalePoints(p.style, paragraphPoints, s), runs: p.runs.map((r) => ({ text: r.text, style: scalePoints(r.style, charPoints, s) })) })) };
}
export function scaleTextData(data: TextLayerData, s: number, cx = 0, cy = 0): TextLayerData {
  return {
    ...data,
    content: scaleContent(data.content, s),
    origin: { x: cx + (data.origin.x - cx) * s, y: cy + (data.origin.y - cy) * s },
    box: data.box ? { width: data.box.width * s, height: data.box.height * s } : undefined,
    warp: data.warp ? { ...data.warp } : undefined,
    ...(data.block ? { block: { width: data.block.width * s, gap: data.block.gap * s } } : {}),
    path: data.path
      ? {
          ...data.path,
          knots: data.path.knots.map((k) => k.map((v, i) => (i % 2 ? cy + (v - cy) * s : cx + (v - cx) * s))),
          ...(data.path.inset !== undefined ? { inset: data.path.inset * s } : {}),
          ...(data.path.arc ? { arc: { ...data.path.arc, x: cx + (data.path.arc.x - cx) * s, y: cy + (data.path.arc.y - cy) * s, width: data.path.arc.width * s } } : {}),
        }
      : undefined,
  };
}

/** Set the document resolution keeping type the same size in pixels: point
 * sizes of text layers and of character and paragraph styles are converted
 * (type in points would otherwise grow with the resolution). */
export function setDocumentResolution(doc: PhotoDocument, resolution: PhotoDocument['resolution']) {
  const k = documentPpi(doc) / documentPpi({ resolution });
  if (resolution) doc.resolution = resolution;
  else delete doc.resolution;
  if (!Number.isFinite(k) || Math.abs(k - 1) < 1e-9) return;
  for (const l of allLayers(doc.layers))
    if (l.textData) {
      l.textData = { ...l.textData, content: scaleContent(l.textData.content, k) };
      syncLegacyFields(l);
    }
  const styles = doc.textStyles;
  if (styles)
    doc.textStyles = {
      character: styles.character.map((c) => ({ ...c, style: scalePoints(c.style, charPoints, k) })),
      paragraph: styles.paragraph.map((p) => ({ ...p, char: scalePoints(p.char, charPoints, k), paragraph: scalePoints(p.paragraph, paragraphPoints, k) })),
    };
}

// Approximate ascent of the old fixed sans-serif text, whose lines were drawn
// with a top baseline; used once when such a layer is first edited.
const LEGACY_ASCENT = 0.9;
// Converts a legacy text layer (plain `text` + `fontSize` in pixels) into
// engine data that looks the same, in the layer's own source space.
export function legacyTextData(l: Layer, ppi: number): { data: TextLayerData; frame: Rect } {
  const style: CharStyle = { ...defaultCharStyle(), weight: 600, size: round(pxToPt(l.fontSize, ppi), 100), color: hexRgb(l.color) };
  const data: TextLayerData = {
    content: fromPlainText(l.text, style),
    mode: 'point',
    origin: { x: 0, y: l.fontSize * LEGACY_ASCENT },
    orientation: 'horizontal',
    antiAlias: 'smooth',
  };
  return { data, frame: { x: 0, y: 0, width: Math.max(1, l.sourceWidth), height: Math.max(1, l.sourceHeight) } };
}
export function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbHexString = (c: readonly number[]) => '#' + c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

// Layer names follow the text until the user renames the layer.
export function textLayerName(content: TextContent): string {
  const t = plainText(content).replace(/\s+/g, ' ').trim();
  return t ? (t.length > 40 ? t.slice(0, 40) + '…' : t) : 'Text';
}
// Keeps the legacy fields in step so older readers and searches still work.
export function syncLegacyFields(l: Layer) {
  if (!l.textData) return;
  const first = l.textData.content.paragraphs[0]?.runs[0]?.style;
  l.text = plainText(l.textData.content);
  if (first) {
    l.color = rgbHexString(first.color);
    l.fontSize = Math.max(1, first.size);
  }
}

// --------------------------------------------------------- validation

const ALIGN = ['left', 'center', 'right', 'justify-left', 'justify-center', 'justify-right', 'justify-all'];
const WARPS = ['none', 'arc', 'arc-lower', 'arc-upper', 'arch', 'bulge', 'shell-lower', 'shell-upper', 'flag', 'wave', 'fish', 'rise', 'fisheye', 'inflate', 'squeeze', 'twist'];
const AA = ['none', 'sharp', 'crisp', 'strong', 'smooth'];
const num = (v: unknown, lo = -1e6, hi = 1e6) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const bool = (v: unknown) => typeof v === 'boolean';

export function validateTextData(d: unknown): asserts d is TextLayerData {
  const fail = (what: string) => {
    throw new Error(`Invalid text layer (${what}).`);
  };
  const t = d as TextLayerData;
  if (!t || typeof t !== 'object') fail('data');
  if (!['point', 'paragraph'].includes(t.mode) || !['horizontal', 'vertical'].includes(t.orientation) || !AA.includes(t.antiAlias)) fail('mode');
  if (!t.origin || !num(t.origin.x) || !num(t.origin.y)) fail('origin');
  if (t.box !== undefined && (!t.box || !num(t.box.width, 0) || !num(t.box.height, 0))) fail('box');
  if (t.warp !== undefined && (!t.warp || !WARPS.includes(t.warp.style) || !num(t.warp.bend, -100, 100) || !num(t.warp.horizontal, -100, 100) || !num(t.warp.vertical, -100, 100) || !['horizontal', 'vertical'].includes(t.warp.axis))) fail('warp');
  if (t.path !== undefined) {
    const p = t.path;
    if (
      !p || !['path', 'area'].includes(p.kind) || !bool(p.closed) || !bool(p.flip) || !num(p.start, 0, 1) || !num(p.end, 0, 1) ||
      (p.inset !== undefined && !num(p.inset, 0, 1e5)) || !Array.isArray(p.knots) || p.knots.length < 2 || p.knots.length > 10_000 ||
      !p.knots.every((k) => Array.isArray(k) && k.length === 6 && k.every((v) => num(v))) ||
      (p.kind === 'area' && !p.closed) ||
      (p.arc !== undefined && (!p.arc || !['arch', 'circle', 'bow', 'wave'].includes(p.arc.preset) || !num(p.arc.bend, -100, 100) || !num(p.arc.x) || !num(p.arc.y) || !num(p.arc.width, 0)))
    )
      fail('path');
  }
  if (t.block !== undefined && (!t.block || !num(t.block.width, 1, 1e6) || !num(t.block.gap, -1e5, 1e5) || t.orientation !== 'horizontal' || !!t.path)) fail('block');
  const paras = t.content?.paragraphs;
  if (!Array.isArray(paras) || !paras.length || paras.length > 100_000) fail('paragraphs');
  let chars = 0;
  for (const p of paras) {
    const s = p?.style;
    if (!s || !ALIGN.includes(s.align) || !['indentLeft', 'indentRight', 'indentFirst', 'spaceBefore', 'spaceAfter'].every((k) => num(s[k as keyof ParagraphStyle])) || !bool(s.hyphenate)) fail('paragraph style');
    if ((s.paragraphStyle !== undefined && typeof s.paragraphStyle !== 'string') || (s.direction !== undefined && s.direction !== 'ltr' && s.direction !== 'rtl')) fail('paragraph style');
    if (!Array.isArray(p.runs) || !p.runs.length) fail('runs');
    for (const r of p.runs) {
      if (typeof r?.text !== 'string' || r.text.includes('\n')) fail('run text');
      chars += r.text.length;
      const c = r.style;
      if (
        !c || typeof c.family !== 'string' || !c.family || c.family.length > 200 ||
        !num(c.weight, 1, 1000) || !bool(c.italic) || !num(c.size, 0.01, 10000) ||
        !(c.leading === 'auto' || num(c.leading, 0, 100000)) || !num(c.tracking, -10000, 10000) ||
        !['metrics', 'optical', 'none'].includes(c.kerning) || !num(c.baselineShift) ||
        !num(c.scaleX, 0.1, 10000) || !num(c.scaleY, 0.1, 10000) ||
        !Array.isArray(c.color) || c.color.length !== 3 || !c.color.every((v) => num(v, 0, 255)) ||
        !['fauxBold', 'fauxItalic', 'allCaps', 'smallCaps', 'superscript', 'subscript', 'underline', 'strikethrough', 'ligatures'].every((k) => bool(c[k as keyof CharStyle])) ||
        typeof c.language !== 'string' ||
        (c.charStyle !== undefined && typeof c.charStyle !== 'string') ||
        (c.features !== undefined && (typeof c.features !== 'string' || c.features.length > 200)) ||
        (c.digits !== undefined && c.digits !== '' && c.digits !== 'arabic' && c.digits !== 'persian') ||
        (c.vertical !== undefined && c.vertical !== '' && c.vertical !== 'rotate' && c.vertical !== 'combine')
      )
        fail('character style');
    }
  }
  if (chars > 1_000_000) fail('length');
}
