// Transform feature: advanced transform sessions (Edit > Transform), layer
// and canvas rotation, Transform Again, Transform Selection, Image Size,
// Canvas Size and the crop tools.
import type { Editor } from '../../editor';
import { registerCommand, registerTool, type MenuItem } from '../../app/registry';
import { isMac } from '../../app/shortcuts';
import { findLayer } from '../../model/document';
import { gridDocBounds } from '../../model/tiles';
import { setPixelResampleMethod } from '../../model/pixel-layer';
import { lazy, lazyRun, lazyTool, prefetchOnIdle } from '../../app/lazy';
import { recordsSettings } from '../action-settings';
import type { Mode, SplitAction } from './session';
import { currentSession, recordTransform, selectionFrameOf, SESSION_TOOL } from './session-state';
import { bezierMesh, frameMatrix, samplerInterp, transformQuad, type Quad } from './math';
import { effectiveFrame } from '../embedded/frame-math';
import { meshKnots } from '../../imaging/filters/mesh';

// Advanced transform sessions, layer and canvas operations and the size
// dialogs load on first use; sessions are fetched when the workspace is idle
// (Mod-dragging a Free Transform handle hands over to one immediately).
const sessions = lazy(() => import('./session'));
const layerOps = lazy(() => import('./layer-ops'));
const imageSize = lazy(() => import('./image-size'));
const canvasSize = lazy(() => import('./canvas-size'));
const crop = lazy(() => import('./crop'));

const modeCommands: [string, Mode, string][] = [
  ['edit.transform-scale', 'scale', 'Scale'],
  ['edit.transform-rotate', 'rotate', 'Rotate'],
  ['edit.transform-skew', 'skew', 'Skew'],
  ['edit.transform-distort', 'distort', 'Distort'],
  ['edit.transform-perspective', 'perspective', 'Perspective'],
  ['edit.transform-warp', 'warp', 'Warp'],
];
const affineModes = new Set<Mode>(['free', 'scale', 'rotate']);
const splitCommands: [string, SplitAction, string][] = [
  ['edit.split-warp-horizontal', 'v', 'Split Warp Horizontally'],
  ['edit.split-warp-vertical', 'u', 'Split Warp Vertically'],
  ['edit.split-warp-crosswise', 'both', 'Split Warp Crosswise'],
  ['edit.remove-warp-split', 'remove', 'Remove Warp Split'],
];
export const transformMenu: MenuItem[] = [
  'edit.free-transform',
  ...modeCommands.map(([id]) => id),
  'edit.split-warp-horizontal',
  'edit.split-warp-vertical',
  'edit.split-warp-crosswise',
  'edit.remove-warp-split',
  'edit.convert-warp-anchor',
  '-',
  'edit.transform-guides',
  '-',
  'edit.rotate-180',
  'edit.rotate-cw',
  'edit.rotate-ccw',
  '-',
  'edit.flip-horizontal',
  'edit.flip-vertical',
];

/** The single selected layer when it is a pixel layer with content, or an image layer. */
function rasterLayer(e: Editor) {
  const l = e.selectedIds.size === 1 ? e.layer : undefined;
  if (!l) return;
  if (l.kind === 'pixel' && l.pixels && gridDocBounds(l.pixels)) return l;
  if (l.kind === 'image') return l;
}
/** Hand an active Free Transform over to an advanced session, keeping its frame. */
function fromFreeTransform(e: Editor, mode: Mode, m: typeof import('./session')) {
  const draft = e.transform.document;
  const l = rasterLayer(e);
  if (!draft || !l) return;
  const dl = findLayer(draft.layers, l.id);
  if (!dl) return;
  // A warped embedded object continues from its frame, moved with the draft.
  const frame = effectiveFrame(dl);
  const quad: Quad = frame?.quad ?? transformQuad(dl.transform);
  e.transform.cancel();
  return m.startSession(e, { mode, quad, mesh: frame?.mesh });
}
async function enterMode(e: Editor, mode: Mode) {
  const m = await sessions();
  const s = currentSession();
  if (s) {
    s.setMode(mode);
    return;
  }
  if (e.transform.active) {
    if (affineModes.has(mode)) return;
    if (fromFreeTransform(e, mode, m)) return;
    const l = e.selectedIds.size === 1 ? e.layer : undefined;
    e.message(
      l && (l.kind === 'text' || l.kind === 'vector')
        ? 'Type and shape layers support Scale and Rotate only. Rasterize the layer (Layer > Rasterize) to skew, distort, apply perspective or warp it.'
        : 'Skew, Distort, Perspective and Warp work on a single pixel or image layer.',
    );
    return;
  }
  const l = rasterLayer(e);
  // Scaling and rotating type, shapes, groups and multiple layers stays
  // non-destructive in the layer transform.
  if (affineModes.has(mode) && (!l || l.kind === 'image')) {
    e.setTool('move');
    e.transform.begin();
    return;
  }
  m.startSession(e, { mode });
}

export function installTransform(e: Editor) {
  registerTool({
    id: SESSION_TOOL,
    label: 'Transform',
    icon: 'transform-box',
    // Not a toolbar slot: sessions select this tool while they run.
    group: 'transform-session',
    options: () => currentSession()?.options() ?? '',
    bindOptions: ({ el }) => currentSession()?.bindOptions(el),
    activate: (e) => {
      if (!currentSession()) queueMicrotask(() => e.tool === SESSION_TOOL && e.setTool('move'));
    },
    deactivate: () => currentSession()?.apply(false),
    pointerDown: (_e, p) => currentSession()?.pointerDown(p),
    pointerMove: (_e, p) => currentSession()?.pointerMove(p),
    pointerUp: () => currentSession()?.pointerUp(),
    hover: (e, p) => {
      const s = currentSession();
      s?.hover(p);
      const handle = (p.event.target as Element).closest?.('[data-ts-handle]');
      e.el('#viewport').style.cursor = !s ? '' : handle ? 'pointer' : s.cursor(p);
    },
    keyDown: (e, ev) => {
      const s = currentSession();
      // Keys belong to an open context menu first (Escape closes it).
      if (!s || document.querySelector('.context-menu') || (ev.target as Element).closest?.('.context-menu,.menu-pop')) return false;
      const mod = isMac ? ev.metaKey : ev.ctrlKey;
      if (ev.key === 'Escape' && s.pendingSplit) {
        s.pendingSplit = undefined;
        e.overlay();
      } else if (ev.key === 'Enter') s.apply();
      else if (ev.key === 'Escape') s.cancel();
      else if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'z') {
        if (!s.undo()) s.cancel();
      } else if (!mod && !ev.altKey && ev.key.startsWith('Arrow')) {
        const step = ev.shiftKey ? 10 : 1;
        s.nudge(ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0, ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0);
      } else return false;
      void e;
      return true;
    },
    overlay: () => currentSession()?.overlay() ?? '',
  });

  const hasTarget = (e: Editor) => !!currentSession() || !!e.layer;
  for (const id of ['image.rotate-arbitrary', 'image.image-size', 'image.canvas-size']) recordsSettings(id);
  registerCommand(
    {
      id: 'edit.free-transform',
      label: 'Free Transform',
      shortcut: 'Mod+T',
      enabled: hasTarget,
      recordable: false,
      checked: () => currentSession()?.mode === 'free',
      run: async (e) => {
        const s = currentSession();
        if (s) return s.setMode('free');
        if (e.transform.active) return;
        const l = rasterLayer(e);
        if (l?.kind === 'pixel') (await sessions()).startSession(e, { mode: 'free' });
        else {
          e.setTool('move');
          e.transform.begin();
        }
      },
    },
    ...modeCommands.map(([id, mode, label]) => ({
      id,
      label,
      enabled: hasTarget,
      recordable: false,
      checked: () => currentSession()?.mode === mode,
      run: (e: Editor) => enterMode(e, mode),
    })),
    ...splitCommands.map(([id, action, label]) => ({
      id,
      label,
      enabled: (e: Editor) => {
        const s = currentSession();
        const mesh = s?.mode === 'warp' ? s.mesh : undefined;
        if (action === 'remove') return !!mesh && bezierMesh(mesh) && (meshKnots(mesh, 'u').length > 2 || meshKnots(mesh, 'v').length > 2);
        // A session switches to the (Bezier) warp grid; the 3 x 3 and 5 x 5 grids cannot split.
        return s ? !mesh || bezierMesh(mesh) : !!rasterLayer(e);
      },
      recordable: false,
      checked: () => currentSession()?.pendingSplit === action,
      run: async (e: Editor) => {
        const s = currentSession() ?? (rasterLayer(e) ? (await sessions()).startSession(e, { mode: 'warp' }) : undefined);
        s?.beginSplit(action);
      },
    })),
    {
      id: 'edit.convert-warp-anchor',
      label: 'Convert Warp Anchor Point',
      description: 'Switch the selected warp anchor between smooth and corner (Alt-click an anchor)',
      enabled: () => !!currentSession()?.canConvertAnchor,
      recordable: false,
      run: () => void currentSession()?.convertAnchor(),
    },
    {
      id: 'edit.transform-guides',
      label: 'Show Transform Guides',
      description: 'Divide transform frames into thirds while transforming',
      checked: (e) => e.settings.transformGuides !== false,
      recordable: false,
      run: (e) => {
        e.settings.transformGuides = e.settings.transformGuides === false;
        e.overlay();
      },
    },
    { id: 'edit.rotate-180', label: 'Rotate 180°', enabled: hasTarget, ...lazyRun(layerOps, (m, e) => m.turnLayers(e, 'rotate-180')) },
    { id: 'edit.rotate-cw', label: 'Rotate 90° Clockwise', enabled: hasTarget, ...lazyRun(layerOps, (m, e) => m.turnLayers(e, 'rotate-cw')) },
    { id: 'edit.rotate-ccw', label: 'Rotate 90° Counter Clockwise', enabled: hasTarget, ...lazyRun(layerOps, (m, e) => m.turnLayers(e, 'rotate-ccw')) },
    { id: 'edit.flip-horizontal', label: 'Flip Horizontal', enabled: hasTarget, ...lazyRun(layerOps, (m, e) => m.turnLayers(e, 'flip-horizontal')) },
    { id: 'edit.flip-vertical', label: 'Flip Vertical', enabled: hasTarget, ...lazyRun(layerOps, (m, e) => m.turnLayers(e, 'flip-vertical')) },
    { id: 'edit.transform-again', label: 'Again', shortcut: 'Mod+Shift+T', enabled: (e) => !!e.layer, ...lazyRun(layerOps, (m, e) => m.transformAgain(e)) },
    {
      id: 'select.transform-selection',
      label: 'Transform Selection',
      enabled: (e) => !!e.doc.selection || currentSession()?.target.kind === 'selection',
      recordable: false,
      run: async (e) => {
        if (currentSession()?.target.kind === 'selection') return;
        const m = await sessions();
        e.transform.apply();
        m.startSession(e, { mode: 'free', selection: true });
      },
    },
    { id: 'image.rotate-180', label: '180°', enabled: (e) => e.hasDocument, ...lazyRun(layerOps, (m, e) => m.rotateCanvas(e, 180)) },
    { id: 'image.rotate-cw', label: '90° Clockwise', enabled: (e) => e.hasDocument, ...lazyRun(layerOps, (m, e) => m.rotateCanvas(e, 90)) },
    { id: 'image.rotate-ccw', label: '90° Counter Clockwise', enabled: (e) => e.hasDocument, ...lazyRun(layerOps, (m, e) => m.rotateCanvas(e, -90)) },
    { id: 'image.rotate-arbitrary', label: 'Arbitrary…', enabled: (e) => e.hasDocument, ...lazyRun(layerOps, (m, e, arg) => m.arbitraryRotation(e, arg)) },
    { id: 'image.flip-horizontal', label: 'Flip Canvas Horizontal', enabled: (e) => e.hasDocument, ...lazyRun(layerOps, (m, e) => m.flipCanvas(e, true)) },
    { id: 'image.flip-vertical', label: 'Flip Canvas Vertical', enabled: (e) => e.hasDocument, ...lazyRun(layerOps, (m, e) => m.flipCanvas(e, false)) },
    { id: 'image.image-size', label: 'Image Size…', shortcut: 'Mod+Alt+I', enabled: (e) => e.hasDocument, ...lazyRun(imageSize, (m, e, arg) => m.imageSizeDialog(e, arg)) },
    { id: 'image.canvas-size', label: 'Canvas Size…', shortcut: 'Mod+Alt+C', enabled: (e) => e.hasDocument, ...lazyRun(canvasSize, (m, e, arg) => m.canvasSizeDialog(e, arg)) },
  );
  // The crop tools load when first chosen.
  registerTool(
    lazyTool({ id: 'crop', label: 'Crop Tool', key: 'C', icon: 'crop', group: 'crop' }, lazy(async () => (await crop()).cropTool)),
    lazyTool({ id: 'perspective-crop', label: 'Perspective Crop Tool', key: 'C', icon: 'crop-perspective', group: 'crop' }, lazy(async () => (await crop()).perspectiveCropTool)),
  );
  for (const [id, label] of [
    ['crop.commit', 'Commit Crop'],
    ['crop.cancel', 'Cancel Crop'],
    ['crop.reset', 'Reset Crop'],
    ['perspective-crop.commit', 'Commit Perspective Crop'],
    ['perspective-crop.cancel', 'Cancel Perspective Crop'],
  ])
    registerCommand({ id, label, hidden: true, recordable: false, ...lazyRun(crop, (m, e, arg) => m.cropCommands.find((c) => c.id === id)!.run(e, arg)) });
  prefetchOnIdle(sessions);

  // Baked pixel-layer transforms (Free Transform on groups, canvas rotation)
  // use the interpolation chosen in the transform options bar.
  // The default follows General → Image interpolation (Automatic means bicubic here).
  const preferred = () => (e.preferences.interpolation === 'automatic' ? 'bicubic' : e.preferences.interpolation);
  let lastPreferred = preferred();
  e.settings.transformInterpolation ??= lastPreferred;
  e.preferenceHooks.push(() => {
    if (preferred() === lastPreferred) return;
    lastPreferred = e.settings.transformInterpolation = preferred();
    const size = e.settings.imageSize as { method?: string } | undefined;
    if (size) delete size.method;
  });
  setPixelResampleMethod(samplerInterp(e.settings.transformInterpolation as string));
  e.onUpdate((e) => {
    setPixelResampleMethod(samplerInterp(e.settings.transformInterpolation as string));
    // History moved underneath a session (undo from the menu, another
    // document): its source no longer matches, so drop it.
    const s = currentSession();
    if (s && e.doc !== s.base) s.cancel();
  });

  // Free Transform commits are remembered for Transform Again.
  const ft = e.transform;
  const apply = ft.apply.bind(ft);
  ft.apply = () => {
    const draft = ft.document,
      before = e.doc,
      ids = new Set(e.selectedIds);
    apply();
    if (!draft || e.doc === before) return;
    const a = selectionFrameOf(before, ids),
      b = selectionFrameOf(draft, ids);
    if (a && b && a.width && a.height) recordTransform({ matrix: frameMatrix(a, b) });
  };

  const viewport = e.el('#viewport');
  // Inside Free Transform, Mod-dragging a corner distorts, Mod+Shift skews and
  // Mod+Alt+Shift applies perspective: hand the frame to an advanced session
  // before the pointer reaches the tool, which then receives this drag.
  viewport.addEventListener(
    'pointerdown',
    (ev) => {
      if (ev.button !== 0 || !e.transform.active || e.tool !== 'move' || e.busy) return;
      const mod = isMac ? ev.metaKey : ev.ctrlKey;
      const handle = (ev.target as Element).closest?.('[data-transform-handle]')?.getAttribute('data-transform-handle');
      if (!mod || !handle || handle === 'rotate' || !rasterLayer(e)) return;
      if (sessions.loaded) fromFreeTransform(e, 'free', sessions.loaded);
      else sessions.prefetch();
    },
    true,
  );
  // Right-clicking during a transform lists the transform modes.
  viewport.addEventListener(
    'contextmenu',
    (ev) => {
      if (!currentSession() && !e.transform.active) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      void import('../../app/menubar').then(({ showContextMenu }) => showContextMenu(e, ev.clientX, ev.clientY, transformMenu));
    },
    true,
  );
}
