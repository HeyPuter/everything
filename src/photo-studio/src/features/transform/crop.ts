// Crop tool (rotatable box, straighten, composition overlays, ratio and
// size presets, delete cropped pixels) and the Perspective Crop tool.
import type { Editor } from '../../editor';
import { registerCommand, registerTool, type Command, type Tool } from '../../app/registry';
import type { CanvasPointer } from '../../app/pointer';
import { svg } from '../../app/icons';
import { allLayers, cropDocument } from '../../model/document';
import { commitPixelTranslation, syncPixelTransform } from '../../model/pixel-layer';
import { setDocumentResolution } from '../../model/text-layer';
import { homography, type Point } from '../../imaging/filters/warp';
import { compose, inscribedSize, rectifiedSize, rotateM, straightenAngle, toPixels, translate, type LengthUnit, type Quad } from './math';
import { refocusAfterChoice } from './focus';

type Box = { cx: number; cy: number; w: number; h: number; angle: number };
type Drag =
  | { kind: 'new'; start: Point }
  | { kind: 'move'; start: Point; box: Box }
  | { kind: 'rotate'; start: Point; box: Box }
  | { kind: 'resize'; handle: string; start: Point; box: Box }
  | { kind: 'straighten'; start: Point; end: Point };
let box: Box | undefined;
// The document (session and size) the box was laid out on: undo, redo or a
// switch to another document puts a fresh box on the canvas shown.
let boxDoc: { session: unknown; width: number; height: number } | undefined;
let drag: Drag | undefined;
let straighten = false;
const RAD = Math.PI / 180;

export const CROP_PRESETS: [string, string, number | undefined][] = [
  ['free', 'Ratio', undefined],
  ['original', 'Original Ratio', -1],
  ['1:1', '1 : 1 (Square)', 1],
  ['4:5', '4 : 5 (8 : 10)', 4 / 5],
  ['5:7', '5 : 7', 5 / 7],
  ['2:3', '2 : 3 (4 : 6)', 2 / 3],
  ['16:9', '16 : 9', 16 / 9],
  ['4:3', '4 : 3', 4 / 3],
  ['3:2', '3 : 2', 3 / 2],
  ['whr', 'W x H x Resolution', undefined],
];
export const CROP_OVERLAYS: [string, string][] = [
  ['thirds', 'Rule of Thirds'],
  ['grid', 'Grid'],
  ['golden', 'Golden Ratio'],
  ['diagonal', 'Diagonal'],
  ['triangle', 'Triangle'],
  ['none', 'None'],
];
type CropSettings = { preset: string; rw: number; rh: number; overlay: string; deleteCropped: boolean; tw: number; th: number; tunit: LengthUnit; res: number; resUnit: 'PPI' | 'PPCM' };
function settings(e: Editor): CropSettings {
  // One object for the session: option listeners keep a reference to it.
  const s = ((e.settings.crop as Partial<CropSettings> | undefined) ??= {}) as Partial<CropSettings>;
  s.preset ??= (e.settings.cropRatio as string | undefined) ?? 'free';
  s.rw ??= 0;
  s.rh ??= 0;
  s.overlay ??= 'thirds';
  s.deleteCropped ??= false;
  s.tw ??= 0;
  s.th ??= 0;
  s.tunit ??= 'px';
  s.res ??= 300;
  s.resUnit ??= 'PPI';
  return s as CropSettings;
}
/** Width / height the box must keep, or undefined for a free box. */
function ratioOf(e: Editor): number | undefined {
  const s = settings(e);
  if (s.preset === 'whr') return s.tw > 0 && s.th > 0 ? s.tw / s.th : undefined;
  if (s.preset === 'original') return e.doc.width / e.doc.height;
  if (s.rw > 0 && s.rh > 0) return s.rw / s.rh;
  return undefined;
}
const fullBox = (e: Editor): Box => ({ cx: e.doc.width / 2, cy: e.doc.height / 2, w: e.doc.width, h: e.doc.height, angle: 0 });
function resetBox(e: Editor): Box {
  boxDoc = { session: e.session, width: e.doc.width, height: e.doc.height };
  return (box = fullBox(e));
}
/** The crop box, reset when the document under it changed size or identity. */
function currentBox(e: Editor): Box | undefined {
  if (box && (boxDoc?.session !== e.session || boxDoc.width !== e.doc.width || boxDoc.height !== e.doc.height)) {
    drag = undefined;
    resetBox(e);
  }
  return box;
}
const untouched = (e: Editor) => !!box && box.angle === 0 && Math.abs(box.w - e.doc.width) < 1e-6 && Math.abs(box.h - e.doc.height) < 1e-6 && Math.abs(box.cx - e.doc.width / 2) < 1e-6 && Math.abs(box.cy - e.doc.height / 2) < 1e-6;
export function boxCorners(b: Box): Quad {
  const c = Math.cos(b.angle * RAD),
    s = Math.sin(b.angle * RAD);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([x, y]) => {
    const dx = (x * b.w) / 2,
      dy = (y * b.h) / 2;
    return { x: b.cx + dx * c - dy * s, y: b.cy + dx * s + dy * c };
  }) as Quad;
}
const toLocal = (b: Box, p: Point): Point => {
  const c = Math.cos(-b.angle * RAD),
    s = Math.sin(-b.angle * RAD),
    dx = p.x - b.cx,
    dy = p.y - b.cy;
  return { x: dx * c - dy * s, y: dx * s + dy * c };
};
const fromLocalVec = (b: Box, v: Point): Point => {
  const c = Math.cos(b.angle * RAD),
    s = Math.sin(b.angle * RAD);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
};
/** Shrink a rotated box about its center until it lies inside the canvas. */
export function fitInside(b: Box, W: number, H: number): Box {
  let f = 1;
  for (const p of boxCorners(b)) {
    const ox = p.x - b.cx,
      oy = p.y - b.cy;
    if (ox > 0) f = Math.min(f, (W - b.cx) / ox);
    if (ox < 0) f = Math.min(f, -b.cx / ox);
    if (oy > 0) f = Math.min(f, (H - b.cy) / oy);
    if (oy < 0) f = Math.min(f, -b.cy / oy);
  }
  f = Math.max(f, 1 / Math.max(b.w, b.h));
  return { ...b, w: b.w * f, h: b.h * f };
}
/** Resize from a handle in the box frame, keeping the opposite side fixed
 * (or the center with Alt) and an optional aspect ratio. */
export function resizeBox(b0: Box, handle: string, delta: Point, ratio: number | undefined, fromCenter: boolean): Box {
  const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0,
    sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
  const k = fromCenter ? 2 : 1;
  let w = Math.max(1, b0.w + sx * delta.x * k),
    h = Math.max(1, b0.h + sy * delta.y * k);
  if (ratio) {
    if (!sx) w = h * ratio;
    else if (!sy) h = w / ratio;
    else if (Math.abs(w - b0.w) * b0.h >= Math.abs(h - b0.h) * b0.w) h = w / ratio;
    else w = h * ratio;
  }
  const shift = fromCenter ? { x: 0, y: 0 } : fromLocalVec(b0, { x: (sx * (w - b0.w)) / 2, y: (sy * (h - b0.h)) / 2 });
  return { ...b0, w, h, cx: b0.cx + shift.x, cy: b0.cy + shift.y };
}

function syncFields(e: Editor) {
  const el = e.root.querySelector('#crop-size');
  const box = currentBox(e);
  if (el && box) el.textContent = `${Math.round(box.w)} × ${Math.round(box.h)} px${box.angle ? `, ${Math.round(box.angle * 10) / 10}°` : ''}`;
}
function constrainToRatio(e: Editor) {
  const r = ratioOf(e);
  const box = currentBox(e);
  if (!box || !r) return;
  // Keep the area roughly the same while matching the ratio.
  const area = box.w * box.h;
  box.w = Math.sqrt(area * r);
  box.h = box.w / r;
  const max = Math.min(e.doc.width / box.w, e.doc.height / box.h, 1);
  if (box.angle === 0 && max < 1) {
    box.w *= max;
    box.h *= max;
  }
}

async function commitCrop(e: Editor) {
  if (!currentBox(e)) return;
  // Canvas transforms and resampling load with the first crop.
  const [{ transformCanvasBy, trimGrid }, { resampleDocument, resolveMethod }] = await Promise.all([import('./layer-ops'), import('./image-size')]);
  const b = currentBox(e);
  if (!b) return;
  const s = settings(e);
  const w = Math.max(1, Math.round(b.w)),
    h = Math.max(1, Math.round(b.h));
  if (w > 8192 || h > 8192 || w * h > 24_000_000) {
    e.message('Crop size must be 8192 pixels or less per side and 24 megapixels or less.');
    return;
  }
  if (Math.abs(b.angle) < 1e-9) {
    const r = { x: Math.round(b.cx - b.w / 2), y: Math.round(b.cy - b.h / 2), width: w, height: h };
    const store = e.assets.tiles;
    e.command('Crop', (d) => {
      cropDocument(d, r);
      d.selection = null;
      d.selectionMask = null;
      if (!s.deleteCropped) return;
      for (const l of allLayers(d.layers)) {
        if (l.kind !== 'pixel' || !l.pixels) continue;
        commitPixelTranslation(l);
        l.pixels = trimGrid(store, l.pixels, { x: 0, y: 0, width: d.width, height: d.height });
        syncPixelTransform(l, d);
      }
    });
  } else {
    // Turn the image so the box becomes upright, then keep the box.
    const m = compose(translate(w / 2, h / 2), rotateM(-b.angle), translate(-b.cx, -b.cy));
    await transformCanvasBy(e, 'Crop', m, w, h, { trim: s.deleteCropped });
  }
  if (s.preset === 'whr' && s.tw > 0 && s.th > 0) {
    const ppi = s.resUnit === 'PPCM' ? s.res * 2.54 : s.res;
    const tw = Math.max(1, Math.round(toPixels(s.tw, s.tunit, ppi, w))),
      th = Math.max(1, Math.round(toPixels(s.th, s.tunit, ppi, h)));
    if (tw !== e.doc.width || th !== e.doc.height) resampleDocument(e, tw, th, resolveMethod('automatic', e.doc.width, e.doc.height, tw, th), ppi, s.resUnit);
    else e.command('Image Size', (d) => setDocumentResolution(d, { horizontalResolution: s.res, horizontalResolutionUnit: s.resUnit, widthUnit: s.resUnit === 'PPCM' ? 'Centimeters' : 'Inches', verticalResolution: s.res, verticalResolutionUnit: s.resUnit, heightUnit: s.resUnit === 'PPCM' ? 'Centimeters' : 'Inches' }));
  }
  resetBox(e);
  e.fit();
  e.update();
}

function overlayLines(kind: string, w: number, h: number, zoom: number): string {
  const x0 = -w / 2,
    y0 = -h / 2;
  let d = '';
  const v = (f: number) => (d += `M${x0 + f * w} ${y0}V${y0 + h}`);
  const hz = (f: number) => (d += `M${x0} ${y0 + f * h}H${x0 + w}`);
  if (kind === 'thirds') [1 / 3, 2 / 3].forEach((f) => (v(f), hz(f)));
  else if (kind === 'golden') [0.382, 0.618].forEach((f) => (v(f), hz(f)));
  else if (kind === 'grid') {
    const n = Math.max(2, Math.round((Math.max(w, h) * zoom) / 48));
    const step = Math.max(w, h) / n;
    for (let x = step; x < w - 1e-6; x += step) v(x / w);
    for (let y = step; y < h - 1e-6; y += step) hz(y / h);
  } else if (kind === 'diagonal') {
    // 45° lines from each corner.
    const m = Math.min(w, h);
    d += `M${x0} ${y0}l${m} ${m}M${x0 + w} ${y0}l${-m} ${m}M${x0} ${y0 + h}l${m} ${-m}M${x0 + w} ${y0 + h}l${-m} ${-m}`;
  } else if (kind === 'triangle') {
    // The main diagonal and perpendiculars to it from the other corners.
    const len2 = w * w + h * h;
    const foot = (px: number, py: number) => {
      const t = ((px - x0) * w + (py - y0) * h) / len2;
      return [x0 + t * w, y0 + t * h];
    };
    const [ax, ay] = foot(x0 + w, y0),
      [bx, by] = foot(x0, y0 + h);
    d += `M${x0} ${y0}L${x0 + w} ${y0 + h}M${x0 + w} ${y0}L${ax} ${ay}M${x0} ${y0 + h}L${bx} ${by}`;
  }
  return d;
}

// ----- Perspective crop -----
let quad: Point[] = [];
// index: a corner, -1 moves all corners, -2 is the first click (may become a rectangle).
let quadDrag: { index: number; start: Point; points: Point[] } | undefined;
/** Order four points as top-left, top-right, bottom-right, bottom-left. */
export function orderQuad(pts: Point[]): Quad {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4,
    cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // Angles from -π: start with the point nearest the top-left direction.
  let start = 0,
    best = Infinity;
  sorted.forEach((p, i) => {
    const s = p.x + p.y;
    if (s < best) [best, start] = [s, i];
  });
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]) as Quad;
}
async function commitPerspective(e: Editor) {
  if (quad.length !== 4) {
    e.message('Place four corners on the canvas first.');
    return;
  }
  const q = orderQuad(quad);
  // A dented or flat outline has no plane to straighten (the outline turns red).
  if (!isConvex(q)) {
    e.message('The corners must form a convex four-sided shape; drag them to the corners of the plane.');
    return;
  }
  const s = (e.settings.perspectiveCrop as { w?: number; h?: number } | undefined) ?? {};
  const auto = rectifiedSize(q);
  const w = s.w && s.w > 0 ? Math.round(s.w) : auto.width,
    h = s.h && s.h > 0 ? Math.round(s.h) : auto.height;
  if (w > 8192 || h > 8192 || w * h > 24_000_000) {
    e.message('The corrected image would exceed 8192 pixels or 24 megapixels; enter a smaller size.');
    return;
  }
  let m;
  try {
    m = homography(q, [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ]);
  } catch {
    e.message('The corners must form a four-sided shape.');
    return;
  }
  const { transformCanvasBy } = await import('./layer-ops');
  quad = [];
  await transformCanvasBy(e, 'Perspective Crop', m, w, h, { trim: true });
}

export const cropTool: Tool = {
  id: 'crop',
  label: 'Crop Tool',
  key: 'C',
  icon: 'crop',
  group: 'crop',
  cursor: () => (straighten ? 'crosshair' : 'default'),
  activate: (e) => {
    resetBox(e);
    straighten = false;
  },
  deactivate: () => {
    box = undefined;
    drag = undefined;
    straighten = false;
  },
  options: (e) => {
    const s = settings(e);
    const whr = s.preset === 'whr';
    let html = `<select id="crop-preset" aria-label="Crop preset">${CROP_PRESETS.map(([id, label]) => `<option value="${id}" ${s.preset === id ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
    if (whr)
      html += `<label>W <input id="crop-tw" type="number" min="0" step="any" value="${s.tw || ''}" placeholder="width"></label><button class="icon-button" data-crop-action="swap" title="Swap width and height" aria-label="Swap width and height">${svg('arrow-left-right', 14)}</button><label>H <input id="crop-th" type="number" min="0" step="any" value="${s.th || ''}" placeholder="height"></label><select id="crop-tunit" aria-label="Size unit">${(['px', 'in', 'cm', 'mm'] as LengthUnit[]).map((u) => `<option value="${u}" ${s.tunit === u ? 'selected' : ''}>${u}</option>`).join('')}</select><label>Resolution <input id="crop-res" type="number" min="1" step="any" value="${s.res}"></label><select id="crop-resunit" aria-label="Resolution unit"><option value="PPI" ${s.resUnit === 'PPI' ? 'selected' : ''}>px/in</option><option value="PPCM" ${s.resUnit === 'PPCM' ? 'selected' : ''}>px/cm</option></select>`;
    else
      html += `<input id="crop-rw" type="number" min="0" step="any" value="${s.rw || ''}" placeholder="W" aria-label="Ratio width" ${s.preset === 'original' ? 'disabled' : ''}><button class="icon-button" data-crop-action="swap" title="Swap width and height" aria-label="Swap width and height">${svg('arrow-left-right', 14)}</button><input id="crop-rh" type="number" min="0" step="any" value="${s.rh || ''}" placeholder="H" aria-label="Ratio height" ${s.preset === 'original' ? 'disabled' : ''}>`;
    html += `<button data-crop-action="clear" title="Clear the ratio">Clear</button><span class="divider"></span>`;
    html += `<button class="toggle" data-crop-action="straighten" aria-pressed="${straighten}" title="Draw a line along the horizon or a vertical edge to level the image">${svg('ruler', 14)} Straighten</button>`;
    html += `<label>Overlay <select id="crop-overlay">${CROP_OVERLAYS.map(([id, l]) => `<option value="${id}" ${s.overlay === id ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
    html += `<label class="transform-setting" title="When off, pixels outside the crop stay on their layers"><input id="crop-delete" type="checkbox" ${s.deleteCropped ? 'checked' : ''}>Delete Cropped Pixels</label>`;
    html += `<span class="hint" id="crop-size"></span><span class="divider"></span><button data-command="crop.reset" class="icon-button" title="Reset the crop box" aria-label="Reset crop">${svg('rotate-ccw', 16)}</button><button data-command="crop.cancel" class="icon-button" title="Cancel crop (Escape)" aria-label="Cancel crop">${svg('ban', 16)}</button><button data-command="crop.commit" class="icon-button transform-apply" title="Commit crop (Enter)" aria-label="Commit crop">${svg('check', 16)}</button>`;
    return html;
  },
  bindOptions: ({ e, el }) => {
    const s = settings(e);
    refocusAfterChoice(e, el);
    const rerender = () => {
      constrainToRatio(e);
      e.options();
      e.overlay();
      syncFields(e);
    };
    el.querySelector<HTMLSelectElement>('#crop-preset')?.addEventListener('change', (ev) => {
      s.preset = (ev.target as HTMLSelectElement).value;
      const p = CROP_PRESETS.find(([id]) => id === s.preset);
      if (p?.[2] && p[2] > 0) [s.rw, s.rh] = s.preset.split(':').map(Number);
      else if (s.preset === 'free') [s.rw, s.rh] = [0, 0];
      else if (s.preset === 'original') [s.rw, s.rh] = [e.doc.width, e.doc.height];
      rerender();
    });
    const num = (id: string, fn: (v: number) => void) =>
      el.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener('change', (ev) => {
        const v = Number((ev.target as HTMLInputElement).value);
        fn(Number.isFinite(v) && v > 0 ? v : 0);
        rerender();
      });
    num('crop-rw', (v) => {
      s.rw = v;
      if (s.preset !== 'free') s.preset = 'free';
    });
    num('crop-rh', (v) => {
      s.rh = v;
      if (s.preset !== 'free') s.preset = 'free';
    });
    num('crop-tw', (v) => (s.tw = v));
    num('crop-th', (v) => (s.th = v));
    num('crop-res', (v) => (s.res = v || 72));
    el.querySelector<HTMLSelectElement>('#crop-tunit')?.addEventListener('change', (ev) => (s.tunit = (ev.target as HTMLSelectElement).value as LengthUnit));
    el.querySelector<HTMLSelectElement>('#crop-resunit')?.addEventListener('change', (ev) => (s.resUnit = (ev.target as HTMLSelectElement).value as 'PPI' | 'PPCM'));
    el.querySelector<HTMLSelectElement>('#crop-overlay')?.addEventListener('change', (ev) => {
      s.overlay = (ev.target as HTMLSelectElement).value;
      e.overlay();
    });
    el.querySelector<HTMLInputElement>('#crop-delete')?.addEventListener('change', (ev) => (s.deleteCropped = (ev.target as HTMLInputElement).checked));
    el.querySelectorAll<HTMLButtonElement>('[data-crop-action]').forEach((b) =>
      b.addEventListener('click', () => {
        const a = b.dataset.cropAction;
        if (a === 'swap') {
          if (s.preset === 'whr') [s.tw, s.th] = [s.th, s.tw];
          else {
            [s.rw, s.rh] = [s.rh, s.rw];
            if (s.preset !== 'free' && s.preset !== 'original') s.preset = 'free';
          }
          const box = currentBox(e);
          if (box && !ratioOf(e)) [box.w, box.h] = [box.h, box.w];
          rerender();
        } else if (a === 'clear') {
          s.preset = 'free';
          s.rw = s.rh = s.tw = s.th = 0;
          rerender();
        } else if (a === 'straighten') {
          straighten = !straighten;
          e.options();
        }
      }),
    );
    syncFields(e);
  },
  pointerDown: (e, p) => {
    const box = currentBox(e) ?? resetBox(e);
    const at = { x: p.x, y: p.y };
    if (straighten) {
      drag = { kind: 'straighten', start: at, end: at };
      return;
    }
    const handle = (p.event.target as Element).closest?.('[data-crop-handle]')?.getAttribute('data-crop-handle');
    const l = toLocal(box, at);
    const inside = Math.abs(l.x) <= box.w / 2 && Math.abs(l.y) <= box.h / 2;
    if (handle) drag = { kind: 'resize', handle, start: at, box: { ...box } };
    else if (inside && untouched(e)) drag = { kind: 'new', start: at };
    else if (inside) drag = { kind: 'move', start: at, box: { ...box } };
    else drag = { kind: 'rotate', start: at, box: { ...box } };
  },
  pointerMove: (e, p) => {
    if (!drag || !box) return;
    const at = { x: p.x, y: p.y };
    if (drag.kind === 'straighten') drag.end = at;
    else if (drag.kind === 'new') {
      const r = ratioOf(e);
      let w = Math.abs(at.x - drag.start.x),
        h = Math.abs(at.y - drag.start.y);
      if (r) {
        if (w / Math.max(h, 1e-9) > r) h = w / r;
        else w = h * r;
      } else if (p.shift) w = h = Math.max(w, h);
      if (w < 2 && h < 2) return;
      const sx = at.x >= drag.start.x ? 1 : -1,
        sy = at.y >= drag.start.y ? 1 : -1;
      box = { cx: drag.start.x + (sx * w) / 2, cy: drag.start.y + (sy * h) / 2, w: Math.max(1, w), h: Math.max(1, h), angle: 0 };
    } else if (drag.kind === 'move') box = { ...drag.box, cx: drag.box.cx + at.x - drag.start.x, cy: drag.box.cy + at.y - drag.start.y };
    else if (drag.kind === 'rotate') {
      const b = drag.box;
      let a = b.angle + (Math.atan2(at.y - b.cy, at.x - b.cx) - Math.atan2(drag.start.y - b.cy, drag.start.x - b.cx)) / RAD;
      if (p.shift) a = Math.round(a / 15) * 15;
      a = ((((a + 180) % 360) + 360) % 360) - 180;
      // Keep the rotated box on the image so no empty corners appear.
      box = fitInside({ ...b, angle: a }, e.doc.width, e.doc.height);
    } else {
      const local = toLocal({ ...drag.box, cx: 0, cy: 0 }, { x: at.x - drag.start.x, y: at.y - drag.start.y });
      const r = ratioOf(e) ?? (p.shift ? drag.box.w / drag.box.h : undefined);
      box = resizeBox(drag.box, drag.handle, local, r, p.alt);
    }
    e.overlay();
    syncFields(e);
  },
  pointerUp: (e) => {
    const d = drag;
    drag = undefined;
    if (d?.kind === 'straighten') {
      straighten = false;
      if (Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y) > 3) {
        const angle = -straightenAngle(d.start, d.end);
        const W = e.doc.width,
          H = e.doc.height;
        const r = ratioOf(e) ?? W / H;
        const size = inscribedSize(W, H, angle, r);
        box = { cx: W / 2, cy: H / 2, w: size.width, h: size.height, angle };
      }
      e.options();
      e.overlay();
    }
  },
  doubleClick: (e) => void e.runCommand('crop.commit'),
  keyDown: (e, ev) => {
    if (ev.key === 'Enter') {
      void e.runCommand('crop.commit');
      return true;
    }
    if (ev.key === 'Escape') {
      void e.runCommand('crop.cancel');
      return true;
    }
    return false;
  },
  overlay: (e) => {
    const b = currentBox(e);
    if (!b) return '';
    const z = e.zoom;
    const W = e.doc.width,
      H = e.doc.height,
      pad = Math.max(W, H) * 4;
    const corners = boxCorners(b);
    let html = `<path class="crop-shade" fill-rule="evenodd" d="M${-pad} ${-pad}H${W + pad}V${H + pad}H${-pad}Z M${corners.map((c) => `${c.x} ${c.y}`).join('L')}Z"/>`;
    const overlayKind = settings(e).overlay;
    html += `<g transform="translate(${b.cx} ${b.cy}) rotate(${b.angle})">`;
    if (overlayKind !== 'none') html += `<path class="crop-grid-lines" d="${overlayLines(overlayKind, b.w, b.h, z)}" stroke-width="${0.8 / z}"/>`;
    html += `<rect class="crop-box" x="${-b.w / 2}" y="${-b.h / 2}" width="${b.w}" height="${b.h}" stroke-width="${1.5 / z}"/>`;
    for (const k of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const hx = k.includes('w') ? -b.w / 2 : k.includes('e') ? b.w / 2 : 0;
      const hy = k.includes('n') ? -b.h / 2 : k.includes('s') ? b.h / 2 : 0;
      const s = 9 / z;
      html += `<rect data-crop-handle="${k}" class="crop-handle" x="${hx - s / 2}" y="${hy - s / 2}" width="${s}" height="${s}" stroke-width="${1 / z}"/>`;
    }
    html += '</g>';
    if (drag?.kind === 'straighten') html += `<line class="crop-straighten" x1="${drag.start.x}" y1="${drag.start.y}" x2="${drag.end.x}" y2="${drag.end.y}" stroke-width="${1.5 / z}"/>`;
    return html;
  },
};
export const perspectiveCropTool: Tool = {
  id: 'perspective-crop',
  label: 'Perspective Crop Tool',
  key: 'C',
  icon: 'crop-perspective',
  group: 'crop',
  cursor: () => 'crosshair',
  activate: () => {
    quad = [];
  },
  deactivate: () => {
    quad = [];
    quadDrag = undefined;
  },
  options: (e) => {
    const s = (e.settings.perspectiveCrop as { w?: number; h?: number; grid?: boolean } | undefined) ?? {};
    const auto = quad.length === 4 ? rectifiedSize(orderQuad(quad)) : undefined;
    return `<label>W <input id="pc-w" type="number" min="0" step="1" value="${s.w || ''}" placeholder="${auto?.width ?? 'auto'}"> px</label><label>H <input id="pc-h" type="number" min="0" step="1" value="${s.h || ''}" placeholder="${auto?.height ?? 'auto'}"> px</label><label class="transform-setting"><input id="pc-grid" type="checkbox" ${s.grid !== false ? 'checked' : ''}>Show Grid</label><span class="hint">${quad.length < 4 ? `Click ${4 - quad.length} more corner${quad.length === 3 ? '' : 's'}, or drag a rectangle.` : 'Drag corners to match the plane, then press Enter.'}</span><span class="divider"></span><button data-command="perspective-crop.cancel" class="icon-button" title="Cancel (Escape)" aria-label="Cancel perspective crop">${svg('ban', 16)}</button><button data-command="perspective-crop.commit" class="icon-button transform-apply" title="Commit (Enter)" aria-label="Commit perspective crop" ${quad.length === 4 && isConvex(orderQuad(quad)) ? '' : 'disabled'}>${svg('check', 16)}</button>`;
  },
  bindOptions: ({ e, el }) => {
    refocusAfterChoice(e, el);
    const s = ((e.settings.perspectiveCrop as Record<string, unknown> | undefined) ??= {}) as { w?: number; h?: number; grid?: boolean };
    e.settings.perspectiveCrop = s;
    el.querySelector<HTMLInputElement>('#pc-w')?.addEventListener('change', (ev) => (s.w = Math.max(0, Math.round(Number((ev.target as HTMLInputElement).value) || 0))));
    el.querySelector<HTMLInputElement>('#pc-h')?.addEventListener('change', (ev) => (s.h = Math.max(0, Math.round(Number((ev.target as HTMLInputElement).value) || 0))));
    el.querySelector<HTMLInputElement>('#pc-grid')?.addEventListener('change', (ev) => {
      s.grid = (ev.target as HTMLInputElement).checked;
      e.overlay();
    });
  },
  pointerDown: (e, p: CanvasPointer) => {
    const at = { x: p.x, y: p.y };
    const handle = (p.event.target as Element).closest?.('[data-pc-handle]')?.getAttribute('data-pc-handle');
    if (handle !== null && handle !== undefined) {
      quadDrag = { index: Number(handle), start: at, points: quad.map((q) => ({ ...q })) };
      return;
    }
    if (quad.length === 4 && insidePoly(quad, at)) {
      quadDrag = { index: -1, start: at, points: quad.map((q) => ({ ...q })) };
      return;
    }
    if (quad.length === 4) quad = [];
    if (quad.length === 0) {
      quadDrag = { index: -2, start: at, points: [] };
      quad = [at];
    } else quad.push(at);
    e.options();
    e.overlay();
  },
  pointerMove: (e, p) => {
    const d = quadDrag;
    if (!d) return;
    const at = { x: p.x, y: p.y };
    if (d.index === -2) {
      // Dragging from the first click lays down an axis-aligned rectangle.
      if (Math.hypot(at.x - d.start.x, at.y - d.start.y) < 4) return;
      quad = [d.start, { x: at.x, y: d.start.y }, at, { x: d.start.x, y: at.y }];
    } else if (d.index === -1) quad = d.points.map((q) => ({ x: q.x + at.x - d.start.x, y: q.y + at.y - d.start.y }));
    else quad[d.index] = { x: d.points[d.index].x + at.x - d.start.x, y: d.points[d.index].y + at.y - d.start.y };
    e.overlay();
  },
  pointerUp: (e) => {
    const d = quadDrag;
    quadDrag = undefined;
    if (d?.index === -2 && quad.length === 4) e.options();
    if (d && d.index >= -1) e.options();
  },
  keyDown: (e, ev) => {
    if (ev.key === 'Enter') {
      void e.runCommand('perspective-crop.commit');
      return true;
    }
    if (ev.key === 'Escape') {
      void e.runCommand('perspective-crop.cancel');
      return true;
    }
    if (ev.key === 'Backspace' && quad.length && quad.length < 4) {
      quad.pop();
      e.options();
      e.overlay();
      return true;
    }
    return false;
  },
  overlay: (e) => {
    if (!quad.length) return '';
    const z = e.zoom,
      sw = 1 / z;
    const W = e.doc.width,
      H = e.doc.height,
      pad = Math.max(W, H) * 4;
    let html = '';
    if (quad.length === 4) {
      const q = orderQuad(quad);
      const valid = isConvex(q);
      html += `<path class="crop-shade" fill-rule="evenodd" d="M${-pad} ${-pad}H${W + pad}V${H + pad}H${-pad}Z M${q.map((c) => `${c.x} ${c.y}`).join('L')}Z"/>`;
      const s = (e.settings.perspectiveCrop as { grid?: boolean } | undefined) ?? {};
      if (s.grid !== false && valid) html += `<path class="crop-grid-lines" d="${perspectiveGrid(q, 4)}" stroke-width="${0.8 * sw}"/>`;
      html += `<polygon class="crop-box ${valid ? '' : 'invalid'}" points="${q.map((c) => `${c.x},${c.y}`).join(' ')}" stroke-width="${1.5 * sw}"/>`;
    } else html += `<polyline class="crop-box" fill="none" points="${quad.map((c) => `${c.x},${c.y}`).join(' ')}" stroke-width="${1.5 * sw}"/>`;
    quad.forEach((c, i) => {
      const s = 9 / z;
      html += `<rect data-pc-handle="${i}" class="crop-handle" x="${c.x - s / 2}" y="${c.y - s / 2}" width="${s}" height="${s}" stroke-width="${sw}"/>`;
    });
    return html;
  },
};
export const cropCommands: Command[] = [
  { id: 'crop.commit', label: 'Commit Crop', hidden: true, recordable: false, run: (e) => commitCrop(e) },
  {
    id: 'crop.cancel',
    label: 'Cancel Crop',
    hidden: true,
    recordable: false,
    run: (e) => {
      resetBox(e);
      straighten = false;
      e.options();
      e.overlay();
    },
  },
  {
    id: 'crop.reset',
    label: 'Reset Crop',
    hidden: true,
    recordable: false,
    run: (e) => {
      resetBox(e);
      e.options();
      e.overlay();
    },
  },
  { id: 'perspective-crop.commit', label: 'Commit Perspective Crop', hidden: true, recordable: false, run: (e) => commitPerspective(e) },
  {
    id: 'perspective-crop.cancel',
    label: 'Cancel Perspective Crop',
    hidden: true,
    recordable: false,
    run: (e) => {
      quad = [];
      e.options();
      e.overlay();
    },
  },
];
export function installCrop(_e: Editor) {
  registerTool(cropTool, perspectiveCropTool);
  registerCommand(...cropCommands);
}
function insidePoly(q: Point[], p: Point) {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i],
      b = q[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function isConvex(q: Quad) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i],
      b = q[(i + 1) % 4],
      c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9 || (sign && Math.sign(cross) !== sign)) return false;
    sign = Math.sign(cross);
  }
  return true;
}
/** Grid lines of the plane: evenly spaced in the rectified image. */
function perspectiveGrid(q: Quad, n: number) {
  let m;
  try {
    m = homography(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      q,
    );
  } catch {
    return '';
  }
  const at = (u: number, v: number) => {
    const w = m[6] * u + m[7] * v + m[8];
    return `${(m[0] * u + m[1] * v + m[2]) / w} ${(m[3] * u + m[4] * v + m[5]) / w}`;
  };
  let d = '';
  for (let i = 1; i < n; i++) {
    const t = i / n;
    d += `M${at(t, 0)}L${at(t, 1)}M${at(0, t)}L${at(1, t)}`;
  }
  return d;
}
