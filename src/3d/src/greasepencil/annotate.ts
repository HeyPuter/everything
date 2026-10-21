// Annotations in the 3D Viewport: the Annotate tools (freehand, line with arrow heads, polygon,
// eraser), the gpencil.annotate operator behind them (also scriptable with a `stroke` list) and
// the D shortcut (hold D: drag to draw, Alt for lines, Shift Alt for polygons, right drag erases).
// Strokes live on the scene (scene.annotations, see editors/view3d/tools3d.ts).
import { Vector3 } from 'three';
import { app, registerOperators, type OpContext } from '../app/app';
import { activeTools } from '../app/prefs';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { toolSettingsRenderers, COMMON_TOOLS, toolsByMode, extraToolLists, type ToolDef } from '../editors/view3d/toolbar';
import { activeAnnotationLayer, annotateSettings, strokeLook, placePoint, type AnnotationStroke, type AnnotationArrow } from '../editors/view3d/tools3d';
import { h, type VNode } from '../ui/h';
import { registerIcons } from '../ui/icons';
import { checkbox, colorSwatch, enumMenu, numberField, opButton } from '../ui/widgets';
import type { SceneData } from '../data/types';

registerIcons({
  annotate_line: '<path class="s" d="M2.5 13.5 12 4" stroke-width="1.6" stroke-linecap="round"/><path class="f" d="M14 2l-1 5-4-4z"/><circle class="f" cx="2.5" cy="13.5" r="1.3"/>',
  annotate_polygon:
    '<path class="s" d="M2.5 12.5 5 3.5l5.5 3 3-2.5L12 13z" fill="none" stroke-width="1.4" stroke-linejoin="round"/><circle class="f" cx="5" cy="3.5" r="1.3"/><circle class="f" cx="10.5" cy="6.5" r="1.3"/><circle class="f" cx="12" cy="13" r="1.3"/>',
  annotate_eraser:
    '<path class="f" d="M9.4 2.6 13.8 7 9 11.8H5.8L2.6 8.6z" opacity=".35"/><path class="s" d="M9.4 2.6 13.8 7 9 11.8H5.8L2.6 8.6zM6 5.9l4.3 4.3" fill="none" stroke-width="1.2" stroke-linejoin="round"/><path class="s" d="M10 13.5h4" stroke-width="1.2" stroke-linecap="round"/>',
});

type SceneExt = SceneData & {
  annotations?: AnnotationStroke[];
  annotation_layers?: {
    name: string;
    lock: boolean;
    annotation_hide: boolean;
  }[];
};
const scene = () => app.doc.scene as SceneExt;

export type AnnotateMode = 'DRAW' | 'DRAW_STRAIGHT' | 'DRAW_POLY' | 'ERASER';

/** Per tool settings of the Annotate tools. */
export const annotateTool = {
  arrow_start: 'NONE' as AnnotationArrow,
  arrow_end: 'NONE' as AnnotationArrow,
  use_stabilizer: false,
  stabilizer_radius: 35,
  stabilizer_factor: 0.75,
};

const ARROWS: [string, string, string][] = [
  ['NONE', 'None', 'No decoration'],
  ['ARROW', 'Arrow', 'A filled arrow head'],
  ['ARROW_OPEN', 'Open Arrow', 'An open arrow head'],
  ['ARROW_OPEN_INVERTED', 'Segment', 'A short bar across the end'],
  ['DIAMOND', 'Square', 'A square on the end'],
];

const rgbCss = (c: number[]) => `rgb(${c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255)).join(',')})`;

// ---------------------------------------------------------------------------
// pure helpers

/** Screen-space arrow head polygons / lines at `tip`, pointing along (dx, dy). */
export function arrowShape(style: AnnotationArrow | undefined, tip: { x: number; y: number }, dx: number, dy: number, size: number): { kind: 'fill' | 'line'; pts: [number, number][] } | null {
  if (!style || style === 'NONE') return null;
  const l = Math.hypot(dx, dy);
  if (l < 1e-6) return null;
  const ux = dx / l,
    uy = dy / l;
  const nx = -uy,
    ny = ux;
  const back = (k: number, side: number): [number, number] => [tip.x - ux * size * k + nx * size * side, tip.y - uy * size * k + ny * size * side];
  switch (style) {
    case 'ARROW':
      return {
        kind: 'fill',
        pts: [[tip.x + ux * size * 0.15, tip.y + uy * size * 0.15], back(1, 0.55), back(1, -0.55)],
      };
    case 'ARROW_OPEN':
      return {
        kind: 'line',
        pts: [back(1, 0.6), [tip.x, tip.y], back(1, -0.6)],
      };
    case 'ARROW_OPEN_INVERTED':
      return { kind: 'line', pts: [back(0, 0.6), back(0, -0.6)] };
    case 'DIAMOND': {
      const s = size * 0.45;
      return {
        kind: 'fill',
        pts: [
          [tip.x + ux * s + nx * s, tip.y + uy * s + ny * s],
          [tip.x - ux * s + nx * s, tip.y - uy * s + ny * s],
          [tip.x - ux * s - nx * s, tip.y - uy * s - ny * s],
          [tip.x + ux * s - nx * s, tip.y + uy * s - ny * s],
        ],
      };
    }
  }
  return null;
}

/**
 * Erase the parts of strokes inside a screen circle: segments are cut where they enter and leave
 * it, pieces with fewer than two points are dropped. `screen` maps a world point index of a
 * stroke to pixels. Returns null when nothing changed.
 */
export function eraseInCircle(
  strokes: AnnotationStroke[],
  screen: (p: number[]) => { x: number; y: number; z: number },
  cx: number,
  cy: number,
  r: number,
  skip: (s: AnnotationStroke) => boolean,
): AnnotationStroke[] | null {
  let changed = false;
  const out: AnnotationStroke[] = [];
  const r2 = r * r;
  for (const s of strokes) {
    if (skip(s)) {
      out.push(s);
      continue;
    }
    const n = s.points.length / 3;
    const P = (i: number) => [s.points[i * 3], s.points[i * 3 + 1], s.points[i * 3 + 2]];
    const S = Array.from({ length: n }, (_, i) => screen(P(i)));
    const inside = S.map((q) => q.z <= 1 && (q.x - cx) ** 2 + (q.y - cy) ** 2 <= r2);
    const pieces: number[][] = [];
    let cur: number[] = [];
    const flush = () => {
      if (cur.length >= 6) pieces.push(cur);
      cur = [];
    };
    let hit = inside.some(Boolean);
    for (let i = 0; i < n; i++) {
      if (!inside[i]) cur.push(...P(i));
      if (i + 1 >= n) break;
      // intersections of segment i → i+1 with the circle (screen space, linear in world)
      const a = S[i],
        b = S[i + 1];
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const fx = a.x - cx,
        fy = a.y - cy;
      const A = dx * dx + dy * dy,
        B = 2 * (fx * dx + fy * dy),
        C = fx * fx + fy * fy - r2;
      const disc = B * B - 4 * A * C;
      if (A < 1e-9 || disc <= 0) {
        if (inside[i] !== inside[i + 1]) flush();
        continue;
      }
      const sq = Math.sqrt(disc);
      const t0 = (-B - sq) / (2 * A),
        t1 = (-B + sq) / (2 * A);
      const pa = P(i),
        pb = P(i + 1);
      const at = (t: number) => [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
      if (!inside[i] && t0 > 0 && t0 < 1) {
        cur.push(...at(t0));
        flush();
        hit = true;
      } else if (inside[i] !== inside[i + 1]) flush();
      if (!inside[i + 1] && t1 > 0 && t1 < 1) {
        flush();
        cur.push(...at(t1));
        hit = true;
      }
    }
    flush();
    if (!hit) {
      out.push(s);
      continue;
    }
    changed = true;
    pieces.forEach((pts, k) =>
      out.push({
        ...s,
        points: pts,
        ...(k > 0 ? { arrow_start: 'NONE' as AnnotationArrow } : {}),
        ...(k < pieces.length - 1 ? { arrow_end: 'NONE' as AnnotationArrow } : {}),
      }),
    );
  }
  return changed ? out : null;
}

/** Lazy-mouse stabilizer: the drawn point trails the pointer by `radius` pixels, eased by `factor`. */
export function stabilize(prev: { x: number; y: number }, target: { x: number; y: number }, radius: number, factor: number): { x: number; y: number } {
  const dx = target.x - prev.x,
    dy = target.y - prev.y;
  const d = Math.hypot(dx, dy);
  if (d <= radius) return prev;
  const move = (d - radius) * (1 - Math.min(0.95, Math.max(0, factor)) * 0.5);
  return { x: prev.x + (dx / d) * move, y: prev.y + (dy / d) * move };
}

// ---------------------------------------------------------------------------
// drawing

let preview: {
  pts: number[];
  color: number[];
  thickness: number;
  arrowStart?: AnnotationArrow;
  arrowEnd?: AnnotationArrow;
  rubber?: { x: number; y: number };
} | null = null;
let eraserAt: { x: number; y: number } | null = null;
let hoverEraser: { x: number; y: number } | null = null;

function strokeSvg(v: View3D, pts: number[], color: number[], thickness: number, opacity: number, aStart?: AnnotationArrow, aEnd?: AnnotationArrow, out: VNode[] = []): VNode[] {
  const scr: { x: number; y: number }[] = [];
  const p = new Vector3();
  for (let i = 0; i < pts.length; i += 3) {
    const q = v.project(p.set(pts[i], pts[i + 1], pts[i + 2]));
    if (q.z > 1) continue;
    scr.push({ x: q.x, y: q.y });
  }
  if (scr.length < 1) return out;
  const col = rgbCss(color);
  if (scr.length === 1)
    out.push(
      h('circle', {
        cx: scr[0].x,
        cy: scr[0].y,
        r: Math.max(1, thickness / 2),
        fill: col,
        'fill-opacity': opacity,
      }),
    );
  else
    out.push(
      h('polyline', {
        points: scr.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' '),
        fill: 'none',
        stroke: col,
        'stroke-width': thickness,
        'stroke-opacity': opacity,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    );
  const size = Math.max(9, thickness * 3.5);
  const ends: [AnnotationArrow | undefined, { x: number; y: number }, { x: number; y: number } | undefined][] = [
    [aEnd, scr[scr.length - 1], scr.length > 1 ? farBack(scr, scr.length - 1, -1, size) : undefined],
    [aStart, scr[0], scr.length > 1 ? farBack(scr, 0, 1, size) : undefined],
  ];
  for (const [style, tip, from] of ends) {
    if (!from) continue;
    const sh = arrowShape(style, tip, tip.x - from.x, tip.y - from.y, size);
    if (!sh) continue;
    const d = sh.pts.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' ');
    out.push(
      sh.kind === 'fill'
        ? h('polygon', {
            points: d,
            fill: col,
            'fill-opacity': opacity,
            stroke: col,
            'stroke-width': 1,
            'stroke-linejoin': 'round',
          })
        : h('polyline', {
            points: d,
            fill: 'none',
            stroke: col,
            'stroke-width': thickness,
            'stroke-opacity': opacity,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
          }),
    );
  }
  return out;
}

/** A point some pixels back along the polyline from index i (for a stable arrow direction). */
function farBack(scr: { x: number; y: number }[], i: number, step: number, dist: number) {
  let j = i + step;
  while (j > 0 && j < scr.length - 1 && Math.hypot(scr[j].x - scr[i].x, scr[j].y - scr[i].y) < dist * 0.5) j += step;
  return scr[Math.max(0, Math.min(scr.length - 1, j))];
}

editModeHooks.svg.push((v) => {
  const parts: VNode[] = [];
  if (v.overlay.show_overlays && v.overlay.show_annotation !== false)
    for (const s of scene().annotations ?? []) {
      const look = strokeLook(s);
      if (look) strokeSvg(v, s.points, look.color, look.thickness, look.opacity, s.arrow_start, s.arrow_end, parts);
    }
  if (preview) {
    strokeSvg(v, preview.pts, preview.color, preview.thickness, 1, preview.arrowStart, preview.arrowEnd, parts);
    if (preview.rubber && preview.pts.length >= 3) {
      const n = preview.pts.length;
      const a = v.project(new Vector3(preview.pts[n - 3], preview.pts[n - 2], preview.pts[n - 1]));
      parts.push(
        h('line', {
          x1: a.x,
          y1: a.y,
          x2: preview.rubber.x,
          y2: preview.rubber.y,
          stroke: rgbCss(preview.color),
          'stroke-width': Math.max(1, preview.thickness * 0.6),
          'stroke-dasharray': '4 3',
          opacity: 0.8,
        }),
      );
    }
  }
  const er = eraserAt ?? (activeTools[app.doc.mode] === 'builtin.annotate_eraser' ? hoverEraser : null);
  if (er)
    parts.push(
      h('circle', {
        cx: er.x,
        cy: er.y,
        r: annotateSettings.eraserRadius,
        fill: 'none',
        stroke: '#ffffff',
        'stroke-width': 1,
        opacity: 0.8,
      }),
    );
  return parts.length ? h('g', { class: 'annotations' }, parts) : null;
});

editModeHooks.hover.push((v, e) => {
  if (activeTools[app.doc.mode] !== 'builtin.annotate_eraser') {
    hoverEraser = null;
    return;
  }
  hoverEraser = v.local(e);
  v.drawSvg();
});

// ---------------------------------------------------------------------------
// operator

function lockedLayers(): Set<string> {
  return new Set((scene().annotation_layers ?? []).filter((l) => l.lock || l.annotation_hide).map((l) => l.name));
}

function eraseAt(v: View3D, x: number, y: number): boolean {
  const sc = scene();
  const locked = lockedLayers();
  const p = new Vector3();
  const out = eraseInCircle(
    sc.annotations ?? [],
    (q) => v.project(p.set(q[0], q[1], q[2])),
    x,
    y,
    annotateSettings.eraserRadius,
    (s) => !!s.layer && locked.has(s.layer),
  );
  if (!out) return false;
  sc.annotations = out;
  return true;
}

function addStroke(pts: number[], arrows: { arrow_start?: AnnotationArrow; arrow_end?: AnnotationArrow } = {}): boolean {
  if (pts.length < 3) return false;
  const layer = activeAnnotationLayer(true);
  if (layer?.lock) {
    app.report('WARNING', `Annotation layer "${layer.name}" is locked`);
    return false;
  }
  const sc = scene();
  const st: AnnotationStroke = {
    points: pts,
    color: [...(layer?.color ?? annotateSettings.color)] as [number, number, number],
    thickness: layer?.thickness ?? annotateSettings.thickness,
    layer: layer?.name,
  };
  if (arrows.arrow_start && arrows.arrow_start !== 'NONE') st.arrow_start = arrows.arrow_start;
  if (arrows.arrow_end && arrows.arrow_end !== 'NONE') st.arrow_end = arrows.arrow_end;
  sc.annotations = [...(sc.annotations ?? []), st];
  return true;
}

/** Stroke elements given to the operator: world `location`s or viewport `mouse` pixels. */
function strokeFromProp(v: View3D | null, list: unknown): number[] {
  const out: number[] = [];
  if (!Array.isArray(list)) return out;
  for (const el of list) {
    const e = el as { location?: number[]; mouse?: number[] };
    if (Array.isArray(e.location) && e.location.length >= 3) out.push(+e.location[0], +e.location[1], +e.location[2]);
    else if (v && Array.isArray(e.mouse) && e.mouse.length >= 2) {
      const q = placePoint(v, +e.mouse[0], +e.mouse[1], annotateSettings.placement);
      out.push(q.x, q.y, q.z);
    }
  }
  return out;
}

function annotateInvoke(ctx: OpContext, p: Record<string, unknown>) {
  const v = activeView3D();
  if (!v) return 'CANCELLED' as const;
  const mode = p.mode as AnnotateMode;
  const r = v.el.getBoundingClientRect();
  const ev = ctx.event ?? app.pointer;
  const local = (e: { clientX: number; clientY: number }) => ({
    x: e.clientX - r.left,
    y: e.clientY - r.top,
  });
  const before = scene().annotations;
  const restore = () => {
    scene().annotations = before;
    preview = null;
    eraserAt = null;
    app.changed('doc');
  };
  const layer = mode === 'ERASER' ? null : activeAnnotationLayer(true);
  if (layer?.lock) {
    app.report('WARNING', `Annotation layer "${layer.name}" is locked`);
    return 'CANCELLED' as const;
  }
  const look = {
    color: [...(layer?.color ?? annotateSettings.color)],
    thickness: layer?.thickness ?? annotateSettings.thickness,
  };
  const place = (x: number, y: number) => placePoint(v, x, y, annotateSettings.placement);
  const start = { x: ev.x - r.left, y: ev.y - r.top };
  const pts: number[] = [];
  const recorded: { location: number[] }[] = [];
  const push = (x: number, y: number) => {
    const q = place(x, y);
    pts.push(q.x, q.y, q.z);
  };
  const redo = () => ({
    idname: 'gpencil.annotate',
    props: {
      ...p,
      wait_for_input: false,
      stroke: pts.length
        ? Array.from({ length: pts.length / 3 }, (_, i) => ({
            location: pts.slice(i * 3, i * 3 + 3),
          }))
        : recorded,
    },
  });

  if (mode === 'ERASER') {
    let erased = false;
    eraserAt = start;
    erased = eraseAt(v, start.x, start.y) || erased;
    app.changed('doc');
    app.startModal({
      label: 'Annotation Erase',
      onPointerMove(e) {
        const q = local(e);
        eraserAt = q;
        if (eraseAt(v, q.x, q.y)) erased = true;
        app.changed('doc');
      },
      onPointerUp: () => (erased ? 'FINISHED' : 'CANCELLED'),
      onKey: (e) => (e.key === 'Escape' ? 'CANCELLED' : undefined),
      cancel: restore,
      finish: () => {
        eraserAt = null;
      },
      status: () => [['LMB', 'Erase']],
    });
    return 'RUNNING_MODAL' as const;
  }

  if (mode === 'DRAW') {
    const stab = !!p.use_stabilizer;
    let lazy = { ...start };
    push(start.x, start.y);
    preview = { pts, ...look };
    app.changed('ui');
    app.startModal({
      label: 'Annotate',
      onPointerMove(e) {
        let q = local(e);
        if (stab) {
          q = stabilize(lazy, q, p.stabilizer_radius as number, p.stabilizer_factor as number);
          if (q === lazy) return;
          lazy = q;
        }
        push(q.x, q.y);
        app.changed('ui');
      },
      onPointerUp() {
        if (stab) push(lazy.x, lazy.y);
        preview = null;
        return addStroke(pts) ? 'FINISHED' : 'CANCELLED';
      },
      onKey: (e) => (e.key === 'Escape' ? 'CANCELLED' : undefined),
      cancel: restore,
    });
    const m = app.modal as { redoOp?: unknown } | null;
    if (m) Object.defineProperty(m, 'redoOp', { get: redo });
    return 'RUNNING_MODAL' as const;
  }

  if (mode === 'DRAW_STRAIGHT') {
    const a = place(start.x, start.y);
    pts.push(a.x, a.y, a.z, a.x, a.y, a.z);
    preview = {
      pts,
      ...look,
      arrowStart: p.arrowstyle_start as AnnotationArrow,
      arrowEnd: p.arrowstyle_end as AnnotationArrow,
    };
    let moved = false;
    app.startModal({
      label: 'Annotate',
      onPointerMove(e) {
        const q = local(e);
        if (Math.hypot(q.x - start.x, q.y - start.y) > 2) moved = true;
        const b = place(q.x, q.y);
        pts.splice(3, 3, b.x, b.y, b.z);
        app.changed('ui');
      },
      onPointerUp() {
        preview = null;
        if (!moved) return 'CANCELLED';
        return addStroke(pts, {
          arrow_start: p.arrowstyle_start as AnnotationArrow,
          arrow_end: p.arrowstyle_end as AnnotationArrow,
        })
          ? 'FINISHED'
          : 'CANCELLED';
      },
      onKey: (e) => (e.key === 'Escape' ? 'CANCELLED' : undefined),
      cancel: restore,
    });
    const m = app.modal as { redoOp?: unknown } | null;
    if (m) Object.defineProperty(m, 'redoOp', { get: redo });
    return 'RUNNING_MODAL' as const;
  }

  // DRAW_POLY: clicks add points; Enter, right click or a double click finish
  push(start.x, start.y);
  preview = { pts, ...look, rubber: start };
  let lastClick = performance.now();
  let lastPos = start;
  const finish = () => {
    preview = null;
    return addStroke(pts) ? ('FINISHED' as const) : ('CANCELLED' as const);
  };
  app.startModal({
    label: 'Annotate',
    onPointerMove(e) {
      if (preview) preview.rubber = local(e);
      app.changed('ui');
    },
    onPointerDown(e) {
      if (e.button === 2) return finish();
      if (e.button !== 0) return;
      const q = local(e);
      const now = performance.now();
      if (now - lastClick < 350 && Math.hypot(q.x - lastPos.x, q.y - lastPos.y) < 6) return finish();
      lastClick = now;
      lastPos = q;
      push(q.x, q.y);
      app.changed('ui');
    },
    onKey(e) {
      if (e.key === 'Enter' || e.key === ' ') return finish();
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Backspace' && pts.length > 3) {
        pts.splice(pts.length - 3, 3);
        app.changed('ui');
        return true;
      }
    },
    cancel: restore,
    status: () => [
      ['LMB', 'Add Point'],
      ['Enter / RMB / Double Click', 'Confirm'],
      ['Backspace', 'Remove Last'],
      ['Esc', 'Cancel'],
    ],
  });
  const m = app.modal as { redoOp?: unknown } | null;
  if (m) Object.defineProperty(m, 'redoOp', { get: redo });
  return 'RUNNING_MODAL' as const;
}

registerOperators([
  {
    idname: 'gpencil.annotate',
    label: 'Annotation Draw',
    description: 'Draw notes over the scene: free hand, straight lines, polygons, or erase them',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'DRAW',
        items: [
          ['DRAW', 'Draw Freehand', 'Draw freely with the pointer'],
          ['DRAW_STRAIGHT', 'Draw Straight Lines', 'Drag a straight line'],
          ['DRAW_POLY', 'Draw Poly Line', 'Click points of a poly line'],
          ['ERASER', 'Eraser', 'Erase the annotations under the pointer'],
        ],
      },
      {
        id: 'arrowstyle_start',
        label: 'Start Arrow Style',
        type: 'enum',
        default: 'NONE',
        items: ARROWS,
      },
      {
        id: 'arrowstyle_end',
        label: 'End Arrow Style',
        type: 'enum',
        default: 'NONE',
        items: ARROWS,
      },
      {
        id: 'use_stabilizer',
        label: 'Stabilize Stroke',
        type: 'bool',
        default: false,
      },
      {
        id: 'stabilizer_factor',
        label: 'Stabilizer Stroke Factor',
        type: 'float',
        default: 0.75,
        min: 0,
        max: 1,
        subtype: 'factor',
      },
      {
        id: 'stabilizer_radius',
        label: 'Stabilizer Stroke Radius',
        type: 'int',
        default: 35,
        min: 0,
        max: 200,
        subtype: 'pixel',
      },
      {
        id: 'stroke',
        label: 'Stroke',
        type: 'string',
        default: [],
        hidden: true,
      },
      {
        id: 'wait_for_input',
        label: 'Wait for Input',
        type: 'bool',
        default: true,
        hidden: true,
      },
    ],
    poll: () => !!activeView3D(),
    invoke: (ctx, p) => {
      if (Array.isArray(p.stroke) && p.stroke.length) return annotateExec(p);
      return annotateInvoke(ctx, p);
    },
    exec: (_c, p) => annotateExec(p),
  },
]);

function annotateExec(p: Record<string, unknown>) {
  const v = activeView3D();
  const pts = strokeFromProp(v, p.stroke);
  if (p.mode === 'ERASER') {
    if (!v) return 'CANCELLED' as const;
    let any = false;
    const q = new Vector3();
    for (let i = 0; i < pts.length; i += 3) {
      const s = v.project(q.set(pts[i], pts[i + 1], pts[i + 2]));
      if (eraseAt(v, s.x, s.y)) any = true;
    }
    return any ? ('FINISHED' as const) : ('CANCELLED' as const);
  }
  const use = p.mode === 'DRAW_STRAIGHT' && pts.length > 6 ? [...pts.slice(0, 3), ...pts.slice(-3)] : pts;
  return addStroke(
    use,
    p.mode === 'DRAW_STRAIGHT'
      ? {
          arrow_start: p.arrowstyle_start as AnnotationArrow,
          arrow_end: p.arrowstyle_end as AnnotationArrow,
        }
      : {},
  )
    ? ('FINISHED' as const)
    : ('CANCELLED' as const);
}

// ---------------------------------------------------------------------------
// tools, keys and settings

const ANNOTATE_TOOLS: ToolDef[] = [
  {
    id: 'builtin.annotate',
    label: 'Annotate',
    icon: 'annotate',
    group: 'annotate',
    description: 'Draw free-hand annotation (Ctrl: erase)',
  },
  {
    id: 'builtin.annotate_line',
    label: 'Annotate Line',
    icon: 'annotate_line',
    group: 'annotate',
    description: 'Draw straight annotation lines, with optional arrow heads',
  },
  {
    id: 'builtin.annotate_polygon',
    label: 'Annotate Polygon',
    icon: 'annotate_polygon',
    group: 'annotate',
    description: 'Click the points of an annotation poly line; Enter or right click finishes',
  },
  {
    id: 'builtin.annotate_eraser',
    label: 'Annotate Eraser',
    icon: 'annotate_eraser',
    group: 'annotate',
    description: 'Erase annotation strokes',
  },
];

/** Put the annotate variants next to the Annotate tool in a tool list (grouped into one slot). */
function withAnnotateGroup(list: (ToolDef | null)[]) {
  const i = list.findIndex((t) => t?.id === 'builtin.annotate');
  if (i < 0) return;
  if (list.some((t) => t?.id === 'builtin.annotate_line')) return;
  list[i] = { ...list[i]!, group: 'annotate' };
  list.splice(i + 1, 0, ...ANNOTATE_TOOLS.slice(1));
}
withAnnotateGroup(COMMON_TOOLS);
// the sculpt / vertex / weight paint modes of Grease Pencil offer the annotate tools too
for (const m of ['SCULPT_GREASE_PENCIL', 'VERTEX_GREASE_PENCIL', 'WEIGHT_GREASE_PENCIL']) {
  const base = extraToolLists[m];
  if (base) extraToolLists[m] = () => [...base(), null, ...ANNOTATE_TOOLS];
}
for (const key of Object.keys(toolsByMode)) withAnnotateGroup(toolsByMode[key]);

const TOOL_MODE: Record<string, AnnotateMode> = {
  'builtin.annotate': 'DRAW',
  'builtin.annotate_line': 'DRAW_STRAIGHT',
  'builtin.annotate_polygon': 'DRAW_POLY',
  'builtin.annotate_eraser': 'ERASER',
};

function toolProps(mode: AnnotateMode) {
  return {
    mode,
    arrowstyle_start: annotateTool.arrow_start,
    arrowstyle_end: annotateTool.arrow_end,
    use_stabilizer: annotateTool.use_stabilizer,
    stabilizer_radius: annotateTool.stabilizer_radius,
    stabilizer_factor: annotateTool.stabilizer_factor,
    wait_for_input: false,
  };
}

// D held: annotate whatever the active tool is
let dHeld = false;
addEventListener(
  'keydown',
  (e) => {
    if (e.code !== 'KeyD' || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    dHeld = true;
  },
  true,
);
addEventListener('keyup', (e) => e.code === 'KeyD' && (dHeld = false), true);
addEventListener('blur', () => (dHeld = false));

const run = (mode: AnnotateMode, e: PointerEvent) =>
  app.run('gpencil.annotate', toolProps(mode), {
    event: { x: e.clientX, y: e.clientY },
  });

editModeHooks.pointer.unshift((_v, e) => {
  if (e.button !== 0) return false;
  if (dHeld) {
    run(e.altKey ? (e.shiftKey ? 'DRAW_POLY' : 'DRAW_STRAIGHT') : 'DRAW', e);
    return true;
  }
  const mode = TOOL_MODE[activeTools[app.doc.mode] ?? ''];
  if (!mode || e.altKey) return false;
  // Ctrl with any annotate tool erases
  run(e.ctrlKey || e.metaKey ? 'ERASER' : mode, e);
  return true;
});
editModeHooks.context.unshift((_v, e) => {
  if (!dHeld) return false;
  run('ERASER', e);
  return true;
});

const layerColorField = () =>
  colorSwatch('ann-color', activeAnnotationLayer()?.color ?? annotateSettings.color, (c, final) => {
    annotateSettings.color = [c[0], c[1], c[2]];
    const l = activeAnnotationLayer();
    if (l) {
      l.color = [c[0], c[1], c[2]];
      if (final) app.pushUndo('Annotation Color');
    }
    app.changed('ui');
  });

const thicknessField = () =>
  numberField({
    id: 'ann-thick',
    label: 'Thickness',
    value: activeAnnotationLayer()?.thickness ?? annotateSettings.thickness,
    min: 1,
    max: 10,
    int: true,
    set: (x, final) => {
      annotateSettings.thickness = x;
      const l = activeAnnotationLayer();
      if (l) {
        l.thickness = x;
        if (final) app.pushUndo('Annotation Thickness');
      }
      app.changed('ui');
    },
  });

const placementMenu = () =>
  enumMenu(
    'ann-place',
    [
      {
        value: 'CURSOR',
        label: '3D Cursor',
        description: 'Draw on a plane through the 3D cursor',
      },
      {
        value: 'VIEW',
        label: 'View',
        description: 'Draw in front of the view',
      },
      {
        value: 'SURFACE',
        label: 'Surface',
        description: 'Draw on the surfaces under the pointer',
      },
    ],
    annotateSettings.placement,
    (x) => ((annotateSettings.placement = x as 'CURSOR'), app.changed('ui')),
    { tip: 'Placement\nWhere the annotation points land in 3D' },
  );

const arrowMenu = (id: string, key: 'arrow_start' | 'arrow_end', tip: string) =>
  enumMenu(
    id,
    ARROWS.map(([value, label, description]) => ({
      value,
      label,
      description,
    })),
    annotateTool[key],
    (x) => ((annotateTool[key] = x as AnnotationArrow), app.changed('ui')),
    { tip },
  );

const box = (w: number, c: unknown) => h('div', { style: { width: `${w}px`, flex: 'none' } }, c as VNode);

toolSettingsRenderers['builtin.annotate'] = () => [
  layerColorField(),
  box(110, thicknessField()),
  h('span', { class: 'th-label' }, 'Placement'),
  box(100, placementMenu()),
  checkbox('ann-stab', 'Stabilize Stroke', annotateTool.use_stabilizer, (x) => ((annotateTool.use_stabilizer = x), app.changed('ui'))),
  annotateTool.use_stabilizer
    ? box(
        110,
        numberField({
          id: 'ann-stab-r',
          label: 'Radius',
          value: annotateTool.stabilizer_radius,
          min: 0,
          max: 200,
          int: true,
          set: (x) => ((annotateTool.stabilizer_radius = Math.round(x)), app.changed('ui')),
        }),
      )
    : null,
  annotateTool.use_stabilizer
    ? box(
        110,
        numberField({
          id: 'ann-stab-f',
          label: 'Factor',
          value: annotateTool.stabilizer_factor,
          min: 0,
          max: 1,
          slider: true,
          set: (x) => ((annotateTool.stabilizer_factor = x), app.changed('ui')),
        }),
      )
    : null,
  opButton('annotation.clear', 'Clear'),
];

toolSettingsRenderers['builtin.annotate_line'] = () => [
  layerColorField(),
  box(110, thicknessField()),
  h('span', { class: 'th-label' }, 'Style Start'),
  box(100, arrowMenu('ann-as', 'arrow_start', 'Style Start\nDecoration of the line start')),
  h('span', { class: 'th-label' }, 'End'),
  box(100, arrowMenu('ann-ae', 'arrow_end', 'Style End\nDecoration of the line end')),
  h('span', { class: 'th-label' }, 'Placement'),
  box(100, placementMenu()),
];

toolSettingsRenderers['builtin.annotate_polygon'] = () => [
  layerColorField(),
  box(110, thicknessField()),
  h('span', { class: 'th-label' }, 'Placement'),
  box(100, placementMenu()),
  h('span', { class: 'th-label' }, 'Click to add points · Enter / right click / double click to finish'),
];

toolSettingsRenderers['builtin.annotate_eraser'] = () => [
  box(
    130,
    numberField({
      id: 'ann-er',
      label: 'Radius',
      value: annotateSettings.eraserRadius,
      min: 1,
      max: 200,
      int: true,
      set: (x) => ((annotateSettings.eraserRadius = Math.round(x)), app.changed('ui')),
    }),
  ),
  opButton('annotation.clear', 'Clear'),
];
