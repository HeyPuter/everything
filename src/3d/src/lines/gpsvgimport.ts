// File ▸ Import ▸ SVG as Grease Pencil: SVG shapes become strokes on the front (X-Z) plane, one
// layer per top-level group / element, with Stroke / Fill / Both materials and the exact colours
// stored as per-stroke fill colours and per-point vertex colours.
import { app, registerOperators } from '../app/app';
import { newObject } from '../data/defaults';
import type { DocumentData, ObjectData } from '../data/types';
import { addObjectToScene } from '../ops/object';
import { gpTable, newGreasePencil, newGPMaterial, newLayer, newPoint, newStroke, fromStrokes, setKeyframe, type GPStroke } from '../greasepencil/data';
import { pickFile } from '../io/native';
import { registerFormat } from '../io/files';
import { svgShapes, type SvgShape } from './svgparse';
import { uniqueIn } from './defaults';

/** Metres per SVG pixel at scale 1 (96 px per inch). */
export const PX_TO_M = 0.0254 / 96;

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export interface SvgImportOptions {
  resolution?: number;
  scale?: number;
  /** put the drawing's centre at the object origin */
  recenter_bounds?: boolean;
}

/** Grease pencil strokes (object space, front plane) per layer, and the materials they use. */
export function svgToStrokes(shapes: SvgShape[], o: SvgImportOptions = {}) {
  const k = PX_TO_M * (o.scale ?? 10);
  let cx = 0,
    cy = 0;
  if (o.recenter_bounds !== false) {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const s of shapes)
      for (const sp of s.subpaths)
        for (const [x, y] of sp.pts) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
    if (Number.isFinite(x0)) {
      cx = (x0 + x1) / 2;
      cy = (y0 + y1) / 2;
    }
  }
  const layers = new Map<string, GPStroke[]>();
  const kinds = new Set<'Both' | 'Stroke' | 'Fill'>();
  let fillId = 1;
  for (const s of shapes) {
    const kind = s.fill && s.stroke ? 'Both' : s.stroke ? 'Stroke' : 'Fill';
    kinds.add(kind);
    let list = layers.get(s.layer);
    if (!list) layers.set(s.layer, (list = []));
    const vc: [number, number, number, number] = s.stroke ? [toLinear(s.stroke[0]), toLinear(s.stroke[1]), toLinear(s.stroke[2]), 1] : [0, 0, 0, 0];
    const fc: [number, number, number, number] = s.fill ? [toLinear(s.fill[0]), toLinear(s.fill[1]), toLinear(s.fill[2]), 1] : [0, 0, 0, 0];
    // a compound path fills as one shape (inner subpaths are holes)
    const fid = s.fill && s.subpaths.length > 1 ? fillId++ : 0;
    const radius = (Math.max(0, s.width) / 2) * k;
    const opacity = s.stroke ? s.stroke[3] : 1;
    for (const sp of s.subpaths)
      list.push(
        newStroke(
          sp.pts.map(([x, y]) => newPoint([(x - cx) * k, 0, -(y - cy) * k], radius, opacity, vc)),
          { cyclic: sp.closed || (!!s.fill && !s.stroke), material_index: 0, fill_color: fc, fill_opacity: s.fill ? s.fill[3] : 1, fill_id: fid, kind } as never,
        ),
      );
  }
  return { layers, kinds: [...kinds] };
}

/** Create a grease pencil object from SVG text; returns it (null when nothing could be read). */
export function importSvgText(doc: DocumentData, text: string, name: string, o: SvgImportOptions = {}): ObjectData | null {
  const xml = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = xml.documentElement;
  if (!root || root.tagName.toLowerCase().replace(/^svg:/, '') !== 'svg') return null;
  const { shapes } = svgShapes(root, Math.max(1, Math.round(o.resolution ?? 10)));
  if (!shapes.length) return null;
  const { layers, kinds } = svgToStrokes(shapes, o);
  const gp = newGreasePencil(uniqueIn(Object.values(gpTable(doc)).map((g) => g.name), name));
  gpTable(doc)[gp.id] = gp;
  const matIndex: Record<string, number> = {};
  for (const kind of ['Both', 'Stroke', 'Fill'] as const) {
    if (!kinds.includes(kind)) continue;
    const ma = newGPMaterial(uniqueIn(Object.values(doc.materials).map((m) => m.name), kind), { show_stroke: kind !== 'Fill', show_fill: kind !== 'Stroke', color: [0, 0, 0, 1], fill_color: [0.5, 0.5, 0.5, 1] });
    doc.materials[ma.id] = ma;
    matIndex[kind] = gp.materials.length;
    gp.materials.push(ma.id);
  }
  const frame = doc.scene.frame_current;
  for (const [lname, strokes] of layers) {
    const l = newLayer(uniqueIn(gp.layers.map((x) => x.name), lname));
    gp.layers.push(l);
    for (const s of strokes) {
      const kind = (s as unknown as { kind: string }).kind;
      s.material_index = matIndex[kind] ?? 0;
      delete (s as unknown as { kind?: string }).kind;
    }
    setKeyframe(gp, l, frame, fromStrokes(strokes));
  }
  gp.active_layer_index = gp.layers.length - 1;
  const ob = newObject(name, 'GREASEPENCIL', gp.id);
  addObjectToScene(doc, ob, { location: [...doc.scene.cursor.location] });
  return ob;
}

registerOperators([
  {
    idname: 'wm.grease_pencil_import_svg',
    label: 'SVG as Grease Pencil',
    description: 'Import an SVG drawing as a grease pencil object (paths, shapes and their colours)',
    props: [
      { id: 'resolution', label: 'Resolution', type: 'int', default: 10, min: 1, max: 100 },
      { id: 'scale', label: 'Scale', type: 'float', default: 10, min: 0.001, max: 100 },
      { id: 'recenter_bounds', label: 'Center on Bounds', type: 'bool', default: true },
      { id: 'filepath', label: 'File Path', type: 'string', default: '', hidden: true },
      { id: 'text', label: 'SVG Text', type: 'string', default: '', hidden: true },
    ],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    invoke: (_ctx, p) => {
      void pickFile('.svg').then(async (f) => {
        if (!f) return;
        const text = await f.text();
        app.run('wm.grease_pencil_import_svg', { ...p, text, filepath: f.name }, { invoke: false });
      });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const text = String(p.text ?? '');
      if (!text) return 'CANCELLED';
      const name = String(p.filepath || 'SVG').split(/[\\/]/).pop()!;
      const ob = importSvgText(ctx.doc, text, name, { resolution: p.resolution as number, scale: p.scale as number, recenter_bounds: !!p.recenter_bounds });
      if (!ob) {
        app.report('ERROR', 'No drawable shapes in the SVG file');
        return 'CANCELLED';
      }
    },
  },
]);

registerFormat({ id: 'gp_svg', label: 'SVG as Grease Pencil', extensions: ['.svg'], description: 'Paths and shapes of an SVG drawing as grease pencil strokes', importOp: 'wm.grease_pencil_import_svg', import: async (file) => {
  if (!importSvgText(app.doc, await file.text(), file.name)) throw new Error('No drawable shapes in the SVG file');
} });
