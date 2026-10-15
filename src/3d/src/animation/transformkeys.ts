// Modal and scripted transforms of keyframes / Bézier handles for the Dope Sheet
// (time translate, scale, extend) and the Graph Editor (translate, rotate, scale
// with axis constraints, numeric input and frame snapping).
import { app, type ModalHandler } from '../app/app';
import type { FCurve, Keyframe } from '../data/types';
import type { CurveRef } from './channels';
import { calcHandles, alignHandle, sortKeyframes } from '../anim/fcurve';
import { finalizeCurve, editable, isAnySelected } from './keyedit';
import { parseExpression, evalExpression } from '../anim/drivers';

export type KeyTransformMode = 'TIME_TRANSLATE' | 'TIME_SCALE' | 'TIME_EXTEND' | 'TIME_SLIDE' | 'TRANSLATION' | 'ROTATION' | 'RESIZE';

/** What a transform needs from the editor that hosts it. */
export interface KeyTransformHost {
  /** editable curves in scope (visible in the Graph Editor) */
  transformCurves(): CurveRef[];
  /** Graph Editor (values + handles) vs time-only editors */
  graph: boolean;
  /** pixels per frame / per display value unit */
  ppf(): number;
  ppv(): number;
  /** value → display value (normalization) and back */
  toDisp(fc: FCurve, v: number): number;
  fromDisp(fc: FCurve, d: number): number;
  /** screen position (client px) of a frame/display value */
  screen(x: number, d: number): { x: number; y: number };
  autoSnap: boolean;
  /** what snapping snaps to (whole frames by default); absolute snaps the keys, not the offset */
  snapTo?: { mode: 'FRAME' | 'SECOND' | 'MARKER'; absolute: boolean; fps: number; markers: number[] };
  /** handles are only editable when displayed */
  handlesVisible(k: Keyframe): boolean;
  pivot?: 'BOUNDING_BOX_CENTER' | 'CURSOR' | 'INDIVIDUAL_ORIGINS';
  cursorValue?: number;
  /** proportional editing: unselected keys within the radius (frames) follow with a falloff */
  proportional?: { size: number; falloff: string };
}

interface Snap {
  k: Keyframe;
  fc: FCurve;
  co: [number, number];
  hl: [number, number];
  hr: [number, number];
  hlt: Keyframe['handle_left_type'];
  hrt: Keyframe['handle_right_type'];
  /** which points move */
  c: boolean;
  l: boolean;
  r: boolean;
  /** proportional weight (1 for selected keys) */
  w: number;
  /** distance (frames) to the nearest selected key, for proportional editing */
  dist: number;
}

export interface TransformValues {
  mode: KeyTransformMode;
  /** translate: [dx, dy]; scale: [sx, sy]; rotate: [angle] */
  value: [number, number];
  constraint: 'NONE' | 'X' | 'Y';
  /** TIME_EXTEND: which side of the current frame moves */
  side?: 'LEFT' | 'RIGHT';
}

function collect(host: KeyTransformHost, mode: KeyTransformMode, side?: 'LEFT' | 'RIGHT'): Snap[] {
  const out: Snap[] = [];
  const cfra = app.doc.scene.frame_current;
  const prop = host.proportional && mode !== 'TIME_EXTEND' && mode !== 'TIME_SLIDE' ? host.proportional : null;
  const others: { k: Keyframe; fc: FCurve }[] = [];
  for (const { fc } of editable(host.transformCurves())) {
    for (const k of fc.keyframe_points) {
      let c = !!k.select_control_point;
      let l = host.graph ? !!k.select_left_handle && host.handlesVisible(k) : c;
      let r = host.graph ? !!k.select_right_handle && host.handlesVisible(k) : c;
      if (c) l = r = true;
      if (mode === 'TIME_EXTEND' && c) {
        const onSide = side === 'LEFT' ? k.co[0] <= cfra : k.co[0] >= cfra;
        if (!onSide) c = l = r = false;
      }
      if (!c && !l && !r) {
        if (prop) others.push({ k, fc });
        continue;
      }
      out.push(snapOf(k, fc, c, l, r, 1, 0));
    }
  }
  if (prop && out.length) {
    // proportional: distance to the nearest selected key (frames; in the Graph Editor the value
    // axis is scaled to frames through the view's aspect)
    const aspect = host.graph ? host.ppv() / Math.max(1e-6, host.ppf()) : 0;
    const sel = out.filter((o) => o.c).map((o) => [o.co[0], host.toDisp(o.fc, o.co[1])] as const);
    for (const { k, fc } of others) {
      const y = host.toDisp(fc, k.co[1]);
      let d = Infinity;
      for (const [sx, sy] of sel) d = Math.min(d, Math.hypot(k.co[0] - sx, (y - sy) * aspect));
      out.push(snapOf(k, fc, true, true, true, 0, d));
    }
    weighProportional(out, prop);
  }
  return out;
}

function snapOf(k: Keyframe, fc: FCurve, c: boolean, l: boolean, r: boolean, w: number, dist: number): Snap {
  return { k, fc, co: [...k.co], hl: [...k.handle_left], hr: [...k.handle_right], hlt: k.handle_left_type, hrt: k.handle_right_type, c, l, r, w, dist };
}

/** Falloff weight for a normalised distance (0 at the selection, 1 at the radius). */
export function propFalloff(type: string, t: number): number {
  const x = Math.max(0, Math.min(1, 1 - t));
  switch (type) {
    case 'SPHERE':
      return Math.sqrt(1 - (1 - x) * (1 - x));
    case 'ROOT':
      return Math.sqrt(x);
    case 'INVERSE_SQUARE':
      return x * (2 - x);
    case 'SHARP':
      return x * x;
    case 'LINEAR':
      return x;
    case 'CONSTANT':
      return x > 0 ? 1 : 0;
    case 'RANDOM':
      return x * (0.5 + 0.5 * Math.random());
    default:
      return x * x * (3 - 2 * x);
  }
}

function weighProportional(snaps: Snap[], prop: { size: number; falloff: string }) {
  for (const s of snaps) if (s.dist > 0 || s.w < 1) s.w = s.dist < prop.size ? propFalloff(prop.falloff, s.dist / Math.max(1e-6, prop.size)) : 0;
}

function restore(s: Snap) {
  s.k.co = [...s.co];
  s.k.handle_left = [...s.hl];
  s.k.handle_right = [...s.hr];
  s.k.handle_left_type = s.hlt;
  s.k.handle_right_type = s.hrt;
}

function pivotOf(host: KeyTransformHost, snaps: Snap[], mode: KeyTransformMode): { x: number; d: number } {
  const cfra = app.doc.scene.frame_current;
  if (!host.graph || mode === 'TIME_SCALE') return { x: cfra, d: 0 };
  if (host.pivot === 'CURSOR') return { x: cfra, d: host.cursorValue ?? 0 };
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const s of snaps) {
    if (s.w < 1) continue;
    const pts: [number, number][] = [];
    if (s.c) pts.push(s.co);
    else {
      if (s.l) pts.push(s.hl);
      if (s.r) pts.push(s.hr);
    }
    for (const [x, v] of pts) {
      const d = host.toDisp(s.fc, v);
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, d);
      y1 = Math.max(y1, d);
    }
  }
  return x0 === Infinity ? { x: cfra, d: 0 } : { x: (x0 + x1) / 2, d: (y0 + y1) / 2 };
}

/** Snap a frame (absolute) to the chosen target. */
export function snapFrameTo(f: number, snap: NonNullable<KeyTransformHost['snapTo']> | undefined): number {
  if (!snap || snap.mode === 'FRAME') return Math.round(f);
  if (snap.mode === 'SECOND') return Math.round(f / snap.fps) * snap.fps;
  if (!snap.markers.length) return Math.round(f);
  return snap.markers.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a));
}

/** Snap a time offset: by whole frames or seconds (markers and absolute snapping work per key). */
function snapDelta(dx: number, snap: KeyTransformHost['snapTo']): number {
  if (snap?.mode === 'SECOND' && !snap.absolute) return Math.round(dx / snap.fps) * snap.fps;
  return Math.round(dx);
}

const perKeySnap = (snap: KeyTransformHost['snapTo']) => !!snap && (snap.absolute || snap.mode === 'MARKER');

/** Frame range of the keys taking part in a transform (from their original positions). */
function slideRange(snaps: Snap[]): [number, number] {
  let a = Infinity,
    b = -Infinity;
  for (const s of snaps)
    if (s.c && s.w >= 1) {
      a = Math.min(a, s.co[0]);
      b = Math.max(b, s.co[0]);
    }
  return a === Infinity ? [0, 0] : [a, b];
}

/** Apply transform values to the snapshot (from the initial state). */
function apply(host: KeyTransformHost, snaps: Snap[], t: TransformValues, pivot: { x: number; d: number }, snapFrames: boolean) {
  const ppf = host.ppf(),
    ppv = host.ppv();
  const touched = new Set<FCurve>();
  const cx = t.constraint !== 'Y',
    cy = t.constraint !== 'X' && host.graph;
  for (const s of snaps) {
    restore(s);
    touched.add(s.fc);
    const map = (p: [number, number]): [number, number] => {
      let x = p[0];
      let d = host.toDisp(s.fc, p[1]);
      switch (t.mode) {
        case 'TIME_TRANSLATE':
        case 'TIME_EXTEND':
          x += t.value[0];
          break;
        case 'TIME_SLIDE': {
          // inner keys slide towards one end of the selected range; the outer keys stay
          const [a, b] = slideRange(snaps);
          const f = Math.max(-1, Math.min(1, t.value[0]));
          if (x > a + 1e-6 && x < b - 1e-6) x = f >= 0 ? x + (b - x) * f : x + (x - a) * f;
          break;
        }
        case 'TIME_SCALE':
          x = pivot.x + (x - pivot.x) * t.value[0];
          break;
        case 'TRANSLATION':
          if (cx) x += t.value[0];
          if (cy) d += t.value[1];
          break;
        case 'RESIZE':
          if (cx) x = pivot.x + (x - pivot.x) * t.value[0];
          if (cy) d = pivot.d + (d - pivot.d) * t.value[1];
          break;
        case 'ROTATION': {
          const a = t.value[0];
          const px = (x - pivot.x) * ppf,
            py = (d - pivot.d) * ppv;
          const rx = px * Math.cos(a) - py * Math.sin(a),
            ry = px * Math.sin(a) + py * Math.cos(a);
          x = pivot.x + rx / ppf;
          d = pivot.d + ry / ppv;
          break;
        }
      }
      return [x, host.fromDisp(s.fc, d)];
    };
    if (s.c) {
      const nco = map(s.co);
      if (snapFrames && (t.mode === 'TIME_SCALE' || t.mode === 'TIME_SLIDE' || ((t.mode === 'TIME_TRANSLATE' || t.mode === 'TIME_EXTEND' || t.mode === 'TRANSLATION') && perKeySnap(host.snapTo)))) nco[0] = snapFrameTo(nco[0], host.snapTo);
      if (t.mode === 'ROTATION' || t.mode === 'RESIZE') {
        // handles follow the full mapping (they rotate/scale with the key)
        const nl = map(s.hl),
          nr = map(s.hr);
        const dx = nco[0] - map(s.co)[0];
        s.k.co = nco;
        s.k.handle_left = [nl[0] + dx, nl[1]];
        s.k.handle_right = [nr[0] + dx, nr[1]];
      } else if (t.mode === 'TIME_SCALE') {
        const nl = map(s.hl),
          nr = map(s.hr);
        const dx = nco[0] - map(s.co)[0];
        s.k.co = nco;
        s.k.handle_left = [nl[0] + dx, s.hl[1]];
        s.k.handle_right = [nr[0] + dx, s.hr[1]];
      } else {
        const dx = nco[0] - s.co[0],
          dy = nco[1] - s.co[1];
        s.k.co = nco;
        s.k.handle_left = [s.hl[0] + dx, s.hl[1] + dy];
        s.k.handle_right = [s.hr[0] + dx, s.hr[1] + dy];
      }
    } else {
      // handle-only edits: auto handles become aligned, vector handles become free
      const conv = (ty: Keyframe['handle_left_type']) => (ty === 'AUTO' || ty === 'AUTO_CLAMPED' ? 'ALIGNED' : ty === 'VECTOR' ? 'FREE' : ty);
      if (s.l) {
        s.k.handle_left = map(s.hl);
        s.k.handle_left_type = conv(s.k.handle_left_type);
        if (s.k.handle_right_type === 'AUTO' || s.k.handle_right_type === 'AUTO_CLAMPED') s.k.handle_right_type = 'ALIGNED';
        if (s.k.handle_left_type === 'ALIGNED' && s.k.handle_right_type === 'ALIGNED') alignHandle(s.k, 'right');
      }
      if (s.r) {
        s.k.handle_right = map(s.hr);
        s.k.handle_right_type = conv(s.k.handle_right_type);
        if (s.k.handle_left_type === 'AUTO' || s.k.handle_left_type === 'AUTO_CLAMPED') s.k.handle_left_type = 'ALIGNED';
        if (s.k.handle_left_type === 'ALIGNED' && s.k.handle_right_type === 'ALIGNED' && !s.l) alignHandle(s.k, 'left');
      }
    }
    if (s.w < 1) {
      // proportional: partial move towards the mapped position
      const mix = (a: [number, number], b: [number, number]): [number, number] => [a[0] + (b[0] - a[0]) * s.w, a[1] + (b[1] - a[1]) * s.w];
      s.k.co = mix(s.co, s.k.co as [number, number]);
      s.k.handle_left = mix(s.hl, s.k.handle_left as [number, number]);
      s.k.handle_right = mix(s.hr, s.k.handle_right as [number, number]);
    }
    // keep handles on their side of the key
    if (s.k.handle_left[0] > s.k.co[0]) s.k.handle_left[0] = s.k.co[0];
    if (s.k.handle_right[0] < s.k.co[0]) s.k.handle_right[0] = s.k.co[0];
  }
  for (const fc of touched) {
    sortKeyframes(fc);
    calcHandles(fc);
  }
  return touched;
}

/** Non-interactive transform (redo panel / scripting). */
export function transformKeys(host: KeyTransformHost, t: TransformValues): number {
  const snaps = collect(host, t.mode, t.side);
  if (!snaps.length) return 0;
  const pivot = pivotOf(host, snaps, t.mode);
  const touched = apply(host, snaps, t, pivot, host.autoSnap);
  for (const fc of touched) finalizeCurve(fc);
  return snaps.length;
}

const MODE_LABEL: Record<KeyTransformMode, string> = {
  TIME_TRANSLATE: 'Move',
  TIME_SCALE: 'Scale',
  TIME_EXTEND: 'Extend',
  TIME_SLIDE: 'Time Slide',
  TRANSLATION: 'Move',
  ROTATION: 'Rotate',
  RESIZE: 'Resize',
};

/** Start an interactive transform. Returns false when nothing is selected. */
export function startKeyTransform(
  host: KeyTransformHost,
  mode: KeyTransformMode,
  opts: {
    start: { x: number; y: number };
    releaseConfirm?: boolean;
    redoIdname: string;
    onUpdate?: () => void;
    afterFinish?: () => void;
    onCancel?: () => void;
  },
): boolean {
  const cfra = app.doc.scene.frame_current;
  let side: 'LEFT' | 'RIGHT' | undefined;
  if (mode === 'TIME_EXTEND') {
    const p = host.screen(cfra, 0);
    side = opts.start.x < p.x ? 'LEFT' : 'RIGHT';
  }
  const snaps = collect(host, mode, side);
  if (!snaps.length) return false;
  const pivot = pivotOf(host, snaps, mode);
  const pivotScreen = host.screen(pivot.x, pivot.d);
  const start = { ...opts.start };
  let mouse = { ...start };
  let constraint: TransformValues['constraint'] = 'NONE';
  let numeric = '';
  let snapToggle = false;
  let precise = false;
  let preciseBase = { ...start },
    preciseAccum = { x: 0, y: 0 },
    lastRaw = { ...start };
  const startAngle = Math.atan2(start.y - pivotScreen.y, start.x - pivotScreen.x);
  let rotTotal = 0,
    lastAngle = startAngle;
  let current: TransformValues = {
    mode,
    value: mode === 'RESIZE' || mode === 'TIME_SCALE' ? [1, 1] : [0, 0],
    constraint,
    side,
  };

  const evalNumeric = (): number | null => {
    if (!numeric || numeric === '-') return null;
    try {
      const v = evalExpression(parseExpression(numeric), {});
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };

  const compute = () => {
    const snapOn = host.autoSnap !== snapToggle;
    const ppf = host.ppf(),
      ppv = host.ppv();
    const num = evalNumeric();
    let value: [number, number];
    switch (mode) {
      case 'TIME_SLIDE': {
        const [a, b] = slideRange(snaps);
        const span = Math.max(1e-6, b - a);
        value = [Math.max(-1, Math.min(1, num !== null ? num / 100 : (mouse.x - start.x) / ppf / span)), 0];
        break;
      }
      case 'TIME_TRANSLATE':
      case 'TIME_EXTEND': {
        let dx = num ?? (mouse.x - start.x) / ppf;
        if (snapOn && num === null && !perKeySnap(host.snapTo)) dx = snapDelta(dx, host.snapTo);
        value = [dx, 0];
        break;
      }
      case 'TRANSLATION': {
        let dx = (mouse.x - start.x) / ppf,
          dy = -(mouse.y - start.y) / ppv;
        if (num !== null) {
          if (constraint === 'Y') dy = num;
          else {
            dx = num;
            if (constraint === 'NONE') dy = 0;
          }
        } else if (snapOn && !perKeySnap(host.snapTo)) dx = snapDelta(dx, host.snapTo);
        value = [dx, dy];
        break;
      }
      case 'TIME_SCALE': {
        const d0 = start.x - pivotScreen.x;
        let s = num ?? (Math.abs(d0) < 1 ? 1 : (mouse.x - pivotScreen.x) / d0);
        if (!Number.isFinite(s)) s = 1;
        value = [s, 1];
        break;
      }
      case 'RESIZE': {
        const d0 = Math.hypot(start.x - pivotScreen.x, start.y - pivotScreen.y);
        let s = d0 < 1 ? 1 : Math.hypot(mouse.x - pivotScreen.x, mouse.y - pivotScreen.y) / d0;
        if (num !== null) s = num;
        value = [s, s];
        break;
      }
      case 'ROTATION': {
        // screen y grows downwards: negate so positive angles rotate counter-clockwise
        let a = -rotTotal;
        if (num !== null) a = (num * Math.PI) / 180;
        value = [a, 0];
        break;
      }
    }
    current = { mode, value, constraint, side };
    apply(host, snaps, current, pivot, snapOn);
    app.changed('doc');
    opts.onUpdate?.();
  };

  const resizeProportional = (k: number) => {
    const prop = host.proportional!;
    prop.size = Math.max(0.1, Math.min(10000, prop.size * k));
    app.doc.scene.tool_settings.proportional_size = prop.size;
    weighProportional(snaps, prop);
    compute();
  };
  const fmt = (v: number, d = 3) => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(d));
  const handler: ModalHandler = {
    label: MODE_LABEL[mode],
    cursor: mode === 'TIME_TRANSLATE' || mode === 'TIME_EXTEND' ? 'ew-resize' : 'move',
    header: () => {
      const n = (numeric ? ` [${numeric}|]` : '') + (host.proportional ? `  Proportional size: ${host.proportional.size.toFixed(2)}` : '');
      const c = constraint !== 'NONE' ? ` along ${constraint}` : '';
      switch (mode) {
        case 'TIME_TRANSLATE':
        case 'TIME_EXTEND':
          return `Delta: ${fmt(current.value[0], 2)}${n}`;
        case 'TIME_SLIDE':
          return `Time Slide: ${Math.round(current.value[0] * 100)}%${n}`;
        case 'TIME_SCALE':
          return `Scale: ${fmt(current.value[0])}${n}`;
        case 'TRANSLATION':
          return `D: ${fmt(current.value[0])}  ${fmt(current.value[1])}${c}${n}`;
        case 'RESIZE':
          return `Scale: ${fmt(current.value[0])}${c}${n}`;
        case 'ROTATION':
          return `Rot: ${fmt((current.value[0] * 180) / Math.PI, 2)}°${n}`;
      }
      return '';
    },
    status: () => [['LMB', 'Confirm'], ['RMB/Esc', 'Cancel'], ...(host.graph ? ([['X Y', 'Axis']] as [string, string][]) : []), ['Ctrl', 'Toggle Snap'], ['Shift', 'Precision']],
    onPointerMove(e: PointerEvent) {
      precise = e.shiftKey;
      const raw = { x: e.clientX, y: e.clientY };
      if (precise) {
        preciseAccum.x += (raw.x - lastRaw.x) * 0.1;
        preciseAccum.y += (raw.y - lastRaw.y) * 0.1;
        mouse = {
          x: preciseBase.x + preciseAccum.x,
          y: preciseBase.y + preciseAccum.y,
        };
      } else {
        preciseBase = raw;
        preciseAccum = { x: 0, y: 0 };
        mouse = raw;
      }
      lastRaw = raw;
      snapToggle = e.ctrlKey || e.metaKey;
      const a = Math.atan2(mouse.y - pivotScreen.y, mouse.x - pivotScreen.x);
      let da = a - lastAngle;
      if (da > Math.PI) da -= Math.PI * 2;
      if (da < -Math.PI) da += Math.PI * 2;
      lastAngle = a;
      rotTotal += da;
      compute();
    },
    onPointerDown(e: PointerEvent) {
      if (e.button === 0) return 'FINISHED';
      if (e.button === 2) return 'CANCELLED';
      return undefined;
    },
    onPointerUp(e: PointerEvent) {
      if (opts.releaseConfirm && e.button === 0) return 'FINISHED';
      return undefined;
    },
    onWheel(e: WheelEvent) {
      if (!host.proportional) return;
      resizeProportional(e.deltaY > 0 ? 1 / 1.1 : 1.1);
    },
    onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter' || e.key === ' ') return 'FINISHED';
      if (host.proportional && e.type === 'keydown' && (e.key === 'PageUp' || e.key === 'PageDown')) {
        resizeProportional(e.key === 'PageUp' ? 1.1 : 1 / 1.1);
        return true;
      }
      if (e.key === 'Control' || e.key === 'Meta') {
        snapToggle = e.type === 'keydown';
        compute();
        return true;
      }
      if (e.type !== 'keydown') return true;
      if (host.graph && (e.code === 'KeyX' || e.code === 'KeyY')) {
        const c = e.code === 'KeyX' ? 'X' : 'Y';
        constraint = constraint === c ? 'NONE' : c;
        compute();
        return true;
      }
      const k = e.key;
      if (/^[0-9.]$/.test(k) || k === '*' || k === '/' || k === '+' || k === '(' || k === ')') {
        numeric += k;
        compute();
        return true;
      }
      if (k === '-') {
        numeric = numeric === '' ? '-' : numeric === '-' ? '' : numeric + '-';
        compute();
        return true;
      }
      if (k === 'Backspace') {
        numeric = e.ctrlKey ? '' : numeric.slice(0, -1);
        compute();
        return true;
      }
      return true;
    },
    cancel() {
      const touched = new Set<FCurve>();
      for (const s of snaps) {
        restore(s);
        touched.add(s.fc);
      }
      for (const fc of touched) {
        sortKeyframes(fc);
        calcHandles(fc);
      }
      opts.onCancel?.();
      app.changed('doc');
    },
    finish() {
      const touched = new Set(snaps.map((s) => s.fc));
      for (const fc of touched) finalizeCurve(fc);
      handler.redoOp = {
        idname: opts.redoIdname,
        props: {
          mode,
          value: [...current.value],
          constraint: current.constraint,
          side: current.side ?? 'RIGHT',
        },
      };
      opts.afterFinish?.();
    },
  };
  handler.redoOp = {
    idname: opts.redoIdname,
    props: {
      mode,
      value: [...current.value],
      constraint,
      side: side ?? 'RIGHT',
    },
  };
  app.startModal(handler);
  compute();
  return true;
}

/** Keys whose handles are drawn (and pickable) in the Graph Editor. */
export function anySelectedKeys(curves: CurveRef[]) {
  return curves.some((r) => r.fc.keyframe_points.some(isAnySelected));
}
