// File ▸ Export ▸ Grease Pencil as SVG / PDF: collects the evaluated strokes of the chosen
// objects and frames, projects them through the scene camera (or the active viewport) and writes
// the files.
import { Matrix4, Vector3, type Camera } from 'three';
import { app, registerOperators, onAppReady, type PropDef } from '../app/app';
import type { DocumentData, ObjectData } from '../data/types';
import { gpOf, frameAt, normalizeDrawing, toStrokes, slotStyle, strokeShows } from '../greasepencil/data';
import { activeModifiers, layerFrame, evaluateDrawing } from '../greasepencil/modifiers';
import { layerMatrix } from '../greasepencil/render';
import { renderCamera } from '../render/final/camera';
import { renderSize } from '../render/final/units';
import { activeView3D } from '../editors/view3d/view3d';
import { download } from '../io/native';
import { ZipWriter } from '../render/final/zip';
import { optionsDialog, type FormatOption } from '../io/formats/ui';
import { registerFormat, formats } from '../io/files';
import { writePdf, writeSvg, type ExportItem, type ExportObject, type RGBA } from './gpexport';
import { evaluatedDrawing } from '../greasepencil/curves';

const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055);
const mix = (a: number[], b: number[], t: number) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);

export interface ExportView {
  camera: Camera;
  width: number;
  height: number;
  /** the scene camera (else the viewport) */
  fromCamera: boolean;
}

/** The camera the export looks through and the page size. */
export function exportView(doc: DocumentData): ExportView | null {
  if (doc.scene.camera && doc.objects[doc.scene.camera]) {
    const [W, H] = renderSize(doc.scene.render);
    const cam = renderCamera(app, W, H);
    if (cam) return { camera: cam, width: W, height: H, fromCamera: true };
  }
  const v = activeView3D();
  if (!v) return null;
  const cam = v.camera;
  cam.updateMatrixWorld(true);
  return { camera: cam, width: Math.max(1, Math.round(v.width)), height: Math.max(1, Math.round(v.height)), fromCamera: false };
}

/** Projected strokes of grease pencil objects at the current (evaluated) frame. */
export function collectExport(doc: DocumentData, obs: ObjectData[], view: ExportView, o: { stroke_sample?: number } = {}): ExportObject[] {
  const cam = view.camera;
  cam.updateMatrixWorld(true);
  const vp = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const e = vp.elements;
  const W = view.width,
    H = view.height;
  const p5 = cam.projectionMatrix.elements[5];
  const camPos = new Vector3().setFromMatrixPosition(cam.matrixWorld);
  const frame = doc.scene.frame_current;
  const objects: { ob: ExportObject; dist: number }[] = [];
  const v = new Vector3();
  for (const ob of obs) {
    const gp = gpOf(doc, ob);
    const ev = app.graph.get(ob.id);
    if (!gp || !ev) continue;
    const mods = activeModifiers(ob, true);
    const out: ExportObject = { name: ob.name, layers: [] };
    gp.layers.forEach((layer, li) => {
      if (layer.hide) return;
      const shown = mods.length ? layerFrame(ob, { layer, layerIndex: li, doc, gp }, frame, mods) : frame;
      const fr = frameAt(layer, shown);
      let d = fr && gp.drawings[fr.drawing] ? evaluatedDrawing(normalizeDrawing(gp.drawings[fr.drawing])) : undefined;
      if (!d) return;
      const world = ev.world.clone().multiply(layerMatrix(layer));
      if (mods.length) {
        const k = layer.frames.indexOf(fr!);
        const prev = k > 0 ? gp.drawings[layer.frames[k - 1].drawing] : undefined;
        d = evaluateDrawing(normalizeDrawing(d), { doc, ob, gp, layer, layerIndex: li, frame: shown, keyFrame: fr!.frame_number, nextKeyFrame: layer.frames[k + 1]?.frame_number ?? null, prevStrokeCount: prev ? prev.offsets.length - 1 : 0, world }, mods);
      }
      const items: ExportItem[] = [];
      const groups = new Map<number, { rings: [number, number][][]; color: RGBA }>();
      for (const s of toStrokes(normalizeDrawing(d))) {
        if (s.is_fill_guide) continue;
        const st = slotStyle(doc, gp, s.material_index);
        if (!st || st.hide) continue;
        let pts = s.points;
        if (o.stroke_sample && o.stroke_sample > 0 && pts.length > 1) pts = resamplePoints(pts, o.stroke_sample);
        const xy: [number, number][] = [],
          widths: number[] = [];
        let ok = true;
        let opac = 0;
        for (const p of pts) {
          v.set(p.co[0], p.co[1], p.co[2]).applyMatrix4(world);
          const cw = e[3] * v.x + e[7] * v.y + e[11] * v.z + e[15];
          if (cw <= 1e-6) {
            ok = false;
            break;
          }
          const cx = e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12],
            cy = e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13];
          xy.push([(cx / cw * 0.5 + 0.5) * W, (1 - (cy / cw * 0.5 + 0.5)) * H]);
          widths.push(Math.max(0.05, ((p.radius + layer.radius_offset) * 2 * p5 * H) / 2 / cw));
          opac += p.opacity;
        }
        if (!ok || !xy.length) continue;
        opac /= pts.length;
        const lay = layer.opacity;
        const shows = strokeShows(st, s.stroke_type);
        if (shows.fill && xy.length > 2) {
          const fc = mix(st.fill_color, s.fill_color, s.fill_color[3]);
          const color: RGBA = [toSrgb(fc[0]), toSrgb(fc[1]), toSrgb(fc[2]), st.fill_color[3] * s.fill_opacity * lay];
          if (s.fill_id) {
            let g = groups.get(s.fill_id);
            if (!g) {
              groups.set(s.fill_id, (g = { rings: [], color }));
              items.push({ kind: 'fill', fill: g });
            }
            g.rings.push(xy);
          } else items.push({ kind: 'fill', fill: { rings: [xy], color } });
        }
        if (shows.stroke) {
          const vc = pts.map((p) => p.vertex_color);
          const a = vc.reduce((x, c) => x + c[3], 0) / vc.length;
          const avgC = [0, 1, 2].map((i) => vc.reduce((x, c) => x + c[i], 0) / vc.length);
          const sc = mix(st.color, avgC, a);
          items.push({ kind: 'stroke', path: { pts: xy, widths, cyclic: s.cyclic, stroke: [toSrgb(sc[0]), toSrgb(sc[1]), toSrgb(sc[2]), st.color[3] * opac * lay] } });
        }
      }
      if (items.length) out.layers.push({ name: layer.name, items });
    });
    if (out.layers.length) objects.push({ ob: out, dist: camPos.distanceTo(new Vector3().setFromMatrixPosition(ev.world)) });
  }
  // farther objects first
  return objects.sort((a, b) => b.dist - a.dist).map((x) => x.ob);
}

function resamplePoints<T extends { co: [number, number, number] }>(pts: T[], step: number): T[] {
  const out: T[] = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].co[0] - pts[i - 1].co[0], pts[i].co[1] - pts[i - 1].co[1], pts[i].co[2] - pts[i - 1].co[2]);
    if (acc >= step || i === pts.length - 1) {
      out.push(pts[i]);
      acc = 0;
    }
  }
  return out;
}

function exportObjects(doc: DocumentData, which: string): ObjectData[] {
  const gpObs = Object.values(doc.objects).filter((o) => o.type === 'GREASEPENCIL');
  if (which === 'SELECTED') return gpObs.filter((o) => o.select);
  if (which === 'VISIBLE') return gpObs.filter((o) => app.isVisible(o.id));
  return app.activeObject?.type === 'GREASEPENCIL' ? [app.activeObject] : [];
}

function exportFrames(doc: DocumentData, obs: ObjectData[], mode: string): number[] {
  const sc = doc.scene;
  if (mode === 'SCENE') {
    const out: number[] = [];
    for (let f = sc.frame_start; f <= sc.frame_end; f += Math.max(1, sc.frame_step || 1)) out.push(f);
    return out;
  }
  if (mode === 'SELECTED') {
    const set = new Set<number>();
    for (const ob of obs) for (const l of gpOf(doc, ob)?.layers ?? []) for (const f of l.frames) if (f.select) set.add(f.frame_number);
    if (set.size) return [...set].sort((a, b) => a - b);
  }
  return [sc.frame_current];
}

const exportProps = (pdf: boolean): PropDef[] => [
  {
    id: 'selected_object_type',
    label: 'Object',
    type: 'enum',
    default: 'ACTIVE',
    items: [
      ['ACTIVE', 'Active', 'The active object'],
      ['SELECTED', 'Selected', 'All selected grease pencil objects'],
      ['VISIBLE', 'Visible', 'All visible grease pencil objects'],
    ],
  },
  {
    id: 'frame_mode',
    label: 'Frames',
    type: 'enum',
    default: 'ACTIVE',
    items: [
      ['ACTIVE', 'Active', 'The current frame'],
      ['SELECTED', 'Selected', 'Frames with selected keyframes'],
      ['SCENE', 'Scene', 'The scene frame range'],
    ],
  },
  { id: 'use_fill', label: 'Fill', type: 'bool', default: true },
  { id: 'use_uniform_width', label: 'Uniform Width', type: 'bool', default: false },
  { id: 'stroke_sample', label: 'Sampling', type: 'float', default: 0, min: 0, max: 100, subtype: 'distance' },
  ...(pdf ? [] : [{ id: 'use_clip_camera', label: 'Clip Camera', type: 'bool' as const, default: false }]),
];

/** Export the chosen objects and frames; returns the file bytes, name and type. */
export function exportGreasePencil(doc: DocumentData, format: 'SVG' | 'PDF', p: Record<string, unknown>): { bytes: Uint8Array | string; name: string; mime: string } | string {
  const obs = exportObjects(doc, String(p.selected_object_type ?? 'ACTIVE'));
  if (!obs.length) return 'No grease pencil objects to export';
  app.flush();
  const view = exportView(doc);
  if (!view) return 'No camera or viewport to export from';
  const frames = exportFrames(doc, obs, String(p.frame_mode ?? 'ACTIVE'));
  const orig = doc.scene.frame_current;
  const pages: ExportObject[][] = [];
  for (const f of frames) {
    if (f !== doc.scene.frame_current) {
      app.setFrame(f);
      app.flush();
    }
    pages.push(collectExport(doc, obs, view, { stroke_sample: p.stroke_sample as number }));
  }
  if (doc.scene.frame_current !== orig) {
    app.setFrame(orig);
    app.flush();
  }
  const base = (app.filename || 'drawing').replace(/\.[^.]+$/, '');
  const opts = { uniformWidth: !!p.use_uniform_width, fill: p.use_fill !== false, clip: !!p.use_clip_camera };
  if (format === 'PDF') return { bytes: writePdf(pages, view.width, view.height, opts), name: `${base}.pdf`, mime: 'application/pdf' };
  if (pages.length === 1) return { bytes: writeSvg(pages[0], view.width, view.height, opts), name: `${base}.svg`, mime: 'image/svg+xml' };
  const zip = new ZipWriter();
  const enc = new TextEncoder();
  pages.forEach((pg, i) => zip.add(`${base}_${String(frames[i]).padStart(4, '0')}.svg`, enc.encode(writeSvg(pg, view.width, view.height, opts))));
  const parts = zip.finish();
  const total = parts.reduce((n, x) => n + x.length, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const x of parts) {
    bytes.set(x, off);
    off += x.length;
  }
  return { bytes, name: `${base}_svg.zip`, mime: 'application/zip' };
}

for (const format of ['SVG', 'PDF'] as const)
  registerOperators([
    {
      idname: `wm.grease_pencil_export_${format.toLowerCase()}`,
      label: format === 'SVG' ? 'Grease Pencil as SVG' : 'Grease Pencil as PDF',
      description: format === 'SVG' ? 'Export grease pencil drawings as SVG vector images, seen through the camera' : 'Export grease pencil drawings as a PDF document (a page per frame), seen through the camera',
      undo: false,
      props: exportProps(format === 'PDF'),
      poll: (ctx) => Object.values(ctx.doc.objects).some((o) => o.type === 'GREASEPENCIL'),
      invoke: (_ctx, p) => {
        const props = exportProps(format === 'PDF');
        const options: FormatOption[] = props.map((d) => ({ id: d.id, label: d.label ?? d.id, type: d.type === 'enum' ? 'enum' : d.type === 'bool' ? 'bool' : 'float', default: p[d.id] as never, items: d.items?.map((i) => [i[0], i[1]] as [string, string]), min: d.min, max: d.max, step: 0.01 }));
        optionsDialog(`Export ${format}`, `gp_${format}`, options, 'Export').then(
          (v) => app.run(`wm.grease_pencil_export_${format.toLowerCase()}`, v, { invoke: false }),
          () => {},
        );
        return 'CANCELLED';
      },
      exec: (ctx, p) => {
        const r = exportGreasePencil(ctx.doc, format, p);
        if (typeof r === 'string') {
          app.report('ERROR', r);
          return 'CANCELLED';
        }
        download(r.bytes, r.name, r.mime);
        app.report('INFO', `Exported ${r.name}`);
        return 'FINISHED';
      },
    },
  ]);

registerFormat({ id: 'gp_export_svg', label: 'Grease Pencil as SVG', extensions: ['.svg'], description: 'Grease pencil drawings as SVG vector images', exportOp: 'wm.grease_pencil_export_svg' });
registerFormat({ id: 'gp_export_pdf', label: 'Grease Pencil as PDF', extensions: ['.pdf'], description: 'Grease pencil drawings as a PDF document', exportOp: 'wm.grease_pencil_export_pdf' });

// File ▸ Import / Export list them after USD, before OBJ
onAppReady(() => {
  const mine = formats.filter((f) => f.id.startsWith('gp_'));
  if (!mine.length) return;
  for (const f of mine) formats.splice(formats.indexOf(f), 1);
  const at = formats.findIndex((f) => f.id === 'obj');
  formats.splice(at < 0 ? formats.length : at, 0, ...mine);
});
