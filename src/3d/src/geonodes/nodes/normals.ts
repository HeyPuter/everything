// Set Mesh Normal: sharpness flags, or custom normals stored per corner ("custom_normal").
import { geoNode, sock, geo, enumProp } from './gndef';
import { evalOn } from './common';
import { prop } from './defs';
import { allocData } from '../geometry';
import type { Domain } from '../types';

geoNode(
  {
    idname: 'GeometryNodeSetMeshNormal',
    label: 'Set Mesh Normal',
    category: 'geometry',
    description: 'Control shading normals: mark sharp edges and faces, or give explicit normals',
    inputs: [
      geo('Mesh'),
      sock('Remove Custom', 'BOOLEAN', { d: true }),
      sock('Edge Sharpness', 'BOOLEAN', { d: false, field: true }),
      sock('Face Sharpness', 'BOOLEAN', { d: false, field: true }),
      sock('Custom Normal', 'VECTOR', { d: [0, 0, 0], field: true }),
    ],
    outputs: [geo('Mesh')],
    props: [
      enumProp('mode', 'Mode', [
        ['SHARPNESS', 'Sharpness'],
        ['FREE', 'Free'],
      ]),
      enumProp(
        'domain',
        'Domain',
        [
          ['POINT', 'Point'],
          ['FACE', 'Face'],
          ['CORNER', 'Face Corner'],
        ],
        'POINT',
        { visible: (n) => prop(n, 'mode') !== 'SHARPNESS' },
      ),
    ],
    available: (n, s) => {
      const sharp = prop(n, 'mode') === 'SHARPNESS';
      return s.identifier === 'Custom Normal' ? !sharp : s.identifier === 'Mesh' || sharp;
    },
  },
  {
    exec: (ctx) => {
      const g = ctx.geometry('Mesh');
      const m = g.mesh;
      if (!m) return { Mesh: g };
      const out = m.copy();
      if (prop(ctx.node, 'mode') === 'SHARPNESS') {
        if (ctx.bool('Remove Custom')) out.attrs.delete('custom_normal');
        const e = evalOn(m, 'EDGE', undefined, [ctx.field('Edge Sharpness', 'BOOLEAN')]);
        const f = evalOn(m, 'FACE', undefined, [ctx.field('Face Sharpness', 'BOOLEAN')]);
        out.attrs.set('sharp_edge', { domain: 'EDGE', type: 'BOOLEAN', data: Uint8Array.from(e.values[0]) });
        out.attrs.set('sharp_face', { domain: 'FACE', type: 'BOOLEAN', data: Uint8Array.from(f.values[0]) });
        return { Mesh: g.with(out) };
      }
      const domain = String(prop(ctx.node, 'domain')) as Domain;
      const r = evalOn(m, domain, undefined, [ctx.field('Custom Normal', 'VECTOR')]);
      const data = allocData('FLOAT_VECTOR', r.ctx.size);
      data.set(r.values[0]);
      out.attrs.set('custom_normal', { domain, type: 'FLOAT_VECTOR', data });
      return { Mesh: g.with(out) };
    },
  },
);
