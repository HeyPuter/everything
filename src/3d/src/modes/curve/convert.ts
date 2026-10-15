// Object ▸ Convert ▸ Curve: text objects become Bézier outline curves, meshes become poly splines
// along their edges. Conversion to mesh stays with the original operator, which is wrapped.
import { app, onAppReady, operators, registerOperator, type OpContext } from '../../app/app';
import type { CurveData, DocumentData, ObjectData, Spline } from '../../data/types';
import { newCurve, newObject } from '../../data/defaults';
import { uniqueName, purgeOrphans } from '../../ops/object';
import { layoutText } from '../../io/fonts';
import { meshToSplines } from './meshcurve';

function convertObject(doc: DocumentData, ob: ObjectData, keep: boolean): boolean {
  let splines: Spline[] | null = null;
  const template = newCurve(uniqueName(doc, ob.name, 'curves'));
  if (ob.type === 'FONT' && ob.data) {
    const src = doc.curves[ob.data];
    splines = structuredClone(layoutText(src).splines).map((s) => ({ ...s, resolution_u: src.resolution_u }));
    Object.assign(template, { dimensions: '2D', resolution_u: src.resolution_u, extrude: src.extrude, offset: src.offset, bevel_depth: src.bevel_depth, bevel_resolution: src.bevel_resolution, fill_mode: src.fill_mode, use_fill_caps: src.use_fill_caps, materials: [...src.materials] } as Partial<CurveData>);
  } else if (ob.type === 'MESH') {
    const ev = app.graph.get(ob.id);
    if (!ev?.mesh) return false;
    splines = meshToSplines(ev.mesh);
    template.dimensions = '3D';
    if (ob.data) template.materials = [...(doc.meshes[ob.data]?.materials ?? [])];
  }
  if (!splines?.length) return false;
  template.splines = splines;
  doc.curves[template.id] = template;
  if (keep) {
    const no = newObject(uniqueName(doc, ob.name), 'CURVE', template.id);
    for (const k of ['location', 'rotation_euler', 'scale'] as const) no[k] = [...ob[k]] as typeof no[typeof k];
    no.rotation_quaternion = [...ob.rotation_quaternion] as typeof no.rotation_quaternion;
    no.rotation_mode = ob.rotation_mode;
    no.parent = ob.parent;
    no.matrix_parent_inverse = [...ob.matrix_parent_inverse];
    doc.objects[no.id] = no;
    doc.object_order.push(no.id);
    for (const c of Object.values(doc.collections)) if (c.objects.includes(ob.id)) c.objects.push(no.id);
    ob.select = false;
    no.select = true;
    doc.scene.active_object = no.id;
  } else {
    ob.type = 'CURVE';
    ob.data = template.id;
    ob.modifiers = [];
  }
  return true;
}

onAppReady(() => {
  const prev = operators.get('object.convert');
  if (!prev) return;
  registerOperator({
    ...prev,
    exec: (ctx: OpContext, p) => {
      if (p.target !== 'CURVE') return prev.exec ? prev.exec(ctx, p) : 'CANCELLED';
      let n = 0;
      for (const ob of app.selectedObjects()) if (convertObject(ctx.doc, ob, !!p.keep_original)) n++;
      if (!n) {
        app.report('WARNING', 'Select text or mesh objects to convert to curves');
        return 'CANCELLED';
      }
      purgeOrphans(ctx.doc);
    },
  });
});
