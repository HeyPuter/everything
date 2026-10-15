// Bevel and taper objects: another curve object can give a curve its cross-section (Bevel ▸
// Object) or scale its radius along the length (Taper Object).
import { h } from '../../ui/h';
import { app } from '../../app/app';
import { dataEvaluators } from '../../eval/depsgraph';
import { curveToMesh, sampleSpline, type CurveShapeOptions } from '../../eval/curve';
import { curveGeometryRows } from '../../editors/properties/tabs';
import { splitRow } from '../../ui/props';
import { enumMenu } from '../../ui/widgets';
import type { CurveData, DocumentData, ObjectData } from '../../data/types';

/** First spline of a curve object, sampled (object space). */
function sampledSource(doc: DocumentData, id: string | null | undefined, self: ObjectData) {
  if (!id || id === self.id) return null;
  const ob = doc.objects[id];
  if (!ob || ob.type !== 'CURVE' || !ob.data) return null;
  const cu = doc.curves[ob.data];
  const sp = cu?.splines[0];
  if (!sp) return null;
  return { cu, sp, sampled: sampleSpline(sp, cu.resolution_u) };
}

/** Shape options and a signature of everything they depend on. */
export function shapeFor(doc: DocumentData, ob: ObjectData, cu: CurveData): { opts: CurveShapeOptions; sig: string } {
  const opts: CurveShapeOptions = {};
  let sig = '';
  if (cu.bevel_mode === 'OBJECT') {
    const b = sampledSource(doc, cu.bevel_object, ob);
    if (b) {
      opts.profile = b.sampled.points.map((p) => [p[0], p[1]]);
      opts.profileClosed = b.sp.use_cyclic_u;
      sig += `|b${JSON.stringify(b.sp)}${b.cu.resolution_u}`;
    }
  }
  const t = sampledSource(doc, cu.taper_object, ob);
  if (t) {
    const pts = [...t.sampled.points].sort((a, b) => a[0] - b[0]);
    const x0 = pts[0][0],
      x1 = pts[pts.length - 1][0];
    opts.taper = (u) => {
      const x = x0 + u * (x1 - x0);
      for (let i = 1; i < pts.length; i++)
        if (x <= pts[i][0]) {
          const a = pts[i - 1],
            b = pts[i];
          const f = b[0] - a[0] > 1e-9 ? (x - a[0]) / (b[0] - a[0]) : 0;
          return a[1] + (b[1] - a[1]) * f;
        }
      return pts[pts.length - 1][1];
    };
    sig += `|t${JSON.stringify(t.sp)}${t.cu.resolution_u}`;
  }
  return { opts, sig };
}

for (const type of ['CURVE', 'FONT'] as const)
  dataEvaluators[type] = {
    signature: (doc, ob) => {
      const cu = ob.data ? doc.curves[ob.data] : undefined;
      return cu ? shapeFor(doc, ob, cu).sig : '';
    },
    build: (doc, ob) => {
      const cu = doc.curves[ob.data!];
      return curveToMesh(cu, type === 'FONT', shapeFor(doc, ob, cu).opts);
    },
  };

function objectPicker(id: string, cu: CurveData, key: 'bevel_object' | 'taper_object', ob: ObjectData) {
  const items = [{ value: '', label: '—' }, ...Object.values(app.doc.objects).filter((o) => o.type === 'CURVE' && o.id !== ob.id).map((o) => ({ value: o.id, label: o.name }))];
  return enumMenu(id, items, (cu[key] as string) ?? '', (v) => {
    cu[key] = v || null;
    app.pushUndo(key === 'bevel_object' ? 'Bevel Object' : 'Taper Object');
    app.changed('doc', 'geometry');
  });
}

curveGeometryRows.push((ob, cu) => [
  splitRow(
    'Bevel Mode',
    enumMenu(
      'cu-bevel-mode',
      [
        { value: 'ROUND', label: 'Round' },
        { value: 'OBJECT', label: 'Object' },
      ],
      cu.bevel_mode ?? 'ROUND',
      (v) => {
        cu.bevel_mode = v as 'ROUND';
        app.pushUndo('Bevel Mode');
        app.changed('doc', 'geometry');
      },
    ),
  ),
  cu.bevel_mode === 'OBJECT' ? splitRow('Bevel Object', objectPicker('cu-bevel-ob', cu, 'bevel_object', ob)) : null,
  splitRow('Taper Object', objectPicker('cu-taper-ob', cu, 'taper_object', ob)),
  cu.bevel_mode === 'OBJECT' && !cu.bevel_object ? h('div', { class: 'prop-note' }, 'Pick a curve object as the cross-section.') : null,
]);
