// Artboards: the Artboard tool (shares the Move slot), commands to create
// artboards, on-canvas names and "+" buttons, the pasteboard around artboards,
// automatic nesting of layers moved across artboards, and exporting.
import { artboardConflict } from '../../model/video-timeline';
import type { Editor } from '../../editor';
import { contributeMenu, registerCommand, registerOverlay, registerTool } from '../../app/registry';
import type { CanvasPointer } from '../../app/pointer';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { allLayers, findLayer, type PhotoDocument, type Rect } from '../../model/document';
import {
  artboardAt,
  artboardFromLayers,
  artboardGap,
  artboardLayers,
  artboardOf,
  artboardPresets,
  besideRect,
  canvasGrowth,
  createArtboard,
  dragRect,
  expandCanvasToArtboards,
  hasArtboards,
  isArtboard,
  matchingPreset,
  nestIntoArtboards,
  newArtboardRect,
  presetById,
  type ArtboardBackground,
  type ArtboardLayer,
} from '../../model/artboard';
import { frameAt } from '../../model/frame';
import { closestSnap, handles, snapTargets, snapTranslation, transformSelection, type ResizeHandle } from '../../model/transform';
import { layerLock } from '../../model/locks';
import { layerMoveHooks, pickFallbacks } from '../../ui/transform';
import { formDialog } from '../../ui/dialog';
import { lazy } from '../../app/lazy';

// Exporting pages loads on first use.
const pageExport = lazy(() => import('./page-export'));
import { installArtboardProperties } from './artboard-properties';

type Side = 'left' | 'right' | 'top' | 'bottom';
type Drag =
  | { kind: 'create'; start: [number, number]; rect: Rect }
  | { kind: 'move'; id: string; start: [number, number]; rect: Rect; before: PhotoDocument; draft?: PhotoDocument }
  | { kind: 'resize'; id: string; handle: ResizeHandle; start: [number, number]; rect: Rect; draft?: PhotoDocument };
let drag: Drag | undefined;

export const backgroundOptions: [ArtboardBackground, string][] = [
  ['white', 'White'],
  ['black', 'Black'],
  ['transparent', 'Transparent'],
  ['custom', 'Custom color'],
];

/** The selected artboard, or the artboard containing the selected layer. */
export function currentArtboard(e: Editor): ArtboardLayer | undefined {
  const l = e.layer;
  if (isArtboard(l)) return l;
  return l ? artboardOf(e.doc, l.id) : undefined;
}
function selectedArtboard(e: Editor) {
  const l = e.layer;
  return e.selectedIds.size === 1 && isArtboard(l) ? l : undefined;
}

/** Grow the canvas to fit every artboard as part of the edit being recorded. */
export function fitCanvas(doc: PhotoDocument) {
  expandCanvasToArtboards(doc);
}
/** One undoable layout edit that keeps the canvas around every artboard. */
export function layoutCommand(e: Editor, label: string, edit: (d: PhotoDocument) => void) {
  try {
    e.command(label, (d) => {
      edit(d);
      fitCanvas(d);
    });
  } catch (error) {
    canvasGrowth.pending = undefined;
    e.message((error as Error).message);
  }
}
function applyPendingShift(e: Editor) {
  const s = canvasGrowth.pending;
  if (!s) return;
  canvasGrowth.pending = undefined;
  e.pan = { x: e.pan.x + (s.dw / 2 - s.dx) * e.zoom, y: e.pan.y + (s.dh / 2 - s.dy) * e.zoom };
  e.view();
  e.overlay();
}

/** Zoom and center the view on a document rectangle. */
export function fitRectOnScreen(e: Editor, r: Rect) {
  const v = e.el('#viewport');
  const w = v.clientWidth || 800,
    h = v.clientHeight || 600;
  e.zoom = Math.max(0.01, Math.min(64, (w - 80) / r.width, (h - 80) / r.height));
  e.pan = { x: (e.doc.width / 2 - (r.x + r.width / 2)) * e.zoom, y: (e.doc.height / 2 - (r.y + r.height / 2)) * e.zoom };
  e.view();
  e.overlay();
  e.update();
}

function addArtboard(e: Editor, rect: Rect, select = true, data: Partial<ArtboardLayer['artboard']> = {}) {
  let id = '';
  layoutCommand(e, 'New Artboard', (d) => {
    const a = createArtboard(d, rect, { background: defaultBackground(e), ...data });
    id = a.id;
    d.layers.push(a);
  });
  if (select && id && findLayer(e.doc.layers, id)) {
    e.selectLayers([id]);
    e.update();
  }
}
function addBeside(e: Editor, id: string, side: Side) {
  const a = findLayer(e.doc.layers, id);
  if (!isArtboard(a)) return;
  const rect = besideRect(e.doc, a.artboard.rect, side);
  addArtboard(e, rect, true, { background: a.artboard.background, color: a.artboard.color, clip: a.artboard.clip, preset: a.artboard.preset });
}
const defaultBackground = (e: Editor) => (e.settings.artboardBackground as ArtboardBackground | undefined) ?? 'white';
function defaultSize(e: Editor): { width: number; height: number; preset?: string } {
  return (e.settings.artboardSize as { width: number; height: number; preset?: string } | undefined) ?? { width: 390, height: 844, preset: 'phone' };
}

// ----- Artboard tool -----
const handleCursor: Record<ResizeHandle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
function snapThreshold(e: Editor) {
  return 6 / e.zoom;
}
function pointerDown(e: Editor, p: CanvasPointer) {
  const target = p.event.target as Element;
  const handle = target.closest?.('[data-artboard-handle]')?.getAttribute('data-artboard-handle') as ResizeHandle | null;
  const sel = selectedArtboard(e);
  if (handle && sel) {
    if (layerLock(e.doc.layers, sel.id, 'position')) return void e.message('Unlock the artboard to resize it.');
    drag = { kind: 'resize', id: sel.id, handle, start: [p.x, p.y], rect: { ...sel.artboard.rect } };
    return;
  }
  const hit = artboardAt(e.doc, p.x, p.y);
  if (hit) {
    if (!e.selectedIds.has(hit.id) || e.selectedIds.size > 1) {
      e.selectLayers([hit.id]);
      e.update();
    }
    if (layerLock(e.doc.layers, hit.id, 'position')) return;
    drag = { kind: 'move', id: hit.id, start: [p.x, p.y], rect: { ...hit.artboard.rect }, before: e.doc };
    return;
  }
  drag = { kind: 'create', start: [p.x, p.y], rect: dragRect([p.x, p.y], [p.x, p.y]) };
}
function snapRectMove(e: Editor, doc: PhotoDocument, id: string, r: Rect) {
  if (!e.transform.snapping) return r;
  const a = findLayer(doc.layers, id);
  const targets = snapTargets(doc, a ? [a] : []);
  const t = snapTranslation({ ...r, rotation: 0 }, targets, snapThreshold(e)).transform;
  return { ...r, x: Math.round(t.x), y: Math.round(t.y) };
}
function snapValue(e: Editor, v: number, list: number[]) {
  if (!e.transform.snapping) return v;
  return closestSnap([v], list, snapThreshold(e))?.target ?? v;
}
function pointerMove(e: Editor, p: CanvasPointer) {
  if (!drag) return;
  const dx = p.x - drag.start[0],
    dy = p.y - drag.start[1];
  if (drag.kind === 'create') {
    const targets = snapTargets(e.doc, []);
    let end: [number, number] = [snapValue(e, p.x, targets.x), snapValue(e, p.y, targets.y)];
    const start: [number, number] = [snapValue(e, drag.start[0], targets.x), snapValue(e, drag.start[1], targets.y)];
    if (p.shift) {
      const side = Math.max(Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]));
      end = [start[0] + Math.sign(end[0] - start[0] || 1) * side, start[1] + Math.sign(end[1] - start[1] || 1) * side];
    }
    drag.rect = dragRect(start, end);
    e.overlay();
    return;
  }
  if (drag.kind === 'move') {
    const moved = snapRectMove(e, drag.before, drag.id, { ...drag.rect, x: Math.round(drag.rect.x + dx), y: Math.round(drag.rect.y + dy) });
    const draft = structuredClone(drag.before);
    shiftArtboard(draft, drag.id, moved.x - drag.rect.x, moved.y - drag.rect.y);
    drag.draft = draft;
    e.preview(draft);
    e.overlay(draft);
    return;
  }
  const [sx, sy] = handles[drag.handle];
  const r = drag.rect;
  const targets = snapTargets(e.doc, findLayer(e.doc.layers, drag.id) ? [findLayer(e.doc.layers, drag.id)!] : []);
  let x0 = r.x,
    y0 = r.y,
    x1 = r.x + r.width,
    y1 = r.y + r.height;
  if (sx < 0) x0 = Math.min(x1 - 1, Math.round(snapValue(e, r.x + dx, targets.x)));
  if (sx > 0) x1 = Math.max(x0 + 1, Math.round(snapValue(e, x1 + dx, targets.x)));
  if (sy < 0) y0 = Math.min(y1 - 1, Math.round(snapValue(e, r.y + dy, targets.y)));
  if (sy > 0) y1 = Math.max(y0 + 1, Math.round(snapValue(e, y1 + dy, targets.y)));
  const draft = structuredClone(e.doc);
  const a = findLayer(draft.layers, drag.id);
  if (isArtboard(a)) {
    a.artboard.rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    a.artboard.preset = matchingPreset(x1 - x0, y1 - y0, a.artboard.preset)?.id;
  }
  drag.draft = draft;
  e.preview(draft);
  e.overlay(draft);
}
/** Translate an artboard and everything in it by whole pixels. */
export function shiftArtboard(doc: PhotoDocument, id: string, dx: number, dy: number) {
  const a = findLayer(doc.layers, id);
  if (!isArtboard(a) || (!dx && !dy)) return;
  const frame = { ...a.artboard.rect, rotation: 0 };
  transformSelection([a], frame, { ...frame, x: frame.x + dx, y: frame.y + dy });
}
function pointerUp(e: Editor) {
  const d = drag;
  drag = undefined;
  if (!d) return;
  if (d.kind === 'create') {
    e.overlay();
    if (d.rect.width < 4 || d.rect.height < 4) return;
    addArtboard(e, d.rect, true, { preset: matchingPreset(d.rect.width, d.rect.height)?.id });
    return;
  }
  if (!d.draft) return;
  const draft = d.draft;
  layoutCommand(e, d.kind === 'move' ? 'Move Artboard' : 'Resize Artboard', (doc) => {
    Object.assign(doc, draft);
    // Layers now outside a resized artboard move out of it; layers it now covers move in.
    if (d.kind === 'resize') nestIntoArtboards(doc, allLayers(doc.layers).filter((l) => !l.artboard).map((l) => l.id));
  });
}

function toolOptions(e: Editor) {
  const a = selectedArtboard(e);
  const size = a ? { width: a.artboard.rect.width, height: a.artboard.rect.height, preset: a.artboard.preset } : defaultSize(e);
  const preset = matchingPreset(size.width, size.height, size.preset);
  const categories = [...new Set(artboardPresets.map((p) => p.category))];
  const options = categories
    .map((c) => `<optgroup label="${escapeXML(c)}">${artboardPresets.filter((p) => p.category === c).map((p) => `<option value="${p.id}" ${preset?.id === p.id ? 'selected' : ''}>${escapeXML(p.name)} (${p.width} × ${p.height})</option>`).join('')}</optgroup>`)
    .join('');
  const bg = a ? a.artboard.background : defaultBackground(e);
  return `<label>Size <select id="artboard-preset" aria-label="Artboard size preset"><option value="" ${preset ? '' : 'selected'}>Custom</option>${options}</select></label>
<label>W <input id="artboard-w" type="number" min="1" max="8192" step="1" value="${size.width}" aria-label="Artboard width"></label><button class="icon-button" id="artboard-swap" title="Swap width and height (orientation)" aria-label="Swap width and height">${svg('arrow-left-right', 14)}</button><label>H <input id="artboard-h" type="number" min="1" max="8192" step="1" value="${size.height}" aria-label="Artboard height"></label>
<label>Background <select id="artboard-bg">${backgroundOptions.map(([v, l]) => `<option value="${v}" ${bg === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
<span class="divider"></span><button id="artboard-add" title="${a ? 'Add an artboard to the right of the selected one' : 'Add an artboard of this size'}">${svg('plus', 14)} Add Artboard</button>
<span class="hint">${a ? escapeXML(a.name) : 'Drag on the canvas to draw an artboard'}</span>`;
}
function bindToolOptions(e: Editor, el: HTMLElement) {
  const apply = (width: number, height: number, preset?: string) => {
    width = Math.max(1, Math.min(8192, Math.round(width)));
    height = Math.max(1, Math.min(8192, Math.round(height)));
    const a = selectedArtboard(e);
    if (a) resizeArtboard(e, a.id, { ...a.artboard.rect, width, height }, preset);
    else e.settings.artboardSize = { width, height, preset };
    e.options();
  };
  el.querySelector<HTMLSelectElement>('#artboard-preset')?.addEventListener('change', (ev) => {
    const p = presetById((ev.target as HTMLSelectElement).value);
    if (p) apply(p.width, p.height, p.id);
  });
  const w = el.querySelector<HTMLInputElement>('#artboard-w')!,
    h = el.querySelector<HTMLInputElement>('#artboard-h')!;
  const fields = () => apply(Number(w.value) || 1, Number(h.value) || 1);
  w?.addEventListener('change', fields);
  h?.addEventListener('change', fields);
  el.querySelector('#artboard-swap')?.addEventListener('click', () => apply(Number(h.value) || 1, Number(w.value) || 1, matchingPreset(Number(h.value), Number(w.value))?.id));
  el.querySelector<HTMLSelectElement>('#artboard-bg')?.addEventListener('change', (ev) => {
    const value = (ev.target as HTMLSelectElement).value as ArtboardBackground;
    const a = selectedArtboard(e);
    if (a)
      setArtboard(e, a.id, 'Artboard Background', (x) => {
        x.artboard.background = value;
        if (value === 'custom') x.artboard.color ??= e.color;
      });
    else e.settings.artboardBackground = value;
  });
  el.querySelector('#artboard-add')?.addEventListener('click', () => {
    const a = selectedArtboard(e);
    if (a) addBeside(e, a.id, 'right');
    else {
      const s = defaultSize(e);
      addArtboard(e, newArtboardRect(e.doc, s.width, s.height), true, { preset: s.preset });
    }
  });
}

export function resizeArtboard(e: Editor, id: string, rect: Rect, preset?: string) {
  layoutCommand(e, 'Resize Artboard', (d) => {
    const a = findLayer(d.layers, id);
    if (!isArtboard(a)) return;
    a.artboard.rect = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
    a.artboard.preset = matchingPreset(a.artboard.rect.width, a.artboard.rect.height, preset)?.id;
  });
}
export function setArtboard(e: Editor, id: string, label: string, edit: (a: ArtboardLayer) => void) {
  layoutCommand(e, label, (d) => {
    const a = findLayer(d.layers, id);
    if (isArtboard(a)) edit(a);
  });
}

// ----- Overlays and pasteboard -----
function artboardOverlay(e: Editor) {
  if (!e.hasDocument) return '';
  const doc = e.displayDoc;
  const z = e.zoom;
  const list = artboardLayers(doc);
  let html = '';
  const names = e.preferences.showArtboardNames !== false && !e.settings.extrasHidden;
  const selected = new Set(e.selectedIds);
  const toolActive = e.tool === 'artboard';
  for (const a of list) {
    const r = a.artboard.rect;
    const active = selected.has(a.id);
    if (!a.visible) html += `<rect class="artboard-hidden" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" stroke-width="${1 / z}" stroke-dasharray="${4 / z} ${3 / z}"/>`;
    if (active || toolActive)
      html += `<rect class="artboard-outline ${active ? 'active' : ''}" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" stroke-width="${(active ? 1.5 : 1) / z}"/>`;
    if (names) {
      const label = `${a.name}`;
      html += `<text class="artboard-name canvas-ui ${active ? 'active' : ''}" data-artboard-name="${a.id}" x="${r.x}" y="${r.y - 6 / z}" font-size="${12 / z}" stroke-width="${3 / z}">${escapeXML(label)}</text>`;
    }
  }
  const sel = toolActive ? selectedArtboard(e) : undefined;
  const live = sel && drag?.kind !== 'create' ? (findLayer(doc.layers, sel.id) as ArtboardLayer | undefined) : undefined;
  if (live && isArtboard(live)) {
    const r = live.artboard.rect;
    for (const [handle, [hx, hy]] of Object.entries(handles)) {
      const cx = r.x + ((hx + 1) / 2) * r.width,
        cy = r.y + ((hy + 1) / 2) * r.height;
      html += `<g class="transform-handle" data-artboard-handle="${handle}" style="cursor:${handleCursor[handle as ResizeHandle]}"><circle class="handle-hit" cx="${cx}" cy="${cy}" r="${9 / z}"/><rect x="${cx - 3.5 / z}" y="${cy - 3.5 / z}" width="${7 / z}" height="${7 / z}" stroke-width="${1 / z}"/></g>`;
    }
    if (!drag) {
      const off = Math.min(artboardGap(r) / 2, 28 / z);
      const sides: [Side, number, number][] = [
        ['top', r.x + r.width / 2, r.y - off],
        ['right', r.x + r.width + off, r.y + r.height / 2],
        ['bottom', r.x + r.width / 2, r.y + r.height + off],
        ['left', r.x - off, r.y + r.height / 2],
      ];
      for (const [side, cx, cy] of sides)
        html += `<g class="artboard-add canvas-ui" data-artboard-add="${side}" data-artboard-id="${live.id}"><title>Add an artboard ${side === 'top' ? 'above' : side === 'bottom' ? 'below' : `to the ${side}`}</title><circle cx="${cx}" cy="${cy}" r="${9 / z}" stroke-width="${1 / z}"/><path d="M${cx - 4 / z} ${cy}h${8 / z}M${cx} ${cy - 4 / z}v${8 / z}" stroke-width="${1.5 / z}"/></g>`;
    }
  }
  if (drag?.kind === 'create' && toolActive) {
    const r = drag.rect;
    html += `<rect class="artboard-outline active" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" stroke-width="${1.5 / z}"/><text class="artboard-size" x="${r.x + r.width}" y="${r.y + r.height + 16 / z}" font-size="${11 / z}" text-anchor="end">${r.width} × ${r.height}</text>`;
  }
  return html;
}
let underlay: SVGSVGElement | undefined;
function updatePasteboard(e: Editor) {
  const stage = e.el('#stage');
  const doc = e.displayDoc;
  const on = e.hasDocument && hasArtboards(doc);
  stage.classList.toggle('has-artboards', on);
  if (!on) {
    if (underlay) underlay.innerHTML = '';
    return;
  }
  if (!underlay || !underlay.isConnected) {
    underlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    underlay.id = 'artboard-underlay';
    underlay.setAttribute('aria-hidden', 'true');
    stage.prepend(underlay);
  }
  underlay.setAttribute('viewBox', `0 0 ${doc.width} ${doc.height}`);
  // Transparent artboards show the checkerboard (the same 20 px period as the
  // canvas background); the rest of the canvas is pasteboard.
  const size = 10;
  let html = `<defs><pattern id="artboard-checker" width="${size * 2}" height="${size * 2}" patternUnits="userSpaceOnUse"><rect width="${size * 2}" height="${size * 2}" class="checker-a"/><rect width="${size}" height="${size}" class="checker-b"/><rect x="${size}" y="${size}" width="${size}" height="${size}" class="checker-b"/></pattern></defs>`;
  for (const a of artboardLayers(doc)) {
    if (!a.visible) continue;
    const r = a.artboard.rect;
    html += `<rect class="artboard-shadow" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}"/>`;
    html += `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="url(#artboard-checker)"/>`;
  }
  underlay.innerHTML = html;
}

function bindCanvasUi(e: Editor) {
  const viewport = e.el('#viewport');
  viewport.addEventListener(
    'pointerdown',
    (ev) => {
      if (ev.button !== 0 || e.busy) return;
      const t = ev.target as Element;
      const add = t.closest?.('[data-artboard-add]');
      if (add) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        addBeside(e, add.getAttribute('data-artboard-id')!, add.getAttribute('data-artboard-add') as Side);
        return;
      }
      const name = t.closest?.('[data-artboard-name]');
      if (name && (e.tool === 'move' || e.tool === 'artboard')) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        const id = name.getAttribute('data-artboard-name')!;
        e.selectLayers([id]);
        e.update();
        startNameDrag(e, id, ev);
      }
    },
    true,
  );
  viewport.addEventListener(
    'dblclick',
    (ev) => {
      const name = (ev.target as Element).closest?.('[data-artboard-name]');
      if (!name) return;
      ev.stopImmediatePropagation();
      void renameArtboard(e, name.getAttribute('data-artboard-name')!);
    },
    true,
  );
}
// Dragging an artboard by its name works with the Move and Artboard tools.
function startNameDrag(e: Editor, id: string, ev: PointerEvent) {
  const a = findLayer(e.doc.layers, id);
  if (!isArtboard(a) || layerLock(e.doc.layers, id, 'position')) return;
  const start = e.docPoint(ev.clientX, ev.clientY);
  const before = e.doc;
  let draft: PhotoDocument | undefined;
  const move = (m: PointerEvent) => {
    if (m.pointerId !== ev.pointerId) return;
    const p = e.docPoint(m.clientX, m.clientY);
    const r = snapRectMove(e, before, id, { ...a.artboard.rect, x: Math.round(a.artboard.rect.x + p[0] - start[0]), y: Math.round(a.artboard.rect.y + p[1] - start[1]) });
    draft = structuredClone(before);
    shiftArtboard(draft, id, r.x - a.artboard.rect.x, r.y - a.artboard.rect.y);
    e.preview(draft);
    e.overlay(draft);
  };
  const up = (u: PointerEvent) => {
    if (u.pointerId !== ev.pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (draft && e.doc === before) {
      const d = draft;
      layoutCommand(e, 'Move Artboard', (doc) => Object.assign(doc, d));
    } else e.update();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
async function renameArtboard(e: Editor, id: string) {
  const a = findLayer(e.doc.layers, id);
  if (!a) return;
  const v = await formDialog('Rename Artboard', [{ name: 'name', label: 'Name', value: a.name }], 'Rename');
  if (v?.name) e.command('Rename Artboard', (d) => (findLayer(d.layers, id)!.name = v.name));
}

// ----- Commands -----
function presetFieldOptions(): [string, string][] {
  return [['', 'Custom'], ...artboardPresets.map((p): [string, string] => [p.id, `${p.category}: ${p.name} (${p.width} × ${p.height})`])];
}
async function newArtboardDialog(e: Editor) {
  if (e.doc.timeline) throw new Error(artboardConflict);
  const s = defaultSize(e);
  const used = new Set(artboardLayers(e.doc).map((a) => a.name));
  let n = artboardLayers(e.doc).length + 1;
  while (used.has(`Artboard ${n}`)) n++;
  const pending = formDialog(
    'New Artboard',
    [
      { name: 'name', label: 'Name', value: `Artboard ${n}` },
      { name: 'preset', label: 'Size preset', value: matchingPreset(s.width, s.height, s.preset)?.id ?? '', type: 'select', options: presetFieldOptions() },
      { name: 'width', label: 'Width (px)', value: s.width, type: 'number', min: 1, max: 8192, step: 1 },
      { name: 'height', label: 'Height (px)', value: s.height, type: 'number', min: 1, max: 8192, step: 1 },
      { name: 'background', label: 'Background', value: defaultBackground(e), type: 'select', options: backgroundOptions },
    ],
    'Create',
    'The artboard is placed beside the existing ones.',
  );
  // A preset fills in the size; typing a size that matches no preset shows Custom.
  const form = document.querySelector<HTMLFormElement>('#dialog form');
  const field = (name: string) => form?.querySelector<HTMLInputElement & HTMLSelectElement>(`[name="${name}"]`);
  field('preset')?.addEventListener('change', () => {
    const p = presetById(field('preset')!.value);
    if (!p) return;
    field('width')!.value = String(p.width);
    field('height')!.value = String(p.height);
  });
  for (const name of ['width', 'height'])
    field(name)?.addEventListener('input', () => (field('preset')!.value = matchingPreset(Number(field('width')!.value), Number(field('height')!.value), field('preset')!.value)?.id ?? ''));
  const v = await pending;
  if (!v) return;
  const width = Math.round(Number(v.width)),
    height = Math.round(Number(v.height));
  if (!(width >= 1 && height >= 1 && width <= 8192 && height <= 8192)) return void e.message('Use sizes from 1 to 8192 pixels.');
  e.settings.artboardSize = { width, height, preset: matchingPreset(width, height, v.preset)?.id };
  let id = '';
  layoutCommand(e, 'New Artboard', (d) => {
    const a = createArtboard(d, newArtboardRect(d, width, height), { background: v.background as ArtboardBackground, preset: matchingPreset(width, height, v.preset)?.id, ...(v.background === 'custom' ? { color: e.color } : {}) }, v.name || undefined);
    id = a.id;
    d.layers.push(a);
  });
  if (id && findLayer(e.doc.layers, id)) {
    e.selectLayers([id]);
    e.update();
    const a = findLayer(e.doc.layers, id) as ArtboardLayer;
    if (artboardLayers(e.doc).length === 1) fitRectOnScreen(e, a.artboard.rect);
  }
}
const topLevelSelection = (e: Editor) => e.selectedIds.size > 0 && [...e.selectedIds].every((id) => e.doc.layers.some((l) => l.id === id && !l.artboard));
async function fromLayers(e: Editor, group: boolean) {
  if (e.doc.timeline) throw new Error(artboardConflict);
  let name = '';
  if (!group) {
    const v = await formDialog('Artboard from Layers', [{ name: 'name', label: 'Name', value: `Artboard ${artboardLayers(e.doc).length + 1}` }], 'Create');
    if (!v) return;
    name = v.name;
  }
  const ids = new Set(e.selectedIds);
  let id = '';
  layoutCommand(e, group ? 'Artboard from Group' : 'Artboard from Layers', (d) => {
    id = artboardFromLayers(d, ids, group);
    if (name) findLayer(d.layers, id)!.name = name;
  });
  if (id && findLayer(e.doc.layers, id)) {
    e.selectLayers([id]);
    e.update();
  }
}
const artboardPages = (e: Editor, m: typeof import('./page-export')) =>
  artboardLayers(e.doc)
    .filter((a) => a.visible)
    .map((a) => ({ name: a.name, doc: m.artboardDocument(e.doc, a) }));

export function installArtboards(e: Editor) {
  registerTool({
    id: 'artboard',
    label: 'Artboard Tool',
    key: 'V',
    icon: 'artboard',
    group: 'move',
    cursor: () => 'crosshair',
    options: toolOptions,
    bindOptions: ({ e, el }) => bindToolOptions(e, el),
    pointerDown,
    pointerMove,
    pointerUp,
    deactivate: () => (drag = undefined),
  });
  registerCommand(
    { id: 'layer.new-artboard', label: 'Artboard…', run: (e) => newArtboardDialog(e), enabled: (e) => e.hasDocument, description: 'Add an artboard with a preset or custom size' },
    { id: 'layer.artboard-from-group', label: 'Artboard from Group', run: (e) => fromLayers(e, true), enabled: (e) => e.selectedIds.size === 1 && topLevelSelection(e) && e.layer?.kind === 'group' && !e.layer.frame },
    { id: 'layer.artboard-from-layers', label: 'Artboard from Layers…', run: (e) => fromLayers(e, false), enabled: topLevelSelection },
    {
      id: 'view.fit-artboard',
      label: 'Fit Artboard on Screen',
      run: (e) => {
        const a = currentArtboard(e) ?? artboardLayers(e.doc)[0];
        if (a) fitRectOnScreen(e, a.artboard.rect);
      },
      enabled: (e) => e.hasDocument && hasArtboards(e.doc),
      recordable: false,
    },
    {
      id: 'view.show-artboard-names',
      label: 'Artboard Names',
      checked: (e) => e.preferences.showArtboardNames !== false,
      run: (e) => {
        e.preferences.showArtboardNames = e.preferences.showArtboardNames === false;
        e.savePreferences();
        e.overlay();
      },
      recordable: false,
    },
    {
      id: 'file.export-artboards-files',
      label: 'Artboards to Files…',
      run: async (e) => {
        const m = await pageExport();
        await m.exportPagesToFiles(e, { title: 'Export Artboards to Files', noun: 'artboard', pages: artboardPages(e, m), base: e.doc.name });
      },
      prefetch: pageExport.prefetch,
      enabled: (e) => e.hasDocument && hasArtboards(e.doc),
      recordable: false,
      description: 'Save each visible artboard as an image',
    },
    {
      id: 'file.export-artboards-pdf',
      label: 'Artboards to PDF…',
      run: async (e) => {
        const m = await pageExport();
        await m.exportPagesToPdf(e, { title: 'Export Artboards to PDF', noun: 'artboard', pages: artboardPages(e, m), base: e.doc.name });
      },
      prefetch: pageExport.prefetch,
      enabled: (e) => e.hasDocument && hasArtboards(e.doc),
      recordable: false,
      description: 'Save the visible artboards as pages of one PDF',
    },
  );
  contributeMenu('layer.new-menu', ['layer.new-artboard', 'layer.artboard-from-group', 'layer.artboard-from-layers'], 'layer.group-from-layers');
  contributeMenu('view', ['view.fit-artboard'], 'view.fill');
  contributeMenu('view.show', ['view.show-artboard-names'], 'view.show-artboard-guides');
  registerOverlay('artboards', artboardOverlay);
  // Layers dropped onto another artboard join it; artboards grow the canvas.
  layerMoveHooks.push((doc, ids) => {
    nestIntoArtboards(doc, ids);
    fitCanvas(doc);
  });
  pickFallbacks.push((doc, x, y) => {
    const f = frameAt(doc, x, y);
    if (f && !f.children.length) return f;
    return artboardAt(doc, x, y);
  });
  e.onUpdate((e) => {
    applyPendingShift(e);
    updatePasteboard(e);
  });
  bindCanvasUi(e);
  installArtboardProperties(e);
}
