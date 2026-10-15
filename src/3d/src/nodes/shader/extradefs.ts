// Node types of the shader nodes beyond the first batch (registration, socket availability and
// labels only, so that menus and file loading work without the GLSL runtime). Interface data
// comes from extra.gen.ts; behaviour lives in extra.ts.
import type { NodeData } from '../../data/types';
import { defineFromRaw, propValue } from '../registry';
import type { NodeClass, NodeTypeDef, TreeType } from '../types';
import { SHADER_EXTRA_NODE_DATA } from './extra.gen';

const SH: TreeType[] = ['SHADER', 'WORLD'];
const p = (n: NodeData, id: string) => propValue(n, id) as string;

function def(idname: string, category: NodeClass, extra: Partial<NodeTypeDef> = {}): NodeTypeDef {
  const raw = SHADER_EXTRA_NODE_DATA[idname];
  if (!raw) throw new Error(`missing shader node data ${idname}`);
  return defineFromRaw(idname, raw, { category, treeTypes: SH, ...extra });
}

{
  const d = def('ShaderNodeBsdfHair', 'shader', {
    description: 'Reflection and transmission of light by hair strands',
  });
  d.props.find((x) => x.id === 'component')!.noLabel = true;
}

{
  const d = def('ShaderNodeBsdfHairPrincipled', 'shader', {
    description: 'Physically based hair shader with melanin, absorption or direct color parametrizations',
  });
  const chiangOnly = new Set(['Radial Roughness', 'Coat']);
  const huangOnly = new Set(['Aspect Ratio', 'R lobe', 'TT lobe', 'TRT lobe']);
  const melanin = new Set(['Melanin', 'Melanin Redness', 'Tint', 'Random Color']);
  d.available = (n, s) => {
    const par = p(n, 'parametrization'),
      huang = p(n, 'model') === 'HUANG';
    if (s.identifier === 'Weight') return false;
    if (chiangOnly.has(s.identifier)) return !huang;
    if (huangOnly.has(s.identifier)) return huang;
    if (melanin.has(s.identifier)) return par === 'MELANIN';
    if (s.identifier === 'Color') return par === 'COLOR';
    if (s.identifier === 'Absorption Coefficient') return par === 'ABSORPTION';
    return true;
  };
  for (const x of d.props) x.noLabel = true;
}

def('ShaderNodeBsdfRayPortal', 'shader', {
  description: 'Continue rays from another position and direction, as if the surface were a window into another place',
});

{
  const d = def('ShaderNodeVolumeCoefficients', 'shader', {
    description: 'Volume defined directly by its absorption, scattering and emission coefficients',
  });
  const phase = (n: NodeData) => p(n, 'phase');
  d.available = (n, s) => {
    const ph = phase(n);
    switch (s.identifier) {
      case 'Weight':
        return false;
      case 'Anisotropy':
        return ph === 'HENYEY_GREENSTEIN' || ph === 'DRAINE';
      case 'IOR':
      case 'Backscatter':
        return ph === 'FOURNIER_FORAND';
      case 'Alpha':
        return ph === 'DRAINE';
      case 'Diameter':
        return ph === 'MIE';
      default:
        return true;
    }
  };
  d.props.find((x) => x.id === 'phase')!.noLabel = true;
  // the dump reports the IOR socket with a factor range; it is a refractive index
  const ior = d.inputs.find((s) => s.identifier === 'IOR')!;
  ior.min = 1;
  ior.max = 2;
  ior.subtype = 'NONE';
}

def('ShaderNodeHairInfo', 'input', { description: 'Information about curve strands: position along the strand, length, thickness and a random value' });
def('ShaderNodeParticleInfo', 'input', { description: 'Information about the particle an instance was created from' });
def('ShaderNodePointInfo', 'input', { description: 'Information about the points of a point cloud' });
def('ShaderNodeVolumeInfo', 'input', { description: 'Values of the volume grids of the shaded object' });

{
  const d = def('ShaderNodeRadialTiling', 'vector', {
    description: 'Divide the plane around the origin into segments and output coordinates local to each segment',
  });
  const v = d.inputs.find((s) => s.identifier === 'Vector')!;
  v.default = [0, 0, 0];
  v.dimensions = 2;
  d.inputs.find((s) => s.identifier === 'Sides')!.min = 0;
}

{
  const d = def('ShaderNodeTexIES', 'texture', {
    description: 'Light intensity distribution from an IES photometric file',
  });
  // the data comes from a text data-block chosen in the node body (extra.ts)
  d.props = [];
  d.bodyHeight = () => 26;
}

// Outputs: AOV Output feeds custom render passes, Light Output the emission of light objects
{
  const d = def('ShaderNodeOutputAOV', 'output', {
    description: 'Write a color and a value into a render pass named after the AOV',
  });
  const name = d.props.find((x) => x.id === 'aov_name')!;
  name.noLabel = true;
}
{
  const d = def('ShaderNodeOutputLight', 'output', {
    description: 'Emission of a light object, shaped by nodes',
  });
  d.treeTypes = ['SHADER'];
  d.props.find((x) => x.id === 'is_active_output')!.inNode = false;
  d.props.find((x) => x.id === 'target')!.noLabel = true;
  d.init = (n) => {
    n.props.is_active_output = true;
  };
}
