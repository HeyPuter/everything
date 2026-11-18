// Slice and Slice Select tools: drawing user slices, selecting, moving and
// resizing them, promoting automatic slices, and the slice overlay.
import type { Editor } from '../../editor';
import { registerTool } from '../../app/registry';
import type { CanvasPointer } from '../../app/pointer';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import type { Rect } from '../../model/document';
import { clipRect, MAX_SLICES, partitionSlices, sliceAt, sliceRect, type Slice } from '../../model/slices';

// ----- Shared state (per editor session; IDs that vanish are ignored) -----
export const sliceState = {
  selected: new Set<string>(),
  // An automatic slice clicked with the Slice Select tool (by its rectangle).
  auto: undefined as Rect | undefined,
  hideAuto: false,
};
type Style = 'normal' | 'size' | 'ratio';
const toolSettings = { style: 'normal' as Style, width: 200, height: 100 };
type Drag =
  | { kind: 'new'; start: [number, number]; rect?: Rect }
  | { kind: 'move'; start: [number, number]; ids: string[]; rects: Map<string, Rect>; moved: boolean }
  | { kind: 'resize'; id: string; handle: string; rect: Rect; draft?: Rect };
let drag: Drag | undefined;

export const isSliceTool = (e: Editor) => e.tool === 'slice' || e.tool === 'slice-select';
export const slicesVisible = (e: Editor) => e.hasDocument && !e.settings.extrasHidden && (!!e.preferences.showSlices || isSliceTool(e));
export function selectedSlices(e: Editor): Slice[] {
  return (e.doc.slices ?? []).filter((s) => sliceState.selected.has(s.id));
}
export function slicesLocked(e: Editor) {
  if (!e.preferences.lockSlices) return false;
  e.message('Slices are locked. Choose View → Lock Slices to edit them.');
  return true;
}
export function showSlices(e: Editor) {
  if (e.preferences.showSlices) return;
  e.preferences.showSlices = true;
  e.savePreferences();
}
export const newSliceId = () => crypto.randomUUID();

// ----- Snapping -----
/** Vertical and horizontal edges a slice can snap to: canvas, guides and
 * other slices (excluding `skip`). */
export function sliceEdges(e: Editor, skip: ReadonlySet<string> = new Set()) {
  const doc = e.doc;
  const x = [0, doc.width],
    y = [0, doc.height];
  for (const g of doc.guides ?? []) (g.orientation === 'vertical' ? x : y).push(g.position);
  for (const s of doc.slices ?? []) {
    if (skip.has(s.id)) continue;
    const r = sliceRect(doc, s);
    if (r) {
      x.push(r.x, r.x + r.width);
      y.push(r.y, r.y + r.height);
    }
  }
  return { x, y };
}
const snapValue = (v: number, targets: number[], threshold: number) => {
  let best = v,
    dist = threshold;
  for (const t of targets)
    if (Math.abs(t - v) <= dist) {
      dist = Math.abs(t - v);
      best = t;
    }
  return best;
};
function snapPoint(e: Editor, p: [number, number], skip?: ReadonlySet<string>): [number, number] {
  if (!e.transform.snapping || e.preferences.snapSlices === false) return [Math.round(p[0]), Math.round(p[1])];
  const t = sliceEdges(e, skip),
    th = 6 / e.zoom;
  return [Math.round(snapValue(p[0], t.x, th)), Math.round(snapValue(p[1], t.y, th))];
}
/** Snap a moving rectangle by whichever of its edges is closest to a target. */
function snapRect(e: Editor, r: Rect, skip: ReadonlySet<string>): Rect {
  if (!e.transform.snapping || e.preferences.snapSlices === false) return { ...r, x: Math.round(r.x), y: Math.round(r.y) };
  const t = sliceEdges(e, skip),
    th = 6 / e.zoom;
  const axis = (a: number, size: number, targets: number[]) => {
    let best = Math.round(a),
      dist = th;
    for (const v of targets)
      for (const edge of [a, a + size]) {
        const d = Math.abs(v - edge);
        if (d <= dist) {
          dist = d;
          best = Math.round(a + v - edge);
        }
      }
    return best;
  };
  return { ...r, x: axis(r.x, r.width, t.x), y: axis(r.y, r.height, t.y) };
}

// ----- Geometry of the Slice tool -----
function drawnRect(e: Editor, start: [number, number], p: CanvasPointer): Rect {
  if (toolSettings.style === 'size') {
    const [x, y] = snapPoint(e, [p.x, p.y]);
    return { x, y, width: toolSettings.width, height: toolSettings.height };
  }
  let [x1, y1] = snapPoint(e, [p.x, p.y]);
  const [x0, y0] = start;
  if (toolSettings.style === 'ratio' || p.shift) {
    const ratio = toolSettings.style === 'ratio' ? toolSettings.width / toolSettings.height : 1;
    let w = Math.abs(x1 - x0),
      h = Math.abs(y1 - y0);
    if (w / ratio > h) h = w / ratio;
    else w = h * ratio;
    x1 = x0 + Math.sign(x1 - x0 || 1) * Math.round(w);
    y1 = y0 + Math.sign(y1 - y0 || 1) * Math.round(h);
  }
  const x = Math.min(x0, x1),
    y = Math.min(y0, y1);
  return { x, y, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

const handleNames = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
function handlePoint(r: Rect, h: string): [number, number] {
  const fx = h.includes('w') ? 0 : h.includes('e') ? 1 : 0.5,
    fy = h.includes('n') ? 0 : h.includes('s') ? 1 : 0.5;
  return [r.x + r.width * fx, r.y + r.height * fy];
}
function resized(r: Rect, h: string, p: [number, number]): Rect {
  let x0 = r.x,
    y0 = r.y,
    x1 = r.x + r.width,
    y1 = r.y + r.height;
  if (h.includes('w')) x0 = p[0];
  if (h.includes('e')) x1 = p[0];
  if (h.includes('n')) y0 = p[1];
  if (h.includes('s')) y1 = p[1];
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

export function addSlice(e: Editor, rect: Rect, label = 'Slice') {
  const r = clipRect(rect, e.doc.width, e.doc.height);
  if (!r) return;
  if ((e.doc.slices?.length ?? 0) >= MAX_SLICES) {
    e.message(`This document already has ${MAX_SLICES} slices, the most it can hold.`);
    return;
  }
  const id = newSliceId();
  e.command(label, (d) => {
    d.slices = [...(d.slices ?? []), { id, rect: r }];
  });
  sliceState.selected = new Set([id]);
  sliceState.auto = undefined;
  showSlices(e);
  e.options();
  e.overlay();
}

// ----- Overlay -----
function badge(x: number, y: number, z: number, text: string, cls: string, layer = false) {
  const w = 8 + text.length * 6.5 + (layer ? 10 : 0);
  return `<g class="slice-badge ${cls}" transform="translate(${x} ${y}) scale(${1 / z})"><rect x="1" y="1" width="${w}" height="14" rx="2"/><text x="5" y="12">${escapeXML(text)}</text>${layer ? `<path class="slice-layer-mark" d="M${w - 9} 5h6v6h-6z"/>` : ''}</g>`;
}
export function slicesOverlay(e: Editor): string {
  if (!slicesVisible(e)) return '';
  const doc = e.displayDoc,
    z = e.zoom;
  const live = new Set((doc.slices ?? []).map((s) => s.id));
  for (const id of sliceState.selected) if (!live.has(id)) sliceState.selected.delete(id);
  const pieces = partitionSlices(doc);
  const draft = drag?.kind === 'move' ? drag.rects : drag?.kind === 'resize' && drag.draft ? new Map([[drag.id, drag.draft]]) : undefined;
  let lines = '',
    badges = '',
    selection = '';
  for (const p of pieces) {
    const r = p.rect;
    if (p.kind === 'auto') {
      if (sliceState.hideAuto) continue;
      lines += `<rect class="slice-auto" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" stroke-width="${1 / z}" stroke-dasharray="${4 / z} ${3 / z}"/>`;
    }
    badges += badge(r.x, r.y, z, String(p.number).padStart(2, '0'), p.kind === 'auto' ? 'auto' : 'user', p.kind === 'layer');
  }
  for (const s of doc.slices ?? []) {
    const r = draft?.get(s.id) ?? sliceRect(doc, s);
    if (!r) continue;
    const sel = sliceState.selected.has(s.id);
    lines += `<rect class="slice-user ${sel ? 'selected' : ''}" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" stroke-width="${(sel ? 2 : 1) / z}"/>`;
    if (sel) {
      selection += `<rect class="slice-selected-fill" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}"/>`;
      if (e.tool === 'slice-select' && sliceState.selected.size === 1 && !s.layerId && !e.preferences.lockSlices)
        for (const h of handleNames) {
          const [hx, hy] = handlePoint(r, h);
          selection += `<rect class="slice-handle" x="${hx - 3.5 / z}" y="${hy - 3.5 / z}" width="${7 / z}" height="${7 / z}" stroke-width="${1 / z}"/>`;
        }
    }
  }
  if (sliceState.auto) {
    const r = sliceState.auto;
    selection += `<rect class="slice-user selected" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" stroke-width="${2 / z}" stroke-dasharray="${5 / z} ${3 / z}"/>`;
  }
  if (drag?.kind === 'new' && drag.rect) {
    const r = drag.rect;
    selection += `<rect class="slice-user selected" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" stroke-width="${2 / z}"/>`;
    selection += badge(r.x + r.width, r.y + r.height + 4 / z, z, `${r.width} × ${r.height}`, 'size');
  }
  return `<g class="slices-overlay">${selection}${lines}${badges}</g>`;
}

// ----- Tools -----
function hitHandle(e: Editor, p: CanvasPointer): { id: string; handle: string; rect: Rect } | undefined {
  if (sliceState.selected.size !== 1) return;
  const s = selectedSlices(e)[0];
  if (!s || s.layerId) return;
  const r = sliceRect(e.doc, s);
  if (!r) return;
  const tol = 6 / e.zoom;
  for (const h of handleNames) {
    const [hx, hy] = handlePoint(r, h);
    if (Math.abs(p.x - hx) <= tol && Math.abs(p.y - hy) <= tol) return { id: s.id, handle: h, rect: r };
  }
}
function autoPieceAt(e: Editor, x: number, y: number) {
  return partitionSlices(e.doc).find((p) => p.kind === 'auto' && x >= p.rect.x && y >= p.rect.y && x < p.rect.x + p.rect.width && y < p.rect.y + p.rect.height);
}
const handleCursor: Record<string, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

export function installSliceTools(_e: Editor) {
  registerTool({
    id: 'slice',
    label: 'Slice Tool',
    key: 'C',
    icon: 'slice',
    group: 'crop',
    cursor: () => 'crosshair',
    activate: (e) => e.overlay(),
    deactivate: (e) => {
      drag = undefined;
      e.overlay();
    },
    options: (e) => {
      const s = toolSettings;
      const sized = s.style !== 'normal';
      return `<label>Style <select id="slice-style"><option value="normal" ${s.style === 'normal' ? 'selected' : ''}>Normal</option><option value="ratio" ${s.style === 'ratio' ? 'selected' : ''}>Fixed Ratio</option><option value="size" ${s.style === 'size' ? 'selected' : ''}>Fixed Size</option></select></label>${
        sized
          ? `<label>W <input id="slice-w" type="number" min="1" max="8192" step="1" value="${s.width}"></label><label>H <input id="slice-h" type="number" min="1" max="8192" step="1" value="${s.height}"></label>`
          : ''
      }<span class="divider"></span><button data-command="slices.from-guides" ${e.doc.guides?.length ? '' : 'disabled'} title="Create a slice for each cell between the guides">Slices From Guides</button><button class="toggle" id="slice-hide-auto" aria-pressed="${sliceState.hideAuto}" title="Hide or show automatic slices">${svg(sliceState.hideAuto ? 'eye-off' : 'eye', 14)} Auto Slices</button><span class="hint">${s.style === 'size' ? 'Click to place a slice' : s.style === 'ratio' ? 'Drag to draw a slice with this ratio' : 'Drag to draw a slice; Shift draws a square'}</span>`;
    },
    bindOptions: ({ e, el }) => {
      el.querySelector<HTMLSelectElement>('#slice-style')?.addEventListener('change', (ev) => {
        toolSettings.style = (ev.target as HTMLSelectElement).value as Style;
        e.options();
      });
      const num = (id: string, key: 'width' | 'height') =>
        el.querySelector<HTMLInputElement>(id)?.addEventListener('change', (ev) => {
          const v = Math.round(Number((ev.target as HTMLInputElement).value));
          if (v >= 1) toolSettings[key] = Math.min(8192, v);
        });
      num('#slice-w', 'width');
      num('#slice-h', 'height');
      bindHideAuto(e, el);
    },
    pointerDown: (e, p) => {
      if (slicesLocked(e)) return;
      showSlices(e);
      drag = { kind: 'new', start: snapPoint(e, [p.x, p.y]) };
      if (toolSettings.style === 'size') drag.rect = drawnRect(e, drag.start, p);
      e.overlay();
    },
    pointerMove: (e, p) => {
      if (drag?.kind !== 'new') return;
      drag.rect = drawnRect(e, drag.start, p);
      e.overlay();
    },
    pointerUp: (e, p) => {
      if (drag?.kind !== 'new') return;
      const rect = drag.rect ?? drawnRect(e, drag.start, p);
      drag = undefined;
      if (rect.width >= 1 && rect.height >= 1) addSlice(e, rect);
      else e.overlay();
    },
  });
  registerTool({
    id: 'slice-select',
    label: 'Slice Select Tool',
    key: 'C',
    icon: 'slice-select',
    group: 'crop',
    cursor: () => 'default',
    activate: (e) => e.overlay(),
    deactivate: (e) => {
      drag = undefined;
      e.overlay();
    },
    options: (e) => {
      const sel = selectedSlices(e);
      const canPromote = !!sliceState.auto || sel.some((s) => s.layerId);
      return `<button data-command="slices.promote" ${canPromote ? '' : 'disabled'} title="Turn the selected automatic or layer-based slice into a user slice">Promote</button><button data-command="slices.delete" ${sel.length ? '' : 'disabled'} title="Delete the selected slices (Delete)">${svg('trash-2', 14)} Delete</button><button data-command="slices.options" ${sel.length === 1 ? '' : 'disabled'} title="Name and output format of the selected slice">Slice Options…</button><button data-command="slices.divide" ${sel.length === 1 && !sel[0].layerId ? '' : 'disabled'} title="Split the selected slice into equal parts">Divide…</button><span class="divider"></span><button class="toggle" id="slice-hide-auto" aria-pressed="${sliceState.hideAuto}" title="Hide or show automatic slices">${svg(sliceState.hideAuto ? 'eye-off' : 'eye', 14)} Auto Slices</button><span class="hint">${sel.length ? `${sel.length} slice${sel.length > 1 ? 's' : ''} selected` : sliceState.auto ? 'Automatic slice selected' : 'Click a slice to select it'}</span>`;
    },
    bindOptions: ({ e, el }) => bindHideAuto(e, el),
    hover: (e, p) => {
      const h = hitHandle(e, p);
      e.el('#viewport').style.cursor = h && !e.preferences.lockSlices ? handleCursor[h.handle] : '';
    },
    pointerDown: (e, p) => {
      showSlices(e);
      const h = !e.preferences.lockSlices ? hitHandle(e, p) : undefined;
      if (h) {
        drag = { kind: 'resize', id: h.id, handle: h.handle, rect: h.rect };
        return;
      }
      const s = sliceAt(e.doc, p.x, p.y);
      if (s) {
        sliceState.auto = undefined;
        if (p.shift) {
          if (sliceState.selected.has(s.id)) sliceState.selected.delete(s.id);
          else sliceState.selected.add(s.id);
        } else if (!sliceState.selected.has(s.id)) sliceState.selected = new Set([s.id]);
        const movable = selectedSlices(e).filter((x) => !x.layerId);
        if (sliceState.selected.has(s.id) && !s.layerId && !e.preferences.lockSlices)
          drag = { kind: 'move', start: [p.x, p.y], ids: movable.map((x) => x.id), rects: new Map(movable.map((x) => [x.id, sliceRect(e.doc, x)!])), moved: false };
      } else {
        if (!p.shift) sliceState.selected = new Set();
        const auto = autoPieceAt(e, p.x, p.y);
        sliceState.auto = auto && !p.shift ? { ...auto.rect } : undefined;
      }
      e.options();
      e.overlay();
    },
    pointerMove: (e, p) => {
      if (drag?.kind === 'move') {
        const d = drag;
        const dx = p.x - d.start[0],
          dy = p.y - d.start[1];
        if (!d.moved && Math.hypot(dx, dy) * e.zoom < 3) return;
        d.moved = true;
        const skip = new Set(d.ids);
        const first = (e.doc.slices ?? []).find((s) => s.id === d.ids[0]);
        const base = first ? sliceRect(e.doc, first)! : undefined;
        const snapped = base ? snapRect(e, { ...base, x: base.x + dx, y: base.y + dy }, skip) : undefined;
        const sx = snapped && base ? snapped.x - base.x : Math.round(dx),
          sy = snapped && base ? snapped.y - base.y : Math.round(dy);
        d.rects = new Map(d.ids.map((id) => {
          const s = (e.doc.slices ?? []).find((x) => x.id === id)!;
          const r = sliceRect(e.doc, s)!;
          return [id, { ...r, x: r.x + sx, y: r.y + sy }];
        }));
        e.overlay();
      } else if (drag?.kind === 'resize') {
        drag.draft = resized(drag.rect, drag.handle, snapPoint(e, [p.x, p.y], new Set([drag.id])));
        e.overlay();
      }
    },
    pointerUp: (e) => {
      const d = drag;
      drag = undefined;
      if (d?.kind === 'move' && d.moved) {
        const rects = new Map([...d.rects].map(([id, r]) => [id, clipRect(r, e.doc.width, e.doc.height)]));
        e.command(d.ids.length > 1 ? 'Move Slices' : 'Move Slice', (doc) => {
          doc.slices = (doc.slices ?? []).flatMap((s) => {
            if (!rects.has(s.id)) return [s];
            const r = rects.get(s.id);
            return r ? [{ ...s, rect: r }] : [];
          });
        });
      } else if (d?.kind === 'resize' && d.draft) {
        const r = clipRect(d.draft, e.doc.width, e.doc.height);
        if (r)
          e.command('Resize Slice', (doc) => {
            doc.slices = (doc.slices ?? []).map((s) => (s.id === d.id ? { ...s, rect: r } : s));
          });
      }
      e.overlay();
    },
    doubleClick: (e, p) => {
      const s = sliceAt(e.doc, p.x, p.y);
      if (s) {
        sliceState.selected = new Set([s.id]);
        void e.runCommand('slices.options');
      } else if (autoPieceAt(e, p.x, p.y)) e.message('Promote the automatic slice to set its options.');
    },
    keyDown: (e, ev) => {
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && !ev.metaKey && !ev.ctrlKey && sliceState.selected.size) {
        void e.runCommand('slices.delete');
        return true;
      }
      if (ev.key === 'Escape' && (sliceState.selected.size || sliceState.auto)) {
        sliceState.selected = new Set();
        sliceState.auto = undefined;
        e.options();
        e.overlay();
        return true;
      }
      return false;
    },
  });
}
function bindHideAuto(e: Editor, el: HTMLElement) {
  el.querySelector('#slice-hide-auto')?.addEventListener('click', () => {
    sliceState.hideAuto = !sliceState.hideAuto;
    e.options();
    e.overlay();
  });
}
