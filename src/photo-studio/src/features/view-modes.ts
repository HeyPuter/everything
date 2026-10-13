import type { Editor } from '../editor';
import { commands, registerCommand, registerOverlay } from '../app/registry';
import type { DocumentView } from '../app/views';
import type { DocumentSession } from '../app/session';
import { actualSizeZoom, centerPoint, fitZoom, panToCenter, pixelsPerInch, printSizeZoom, rotateAround, type Size } from '../app/view-transform';
import { selectedRoots } from '../model/layers';
import { allLayers } from '../model/document';
import { transformBounds } from '../model/transform';
import { formDialog } from '../ui/dialog';

// View modes that change how a document is shown, never its pixels: view
// rotation and mirroring, zoom presets, pixel aspect ratio correction and
// pattern preview.

/** Set a window's rotation, pivoting about a viewport-local point (center by default). */
export function rotateView(e: Editor, rotation: number, around?: [number, number], view = e.activeView) {
  const size = view === e.activeView ? e.viewportSize() : e.windows.viewportSize(view);
  const next = rotateAround(view.state(), rotation, size, around?.[0], around?.[1]);
  view.rotation = next.rotation;
  view.pan = next.pan;
}
/** Rotate the active window, and every other window when "Rotate All Windows" is on. */
export function setViewRotation(e: Editor, rotation: number, around?: [number, number]) {
  rotateView(e, rotation, around);
  if (e.preferences.rotateAllWindows) for (const v of e.views) if (v !== e.activeView) rotateView(e, rotation, undefined, v);
  refreshViews(e);
}
export function refreshViews(e: Editor) {
  e.view();
  e.overlay();
  e.windows.renderTabs();
  e.windows.queueDraw();
}

// ----- Pixel aspect ratios -----
type AspectPreset = { id: string; label: string; ratio: number };
export const builtinAspects: AspectPreset[] = [
  { id: 'square', label: 'Square (1.0)', ratio: 1 },
  { id: 'ntsc', label: 'NTSC Standard Definition (0.91)', ratio: 10 / 11 },
  { id: 'pal', label: 'PAL Standard Definition (1.09)', ratio: 59 / 54 },
  { id: 'ntsc-wide', label: 'NTSC Widescreen (1.21)', ratio: 40 / 33 },
  { id: 'hd-133', label: 'HD Anamorphic 1440×1080 (1.33)', ratio: 4 / 3 },
  { id: 'pal-wide', label: 'PAL Widescreen (1.46)', ratio: 118 / 81 },
  { id: 'hd-150', label: 'HD Anamorphic 1280×1080 (1.5)', ratio: 3 / 2 },
  { id: 'anamorphic', label: 'Anamorphic 2:1 (2.0)', ratio: 2 },
];
const aspectKey = 'photo-studio-pixel-aspects';
function loadCustomAspects(): AspectPreset[] {
  try {
    const list = JSON.parse(localStorage.getItem(aspectKey) ?? '[]');
    if (Array.isArray(list))
      return list
        .filter((a) => a && typeof a.label === 'string' && Number.isFinite(a.ratio) && a.ratio >= 0.1 && a.ratio <= 10)
        .map((a, i) => ({ id: `custom-${i}`, label: String(a.label).slice(0, 60), ratio: Number(a.ratio) }));
  } catch {
    /* Optional. */
  }
  return [];
}
function saveCustomAspects(list: AspectPreset[]) {
  try {
    localStorage.setItem(aspectKey, JSON.stringify(list.map(({ label, ratio }) => ({ label, ratio }))));
  } catch {
    /* Optional. */
  }
}
const sameRatio = (a: number, b: number) => Math.abs(a - b) < 1e-4;
function setPixelAspect(e: Editor, ratio: number) {
  e.command('Pixel Aspect Ratio', (d) => {
    if (sameRatio(ratio, 1)) delete d.pixelAspect;
    else d.pixelAspect = ratio;
  });
  refreshViews(e);
}
let customAspects: AspectPreset[] = [];
function registerAspects(e: Editor) {
  for (const id of [...commands.keys()]) if (id.startsWith('view.pixel-aspect-set-custom-')) commands.delete(id);
  customAspects = loadCustomAspects();
  [...builtinAspects, ...customAspects].forEach((a, i) =>
    registerCommand({
      id: `view.pixel-aspect-set-${a.id}`,
      label: a.label,
      menu: 'view.pixel-aspect-ratio',
      order: i,
      enabled: (e) => e.hasDocument,
      checked: (e) => sameRatio(e.doc.pixelAspect ?? 1, a.ratio),
      run: () => setPixelAspect(e, a.ratio),
      description: 'Display pixels at this width-to-height ratio',
    }),
  );
}

// ----- Pattern preview -----
const patternSessions = new WeakSet<DocumentSession>();
export const patternPreviewOn = (e: Editor) => patternSessions.has(e.session) && e.hasDocument;
// Neighbor tiles are drawn into one canvas around the live document canvas.
const PATTERN_MAX = 4096;
function patternCanvas(e: Editor) {
  let c = e.root.querySelector<HTMLCanvasElement>('#pattern-tiles');
  if (!c) {
    c = document.createElement('canvas');
    c.id = 'pattern-tiles';
    c.setAttribute('aria-hidden', 'true');
    e.el('#stage').prepend(c);
  }
  return c;
}
function drawPattern(e: Editor, source: HTMLCanvasElement) {
  const c = patternCanvas(e);
  const k = Math.min(1, PATTERN_MAX / (3 * Math.max(source.width, source.height)));
  const w = Math.max(1, Math.round(source.width * k)),
    h = Math.max(1, Math.round(source.height * k));
  if (c.width !== w * 3 || c.height !== h * 3) {
    c.width = w * 3;
    c.height = h * 3;
  }
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) if (x !== 1 || y !== 1) g.drawImage(source, x * w, y * h, w, h);
}
function syncPattern(e: Editor) {
  const on = patternPreviewOn(e);
  e.el('#stage').classList.toggle('pattern-preview', on);
  if (!on) e.root.querySelector('#pattern-tiles')?.remove();
}

/** Zoom and center the view on a document rectangle. */
function fitRect(e: Editor, r: { x: number; y: number; width: number; height: number }, view: DocumentView = e.activeView) {
  const size: Size = e.viewportSize();
  view.zoom = fitZoom({ rotation: view.rotation, aspect: e.viewAspect() }, r, size, 40, 64);
  view.pan = panToCenter(view.state(e.viewAspect()), e.doc, r.x + r.width / 2, r.y + r.height / 2);
  refreshViews(e);
}

export function installViewModes(e: Editor) {
  const cmd = (id: string, label: string, run: (e: Editor) => void, extra: Partial<Parameters<typeof registerCommand>[0]> = {}) =>
    registerCommand({ id, label, run, recordable: false, ...extra });
  cmd('view.flip-horizontal', 'Flip Horizontal', (e) => {
    // Mirror about the window center so the point there stays put.
    const center = centerPoint(e.activeView.state(e.viewAspect()), e.doc);
    e.activeView.flip = !e.activeView.flip;
    e.activeView.pan = panToCenter(e.activeView.state(e.viewAspect()), e.doc, ...center);
    refreshViews(e);
  }, { checked: (e) => e.activeView.flip, enabled: (e) => e.hasDocument, description: 'Mirror the view only; the image is not changed' });
  cmd('view.reset-rotation', 'Reset Rotation', (e) => setViewRotation(e, 0), { enabled: (e) => !!e.rotation, description: 'Show the image upright again' });
  cmd('view.zoom-200', '200%', (e) => e.zoomAt(2));
  cmd('view.print-size', 'Print Size', (e) => {
    e.zoomAt(printSizeZoom(pixelsPerInch(e.doc.resolution), e.preferences.screenPpi ?? 96));
  }, { enabled: (e) => e.hasDocument, description: 'Show the image at its printed size, using the screen resolution set in Preferences' });
  cmd('view.actual-size', 'Actual Size', (e) => e.zoomBy(actualSizeZoom(globalThis.devicePixelRatio ?? 1)), {
    enabled: (e) => e.hasDocument,
    description: 'Show one image pixel per physical screen pixel (differs from 100% on high-density screens and when the browser is zoomed)',
  });
  cmd('view.fit-layers', 'Fit Layer(s) on Screen', (e) => {
    const leaves = allLayers(selectedRoots(e.doc.layers, e.selectedIds)).filter((l) => l.kind !== 'group' && l.kind !== 'adjustment');
    if (!leaves.length) return e.fit();
    const boxes = leaves.map((l) => transformBounds(l.transform));
    const x = Math.min(...boxes.map((b) => b.x)),
      y = Math.min(...boxes.map((b) => b.y));
    const r = { x, y, width: Math.max(1, Math.max(...boxes.map((b) => b.x + b.width)) - x), height: Math.max(1, Math.max(...boxes.map((b) => b.y + b.height)) - y) };
    fitRect(e, r);
  }, { enabled: (e) => e.hasDocument && e.selectedIds.size > 0 });

  // Pixel aspect ratio and its correction preview.
  registerAspects(e);
  cmd('view.pixel-aspect', 'Pixel Aspect Ratio Correction', (e) => {
    e.preferences.aspectCorrection = e.preferences.aspectCorrection === false;
    e.savePreferences();
    refreshViews(e);
  }, { enabled: (e) => !!e.doc.pixelAspect && e.doc.pixelAspect !== 1, checked: (e) => e.preferences.aspectCorrection !== false && !!e.doc.pixelAspect && e.doc.pixelAspect !== 1 });
  cmd('view.pixel-aspect-custom', 'Custom Pixel Aspect Ratio…', async (e) => {
    const v = await formDialog('Custom Pixel Aspect Ratio', [
      { name: 'name', label: 'Name', value: 'Custom' },
      { name: 'ratio', label: 'Width of one pixel (height = 1)', value: Math.round((e.doc.pixelAspect ?? 1) * 1000) / 1000, type: 'number', min: 0.1, max: 10, step: 0.001 },
    ], 'Apply', 'Saved ratios appear in this menu for every document.');
    if (!v) return;
    const ratio = Math.max(0.1, Math.min(10, Number(v.ratio) || 1));
    const label = `${(v.name || 'Custom').trim().slice(0, 40)} (${Math.round(ratio * 100) / 100})`;
    if (![...builtinAspects, ...customAspects].some((a) => sameRatio(a.ratio, ratio))) {
      saveCustomAspects([...customAspects, { id: '', label, ratio }]);
      registerAspects(e);
    }
    if (e.hasDocument) setPixelAspect(e, ratio);
  });
  cmd('view.pixel-aspect-delete', 'Delete Pixel Aspect Ratio…', async (e) => {
    const v = await formDialog('Delete Pixel Aspect Ratio', [{ name: 'id', label: 'Ratio', value: customAspects[0].id, type: 'select', options: customAspects.map((a) => [a.id, a.label]) }], 'Delete');
    if (!v) return;
    saveCustomAspects(customAspects.filter((a) => a.id !== v.id));
    registerAspects(e);
  }, { enabled: () => customAspects.length > 0 });
  cmd('view.pixel-aspect-reset', 'Reset Pixel Aspect Ratios…', async (e) => {
    const ok = await formDialog('Reset Pixel Aspect Ratios', [], 'Reset', `Remove ${customAspects.length === 1 ? 'the saved custom ratio' : `all ${customAspects.length} saved custom ratios`}? Documents keep their current ratio.`);
    if (!ok) return;
    saveCustomAspects([]);
    registerAspects(e);
  }, { enabled: () => customAspects.length > 0 });

  // Pattern preview: the document repeats around itself and painting wraps.
  cmd('view.pattern-preview', 'Pattern Preview', (e) => {
    if (patternSessions.has(e.session)) patternSessions.delete(e.session);
    else {
      patternSessions.add(e.session);
      e.message('Pattern Preview: the image repeats around itself; brush strokes wrap across the edges.');
    }
    syncPattern(e);
    e.update();
  }, { enabled: (e) => e.hasDocument, checked: (e) => patternPreviewOn(e), description: 'Repeat the image around itself to design seamless patterns' });
  e.onUpdate(syncPattern);
  registerOverlay('pattern-bounds', (e) =>
    patternPreviewOn(e) ? `<rect class="pattern-bounds" x="0" y="0" width="${e.doc.width}" height="${e.doc.height}" fill="none" stroke-width="${1 / e.zoom}" stroke-dasharray="${4 / e.zoom} ${4 / e.zoom}"/>` : '',
  );
  e.whenReady(() =>
    e.renderer.frameListeners.add((canvas, doc) => {
      if (patternPreviewOn(e) && doc.width === e.doc.width && doc.height === e.doc.height) drawPattern(e, canvas);
    }),
  );
}
