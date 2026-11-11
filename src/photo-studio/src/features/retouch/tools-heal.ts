// Healing tools: Spot Healing Brush, Healing Brush, Patch, Context Move, Red Eye
// and Remove. Brush tools collect the stroke, then heal it in the worker in one
// step so the result is seamless and undoable as one edit.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import type { Tool } from '../../app/registry';
import type { CanvasPointer } from '../../app/pointer';
import { brushFor, cursor } from '../paint';
import { previewTarget, roundIRect } from '../pixels';
import { commitSelectionMask, rasterizePolygon, selectionOp } from '../selection';
import { StrokeSession } from '../../engine/paint';
import { maskGrid, selectionGrid } from '../../model/selection';
import { boundingBox, expand } from '../../imaging/segment/mask-ops';
import { detectRedEye, redEye, type SpotHealMode } from '../../imaging/retouch';
import { cloneRGBA8, type IRect, type Mask8, type RGBA8 } from '../../imaging/types';
import { buffersOf, heavy } from './client';
import {
  binarize,
  clampRect,
  colorAdaptationFor,
  cropMask,
  cropRGBA,
  expandRect,
  mixImages,
  outlinePath,
  patchSizeFor,
  placeOver,
  shiftMask,
  strokeBounds,
  strokeMask,
  unionRects,
  type Pt,
} from './logic';
import { cropSafe, imageSampler, imageURL, retouchTarget, selectionMask, sourceRect, writeResult, type PixelsTarget } from './source';
import { svg } from '../../app/icons';
import { bilinearSampler, isTranslation, renderMapped, sourceMapping } from '../../imaging/retouch/clone-transform';
import {
  activeSource,
  cloneSourceChanged,
  currentSourcePoint,
  ignoreAdjustments,
  sampleMode,
  setSource,
  sourceImage,
  sourceMarker,
  sourceOverlay,
  strokeAnchor,
  strokeSampler,
  warmSource,
  type CloneSource,
  type SampleMode,
} from '../clone-source/state';
import { bindSampleOptions, sampleOptions } from '../clone-source/options';
import { ants, bindCheck, bindSize, checkbox, sizeField, sizeKeys } from './ui';

const hardnessField = (id: string) => `<label>Hardness <input id="retouch-hardness" type="number" min="0" max="100" value="${Math.round(brushFor(id).hardness * 100)}" aria-label="Brush hardness (%)">%</label>`;
const bindHardness = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLInputElement>('#retouch-hardness')?.addEventListener('change', (ev) => {
    const v = Number((ev.target as HTMLInputElement).value);
    if (Number.isFinite(v)) brushFor(id).hardness = Math.max(0, Math.min(1, v / 100));
  });
const select = (id: string, label: string, value: string, options: [string, string][]) =>
  `<label>${label} <select id="${id}">${options.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
const bindSelect = (e: Editor, el: HTMLElement, id: string, key: string, after?: () => void) =>
  el.querySelector<HTMLSelectElement>(`#${id}`)?.addEventListener('change', (ev) => {
    e.settings[key] = (ev.target as HTMLSelectElement).value;
    after?.();
  });
const numberField = (id: string, label: string, value: number, min: number, max: number, unit = '') =>
  `<label>${label} <input id="${id}" type="number" min="${min}" max="${max}" value="${value}">${unit}</label>`;
const bindNumber = (e: Editor, el: HTMLElement, id: string, key: string, min: number, max: number) =>
  el.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener('change', (ev) => {
    const v = Number((ev.target as HTMLInputElement).value);
    if (Number.isFinite(v)) e.settings[key] = Math.max(min, Math.min(max, v));
  });
const strokePath = (pts: Pt[]) => (pts.length === 1 ? `M${pts[0][0]} ${pts[0][1]}l0.01 0` : pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(''));
const strokeSvg = (pts: Pt[], size: number, cls = 'retouch-stroke') => `<path d="${strokePath(pts)}" class="${cls}" stroke-width="${size}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;

// ----- Brush stroke collection shared by Spot Healing and Remove -----
type Collected = { points: Pt[]; target?: PixelsTarget; ready: boolean; done: boolean };
function collectingTool(base: Omit<Tool, 'pointerDown' | 'pointerMove' | 'pointerUp'>, what: string, finish: (e: Editor, s: Collected) => Promise<void>, current: { s?: Collected }): Tool {
  const end = async (e: Editor, s: Collected) => {
    try {
      await e.run(() => finish(e, s));
    } finally {
      if (current.s === s) current.s = undefined;
      e.overlay();
    }
  };
  return {
    ...base,
    cursor: () => 'none',
    hover: (e, p) => cursor(e, base.id, p),
    deactivate: (e, reason) => {
      e.screenOverlayContent = '';
      e.screenOverlay();
      return base.deactivate?.(e, reason);
    },
    pointerDown: async (e, p) => {
      const s: Collected = { points: [[p.x, p.y]], ready: false, done: false };
      current.s = s;
      e.overlay();
      const target = await retouchTarget(e, what);
      if (current.s !== s) return;
      if (!target) {
        current.s = undefined;
        e.overlay();
        return;
      }
      s.target = target;
      s.ready = true;
      if (s.done) await end(e, s);
    },
    pointerMove: (e, p) => {
      cursor(e, base.id, p);
      const s = current.s;
      if (!s || s.done) return;
      for (const q of p.coalesced ?? [p]) s.points.push([q.x, q.y]);
      e.overlay();
    },
    pointerUp: async (e) => {
      const s = current.s;
      if (!s) return;
      s.done = true;
      if (s.ready) await end(e, s);
    },
  };
}

// ----- Spot Healing Brush -----
const SPOT = 'spot-healing';
const spot: { s?: Collected } = {};
async function spotHeal(e: Editor, s: Collected) {
  const b = brushFor(SPOT),
    W = e.doc.width,
    H = e.doc.height;
  const sb = strokeBounds(s.points, b.size / 2);
  // Enough surroundings for the patch search (the proximity search reaches
  // about three spot sizes away).
  const margin = Math.min(1200, Math.ceil(3.5 * Math.max(sb.width, sb.height)) + 8);
  const R = expandRect(sb, margin, W, H);
  if (!R) return;
  const mask = strokeMask(s.points, b.size, b.hardness, R);
  if (!boundingBox(mask)) return;
  const sampleAll = !!e.settings.spotSampleAll;
  const target = s.target!;
  const before = await sourceRect(e, R, false, target);
  const img = sampleAll ? await sourceRect(e, R, true) : cloneRGBA8(before);
  const weight = binarize(mask);
  const result = await heavy<RGBA8>(e, 'Healing', 'spot-heal', { img, mask, mode: (e.settings.spotType as SpotHealMode) ?? 'context', seed: s.points.length }, buffersOf(img, mask));
  if (result) writeResult(e, target, R, before, result, 'Spot Healing Brush', { sampleAll, weight });
}
const spotHealingTool = collectingTool(
  {
    id: SPOT,
    label: 'Spot Healing Brush Tool',
    key: 'J',
    icon: 'heal-spot',
    group: 'heal',
    options: (e) =>
      `${sizeField(SPOT)}${hardnessField(SPOT)}${select('spot-type', 'Type', (e.settings.spotType as string) ?? 'context', [
        ['context', 'Context Aware'],
        ['proximity', 'Proximity Match'],
        ['texture', 'Create Texture'],
      ])}${checkbox('spot-all', 'Sample All Layers', !!e.settings.spotSampleAll)}`,
    bindOptions: ({ e, el }) => {
      bindSize(el, SPOT);
      bindHardness(el, SPOT);
      bindSelect(e, el, 'spot-type', 'spotType');
      bindCheck(e, el, 'spot-all', 'spotSampleAll');
    },
    keyDown: (e, ev) => sizeKeys(e, SPOT, ev),
    overlay: () => (spot.s ? strokeSvg(spot.s.points, brushFor(SPOT).size) : ''),
  },
  'The Spot Healing Brush',
  spotHeal,
  spot,
);

// ----- Remove tool -----
const REMOVE = 'remove-tool';
const remove: { s?: Collected } = {};
// Strokes painted with "Remove after each stroke" off wait for Apply in the
// document they were painted in; another document shown meanwhile has its own.
type RemovePending = { strokes: { points: Pt[]; size: number }[]; target: PixelsTarget };
const removePending = new WeakMap<DocumentSession, RemovePending>();
const pendingRemove = (e: Editor) => removePending.get(e.session);
function dropPendingRemove(e: Editor) {
  removePending.delete(e.session);
  e.options();
  e.overlay();
}
async function removeStrokes(e: Editor, strokes: { points: Pt[]; size: number }[], target: PixelsTarget) {
  const W = e.doc.width,
    H = e.doc.height;
  let box: IRect | null = null;
  for (const s of strokes) {
    const r = strokeBounds(s.points, s.size / 2);
    box = box ? unionRects(box, r) : r;
  }
  if (!box) return;
  const size = Math.max(box.width, box.height);
  const R = expandRect(box, Math.min(1024, Math.max(64, 3 * size)) + 8, W, H);
  if (!R) return;
  const hole = { width: R.width, height: R.height, data: new Uint8Array(R.width * R.height) };
  for (const s of strokes) {
    const m = strokeMask(s.points, s.size, 0.9, R);
    for (let i = 0; i < m.data.length; i++) if (m.data[i] > hole.data[i]) hole.data[i] = m.data[i];
  }
  const sampleAll = !!e.settings.removeSampleAll;
  const before = await sourceRect(e, R, false, target);
  const img = sampleAll ? await sourceRect(e, R, true) : cloneRGBA8(before);
  const weight = binarize(hole);
  const result = await heavy<RGBA8>(e, 'Removing', 'context-fill', { img, hole, opts: { seed: 7 } }, buffersOf(img, hole));
  if (result) writeResult(e, target, R, before, result, 'Remove Tool', { sampleAll, weight });
}
async function applyPendingRemove(e: Editor) {
  const pending = pendingRemove(e);
  dropPendingRemove(e);
  if (pending?.strokes.length) await removeStrokes(e, pending.strokes, pending.target);
}
const removeTool = collectingTool(
  {
    id: REMOVE,
    label: 'Remove Tool',
    key: 'J',
    icon: 'remove-tool',
    group: 'heal',
    options: (e) =>
      `${sizeField(REMOVE)}${checkbox('remove-all', 'Sample All Layers', !!e.settings.removeSampleAll)}${checkbox('remove-each', 'Remove after each stroke', e.settings.removeEach !== false)}${
        pendingRemove(e) ? `<button id="remove-apply" class="primary" title="Remove the painted areas (Enter)">Apply</button><button id="remove-cancel" title="Discard the painted strokes (Escape)">Cancel</button>` : ''
      }`,
    bindOptions: ({ e, el }) => {
      bindSize(el, REMOVE);
      bindCheck(e, el, 'remove-all', 'removeSampleAll');
      bindCheck(e, el, 'remove-each', 'removeEach');
      el.querySelector('#remove-apply')?.addEventListener('click', () => void e.run(() => applyPendingRemove(e)));
      el.querySelector('#remove-cancel')?.addEventListener('click', () => dropPendingRemove(e));
    },
    // Choosing another tool applies the strokes; showing another document
    // leaves them waiting in theirs.
    deactivate: (e, reason) => {
      if (reason !== 'document' && pendingRemove(e)) return e.run(() => applyPendingRemove(e));
    },
    keyDown: (e, ev) => {
      if (pendingRemove(e) && ev.key === 'Enter') {
        void e.run(() => applyPendingRemove(e));
        return true;
      }
      if (pendingRemove(e) && ev.key === 'Escape') {
        dropPendingRemove(e);
        return true;
      }
      return sizeKeys(e, REMOVE, ev);
    },
    overlay: (e) => (pendingRemove(e)?.strokes ?? []).map((s) => strokeSvg(s.points, s.size, 'retouch-stroke remove')).join('') + (remove.s ? strokeSvg(remove.s.points, brushFor(REMOVE).size, 'retouch-stroke remove') : ''),
  },
  'The Remove tool',
  async (e, s) => {
    const stroke = { points: s.points, size: brushFor(REMOVE).size };
    if (e.settings.removeEach === false) {
      const pending = pendingRemove(e);
      if (pending && pending.target.layer.id === s.target!.layer.id) pending.strokes.push(stroke);
      else removePending.set(e.session, { strokes: [stroke], target: s.target! });
      e.options();
      return;
    }
    await removeStrokes(e, [stroke], s.target!);
  },
  remove,
);

// ----- Healing Brush -----
// Shares sources, offsets and transforms with the Clone Stamp (Clone Source panel).
const HEAL = 'healing-brush';
type HealStroke = { session?: StrokeSession; target?: PixelsTarget; points: Pt[]; anchor: [number, number]; src: CloneSource; mode: SampleMode; done: boolean };
let healStroke: HealStroke | undefined;
async function finishHealing(e: Editor) {
  const st = healStroke;
  if (!st?.session || !st.target) return;
  healStroke = undefined;
  const session = st.session,
    target = st.target;
  try {
    await e.run(async () => {
      const b = brushFor(HEAL),
        W = e.doc.width,
        H = e.doc.height;
      // A two-pixel ring outside the stroke gives the blend its boundary.
      const D = expandRect(strokeBounds(st.points, b.size / 2), 2, W, H);
      if (!D) return;
      const sampleAll = st.mode !== 'current';
      const before = await sourceRect(e, D, false, target);
      const image = await sourceImage(e, st.src, st.mode, target.layer);
      if (!image) return;
      const dst = sampleAll ? cropSafe(image, D) : cloneRGBA8(before);
      const map = sourceMapping(st.src.point, st.anchor, st.src);
      const src = renderMapped(isTranslation(st.src) ? imageSampler(image) : bilinearSampler(image), map, D);
      const mask = strokeMask(st.points, b.size, b.hardness, D);
      const weight = binarize(mask);
      const result = await heavy<RGBA8>(e, 'Healing', 'heal', { dst, src, mask, offset: { x: 0, y: 0 } }, buffersOf(dst, src, mask));
      if (result) writeResult(e, target, D, before, result, 'Healing Brush', { sampleAll, weight });
      else e.preview(e.doc);
    });
  } finally {
    session.cancel();
    e.overlay();
  }
}
const healingBrushTool: Tool = {
  id: HEAL,
  label: 'Healing Brush Tool',
  key: 'J',
  icon: 'bandage',
  group: 'heal',
  cursor: () => 'none',
  options: (e) =>
    `${sizeField(HEAL)}${hardnessField(HEAL)}${checkbox('heal-aligned', 'Aligned', e.settings.healAligned !== false)}${sampleOptions('heal-sample', sampleMode(e, 'heal'))}<button class="icon-button toggle" id="heal-ignore-adj" aria-pressed="${ignoreAdjustments(e)}" title="Ignore adjustment layers when sampling" aria-label="Ignore adjustment layers when sampling">${svg('layers-2', 16)}</button><button class="icon-button" id="heal-panel" title="Clone Source panel" aria-label="Open the Clone Source panel">${svg('copy-plus', 16)}</button>`,
  bindOptions: ({ e, el }) => {
    bindSize(el, HEAL);
    bindHardness(el, HEAL);
    bindSampleOptions(e, el, 'heal');
  },
  activate: (e) => warmSource(e, sampleMode(e, 'heal')),
  hover: (e, p) => {
    cursor(e, HEAL, p);
    if (activeSource()) e.overlay();
  },
  deactivate: (e) => {
    e.screenOverlayContent = '';
    e.screenOverlay();
  },
  keyDown: (e, ev) => {
    if (ev.key === 'Escape' && healStroke?.session) {
      healStroke.session.cancel();
      healStroke = undefined;
      e.preview(e.doc);
      return true;
    }
    return sizeKeys(e, HEAL, ev);
  },
  pointerDown: async (e, p) => {
    if (p.alt) {
      await setSource(e, p.x, p.y, 'heal');
      e.message('Healing source set.');
      e.overlay();
      return;
    }
    const source = activeSource();
    if (!source) {
      e.message('Alt-click (Option-click) to define a source point to heal from.');
      return;
    }
    const anchor = strokeAnchor(source, [p.x, p.y], e.settings.healAligned !== false);
    cloneSourceChanged();
    const st: HealStroke = { points: [[p.x, p.y]], anchor, src: source, mode: sampleMode(e, 'heal'), done: false };
    healStroke = st;
    const target = await retouchTarget(e, 'The Healing Brush');
    if (healStroke !== st) return;
    if (!target) {
      healStroke = undefined;
      return;
    }
    const sampler = await strokeSampler(e, source, anchor, st.mode, target.layer);
    if (healStroke !== st || !sampler) {
      if (healStroke === st) healStroke = undefined;
      return;
    }
    const b = brushFor(HEAL);
    st.target = target;
    // Live preview: a plain copy from the source; the seamless blend replaces
    // it when the stroke ends.
    st.session = new StrokeSession(e.assets.tiles, target.grid, {
      tip: { size: b.size, hardness: b.hardness, spacing: 0.1, roundness: 1, angle: 0 },
      opacity: 1,
      flow: 1,
      target: { kind: 'color', rgb: [0, 0, 0], mode: 'normal', source: sampler },
      selection: selectionGrid(e.doc, e.assets.tiles),
    });
    for (const q of st.points) st.session.addPoint(q[0], q[1]);
    e.preview(previewTarget(e, target, st.session.grid));
    if (st.done) await finishHealing(e);
  },
  pointerMove: (e, p) => {
    cursor(e, HEAL, p);
    const st = healStroke;
    if (!st || st.done) return;
    for (const q of p.coalesced ?? [p]) {
      st.points.push([q.x, q.y]);
      st.session?.addPoint(q.x, q.y);
    }
    if (st.session && st.target) e.preview(previewTarget(e, st.target, st.session.grid));
    e.overlay();
  },
  pointerUp: async (e) => {
    const st = healStroke;
    if (!st) return;
    st.done = true;
    if (st.session) await finishHealing(e);
    warmSource(e, sampleMode(e, 'heal'));
  },
  overlay: (e) => {
    const src = activeSource();
    if (!src) return '';
    const painting = !!healStroke;
    return sourceOverlay(e, 'heal', brushFor(HEAL).size, painting, healStroke?.anchor) + (src.sessionId === e.session.id || painting ? sourceMarker(e, currentSourcePoint(e, src, painting, healStroke?.anchor)) : '');
  },
};

// ----- Patch and Context Move: draw a selection, then drag it -----
type RegionDrag =
  | { kind: 'lasso'; points: Pt[]; op: ReturnType<typeof selectionOp> }
  | { kind: 'move'; start: Pt; offset: Pt; path: string; rect: IRect; sel: Mask8; preview?: string };
function regionTool(base: Omit<Tool, 'pointerDown' | 'pointerMove' | 'pointerUp' | 'overlay'>, label: string, apply: (e: Editor, sel: Mask8, rect: IRect, dx: number, dy: number) => Promise<void>, previewContent = false): Tool {
  let drag: RegionDrag | undefined;
  return {
    ...base,
    cursor: () => 'crosshair',
    pointerDown: async (e, p) => {
      const sel = e.doc.selection ? selectionMask(e) : null;
      const x = Math.floor(p.x),
        y = Math.floor(p.y);
      const inside = sel && x >= 0 && y >= 0 && x < sel.width && y < sel.height && sel.data[y * sel.width + x] >= 128 && !p.shift && !p.alt;
      if (!inside) {
        drag = { kind: 'lasso', points: [[p.x, p.y]], op: selectionOp(e, p) };
        return;
      }
      const rect = boundingBox(sel!)!;
      const d: RegionDrag = { kind: 'move', start: [p.x, p.y], offset: [0, 0], path: outlinePath(cropMask(sel!, rect), 700_000, rect.x, rect.y), rect, sel: sel! };
      drag = d;
      if (previewContent) {
        const img = await sourceRect(e, rect, !!e.settings[`${base.id}SampleAll`]);
        const m = cropMask(sel!, rect);
        for (let i = 0; i < m.data.length; i++) img.data[i * 4 + 3] = (img.data[i * 4 + 3] * m.data[i]) / 255;
        if (drag === d) {
          d.preview = imageURL(img);
          e.overlay();
        }
      }
    },
    pointerMove: (e, p) => {
      const d = drag;
      if (!d) return;
      if (d.kind === 'lasso') for (const q of p.coalesced ?? [p]) d.points.push([q.x, q.y]);
      else d.offset = [Math.round(p.x - d.start[0]), Math.round(p.y - d.start[1])];
      e.overlay();
    },
    pointerUp: async (e) => {
      const d = drag;
      drag = undefined;
      e.overlay();
      if (!d) return;
      if (d.kind === 'lasso') {
        if (d.points.length < 3) {
          if (d.op === 'replace') commitSelectionMask(e, null, 'replace', 'Deselect');
          return;
        }
        commitSelectionMask(e, rasterizePolygon(d.points, e.doc.width, e.doc.height, true), d.op, label === 'Patch' ? 'Patch Selection' : 'Lasso');
        return;
      }
      const [dx, dy] = d.offset;
      if (!dx && !dy) return;
      await e.run(() => apply(e, d.sel, d.rect, dx, dy));
    },
    overlay: (e) => {
      const d = drag;
      if (!d) return '';
      if (d.kind === 'lasso') return ants(d.points.map((q, i) => `${i ? 'L' : 'M'}${q[0]} ${q[1]}`).join(''), e.zoom);
      const img = d.preview ? `<image href="${d.preview}" x="${d.rect.x}" y="${d.rect.y}" width="${d.rect.width}" height="${d.rect.height}" opacity="0.85" preserveAspectRatio="none"/>` : '';
      return `<g transform="translate(${d.offset[0]} ${d.offset[1]})">${img}${ants(d.path, e.zoom)}</g>`;
    },
  };
}

async function applyPatch(e: Editor, sel: Mask8, rect: IRect, dx: number, dy: number) {
  const target = await retouchTarget(e, 'The Patch tool');
  if (!target) return;
  const W = e.doc.width,
    H = e.doc.height;
  const sampleAll = !!e.settings.patchSampleAll;
  if (e.settings.patchMode === 'content') {
    // Context-aware patch: synthesize the selected area from the dragged-to area.
    const moved = { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
    const R = expandRect(unionRects(rect, moved), 16, W, H);
    if (!R) return;
    const hole = cropMask(sel, R);
    const sampling = expand(cropMask(shiftMask(sel, dx, dy), R), 6);
    for (let i = 0; i < sampling.data.length; i++) if (hole.data[i] >= 128) sampling.data[i] = 0;
    const before = await sourceRect(e, R, false, target);
    const img = sampleAll ? await sourceRect(e, R, true) : cloneRGBA8(before);
    const weight = binarize(hole);
    const opts = { sampling, patchSize: patchSizeFor(Number(e.settings.patchStructure ?? 4)), colorAdaptation: colorAdaptationFor(Number(e.settings.patchColor ?? 3)) };
    const result = await heavy<RGBA8>(e, 'Patching', 'context-fill', { img, hole, opts }, buffersOf(img, hole, sampling));
    if (result) writeResult(e, target, R, before, result, 'Patch', { sampleAll, weight, limit: false });
    return;
  }
  const destination = e.settings.patchDirection === 'destination';
  const S0 = expandRect(rect, 2, W, H)!;
  if (!destination) {
    // Source: the selected area is rebuilt from the content where it was dragged.
    const D = S0;
    const S = { ...D, x: D.x + dx, y: D.y + dy };
    const before = await sourceRect(e, D, false, target);
    const dst = sampleAll ? await sourceRect(e, D, true) : cloneRGBA8(before);
    const src = await sourceRect(e, S, sampleAll, target);
    const mask = cropMask(sel, D);
    const weight = binarize(mask);
    const result = await heavy<RGBA8>(e, 'Patching', 'heal', { dst, src, mask, offset: { x: 0, y: 0 } }, buffersOf(dst, src, mask));
    if (result) writeResult(e, target, D, before, result, 'Patch', { sampleAll, weight, limit: false });
    return;
  }
  // Destination: the selected content is copied to where it was dragged.
  const D = clampRect({ ...S0, x: S0.x + dx, y: S0.y + dy }, W, H);
  if (!D) return;
  const src = await sourceRect(e, S0, sampleAll, target);
  const mask = cropMask(sel, S0);
  const before = await sourceRect(e, D, false, target);
  const dst = sampleAll ? await sourceRect(e, D, true) : cloneRGBA8(before);
  const offset = { x: S0.x + dx - D.x, y: S0.y + dy - D.y };
  const placed = { width: D.width, height: D.height, data: new Uint8Array(D.width * D.height) };
  for (let v = 0; v < mask.height; v++)
    for (let u = 0; u < mask.width; u++) {
      const X = u + offset.x,
        Y = v + offset.y;
      if (X >= 0 && Y >= 0 && X < D.width && Y < D.height && mask.data[v * mask.width + u]) placed.data[Y * D.width + X] = 255;
    }
  const result = await heavy<RGBA8>(e, 'Patching', 'heal', { dst, src, mask, offset }, buffersOf(dst, src, mask));
  if (result) writeResult(e, target, D, before, result, 'Patch', { sampleAll, weight: placed, limit: false, selection: maskGrid(e.assets.tiles, shiftMask(sel, dx, dy)) });
}

async function applyContextMove(e: Editor, sel: Mask8, rect: IRect, dx: number, dy: number) {
  const target = await retouchTarget(e, 'Context Move');
  if (!target) return;
  const W = e.doc.width,
    H = e.doc.height;
  const sampleAll = !!e.settings['context-moveSampleAll'];
  const extend = e.settings.contextMoveMode === 'extend';
  const color = Number(e.settings.contextMoveColor ?? 3);
  const moved = { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
  const size = Math.max(rect.width, rect.height);
  const R = expandRect(unionRects(rect, moved), extend ? 8 : Math.min(1024, Math.max(64, 3 * size)), W, H);
  if (!R) return;
  const before = await sourceRect(e, R, false, target);
  const img = sampleAll ? await sourceRect(e, R, true) : cloneRGBA8(before);
  const hole = cropMask(sel, R);
  const opts = { patchSize: patchSizeFor(Number(e.settings.contextMoveStructure ?? 4)), colorAdaptation: colorAdaptationFor(color) };
  let base = img;
  if (!extend) {
    const copy = cloneRGBA8(img),
      holeCopy = { width: hole.width, height: hole.height, data: new Uint8Array(hole.data) };
    const filled = await heavy<RGBA8>(e, 'Filling the original area', 'context-fill', { img: copy, hole: holeCopy, opts }, buffersOf(copy, holeCopy));
    if (!filled) return;
    base = filled;
  }
  const S = expandRect(rect, 2, W, H)!;
  const patch = cropRGBA(img, { x: S.x - R.x, y: S.y - R.y, width: S.width, height: S.height });
  const pmask = cropMask(sel, S);
  const ox = S.x + dx - R.x,
    oy = S.y + dy - R.y;
  let out = placeOver(base, patch, pmask, ox, oy);
  if (color > 0) {
    // Color adaptation blends the moved content toward a seamless (gradient-
    // domain) placement in proportion to the Color setting.
    const dst = cloneRGBA8(base),
      p2 = cloneRGBA8(patch),
      m2 = { width: pmask.width, height: pmask.height, data: new Uint8Array(pmask.data) };
    const healed = await heavy<RGBA8>(e, 'Blending', 'heal', { dst, src: p2, mask: m2, offset: { x: ox, y: oy } }, buffersOf(dst, p2, m2));
    if (!healed) return;
    out = mixImages(out, healed, Math.min(1, color / 10));
  }
  const weight = binarize(extend ? shiftMask(hole, dx, dy) : hole);
  if (!extend) {
    const sh = shiftMask(hole, dx, dy);
    for (let i = 0; i < weight.data.length; i++) if (sh.data[i]) weight.data[i] = 255;
  }
  writeResult(e, target, R, before, out, 'Context Move', { sampleAll, weight, limit: false, selection: maskGrid(e.assets.tiles, shiftMask(sel, dx, dy)) });
}

const structureColor = (e: Editor, prefix: string) =>
  `${numberField(`${prefix}-structure`, 'Structure', Number(e.settings[`${prefix}Structure`] ?? 4), 1, 7)}${numberField(`${prefix}-color`, 'Color', Number(e.settings[`${prefix}Color`] ?? 3), 0, 10)}`;
const patchTool = regionTool(
  {
    id: 'patch',
    label: 'Patch Tool',
    key: 'J',
    icon: 'patch',
    group: 'heal',
    options: (e) => {
      const content = e.settings.patchMode === 'content';
      return `${select('patch-mode', 'Patch', content ? 'content' : 'normal', [
        ['normal', 'Normal'],
        ['content', 'Context Aware'],
      ])}${
        content
          ? structureColor(e, 'patch')
          : `<div class="segmented" role="group" aria-label="Patch direction"><button data-patch-dir="source" aria-pressed="${e.settings.patchDirection !== 'destination'}" title="Fill the selection from where you drag it">Source</button><button data-patch-dir="destination" aria-pressed="${e.settings.patchDirection === 'destination'}" title="Copy the selection to where you drag it">Destination</button></div>`
      }${checkbox('patch-all', 'Sample All Layers', !!e.settings.patchSampleAll)}`;
    },
    bindOptions: ({ e, el }) => {
      bindSelect(e, el, 'patch-mode', 'patchMode', () => e.options());
      el.querySelectorAll<HTMLButtonElement>('[data-patch-dir]').forEach((b) =>
        b.addEventListener('click', () => {
          e.settings.patchDirection = b.dataset.patchDir;
          e.options();
        }),
      );
      bindNumber(e, el, 'patch-structure', 'patchStructure', 1, 7);
      bindNumber(e, el, 'patch-color', 'patchColor', 0, 10);
      bindCheck(e, el, 'patch-all', 'patchSampleAll');
    },
  },
  'Patch',
  applyPatch,
);
const contextMoveTool = regionTool(
  {
    id: 'context-move',
    label: 'Context Move Tool',
    key: 'J',
    icon: 'context-move',
    group: 'heal',
    options: (e) =>
      `${select('cm-mode', 'Mode', (e.settings.contextMoveMode as string) ?? 'move', [
        ['move', 'Move'],
        ['extend', 'Extend'],
      ])}${structureColor(e, 'contextMove')}${checkbox('cm-all', 'Sample All Layers', !!e.settings['context-moveSampleAll'])}`,
    bindOptions: ({ e, el }) => {
      bindSelect(e, el, 'cm-mode', 'contextMoveMode');
      bindNumber(e, el, 'contextMove-structure', 'contextMoveStructure', 1, 7);
      bindNumber(e, el, 'contextMove-color', 'contextMoveColor', 0, 10);
      bindCheck(e, el, 'cm-all', 'context-moveSampleAll');
    },
  },
  'Context Move',
  applyContextMove,
  true,
);

// ----- Red Eye -----
let redDrag: { start: Pt; last: Pt } | undefined;
const redEyeTool: Tool = {
  id: 'red-eye',
  label: 'Red Eye Tool',
  key: 'J',
  icon: 'red-eye',
  group: 'heal',
  cursor: () => 'crosshair',
  options: (e) => `${numberField('red-pupil', 'Pupil Size', Number(e.settings.redPupil ?? 50), 1, 100, '%')}${numberField('red-darken', 'Darken Amount', Number(e.settings.redDarken ?? 50), 1, 100, '%')}`,
  bindOptions: ({ e, el }) => {
    bindNumber(e, el, 'red-pupil', 'redPupil', 1, 100);
    bindNumber(e, el, 'red-darken', 'redDarken', 1, 100);
  },
  pointerDown: (_e, p) => {
    redDrag = { start: [p.x, p.y], last: [p.x, p.y] };
  },
  pointerMove: (e, p) => {
    if (!redDrag) return;
    redDrag.last = [p.x, p.y];
    e.overlay();
  },
  pointerUp: async (e, p: CanvasPointer) => {
    const d = redDrag;
    redDrag = undefined;
    e.overlay();
    if (!d) return;
    await e.run(async () => {
      const target = await retouchTarget(e, 'The Red Eye tool');
      if (!target) return;
      const W = e.doc.width,
        H = e.doc.height;
      const [x0, y0] = d.start;
      let search: IRect;
      if (Math.hypot(p.x - x0, p.y - y0) < 4) {
        const half = Math.max(12, Math.round(Math.min(W, H) * 0.05));
        search = { x: x0 - half, y: y0 - half, width: 2 * half, height: 2 * half };
      } else search = roundIRect({ x: Math.min(x0, p.x), y: Math.min(y0, p.y), width: Math.abs(p.x - x0), height: Math.abs(p.y - y0) });
      // The darkened disk can extend past the search area; keep a margin.
      const R = expandRect(search, Math.ceil(Math.max(search.width, search.height) / 2) + 4, W, H);
      if (!R) return;
      const before = await sourceRect(e, R, false, target);
      const local = { ...search, x: search.x - R.x, y: search.y - R.y };
      if (!detectRedEye(before, local)) {
        e.message('No red eye found there. Click the center of a red pupil, or drag around it.');
        return;
      }
      const after = redEye(before, local, Number(e.settings.redPupil ?? 50), Number(e.settings.redDarken ?? 50));
      writeResult(e, target, R, before, after, 'Red Eye');
    });
  },
  overlay: (e) => {
    const d = redDrag;
    if (!d) return '';
    const [x0, y0] = d.start,
      [x1, y1] = d.last;
    return ants(`M${x0} ${y0}H${x1}V${y1}H${x0}Z`, e.zoom);
  },
};

export const healTools = [spotHealingTool, healingBrushTool, patchTool, contextMoveTool, removeTool, redEyeTool];
