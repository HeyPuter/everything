// Grease Pencil geometry in geometry nodes: layers of strokes, each a curves component (the
// drawing at the evaluated frame) with the layer transform. Stroke attributes use the names of
// the Grease Pencil data: radius, opacity, vertex_color (points), material_index, fill_color,
// fill_opacity, softness, start_cap, end_cap (strokes).
import { CurvesComponent, composeMat, mulMat, transformPositions, type AttrMap } from '../geometry';
import type { DocumentData, ObjectData } from '../../data/types';
import type { GPDrawing, GreasePencilData } from '../../greasepencil/types';
import { setCurveAttr, setPointAttr, transformCurveAttrs } from './curvedata';
import { joinCurves } from '../ops/join';

export interface GPLayerGeometry {
  name: string;
  curves: CurvesComponent;
  /** column-major 4×4 layer transform */
  transform: number[];
  opacity: number;
}

export class GreasePencilComponent {
  readonly kind = 'GREASE_PENCIL' as const;
  constructor(
    public layers: GPLayerGeometry[],
    public materials: (string | null)[] = [],
    public depthOrder: '2D' | '3D' = '2D',
  ) {
    for (const l of layers) layerNames.set(l.curves, l.name);
  }
  get layerCount() {
    return this.layers.length;
  }
  copy(layers = this.layers.map((l) => ({ ...l }))) {
    return new GreasePencilComponent(layers, [...this.materials], this.depthOrder);
  }
}

/** Layer name of a layer's strokes (for layer selections evaluated on strokes). */
export const layerNames = new WeakMap<CurvesComponent, string>();

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const isIdentity = (m: ArrayLike<number>) => IDENTITY.every((v, i) => Math.abs(m[i] - v) < 1e-9);

/** Strokes of a layer moved into the space the layer transform maps to. */
export function layerCurvesInParent(l: GPLayerGeometry): CurvesComponent {
  if (isIdentity(l.transform)) return l.curves;
  const c = l.curves.copy();
  c.positions = transformPositions(l.transform, l.curves.positions);
  transformCurveAttrs(c, l.transform);
  return c;
}

export function joinGreasePencil(list: (GreasePencilComponent | undefined)[]): GreasePencilComponent | undefined {
  const gps = list.filter((g): g is GreasePencilComponent => !!g);
  if (gps.length <= 1) return gps[0];
  return new GreasePencilComponent(
    gps.flatMap((g) => g.layers),
    gps[0].materials,
    gps[0].depthOrder,
  );
}

export function transformGreasePencil(gp: GreasePencilComponent, m: ArrayLike<number>): GreasePencilComponent {
  return gp.copy(gp.layers.map((l) => ({ ...l, transform: Array.from(mulMat(m, l.transform)) })));
}

/** Strokes of a drawing as curves (positions in layer space). */
export function drawingToCurves(d: GPDrawing): CurvesComponent {
  const attrs: AttrMap = new Map();
  const np = d.position.length / 3;
  setPointAttr(attrs, 'radius', 'FLOAT', d.radius.length === np ? d.radius : new Float32Array(np).fill(0.01));
  if (d.opacity.length === np) setPointAttr(attrs, 'opacity', 'FLOAT', d.opacity);
  if (d.vertex_color.length === np * 4) setPointAttr(attrs, 'vertex_color', 'FLOAT_COLOR', d.vertex_color);
  const nc = d.offsets.length - 1;
  if (d.material_index.length === nc) setCurveAttr(attrs, 'material_index', 'INT', Int32Array.from(d.material_index));
  if (d.fill_color.length === nc * 4) setCurveAttr(attrs, 'fill_color', 'FLOAT_COLOR', d.fill_color);
  if (d.fill_opacity.length === nc) setCurveAttr(attrs, 'fill_opacity', 'FLOAT', d.fill_opacity);
  if (d.start_cap.length === nc) setCurveAttr(attrs, 'start_cap', 'INT8', Int32Array.from(d.start_cap));
  if (d.end_cap.length === nc) setCurveAttr(attrs, 'end_cap', 'INT8', Int32Array.from(d.end_cap));
  // stroke spline types (Bézier strokes bring their handles)
  if (d.curve_type?.length === nc) {
    setCurveAttr(attrs, 'curve_type', 'INT8', Int32Array.from(d.curve_type));
    if (d.resolution?.length === nc) setCurveAttr(attrs, 'resolution', 'INT', Int32Array.from(d.resolution));
    if (d.nurbs_order?.length === nc) setCurveAttr(attrs, 'nurbs_order', 'INT8', Int32Array.from(d.nurbs_order));
    if (d.knots_mode?.length === nc) setCurveAttr(attrs, 'knots_mode', 'INT8', Int32Array.from(d.knots_mode));
    if (d.handle_left?.length === np * 3 && d.handle_right?.length === np * 3 && d.handle_type_left && d.handle_type_right) {
      setPointAttr(attrs, 'handle_left', 'FLOAT_VECTOR', d.handle_left);
      setPointAttr(attrs, 'handle_right', 'FLOAT_VECTOR', d.handle_right);
      setPointAttr(attrs, 'handle_type_left', 'INT8', Int32Array.from(d.handle_type_left));
      setPointAttr(attrs, 'handle_type_right', 'INT8', Int32Array.from(d.handle_type_right));
    }
  }
  return new CurvesComponent(d.position, d.offsets, d.cyclic, attrs);
}

function layerMatrix(l: { translation: number[]; rotation: number[]; scale: number[] }): number[] {
  return Array.from(composeMat(l.translation, l.rotation, l.scale));
}

/** Grease Pencil object at a frame: visible layers with the drawing shown at that frame. */
export function greasePencilGeometry(doc: DocumentData, ob: ObjectData, frame: number): GreasePencilComponent | null {
  if (ob.type !== 'GREASEPENCIL' || !ob.data) return null;
  const gp: GreasePencilData | undefined = doc.grease_pencils?.[ob.data];
  if (!gp) return null;
  const layers: GPLayerGeometry[] = [];
  for (const l of gp.layers) {
    if (l.hide) continue;
    let best = -1;
    for (let i = 0; i < l.frames.length; i++) if (l.frames[i].frame_number <= frame && (best < 0 || l.frames[i].frame_number >= l.frames[best].frame_number)) best = i;
    const d = best >= 0 ? gp.drawings[l.frames[best].drawing] : null;
    const curves = d ? drawingToCurves(d) : new CurvesComponent(new Float32Array(0), new Uint32Array([0]), new Uint8Array(0));
    layers.push({ name: l.name, curves, transform: layerMatrix(l), opacity: l.opacity });
  }
  return new GreasePencilComponent(layers, [...gp.materials], gp.stroke_depth_order);
}

/** Curves of a geometry plus the strokes of its Grease Pencil layers (for display). */
export function curvesWithGreasePencil(g: { curves?: CurvesComponent; greasePencil?: GreasePencilComponent }): CurvesComponent | undefined {
  if (!g.greasePencil?.layers.length) return g.curves;
  const parts = [...(g.curves ? [g.curves] : []), ...g.greasePencil.layers.map(layerCurvesInParent).filter((c) => c.pointCount)];
  return parts.length ? joinCurves(parts) : undefined;
}
