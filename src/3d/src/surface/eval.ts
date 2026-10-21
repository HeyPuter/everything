// Depsgraph integration: a surface object evaluates to the tessellation of its control grids.
import { dataEvaluators } from '../eval/depsgraph';
import { surfaceToMesh } from './nurbs';

dataEvaluators.SURFACE = {
  signature(doc, ob, graph) {
    const cu = ob.data ? doc.curves[ob.data] : undefined;
    if (!cu) return null;
    // selection and hiding don't change the surface
    const geo = cu.splines.map((sp) => ({ ...sp, points: sp.points.map((p) => p.co) }));
    return `surf|${graph.render ? 'R' : ''}|${cu.resolution_u}|${cu.resolution_v}|${cu.render_resolution_u}|${JSON.stringify(geo)}`;
  },
  build(doc, ob, graph) {
    return surfaceToMesh(doc.curves[ob.data!], graph.render);
  },
};
