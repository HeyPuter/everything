// Trace Image to Grease Pencil (image empties: dark parts become filled outlines) and Bake Object
// Transform to Grease Pencil (the evaluated strokes of every frame become keys of a new object).
import { Matrix4, Vector3, Plane, Ray } from 'three';
import { app, registerOperators } from '../app/app';
import type { DocumentData, ObjectData } from '../data/types';
import { newObject } from '../data/defaults';
import { addObjectToScene, uniqueName } from '../ops/object';
import { imageCanvas } from '../render/images';
import { imageEmptySize } from '../render/scene';
import { activeView3D } from '../editors/view3d/view3d';
import { gpTable, gpOf, newGreasePencil, newLayer, newGPMaterial, newPoint, newStroke, fromStrokes, toStrokes, setKeyframe, frameAt, normalizeDrawing, uniqueLayerName, type GPStroke } from './data';
import { traceContours, simplifyLoop } from './fillmath';
import { layerMatrix } from './render';
import { activeModifiers, evaluateDrawing, layerFrame } from './modifiers';

/** Ink mask of an RGBA image: pixels darker than `threshold` (weighted by alpha). */
export function inkMask(px: ArrayLike<number>, W: number, H: number, threshold: number): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const a = px[i * 4 + 3] / 255;
    const l = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
    m[i] = a > 0.5 && l < threshold ? 1 : 0;
  }
  return m;
}

/** Outline loops of the ink, in image units [0, 1] (y up). */
export function traceInk(mask: Uint8Array, W: number, H: number): [number, number][][] {
  return traceContours(mask, W, H)
    .map((l) => simplifyLoop(l, 0.75))
    .filter((l) => l.length >= 3)
    .map((l) => l.map(([x, y]) => [x / W, 1 - y / H] as [number, number]));
}

function ensureMaterial(doc: DocumentData, gp: ReturnType<typeof newGreasePencil>): number {
  const i = gp.materials.findIndex((id) => id && doc.materials[id]?.grease_pencil?.show_fill);
  if (i >= 0) return i;
  const m = newGPMaterial(uniqueName(doc, 'Trace', 'materials'), { color: [0, 0, 0, 1], fill_color: [0, 0, 0, 1], show_fill: true, show_stroke: true });
  doc.materials[m.id] = m;
  gp.materials.push(m.id);
  return gp.materials.length - 1;
}

function newGPObjectAt(doc: DocumentData, name: string, world: Matrix4): { ob: ObjectData; gp: ReturnType<typeof newGreasePencil> } {
  const gp = newGreasePencil(uniqueName(doc, name, 'objects'));
  gpTable(doc)[gp.id] = gp;
  const ob = newObject(gp.name, 'GREASEPENCIL', gp.id);
  const p = new Vector3().setFromMatrixPosition(world);
  addObjectToScene(doc, ob, { location: [p.x, p.y, p.z] });
  return { ob, gp };
}

registerOperators([
  {
    idname: 'grease_pencil.trace_image',
    label: 'Trace Image to Grease Pencil',
    description: 'Outline the dark parts of the active image empty as filled grease pencil strokes',
    props: [
      {
        id: 'target',
        label: 'Target Object',
        type: 'enum',
        default: 'NEW',
        items: [
          ['NEW', 'New Object', 'Create a new grease pencil object'],
          ['SELECTED', 'Selected Object', 'Add the strokes to the other selected grease pencil object'],
        ],
      },
      { id: 'threshold', label: 'Color Threshold', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
    ],
    poll: (c) => c.doc.mode === 'OBJECT' && app.activeObject?.type === 'EMPTY' && app.activeObject.empty_display_type === 'IMAGE' && !!app.activeObject.data,
    exec: (c, p) => {
      const doc = c.doc;
      const empty = app.activeObject!;
      const img = doc.images[empty.data!];
      if (!img) return 'CANCELLED';
      const canvas = imageCanvas(img);
      const s = Math.min(1, 512 / Math.max(canvas.width, canvas.height));
      const W = Math.max(1, Math.round(canvas.width * s)),
        H = Math.max(1, Math.round(canvas.height * s));
      const tmp = document.createElement('canvas');
      tmp.width = W;
      tmp.height = H;
      const g = tmp.getContext('2d', { willReadFrequently: true });
      if (!g) return 'CANCELLED';
      g.drawImage(canvas, 0, 0, W, H);
      const loops = traceInk(inkMask(g.getImageData(0, 0, W, H).data, W, H, p.threshold as number), W, H);
      if (!loops.length) {
        app.report('WARNING', 'Nothing dark enough to trace');
        return 'CANCELLED';
      }
      // image plane points → world
      const [w, h] = imageEmptySize(empty, img);
      const off = empty.empty_image_offset ?? [-0.5, -0.5];
      const ew = app.graph.get(empty.id)?.world ?? new Matrix4();
      const world = loops.map((l) => l.map(([u, v]) => new Vector3(off[0] * w + u * w, off[1] * h + v * h, 0).applyMatrix4(ew)));
      let target = p.target === 'SELECTED' ? app.selectedObjects().find((o) => o !== empty && gpOf(doc, o)) : undefined;
      let gp = target ? gpOf(doc, target)! : null;
      if (!target || !gp) ({ ob: target, gp } = newGPObjectAt(doc, 'Trace', ew));
      const mat = ensureMaterial(doc, gp!);
      const tw = (app.graph.get(target!.id)?.world ?? new Matrix4().setPosition(new Vector3().setFromMatrixPosition(ew))).clone().invert();
      const radius = (Math.max(w, h) / Math.max(W, H)) * 0.5;
      const strokes: GPStroke[] = world.map((l) => newStroke(l.map((q) => newPoint(q.clone().applyMatrix4(tw).toArray() as [number, number, number], radius)), { cyclic: true, material_index: mat, fill_id: 1 }));
      const layer = newLayer(uniqueLayerName(gp!, 'Trace'));
      gp!.layers.push(layer);
      gp!.active_layer_index = gp!.layers.length - 1;
      setKeyframe(gp!, layer, doc.scene.frame_current, fromStrokes(strokes));
      app.report('INFO', `Traced ${strokes.length} outline${strokes.length === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'grease_pencil.bake_grease_pencil_animation',
    label: 'Bake Object Transform to Grease Pencil',
    description: 'Make a new grease pencil object whose keys hold the strokes as they move over the frame range (object animation, parents and modifiers baked in)',
    props: [
      { id: 'frame_start', label: 'Start Frame', type: 'int', default: 1, min: 0, max: 100000 },
      { id: 'frame_end', label: 'End Frame', type: 'int', default: 250, min: 0, max: 100000 },
      { id: 'step', label: 'Step', type: 'int', default: 1, min: 1, max: 100 },
      { id: 'only_selected', label: 'Only Selected Keyframes', type: 'bool', default: false },
      { id: 'frame_target', label: 'Target Frame', type: 'int', default: 1, min: 0, max: 100000 },
      {
        id: 'project_type',
        label: 'Projection Type',
        type: 'enum',
        default: 'KEEP',
        items: [
          ['KEEP', 'No Reproject', 'Keep the strokes where they are'],
          ['FRONT', 'Front', 'Flatten onto the front (X-Z) plane'],
          ['SIDE', 'Side', 'Flatten onto the side (Y-Z) plane'],
          ['TOP', 'Top', 'Flatten onto the top (X-Y) plane'],
          ['VIEW', 'View', 'Flatten onto the view plane'],
          ['CURSOR', 'Cursor', 'Flatten onto the plane of the 3D cursor'],
        ],
      },
    ],
    poll: (c) => c.doc.mode === 'OBJECT' && app.selectedObjects().some((o) => gpOf(c.doc, o)),
    exec: (c, p) => {
      const doc = c.doc;
      const sources = app.selectedObjects().filter((o) => gpOf(doc, o));
      if (!sources.length) return 'CANCELLED';
      const start = p.frame_start as number,
        end = Math.max(start, p.frame_end as number),
        step = Math.max(1, p.step as number);
      const keep = doc.scene.frame_current;
      const v = activeView3D();
      const plane = (() => {
        const cur = doc.scene.cursor;
        switch (p.project_type) {
          case 'FRONT':
            return new Plane(new Vector3(0, 1, 0), 0);
          case 'SIDE':
            return new Plane(new Vector3(1, 0, 0), 0);
          case 'TOP':
            return new Plane(new Vector3(0, 0, 1), 0);
          case 'CURSOR':
            return new Plane().setFromNormalAndCoplanarPoint(new Vector3(0, 0, 1), new Vector3(...cur.location));
          case 'VIEW':
            return v ? new Plane().setFromNormalAndCoplanarPoint(new Vector3(0, 0, 1).applyQuaternion(v.camera.quaternion), new Vector3()) : null;
        }
        return null;
      })();
      const viewDir = v ? new Vector3(0, 0, -1).applyQuaternion(v.camera.quaternion) : null;
      const { ob: target, gp } = newGPObjectAt(doc, `${sources[0].name}_baked`, new Matrix4());
      const layers = new Map<string, ReturnType<typeof newLayer>>();
      let out = p.frame_target as number;
      const w = new Vector3();
      for (let f = start; f <= end; f += step, out += step) {
        app.setFrame(f);
        app.flush();
        for (const ob of sources) {
          const g = gpOf(doc, ob)!;
          const ev = app.graph.get(ob.id);
          if (!ev) continue;
          const mods = activeModifiers(ob, true);
          for (const [li, l] of g.layers.entries()) {
            if (l.hide) continue;
            const shown = mods.length ? layerFrame(ob, { layer: l, layerIndex: li, doc, gp: g }, f, mods) : f;
            const fr = frameAt(l, shown);
            if (!fr || !g.drawings[fr.drawing] || (p.only_selected && !fr.select)) continue;
            const m = ev.world.clone().multiply(layerMatrix(l));
            let d = normalizeDrawing(g.drawings[fr.drawing]);
            if (mods.length) d = evaluateDrawing(d, { doc, ob, gp: g, layer: l, layerIndex: li, frame: shown, keyFrame: fr.frame_number, nextKeyFrame: null, prevStrokeCount: 0, world: m }, mods);
            for (const id of g.materials) if (!gp.materials.includes(id)) gp.materials.push(id);
            const strokes = toStrokes(d).map((s) => ({
              ...s,
              material_index: Math.max(0, gp.materials.indexOf(g.materials[s.material_index] ?? null)),
              points: s.points.map((pt) => {
                w.set(...pt.co).applyMatrix4(m);
                if (plane) {
                  if (p.project_type === 'VIEW' && viewDir) new Ray(w.clone().addScaledVector(viewDir, -1e4), viewDir).intersectPlane(plane, w);
                  else plane.projectPoint(w.clone(), w);
                }
                return { ...pt, co: w.toArray() as [number, number, number] };
              }),
            }));
            const key = `${ob.name}: ${l.name}`;
            let tl = layers.get(key);
            if (!tl) {
              tl = newLayer(uniqueLayerName(gp, sources.length > 1 ? key : l.name));
              gp.layers.push(tl);
              layers.set(key, tl);
            }
            setKeyframe(gp, tl, out, fromStrokes(strokes), fr.keyframe_type);
          }
        }
      }
      app.setFrame(keep);
      gp.active_layer_index = Math.max(0, gp.layers.length - 1);
      if (!gp.layers.length) {
        app.report('WARNING', 'Nothing to bake');
        return 'CANCELLED';
      }
      void target;
    },
  },
]);
