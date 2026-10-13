// Guides: dragging them from the rulers and with the Move tool, selecting,
// editing and clearing them, and the View > Guides and View > Show commands.
// Canvas guides span the canvas; artboard guides belong to one artboard and
// move with it (model/guides.ts). A guide dropped on an artboard becomes one
// of its guides, anywhere else a canvas guide.
import type { Editor } from '../editor';
import { registerCommand, registerOverlay } from '../app/registry';
import { findLayer, type Guide, type Layer, type PhotoDocument, type Rect } from '../model/document';
import {
  artboardAt,
  guideKey,
  mergeGuides,
  ownerGuides,
  parseGuideKey,
  placedGuides,
  rectGuides,
  removeGuides,
  setOwnerGuides,
  toArtboard,
  type GuideOwner,
} from '../model/guides';
import type { Preferences } from '../model/preferences';
import { formDialog } from '../ui/dialog';
import { extraHidden } from './view-extras';

const isArtboardLayer = (l: Layer | undefined): l is Layer & { artboard: NonNullable<Layer['artboard']> } => !!l?.artboard && l.kind === 'group';
const artboardsOf = (doc: Pick<PhotoDocument, 'layers'>) => doc.layers.filter(isArtboardLayer);
const sameOwner = (a: GuideOwner, b: GuideOwner) => (a === 'canvas' ? b === 'canvas' : b !== 'canvas' && a.artboard === b.artboard);

// ----- Visibility -----
export const canvasGuidesShown = (e: Editor) => e.preferences.showCanvasGuides !== false;
export const artboardGuidesShown = (e: Editor) => e.preferences.showArtboardGuides !== false;
type GuidePrefs = Pick<Preferences, 'showGuides' | 'showCanvasGuides' | 'showArtboardGuides'>;
/** View → Show → Guides. Guides are never shown with both kinds hidden:
 * showing them then shows both kinds. */
export function setGuidesShown(p: GuidePrefs, on: boolean) {
  p.showGuides = on;
  if (on && p.showCanvasGuides === false && p.showArtboardGuides === false) p.showCanvasGuides = p.showArtboardGuides = true;
}
/** View → Show → Canvas Guides / Artboard Guides, as the menu shows them:
 * while guides are hidden both appear unchecked, so choosing one shows guides
 * with that kind. Hiding the last shown kind hides guides. */
export function toggleGuideKind(p: GuidePrefs, key: 'showCanvasGuides' | 'showArtboardGuides') {
  if (!p.showGuides) {
    p.showGuides = true;
    p[key] = true;
    return;
  }
  p[key] = p[key] === false;
  if (p.showCanvasGuides === false && p.showArtboardGuides === false) p.showGuides = false;
}
function guidesVisible(e: Editor) {
  return e.hasDocument && e.preferences.showGuides && !extraHidden(e, 'guides');
}

// ----- Selection -----
// Selected guides are keys into specific guide lists; an edit that replaces a
// list drops the selection of its guides unless the edit carries it over.
let selection: { keys: Set<string>; lists: Map<string, Guide[]> } = { keys: new Set(), lists: new Map() };
const ownerId = (o: GuideOwner) => (o === 'canvas' ? 'canvas' : o.artboard);
export function selectedGuides(e: Editor): Set<string> {
  const out = new Set<string>();
  if (!e.hasDocument) return out;
  for (const k of selection.keys) {
    const p = parseGuideKey(k);
    if (!p) continue;
    const list = ownerGuides(e.doc, p.owner);
    if (list.length && selection.lists.get(ownerId(p.owner)) === list && p.index < list.length) out.add(k);
  }
  return out;
}
export function selectGuides(e: Editor, keys: Iterable<string>) {
  const set = new Set(keys);
  const lists = new Map<string, Guide[]>();
  for (const k of set) {
    const p = parseGuideKey(k);
    if (p) lists.set(ownerId(p.owner), ownerGuides(e.doc, p.owner));
  }
  selection = { keys: set, lists };
  e.overlay();
}

// ----- Dragging -----
type Drag = {
  pointer: number;
  orientation: Guide['orientation'];
  // The guide being moved (absent for a new guide pulled from a ruler).
  source?: { owner: GuideOwner; index: number };
  key?: string;
  // Current position (document coordinates) and the pointer's document point.
  position: number;
  at: [number, number];
  start: [number, number];
  moved: boolean;
  shift: boolean;
};
let drag: Drag | undefined;
export const guideDragActive = () => !!drag;

/** Where a guide dropped at a document point is stored. */
function dropOwner(doc: PhotoDocument, at: [number, number]): GuideOwner {
  const a = artboardAt(doc, at[0], at[1]);
  return a ? { artboard: a.id } : 'canvas';
}
function ownerRect(doc: PhotoDocument, owner: GuideOwner): Rect | undefined {
  return owner === 'canvas' ? undefined : artboardsOf(doc).find((a) => a.id === owner.artboard)?.artboard.rect;
}

function bindGuides(e: Editor) {
  const viewport = e.el('#viewport');
  const begin = (orientation: Guide['orientation'], ev: PointerEvent, key?: string) => {
    if (!e.hasDocument || e.preferences.guidesLocked) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const at = e.docPoint(ev.clientX, ev.clientY) as [number, number];
    const source = key ? parseGuideKey(key) : undefined;
    const existing = source && placedGuides(e.doc).find((g) => g.key === key);
    drag = {
      pointer: ev.pointerId,
      orientation,
      source,
      key,
      position: existing ? existing.position : Math.round(orientation === 'vertical' ? at[0] : at[1]),
      at,
      start: [ev.clientX, ev.clientY],
      moved: !source,
      shift: ev.shiftKey,
    };
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    document.body.classList.add(orientation === 'vertical' ? 'dragging-vguide' : 'dragging-hguide');
    e.overlay();
  };
  e.el('#ruler-x').addEventListener('pointerdown', (ev) => begin('horizontal', ev));
  e.el('#ruler-y').addEventListener('pointerdown', (ev) => begin('vertical', ev));
  // Existing guides are dragged with the Move tool (capture phase, before the tool sees the event).
  viewport.addEventListener(
    'pointerdown',
    (ev) => {
      const hit = (ev.target as Element).closest?.('[data-guide]');
      if (e.tool !== 'move' || ev.button !== 0) return;
      // Clicking anything else with the Move tool deselects guides.
      if (!hit) {
        if (selectedGuides(e).size && !ev.shiftKey) selectGuides(e, []);
        return;
      }
      const key = hit.getAttribute('data-guide')!;
      const g = placedGuides(e.doc).find((p) => p.key === key);
      if (g) begin(g.orientation, ev, key);
    },
    true,
  );
  const finish = () => {
    drag = undefined;
    document.body.classList.remove('dragging-vguide', 'dragging-hguide');
  };
  window.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.pointer) return;
    if (!drag.moved && Math.hypot(ev.clientX - drag.start[0], ev.clientY - drag.start[1]) < 3) return;
    drag.moved = true;
    drag.at = e.docPoint(ev.clientX, ev.clientY) as [number, number];
    drag.position = Math.round(drag.orientation === 'vertical' ? drag.at[0] : drag.at[1]);
    e.overlay();
  });
  const end = (ev: PointerEvent) => {
    if (!drag || ev.pointerId !== drag.pointer) return;
    const d = drag;
    finish();
    if (!d.moved) {
      // A click selects the guide (Shift adds or removes it).
      const current = selectedGuides(e);
      if (d.shift) {
        if (current.has(d.key!)) current.delete(d.key!);
        else current.add(d.key!);
        selectGuides(e, current);
      } else selectGuides(e, [d.key!]);
      return;
    }
    const doc = e.doc;
    const max = d.orientation === 'vertical' ? doc.width : doc.height;
    // Dragging a guide back onto the ruler (outside the canvas) removes it.
    const box = viewport.getBoundingClientRect();
    const over = ev.clientX >= box.left && ev.clientY >= box.top && ev.clientX <= box.right && ev.clientY <= box.bottom;
    const removed = !over || d.position < -max || d.position > max * 2;
    if (removed && !d.source) {
      e.overlay();
      return;
    }
    let key: string | undefined;
    e.command(d.source ? (removed ? 'Delete Guide' : 'Move Guide') : 'New Guide', (draft) => {
      const target = dropOwner(draft, d.at);
      const absolute: Guide = { orientation: d.orientation, position: d.position };
      const rect = ownerRect(draft, target);
      const stored = rect ? toArtboard(absolute, rect) : absolute;
      if (d.source && !removed && sameOwner(d.source.owner, target)) {
        // Moved within its own list: keep its place (and selection key).
        const list = [...ownerGuides(draft, target)];
        list[d.source.index] = stored;
        setOwnerGuides(draft, target, list);
        key = guideKey(target, d.source.index);
        return;
      }
      if (d.source) setOwnerGuides(draft, d.source.owner, ownerGuides(draft, d.source.owner).filter((_, i) => i !== d.source!.index));
      if (removed) return;
      const list = [...ownerGuides(draft, target), stored];
      setOwnerGuides(draft, target, list);
      key = guideKey(target, list.length - 1);
    });
    // The moved or new guide becomes the selection.
    selectGuides(e, key ? [key] : []);
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', (ev) => {
    if (!drag || ev.pointerId !== drag.pointer) return;
    finish();
    e.overlay();
  });
}

// ----- Overlay -----
function line(g: Guide, extent: Rect | undefined, pad: number, doc: PhotoDocument) {
  const v = g.orientation === 'vertical';
  const from = extent ? (v ? extent.y : extent.x) : -pad;
  const to = extent ? (v ? extent.y + extent.height : extent.x + extent.width) : (v ? doc.height : doc.width) + pad;
  return v ? `x1="${g.position}" x2="${g.position}" y1="${from}" y2="${to}"` : `x1="${from}" x2="${to}" y1="${g.position}" y2="${g.position}"`;
}
function guidesOverlay(e: Editor) {
  if (!guidesVisible(e)) return '';
  const doc = e.doc;
  const z = e.zoom,
    pad = Math.max(doc.width, doc.height) * 4;
  const selected = drag?.moved ? new Set<string>() : selectedGuides(e);
  const hidden = drag?.moved && drag.key;
  let html = '';
  for (const g of placedGuides(doc, { canvas: canvasGuidesShown(e), artboards: artboardGuidesShown(e) })) {
    if (g.key === hidden) continue;
    const sel = selected.has(g.key);
    const kind = g.extent ? ' artboard-guide' : '';
    const at = line(g, g.extent, pad, doc);
    html += `<line ${at} class="guide${kind}${sel ? ' selected' : ''}" stroke-width="${(sel ? 2 : 1) / z}"/><line data-guide="${g.key}" ${at} class="guide-hit ${g.orientation}" stroke-width="${7 / z}"/>`;
  }
  if (drag?.moved) {
    // The guide being placed spans the artboard it would join.
    const owner = dropOwner(doc, drag.at);
    const extent = ownerRect(doc, owner);
    html += `<line ${line({ orientation: drag.orientation, position: drag.position }, extent, pad, doc)} class="guide dragging${extent ? ' artboard-guide' : ''}" stroke-width="${1 / z}"/>`;
  }
  return html;
}

// ----- Commands -----
/** Artboards a command acts on: selected artboards, else those holding the selected layers. */
export function targetArtboards(e: Editor) {
  if (!e.hasDocument) return [];
  const boards = artboardsOf(e.doc);
  const ids = [...e.selectedIds];
  return boards.filter((a) => ids.some((id) => id === a.id || !!findLayer(a.children, id)));
}
function ownerChoices(e: Editor): { options: [string, string][]; value: string } {
  const boards = artboardsOf(e.doc);
  const target = targetArtboards(e)[0];
  return { options: [['canvas', 'Canvas'], ...boards.map((a) => [a.id, `Artboard: ${a.name}`] as [string, string])], value: target?.id ?? 'canvas' };
}
const ownerFromChoice = (v: string | undefined): GuideOwner => (!v || v === 'canvas' ? 'canvas' : { artboard: v });

async function newGuide(e: Editor) {
  const owners = ownerChoices(e);
  const v = await formDialog('New Guide', [
    { name: 'orientation', label: 'Orientation', value: 'horizontal', type: 'select', options: [['horizontal', 'Horizontal'], ['vertical', 'Vertical']] },
    { name: 'position', label: owners.options.length > 1 ? 'Position (px from the left or top edge)' : 'Position (px)', value: 0, type: 'number' },
    ...(owners.options.length > 1 ? [{ name: 'owner', label: 'Guide for', value: owners.value, type: 'select', options: owners.options }] : []),
  ], 'OK');
  if (!v || !Number.isFinite(Number(v.position))) return;
  const owner = ownerFromChoice(v.owner);
  e.command('New Guide', (d) => setOwnerGuides(d, owner, [...ownerGuides(d, owner), { orientation: v.orientation as Guide['orientation'], position: Number(v.position) }]));
}

/** Guides for columns and rows with gutters and margins inside a w × h area. */
export function layoutGuides(width: number, height: number, columns: number, rows: number, gutter: number, margin: number): Guide[] {
  const guides: Guide[] = [];
  const lay = (n: number, size: number, orientation: Guide['orientation']) => {
    if (n <= 0) return;
    if (margin) guides.push({ orientation, position: margin }, { orientation, position: size - margin });
    const cell = (size - 2 * margin - gutter * (n - 1)) / n;
    for (let i = 1; i < n; i++) {
      const at = margin + i * cell + (i - 1) * gutter;
      guides.push({ orientation, position: Math.round(at) });
      if (gutter) guides.push({ orientation, position: Math.round(at + gutter) });
    }
  };
  lay(columns, width, 'vertical');
  lay(rows, height, 'horizontal');
  return guides;
}
async function newGuideLayout(e: Editor) {
  const owners = ownerChoices(e);
  const v = await formDialog('New Guide Layout', [
    { name: 'columns', label: 'Columns', value: 4, type: 'number', min: 0, max: 100 },
    { name: 'rows', label: 'Rows', value: 0, type: 'number', min: 0, max: 100 },
    { name: 'gutter', label: 'Gutter (px)', value: 20, type: 'number', min: 0 },
    { name: 'margin', label: 'Margin (px)', value: 0, type: 'number', min: 0 },
    ...(owners.options.length > 1 ? [{ name: 'owner', label: 'Lay out on', value: owners.value, type: 'select', options: owners.options }] : []),
    { name: 'clear', label: 'Clear existing guides', value: 'yes', type: 'checkbox' },
  ], 'OK');
  if (!v) return;
  const owner = ownerFromChoice(v.owner);
  const rect = ownerRect(e.doc, owner) ?? { x: 0, y: 0, width: e.doc.width, height: e.doc.height };
  const guides = layoutGuides(rect.width, rect.height, Number(v.columns), Number(v.rows), Number(v.gutter), Number(v.margin));
  e.command('New Guide Layout', (d) => setOwnerGuides(d, owner, v.clear === 'yes' ? guides : [...ownerGuides(d, owner), ...guides]));
}

/** Bounds a layer contributes to New Guides From Shape: the outline of a
 * shape layer or a vector mask, else the layer's transformed content box. */
async function shapeRect(l: Layer): Promise<Rect | null> {
  const { vectorBounds } = await import('../model/vector');
  if (l.kind === 'vector' && l.vector) {
    const { shapeBounds } = await import('./vector/edit');
    const b = shapeBounds(l);
    if (b && b.width + b.height > 0) return b;
  }
  if (l.vectorMask && !l.vectorMask.disabled) {
    const b = vectorBounds(l.vectorMask.mask);
    if (b && b.width + b.height > 0) return b;
  }
  if (isArtboardLayer(l)) return l.artboard.rect;
  if (l.frame) return l.frame.rect;
  if (l.kind === 'group' || l.kind === 'adjustment') return null;
  const { transformBounds } = await import('../model/transform');
  return transformBounds(l.transform);
}
async function guidesFromShape(e: Editor) {
  const layers = [...e.selectedIds].map((id) => findLayer(e.doc.layers, id)).filter((l): l is Layer => !!l);
  const byOwner = new Map<string, { owner: GuideOwner; guides: Guide[] }>();
  for (const l of layers) {
    const r = await shapeRect(l);
    if (!r) continue;
    // Guides for a layer on an artboard belong to that artboard.
    const board = isArtboardLayer(l) ? undefined : artboardsOf(e.doc).find((a) => !!findLayer(a.children, l.id));
    const owner: GuideOwner = board ? { artboard: board.id } : 'canvas';
    const entry = byOwner.get(ownerId(owner)) ?? { owner, guides: [] };
    entry.guides.push(...rectGuides(r).map((g) => (board ? toArtboard(g, board.artboard.rect) : g)));
    byOwner.set(ownerId(owner), entry);
  }
  if (!byOwner.size) {
    e.message('Select a shape, a layer with a vector mask or a layer with content.');
    return;
  }
  e.command('New Guides From Shape', (d) => {
    for (const { owner, guides } of byOwner.values()) setOwnerGuides(d, owner, mergeGuides(ownerGuides(d, owner), guides));
  });
}

const insideCanvas = (doc: PhotoDocument, g: Guide) => g.position >= 0 && g.position <= (g.orientation === 'vertical' ? doc.width : doc.height);

async function editSelectedGuides(e: Editor) {
  const keys = [...selectedGuides(e)];
  if (!keys.length) return;
  if (keys.length === 1) {
    const p = parseGuideKey(keys[0])!;
    const rect = ownerRect(e.doc, p.owner);
    const g = ownerGuides(e.doc, p.owner)[p.index];
    const v = await formDialog('Edit Guide', [
      { name: 'orientation', label: 'Orientation', value: g.orientation, type: 'select', options: [['horizontal', 'Horizontal'], ['vertical', 'Vertical']] },
      { name: 'position', label: rect ? 'Position (px from the artboard edge)' : 'Position (px)', value: g.position, type: 'number' },
    ], 'OK');
    if (!v || !Number.isFinite(Number(v.position))) return;
    e.command('Edit Guide', (d) => {
      const list = [...ownerGuides(d, p.owner)];
      list[p.index] = { orientation: v.orientation as Guide['orientation'], position: Number(v.position) };
      setOwnerGuides(d, p.owner, list);
    });
    selectGuides(e, keys);
    return;
  }
  const v = await formDialog('Edit Selected Guides', [
    { name: 'dx', label: 'Move vertical guides by (px)', value: 0, type: 'number' },
    { name: 'dy', label: 'Move horizontal guides by (px)', value: 0, type: 'number' },
  ], 'OK', `${keys.length} guides are selected.`);
  if (!v) return;
  const dx = Number(v.dx) || 0,
    dy = Number(v.dy) || 0;
  e.command('Edit Guides', (d) => {
    const lists = new Map<string, { owner: GuideOwner; list: Guide[] }>();
    for (const k of keys) {
      const p = parseGuideKey(k)!;
      const entry = lists.get(ownerId(p.owner)) ?? { owner: p.owner, list: [...ownerGuides(d, p.owner)] };
      const g = entry.list[p.index];
      entry.list[p.index] = { ...g, position: g.position + (g.orientation === 'vertical' ? dx : dy) };
      lists.set(ownerId(p.owner), entry);
    }
    for (const { owner, list } of lists.values()) setOwnerGuides(d, owner, list);
  });
  selectGuides(e, keys);
}

export function installGuides(e: Editor) {
  bindGuides(e);
  registerOverlay('guides', guidesOverlay);
  const hasDoc = (e: Editor) => e.hasDocument;
  const flag = (key: 'showCanvasGuides' | 'showArtboardGuides') => (e: Editor) => {
    toggleGuideKind(e.preferences, key);
    e.savePreferences();
    e.overlay();
  };
  registerCommand(
    { id: 'view.show-canvas-guides', label: 'Canvas Guides', checked: (e) => e.preferences.showGuides && canvasGuidesShown(e), run: flag('showCanvasGuides'), recordable: false, description: 'Show guides that span the whole canvas.' },
    { id: 'view.show-artboard-guides', label: 'Artboard Guides', checked: (e) => e.preferences.showGuides && artboardGuidesShown(e), run: flag('showArtboardGuides'), recordable: false, description: 'Show guides that belong to artboards and move with them.' },
    {
      id: 'view.guides-clear',
      label: 'Clear Guides',
      enabled: (e) => hasDoc(e) && placedGuides(e.doc).length > 0,
      run: (e) =>
        e.command('Clear Guides', (d) => {
          setOwnerGuides(d, 'canvas', []);
          for (const a of artboardsOf(d)) if (a.artboard.guides) setOwnerGuides(d, { artboard: a.id }, []);
        }),
    },
    {
      id: 'view.guides-clear-selected',
      label: 'Clear Selected Guides',
      enabled: (e) => selectedGuides(e).size > 0,
      run: (e) => {
        const keys = selectedGuides(e);
        e.command('Clear Selected Guides', (d) => void removeGuides(d, keys));
      },
    },
    {
      id: 'view.guides-clear-artboard',
      label: 'Clear Selected Artboard Guides',
      description: 'Remove the guides of the selected artboards (or of the artboards holding the selected layers).',
      enabled: (e) => targetArtboards(e).some((a) => !!a.artboard.guides?.length),
      run: (e) => {
        const ids = targetArtboards(e).map((a) => a.id);
        e.command('Clear Artboard Guides', (d) => {
          for (const id of ids) setOwnerGuides(d, { artboard: id }, []);
        });
      },
    },
    { id: 'view.guides-edit-selected', label: 'Edit Selected Guides…', enabled: (e) => selectedGuides(e).size > 0, run: editSelectedGuides },
    {
      id: 'view.guides-clear-canvas',
      label: 'Clear Canvas Guides',
      description: 'Remove canvas guides that cross the canvas; artboard guides and guides out on the pasteboard stay.',
      enabled: (e) => hasDoc(e) && !!e.doc.guides?.some((g) => insideCanvas(e.doc, g)),
      run: (e) => {
        const all = e.doc.guides ?? [];
        const kept = all.filter((g) => !insideCanvas(e.doc, g));
        e.command('Clear Canvas Guides', (d) => setOwnerGuides(d, 'canvas', kept));
        if (kept.length) e.message(`Cleared ${all.length - kept.length} canvas guides; ${kept.length} outside the canvas kept.`);
      },
    },
    { id: 'view.guides-new', label: 'New Guide…', enabled: hasDoc, run: newGuide },
    { id: 'view.guides-layout', label: 'New Guide Layout…', enabled: hasDoc, run: newGuideLayout },
    {
      id: 'view.guides-from-shape',
      label: 'New Guides From Shape',
      description: 'Add guides along the edges and centers of the selected shapes, vector masks or layers.',
      enabled: (e) => hasDoc(e) && e.selectedIds.size > 0,
      run: guidesFromShape,
    },
  );
}
