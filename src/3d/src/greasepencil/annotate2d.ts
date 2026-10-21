// Annotations in the node editors (Shader, Geometry, Compositor): hold D and drag to draw (Alt: a
// straight line, Shift Alt: a poly line), hold D and right drag to erase. Strokes are stored with
// the node tree in node-space coordinates, so they follow panning and zooming. An overlay per editor
// draws them. The Image, Movie Clip, UV and Sequencer views have their own (mask/annotate2d.ts).
import { app } from '../app/app';
import { shell } from '../ui/shell';
import { h, patch, type VNode } from '../ui/h';
import { activeAnnotationLayer, annotateSettings, type AnnotationStroke, type AnnotationArrow } from '../editors/view3d/tools3d';
import { annotateTool, arrowShape, eraseInCircle, stabilize, annotateKeyHeld } from './annotate';

/** How an editor maps its data coordinates to its element's pixels. */
interface Host2D {
  /** object that keeps the strokes (null: nothing to annotate) */
  owner(): Record<string, unknown> | null;
  /** client pixels → data coordinates */
  toData(clientX: number, clientY: number): [number, number];
  /** data coordinates → pixels relative to the editor element */
  toView(x: number, y: number): [number, number];
}

type AnyEditor = Record<string, unknown> & { el: HTMLElement };

const NODE_EDITORS = new Set(['SHADER', 'GEOMETRY', 'COMPOSITOR']);

function hostOf(type: string, ed: AnyEditor): Host2D | null {
  if (NODE_EDITORS.has(type) && typeof ed.toNode === 'function' && typeof ed.toScreen === 'function' && typeof ed.tree === 'function') {
    const e = ed as AnyEditor & { toNode(x: number, y: number): [number, number]; toScreen(x: number, y: number): [number, number]; tree(): Record<string, unknown> | null };
    return { owner: () => e.tree(), toData: (x, y) => e.toNode(x, y), toView: (x, y) => e.toScreen(x, y) };
  }
  return null;
}

/** Key of the stroke list on the node tree. */
const KEY = 'annotation_strokes_2d';
const strokesOf = (owner: Record<string, unknown>): AnnotationStroke[] => (owner[KEY] as AnnotationStroke[] | undefined) ?? [];

// ---------------------------------------------------------------------------
// overlays

const overlays = new WeakMap<HTMLElement, { el: HTMLElement; sig: string }>();
let preview: { el: HTMLElement; host: Host2D; pts: number[]; color: number[]; thickness: number; arrowEnd?: AnnotationArrow; arrowStart?: AnnotationArrow; rubber?: [number, number] } | null = null;
let eraser: { el: HTMLElement; x: number; y: number } | null = null;

const rgbCss = (c: number[]) => `rgb(${c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255)).join(',')})`;

function strokeNodes(host: Host2D, pts: number[], color: number[], thickness: number, a0?: AnnotationArrow, a1?: AnnotationArrow, out: VNode[] = []) {
  const scr: [number, number][] = [];
  for (let i = 0; i < pts.length; i += 3) scr.push(host.toView(pts[i], pts[i + 1]));
  if (!scr.length) return out;
  const col = rgbCss(color);
  if (scr.length === 1) out.push(h('circle', { cx: scr[0][0], cy: scr[0][1], r: thickness / 2, fill: col }));
  else
    out.push(
      h('polyline', {
        points: scr.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' '),
        fill: 'none',
        stroke: col,
        'stroke-width': thickness,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    );
  const size = Math.max(9, thickness * 3.5);
  if (scr.length > 1)
    for (const [style, tip, from] of [
      [a1, scr[scr.length - 1], scr[scr.length - 2]],
      [a0, scr[0], scr[1]],
    ] as const) {
      const sh = arrowShape(style, { x: tip[0], y: tip[1] }, tip[0] - from[0], tip[1] - from[1], size);
      if (!sh) continue;
      const d = sh.pts.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' ');
      out.push(
        sh.kind === 'fill'
          ? h('polygon', { points: d, fill: col, stroke: col, 'stroke-width': 1 })
          : h('polyline', { points: d, fill: 'none', stroke: col, 'stroke-width': thickness, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      );
    }
  return out;
}

function liveHosts(): { el: HTMLElement; host: Host2D }[] {
  const out: { el: HTMLElement; host: Host2D }[] = [];
  for (const a of shell?.screen?.areas ?? []) {
    const ed = a.editor as unknown as AnyEditor;
    if (!ed?.el) continue;
    const host = hostOf(a.type, ed);
    if (host) out.push({ el: ed.el, host });
  }
  return out;
}

/** Draw the overlays that changed; true while some editor shows annotations (keep following its view). */
function renderOverlays(): boolean {
  let busy = !!preview || !!eraser;
  for (const { el, host } of liveHosts()) {
    const owner = host.owner();
    const list = owner ? strokesOf(owner) : [];
    if (list.length) busy = true;
    const p0 = host.toView(0, 0),
      p1 = host.toView(100, 100);
    const sig = `${p0.join(',')}|${p1.join(',')}|${el.clientWidth}x${el.clientHeight}|${list.length}|${aidOf(list)}|${preview?.el === el ? `p${preview.pts.length}${preview.rubber ?? ''}` : ''}|${eraser?.el === el ? `${eraser.x},${eraser.y}` : ''}`;
    let ov = overlays.get(el);
    if (ov && ov.sig === sig) continue;
    if (!list.length && !ov && preview?.el !== el) continue;
    if (!ov) {
      const d = document.createElement('div');
      d.className = 'gp-annot2d';
      el.append(d);
      overlays.set(el, (ov = { el: d, sig: '' }));
    }
    if (!ov.el.isConnected) el.append(ov.el);
    ov.sig = sig;
    const parts: VNode[] = [];
    for (const s of list) strokeNodes(host, s.points, s.color, s.thickness, s.arrow_start, s.arrow_end, parts);
    if (preview?.el === el) {
      strokeNodes(host, preview.pts, preview.color, preview.thickness, preview.arrowStart, preview.arrowEnd, parts);
      if (preview.rubber && preview.pts.length >= 3) {
        const n = preview.pts.length;
        const a = host.toView(preview.pts[n - 3], preview.pts[n - 2]),
          b = host.toView(preview.rubber[0], preview.rubber[1]);
        parts.push(h('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: rgbCss(preview.color), 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }));
      }
    }
    if (eraser?.el === el) parts.push(h('circle', { cx: eraser.x, cy: eraser.y, r: annotateSettings.eraserRadius, fill: 'none', stroke: '#ffffff', 'stroke-width': 1, opacity: 0.8 }));
    patch(ov.el, [h('svg', { width: '100%', height: '100%' }, parts)]);
  }
  return busy;
}

const ids = new WeakMap<object, number>();
let nextId = 1;
function aidOf(o: object) {
  let i = ids.get(o);
  if (!i) ids.set(o, (i = nextId++));
  return i;
}

// every frame while annotations are shown (they follow pans and zooms), else a slow check
let raf = 0,
  idle = 0;
function loop() {
  raf = 0;
  idle = 0;
  let busy = true;
  try {
    busy = renderOverlays();
  } catch {
    // an editor in transition (being replaced): try again next frame
  }
  if (busy) kick();
  else idle = window.setTimeout(loop, 300);
}
function kick() {
  if (idle) window.clearTimeout(idle);
  idle = 0;
  if (!raf && typeof requestAnimationFrame !== 'undefined') raf = requestAnimationFrame(loop);
}
if (typeof window !== 'undefined') kick();

// ---------------------------------------------------------------------------
// drawing

function hostAt(clientX: number, clientY: number): { el: HTMLElement; host: Host2D } | null {
  for (const x of liveHosts()) {
    const r = x.el.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return x;
  }
  return null;
}

function start2D(e: PointerEvent, mode: 'DRAW' | 'DRAW_STRAIGHT' | 'DRAW_POLY' | 'ERASER'): boolean {
  const hit = hostAt(e.clientX, e.clientY);
  if (!hit) return false;
  kick();
  const owner = hit.host.owner();
  if (!owner) return false;
  const { el, host } = hit;
  const before = strokesOf(owner);
  const layer = activeAnnotationLayer(false);
  const look = { color: [...(layer?.color ?? annotateSettings.color)], thickness: layer?.thickness ?? annotateSettings.thickness };
  const r = el.getBoundingClientRect();
  const finish = (label: string, list: AnnotationStroke[] | null) => {
    preview = null;
    eraser = null;
    if (list) {
      owner[KEY] = list;
      app.pushUndo(label);
    }
    app.changed('doc');
  };
  if (mode === 'ERASER') {
    let cur = before;
    let changed = false;
    const erase = (ev: PointerEvent) => {
      const x = ev.clientX - r.left,
        y = ev.clientY - r.top;
      eraser = { el, x, y };
      const out = eraseInCircle(
        cur,
        (p) => {
          const q = host.toView(p[0], p[1]);
          return { x: q[0], y: q[1], z: 0 };
        },
        x,
        y,
        annotateSettings.eraserRadius,
        () => false,
      );
      if (out) {
        cur = out;
        owner[KEY] = cur;
        changed = true;
      }
    };
    erase(e);
    const up = () => {
      removeEventListener('pointermove', erase, true);
      removeEventListener('pointerup', up, true);
      finish('Annotation Erase', changed ? cur : null);
    };
    addEventListener('pointermove', erase, true);
    addEventListener('pointerup', up, true);
    return true;
  }
  const pts: number[] = [];
  const at = (ev: { clientX: number; clientY: number }) => host.toData(ev.clientX, ev.clientY);
  const p0 = at(e);
  pts.push(p0[0], p0[1], 0);
  preview = { el, host, pts, ...look };
  if (mode === 'DRAW_STRAIGHT') {
    pts.push(p0[0], p0[1], 0);
    preview.arrowStart = annotateTool.arrow_start;
    preview.arrowEnd = annotateTool.arrow_end;
  }
  if (mode === 'DRAW_POLY') {
    preview.rubber = p0;
    const move = (ev: PointerEvent) => preview && (preview.rubber = at(ev));
    const down = (ev: PointerEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (ev.button === 2) return done(true);
      const q = at(ev);
      pts.push(q[0], q[1], 0);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') done(true);
      else if (ev.key === 'Escape') done(false);
      else return;
      ev.stopPropagation();
      ev.preventDefault();
    };
    const done = (ok: boolean) => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerdown', down, true);
      removeEventListener('keydown', key, true);
      finish('Annotate', ok && pts.length >= 6 ? [...before, { points: pts.slice(), ...look } as AnnotationStroke] : null);
    };
    addEventListener('pointermove', move, true);
    // the press that started the poly line is still in flight: listen for the next ones
    setTimeout(() => addEventListener('pointerdown', down, true));
    addEventListener('keydown', key, true);
    return true;
  }
  let lazy = { x: e.clientX, y: e.clientY };
  const move = (ev: PointerEvent) => {
    if (mode === 'DRAW_STRAIGHT') {
      const q = at(ev);
      pts.splice(3, 3, q[0], q[1], 0);
      return;
    }
    let c = { x: ev.clientX, y: ev.clientY };
    if (annotateTool.use_stabilizer) {
      c = stabilize(lazy, c, annotateTool.stabilizer_radius, annotateTool.stabilizer_factor);
      if (c === lazy) return;
      lazy = c;
    }
    const q = host.toData(c.x, c.y);
    pts.push(q[0], q[1], 0);
  };
  const up = () => {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    const ok = pts.length >= 6 && (mode !== 'DRAW_STRAIGHT' || pts[0] !== pts[3] || pts[1] !== pts[4]);
    const st: AnnotationStroke = { points: pts.slice(), ...look } as AnnotationStroke;
    if (mode === 'DRAW_STRAIGHT') {
      if (annotateTool.arrow_start !== 'NONE') st.arrow_start = annotateTool.arrow_start;
      if (annotateTool.arrow_end !== 'NONE') st.arrow_end = annotateTool.arrow_end;
    }
    finish('Annotate', ok ? [...before, st] : null);
  };
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
  return true;
}

// D held over a 2D editor: annotate (capture phase, before the editor's own handlers)
if (typeof window !== 'undefined')
  addEventListener(
    'pointerdown',
    (e) => {
      if (!annotateKeyHeld() || app.modal) return;
      const mode = e.button === 2 ? 'ERASER' : e.button === 0 ? (e.altKey ? (e.shiftKey ? 'DRAW_POLY' : 'DRAW_STRAIGHT') : 'DRAW') : null;
      if (!mode) return;
      if (start2D(e, mode)) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true,
  );
// right drag erasing must not open the editors' context menus
if (typeof window !== 'undefined') addEventListener('contextmenu', (e) => annotateKeyHeld() && hostAt(e.clientX, e.clientY) && (e.preventDefault(), e.stopPropagation()), true);
