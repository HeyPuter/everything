// Annotations in the 2D media editors (Image Editor, Movie Clip Editor, sequencer preview): freehand
// strokes, straight lines and polygons drawn over the frame, and an eraser. Strokes live on the
// shown data (the image, the movie clip, the scene for the sequencer) in frame space (0..1, y up),
// so they stay on the picture when the view pans or zooms. D + left drag draws in any of these
// editors, D + right drag erases; the Annotate tools of their toolbars do the same with the left
// button alone.
import { app, type ModalHandler } from '../app/app';
import { h, type Child } from '../ui/h';
import { icon, registerIcons } from '../ui/icons';
import { openMenu, type MenuItem } from '../ui/menu';
import { panel, numberField, colorSwatch, button } from '../ui/widgets';
import { splitRow } from '../ui/props';
import { annotateSettings } from '../editors/view3d/tools3d';
import { eraseAt, type Annotation2DStroke, type Annotation2DOwner } from './annotate2dcore';

export type { Annotation2DStroke, Annotation2DOwner } from './annotate2dcore';
export { eraseAt, segmentDistance } from './annotate2dcore';

registerIcons({
  annotate_line: '<path class="s" d="M3 13L13 3" stroke-width="1.6" stroke-linecap="round"/><circle class="f" cx="3" cy="13" r="1.6"/><circle class="f" cx="13" cy="3" r="1.6"/>',
  annotate_poly: '<path class="s" d="M2.5 12.5L5 4l5.5 2.5 3-3.5" fill="none" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><circle class="f" cx="5" cy="4" r="1.3"/><circle class="f" cx="10.5" cy="6.5" r="1.3"/>',
  annotate_eraser: '<path class="s" d="M6 13.5h7.5M2.8 9.6l6.3-6.3a1.4 1.4 0 0 1 2 0l2.1 2.1a1.4 1.4 0 0 1 0 2l-6.3 6.3H5.4L2.8 11.6a1.4 1.4 0 0 1 0-2z" fill="none" stroke-width="1.2" stroke-linejoin="round"/><path class="f" d="M2.8 9.6l3.2-3.2 4.1 4.1-3.2 3.2H5.4L2.8 11.6a1.4 1.4 0 0 1 0-2z" opacity=".55"/>',
});

/** What an editor provides for annotating. */
export interface Annotate2DHost {
  /** frame space → editor-local screen pixels */
  annToScreen(u: number, v: number): [number, number];
  /** client point → frame space */
  annFromClient(clientX: number, clientY: number): [number, number];
  /** where strokes are kept (`create`: the caller is about to add one) */
  annotationOwner(): Annotation2DOwner | null;
  /** the editor's element (for local coordinates) */
  el: HTMLElement;
  draw(): void;
}

export type AnnotateMode = 'DRAW' | 'DRAW_STRAIGHT' | 'DRAW_POLY' | 'ERASER';
export type AnnotateTool = 'annotate' | 'annotate_line' | 'annotate_polygon' | 'annotate_eraser';

export const ANNOTATE_TOOLS: { id: AnnotateTool; mode: AnnotateMode; label: string; icon: string; tip: string }[] = [
  { id: 'annotate', mode: 'DRAW', label: 'Annotate', icon: 'annotate', tip: 'Draw freehand notes over the picture (Ctrl erases)' },
  { id: 'annotate_line', mode: 'DRAW_STRAIGHT', label: 'Annotate Line', icon: 'annotate_line', tip: 'Drag to draw straight lines (Ctrl erases)' },
  { id: 'annotate_polygon', mode: 'DRAW_POLY', label: 'Annotate Polygon', icon: 'annotate_poly', tip: 'Click to add corners; Enter, a double click or right click finishes (Ctrl erases)' },
  { id: 'annotate_eraser', mode: 'ERASER', label: 'Annotate Eraser', icon: 'annotate_eraser', tip: 'Drag over notes to erase them' },
];
export const isAnnotateTool = (t: string): t is AnnotateTool => ANNOTATE_TOOLS.some((x) => x.id === t);
export const annotateModeOf = (t: AnnotateTool) => ANNOTATE_TOOLS.find((x) => x.id === t)!.mode;

// the D key works as a modifier: held while pressing a mouse button
let dHeld = false;
addEventListener('keydown', (e) => {
  if (e.code === 'KeyD' && !e.ctrlKey && !e.metaKey && !e.altKey) dHeld = true;
});
addEventListener('keyup', (e) => {
  if (e.code === 'KeyD') dHeld = false;
});
addEventListener('blur', () => (dHeld = false));
export const annotateKeyHeld = () => dHeld;

/** Strokes being drawn right now (shown before they are committed). */
const live = new WeakMap<Annotate2DHost, Annotation2DStroke>();

/** Draw the annotations of a host (call while overlays are shown). */
export function drawAnnotations2D(host: Annotate2DHost, g: CanvasRenderingContext2D) {
  const strokes = [...(host.annotationOwner()?.annotations_2d ?? [])];
  const cur = live.get(host);
  if (cur) strokes.push(cur);
  if (!strokes.length) return;
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const s of strokes) {
    if (s.points.length < 2) continue;
    g.strokeStyle = `rgb(${s.color.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255)).join(', ')})`;
    g.lineWidth = Math.max(1, s.thickness);
    g.beginPath();
    for (let i = 0; i < s.points.length; i += 2) {
      const [x, y] = host.annToScreen(s.points[i], s.points[i + 1]);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    if (s.points.length === 2) {
      const [x, y] = host.annToScreen(s.points[0], s.points[1]);
      g.lineTo(x + 0.01, y);
    }
    g.stroke();
  }
  g.restore();
}

function commit(host: Annotate2DHost, s: Annotation2DStroke) {
  live.delete(host);
  const owner = host.annotationOwner();
  if (!owner) return void host.draw();
  if (s.points.length >= 4) {
    owner.annotations_2d = [...(owner.annotations_2d ?? []), s];
    app.pushUndo('Annotate');
    app.changed('doc');
  }
  host.draw();
}

const newStroke = (): Annotation2DStroke => ({ points: [], color: [...annotateSettings.color] as [number, number, number], thickness: annotateSettings.thickness });

/**
 * Start annotating from a pointer press. Returns false when there is nothing to annotate on.
 * Ctrl (or the eraser) erases.
 */
export function annotatePointerDown(host: Annotate2DHost, e: PointerEvent, mode: AnnotateMode): boolean {
  if (!host.annotationOwner()) {
    app.report('INFO', 'Nothing to annotate here: show an image, a clip or a scene first');
    return false;
  }
  if (e.ctrlKey || e.metaKey || e.button === 2) mode = 'ERASER';
  e.preventDefault();
  if (mode === 'ERASER') return startErase(host, e);
  if (mode === 'DRAW_POLY') return startPoly(host, e);
  const s = newStroke();
  const first = host.annFromClient(e.clientX, e.clientY);
  s.points.push(first[0], first[1]);
  live.set(host, s);
  host.draw();
  let lastX = e.clientX,
    lastY = e.clientY;
  const move = (ev: PointerEvent) => {
    const p = host.annFromClient(ev.clientX, ev.clientY);
    if (mode === 'DRAW_STRAIGHT') s.points = [first[0], first[1], p[0], p[1]];
    else {
      if (Math.hypot(ev.clientX - lastX, ev.clientY - lastY) < 2) return;
      s.points.push(p[0], p[1]);
    }
    lastX = ev.clientX;
    lastY = ev.clientY;
    host.draw();
  };
  const up = () => {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    // a click leaves a dot
    if (s.points.length === 2) s.points.push(s.points[0] + 1e-4, s.points[1]);
    commit(host, s);
  };
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
  return true;
}

function startErase(host: Annotate2DHost, e: PointerEvent): boolean {
  const owner = host.annotationOwner()!;
  const strokes = [...(owner.annotations_2d ?? [])].map((s) => ({ ...s, points: [...s.points] }));
  let changed = false;
  const at = (ev: { clientX: number; clientY: number }) => {
    const r = host.el.getBoundingClientRect();
    if (eraseAt(strokes, ev.clientX - r.left, ev.clientY - r.top, annotateSettings.eraserRadius, (u, v) => host.annToScreen(u, v))) {
      changed = true;
      owner.annotations_2d = strokes.map((s) => ({ ...s, points: [...s.points] }));
      host.draw();
    }
  };
  at(e);
  const up = () => {
    removeEventListener('pointermove', at, true);
    removeEventListener('pointerup', up, true);
    if (changed) {
      app.pushUndo('Annotate Erase');
      app.changed('doc');
    }
  };
  addEventListener('pointermove', at, true);
  addEventListener('pointerup', up, true);
  return true;
}

/** Polygon: each click adds a corner; Enter, double click, right click or Esc finishes. */
function startPoly(host: Annotate2DHost, e: PointerEvent): boolean {
  const s = newStroke();
  const p0 = host.annFromClient(e.clientX, e.clientY);
  s.points.push(p0[0], p0[1], p0[0], p0[1]);
  live.set(host, s);
  host.draw();
  let lastClick = performance.now();
  const finish = () => {
    s.points.splice(-2, 2); // the rubber-band corner
    commit(host, s);
  };
  const handler: ModalHandler = {
    label: 'Annotate Polygon',
    cursor: 'crosshair',
    header: () => 'Annotate Polygon: click to add corners, Enter / double click / right click to finish',
    onPointerMove(ev) {
      const p = host.annFromClient(ev.clientX, ev.clientY);
      s.points[s.points.length - 2] = p[0];
      s.points[s.points.length - 1] = p[1];
      host.draw();
    },
    onPointerDown(ev) {
      if (ev.button === 2) return 'FINISHED';
      if (ev.button !== 0) return undefined;
      const now = performance.now();
      if (now - lastClick < 300) return 'FINISHED';
      lastClick = now;
      const p = host.annFromClient(ev.clientX, ev.clientY);
      s.points.push(p[0], p[1]);
      host.draw();
      return undefined;
    },
    onKey(ev) {
      if (ev.type !== 'keydown') return true;
      if (ev.key === 'Enter' || ev.key === 'Escape') return 'FINISHED';
      return true;
    },
    finish,
    cancel: finish,
  };
  app.startModal(handler);
  return true;
}

/** Annotation tool button group for a toolbar (one slot, variants on right click / long press). */
export function annotateToolSlot(current: string, last: AnnotateTool, set: (t: AnnotateTool) => void): Child {
  const on = isAnnotateTool(current);
  const shown = ANNOTATE_TOOLS.find((t) => t.id === (on ? current : last)) ?? ANNOTATE_TOOLS[0];
  const pick = (el: HTMLElement) => openMenu(ANNOTATE_TOOLS.map((t): MenuItem => ({ label: t.label, icon: t.icon, active: t.id === current, action: () => set(t.id) })), el);
  return h(
    'button',
    {
      key: 'annotate',
      class: { 'tb-tool': true, on, 'has-alt': true },
      'data-tool': shown.id,
      'data-tip': `${shown.label}\n${shown.tip}\nD + drag draws and D + right drag erases with any tool`,
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        const el = e.currentTarget as HTMLElement;
        if (e.button === 2 || e.detail > 1) return pick(el);
        set(shown.id);
        const timer = setTimeout(() => pick(el), 350);
        const up = () => (clearTimeout(timer), removeEventListener('pointerup', up));
        addEventListener('pointerup', up);
      },
    },
    icon(shown.icon),
  );
}

/** Sidebar panel: colour and thickness of new notes, and clearing them. */
export function annotationsPanel(key: string, host: Annotate2DHost): Child {
  return panel(`${key}-annotations`, 'Annotations', () => {
    const owner = host.annotationOwner();
    const n = owner?.annotations_2d?.length ?? 0;
    return [
      splitRow('Color', colorSwatch(`${key}-ann-color`, annotateSettings.color, (v) => ((annotateSettings.color = [v[0], v[1], v[2]]), app.changed('ui')))),
      splitRow('Thickness', numberField({ id: `${key}-ann-thick`, value: annotateSettings.thickness, int: true, min: 1, max: 20, unit: 'pixel', set: (v) => (annotateSettings.thickness = v) })),
      h('div', { class: 'sb-hint' }, owner ? `${n} note${n === 1 ? '' : 's'}` : 'Nothing shown to annotate'),
      h(
        'div',
        { class: 'btn-col' },
        button(`${key}-ann-clear`, 'Clear Annotations', () => {
          if (!owner || !n) return;
          owner.annotations_2d = [];
          app.pushUndo('Clear Annotations');
          app.changed('doc');
          host.draw();
        }),
      ),
    ];
  });
}
