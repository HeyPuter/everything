// Move / rotate / scale / shear / mirror of UVs: interactive modal transforms whose final values
// are stored as operator properties (Adjust Last Operation re-runs them), with pivot points,
// axis constraints, numeric input, increment snapping and proportional editing.
import { app, registerOperators, type OpContext, type PropDef } from '../../app/app';
import { UVTopo, selReader, type UVLayer } from './uvcore';
import { islandCorners } from './uvalgo';
import { uvLayers, uvEditPoll, ctxUVEditor, uvCursor, uvChanged, type UVView } from './uvcontext';

export type UVPivot = 'BOUNDING_BOX_CENTER' | 'CURSOR' | 'INDIVIDUAL_ORIGINS' | 'MEDIAN_POINT';
type Kind = 'TRANSLATE' | 'ROTATE' | 'RESIZE' | 'SHEAR';

const FALLOFFS: [string, string][] = [
  ['SMOOTH', 'Smooth'],
  ['SPHERE', 'Sphere'],
  ['ROOT', 'Root'],
  ['INVERSE_SQUARE', 'Inverse Square'],
  ['SHARP', 'Sharp'],
  ['LINEAR', 'Linear'],
  ['CONSTANT', 'Constant'],
  ['RANDOM', 'Random'],
];

export function falloff(type: string, t: number, seed = 0): number {
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
    case 'RANDOM': {
      const h = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
      return x * (0.5 + 0.5 * (h - Math.floor(h)));
    }
    default:
      return x * x * (3 - 2 * x);
  }
}

interface Part {
  layer: UVLayer;
  t: UVTopo;
  base: Float32Array;
  /** per corner weight (1 = selected, 0..1 proportional, 0 = fixed) */
  w: Float32Array;
  /** corners with weight > 0 */
  moving: number[];
  /** per corner pivot for individual origins */
  local?: Float32Array;
}

export interface TransformParams {
  kind: Kind;
  value: number[];
  center: [number, number];
  pivot: UVPivot;
  constraint: [boolean, boolean];
  proportional: boolean;
  size: number;
  falloffType: string;
}

/** Gather selected UVs (and proportional neighbours) of the edited meshes. */
export function collectParts(proportional: boolean, size: number, falloffType: string, individual: boolean, layers = uvLayers()): Part[] {
  const out: Part[] = [];
  for (const layer of layers) {
    const t = new UVTopo(layer);
    const sel = selReader(layer);
    const me = layer.me;
    const w = new Float32Array(me.indices.length);
    const moving: number[] = [];
    const selectedVerts: number[] = [];
    for (const f of layer.faces)
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++)
        if (sel(c)) {
          w[c] = 1;
          moving.push(c);
        }
    if (!moving.length) continue;
    if (proportional && size > 0) {
      for (const c of moving) selectedVerts.push(t.uvVert[c]);
      const pts = [...new Set(selectedVerts)].map((id) => t.vertUV(id));
      for (let id = 0; id < t.vertCount; id++) {
        const cs = t.vertCorners[id];
        if (cs.some((c) => w[c] >= 1)) continue;
        const [u, v] = t.vertUV(id);
        let d = Infinity;
        for (const p of pts) d = Math.min(d, Math.hypot(p[0] - u, p[1] - v));
        if (d >= size) continue;
        const k = falloff(falloffType, d / size, id);
        if (k <= 0) continue;
        for (const c of cs) {
          w[c] = k;
          moving.push(c);
        }
      }
    }
    const part: Part = { layer, t, base: new Float32Array(me.uvs), w, moving };
    if (individual) {
      part.local = new Float32Array(me.indices.length * 2);
      for (const faces of t.islandFaces()) {
        const cs = islandCorners(t, faces).filter((c) => w[c] >= 1);
        if (!cs.length) continue;
        let a = Infinity,
          b = Infinity,
          c2 = -Infinity,
          d = -Infinity;
        for (const c of cs) {
          a = Math.min(a, me.uvs[c * 2]);
          c2 = Math.max(c2, me.uvs[c * 2]);
          b = Math.min(b, me.uvs[c * 2 + 1]);
          d = Math.max(d, me.uvs[c * 2 + 1]);
        }
        for (const c of islandCorners(t, faces)) {
          part.local[c * 2] = (a + c2) / 2;
          part.local[c * 2 + 1] = (b + d) / 2;
        }
      }
    }
    out.push(part);
  }
  return out;
}

/** Pivot of the selection. */
export function pivotCenter(parts: Part[], pivot: UVPivot): [number, number] {
  if (pivot === 'CURSOR') return [uvCursor.u, uvCursor.v];
  let a = Infinity,
    b = Infinity,
    c = -Infinity,
    d = -Infinity,
    su = 0,
    sv = 0,
    n = 0;
  for (const p of parts) {
    const seen = new Set<number>();
    for (const k of p.moving) {
      if (p.w[k] < 1) continue;
      const id = p.t.uvVert[k];
      if (seen.has(id)) continue;
      seen.add(id);
      const u = p.base[k * 2],
        v = p.base[k * 2 + 1];
      a = Math.min(a, u);
      c = Math.max(c, u);
      b = Math.min(b, v);
      d = Math.max(d, v);
      su += u;
      sv += v;
      n++;
    }
  }
  if (!n) return [0, 0];
  return pivot === 'MEDIAN_POINT' ? [su / n, sv / n] : [(a + c) / 2, (b + d) / 2];
}

/** Write transformed UVs for the given parameters. */
export function applyParts(parts: Part[], p: TransformParams) {
  for (const part of parts) {
    const uvs = new Float32Array(part.base);
    for (const k of part.moving) {
      const w = part.w[k];
      const u0 = part.base[k * 2],
        v0 = part.base[k * 2 + 1];
      const cu = part.local && p.pivot === 'INDIVIDUAL_ORIGINS' ? part.local[k * 2] : p.center[0];
      const cv = part.local && p.pivot === 'INDIVIDUAL_ORIGINS' ? part.local[k * 2 + 1] : p.center[1];
      let u = u0,
        v = v0;
      if (p.kind === 'TRANSLATE') {
        u += p.value[0] * w;
        v += p.value[1] * w;
      } else if (p.kind === 'ROTATE') {
        const a = p.value[0] * w;
        const cs = Math.cos(a),
          sn = Math.sin(a);
        const du = u0 - cu,
          dv = v0 - cv;
        u = cu + du * cs - dv * sn;
        v = cv + du * sn + dv * cs;
      } else if (p.kind === 'RESIZE') {
        const su = 1 + (p.value[0] - 1) * w,
          sv = 1 + (p.value[1] - 1) * w;
        u = cu + (u0 - cu) * su;
        v = cv + (v0 - cv) * sv;
      } else {
        // shear along U by default, along V when constrained to Y
        if (p.constraint[1] && !p.constraint[0]) v = v0 + p.value[0] * w * (u0 - cu);
        else u = u0 + p.value[0] * w * (v0 - cv);
      }
      uvs[k * 2] = u;
      uvs[k * 2 + 1] = v;
    }
    part.layer.me.uvs = uvs;
  }
  uvChanged();
}

function restore(parts: Part[]) {
  for (const p of parts) p.layer.me.uvs = p.base;
  uvChanged();
}

// ---------------------------------------------------------------------------
// operators

const propEditProps: PropDef[] = [
  { id: 'use_proportional_edit', label: 'Proportional Editing', type: 'bool', default: false },
  { id: 'proportional_edit_falloff', label: 'Proportional Falloff', type: 'enum', default: 'SMOOTH', items: FALLOFFS, showIf: (p) => !!p.use_proportional_edit },
  { id: 'proportional_size', label: 'Proportional Size', type: 'float', default: 0.1, min: 0.000001, softMax: 2, showIf: (p) => !!p.use_proportional_edit },
];

const hiddenProps: PropDef[] = [
  { id: 'center', type: 'vec2', default: [0, 0], hidden: true },
  { id: 'pivot', type: 'enum', default: 'MEDIAN_POINT', items: [['BOUNDING_BOX_CENTER', 'Bounding Box Center'], ['CURSOR', '2D Cursor'], ['INDIVIDUAL_ORIGINS', 'Individual Origins'], ['MEDIAN_POINT', 'Median Point']], hidden: true },
  { id: 'release_confirm', type: 'bool', default: false, hidden: true },
  { id: 'use_center', type: 'bool', default: false, hidden: true },
];

const IDS: Record<Kind, string> = { TRANSLATE: 'uv.translate', ROTATE: 'uv.rotate', RESIZE: 'uv.resize', SHEAR: 'uv.shear' };
const LABELS: Record<Kind, string> = { TRANSLATE: 'Move', ROTATE: 'Rotate', RESIZE: 'Resize', SHEAR: 'Shear' };

function valueOf(kind: Kind, p: Record<string, unknown>): number[] {
  const v = p.value;
  if (kind === 'ROTATE' || kind === 'SHEAR') return [Number(v) || 0];
  return (v as number[]) ?? (kind === 'RESIZE' ? [1, 1] : [0, 0]);
}

function execTransform(kind: Kind, p: Record<string, unknown>, view: UVView | null) {
  const pivot = ((p.pivot as UVPivot) ?? view?.pivot ?? 'MEDIAN_POINT') as UVPivot;
  const parts = collectParts(!!p.use_proportional_edit, p.proportional_size as number, p.proportional_edit_falloff as string, pivot === 'INDIVIDUAL_ORIGINS');
  if (!parts.length) return 'CANCELLED' as const;
  const center = p.use_center ? (p.center as [number, number]) : pivotCenter(parts, pivot);
  applyParts(parts, { kind, value: valueOf(kind, p), center, pivot, constraint: [false, false], proportional: !!p.use_proportional_edit, size: p.proportional_size as number, falloffType: p.proportional_edit_falloff as string });
  return 'FINISHED' as const;
}

/** Start an interactive UV transform. */
export function startUVTransform(kind: Kind, ctx: OpContext, props: Record<string, unknown>) {
  const view = ctxUVEditor(ctx);
  if (!view) return 'CANCELLED' as const;
  const ts = app.doc.scene.tool_settings;
  let proportional = ts.use_proportional_edit;
  let size = ts.proportional_size > 0 && ts.proportional_size < 5 ? ts.proportional_size : 0.1;
  const falloffType = ts.proportional_edit_falloff;
  const pivot = view.pivot;
  let parts = collectParts(proportional, size, falloffType, pivot === 'INDIVIDUAL_ORIGINS');
  if (!parts.length) return 'CANCELLED' as const;
  const center = pivotCenter(parts, pivot);
  const r = view.el.getBoundingClientRect();
  const ev = ctx.event ?? app.pointer;
  const start = { x: ev.x - r.left, y: ev.y - r.top };
  let mouse = { ...start };
  const constraint: [boolean, boolean] = [false, false];
  let numeric = '';
  let snap = false,
    precise = false;
  let value: number[] = kind === 'RESIZE' ? [1, 1] : kind === 'TRANSLATE' ? [0, 0] : [0];
  const releaseConfirm = !!props.release_confirm;
  // accumulate rotation across the ±180° wrap
  let lastAng = 0,
    totalAng = 0;
  const cPx = view.toPx(center[0], center[1]);
  const startUV = view.toUV(start.x, start.y);
  // snapping: the header toggle (Ctrl inverts it while transforming)
  const snapOn = () => !!ts.use_snap_uv !== snap;
  const snapElement = ts.snap_uv_element ?? 'INCREMENT';
  // vertex snapping targets: UV vertices that do not move
  const targets: [number, number][] = [];
  const sources: [number, number][] = [];
  if (kind === 'TRANSLATE')
    for (const part of parts) {
      for (let id = 0; id < part.t.vertCount; id++) {
        const cs = part.t.vertCorners[id];
        const moving = cs.some((c) => part.w[c] > 0);
        const uv = part.t.vertUV(id);
        if (!moving) targets.push(uv);
        else if (cs.some((c) => part.w[c] >= 1)) sources.push(uv);
      }
    }
  const snapVertex = (du: number, dv: number): [number, number] | null => {
    // the target nearest to the pointer, within 20 px
    const cur = view.toUV(mouse.x, mouse.y);
    const r = 20 / view.scale();
    let best: [number, number] | null = null,
      bd = r;
    for (const t of targets) {
      const d = Math.hypot(t[0] - cur.u, t[1] - cur.v);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    if (!best) return null;
    // the moved UV closest to it lands exactly on it
    let src: [number, number] | null = null;
    bd = Infinity;
    for (const s of sources) {
      const d = Math.hypot(s[0] + du - best[0], s[1] + dv - best[1]);
      if (d < bd) {
        bd = d;
        src = s;
      }
    }
    return src ? [best[0] - src[0], best[1] - src[1]] : null;
  };
  const compute = () => {
    const num = numeric && numeric !== '-' ? parseFloat(numeric) : NaN;
    const cur = view.toUV(mouse.x, mouse.y);
    const only = constraint[0] !== constraint[1] ? (constraint[0] ? 0 : 1) : -1;
    if (kind === 'TRANSLATE') {
      let du = cur.u - startUV.u,
        dv = cur.v - startUV.v;
      if (precise) {
        du *= 0.1;
        dv *= 0.1;
      }
      if (snapOn()) {
        const v = snapElement === 'VERTEX' ? snapVertex(du, dv) : null;
        if (v) [du, dv] = v;
        else if (snapElement === 'INCREMENT') {
          const s = view.gridStep() / (precise ? 4 : 1);
          du = Math.round(du / s) * s;
          dv = Math.round(dv / s) * s;
        }
      }
      if (Number.isFinite(num)) {
        du = only === 1 ? 0 : num;
        dv = only === 1 ? num : only === 0 ? 0 : 0;
      }
      if (only === 0) dv = 0;
      if (only === 1) du = 0;
      value = [du, dv];
    } else if (kind === 'ROTATE') {
      const a = Math.atan2(cur.v - center[1], cur.u - center[0]) - Math.atan2(startUV.v - center[1], startUV.u - center[0]);
      let d = a - lastAng;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      totalAng += precise ? d * 0.1 : d;
      lastAng = a;
      let ang = totalAng;
      if (snapOn()) ang = Math.round(ang / (Math.PI / 36)) * (Math.PI / 36);
      if (Number.isFinite(num)) ang = (num * Math.PI) / 180;
      value = [ang];
    } else if (kind === 'RESIZE') {
      const d0 = Math.max(1, Math.hypot(start.x - cPx.x, start.y - cPx.y));
      let s = Math.hypot(mouse.x - cPx.x, mouse.y - cPx.y) / d0;
      if (precise) s = 1 + (s - 1) * 0.1;
      if (snapOn()) s = Math.round(s * 10) / 10;
      if (Number.isFinite(num)) s = num;
      value = [only === 1 ? 1 : s, only === 0 ? 1 : s];
    } else {
      let k = (mouse.x - start.x) / 100;
      if (constraint[1] && !constraint[0]) k = -(mouse.y - start.y) / 100;
      if (precise) k *= 0.1;
      if (snapOn()) k = Math.round(k * 10) / 10;
      if (Number.isFinite(num)) k = num;
      value = [k];
    }
    applyParts(parts, { kind, value, center, pivot, constraint, proportional, size, falloffType });
  };
  const redoProps = () => ({
    value: kind === 'ROTATE' || kind === 'SHEAR' ? value[0] : value,
    center,
    use_center: true,
    pivot,
    use_proportional_edit: proportional,
    proportional_edit_falloff: falloffType,
    proportional_size: size,
  });
  const handler = {
    label: LABELS[kind],
    redoOp: { idname: IDS[kind], props: redoProps() },
    header: () => {
      const f = (x: number) => x.toFixed(4);
      let s = '';
      if (kind === 'TRANSLATE') s = `D: ${f(value[0])}  ${f(value[1])}`;
      else if (kind === 'ROTATE') s = `Rot: ${((value[0] * 180) / Math.PI).toFixed(2)}°`;
      else if (kind === 'RESIZE') s = `Scale: ${f(value[0])}  ${f(value[1])}`;
      else s = `Shear: ${f(value[0])}`;
      if (numeric) s += ` [${numeric}]`;
      if (constraint[0] !== constraint[1]) s += ` along ${constraint[0] ? 'X' : 'Y'}`;
      if (proportional) s += `  Proportional size: ${size.toFixed(3)}`;
      return s;
    },
    status: () =>
      [
        ['LMB / Enter', 'Confirm'],
        ['RMB / Esc', 'Cancel'],
        ['X / Y', 'Axis'],
        ['Ctrl', 'Snap'],
        ['Shift', 'Precision'],
      ] as [string, string][],
    onPointerMove(e: PointerEvent) {
      mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      snap = e.ctrlKey || e.metaKey;
      precise = e.shiftKey;
      compute();
      handler.redoOp = { idname: IDS[kind], props: redoProps() };
    },
    onPointerDown(e: PointerEvent) {
      return e.button === 0 ? ('FINISHED' as const) : ('CANCELLED' as const);
    },
    onPointerUp(e: PointerEvent) {
      if (releaseConfirm && e.button === 0) return 'FINISHED' as const;
      return undefined;
    },
    onWheel(e: WheelEvent) {
      if (!proportional) return;
      size = Math.max(1e-4, size * (e.deltaY > 0 ? 1.1 : 1 / 1.1));
      restore(parts);
      parts = collectParts(proportional, size, falloffType, pivot === 'INDIVIDUAL_ORIGINS');
      compute();
      handler.redoOp = { idname: IDS[kind], props: redoProps() };
    },
    onKey(e: KeyboardEvent) {
      if (e.type !== 'keydown') {
        if (e.key === 'Control' || e.key === 'Meta') snap = false;
        if (e.key === 'Shift') precise = false;
        return true;
      }
      if (e.key === 'Escape') return 'CANCELLED' as const;
      if (e.key === 'Enter') return 'FINISHED' as const;
      const k = e.key.toLowerCase();
      if (k === 'x') {
        const was = constraint[0] && !constraint[1];
        constraint[0] = !was;
        constraint[1] = false;
      } else if (k === 'y') {
        const was = constraint[1] && !constraint[0];
        constraint[1] = !was;
        constraint[0] = false;
      } else if (k === 'o') {
        proportional = !proportional;
        restore(parts);
        parts = collectParts(proportional, size, falloffType, pivot === 'INDIVIDUAL_ORIGINS');
      } else if (e.key === 'PageUp' || e.key === 'PageDown') {
        if (proportional) {
          size = Math.max(1e-4, size * (e.key === 'PageUp' ? 1.1 : 1 / 1.1));
          restore(parts);
          parts = collectParts(proportional, size, falloffType, pivot === 'INDIVIDUAL_ORIGINS');
        }
      } else if (/^[0-9.]$/.test(e.key)) numeric += e.key;
      else if (e.key === '-') numeric = numeric.startsWith('-') ? numeric.slice(1) : '-' + numeric;
      else if (e.key === 'Backspace') numeric = numeric.slice(0, -1);
      else if (e.key === 'Control' || e.key === 'Meta') snap = true;
      else if (e.key === 'Shift') precise = true;
      compute();
      handler.redoOp = { idname: IDS[kind], props: redoProps() };
      return true;
    },
    cancel() {
      restore(parts);
    },
    finish() {
      if (proportional !== ts.use_proportional_edit) ts.use_proportional_edit = proportional;
      if (proportional) ts.proportional_size = size;
    },
  };
  app.startModal(handler);
  compute();
  return 'RUNNING_MODAL' as const;
}

function transformOp(kind: Kind, valueProp: PropDef, description: string) {
  return {
    idname: IDS[kind],
    label: LABELS[kind],
    description,
    props: [valueProp, ...(kind === 'TRANSLATE' || kind === 'ROTATE' || kind === 'RESIZE' ? propEditProps : []), ...hiddenProps],
    poll: uvEditPoll,
    invoke: (ctx: OpContext, p: Record<string, unknown>) => startUVTransform(kind, ctx, p),
    exec: (ctx: OpContext, p: Record<string, unknown>) => execTransform(kind, p, ctxUVEditor(ctx)),
  };
}

function mirrorCenter(ctx: OpContext): { parts: Part[]; center: [number, number]; pivot: UVPivot } | null {
  const view = ctxUVEditor(ctx);
  const pivot = view?.pivot ?? 'MEDIAN_POINT';
  const parts = collectParts(false, 0, 'SMOOTH', pivot === 'INDIVIDUAL_ORIGINS');
  if (!parts.length) return null;
  return { parts, center: pivotCenter(parts, pivot), pivot };
}

registerOperators([
  transformOp('TRANSLATE', { id: 'value', label: 'Move', type: 'vec2', default: [0, 0] }, 'Move the selected UVs'),
  transformOp('ROTATE', { id: 'value', label: 'Angle', type: 'float', default: 0, subtype: 'angle' }, 'Rotate the selected UVs around the pivot point'),
  transformOp('RESIZE', { id: 'value', label: 'Scale', type: 'vec2', default: [1, 1] }, 'Scale the selected UVs around the pivot point'),
  transformOp('SHEAR', { id: 'value', label: 'Offset', type: 'float', default: 0 }, 'Shear the selected UVs along the horizontal axis'),
  {
    idname: 'uv.mirror',
    label: 'Mirror',
    description: 'Mirror the selected UVs around the pivot point',
    props: [{ id: 'axis', label: 'Axis', type: 'int', default: 0, min: 0, max: 1 }],
    poll: uvEditPoll,
    exec: (ctx, p) => {
      const m = mirrorCenter(ctx);
      if (!m) return 'CANCELLED';
      applyParts(m.parts, { kind: 'RESIZE', value: p.axis === 0 ? [-1, 1] : [1, -1], center: m.center, pivot: m.pivot, constraint: [false, false], proportional: false, size: 0, falloffType: 'SMOOTH' });
    },
  },
  {
    idname: 'uv.rotate90',
    label: 'Rotate UVs 90°',
    description: 'Rotate the selected UVs by a quarter turn around the pivot point',
    props: [{ id: 'clockwise', label: 'Clockwise', type: 'bool', default: false }],
    poll: uvEditPoll,
    internal: true,
    exec: (ctx, p) => {
      const m = mirrorCenter(ctx);
      if (!m) return 'CANCELLED';
      applyParts(m.parts, { kind: 'ROTATE', value: [p.clockwise ? -Math.PI / 2 : Math.PI / 2], center: m.center, pivot: m.pivot, constraint: [false, false], proportional: false, size: 0, falloffType: 'SMOOTH' });
    },
  },
]);

/** Translate the selection by a fixed amount (keyboard nudges). */
export function nudgeSelection(du: number, dv: number) {
  const parts = collectParts(false, 0, 'SMOOTH', false);
  if (!parts.length) return false;
  applyParts(parts, { kind: 'TRANSLATE', value: [du, dv], center: [0, 0], pivot: 'MEDIAN_POINT', constraint: [false, false], proportional: false, size: 0, falloffType: 'SMOOTH' });
  return true;
}
