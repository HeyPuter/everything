// Preview image transforms: move / rotate / scale / mirror the selected strips' images around a
// pivot (median, bounding box centre, 2D cursor or each image's own centre), with axis
// constraints (X / Y), snapping (frame borders and centre, other strips) and numeric input.
// Output pixels: origin at the frame's bottom-left, y up.
import { app } from '../app/app';
import type { Strip, StripTransform } from './types';
import { isLocked, toolSettings, type SeqEditorLike } from './context';
import { stripImageCorners, previewStrips, stripPlacement } from './transform';
import { snapDelta } from './selection';

export type PreviewMode = 'TRANSLATE' | 'ROTATE' | 'RESIZE' | 'ORIGIN';
export type Pivot = 'MEDIAN_POINT' | 'BOUNDING_BOX_CENTER' | 'CURSOR' | 'INDIVIDUAL_ORIGINS';

export const PIVOTS: [Pivot, string][] = [
  ['BOUNDING_BOX_CENTER', 'Bounding Box Center'],
  ['CURSOR', '2D Cursor'],
  ['INDIVIDUAL_ORIGINS', 'Individual Origins'],
  ['MEDIAN_POINT', 'Median Point'],
];

interface Snap {
  s: Strip;
  t: StripTransform;
  flipX: boolean;
  flipY: boolean;
  /** image centre and bounds before the transform */
  c: [number, number];
  box: [number, number, number, number];
}

function res(): [number, number] {
  const r = app.doc.scene.render;
  return [r.resolution_x, r.resolution_y];
}

const copyT = (t: StripTransform): StripTransform => ({ ...t, origin: [...t.origin] as [number, number] });

function bounds(s: Strip): [number, number, number, number] {
  const [W, H] = res();
  const c = stripImageCorners(s, W, H);
  const xs = c.map((p) => p[0]),
    ys = c.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function snapOf(s: Strip): Snap {
  const [W, H] = res();
  const c = stripImageCorners(s, W, H);
  return { s, t: copyT(s.transform), flipX: s.use_flip_x, flipY: s.use_flip_y, c: [c.reduce((a, p) => a + p[0], 0) / 4, c.reduce((a, p) => a + p[1], 0) / 4], box: bounds(s) };
}

/** The 2D cursor in output pixels (stored relative to the frame centre). */
export function cursorPoint(): [number, number] {
  const [W, H] = res();
  const c = toolSettings().cursor_location ?? [0, 0];
  return [W / 2 + c[0], H / 2 + c[1]];
}

export function setCursorPoint(x: number, y: number) {
  const [W, H] = res();
  toolSettings().cursor_location = [Math.round(x - W / 2), Math.round(y - H / 2)];
}

export function pivotPoint(): Pivot {
  return toolSettings().pivot_point ?? 'MEDIAN_POINT';
}

/** Selected, unlocked strips visible in the preview at the current frame. */
export function previewTargets(): Strip[] {
  return previewStrips(app.doc.scene.frame_current).filter((s) => s.select && !isLocked(s));
}

function pivotOf(snaps: Snap[], pivot: Pivot): [number, number] {
  if (pivot === 'CURSOR') return cursorPoint();
  if (pivot === 'BOUNDING_BOX_CENTER') {
    const x0 = Math.min(...snaps.map((s) => s.box[0])),
      y0 = Math.min(...snaps.map((s) => s.box[1])),
      x1 = Math.max(...snaps.map((s) => s.box[2])),
      y1 = Math.max(...snaps.map((s) => s.box[3]));
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  }
  return [snaps.reduce((a, s) => a + s.c[0], 0) / snaps.length, snaps.reduce((a, s) => a + s.c[1], 0) / snaps.length];
}

function restore(snaps: Snap[]) {
  for (const n of snaps) {
    n.s.transform = copyT(n.t);
    n.s.use_flip_x = n.flipX;
    n.s.use_flip_y = n.flipY;
  }
}

/**
 * Apply a transform to snapshots: TRANSLATE value = [dx, dy] px, ROTATE value[0] = radians
 * (counter-clockwise), RESIZE value = [sx, sy].
 */
function applyTo(snaps: Snap[], mode: PreviewMode | 'MIRROR', value: number[], pivot: Pivot) {
  restore(snaps);
  const P = pivotOf(snaps, pivot);
  for (const n of snaps) {
    const t = n.s.transform;
    const p = pivot === 'INDIVIDUAL_ORIGINS' ? n.c : P;
    if (mode === 'TRANSLATE') {
      t.offset_x = n.t.offset_x + value[0];
      t.offset_y = n.t.offset_y + value[1];
    } else if (mode === 'ROTATE') {
      const d = value[0];
      t.rotation = n.t.rotation + d;
      const rx = n.c[0] - p[0],
        ry = n.c[1] - p[1];
      t.offset_x = n.t.offset_x + (p[0] + rx * Math.cos(d) - ry * Math.sin(d) - n.c[0]);
      t.offset_y = n.t.offset_y + (p[1] + rx * Math.sin(d) + ry * Math.cos(d) - n.c[1]);
    } else if (mode === 'RESIZE') {
      const [sx, sy] = value;
      t.scale_x = n.t.scale_x * sx;
      t.scale_y = n.t.scale_y * sy;
      t.offset_x = n.t.offset_x + (p[0] + (n.c[0] - p[0]) * sx - n.c[0]);
      t.offset_y = n.t.offset_y + (p[1] + (n.c[1] - p[1]) * sy - n.c[1]);
    } else if (mode === 'ORIGIN') {
      // move the origin by value (output px) while the image stays where it is
      const [W, H] = res();
      const { w, h, M } = stripPlacement({ ...n.s, transform: n.t } as Strip, W, H);
      const a = M[0],
        b = M[1],
        c = M[3],
        d = M[4];
      const det = a * d - b * c || 1e-9;
      const dx = value[0],
        dy = value[1];
      // image-space shift of the origin: (R S)^-1 · d
      const ix = (d * dx - c * dy) / det,
        iy = (-b * dx + a * dy) / det;
      t.origin = [n.t.origin[0] + ix / w, n.t.origin[1] + iy / h];
      t.offset_x = n.t.offset_x + dx - ix;
      t.offset_y = n.t.offset_y + dy - iy;
    } else {
      // mirror across the pivot on X (value[0]) and/or Y (value[1])
      if (value[0]) {
        n.s.use_flip_x = !n.flipX;
        t.rotation = -n.t.rotation;
        t.offset_x = n.t.offset_x + (2 * p[0] - 2 * n.c[0]);
      }
      if (value[1]) {
        n.s.use_flip_y = !n.flipY;
        t.rotation = value[0] ? n.t.rotation : -n.t.rotation;
        t.offset_y = n.t.offset_y + (2 * p[1] - 2 * n.c[1]);
      }
    }
  }
}

/** Non-interactive transform of the selected visible strips (operator exec / redo). */
export function transformPreview(mode: PreviewMode | 'MIRROR', value: number[]): boolean {
  const snaps = previewTargets().map(snapOf);
  if (!snaps.length) return false;
  applyTo(snaps, mode, value, pivotPoint());
  return true;
}

function numericKeys(state: { text: string }, e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return false;
  if (/^[0-9]$/.test(e.key) || (e.key === '-' && !state.text) || (e.key === '.' && !state.text.includes('.'))) state.text += e.key;
  else if (e.key === 'Backspace') state.text = state.text.slice(0, -1);
  else return false;
  return true;
}

let pointerDown = false;
addEventListener('pointerdown', (e) => e.button === 0 && (pointerDown = true), true);
addEventListener('pointerup', (e) => e.button === 0 && (pointerDown = false), true);

/** Interactive preview transform (G / R / S, the transform tools, dragging a strip). */
export function startPreviewTransform(ed: SeqEditorLike, mode: PreviewMode, cx: number, cy: number, drag = false): boolean {
  const snaps = previewTargets().map(snapOf);
  if (!snaps.length) return false;
  const [W, H] = res();
  const pivot = pivotPoint();
  const P = pivotOf(snaps, pivot);
  const [fx0, fy0] = ed.previewToFrame(cx, cy);
  const st = { text: '', value: [0, 0] as number[], axis: null as 'X' | 'Y' | null, snapping: false };
  const ts = toolSettings();
  const others = ts.snap_to_strips_preview === false ? [] : previewStrips(app.doc.scene.frame_current).filter((s) => !s.select).map(bounds);
  const box: [number, number, number, number] = [Math.min(...snaps.map((s) => s.box[0])), Math.min(...snaps.map((s) => s.box[1])), Math.max(...snaps.map((s) => s.box[2])), Math.max(...snaps.map((s) => s.box[3]))];
  const snapOn = () => (app.doc.scene.tool_settings.use_snap_sequencer ?? true) !== st.snapping;
  let last = { x: cx, y: cy, shift: false };
  let precise: { x: number; y: number; fx: number; fy: number } | null = null;
  const pointerFrame = (): [number, number] => {
    const [fx, fy] = ed.previewToFrame(last.x, last.y);
    if (!last.shift) return [fx, fy];
    // Shift: slow, precise motion from where it was pressed
    precise ??= { x: last.x, y: last.y, fx, fy };
    const [ax, ay] = ed.previewToFrame(precise.x, precise.y);
    return [precise.fx + (fx - ax) * 0.1, precise.fy + (fy - ay) * 0.1];
  };
  const apply = () => {
    const [fx, fy] = pointerFrame();
    const num = st.text && st.text !== '-' ? Number(st.text) : null;
    let v: number[];
    if (mode === 'TRANSLATE' || mode === 'ORIGIN') {
      v = num !== null ? [st.axis === 'Y' ? 0 : num, st.axis === 'Y' ? num : 0] : [Math.round(fx - fx0), Math.round(fy - fy0)];
      if (st.axis === 'X') v[1] = 0;
      if (st.axis === 'Y') v[0] = 0;
      if (num === null && snapOn() && mode === 'TRANSLATE') {
        const moved: [number, number, number, number] = [box[0] + v[0], box[1] + v[1], box[2] + v[0], box[3] + v[1]];
        const [dx, dy] = snapDelta(moved, others, W, H, 10 / Math.max(1e-6, ed.previewScale()), { borders: ts.snap_to_borders !== false, center: ts.snap_to_center !== false });
        if (st.axis !== 'Y') v[0] += dx;
        if (st.axis !== 'X') v[1] += dy;
      }
    } else if (mode === 'ROTATE') {
      const a0 = Math.atan2(fy0 - P[1], fx0 - P[0]),
        a1 = Math.atan2(fy - P[1], fx - P[0]);
      v = [num !== null ? (num * Math.PI) / 180 : a1 - a0];
    } else {
      const d0 = Math.hypot(fx0 - P[0], fy0 - P[1]) || 1;
      let k = num ?? Math.hypot(fx - P[0], fy - P[1]) / d0;
      if (num === null && last.shift) k = Math.round(k * 100) / 100;
      v = [st.axis === 'Y' ? 1 : k, st.axis === 'X' ? 1 : k];
    }
    st.value = v;
    applyTo(snaps, mode, v, pivot);
    app.changed('doc');
  };
  const handler = {
    label: mode === 'TRANSLATE' ? 'Move' : mode === 'ROTATE' ? 'Rotate' : mode === 'ORIGIN' ? 'Move Origin' : 'Resize',
    cursor: mode === 'TRANSLATE' || mode === 'ORIGIN' ? 'move' : 'crosshair',
    header: () => {
      const v = st.value;
      const val = mode === 'TRANSLATE' || mode === 'ORIGIN' ? `${Math.round(v[0])} px, ${Math.round(v[1])} px` : mode === 'ROTATE' ? `${((v[0] * 180) / Math.PI).toFixed(1)}°` : st.axis ? (st.axis === 'X' ? v[0] : v[1]).toFixed(3) : v[0].toFixed(3);
      return `${handler.label}: ${st.text ? st.text + '|' : val}${st.axis ? ` along ${st.axis}` : ''}`;
    },
    status: () =>
      [
        ['LMB', 'Confirm'],
        ['RMB', 'Cancel'],
        mode === 'ROTATE' ? null : ['X / Y', 'Constrain Axis'],
        mode === 'TRANSLATE' ? ['Ctrl', 'Toggle Snapping'] : null,
        ['Shift', 'Precision'],
      ].filter(Boolean) as [string, string][],
    onPointerMove(e: PointerEvent) {
      last = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
      if (!e.shiftKey) precise = null;
      apply();
    },
    onPointerDown: (e: PointerEvent) => (e.button === 0 ? ('FINISHED' as const) : e.button === 2 ? ('CANCELLED' as const) : undefined),
    onPointerUp: (e: PointerEvent) => (e.button === 0 && drag && wasDown ? ('FINISHED' as const) : undefined),
    onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') return 'CANCELLED' as const;
      if (e.key === 'Enter') return 'FINISHED' as const;
      if (e.key === 'Control' || e.key === 'Meta') {
        st.snapping = e.type === 'keydown';
        apply();
        return true;
      }
      if (e.type === 'keydown' && mode !== 'ROTATE' && (e.key === 'x' || e.key === 'y' || e.key === 'X' || e.key === 'Y')) {
        const a = e.key.toUpperCase() as 'X' | 'Y';
        st.axis = st.axis === a ? null : a;
        apply();
        return true;
      }
      if (numericKeys(st, e)) apply();
      return true;
    },
    cancel() {
      restore(snaps);
      app.changed('doc');
    },
    finish() {
      handler.redoOp = { idname: 'sequencer.strip_transform', props: { mode, value: mode === 'ROTATE' ? [st.value[0], 0, 0] : [st.value[0], st.value[1], 0] } };
    },
    redoOp: undefined as { idname: string; props: Record<string, unknown> } | undefined,
  };
  const wasDown = pointerDown;
  app.startModal(handler);
  apply();
  return true;
}
