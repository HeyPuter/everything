// UV Unwrap and Pack UV Islands: field nodes computing UV coordinates on face corners.
import { geoNode, sock, enumProp, selection } from './gndef';
import { adaptDomain, type MeshComponent } from '../geometry';
import { InputField, makeContext, evalFull, evalSelection, type Field, type FieldContext } from '../field';
import { unwrapMesh, uvIslands, packIslands } from '../ops/uvnodes';

/** A corner UV field computed once per mesh and adapted to the evaluated domain. */
function cornerUVField(key: string, compute: (m: MeshComponent) => Float32Array): Field {
  const memo = new WeakMap<MeshComponent, Float32Array>();
  return new InputField('VECTOR', key, (fc: FieldContext) => {
    const c = fc.comp;
    if (c.kind !== 'MESH') return { data: new Float32Array(3), single: true };
    let uv = memo.get(c);
    if (!uv) memo.set(c, (uv = compute(c)));
    const data = fc.domain === 'CORNER' ? uv : (adaptDomain(c, uv, 'FLOAT_VECTOR', 'CORNER', fc.domain) as Float32Array);
    return { data, single: false };
  });
}

geoNode(
  {
    idname: 'GeometryNodeUVUnwrap',
    label: 'UV Unwrap',
    category: 'converter',
    description: 'Flatten the mesh surface into UV coordinates, cutting along seams',
    inputs: [
      selection(),
      sock('Seam', 'BOOLEAN', { d: false, hide_value: true, field: true }),
      sock('Margin', 'FLOAT', { d: 0.001, min: 0, max: 1 }),
      sock('Fill Holes', 'BOOLEAN', { d: true }),
      sock('No Flip', 'BOOLEAN', { d: false }),
    ],
    outputs: [sock('UV', 'VECTOR', { field: true })],
    props: [
      enumProp('Method', 'Method', [
        ['Angle Based', 'Angle Based'],
        ['Conformal', 'Conformal'],
      ]),
    ],
  },
  {
    exec: (ctx) => {
      const selF = ctx.field('Selection', 'BOOLEAN'),
        seamF = ctx.field('Seam', 'BOOLEAN');
      const margin = Math.max(0, ctx.float('Margin'));
      const noFlip = ctx.bool('No Flip');
      const fillHoles = ctx.bool('Fill Holes');
      return {
        UV: cornerUVField(`uv_unwrap:${ctx.path}`, (m) => {
          const sel = evalSelection(selF, makeContext(m, 'FACE'));
          const seam = evalSelection(seamF, makeContext(m, 'EDGE'));
          // a constant true seam field cuts every edge
          const uv2 = unwrapMesh(m, sel, seam ?? new Uint8Array(m.edgeCount).fill(1), { margin, noFlip, fillHoles });
          const out = new Float32Array(m.cornerCount * 3);
          for (let c = 0; c < m.cornerCount; c++) {
            out[c * 3] = uv2[c * 2];
            out[c * 3 + 1] = uv2[c * 2 + 1];
          }
          return out;
        }),
      };
    },
  },
);

geoNode(
  {
    idname: 'GeometryNodeUVPackIslands',
    label: 'Pack UV Islands',
    category: 'converter',
    description: 'Arrange UV islands side by side inside a region without overlapping',
    inputs: [
      sock('UV', 'VECTOR', { d: [0, 0, 0], hide_value: true, field: true }),
      selection(),
      sock('Margin', 'FLOAT', { d: 0.001, min: 0, max: 1 }),
      sock('Rotate', 'BOOLEAN', { d: true }),
      sock('Bottom Left', 'VECTOR', { d: [0, 0], dimensions: 2 }),
      sock('Top Right', 'VECTOR', { d: [1, 1], dimensions: 2 }),
    ],
    outputs: [sock('UV', 'VECTOR', { field: true })],
    props: [enumProp('Method', 'Method', [['Bounding Box', 'Bounding Box']])],
  },
  {
    exec: (ctx) => {
      const uvF = ctx.field('UV', 'VECTOR'),
        selF = ctx.field('Selection', 'BOOLEAN');
      const margin = Math.max(0, ctx.float('Margin'));
      const rotate = ctx.bool('Rotate');
      const bl = ctx.vector('Bottom Left'),
        tr = ctx.vector('Top Right');
      return {
        UV: cornerUVField(`uv_pack:${ctx.path}`, (m) => {
          const uv = new Float32Array(evalFull(uvF, makeContext(m, 'CORNER')));
          const sel = evalSelection(selF, makeContext(m, 'FACE'));
          packIslands(uv, 3, uvIslands(m, uv, 3, sel), { margin, rotate, min: [bl[0], bl[1]], max: [tr[0], tr[1]] });
          return uv;
        }),
      };
    },
  },
);
