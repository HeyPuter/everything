// UI and path tracer hints of the shader nodes in extra.ts (kept apart so the GLSL runtime has no
// DOM dependencies).
import { getNodeType } from '../registry';
import { parseIes } from './ies';
import { hairColor } from './extra';
import { pbrHintBuilders } from './material';
import { idSelector, uniqueIdName } from '../editor/idselect';
import { app } from '../../app/app';
import { newText } from '../../data/defaults';

// IES Texture: text data-block selector with an Open button for .ies files
{
  const d = getNodeType('ShaderNodeTexIES')!;
  d.drawBody = (ctx) =>
    idSelector(ctx.node, 'ies', {
      items: () => Object.values(app.doc.texts),
      icon: 'text',
      kind: 'Text',
      accept: '.ies,.IES,text/plain',
      open: async (f) => {
        const body = await f.text();
        if (!parseIes(body)) {
          app.report('ERROR', `${f.name} is not an IES photometric file`);
          return null;
        }
        const t = newText(uniqueIdName(app.doc.texts, f.name), body, 'text');
        app.doc.texts[t.id] = t;
        return t.id;
      },
    });
}

// ---------------------------------------------------------------------------
// Path tracer: base parameters of the new surface closures

const rgb = (v: unknown, d: number[]) => (Array.isArray(v) ? (v as number[]) : d);
const numv = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
pbrHintBuilders.ShaderNodeBsdfRayPortal = (n) => {
  const c = rgb(n.inputs.Color, [1, 1, 1, 1]);
  return { color: [c[0], c[1], c[2]], transmission: 1, ior: 1, roughness: 0, metalness: 0, thickness: 0 };
};
pbrHintBuilders.ShaderNodeBsdfHair = (n) => {
  const c = rgb(n.inputs.Color, [0.8, 0.8, 0.8, 1]);
  return n.props.component === 'Transmission'
    ? { color: [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5], roughness: 1, metalness: 0 }
    : { color: [c[0], c[1], c[2]], roughness: numv(n.inputs.RoughnessU, 0.1), metalness: 1 };
};
pbrHintBuilders.ShaderNodeBsdfHairPrincipled = (n) => {
  const par = String(n.props.parametrization ?? 'COLOR');
  const huang = n.props.model === 'HUANG';
  const c = hairColor(par, {
    color: rgb(n.inputs.Color, [0.017513, 0.005763, 0.002059, 1]),
    melanin: numv(n.inputs.Melanin, 0.8),
    redness: numv(n.inputs['Melanin Redness'], 1),
    tint: rgb(n.inputs.Tint, [1, 1, 1, 1]),
    absorption: rgb(n.inputs['Absorption Coefficient'], [0.245531, 0.52, 1.365]),
    radial: huang ? numv(n.inputs.Roughness, 0.3) : numv(n.inputs['Radial Roughness'], 0.3),
  });
  return { color: c, roughness: numv(n.inputs.Roughness, 0.3), metalness: 0, ior: numv(n.inputs.IOR, 1.55) };
};
