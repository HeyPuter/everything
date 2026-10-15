// Interface data (socket names, identifiers, types, defaults, ranges and node properties) of the
// shader nodes added after the first batch (hair, portal, curves/particle/point/volume info, AOV and
// light outputs, radial tiling, raycast, IES texture, volume coefficients), following the public
// `bpy` interface. Factual interface data used for file and UI compatibility; it contains no code.
// Generated: do not edit by hand. Behaviour lives in shader/extra.ts.
import type { RawNodeData } from '../types';

export const SHADER_EXTRA_NODE_DATA: Record<string, RawNodeData> = {
  ShaderNodeBsdfHair: {
    label: 'Hair BSDF',
    width: 160,
    inputs: [
      ['Color', 'Color', 'RGBA', { d: [0.8, 0.8, 0.8, 1], min: 0 }],
      ['Offset', 'Offset', 'FLOAT', { d: 0, sub: 'ANGLE' }],
      ['RoughnessU', 'RoughnessU', 'FLOAT', { d: 0.1, min: 0, max: 1, sub: 'FACTOR' }],
      ['RoughnessV', 'RoughnessV', 'FLOAT', { d: 1, min: 0, max: 1, sub: 'FACTOR' }],
      ['Tangent', 'Tangent', 'VECTOR', { d: [0, 0, 0], hv: true }],
      ['Weight', 'Weight', 'FLOAT', { d: 0, off: true }],
    ],
    outputs: [['BSDF', 'BSDF', 'SHADER']],
    props: [
      {
        id: 'component',
        name: 'Component',
        type: 'ENUM',
        items: [
          ['Reflection', 'Reflection'],
          ['Transmission', 'Transmission'],
        ],
        d: 'Reflection',
      },
    ],
  },
  ShaderNodeBsdfHairPrincipled: {
    label: 'Principled Hair BSDF',
    width: 240,
    inputs: [
      ['Color', 'Color', 'RGBA', { d: [0.017513, 0.005763, 0.002059, 1], min: 0 }],
      ['Melanin', 'Melanin', 'FLOAT', { d: 0.8, min: 0, max: 1, sub: 'FACTOR', off: true }],
      ['Melanin Redness', 'Melanin Redness', 'FLOAT', { d: 1, min: 0, max: 1, sub: 'FACTOR', off: true }],
      ['Tint', 'Tint', 'RGBA', { d: [1, 1, 1, 1], min: 0, off: true }],
      ['Absorption Coefficient', 'Absorption Coefficient', 'VECTOR', { d: [0.245531, 0.52, 1.365], off: true }],
      ['Aspect Ratio', 'Aspect Ratio', 'FLOAT', { d: 0.85, min: 0, max: 1, sub: 'FACTOR', off: true }],
      ['Roughness', 'Roughness', 'FLOAT', { d: 0.3, min: 0, max: 1, sub: 'FACTOR' }],
      ['Radial Roughness', 'Radial Roughness', 'FLOAT', { d: 0.3, min: 0, max: 1, sub: 'FACTOR' }],
      ['Coat', 'Coat', 'FLOAT', { d: 0, min: 0, max: 1, sub: 'FACTOR' }],
      ['IOR', 'IOR', 'FLOAT', { d: 1.55 }],
      ['Offset', 'Offset', 'FLOAT', { d: 0.034907, sub: 'ANGLE' }],
      ['Random Color', 'Random Color', 'FLOAT', { d: 0, min: 0, max: 1, sub: 'FACTOR', off: true }],
      ['Random Roughness', 'Random Roughness', 'FLOAT', { d: 0, min: 0, max: 1, sub: 'FACTOR' }],
      ['Random', 'Random', 'FLOAT', { d: 0, hv: true }],
      ['Weight', 'Weight', 'FLOAT', { d: 0, off: true }],
      ['Reflection', 'R lobe', 'FLOAT', { d: 1, min: 0, max: 1, sub: 'FACTOR', off: true }],
      ['Transmission', 'TT lobe', 'FLOAT', { d: 1, min: 0, max: 1, sub: 'FACTOR', off: true }],
      ['Secondary Reflection', 'TRT lobe', 'FLOAT', { d: 1, min: 0, max: 1, sub: 'FACTOR', off: true }],
    ],
    outputs: [['BSDF', 'BSDF', 'SHADER']],
    props: [
      {
        id: 'model',
        name: 'Scattering model',
        type: 'ENUM',
        items: [
          ['CHIANG', 'Chiang'],
          ['HUANG', 'Huang'],
        ],
        d: 'CHIANG',
      },
      {
        id: 'parametrization',
        name: 'Color Parametrization',
        type: 'ENUM',
        items: [
          ['ABSORPTION', 'Absorption Coefficient'],
          ['MELANIN', 'Melanin Concentration'],
          ['COLOR', 'Direct Coloring'],
        ],
        d: 'COLOR',
      },
    ],
  },
  ShaderNodeBsdfRayPortal: {
    label: 'Ray Portal BSDF',
    width: 140,
    inputs: [
      ['Color', 'Color', 'RGBA', { d: [1, 1, 1, 1], min: 0 }],
      ['Position', 'Position', 'VECTOR', { d: [0, 0, 0], hv: true }],
      ['Direction', 'Direction', 'VECTOR', { d: [0, 0, 0], hv: true }],
      ['Weight', 'Weight', 'FLOAT', { d: 0, off: true }],
    ],
    outputs: [['BSDF', 'BSDF', 'SHADER']],
    props: [],
  },
  ShaderNodeHairInfo: {
    label: 'Curves Info',
    width: 140,
    inputs: [],
    outputs: [
      ['Is Strand', 'Is Strand', 'FLOAT', { d: 0 }],
      ['Intercept', 'Intercept', 'FLOAT', { d: 0 }],
      ['Length', 'Length', 'FLOAT', { d: 0 }],
      ['Thickness', 'Thickness', 'FLOAT', { d: 0 }],
      ['Tangent Normal', 'Tangent Normal', 'VECTOR', { d: [0, 0, 0] }],
      ['Random', 'Random', 'FLOAT', { d: 0 }],
    ],
    props: [],
  },
  ShaderNodeOutputAOV: {
    label: 'AOV Output',
    width: 140,
    inputs: [
      ['Color', 'Color', 'RGBA', { d: [0, 0, 0, 1], min: 0 }],
      ['Value', 'Value', 'FLOAT', { d: 0 }],
    ],
    outputs: [],
    props: [{ id: 'aov_name', name: 'Name', type: 'STRING', d: '' }],
  },
  ShaderNodeOutputLight: {
    label: 'Light Output',
    width: 140,
    inputs: [['Surface', 'Surface', 'SHADER']],
    outputs: [],
    props: [
      {
        id: 'is_active_output',
        name: 'Active Output',
        type: 'BOOLEAN',
        d: true,
      },
      {
        id: 'target',
        name: 'Target',
        type: 'ENUM',
        items: [
          ['ALL', 'All'],
          ['EEVEE', 'EEVEE'],
          ['CYCLES', 'Cycles'],
        ],
        d: 'ALL',
      },
    ],
  },
  ShaderNodeParticleInfo: {
    label: 'Particle Info',
    width: 140,
    inputs: [],
    outputs: [
      ['Index', 'Index', 'FLOAT', { d: 0 }],
      ['Random', 'Random', 'FLOAT', { d: 0 }],
      ['Age', 'Age', 'FLOAT', { d: 0 }],
      ['Lifetime', 'Lifetime', 'FLOAT', { d: 0 }],
      ['Location', 'Location', 'VECTOR', { d: [0, 0, 0] }],
      ['Size', 'Size', 'FLOAT', { d: 0 }],
      ['Velocity', 'Velocity', 'VECTOR', { d: [0, 0, 0] }],
      ['Angular Velocity', 'Angular Velocity', 'VECTOR', { d: [0, 0, 0] }],
    ],
    props: [],
  },
  ShaderNodePointInfo: {
    label: 'Point Info',
    width: 140,
    inputs: [],
    outputs: [
      ['Position', 'Position', 'VECTOR', { d: [0, 0, 0] }],
      ['Radius', 'Radius', 'FLOAT', { d: 0 }],
      ['Random', 'Random', 'FLOAT', { d: 0 }],
    ],
    props: [],
  },
  ShaderNodeRadialTiling: {
    label: 'Radial Tiling',
    width: 140,
    inputs: [
      ['Vector', 'Vector', 'VECTOR', { d: [0, 0] }],
      ['Sides', 'Sides', 'FLOAT', { d: 5 }],
      ['Roundness', 'Roundness', 'FLOAT', { d: 0, min: 0, max: 1, sub: 'FACTOR' }],
    ],
    outputs: [
      ['Segment Coordinates', 'Segment Coordinates', 'VECTOR', { d: [0, 0, 0] }],
      ['Segment ID', 'Segment ID', 'FLOAT', { d: 0 }],
      ['Segment Width', 'Segment Width', 'FLOAT', { d: 0 }],
      ['Segment Rotation', 'Segment Rotation', 'FLOAT', { d: 0 }],
    ],
    props: [{ id: 'normalize', name: 'Normalize', type: 'BOOLEAN', d: false }],
  },
  ShaderNodeRaycast: {
    label: 'Raycast',
    width: 140,
    inputs: [
      ['Position', 'Position', 'VECTOR', { d: [0, 0, 0], hv: true }],
      ['Direction', 'Direction', 'VECTOR', { d: [0, 0, 0], hv: true }],
      ['Length', 'Length', 'FLOAT', { d: 1 }],
    ],
    outputs: [
      ['Is Hit', 'Is Hit', 'FLOAT', { d: 0 }],
      ['Self Hit', 'Self Hit', 'FLOAT', { d: 0 }],
      ['Hit Distance', 'Hit Distance', 'FLOAT', { d: 0 }],
      ['Hit Position', 'Hit Position', 'VECTOR', { d: [0, 0, 0] }],
      ['Hit Normal', 'Hit Normal', 'VECTOR', { d: [0, 0, 0] }],
    ],
    props: [{ id: 'only_local', name: 'Only Local', type: 'BOOLEAN', d: false }],
  },
  ShaderNodeTexIES: {
    label: 'IES Texture',
    width: 140,
    inputs: [
      ['Vector', 'Vector', 'VECTOR', { d: [0, 0, 0], hv: true }],
      ['Strength', 'Strength', 'FLOAT', { d: 1 }],
    ],
    outputs: [['Factor', 'Fac', 'FLOAT', { d: 0 }]],
    props: [
      { id: 'ies', name: 'IES Text', type: 'TEXT' },
      { id: 'filepath', name: 'File Path', type: 'STRING', d: '' },
      {
        id: 'mode',
        name: 'Source',
        type: 'ENUM',
        items: [
          ['INTERNAL', 'Internal'],
          ['EXTERNAL', 'External'],
        ],
        d: 'INTERNAL',
      },
    ],
  },
  ShaderNodeVolumeCoefficients: {
    label: 'Volume Coefficients',
    width: 240,
    inputs: [
      ['Weight', 'Weight', 'FLOAT', { d: 0, off: true }],
      ['Absorption Coefficients', 'Absorption Coefficients', 'VECTOR', { d: [1, 1, 1] }],
      ['Scatter Coefficients', 'Scatter Coefficients', 'VECTOR', { d: [1, 1, 1] }],
      ['Anisotropy', 'Anisotropy', 'FLOAT', { d: 0, min: 0, max: 1, sub: 'FACTOR' }],
      ['IOR', 'IOR', 'FLOAT', { d: 1.33, min: 0, max: 1, sub: 'FACTOR', off: true }],
      ['Backscatter', 'Backscatter', 'FLOAT', { d: 0.1, min: 0, max: 1, sub: 'FACTOR', off: true }],
      ['Alpha', 'Alpha', 'FLOAT', { d: 0.5, off: true }],
      ['Diameter', 'Diameter', 'FLOAT', { d: 20, off: true }],
      ['Emission Coefficients', 'Emission Coefficients', 'VECTOR', { d: [0, 0, 0] }],
    ],
    outputs: [['Volume', 'Volume', 'SHADER']],
    props: [
      {
        id: 'phase',
        name: 'Phase',
        type: 'ENUM',
        items: [
          ['HENYEY_GREENSTEIN', 'Henyey-Greenstein'],
          ['FOURNIER_FORAND', 'Fournier-Forand'],
          ['DRAINE', 'Draine'],
          ['RAYLEIGH', 'Rayleigh'],
          ['MIE', 'Mie'],
        ],
        d: 'HENYEY_GREENSTEIN',
      },
    ],
  },
  ShaderNodeVolumeInfo: {
    label: 'Volume Info',
    width: 140,
    inputs: [],
    outputs: [
      ['Color', 'Color', 'RGBA', { d: [0.8, 0.8, 0.8, 1], min: 0 }],
      ['Density', 'Density', 'FLOAT', { d: 0 }],
      ['Flame', 'Flame', 'FLOAT', { d: 0 }],
      ['Temperature', 'Temperature', 'FLOAT', { d: 0 }],
    ],
    props: [],
  },
};
