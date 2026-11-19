// Mapping between PSD text layers (ag-psd `layer.text`) and editable text.
//
// PSD text engine values are in pixels of the layer's local text space and
// the layer `transform` places that space in the document; type sizes in
// the editor are points, so sizes convert through the document resolution.

import type { LayerTextData, TextStyle, ParagraphStyle as PsdParagraphStyle, WarpStyle as PsdWarpStyle } from 'ag-psd';
import {
  defaultCharStyle,
  defaultParagraphStyle,
  plainText,
  ptToPx,
  pxToPt,
  type Align,
  type CharStyle,
  type ParagraphStyle,
  type Paragraph,
  type TextLayerData,
  type TypePath,
  type WarpStyle,
} from '../imaging/text/model';
import { BUNDLED_FONTS, SYSTEM_FAMILIES, weightFromStyleName } from '../imaging/text/fonts';
import type { Affine } from './text-layer';

const WARP_IN: Partial<Record<PsdWarpStyle, WarpStyle>> = {
  none: 'none', arc: 'arc', arcLower: 'arc-lower', arcUpper: 'arc-upper', arch: 'arch', bulge: 'bulge', shellLower: 'shell-lower', shellUpper: 'shell-upper',
  flag: 'flag', wave: 'wave', fish: 'fish', rise: 'rise', fisheye: 'fisheye', inflate: 'inflate', squeeze: 'squeeze', twist: 'twist',
};
const WARP_OUT = Object.fromEntries(Object.entries(WARP_IN).map(([k, v]) => [v, k])) as Record<WarpStyle, PsdWarpStyle>;

const knownFamilies = () => [...BUNDLED_FONTS.map((f) => f.family), ...SYSTEM_FAMILIES.map((f) => f.family)];
const squash = (s: string) => s.replace(/[\s_-]+/g, '').toLowerCase();

// PostScript names look like "Family-Style" ("Inter-BoldItalic", "ArialMT",
// "TimesNewRomanPS-BoldMT"). Known families are matched ignoring spaces.
export function parsePostScriptName(name: string): { family: string; weight: number; italic: boolean } {
  const dash = name.indexOf('-');
  let base = dash > 0 ? name.slice(0, dash) : name;
  const style = dash > 0 ? name.slice(dash + 1) : '';
  const italic = /italic|oblique/i.test(style) || /(^|[a-z])It$/.test(style);
  const weight = weightFromStyleName(style.replace(/MT$|PS$/, ''));
  const stripped = base.replace(/(PSMT|MT|PS)$/, '');
  for (const cand of [base, stripped]) {
    const hit = knownFamilies().find((f) => squash(f) === squash(cand));
    if (hit) return { family: hit, weight, italic };
  }
  base = stripped || base;
  const family = base.replace(/([a-z])([A-Z])/g, '$1 $2').trim() || 'Inter';
  return { family, weight, italic };
}
const STYLE_NAMES: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
const SPECIAL: Record<string, (bold: boolean, italic: boolean) => string> = {
  arial: (b, i) => (b || i ? `Arial-${b ? 'Bold' : ''}${i ? 'Italic' : ''}MT` : 'ArialMT'),
  timesnewroman: (b, i) => (b || i ? `TimesNewRomanPS-${b ? 'Bold' : ''}${i ? 'Italic' : ''}MT` : 'TimesNewRomanPSMT'),
  couriernew: (b, i) => (b || i ? `CourierNewPS-${b ? 'Bold' : ''}${i ? 'Italic' : ''}MT` : 'CourierNewPSMT'),
};
export function postScriptName(s: Pick<CharStyle, 'family' | 'weight' | 'italic'>): string {
  const key = squash(s.family);
  const w = Math.round(s.weight / 100) * 100;
  if (SPECIAL[key]) return SPECIAL[key](w >= 600, s.italic);
  const style = w === 400 && s.italic ? 'Italic' : `${STYLE_NAMES[w] ?? 'Regular'}${s.italic ? 'Italic' : ''}`;
  return `${s.family.replace(/\s+/g, '')}-${style}`;
}

const finite = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const channel = (v: unknown) => Math.round(clamp(finite(v, 0), 0, 255));

function charStyle(s: TextStyle, ppi: number): CharStyle {
  const base = defaultCharStyle();
  const font = s.font?.name ? parsePostScriptName(s.font.name) : { family: base.family, weight: 400, italic: false };
  const c = s.fillColor as { r?: number; g?: number; b?: number } | undefined;
  return {
    ...base,
    family: font.family,
    weight: font.weight,
    italic: font.italic,
    size: clamp(r3(pxToPt(finite(s.fontSize, 12), ppi)), 0.01, 10000),
    leading: s.autoLeading === false && finite(s.leading, 0) > 0 ? clamp(r3(pxToPt(s.leading!, ppi)), 0.01, 100000) : 'auto',
    tracking: clamp(finite(s.tracking, 0), -10000, 10000),
    kerning: s.autoKerning === false ? 'none' : 'metrics',
    baselineShift: r3(pxToPt(finite(s.baselineShift, 0), ppi)),
    scaleX: clamp(finite(s.horizontalScale, 1) * 100, 0.1, 10000),
    scaleY: clamp(finite(s.verticalScale, 1) * 100, 0.1, 10000),
    color: c && 'r' in c ? [channel(c.r), channel(c.g), channel(c.b)] : [0, 0, 0],
    fauxBold: !!s.fauxBold,
    fauxItalic: !!s.fauxItalic,
    allCaps: s.fontCaps === 2,
    smallCaps: s.fontCaps === 1,
    superscript: s.fontBaseline === 1,
    subscript: s.fontBaseline === 2,
    underline: !!s.underline,
    strikethrough: !!s.strikethrough,
    ligatures: s.ligatures !== false,
    ...(s.noBreak ? { noBreak: true } : {}),
  };
}
const triple = (v: unknown, k: number, lo: number, hi: number): number[] | undefined => {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return;
  const t = v.map((x: number) => clamp(r3(x * k), lo, hi));
  return t[0] <= t[1] && t[1] <= t[2] ? t : undefined;
};
const intIn = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v), lo, hi) : undefined);
// Paragraph options beyond the basics, kept only where the file sets them.
function paragraphOptions(p: PsdParagraphStyle, ppi: number): Partial<ParagraphStyle> {
  const out: Partial<ParagraphStyle> = {};
  const word = triple(p.wordSpacing, 100, 0, 1000), letter = triple(p.letterSpacing, 100, -100, 500), glyph = triple(p.glyphSpacing, 100, 50, 200);
  if (word && word.join() !== '100,100,133') out.wordSpacing = word;
  if (letter && letter.some((v) => v !== 0)) out.letterSpacing = letter;
  if (glyph && glyph.some((v) => v !== 100)) out.glyphScaling = glyph;
  if (typeof p.autoLeading === 'number' && Number.isFinite(p.autoLeading) && Math.abs(p.autoLeading - 1.2) > 1e-6) out.autoLeading = clamp(r3(p.autoLeading * 100), 0, 500);
  if (p.leadingType === 1) out.leadingModel = 'top';
  if (p.hanging) out.hanging = true;
  if (p.everyLineComposer) out.composer = 'every-line';
  if (p.autoHyphenate) {
    const minWord = intIn(p.hyphenatedWordSize, 2, 25), before = intIn(p.preHyphen, 1, 15), after = intIn(p.postHyphen, 1, 15), limit = intIn(p.consecutiveHyphens, 0, 25);
    if (minWord !== undefined) out.hyphenMinWord = minWord;
    if (before !== undefined) out.hyphenBefore = before;
    if (after !== undefined) out.hyphenAfter = after;
    if (limit !== undefined) out.hyphenLimit = limit;
    if (typeof p.zone === 'number' && Number.isFinite(p.zone) && p.zone > 0) out.hyphenZone = clamp(r3(pxToPt(p.zone, ppi)), 0, 5000);
  }
  return out;
}
function paragraphStyle(p: PsdParagraphStyle, ppi: number): ParagraphStyle {
  const aligns: Align[] = ['left', 'center', 'right', 'justify-left', 'justify-center', 'justify-right', 'justify-all'];
  return {
    ...defaultParagraphStyle(),
    align: aligns.includes(p.justification as Align) ? (p.justification as Align) : 'left',
    indentLeft: r3(pxToPt(finite(p.startIndent, 0), ppi)),
    indentRight: r3(pxToPt(finite(p.endIndent, 0), ppi)),
    indentFirst: r3(pxToPt(finite(p.firstLineIndent, 0), ppi)),
    spaceBefore: r3(pxToPt(finite(p.spaceBefore, 0), ppi)),
    spaceAfter: r3(pxToPt(finite(p.spaceAfter, 0), ppi)),
    hyphenate: !!p.autoHyphenate,
    ...paragraphOptions(p, ppi),
  };
}

export type ImportedText = { data: TextLayerData; matrix: Affine; scale: [number, number]; rotation: number };

// Editable text from a PSD text layer, or undefined when the layer uses
// features the editor cannot reproduce (skewed or mirrored transforms,
// custom envelope warps), in which case it stays a raster layer.
export function importPsdText(t: LayerTextData, ppi: number): ImportedText | undefined {
  if (typeof t.text !== 'string') return;
  const tr = t.transform ?? [1, 0, 0, 1, 0, 0];
  const [a, b, c, d, e, f] = tr.map((v) => finite(v, 0));
  const sx = Math.hypot(a, b);
  const det = a * d - b * c;
  if (!(sx > 1e-9) || !(det > 1e-12)) return;
  const sy = det / sx;
  // Shear shows as a non-orthogonal basis.
  if (Math.abs(a * c + b * d) > 1e-6 * sx * Math.hypot(c, d)) return;
  const warpStyle = t.warp?.style ?? 'none';
  const warp = WARP_IN[warpStyle];
  if (!warp) return;
  const text = t.text.replace(/\r\n?/g, '\n');
  const baseStyle = t.style ?? {};
  // Style runs: lengths count characters including paragraph breaks.
  const runs = t.styleRuns?.length ? t.styleRuns : [{ length: text.length, style: {} }];
  const paraRuns = t.paragraphStyleRuns?.length ? t.paragraphStyleRuns : [{ length: text.length, style: {} }];
  const charAt: CharStyle[] = [];
  {
    let pos = 0;
    for (const run of runs) {
      const st = charStyle({ ...baseStyle, ...run.style }, ppi);
      for (let k = 0; k < run.length; k++) charAt[pos++] = st;
    }
    const last = charAt[charAt.length - 1] ?? charStyle(baseStyle, ppi);
    while (charAt.length < text.length + 1) charAt.push(last);
  }
  const paraAt: ParagraphStyle[] = [];
  {
    let pos = 0;
    for (const run of paraRuns) {
      const st = paragraphStyle({ ...(t.paragraphStyle ?? {}), ...run.style }, ppi);
      for (let k = 0; k < run.length; k++) paraAt[pos++] = st;
    }
    const last = paraAt[paraAt.length - 1] ?? paragraphStyle(t.paragraphStyle ?? {}, ppi);
    while (paraAt.length < text.length + 1) paraAt.push(last);
  }
  const paragraphs: Paragraph[] = [];
  let start = 0;
  for (const line of text.split('\n')) {
    const pruns: Paragraph['runs'] = [];
    for (let i = 0; i < line.length; i++) {
      const st = charAt[start + i];
      const prev = pruns[pruns.length - 1];
      if (prev && prev.style === st) prev.text += line[i];
      else pruns.push({ text: line[i], style: st });
    }
    if (!pruns.length) pruns.push({ text: '', style: charAt[start] });
    paragraphs.push({ runs: pruns.map((r) => ({ text: r.text, style: { ...r.style, color: [...r.style.color] as CharStyle['color'] } })), style: { ...paraAt[start] } });
    start += line.length + 1;
  }
  // Text on a path: kept editable when its curve can be read, otherwise the
  // layer stays raster (laid out straight it would look wrong).
  let typePath: TypePath | undefined;
  if (t.textPath?.bezierCurve) {
    typePath = importTextPath(t.textPath);
    if (!typePath) return;
  }
  const box = t.shapeType === 'box' && t.boxBounds?.length === 4 ? t.boxBounds.map((v) => finite(v, 0)) : undefined;
  const data: TextLayerData = {
    content: { paragraphs },
    mode: box ? 'paragraph' : 'point',
    box: box ? { width: Math.max(1, box[2] - box[0]), height: Math.max(1, box[3] - box[1]) } : undefined,
    origin: box ? { x: box[0], y: box[1] } : { x: 0, y: 0 },
    orientation: t.orientation === 'vertical' ? 'vertical' : 'horizontal',
    antiAlias: (['none', 'sharp', 'crisp', 'strong', 'smooth'] as const).find((v) => v === t.antiAlias) ?? 'smooth',
    warp:
      warp === 'none'
        ? undefined
        : {
            style: warp,
            bend: clamp(finite(t.warp?.value, 0), -100, 100),
            horizontal: clamp(finite(t.warp?.perspective, 0), -100, 100),
            vertical: clamp(finite(t.warp?.perspectiveOther, 0), -100, 100),
            axis: t.warp?.rotate === 'vertical' ? 'vertical' : 'horizontal',
          },
  };
  if (typePath) {
    data.path = typePath;
    data.mode = typePath.kind === 'area' ? 'paragraph' : 'point';
    data.orientation = 'horizontal';
    data.warp = undefined;
    if (typePath.kind === 'path') data.box = undefined;
  }
  return { data, matrix: [a, b, c, d, e, f], scale: [sx, sy], rotation: (Math.atan2(b, a) * 180) / Math.PI };
}

// Text frame curve from the text engine: cubic segments of four points
// (start, two controls, end) in the layer's text space, placed by the frame
// matrix; `textRange` bounds the text in segment parameters and `reversed`
// runs it the other way. Returns undefined for anything it cannot read.
export function importTextPath(tp: NonNullable<LayerTextData['textPath']>): TypePath | undefined {
  const cp = tp.bezierCurve?.controlPoints;
  if (!Array.isArray(cp) || cp.length < 8 || cp.length % 8 !== 0 || cp.length > 80_000 || !cp.every((v) => typeof v === 'number' && Number.isFinite(v))) return;
  const fm = tp.data?.frameMatrix;
  const [a, b, c, d, e, f] = Array.isArray(fm) && fm.length === 6 && fm.every(Number.isFinite) ? fm : [1, 0, 0, 1, 0, 0];
  const pt = (i: number): [number, number] => [a * cp[i] + c * cp[i + 1] + e, b * cp[i] + d * cp[i + 1] + f];
  const segs = cp.length / 8;
  const knots: number[][] = [];
  for (let s = 0; s < segs; s++) {
    const o = s * 8;
    const [p0x, p0y] = pt(o), [c1x, c1y] = pt(o + 2), [c2x, c2y] = pt(o + 4), [p1x, p1y] = pt(o + 6);
    if (s === 0) knots.push([p0x, p0y, p0x, p0y, c1x, c1y]);
    else {
      const prev = knots[knots.length - 1];
      prev[4] = c1x;
      prev[5] = c1y;
    }
    knots.push([c2x, c2y, p1x, p1y, p1x, p1y]);
  }
  // A curve that ends where it starts is closed.
  const first = knots[0], last = knots[knots.length - 1];
  const closed = knots.length > 2 && Math.hypot(first[2] - last[2], first[3] - last[3]) < 1e-3;
  if (closed) {
    first[0] = last[0];
    first[1] = last[1];
    knots.pop();
  }
  const range = tp.data?.textRange;
  const frac = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v / segs)) : dflt);
  const start = frac(Array.isArray(range) ? range[0] : undefined, 0);
  const end = frac(Array.isArray(range) ? range[1] : undefined, 1);
  return { kind: 'path', knots, closed, start, end, flip: !!tp.data?.pathData?.reversed };
}

function psdStyle(s: CharStyle, ppi: number): TextStyle {
  return {
    font: { name: postScriptName(s) },
    fontSize: ptToPx(s.size, ppi),
    fauxBold: s.fauxBold,
    fauxItalic: s.fauxItalic,
    autoLeading: s.leading === 'auto',
    leading: s.leading === 'auto' ? 0 : ptToPx(s.leading, ppi),
    horizontalScale: s.scaleX / 100,
    verticalScale: s.scaleY / 100,
    tracking: s.tracking,
    autoKerning: s.kerning !== 'none',
    baselineShift: ptToPx(s.baselineShift, ppi),
    fontCaps: s.allCaps ? 2 : s.smallCaps ? 1 : 0,
    fontBaseline: s.superscript ? 1 : s.subscript ? 2 : 0,
    underline: s.underline,
    strikethrough: s.strikethrough,
    ligatures: s.ligatures,
    fillColor: { r: s.color[0], g: s.color[1], b: s.color[2] },
    ...(s.noBreak ? { noBreak: true } : {}),
  };
}

// ag-psd text data for an editable text layer placed by `matrix`.
export function exportPsdText(data: TextLayerData, matrix: Affine, ppi: number): LayerTextData {
  const styleRuns: { length: number; style: TextStyle }[] = [];
  const paragraphStyleRuns: { length: number; style: PsdParagraphStyle }[] = [];
  const n = data.content.paragraphs.length;
  data.content.paragraphs.forEach((p, pi) => {
    const brk = pi < n - 1 ? 1 : 0;
    let plen = 0;
    p.runs.forEach((r, ri) => {
      const len = r.text.length + (ri === p.runs.length - 1 ? brk : 0);
      plen += r.text.length;
      if (len > 0) styleRuns.push({ length: len, style: psdStyle(r.style, ppi) });
    });
    const s = p.style;
    paragraphStyleRuns.push({
      length: plen + brk,
      style: {
        justification: s.align,
        startIndent: ptToPx(s.indentLeft, ppi),
        endIndent: ptToPx(s.indentRight, ppi),
        firstLineIndent: ptToPx(s.indentFirst, ppi),
        spaceBefore: ptToPx(s.spaceBefore, ppi),
        spaceAfter: ptToPx(s.spaceAfter, ppi),
        autoHyphenate: s.hyphenate,
        ...(s.wordSpacing ? { wordSpacing: s.wordSpacing.map((v) => v / 100) } : {}),
        ...(s.letterSpacing ? { letterSpacing: s.letterSpacing.map((v) => v / 100) } : {}),
        ...(s.glyphScaling ? { glyphSpacing: s.glyphScaling.map((v) => v / 100) } : {}),
        ...(s.autoLeading !== undefined ? { autoLeading: s.autoLeading / 100 } : {}),
        ...(s.leadingModel === 'top' ? { leadingType: 1 } : {}),
        ...(s.hanging ? { hanging: true } : {}),
        ...(s.composer === 'every-line' ? { everyLineComposer: true } : {}),
        ...(s.hyphenMinWord !== undefined ? { hyphenatedWordSize: s.hyphenMinWord } : {}),
        ...(s.hyphenBefore !== undefined ? { preHyphen: s.hyphenBefore } : {}),
        ...(s.hyphenAfter !== undefined ? { postHyphen: s.hyphenAfter } : {}),
        ...(s.hyphenLimit !== undefined ? { consecutiveHyphens: s.hyphenLimit } : {}),
        ...(s.hyphenZone !== undefined ? { zone: ptToPx(s.hyphenZone, ppi) } : {}),
      },
    });
  });
  const first = data.content.paragraphs[0]?.runs[0]?.style ?? defaultCharStyle();
  const out: LayerTextData = {
    text: plainText(data.content),
    transform: [...matrix],
    antiAlias: data.antiAlias,
    orientation: data.orientation,
    style: psdStyle(first, ppi),
    styleRuns: styleRuns.length ? styleRuns : [{ length: 0, style: psdStyle(first, ppi) }],
    paragraphStyleRuns,
    shapeType: data.mode === 'paragraph' && data.box ? 'box' : 'point',
  };
  if (data.mode === 'paragraph' && data.box) out.boxBounds = [data.origin.x, data.origin.y, data.origin.x + data.box.width, data.origin.y + data.box.height];
  else if (data.origin.x || data.origin.y) {
    // Point text anchors at the local origin; fold the anchor into the transform.
    const [a, b, c, d, e, f] = matrix;
    out.transform = [a, b, c, d, a * data.origin.x + c * data.origin.y + e, b * data.origin.x + d * data.origin.y + f];
  }
  if (data.warp && data.warp.style !== 'none')
    out.warp = { style: WARP_OUT[data.warp.style], value: data.warp.bend, perspective: data.warp.horizontal, perspectiveOther: data.warp.vertical, rotate: data.warp.axis };
  return out;
}
