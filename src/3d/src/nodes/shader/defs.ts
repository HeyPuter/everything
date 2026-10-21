// Shader node types: categories, dynamic socket availability/labels, panels and the Add menu.
// Socket interface data comes from data.gen.ts; GLSL behaviour lives in shader/glsl/*.
import type { NodeData } from '../../data/types';
import { defineFromRaw, registerNodeAlias, registerNodeMenu, propValue, getNodeType } from '../registry';
import type { MenuCategory, NodeClass, NodeTypeDef, SocketDef, TreeType } from '../types';
import { SHADER_NODE_DATA } from './data.gen';
import { defaultRamp, defaultCurves } from '../curves';
// node types of later additions referenced by the Add menu below
import './extradefs';

const SH: TreeType[] = ['SHADER', 'WORLD'];
const p = (n: NodeData, id: string) => propValue(n, id) as string;

/** Properties handled by custom UI (not drawn as generic props). */
const CUSTOM_PROP_TYPES = new Set(['COLORRAMP', 'CURVEMAPPING']);

function def(idname: string, category: NodeClass, extra: Partial<NodeTypeDef> = {}): NodeTypeDef {
  const raw = SHADER_NODE_DATA[idname];
  if (!raw) throw new Error(`missing shader node data ${idname}`);
  const d = defineFromRaw(idname, raw, { category, treeTypes: SH, ...extra });
  d.props = d.props.filter((x) => !CUSTOM_PROP_TYPES.has(x.type as string));
  // Weight sockets are internal
  for (const s of d.inputs) if (s.identifier === 'Weight' && s.type === 'FLOAT' && d.category === 'shader') s.disabled = true;
  return d;
}

function setProp(d: NodeTypeDef, id: string, patch: Partial<NodeTypeDef['props'][number]>) {
  const pr = d.props.find((x) => x.id === id);
  if (pr) Object.assign(pr, patch);
}

function sock(d: NodeTypeDef, id: string, isOutput = false): SocketDef {
  const s = (isOutput ? d.outputs : d.inputs).find((x) => x.identifier === id);
  if (!s) throw new Error(`${d.idname}: no socket ${id}`);
  return s;
}

// ---------------------------------------------------------------------------
// Input

def('ShaderNodeAmbientOcclusion', 'input');
setProp(def('ShaderNodeAttribute', 'input'), 'attribute_name', {
  name: 'Name',
});
def('ShaderNodeBevel', 'input');
def('ShaderNodeCameraData', 'input');
setProp(def('ShaderNodeVertexColor', 'input'), 'layer_name', {
  type: 'COLOR_ATTRIBUTE',
  noLabel: true,
});
def('ShaderNodeFresnel', 'input');
def('ShaderNodeNewGeometry', 'input');
def('ShaderNodeLayerWeight', 'input');
def('ShaderNodeLightPath', 'input');
def('ShaderNodeObjectInfo', 'input');
def('ShaderNodeRGB', 'input', {
  outputs: [
    {
      name: 'Color',
      identifier: 'Color',
      type: 'RGBA',
      default: [0.5, 0.5, 0.5, 1],
    },
  ],
  props: [
    {
      id: 'outputs.Color',
      name: 'Color',
      type: 'COLOR',
      d: [0.5, 0.5, 0.5, 1],
      noLabel: true,
    },
  ],
  description: 'A color picker',
});
{
  const d = def('ShaderNodeTangent', 'input');
  setProp(d, 'axis', {
    expand: true,
    visible: (n) => p(n, 'direction_type') === 'RADIAL',
  });
  setProp(d, 'uv_map', {
    type: 'UV_MAP',
    noLabel: true,
    visible: (n) => p(n, 'direction_type') === 'UV_MAP',
  });
}
{
  const d = def('ShaderNodeTexCoord', 'input');
  setProp(d, 'from_instancer', { inNode: false });
}
setProp(def('ShaderNodeUVMap', 'input'), 'uv_map', {
  type: 'UV_MAP',
  noLabel: true,
});
def('ShaderNodeValue', 'input', {
  outputs: [{ name: 'Value', identifier: 'Value', type: 'FLOAT', default: 0.5 }],
  props: [
    {
      id: 'outputs.Value',
      name: 'Value',
      type: 'FLOAT',
      d: 0.5,
      noLabel: true,
    },
  ],
  description: 'Input numerical values to other nodes in the tree',
});
def('ShaderNodeWireframe', 'input');

// ---------------------------------------------------------------------------
// Output

{
  const d = def('ShaderNodeOutputMaterial', 'output');
  d.treeTypes = ['SHADER'];
  setProp(d, 'is_active_output', { inNode: false });
  setProp(d, 'target', { noLabel: true });
  d.init = (n) => {
    n.props.is_active_output = true;
  };
}
{
  const d = def('ShaderNodeOutputWorld', 'output');
  d.treeTypes = ['WORLD'];
  setProp(d, 'is_active_output', { inNode: false });
  setProp(d, 'target', { noLabel: true });
  d.init = (n) => {
    n.props.is_active_output = true;
  };
}

// ---------------------------------------------------------------------------
// Shader

def('ShaderNodeAddShader', 'shader');
def('ShaderNodeMixShader', 'shader');
def('ShaderNodeBackground', 'shader');
def('ShaderNodeBsdfDiffuse', 'shader');
def('ShaderNodeEmission', 'shader');
def('ShaderNodeBsdfGlass', 'shader');
def('ShaderNodeBsdfAnisotropic', 'shader');
registerNodeAlias('ShaderNodeBsdfGlossy', 'ShaderNodeBsdfAnisotropic');
def('ShaderNodeHoldout', 'shader');
{
  const d = def('ShaderNodeBsdfMetallic', 'shader');
  d.available = (n, s) => {
    const f = p(n, 'fresnel_type');
    if (s.identifier === 'IOR' || s.identifier === 'Extinction') return f === 'PHYSICAL_CONDUCTOR';
    if (s.identifier === 'Base Color' || s.identifier === 'Edge Tint') return f === 'F82';
    return !s.disabled;
  };
  d.panels = [
    {
      name: 'Thin Film',
      inputs: ['Thin Film Thickness', 'Thin Film IOR'],
      closed: true,
    },
  ];
  sock(d, 'Thin Film Thickness').shortLabel = 'Thickness';
  sock(d, 'Thin Film IOR').shortLabel = 'IOR';
}
{
  const d = def('ShaderNodeBsdfPrincipled', 'shader');
  d.panels = [
    { name: 'Diffuse', inputs: ['Diffuse Roughness'], closed: true },
    {
      name: 'Subsurface',
      props: ['subsurface_method'],
      inputs: ['Subsurface Weight', 'Subsurface Radius', 'Subsurface Scale', 'Subsurface IOR', 'Subsurface Anisotropy'],
      closed: true,
    },
    {
      name: 'Specular',
      props: ['distribution'],
      inputs: ['Specular IOR Level', 'Specular Tint', 'Anisotropic', 'Anisotropic Rotation', 'Tangent'],
      closed: true,
    },
    { name: 'Transmission', inputs: ['Transmission Weight'], closed: true },
    {
      name: 'Coat',
      inputs: ['Coat Weight', 'Coat Roughness', 'Coat IOR', 'Coat Tint', 'Coat Normal'],
      closed: true,
    },
    {
      name: 'Sheen',
      inputs: ['Sheen Weight', 'Sheen Roughness', 'Sheen Tint'],
      closed: true,
    },
    {
      name: 'Emission',
      inputs: ['Emission Color', 'Emission Strength'],
      closed: true,
    },
    {
      name: 'Thin Film',
      inputs: ['Thin Film Thickness', 'Thin Film IOR'],
      closed: true,
    },
  ];
  const short: Record<string, string> = {
    'Subsurface Weight': 'Weight',
    'Subsurface Radius': 'Radius',
    'Subsurface Scale': 'Scale',
    'Subsurface IOR': 'IOR',
    'Subsurface Anisotropy': 'Anisotropy',
    'Specular IOR Level': 'IOR Level',
    'Specular Tint': 'Tint',
    'Transmission Weight': 'Weight',
    'Coat Weight': 'Weight',
    'Coat Roughness': 'Roughness',
    'Coat IOR': 'IOR',
    'Coat Tint': 'Tint',
    'Coat Normal': 'Normal',
    'Sheen Weight': 'Weight',
    'Sheen Roughness': 'Roughness',
    'Sheen Tint': 'Tint',
    'Emission Color': 'Color',
    'Emission Strength': 'Strength',
    'Thin Film Thickness': 'Thickness',
    'Thin Film IOR': 'IOR',
  };
  for (const s of d.inputs) if (short[s.identifier]) s.shortLabel = short[s.identifier];
  sock(d, 'IOR').min = 1;
  sock(d, 'Subsurface IOR').min = 1.01;
  sock(d, 'Subsurface IOR').max = 3.8;
  sock(d, 'Subsurface IOR').subtype = 'NONE';
  sock(d, 'Emission Strength').min = 0;
  sock(d, 'Coat IOR').min = 1;
  d.available = (n, s) => {
    if (s.identifier === 'Subsurface IOR') return p(n, 'subsurface_method') === 'RANDOM_WALK_SKIN';
    return !s.disabled;
  };
  setProp(d, 'distribution', { noLabel: true });
  setProp(d, 'subsurface_method', { noLabel: true });
  d.init = (n) => {
    n.props.distribution ??= 'MULTI_GGX';
    n.props.subsurface_method ??= 'RANDOM_WALK';
  };
}
def('ShaderNodeBsdfRefraction', 'shader');
def('ShaderNodeBsdfSheen', 'shader');
def('ShaderNodeEeveeSpecular', 'shader');
{
  const d = def('ShaderNodeSubsurfaceScattering', 'shader');
  sock(d, 'IOR').min = 1.01;
  sock(d, 'IOR').max = 3.8;
  sock(d, 'IOR').subtype = 'NONE';
  d.available = (n, s) => (s.identifier === 'IOR' || s.identifier === 'Roughness' ? p(n, 'falloff') !== 'BURLEY' : !s.disabled);
}
def('ShaderNodeBsdfToon', 'shader');
def('ShaderNodeBsdfTranslucent', 'shader');
def('ShaderNodeBsdfTransparent', 'shader');
{
  const d = def('ShaderNodeVolumePrincipled', 'shader');
  d.inputs = d.inputs.filter((s) => s.type !== 'STRING');
}
def('ShaderNodeVolumeAbsorption', 'shader');
def('ShaderNodeVolumeScatter', 'shader');

// ---------------------------------------------------------------------------
// Displacement

def('ShaderNodeBump', 'vector');
def('ShaderNodeDisplacement', 'vector');
{
  const d = def('ShaderNodeNormalMap', 'vector');
  setProp(d, 'uv_map', {
    type: 'UV_MAP',
    noLabel: true,
    visible: (n) => p(n, 'space') === 'TANGENT',
  });
  setProp(d, 'space', { noLabel: true });
  setProp(d, 'convention', { inNode: false });
  setProp(d, 'base', { inNode: false });
}
def('ShaderNodeVectorDisplacement', 'vector');

// ---------------------------------------------------------------------------
// Color

def('ShaderNodeBlackbody', 'converter');
def('ShaderNodeBrightContrast', 'color');
{
  const d = def('ShaderNodeValToRGB', 'converter');
  d.init = (n) => {
    if (!n.props.color_ramp) Object.assign(n.props, defaultRamp());
  };
}
def('ShaderNodeGamma', 'color');
def('ShaderNodeHueSaturation', 'color');
def('ShaderNodeInvert', 'color');
def('ShaderNodeLightFalloff', 'color');
for (const id of ['ShaderNodeRGBCurve', 'ShaderNodeVectorCurve', 'ShaderNodeFloatCurve']) {
  const d = def(id, id === 'ShaderNodeRGBCurve' ? 'color' : id === 'ShaderNodeVectorCurve' ? 'vector' : 'converter');
  const kind = id === 'ShaderNodeRGBCurve' ? 'RGB' : id === 'ShaderNodeVectorCurve' ? 'VECTOR' : 'FLOAT';
  d.init = (n) => {
    if (!n.props.curve_0) Object.assign(n.props, defaultCurves(kind));
  };
}
def('ShaderNodeWavelength', 'converter');
{
  const labels: Record<string, string[]> = {
    RGB: ['Red', 'Green', 'Blue'],
    HSV: ['Hue', 'Saturation', 'Value'],
    HSL: ['Hue', 'Saturation', 'Lightness'],
  };
  const idx: Record<string, number> = { Red: 0, Green: 1, Blue: 2 };
  for (const id of ['ShaderNodeCombineColor', 'ShaderNodeSeparateColor']) {
    const d = def(id, 'converter');
    d.socketLabel = (n, s) => (s.identifier in idx ? labels[p(n, 'mode')]?.[idx[s.identifier]] : undefined);
    setProp(d, 'mode', { noLabel: true });
  }
}
def('ShaderNodeRGBToBW', 'converter');
def('ShaderNodeShaderToRGB', 'converter');

// ---------------------------------------------------------------------------
// Texture

{
  const d = def('ShaderNodeTexBrick', 'texture');
  setProp(d, 'offset', { inNode: true });
  setProp(d, 'squash', { inNode: true });
}
def('ShaderNodeTexChecker', 'texture');
{
  const d = def('ShaderNodeTexEnvironment', 'texture');
  setProp(d, 'image', { noLabel: true });
  setProp(d, 'projection', { noLabel: true });
  setProp(d, 'interpolation', { noLabel: true });
}
{
  const d = def('ShaderNodeTexGabor', 'texture');
  d.available = (n, s) => (s.identifier === 'Orientation 2D' ? p(n, 'gabor_type') === '2D' : s.identifier === 'Orientation 3D' ? p(n, 'gabor_type') === '3D' : !s.disabled);
  setProp(d, 'gabor_type', { noLabel: true });
}
setProp(def('ShaderNodeTexGradient', 'texture'), 'gradient_type', {
  noLabel: true,
});
{
  const d = def('ShaderNodeTexImage', 'texture');
  setProp(d, 'image', { noLabel: true });
  setProp(d, 'interpolation', { noLabel: true });
  setProp(d, 'projection', { noLabel: true });
  setProp(d, 'extension', { noLabel: true });
  setProp(d, 'projection_blend', {
    name: 'Blend',
    min: 0,
    max: 1,
    visible: (n) => p(n, 'projection') === 'BOX',
  });
}
setProp(def('ShaderNodeTexMagic', 'texture'), 'turbulence_depth', {
  name: 'Depth',
});
{
  const d = def('ShaderNodeTexNoise', 'texture');
  for (const id of ['Detail']) {
    sock(d, id).min = 0;
    sock(d, id).max = 15;
  }
  sock(d, 'Lacunarity').min = 0;
  d.available = (n, s) => {
    const dims = p(n, 'noise_dimensions');
    const type = p(n, 'noise_type');
    if (s.identifier === 'W') return dims === '1D' || dims === '4D';
    if (s.identifier === 'Vector') return dims !== '1D';
    if (s.identifier === 'Offset') return type === 'RIDGED_MULTIFRACTAL' || type === 'HYBRID_MULTIFRACTAL' || type === 'HETERO_TERRAIN';
    if (s.identifier === 'Gain') return type === 'RIDGED_MULTIFRACTAL' || type === 'HYBRID_MULTIFRACTAL';
    return !s.disabled;
  };
  setProp(d, 'noise_dimensions', { noLabel: true });
  setProp(d, 'noise_type', { noLabel: true });
  setProp(d, 'normalize', { visible: (n) => p(n, 'noise_type') === 'FBM' });
}
{
  const d = def('ShaderNodeTexSky', 'texture');
  const nishita = (n: NodeData) => ['SINGLE_SCATTERING', 'MULTIPLE_SCATTERING', 'NISHITA'].includes(p(n, 'sky_type'));
  setProp(d, 'sky_type', { noLabel: true });
  for (const id of ['sun_disc', 'sun_size', 'sun_intensity', 'sun_elevation', 'sun_rotation', 'altitude', 'air_density', 'aerosol_density', 'ozone_density']) setProp(d, id, { visible: nishita });
  setProp(d, 'sun_size', {
    visible: (n) => nishita(n) && !!propValue(n, 'sun_disc'),
  });
  setProp(d, 'sun_intensity', {
    visible: (n) => nishita(n) && !!propValue(n, 'sun_disc'),
  });
  setProp(d, 'air_density', { name: 'Air' });
  setProp(d, 'aerosol_density', { name: 'Aerosols' });
  setProp(d, 'ozone_density', { name: 'Ozone' });
  setProp(d, 'sun_direction', { visible: (n) => !nishita(n) });
  setProp(d, 'turbidity', { min: 1, max: 10, visible: (n) => !nishita(n) });
  setProp(d, 'ground_albedo', {
    min: 0,
    max: 1,
    visible: (n) => p(n, 'sky_type') === 'HOSEK_WILKIE',
  });
}
{
  const d = def('ShaderNodeTexVoronoi', 'texture');
  sock(d, 'Detail').min = 0;
  sock(d, 'Detail').max = 15;
  sock(d, 'Lacunarity').min = 0;
  d.available = (n, s, out) => {
    const dims = p(n, 'voronoi_dimensions');
    const f = p(n, 'feature');
    const dist = p(n, 'distance');
    const edge = f === 'DISTANCE_TO_EDGE',
      sphere = f === 'N_SPHERE_RADIUS';
    if (out) {
      if (s.identifier === 'Distance') return !sphere;
      if (s.identifier === 'Color') return !edge && !sphere;
      if (s.identifier === 'Position') return !edge && !sphere && dims !== '1D';
      if (s.identifier === 'W') return !edge && !sphere && (dims === '1D' || dims === '4D');
      if (s.identifier === 'Radius') return sphere;
      return true;
    }
    if (s.identifier === 'W') return dims === '1D' || dims === '4D';
    if (s.identifier === 'Vector') return dims !== '1D';
    if (s.identifier === 'Smoothness') return f === 'SMOOTH_F1';
    if (s.identifier === 'Exponent') return dist === 'MINKOWSKI' && dims !== '1D' && !edge && !sphere;
    if (s.identifier === 'Detail' || s.identifier === 'Roughness' || s.identifier === 'Lacunarity') return !sphere;
    return !s.disabled;
  };
  setProp(d, 'voronoi_dimensions', { noLabel: true });
  setProp(d, 'feature', { noLabel: true });
  setProp(d, 'distance', {
    noLabel: true,
    visible: (n) => p(n, 'voronoi_dimensions') !== '1D' && !['DISTANCE_TO_EDGE', 'N_SPHERE_RADIUS'].includes(p(n, 'feature')),
  });
  setProp(d, 'normalize', {
    visible: (n) => p(n, 'feature') !== 'N_SPHERE_RADIUS',
  });
}
{
  const d = def('ShaderNodeTexWave', 'texture');
  setProp(d, 'wave_type', { noLabel: true });
  setProp(d, 'bands_direction', {
    noLabel: true,
    visible: (n) => p(n, 'wave_type') === 'BANDS',
  });
  setProp(d, 'rings_direction', {
    noLabel: true,
    visible: (n) => p(n, 'wave_type') === 'RINGS',
  });
  setProp(d, 'wave_profile', { noLabel: true });
}
{
  const d = def('ShaderNodeTexWhiteNoise', 'texture');
  d.available = (n, s) => {
    const dims = p(n, 'noise_dimensions');
    if (s.identifier === 'W') return dims === '1D' || dims === '4D';
    if (s.identifier === 'Vector') return dims !== '1D';
    return !s.disabled;
  };
  setProp(d, 'noise_dimensions', { noLabel: true });
}

// ---------------------------------------------------------------------------
// Utilities ▸ Math / Vector

export const MATH_SINGLE = new Set([
  'SQRT',
  'INVERSE_SQRT',
  'ABSOLUTE',
  'EXPONENT',
  'SIGN',
  'ROUND',
  'FLOOR',
  'CEIL',
  'TRUNC',
  'FRACT',
  'SINE',
  'COSINE',
  'TANGENT',
  'ARCSINE',
  'ARCCOSINE',
  'ARCTANGENT',
  'SINH',
  'COSH',
  'TANH',
  'RADIANS',
  'DEGREES',
]);
export const MATH_TERNARY = new Set(['MULTIPLY_ADD', 'COMPARE', 'SMOOTH_MIN', 'SMOOTH_MAX', 'WRAP']);
const MATH_LABELS: Record<string, [string?, string?, string?]> = {
  MULTIPLY_ADD: [undefined, 'Multiplier', 'Addend'],
  POWER: ['Base', 'Exponent'],
  LOGARITHM: [undefined, 'Base'],
  COMPARE: [undefined, undefined, 'Epsilon'],
  SMOOTH_MIN: [undefined, undefined, 'Distance'],
  SMOOTH_MAX: [undefined, undefined, 'Distance'],
  WRAP: [undefined, 'Max', 'Min'],
  SNAP: [undefined, 'Increment'],
  PINGPONG: [undefined, 'Scale'],
  LESS_THAN: [undefined, 'Threshold'],
  GREATER_THAN: [undefined, 'Threshold'],
};
{
  const d = def('ShaderNodeMath', 'converter');
  const idx: Record<string, number> = { Value: 0, Value_001: 1, Value_002: 2 };
  d.available = (n, s, out) => {
    if (out) return true;
    const op = p(n, 'operation');
    if (s.identifier === 'Value_001') return !MATH_SINGLE.has(op);
    if (s.identifier === 'Value_002') return MATH_TERNARY.has(op);
    return true;
  };
  d.socketLabel = (n, s, out) => (out ? undefined : MATH_LABELS[p(n, 'operation')]?.[idx[s.identifier]]);
  d.dynamicLabel = (n) => d.props.find((x) => x.id === 'operation')!.items!.find((i) => i[0] === p(n, 'operation'))?.[1] ?? 'Math';
  setProp(d, 'operation', { noLabel: true });
}
export const VMATH_SINGLE = new Set(['NORMALIZE', 'LENGTH', 'ABSOLUTE', 'SIGN', 'FLOOR', 'CEIL', 'FRACTION', 'SINE', 'COSINE', 'TANGENT', 'SCALE']);
export const VMATH_TERNARY = new Set(['MULTIPLY_ADD', 'FACEFORWARD', 'WRAP']);
export const VMATH_FLOAT_OUT = new Set(['DOT_PRODUCT', 'DISTANCE', 'LENGTH']);
const VMATH_LABELS: Record<string, [string?, string?, string?]> = {
  MULTIPLY_ADD: [undefined, 'Multiplier', 'Addend'],
  FACEFORWARD: [undefined, 'Incident', 'Reference'],
  WRAP: [undefined, 'Max', 'Min'],
  SNAP: [undefined, 'Increment'],
  POWER: ['Base', 'Exponent'],
};
{
  const d = def('ShaderNodeVectorMath', 'vector');
  const idx: Record<string, number> = {
    Vector: 0,
    Vector_001: 1,
    Vector_002: 2,
  };
  d.available = (n, s, out) => {
    const op = p(n, 'operation');
    if (out) return s.identifier === 'Value' ? VMATH_FLOAT_OUT.has(op) : !VMATH_FLOAT_OUT.has(op);
    if (s.identifier === 'Vector_001') return !VMATH_SINGLE.has(op);
    if (s.identifier === 'Vector_002') return VMATH_TERNARY.has(op);
    if (s.identifier === 'Scale') return op === 'SCALE' || op === 'REFRACT';
    return true;
  };
  d.socketLabel = (n, s, out) => {
    if (out) return undefined;
    const op = p(n, 'operation');
    if (s.identifier === 'Scale' && op === 'REFRACT') return 'IOR';
    return VMATH_LABELS[op]?.[idx[s.identifier]];
  };
  d.dynamicLabel = (n) => d.props.find((x) => x.id === 'operation')!.items!.find((i) => i[0] === p(n, 'operation'))?.[1] ?? 'Vector Math';
  setProp(d, 'operation', { noLabel: true });
}
def('ShaderNodeClamp', 'converter');
setProp(nodeDef('ShaderNodeClamp'), 'clamp_type', { noLabel: true });
{
  const d = def('ShaderNodeMapRange', 'converter');
  const vec = (n: NodeData) => p(n, 'data_type') === 'FLOAT_VECTOR';
  d.available = (n, s, out) => {
    const v = s.identifier.endsWith('_FLOAT3') || s.identifier === 'Vector';
    if (out) return s.identifier === 'Vector' ? vec(n) : !vec(n);
    if (s.identifier.startsWith('Steps')) return p(n, 'interpolation_type') === 'STEPPED' && v === vec(n);
    return v === vec(n);
  };
  setProp(d, 'data_type', { noLabel: true });
  setProp(d, 'interpolation_type', { noLabel: true });
  setProp(d, 'clamp', {
    visible: (n) => p(n, 'interpolation_type') === 'LINEAR' || p(n, 'interpolation_type') === 'STEPPED',
  });
  // vector sockets keep their own visible names
  sock(d, 'Vector').hide_value = false;
}
{
  const d = def('ShaderNodeMix', 'converter');
  const prop = d.props.find((x) => x.id === 'data_type')!;
  prop.items = prop.items!.filter((i) => i[0] !== 'ROTATION');
  d.inputs = d.inputs.filter((s) => !s.identifier.endsWith('_Rotation'));
  d.outputs = d.outputs.filter((s) => !s.identifier.endsWith('_Rotation'));
  const suffix: Record<string, string> = {
    FLOAT: '_Float',
    VECTOR: '_Vector',
    RGBA: '_Color',
  };
  d.available = (n, s) => {
    const t = p(n, 'data_type');
    if (s.identifier === 'Factor_Float') return t !== 'VECTOR' || p(n, 'factor_mode') !== 'NON_UNIFORM';
    if (s.identifier === 'Factor_Vector') return t === 'VECTOR' && p(n, 'factor_mode') === 'NON_UNIFORM';
    return s.identifier.endsWith(suffix[t] ?? '_Float');
  };
  d.dynamicLabel = (n) => (p(n, 'data_type') === 'RGBA' ? 'Mix' : 'Mix');
  setProp(d, 'data_type', { noLabel: true });
  setProp(d, 'factor_mode', {
    noLabel: true,
    visible: (n) => p(n, 'data_type') === 'VECTOR',
  });
  setProp(d, 'blend_type', {
    noLabel: true,
    visible: (n) => p(n, 'data_type') === 'RGBA',
  });
  setProp(d, 'clamp_result', { visible: (n) => p(n, 'data_type') === 'RGBA' });
  // the node body lists Clamp Result above Clamp Factor
  const cr = d.props.findIndex((q) => q.id === 'clamp_result'),
    cf = d.props.findIndex((q) => q.id === 'clamp_factor');
  if (cr > cf && cf >= 0) d.props.splice(cf, 0, ...d.props.splice(cr, 1));
  d.init = (n) => {
    n.props.data_type ??= 'FLOAT';
  };
}
{
  const d = def('ShaderNodeMixRGB', 'color');
  d.hidden = true;
  d.label = 'Mix (Legacy)';
  d.dynamicLabel = (n) => d.props.find((x) => x.id === 'blend_type')!.items!.find((i) => i[0] === p(n, 'blend_type'))?.[1] ?? 'Mix';
  setProp(d, 'blend_type', { noLabel: true });
}
def('ShaderNodeCombineXYZ', 'converter');
def('ShaderNodeSeparateXYZ', 'converter');
setProp(def('ShaderNodeMapping', 'vector'), 'vector_type', { noLabel: true });
nodeDef('ShaderNodeMapping').available = (n, s) => (s.identifier === 'Location' ? !['VECTOR', 'NORMAL'].includes(p(n, 'vector_type')) : true);
def('ShaderNodeNormal', 'vector', {
  inputs: [
    {
      name: 'Normal',
      identifier: 'Normal',
      type: 'VECTOR',
      default: [0, 0, 1],
      subtype: 'DIRECTION',
    },
  ],
  outputs: [
    {
      name: 'Normal',
      identifier: 'Normal',
      type: 'VECTOR',
      default: [0, 0, 1],
      subtype: 'DIRECTION',
    },
    { name: 'Dot', identifier: 'Dot', type: 'FLOAT', default: 1 },
  ],
  props: [
    {
      id: 'outputs.Normal',
      name: 'Normal',
      type: 'DIRECTION',
      d: [0, 0, 1],
      noLabel: true,
    },
  ],
});
{
  const d = def('ShaderNodeVectorRotate', 'vector');
  d.available = (n, s) => {
    const t = p(n, 'rotation_type');
    if (s.identifier === 'Axis') return t === 'AXIS_ANGLE';
    if (s.identifier === 'Angle') return t !== 'EULER_XYZ';
    if (s.identifier === 'Rotation') return t === 'EULER_XYZ';
    return true;
  };
  setProp(d, 'rotation_type', { noLabel: true });
}
{
  const d = def('ShaderNodeVectorTransform', 'vector');
  setProp(d, 'vector_type', { expand: true, noLabel: true });
}
{
  const d = def('ShaderNodeSqueeze', 'converter');
  d.hidden = true;
}

function nodeDef(id: string) {
  return getNodeType(id)!;
}

// ---------------------------------------------------------------------------
// Add menu (shader editor)

const e = (idname: string, label?: string, settings?: Record<string, string>) => ({ idname, label, settings });
const objectOnly = (c: { shaderType?: string }) => c.shaderType !== 'WORLD';
const worldOnly = (c: { shaderType?: string }) => c.shaderType === 'WORLD';

export const SHADER_MENU: MenuCategory[] = [
  {
    label: 'Input',
    items: [
      {
        label: 'Constant',
        // Boolean, Integer and Vector join once the shared constant nodes are available (constants.ts)
        items: [e('ShaderNodeRGB'), e('ShaderNodeValue')],
      },
      'SEPARATOR',
      e('ShaderNodeAmbientOcclusion'),
      e('ShaderNodeAttribute'),
      e('ShaderNodeBevel'),
      e('ShaderNodeCameraData'),
      e('ShaderNodeVertexColor'),
      e('ShaderNodeHairInfo'),
      e('ShaderNodeFresnel'),
      e('ShaderNodeNewGeometry'),
      e('ShaderNodeLayerWeight'),
      e('ShaderNodeLightPath'),
      e('ShaderNodeObjectInfo'),
      e('ShaderNodeParticleInfo'),
      e('ShaderNodePointInfo'),
      e('ShaderNodeTangent'),
      e('ShaderNodeTexCoord'),
      e('ShaderNodeUVMap'),
      e('ShaderNodeVolumeInfo'),
      e('ShaderNodeWireframe'),
    ],
  },
  {
    label: 'Output',
    items: [e('ShaderNodeOutputAOV'), e('ShaderNodeOutputLight'), e('ShaderNodeOutputMaterial'), e('ShaderNodeOutputWorld')],
  },
  {
    label: 'Shader',
    separatorBefore: true,
    items: [
      e('ShaderNodeAddShader'),
      e('ShaderNodeMixShader'),
      'SEPARATOR',
      e('ShaderNodeBackground'),
      e('ShaderNodeBsdfDiffuse'),
      e('ShaderNodeEmission'),
      e('ShaderNodeBsdfGlass'),
      e('ShaderNodeBsdfAnisotropic'),
      e('ShaderNodeBsdfHair'),
      e('ShaderNodeHoldout'),
      e('ShaderNodeBsdfMetallic'),
      e('ShaderNodeBsdfPrincipled'),
      e('ShaderNodeBsdfHairPrincipled'),
      e('ShaderNodeBsdfRayPortal'),
      e('ShaderNodeBsdfRefraction'),
      e('ShaderNodeBsdfSheen'),
      e('ShaderNodeEeveeSpecular'),
      e('ShaderNodeSubsurfaceScattering'),
      e('ShaderNodeBsdfToon'),
      e('ShaderNodeBsdfTranslucent'),
      e('ShaderNodeBsdfTransparent'),
      'SEPARATOR',
      e('ShaderNodeVolumePrincipled'),
      e('ShaderNodeVolumeAbsorption'),
      e('ShaderNodeVolumeScatter'),
      e('ShaderNodeVolumeCoefficients'),
    ],
  },
  {
    label: 'Displacement',
    items: [e('ShaderNodeBump'), e('ShaderNodeDisplacement'), e('ShaderNodeNormalMap'), e('ShaderNodeVectorDisplacement')],
  },
  {
    label: 'Color',
    separatorBefore: true,
    items: [
      e('ShaderNodeBlackbody'),
      e('ShaderNodeBrightContrast'),
      e('ShaderNodeValToRGB'),
      e('ShaderNodeGamma'),
      e('ShaderNodeHueSaturation'),
      e('ShaderNodeInvert'),
      e('ShaderNodeLightFalloff'),
      e('ShaderNodeMix', 'Mix Color', { data_type: 'RGBA' }),
      e('ShaderNodeRGBCurve'),
      e('ShaderNodeWavelength'),
      'SEPARATOR',
      e('ShaderNodeCombineColor'),
      e('ShaderNodeSeparateColor'),
      'SEPARATOR',
      e('ShaderNodeRGBToBW'),
      e('ShaderNodeShaderToRGB'),
    ],
  },
  {
    label: 'Texture',
    items: [
      e('ShaderNodeTexBrick'),
      e('ShaderNodeTexChecker'),
      e('ShaderNodeTexEnvironment'),
      e('ShaderNodeTexGabor'),
      e('ShaderNodeTexGradient'),
      e('ShaderNodeTexIES'),
      e('ShaderNodeTexImage'),
      e('ShaderNodeTexMagic'),
      e('ShaderNodeTexNoise'),
      e('ShaderNodeTexSky'),
      e('ShaderNodeTexVoronoi'),
      e('ShaderNodeTexWave'),
      e('ShaderNodeTexWhiteNoise'),
    ],
  },
  {
    label: 'Utilities',
    items: [
      {
        label: 'Math',
        items: [e('ShaderNodeClamp'), e('ShaderNodeFloatCurve'), e('ShaderNodeMapRange'), e('ShaderNodeMath'), e('ShaderNodeMix')],
      },
      {
        label: 'Vector',
        items: [
          e('ShaderNodeCombineXYZ'),
          e('ShaderNodeMapRange', 'Map Range', { data_type: 'FLOAT_VECTOR' }),
          e('ShaderNodeMix', 'Mix Vector', { data_type: 'VECTOR' }),
          e('ShaderNodeSeparateXYZ'),
          'SEPARATOR',
          e('ShaderNodeMapping'),
          e('ShaderNodeNormal'),
          e('ShaderNodeRadialTiling'),
          e('ShaderNodeVectorCurve'),
          e('ShaderNodeVectorMath'),
          e('ShaderNodeVectorRotate'),
          e('ShaderNodeVectorTransform'),
        ],
      },
    ],
  },
];

// per-entry polls for object vs world trees: world trees offer only nodes that make sense for
// the background (no surface BSDFs or mesh attributes)
const OBJECT_ONLY = new Set([
  'ShaderNodeAmbientOcclusion',
  'ShaderNodeBevel',
  'ShaderNodeVertexColor',
  'ShaderNodeHairInfo',
  'ShaderNodeFresnel',
  'ShaderNodeLayerWeight',
  'ShaderNodeObjectInfo',
  'ShaderNodeParticleInfo',
  'ShaderNodePointInfo',
  'ShaderNodeUVMap',
  'ShaderNodeVolumeInfo',
  'ShaderNodeWireframe',
  'ShaderNodeOutputMaterial',
  'ShaderNodeOutputLight',
  'ShaderNodeShaderToRGB',
  'ShaderNodeBsdfDiffuse',
  'ShaderNodeBsdfGlass',
  'ShaderNodeBsdfAnisotropic',
  'ShaderNodeBsdfHair',
  'ShaderNodeHoldout',
  'ShaderNodeBsdfMetallic',
  'ShaderNodeBsdfPrincipled',
  'ShaderNodeBsdfHairPrincipled',
  'ShaderNodeBsdfRayPortal',
  'ShaderNodeBsdfRefraction',
  'ShaderNodeBsdfSheen',
  'ShaderNodeEeveeSpecular',
  'ShaderNodeSubsurfaceScattering',
  'ShaderNodeBsdfToon',
  'ShaderNodeBsdfTranslucent',
  'ShaderNodeBsdfTransparent',
]);
const WORLD_ONLY = new Set(['ShaderNodeOutputWorld', 'ShaderNodeBackground']);
/** Output nodes whose feature is not available yet are left out of the menu. */
export const hiddenShaderEntries = new Set<string>();
export function shaderEntryPoll(idname: string, shaderType: 'OBJECT' | 'WORLD') {
  if (hiddenShaderEntries.has(idname)) return false;
  if (!getNodeType(idname)) return false;
  if (OBJECT_ONLY.has(idname)) return objectOnly({ shaderType });
  if (WORLD_ONLY.has(idname)) return worldOnly({ shaderType });
  return true;
}

registerNodeMenu(['SHADER', 'WORLD'], SHADER_MENU);
