import type { Editor } from '../../editor';
import type { Rect } from '../../model/document';
import type { VectorShape } from '../../model/vector';
import { strokeMeasurePixels, type VectorStroke } from '../../model/vector-stroke';
import { gradientFrame, isVectorGradient, type VectorGradient } from '../../model/vector-gradient';
import { isVectorPattern, type VectorPattern } from '../../model/vector-pattern';
import { vectorColorHex } from '../../color/vector';
import { vectorHexColor } from '../../color/vector';
import { escapeXML } from '../../model/assets';
import { hexRgb } from '../pixels';

// Fill and stroke descriptions used by the shape tools' options bar and the
// Properties editor, converted to the PSD-compatible vector paint model.
export type GradientStyle = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
export type FillSpec =
  | { type: 'none' }
  | { type: 'color'; color: string }
  | { type: 'gradient'; from: string; to: string; style: GradientStyle; angle: number; reverse: boolean }
  | { type: 'pattern'; id: string; name: string };
export type DashPreset = 'solid' | 'dashed' | 'dotted' | 'custom';
export type StrokeSpec = {
  type: 'none' | 'color';
  color: string;
  width: number;
  align: VectorStroke['alignment'];
  cap: VectorStroke['cap'];
  join: VectorStroke['join'];
  dash: DashPreset;
  custom: string;
  opacity: number;
};
export const defaultStroke = (): StrokeSpec => ({ type: 'none', color: '#000000', width: 3, align: 'inside', cap: 'butt', join: 'miter', dash: 'solid', custom: '4 2', opacity: 1 });

const dashSets: Record<Exclude<DashPreset, 'custom' | 'solid'>, number[]> = { dashed: [4, 2], dotted: [1, 1.5] };
export function dashValues(spec: StrokeSpec): number[] | undefined {
  if (spec.dash === 'solid') return;
  if (spec.dash === 'custom') {
    const v = spec.custom.trim().split(/[\s,]+/).map(Number);
    // As strokes allow: an odd list repeats, zero lengths only for gaps of an even list.
    return v.length && v.every((n, i) => Number.isFinite(n) && n >= 0 && (n > 0 || (i % 2 === 1 && v.length % 2 === 0))) && v.some((n) => n > 0) ? v : undefined;
  }
  return dashSets[spec.dash];
}
/** Vector paint for a fill spec (an empty color means the foreground color). */
export function buildFill(e: Editor, fill: FillSpec, bounds: Rect | null, fallback = '#000000'): { fill: VectorShape['fill']; color: string } {
  const doc = e.doc;
  if (fill.type === 'gradient') return { fill: gradientPaint(fill, { x: 0, y: 0, width: doc.width, height: doc.height }, bounds), color: fill.from };
  if (fill.type === 'pattern' && doc.psdMetadataAsset && fill.id)
    return { fill: { type: 'pattern', name: fill.name, id: fill.id, asset: doc.psdMetadataAsset, align: true } as VectorPattern, color: fallback };
  const color = fill.type === 'color' ? fill.color || e.color : fallback;
  return { fill: vectorHexColor(color), color };
}
/** Stroke record; undefined when there is no stroke and the fill is visible. */
export function buildStroke(stroke: StrokeSpec, fillEnabled: boolean, open: boolean): VectorStroke | undefined {
  if (stroke.type !== 'color' && fillEnabled) return;
  const dashes = stroke.type === 'color' ? dashValues(stroke) : undefined;
  return {
    enabled: stroke.type === 'color' && stroke.width > 0,
    fillEnabled,
    lineWidth: { value: Math.max(0, stroke.width), units: 'Pixels' },
    lineDashOffset: { value: 0, units: 'Pixels' },
    ...(dashes ? { lineDashSet: dashes.map((value) => ({ value, units: 'None' as const })) } : {}),
    resolution: 72,
    cap: stroke.dash === 'dotted' ? 'round' : stroke.cap,
    join: stroke.join,
    alignment: open ? 'center' : stroke.align,
    miterLimit: 100,
    opacity: Math.max(0, Math.min(1, stroke.opacity)),
    color: vectorHexColor(stroke.color || '#000000'),
  };
}
export function buildPaint(e: Editor, fill: FillSpec, stroke: StrokeSpec, bounds: Rect | null, open: boolean): { fill: VectorShape['fill']; stroke?: VectorStroke; color: string } {
  const f = buildFill(e, fill, bounds, stroke.color);
  const s = buildStroke(stroke, fill.type !== 'none', open);
  return { fill: f.fill, ...(s ? { stroke: s } : {}), color: f.color };
}
/** Change only a shape's fill, keeping its stroke. */
export function applyFill(e: Editor, v: VectorShape, spec: FillSpec, bounds: Rect | null) {
  if (spec.type === 'none') {
    v.stroke ??= buildStroke({ ...defaultStroke(), type: 'none' }, false, v.mask.paths.some((p) => p.open))!;
    v.stroke.fillEnabled = false;
    return;
  }
  v.fill = buildFill(e, spec, bounds).fill;
  if (v.stroke) {
    v.stroke.fillEnabled = true;
    if (!v.stroke.enabled) delete v.stroke;
  }
}
/** Change only a shape's stroke, keeping its fill. */
export function applyStroke(v: VectorShape, spec: StrokeSpec) {
  const fillEnabled = v.stroke ? v.stroke.fillEnabled : true;
  const s = buildStroke(spec, fillEnabled, v.mask.paths.some((p) => p.open));
  // Settings the stroke controls do not show (from opened files) are kept.
  if (s && v.stroke) {
    const o = v.stroke.lineDashOffset;
    s.lineDashOffset = o.units === 'None' ? { ...o } : { value: strokeMeasurePixels(o, v.stroke.resolution), units: 'Pixels' };
    s.miterLimit = v.stroke.miterLimit;
  }
  if (s) v.stroke = s;
  else delete v.stroke;
}
export function gradientPaint(spec: Extract<FillSpec, { type: 'gradient' }>, canvas: Rect, bounds: Rect | null): VectorGradient {
  const [r1, g1, b1] = hexRgb(spec.from), [r2, g2, b2] = hexRgb(spec.to);
  return {
    type: 'solid',
    name: 'Custom',
    style: spec.style,
    angle: spec.angle,
    reverse: spec.reverse,
    align: true,
    interpolationSamples: 4096,
    colorStops: [
      { color: { r: r1, g: g1, b: b1 }, location: 0, midpoint: 0.5 },
      { color: { r: r2, g: g2, b: b2 }, location: 1, midpoint: 0.5 },
    ],
    opacityStops: [
      { location: 0, midpoint: 0.5, opacityPercent: 100 },
      { location: 1, midpoint: 0.5, opacityPercent: 100 },
    ],
    frame: gradientFrame(canvas, true, undefined, bounds),
  };
}
const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
/** Describe an existing layer's paint as specs (for the Properties editor). */
export function specsOf(e: Editor, v: VectorShape): { fill: FillSpec; stroke: StrokeSpec } {
  const doc = e.doc;
  let fill: FillSpec;
  if (v.stroke && !v.stroke.fillEnabled) fill = { type: 'none' };
  else if (isVectorGradient(v.fill)) {
    const s = v.fill.colorStops, a = s[0]?.color as { r: number; g: number; b: number }, b = s[s.length - 1]?.color as { r: number; g: number; b: number };
    fill = { type: 'gradient', from: `#${hex2(a.r)}${hex2(a.g)}${hex2(a.b)}`, to: `#${hex2(b.r)}${hex2(b.g)}${hex2(b.b)}`, style: (v.fill.style ?? 'linear') as GradientStyle, angle: v.fill.angle ?? 0, reverse: !!v.fill.reverse };
  } else if (isVectorPattern(v.fill)) fill = { type: 'pattern', id: v.fill.id, name: v.fill.name };
  else fill = { type: 'color', color: vectorColorHex(v.fill, doc) };
  const s = v.stroke;
  const stroke: StrokeSpec = s
    ? {
        type: s.enabled ? 'color' : 'none',
        color: vectorColorHex(s.color, doc),
        width: s.lineWidth.units === 'Pixels' ? s.lineWidth.value : Math.round(s.lineWidth.value * (s.lineWidth.units === 'Points' ? s.resolution / 72 : 1) * 100) / 100,
        align: s.alignment,
        cap: s.cap,
        join: s.join,
        dash: !s.lineDashSet?.length ? 'solid' : 'custom',
        custom: (s.lineDashSet ?? []).map((d) => d.value).join(' ') || '4 2',
        opacity: s.opacity,
      }
    : defaultStroke();
  if (s?.lineDashSet?.length) {
    const vals = s.lineDashSet.map((d) => d.value).join(' ');
    if (vals === dashSets.dashed.join(' ')) stroke.dash = 'dashed';
    else if (vals === dashSets.dotted.join(' ')) stroke.dash = 'dotted';
  }
  return { fill, stroke };
}

// ----- Swatch buttons and the paint popover -----
const checker = 'repeating-conic-gradient(#bbb 0 25%, #fff 0 50%) 0 0/8px 8px';
export function swatchStyle(spec: FillSpec | StrokeSpec, foreground: string): string {
  if (spec.type === 'none') return `background:${checker}`;
  if ('width' in spec) return `background:${spec.color}`;
  if (spec.type === 'color') return `background:${spec.color || foreground}`;
  if (spec.type === 'gradient') return `background:linear-gradient(90deg,${spec.from},${spec.to})`;
  return `background:${checker};outline:2px dashed var(--accent)`;
}
export function swatchButton(id: string, label: string, spec: FillSpec | StrokeSpec, foreground: string, stroke = false) {
  return `<button class="vec-swatch ${stroke ? 'stroke' : ''} ${spec.type === 'none' ? 'none' : ''}" id="${id}" title="${escapeXML(label)}" aria-label="${escapeXML(label)}" aria-haspopup="dialog"><span style="${swatchStyle(spec, foreground)}"></span></button>`;
}
export type PatternChoice = { id: string; name: string };
let patternCache: { asset: string; list: Promise<PatternChoice[]> } | undefined;
/** Patterns defined in the document (imported PSD pattern resources). */
export function documentPatterns(e: Editor): Promise<PatternChoice[]> {
  const asset = e.doc.psdMetadataAsset;
  if (!asset) return Promise.resolve([]);
  if (patternCache?.asset !== asset)
    patternCache = {
      asset,
      list: (async () => {
        const [{ decodePsdMetadata }, { indexPsdPatterns, supportedPsdPattern }] = await Promise.all([import('../../model/psd-metadata'), import('../../model/psd-patterns')]);
        const bytes = new Uint8Array(await e.assets.blob(asset).arrayBuffer());
        const seen = new Map<string, PatternChoice>();
        for (const tag of decodePsdMetadata(bytes).tags) {
          if (!['Patt', 'Pat2', 'Pat3'].includes(tag.key)) continue;
          for (const p of indexPsdPatterns(tag.data)) if (supportedPsdPattern(p) && !seen.has(p.id)) seen.set(p.id, { id: p.id, name: p.name || p.id });
        }
        return [...seen.values()];
      })().catch(() => []),
    };
  return patternCache.list;
}
/** A small popover editing a fill or stroke spec; calls `change` on every edit. */
export function openPaintPopover(e: Editor, anchor: HTMLElement, spec: FillSpec | StrokeSpec, change: (spec: FillSpec | StrokeSpec) => void) {
  document.querySelector('.vec-paint-pop')?.remove();
  const pop = document.createElement('div');
  pop.className = 'vec-paint-pop popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'width' in spec ? 'Stroke' : 'Fill');
  let current = structuredClone(spec);
  const render = async () => {
    const stroke = 'width' in current;
    const types = stroke ? [['none', 'No stroke'], ['color', 'Solid color']] : [['none', 'No fill'], ['color', 'Solid color'], ['gradient', 'Gradient'], ['pattern', 'Pattern']];
    let body = '';
    const c = current;
    if (c.type === 'color') body = `<label>Color <input type="color" data-k="color" value="${(c as { color: string }).color || e.color}"></label><button type="button" data-k="use-fg">Use foreground</button>`;
    if (c.type === 'gradient') {
      const g = c as Extract<FillSpec, { type: 'gradient' }>;
      body = `<label>From <input type="color" data-k="from" value="${g.from}"></label><label>To <input type="color" data-k="to" value="${g.to}"></label><label>Style <select data-k="style">${['linear', 'radial', 'angle', 'reflected', 'diamond'].map((s) => `<option value="${s}" ${g.style === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></label><label>Angle <input type="number" data-k="angle" min="-360" max="360" value="${g.angle}">°</label><label class="check"><input type="checkbox" data-k="reverse" ${g.reverse ? 'checked' : ''}> Reverse</label>`;
    }
    if (c.type === 'pattern') {
      const list = await documentPatterns(e);
      const p = c as Extract<FillSpec, { type: 'pattern' }>;
      body = list.length
        ? `<label>Pattern <select data-k="pattern">${list.map((q) => `<option value="${escapeXML(q.id)}" ${q.id === p.id ? 'selected' : ''}>${escapeXML(q.name)}</option>`).join('')}</select></label>`
        : `<p class="muted">This document has no patterns. Patterns come from opened PSD files.</p>`;
      if (list.length && !list.some((q) => q.id === p.id)) {
        current = { type: 'pattern', id: list[0].id, name: list[0].name };
        change(current);
      }
    }
    pop.innerHTML = `<div class="segmented vec-paint-types" role="radiogroup">${types.map(([t, l]) => `<button type="button" role="radio" data-type="${t}" aria-checked="${c.type === t}" title="${l}">${l}</button>`).join('')}</div><div class="vec-paint-body">${body}</div>`;
  };
  pop.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-type]');
    if (t) {
      const type = t.dataset.type!;
      if ('width' in current) current = { ...current, type: type as 'none' | 'color' };
      else if (type === 'none') current = { type: 'none' };
      else if (type === 'color') current = { type: 'color', color: e.color };
      else if (type === 'gradient') current = { type: 'gradient', from: e.color, to: e.background, style: 'linear', angle: 0, reverse: false };
      else current = { type: 'pattern', id: '', name: '' };
      change(current);
      void render();
      return;
    }
    if ((ev.target as HTMLElement).closest('[data-k="use-fg"]')) {
      (current as { color: string }).color = e.color;
      change(current);
      void render();
    }
  });
  const edit = (ev: Event) => {
    const t = ev.target as HTMLInputElement;
    const k = t.dataset.k;
    if (!k) return;
    const c = current as Record<string, unknown>;
    if (k === 'reverse') c.reverse = t.checked;
    else if (k === 'angle') c.angle = Number(t.value) || 0;
    else if (k === 'pattern') {
      c.id = t.value;
      c.name = (t as unknown as HTMLSelectElement).selectedOptions?.[0]?.textContent ?? t.value;
    } else c[k] = t.value;
    change(current);
  };
  pop.addEventListener('input', edit);
  pop.addEventListener('change', edit);
  document.body.append(pop);
  void render().then(() => {
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(4, Math.min(window.innerWidth - pop.offsetWidth - 4, r.left))}px`;
    pop.style.top = `${r.bottom + 4}px`;
  });
  const close = (ev: Event) => {
    if (!pop.contains(ev.target as Node) && !anchor.contains(ev.target as Node)) {
      pop.remove();
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', esc, true);
    }
  };
  const esc = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      pop.remove();
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', esc, true);
      anchor.focus();
    }
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', esc, true);
  });
}
