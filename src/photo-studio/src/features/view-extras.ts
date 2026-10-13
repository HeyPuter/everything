// View > Show (layer edges, alignment guides, brush preview, all/none, extras
// options) and View > Snap To. Guides live in features/guides.ts. Proof plates and vision simulations live with the
// rest of soft proofing in features/color.
import type { Editor } from '../editor';
import { registerCommand, registerOverlay } from '../app/registry';
import { allLayers, findLayer, type Layer, type PhotoDocument, type Transform } from '../model/document';
import { layerTargetRects, lineTargets, snapTargets, snapTranslation, transformBounds, worldPoint, type Guides, type SnapOptions } from '../model/transform';
import { smartGuides, type SmartGuideResult } from '../model/smart-guides';
import { formDialog } from '../ui/dialog';
import { gridSpacingPx } from '../model/preferences';
import { documentPpi } from '../model/text-layer';

// ----- Extras -----
// Items View > Extras hides; chosen in Show Extras Options.
export const EXTRAS: [string, string][] = [
  ['layer-edges', 'Layer edges'],
  ['selection-edges', 'Selection edges'],
  ['target-path', 'Target path'],
  ['grid', 'Grid'],
  ['guides', 'Guides'],
  ['alignment-guides', 'Alignment guides'],
  ['pixel-grid', 'Pixel grid'],
  ['brush-preview', 'Brush preview'],
];
const defaultExtras = EXTRAS.map(([k]) => k).filter((k) => k !== 'brush-preview');
export const extrasIncluded = (e: Editor) => e.preferences.extras ?? defaultExtras;
/** True while View > Extras is off and hides this item. */
export function extraHidden(e: Editor, key: string) {
  return !!e.settings.extrasHidden && extrasIncluded(e).includes(key);
}
/** Whether the brush outline follows the pointer (else a precise crosshair). */
export function brushPreviewShown(e: Editor) {
  return e.preferences.showBrushPreview !== false && !extraHidden(e, 'brush-preview');
}
const smartGuidesShown = (e: Editor) => e.preferences.showAlignmentGuides !== false && !extraHidden(e, 'alignment-guides');

// Session flags hidden by Extras, restored when Extras comes back.
let hiddenByExtras: { selection: boolean; path: boolean } | undefined;
function setExtras(e: Editor, visible: boolean) {
  if (visible === !e.settings.extrasHidden) return;
  const included = extrasIncluded(e);
  if (!visible) {
    hiddenByExtras = { selection: !!e.settings.hideSelectionEdges, path: !!e.settings.hideTargetPath };
    e.settings.extrasHidden = true;
    if (included.includes('selection-edges')) e.settings.hideSelectionEdges = true;
    if (included.includes('target-path')) e.settings.hideTargetPath = true;
  } else {
    e.settings.extrasHidden = false;
    if (hiddenByExtras) {
      e.settings.hideSelectionEdges = hiddenByExtras.selection;
      e.settings.hideTargetPath = hiddenByExtras.path;
    }
    hiddenByExtras = undefined;
  }
  refresh(e);
}
function refresh(e: Editor) {
  e.savePreferences();
  e.overlay();
  e.screenOverlayContent = '';
  e.screenOverlay();
}

/** Grid spacing in document pixels (Preferences → Guides, Grid & Slices). */
export function gridSpacing(e: Editor) {
  return gridSpacingPx(e.preferences, documentPpi(e.doc), e.doc.width);
}

// ----- Snapping -----
const snapDefaults = { guides: true, grid: false, layers: true, document: true };
export const snapTo = (e: Editor) => ({ ...snapDefaults, ...e.preferences.snapTo });
/** Snap targets enabled in View > Snap To (grid lines follow the visible grid's subdivisions). */
export function snapOptions(e: Editor): SnapOptions {
  const s = snapTo(e);
  return { guides: s.guides, layers: s.layers, document: s.document, grid: s.grid ? gridSpacing(e) : 0, gridDivisions: e.preferences.gridSubdivisions };
}
export type MoveGuides = Guides & { smart?: SmartGuideResult };
/** Snap a moved selection frame. With alignment guides on, the frame aligns to
 * other layers' edges and centers or to equal spacing, and the matches are
 * returned for drawing; Snap (View > Snap) controls the pull. */
export function snapMove(e: Editor, doc: PhotoDocument, roots: Layer[], next: Transform, snapping: boolean): { transform: Transform; guides: MoveGuides } {
  const opts = snapOptions(e);
  const threshold = 6 / e.zoom;
  if (smartGuidesShown(e)) {
    const lines = lineTargets(doc, { ...opts, document: false });
    const rects = opts.layers ? layerTargetRects(doc, roots) : [];
    const result = smartGuides({
      moving: transformBounds(next),
      rects,
      canvas: { x: 0, y: 0, width: doc.width, height: doc.height },
      snapCanvas: opts.document,
      lines,
      threshold: snapping ? threshold : 0,
    });
    return { transform: { ...next, x: next.x + result.dx, y: next.y + result.dy }, guides: { smart: result } };
  }
  if (!snapping) return { transform: next, guides: {} };
  const snapped = snapTranslation(next, snapTargets(doc, roots, opts), threshold);
  return { transform: snapped.transform, guides: snapped.guides };
}
/** SVG for alignment lines and equal-spacing markers (document space). */
export function smartGuidesSvg(e: Editor, g: SmartGuideResult) {
  const z = e.zoom;
  let html = '';
  for (const l of g.lines)
    html += l.axis === 'x'
      ? `<line class="smart-guide" x1="${l.at}" x2="${l.at}" y1="${l.from}" y2="${l.to}" stroke-width="${1 / z}"/>`
      : `<line class="smart-guide" x1="${l.from}" x2="${l.to}" y1="${l.at}" y2="${l.at}" stroke-width="${1 / z}"/>`;
  const tick = 4 / z,
    font = 10 / z;
  for (const s of g.spacing) {
    const label = String(Math.round(s.gap));
    const mid = (s.from + s.to) / 2;
    const w = (label.length * 6.2 + 8) / z,
      h = 14 / z;
    if (s.axis === 'x')
      html += `<path class="smart-spacing" d="M${s.from} ${s.at}H${s.to}M${s.from} ${s.at - tick}V${s.at + tick}M${s.to} ${s.at - tick}V${s.at + tick}" stroke-width="${1 / z}"/><rect class="smart-label-bg" x="${mid - w / 2}" y="${s.at + tick + 2 / z}" width="${w}" height="${h}" rx="${3 / z}"/><text class="smart-label" x="${mid}" y="${s.at + tick + 2 / z + h / 2}" font-size="${font}">${label}</text>`;
    else
      html += `<path class="smart-spacing" d="M${s.at} ${s.from}V${s.to}M${s.at - tick} ${s.from}H${s.at + tick}M${s.at - tick} ${s.to}H${s.at + tick}" stroke-width="${1 / z}"/><rect class="smart-label-bg" x="${s.at + tick + 2 / z}" y="${mid - h / 2}" width="${w}" height="${h}" rx="${3 / z}"/><text class="smart-label" x="${s.at + tick + 2 / z + w / 2}" y="${mid}" font-size="${font}">${label}</text>`;
  }
  return html;
}

// ----- Overlays -----
function layerEdgesOverlay(e: Editor) {
  // While a move is dragged the transform frame already shows the live bounds.
  if (!e.hasDocument || !e.preferences.showLayerEdges || extraHidden(e, 'layer-edges') || e.transform.dragging) return '';
  const doc = e.displayDoc;
  const leaves = allLayers([...e.selectedIds].map((id) => findLayer(doc.layers, id)).filter((l): l is Layer => !!l)).filter(
    (l) => l.kind !== 'group' && l.kind !== 'adjustment' && l.visible,
  );
  return leaves
    .map((l) => {
      const points = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => worldPoint(l.transform, x, y).join(',')).join(' ');
      return `<polygon class="layer-edge" points="${points}" stroke-width="${1 / e.zoom}"/>`;
    })
    .join('');
}

// ----- Commands -----
type Flag = 'showLayerEdges' | 'showAlignmentGuides' | 'showBrushPreview';
const flag = (e: Editor, key: Flag) => e.preferences[key] ?? key !== 'showLayerEdges';
function toggle(e: Editor, key: Flag) {
  e.preferences[key] = !flag(e, key);
  refresh(e);
}
function showEverything(e: Editor, on: boolean) {
  Object.assign(e.preferences, { showGrid: on, showGuides: on, showCanvasGuides: on, showArtboardGuides: on, showPixelGrid: on, showLayerEdges: on, showAlignmentGuides: on, showBrushPreview: on, showSlices: on });
  e.settings.hideSelectionEdges = !on;
  e.settings.hideTargetPath = !on;
  e.settings.hideNotes = !on;
  e.settings.hideCounts = !on;
  e.settings.hideSamplers = !on;
  hiddenByExtras = undefined;
  e.settings.extrasHidden = false;
  refresh(e);
  e.update();
}
function setSnap(e: Editor, patch: Partial<typeof snapDefaults>) {
  e.preferences.snapTo = { ...snapTo(e), ...patch };
  // Choosing a target turns snapping on; choosing none leaves it as it is.
  if (Object.values(patch).some(Boolean)) e.transform.snapping = true;
  e.savePreferences();
  e.options();
}

async function extrasOptions(e: Editor) {
  const included = new Set(extrasIncluded(e));
  const v = await formDialog(
    'Extras Options',
    EXTRAS.map(([key, label]) => ({ name: key, label, value: included.has(key) ? 'yes' : 'no', type: 'checkbox' })),
    'OK',
    'View > Extras shows or hides these items together.',
  );
  if (!v) return;
  const hidden = !!e.settings.extrasHidden;
  // Re-apply with the new set so a hidden item comes back or goes away now.
  if (hidden) setExtras(e, true);
  e.preferences.extras = EXTRAS.map(([k]) => k).filter((k) => v[k] === 'yes');
  if (hidden) setExtras(e, false);
  refresh(e);
}

export function installViewExtras(_e: Editor) {
  registerOverlay('layer-edges', layerEdgesOverlay);
  const snapItem = (id: string, label: string, key: keyof typeof snapDefaults) => ({
    id,
    label,
    checked: (e: Editor) => snapTo(e)[key],
    run: (e: Editor) => setSnap(e, { [key]: !snapTo(e)[key] }),
    recordable: false,
  });
  registerCommand(
    {
      id: 'view.extras',
      label: 'Extras',
      shortcut: 'Mod+H',
      checked: (e) => !e.settings.extrasHidden,
      run: (e) => setExtras(e, !!e.settings.extrasHidden),
      recordable: false,
    },
    { id: 'view.show-layer-edges', label: 'Layer Edges', checked: (e) => flag(e, 'showLayerEdges'), run: (e) => toggle(e, 'showLayerEdges'), recordable: false, description: 'Outline the bounds of the selected layers.' },
    { id: 'view.show-alignment-guides', label: 'Alignment Guides', checked: (e) => flag(e, 'showAlignmentGuides'), run: (e) => toggle(e, 'showAlignmentGuides'), recordable: false, description: 'While moving layers, show alignment with other layers and equal spacing.' },
    { id: 'view.show-brush-preview', label: 'Brush Preview', checked: (e) => flag(e, 'showBrushPreview'), run: (e) => toggle(e, 'showBrushPreview'), recordable: false, description: 'Show the brush outline at the pointer; off shows a precise crosshair.' },
    { id: 'view.show-all', label: 'All', run: (e) => showEverything(e, true), recordable: false },
    { id: 'view.show-none', label: 'None', run: (e) => showEverything(e, false), recordable: false },
    { id: 'view.show-extras-options', label: 'Show Extras Options…', run: extrasOptions, recordable: false },
    snapItem('view.snap-guides', 'Guides', 'guides'),
    snapItem('view.snap-grid', 'Grid', 'grid'),
    snapItem('view.snap-layers', 'Layers', 'layers'),
    snapItem('view.snap-document', 'Document Bounds', 'document'),
    { id: 'view.snap-all', label: 'All', run: (e) => setSnap(e, { guides: true, grid: true, layers: true, document: true }), recordable: false },
    { id: 'view.snap-none', label: 'None', run: (e) => setSnap(e, { guides: false, grid: false, layers: false, document: false }), recordable: false },
  );
}
