// Viewport display of hair curves: shaded strand lines in Solid / Material Preview (and the
// Rendered fallback), object ids for picking and outlines, and the Edit / Sculpt Curves overlays
// (selection colours, control points). Path-traced and final renders get tubes (render.ts).
import { BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, LineSegments, Points, ShaderMaterial, Vector3, type Material } from 'three';
import { app } from '../app/app';
import { sceneSyncHooks, type SyncedObject } from '../render/scene';
import { drawHooks } from '../editors/view3d/draw';
import { overlayPopoverSections } from '../editors/view3d/hooks';
import { h } from '../ui/h';
import { checkbox, numberField } from '../ui/widgets';
import { renderContext } from '../render/context';
import { viewportMaterial } from '../render/pbr';
import { materialSlots } from '../geonodes/convert';
import type { DocumentData, ObjectData } from '../data/types';
import type { EvalMesh } from '../eval/types';
import type { Shading } from '../editors/view3d/state';
import { hairDisplay } from './eval';
import { hairOf, pointSelection, curveSelection } from './data';

const VS = /* glsl */ `
attribute vec3 tangent;
attribute float sel;
attribute float along;
varying vec3 vT;
varying float vSel;
varying float vAlong;
void main() {
  vT = normalize(normalMatrix * tangent);
  vSel = sel;
  vAlong = along;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FS = /* glsl */ `
uniform vec3 uColor;
uniform float uShowSel;
uniform float uLit;
varying vec3 vT;
varying float vSel;
varying float vAlong;
void main() {
  vec3 T = normalize(vT);
  vec3 L = normalize(vec3(0.35, 0.55, 1.0));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float tl = dot(T, L);
  float th = dot(T, H);
  float diff = sqrt(max(0.0, 1.0 - tl * tl));
  float spec = pow(sqrt(max(0.0, 1.0 - th * th)), 48.0) * 0.25;
  float ao = 0.55 + 0.45 * vAlong;
  vec3 c = uLit > 0.5 ? uColor * (0.25 + 0.75 * diff) * ao + vec3(spec) : uColor;
  if (uShowSel > 0.0) c = mix(c, mix(c * 0.25 + vec3(0.02), c, clamp(vSel, 0.0, 1.0)), uShowSel);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function strandMaterial() {
  return new ShaderMaterial({
    vertexShader: VS,
    fragmentShader: FS,
    uniforms: { uColor: { value: new Color(0.8, 0.8, 0.8) }, uShowSel: { value: 0 }, uLit: { value: 1 } },
  });
}

interface Entry {
  lines: LineSegments;
  mesh: EvalMesh | null;
  /** edit overlay: curves coloured by selection, control points */
  editLines: LineSegments;
  editPoints: Points;
  /** Bézier handles: all of them / only those of selected points */
  handlesAll: LineSegments;
  handlesSel: LineSegments;
  /** control polygon shown over the evaluated curves in Sculpt mode */
  cage: LineSegments;
  editKey: string;
  cageKey: string;
  so: SyncedObject;
}

const entries = new Map<string, Entry>();

/** Line geometry (indexed pairs) with tangents, selection and position along the strand. */
export function strandGeometry(m: EvalMesh): BufferGeometry {
  const curves = m.curves ?? [];
  let n = 0,
    segs = 0;
  for (const c of curves) {
    const k = c.points.length / 3;
    n += k;
    segs += Math.max(0, k - 1) + (c.cyclic && k > 2 ? 1 : 0);
  }
  const pos = new Float32Array(n * 3),
    tan = new Float32Array(n * 3),
    along = new Float32Array(n);
  const idx = n > 65535 ? new Uint32Array(segs * 2) : new Uint16Array(segs * 2);
  let o = 0,
    w = 0;
  for (const c of curves) {
    const k = c.points.length / 3;
    pos.set(c.points, o * 3);
    for (let i = 0; i < k; i++) {
      const a = Math.max(0, i - 1),
        b = Math.min(k - 1, i + 1);
      let tx = c.points[b * 3] - c.points[a * 3],
        ty = c.points[b * 3 + 1] - c.points[a * 3 + 1],
        tz = c.points[b * 3 + 2] - c.points[a * 3 + 2];
      const l = Math.hypot(tx, ty, tz) || 1;
      tx /= l;
      ty /= l;
      tz /= l;
      tan[(o + i) * 3] = tx;
      tan[(o + i) * 3 + 1] = ty;
      tan[(o + i) * 3 + 2] = tz;
      along[o + i] = k > 1 ? i / (k - 1) : 1;
      if (i + 1 < k) {
        idx[w++] = o + i;
        idx[w++] = o + i + 1;
      }
    }
    if (c.cyclic && k > 2) {
      idx[w++] = o + k - 1;
      idx[w++] = o;
    }
    o += k;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('tangent', new BufferAttribute(tan, 3));
  g.setAttribute('along', new BufferAttribute(along, 1));
  const disp = hairDisplay.get(m);
  const sel = disp?.selection && disp.selection.length === n ? disp.selection : new Float32Array(n).fill(1);
  g.setAttribute('sel', new BufferAttribute(sel, 1));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

function hashColor(name: string): [number, number, number] {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const c = new Color().setHSL((h % 360) / 360, 0.5, 0.55);
  return [c.r, c.g, c.b];
}

/** Base colour of the strands for a shading setup. */
export function strandColor(doc: DocumentData, ob: ObjectData, sh: Pick<Shading, 'type' | 'color_type' | 'single_color'> | null): Color {
  const slot0 = materialSlots(doc, ob)[0] ?? null;
  if (sh && (sh.type === 'MATERIAL' || sh.type === 'RENDERED')) {
    const vm = viewportMaterial(doc, slot0) as Material & { color?: Color };
    if (vm.color) return vm.color.clone();
  }
  if (sh?.color_type === 'SINGLE') return new Color(...sh.single_color);
  if (sh?.color_type === 'OBJECT') return new Color(ob.color[0], ob.color[1], ob.color[2]);
  if (sh?.color_type === 'RANDOM') return new Color(...hashColor(ob.name));
  const ma = slot0 ? doc.materials[slot0] : undefined;
  return ma ? new Color(ma.diffuse_color[0], ma.diffuse_color[1], ma.diffuse_color[2]) : new Color(0.8, 0.8, 0.8);
}

let lastRevision = -1;
sceneSyncHooks.push((doc, ev, so) => {
  if (lastRevision !== app.revision) {
    lastRevision = app.revision;
    for (const [id, e] of entries)
      if (!app.graph.get(id) || app.doc.objects[id]?.type !== 'CURVES') {
        e.lines.removeFromParent();
        e.editLines.removeFromParent();
        e.editPoints.removeFromParent();
        e.handlesAll.removeFromParent();
        e.handlesSel.removeFromParent();
        e.cage.removeFromParent();
        e.lines.geometry.dispose();
        entries.delete(id);
      }
  }
  if (ev.ob.type !== 'CURVES') return;
  let e = entries.get(ev.id);
  if (!e) {
    const lines = new LineSegments(new BufferGeometry(), strandMaterial());
    lines.matrixAutoUpdate = false;
    lines.userData.id = ev.id;
    const editLines = new LineSegments(new BufferGeometry(), new ShaderMaterial({ vertexColors: true, vertexShader: EDIT_VS, fragmentShader: EDIT_FS, uniforms: { uOpacity: { value: 1 } } }));
    editLines.matrixAutoUpdate = false;
    const editPoints = new Points(new BufferGeometry(), new ShaderMaterial({ vertexColors: true, vertexShader: POINT_VS, fragmentShader: POINT_FS, uniforms: { uSize: { value: 4 * (globalThis.devicePixelRatio || 1) } } }));
    editPoints.matrixAutoUpdate = false;
    const lineObj = () => {
      const l = new LineSegments(new BufferGeometry(), new ShaderMaterial({ vertexColors: true, vertexShader: EDIT_VS, fragmentShader: EDIT_FS, transparent: true, uniforms: { uOpacity: { value: 1 } } }));
      l.matrixAutoUpdate = false;
      return l;
    };
    entries.set(ev.id, (e = { lines, mesh: null, editLines, editPoints, handlesAll: lineObj(), handlesSel: lineObj(), cage: lineObj(), editKey: '', cageKey: '', so }));
  }
  e.so = so;
  for (const o of [e.lines, e.editLines, e.editPoints, e.handlesAll, e.handlesSel, e.cage]) if (o.parent !== so.root) so.root.add(o);
  const m = ev.mesh ?? null;
  if (e.mesh !== m) {
    e.mesh = m;
    e.lines.geometry.dispose();
    e.lines.geometry = m?.curves?.length ? strandGeometry(m) : new BufferGeometry();
  }
  syncEditOverlay(doc, ev.ob, e);
});

const EDIT_VS = /* glsl */ `
varying vec3 vColor;
void main() { vColor = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const EDIT_FS = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, uOpacity); }`;
const POINT_VS = /* glsl */ `
uniform float uSize;
varying vec3 vColor;
void main() { vColor = color; gl_PointSize = uSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z -= 0.0005 * gl_Position.w; }`;
const POINT_FS = /* glsl */ `
varying vec3 vColor;
void main() { vec2 d = gl_PointCoord - 0.5; if (dot(d, d) > 0.25) discard; gl_FragColor = vec4(vColor, 1.0); }`;

const SEL = new Color(1, 0.52, 0).convertSRGBToLinear(),
  WIRE_SEL = new Color(1, 0.62, 0.2).convertSRGBToLinear(),
  WIRE = new Color(0.12, 0.12, 0.12),
  UNSEL_POINT = new Color(0.05, 0.05, 0.05);

/** Whether the object is being edited in Curves Edit Mode. */
const inCurvesEdit = (ob: ObjectData) => app.doc.mode === 'EDIT' && app.activeObject?.id === ob.id;

function lineGeometry(pos: ArrayLike<number>, idx: number[], color: Color | ((i: number) => Color)): BufferGeometry {
  const n = pos.length / 3;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = typeof color === 'function' ? color(i) : color;
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(Float32Array.from(pos), 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

function setGeometry(o: LineSegments | Points, g: BufferGeometry) {
  o.geometry.dispose();
  o.geometry = g;
}

const HANDLE = new Color(0.55, 0.12, 0.12).convertSRGBToLinear(),
  HANDLE_SEL = new Color(1, 0.4, 0.4).convertSRGBToLinear(),
  CAGE = new Color(0.85, 0.85, 0.85).convertSRGBToLinear();

function syncEditOverlay(doc: DocumentData, ob: ObjectData, e: Entry) {
  const hc = hairOf(doc, ob);
  const o = hc?.curve_offsets;
  // Sculpt mode cage: the whole control polygon
  if (hc && o && app.doc.mode === 'SCULPT_CURVES' && app.activeObject?.id === ob.id) {
    const key = `${idOf(hc.positions)}:${idOf(hc.curve_offsets)}`;
    if (key !== e.cageKey) {
      e.cageKey = key;
      const idx: number[] = [];
      for (let c = 0; c + 1 < o.length; c++) for (let i = o[c]; i + 1 < o[c + 1]; i++) idx.push(i, i + 1);
      setGeometry(e.cage, lineGeometry(hc.positions, idx, CAGE));
    }
  } else e.cageKey = '';
  if (!hc || !o || !inCurvesEdit(ob)) {
    e.editKey = '';
    return;
  }
  const selData = hc.attributes.find((a) => a.name === '.selection')?.data ?? null;
  const hl = hc.attributes.find((a) => a.name === 'handle_left'),
    hr = hc.attributes.find((a) => a.name === 'handle_right'),
    ty = hc.attributes.find((a) => a.name === 'curve_type');
  const key = `${idOf(hc.positions)}:${idOf(hc.curve_offsets)}:${idOf(selData)}:${hc.selection_domain}:${idOf(hl?.data ?? null)}:${idOf(hr?.data ?? null)}:${idOf(ty?.data ?? null)}`;
  if (key === e.editKey) return;
  e.editKey = key;
  const np = hc.positions.length / 3;
  const point = pointSelectionSpread(hc);
  // the selected part of the control polygon is highlighted
  const idx: number[] = [];
  for (let c = 0; c + 1 < o.length; c++) for (let i = o[c]; i + 1 < o[c + 1]; i++) if (point[i] > 0.5 && point[i + 1] > 0.5) idx.push(i, i + 1);
  setGeometry(e.editLines, lineGeometry(hc.positions, idx, WIRE_SEL));
  const pc = new Float32Array(np * 3);
  for (let i = 0; i < np; i++) {
    const col = point[i] > 0.5 ? SEL : UNSEL_POINT;
    pc.set([col.r, col.g, col.b], i * 3);
  }
  const pg = new BufferGeometry();
  pg.setAttribute('position', new BufferAttribute(hc.positions, 3));
  pg.setAttribute('color', new Float32BufferAttribute(pc, 3));
  setGeometry(e.editPoints, pg);
  // Bézier handles: point → left handle, point → right handle
  const all: number[] = [],
    sel: number[] = [];
  const allIdx: number[] = [],
    selIdx: number[] = [];
  const allCol: Color[] = [],
    selCol: Color[] = [];
  if (hl && hr && ty) {
    for (let c = 0; c + 1 < o.length; c++) {
      if (ty.data[c] !== 2) continue;
      for (let i = o[c]; i < o[c + 1]; i++) {
        const on = point[i] > 0.5;
        for (const h of [hl.data, hr.data]) {
          for (const [list, ind, cols] of on ? [[all, allIdx, allCol], [sel, selIdx, selCol]] as const : [[all, allIdx, allCol]] as const) {
            const b = list.length / 3;
            list.push(hc.positions[i * 3], hc.positions[i * 3 + 1], hc.positions[i * 3 + 2], h[i * 3], h[i * 3 + 1], h[i * 3 + 2]);
            ind.push(b, b + 1);
            cols.push(on ? HANDLE_SEL : HANDLE, on ? HANDLE_SEL : HANDLE);
          }
        }
      }
    }
  }
  setGeometry(e.handlesAll, lineGeometry(all, allIdx, (i) => allCol[i]));
  setGeometry(e.handlesSel, lineGeometry(sel, selIdx, (i) => selCol[i]));
}

/** Selection of every control point (a curve's selection spread over its points). */
function pointSelectionSpread(hc: NonNullable<ReturnType<typeof hairOf>>): Float32Array {
  if (hc.selection_domain !== 'CURVE') return pointSelection(hc);
  const cs = curveSelection(hc);
  const pt = new Float32Array(hc.positions.length / 3);
  const o = hc.curve_offsets;
  for (let c = 0; c + 1 < o.length; c++) pt.fill(cs[c], o[c], o[c + 1]);
  return pt;
}

const ids = new WeakMap<object, number>();
let nextId = 1;
function idOf(a: object | null): number {
  if (!a) return 0;
  let i = ids.get(a);
  if (!i) ids.set(a, (i = nextId++));
  return i;
}

/** The objects whose strands are drawn by this module (for tests). */
export function strandObjects(): string[] {
  return [...entries.keys()];
}

// ---------------------------------------------------------------------------
// pass visibility: strands in the scene and ID passes, edit overlays in the overlay pass

drawHooks.passes.push((pass, view) => {
  if (!entries.size) return;
  const restore: (() => void)[] = [];
  const sh = view.shading;
  const ov = view.overlay as typeof view.overlay & { show_sculpt_curves_cage?: boolean; sculpt_curves_cage_opacity?: number };
  const doc = app.doc;
  for (const e of entries.values()) {
    const so = e.so;
    const ob = so.ev.ob;
    const lines = e.lines;
    const extras = [e.editLines, e.editPoints, e.handlesAll, e.handlesSel, e.cage];
    const prev = [lines.visible, lines.material, ...extras.map((x) => x.visible)] as const;
    restore.push(() => {
      lines.visible = prev[0] as boolean;
      lines.material = prev[1] as ShaderMaterial;
      extras.forEach((x, i) => (x.visible = prev[i + 2] as boolean));
    });
    for (const x of extras) x.visible = false;
    const editing = !!e.editKey;
    const sculpting = doc.mode === 'SCULPT_CURVES' && app.activeObject?.id === ob.id;
    const wireOnly = sh.type === 'WIREFRAME' || ob.display_type === 'WIRE' || ob.display_type === 'BOUNDS';
    if (pass === 'SCENE') {
      lines.visible = !wireOnly;
      if (!wireOnly) {
        const mat = lines.material as ShaderMaterial;
        mat.uniforms.uColor.value.copy(strandColor(doc, ob, sh));
        // Selection Opacity of the overlays dims unselected curves while sculpting
        mat.uniforms.uShowSel.value = sculpting && ov.show_overlays ? (ov.sculpt_mode_mask_opacity ?? 0.75) : 0;
        mat.uniforms.uLit.value = sh.type === 'SOLID' && sh.light === 'FLAT' ? 0 : 1;
      }
    } else if (pass === 'OVERLAY') {
      lines.visible = false;
      e.editLines.visible = editing;
      e.editPoints.visible = editing && hairOf(doc, ob)?.selection_domain === 'POINT';
      const handles = ov.display_handle ?? 'SELECTED';
      e.handlesAll.visible = editing && handles === 'ALL';
      e.handlesSel.visible = editing && handles === 'SELECTED';
      if (sculpting && e.cageKey && ov.show_sculpt_curves_cage) {
        e.cage.visible = true;
        (e.cage.material as ShaderMaterial).uniforms.uOpacity.value = ov.sculpt_curves_cage_opacity ?? 0.5;
      }
      // the polyline wire of the evaluated curves only shows in wireframe display
      if (so.wire) {
        const w = so.wire;
        const v = w.visible;
        if (!wireOnly && !ob.show_wire) w.visible = false;
        restore.push(() => (w.visible = v));
      }
    } else {
      // ID pass: draw the strands with the object's id material (picking, outlines)
      const idm = so.mesh?.visible ? so.mesh.material : null;
      lines.visible = !!idm && !Array.isArray(idm) && so.root.visible;
      if (idm && !Array.isArray(idm)) lines.material = idm;
    }
  }
  return () => restore.forEach((f) => f());
});

// Sculpt overlays: selection opacity and the control point cage
overlayPopoverSections.push((v) => {
  if (app.doc.mode !== 'SCULPT_CURVES') return null;
  const o = v.overlay as typeof v.overlay & { show_sculpt_curves_cage?: boolean; sculpt_curves_cage_opacity?: number };
  const set = (k: string) => (x: unknown) => (((o as unknown as Record<string, unknown>)[k] = x), app.changed('ui'));
  return [
    h('div', { class: 'pop-sub' }, 'Sculpt'),
    numberField({ id: 'o-hc-selop', label: 'Selection Opacity', value: o.sculpt_mode_mask_opacity ?? 0.75, min: 0, max: 1, slider: true, tip: 'How strongly unselected curves are dimmed', set: set('sculpt_mode_mask_opacity') }),
    h('div', { class: 'row-split' }, checkbox('o-hc-cage', 'Cage', !!o.show_sculpt_curves_cage, set('show_sculpt_curves_cage'), { tip: 'Show the control points the curves are evaluated from' }), numberField({ id: 'o-hc-cageop', value: o.sculpt_curves_cage_opacity ?? 0.5, min: 0, max: 1, slider: true, set: set('sculpt_curves_cage_opacity') })),
  ];
});

/** World-space bounds helper for frame selected etc. */
export function strandCenter(ob: ObjectData): Vector3 | null {
  const ev = app.graph.get(ob.id);
  const g = entries.get(ob.id)?.lines.geometry;
  if (!ev || !g?.boundingSphere) return null;
  return g.boundingSphere.center.clone().applyMatrix4(ev.world);
}

void renderContext;

// the object being edited or sculpted shows no selection outline around its strands
drawHooks.skipOutline.push((ob) => ob.type === 'CURVES' && app.doc.mode !== 'OBJECT' && app.activeObject?.id === ob.id);
