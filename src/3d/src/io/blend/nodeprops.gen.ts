// GENERATED (see tests/fixtures/blend/make_node_enums.py): for every shader node type, one
// node per enum item / boolean state was written to a .blend file by a bpy script and the DNA field
// that changed was recorded by reading the file back with this package's own reader. Maps DNA storage of
// node settings (custom1/custom2/storage.*) to RNA property names and enum identifiers.
// f = field path, e = value -> enum identifier, b = bit mask (negative = inverted bit).
export interface NodePropRule {
  f: string;
  e?: Record<number, string>;
  b?: number;
}

export const NODE_PROP_RULES: Record<string, Record<string, NodePropRule>> = {
  ShaderNodeAmbientOcclusion: {
    inside: { f: "custom2", b: 1 },
    only_local: { f: "custom2", b: 2 },
  },
  ShaderNodeAttribute: {
    attribute_type: { f: "storage.type", e: { 0: "GEOMETRY", 1: "OBJECT", 2: "INSTANCER", 3: "VIEW_LAYER" } },
  },
  ShaderNodeBsdfAnisotropic: {
    distribution: { f: "custom1", e: { 0: "BECKMANN", 2: "GGX", 3: "ASHIKHMIN_SHIRLEY", 4: "MULTI_GGX" } },
  },
  ShaderNodeBsdfGlass: {
    distribution: { f: "custom1", e: { 0: "BECKMANN", 2: "GGX", 4: "MULTI_GGX" } },
  },
  ShaderNodeBsdfHair: {
    component: { f: "custom1", e: { 0: "Reflection", 1: "Transmission" } },
  },
  ShaderNodeBsdfHairPrincipled: {
    model: { f: "storage.model", e: { 0: "CHIANG", 1: "HUANG" } },
    parametrization: { f: "storage.parametrization", e: { 0: "COLOR", 1: "MELANIN", 2: "ABSORPTION" } },
  },
  ShaderNodeBsdfMetallic: {
    distribution: { f: "custom1", e: { 0: "BECKMANN", 2: "GGX", 4: "MULTI_GGX" } },
    fresnel_type: { f: "custom2", e: { 0: "PHYSICAL_CONDUCTOR", 1: "F82" } },
  },
  ShaderNodeBsdfPrincipled: {
    distribution: { f: "custom1", e: { 2: "GGX", 4: "MULTI_GGX" } },
    subsurface_method: { f: "custom2", e: { 3: "BURLEY", 4: "RANDOM_WALK_LEGACY", 5: "RANDOM_WALK_SKIN", 6: "RANDOM_WALK" } },
  },
  ShaderNodeBsdfRefraction: {
    distribution: { f: "custom1", e: { 0: "BECKMANN", 2: "GGX" } },
  },
  ShaderNodeBsdfSheen: {
    distribution: { f: "custom1", e: { 0: "ASHIKHMIN", 1: "MICROFIBER" } },
  },
  ShaderNodeBsdfToon: {
    component: { f: "custom1", e: { 0: "DIFFUSE", 1: "GLOSSY" } },
  },
  ShaderNodeBump: {
    invert: { f: "custom1", b: 1 },
  },
  ShaderNodeClamp: {
    clamp_type: { f: "custom1", e: { 0: "MINMAX", 1: "RANGE" } },
  },
  ShaderNodeCombineColor: {
    mode: { f: "storage.mode", e: { 0: "RGB", 1: "HSV", 2: "HSL" } },
  },
  ShaderNodeDisplacement: {
    space: { f: "custom1", e: { 1: "OBJECT", 2: "WORLD" } },
  },
  ShaderNodeMapRange: {
    clamp: { f: "storage.clamp", b: 1 },
    interpolation_type: { f: "storage.interpolation_type", e: { 0: "LINEAR", 1: "STEPPED", 2: "SMOOTHSTEP", 3: "SMOOTHERSTEP" } },
    data_type: { f: "storage.data_type", e: { 10: "FLOAT", 48: "FLOAT_VECTOR" } },
  },
  ShaderNodeMapping: {
    vector_type: { f: "custom1", e: { 0: "POINT", 1: "TEXTURE", 2: "VECTOR", 3: "NORMAL" } },
  },
  ShaderNodeMath: {
    operation: { f: "custom1", e: { 0: "ADD", 1: "SUBTRACT", 2: "MULTIPLY", 3: "DIVIDE", 4: "SINE", 5: "COSINE", 6: "TANGENT", 7: "ARCSINE", 8: "ARCCOSINE", 9: "ARCTANGENT", 10: "POWER", 11: "LOGARITHM", 12: "MINIMUM", 13: "MAXIMUM", 14: "ROUND", 15: "LESS_THAN", 16: "GREATER_THAN", 17: "MODULO", 18: "ABSOLUTE", 19: "ARCTAN2", 20: "FLOOR", 21: "CEIL", 22: "FRACT", 23: "SQRT", 24: "INVERSE_SQRT", 25: "SIGN", 26: "EXPONENT", 27: "RADIANS", 28: "DEGREES", 29: "SINH", 30: "COSH", 31: "TANH", 32: "TRUNC", 33: "SNAP", 34: "WRAP", 35: "COMPARE", 36: "MULTIPLY_ADD", 37: "PINGPONG", 38: "SMOOTH_MIN", 39: "SMOOTH_MAX", 40: "FLOORED_MODULO" } },
    use_clamp: { f: "custom2", b: 1 },
  },
  ShaderNodeMix: {
    data_type: { f: "storage.data_type", e: { 0: "FLOAT", 1: "VECTOR", 2: "RGBA" } },
    factor_mode: { f: "storage.factor_mode", e: { 0: "UNIFORM", 1: "NON_UNIFORM" } },
    blend_type: { f: "storage.blend_type", e: { 0: "MIX", 1: "ADD", 2: "MULTIPLY", 3: "SUBTRACT", 4: "SCREEN", 5: "DIVIDE", 6: "DIFFERENCE", 7: "DARKEN", 8: "LIGHTEN", 9: "OVERLAY", 10: "DODGE", 11: "BURN", 12: "HUE", 13: "SATURATION", 14: "VALUE", 15: "COLOR", 16: "SOFT_LIGHT", 17: "LINEAR_LIGHT", 18: "EXCLUSION" } },
    clamp_factor: { f: "storage.clamp_factor", b: 1 },
    clamp_result: { f: "storage.clamp_result", b: 1 },
  },
  ShaderNodeMixRGB: {
    blend_type: { f: "custom1", e: { 0: "MIX", 1: "ADD", 2: "MULTIPLY", 3: "SUBTRACT", 4: "SCREEN", 5: "DIVIDE", 6: "DIFFERENCE", 7: "DARKEN", 8: "LIGHTEN", 9: "OVERLAY", 10: "DODGE", 11: "BURN", 12: "HUE", 13: "SATURATION", 14: "VALUE", 15: "COLOR", 16: "SOFT_LIGHT", 17: "LINEAR_LIGHT", 18: "EXCLUSION" } },
    use_alpha: { f: "custom2", b: 1 },
    use_clamp: { f: "custom2", b: 2 },
  },
  ShaderNodeNormalMap: {
    space: { f: "storage.space", e: { 0: "TANGENT", 1: "OBJECT", 2: "WORLD", 3: "BLENDER_OBJECT", 4: "BLENDER_WORLD" } },
    convention: { f: "storage.convention", e: { 0: "OPENGL", 1: "DIRECTX" } },
    base: { f: "storage.base", e: { 0: "ORIGINAL", 1: "DISPLACED" } },
  },
  ShaderNodeOutputLight: {
    target: { f: "custom1", e: { 0: "ALL", 1: "EEVEE", 2: "CYCLES" } },
  },
  ShaderNodeOutputLineStyle: {
    target: { f: "custom1", e: { 0: "ALL", 1: "EEVEE", 2: "CYCLES" } },
    blend_type: { f: "custom1", e: { 0: "MIX", 1: "ADD", 2: "MULTIPLY", 3: "SUBTRACT", 4: "SCREEN", 5: "DIVIDE", 6: "DIFFERENCE", 7: "DARKEN", 8: "LIGHTEN", 9: "OVERLAY", 10: "DODGE", 11: "BURN", 12: "HUE", 13: "SATURATION", 14: "VALUE", 15: "COLOR", 16: "SOFT_LIGHT", 17: "LINEAR_LIGHT", 18: "EXCLUSION" } },
    use_alpha: { f: "custom2", b: 1 },
    use_clamp: { f: "custom2", b: 2 },
  },
  ShaderNodeOutputMaterial: {
    target: { f: "custom1", e: { 0: "ALL", 1: "EEVEE", 2: "CYCLES" } },
  },
  ShaderNodeOutputWorld: {
    target: { f: "custom1", e: { 0: "ALL", 1: "EEVEE", 2: "CYCLES" } },
  },
  ShaderNodeRadialTiling: {
    normalize: { f: "storage.normalize", b: 1 },
  },
  ShaderNodeRaycast: {
    only_local: { f: "custom1", b: 1 },
  },
  ShaderNodeScript: {
    mode: { f: "storage.mode", e: { 0: "INTERNAL", 1: "EXTERNAL" } },
    use_auto_update: { f: "storage.flag", b: 1 },
  },
  ShaderNodeSeparateColor: {
    mode: { f: "storage.mode", e: { 0: "RGB", 1: "HSV", 2: "HSL" } },
  },
  ShaderNodeSubsurfaceScattering: {
    falloff: { f: "custom1", e: { 3: "BURLEY", 4: "RANDOM_WALK_LEGACY", 5: "RANDOM_WALK_SKIN", 6: "RANDOM_WALK" } },
  },
  ShaderNodeTangent: {
    direction_type: { f: "storage.direction_type", e: { 0: "RADIAL", 1: "UV_MAP" } },
    axis: { f: "storage.axis", e: { 0: "X", 1: "Y", 2: "Z" } },
  },
  ShaderNodeTexCoord: {
    from_instancer: { f: "custom1", b: 1 },
  },
  ShaderNodeTexEnvironment: {
    projection: { f: "storage.projection", e: { 0: "EQUIRECTANGULAR", 1: "MIRROR_BALL" } },
    interpolation: { f: "storage.interpolation", e: { 0: "Linear", 1: "Closest", 2: "Cubic", 3: "Smart" } },
  },
  ShaderNodeTexGabor: {
    gabor_type: { f: "storage.type", e: { 0: "2D", 1: "3D" } },
  },
  ShaderNodeTexGradient: {
    gradient_type: { f: "storage.gradient_type", e: { 0: "LINEAR", 1: "QUADRATIC", 2: "EASING", 3: "DIAGONAL", 4: "RADIAL", 5: "QUADRATIC_SPHERE", 6: "SPHERICAL" } },
  },
  ShaderNodeTexIES: {
    mode: { f: "storage.mode", e: { 0: "INTERNAL", 1: "EXTERNAL" } },
  },
  ShaderNodeTexImage: {
    projection: { f: "storage.projection", e: { 0: "FLAT", 1: "BOX", 2: "SPHERE", 3: "TUBE" } },
    interpolation: { f: "storage.interpolation", e: { 0: "Linear", 1: "Closest", 2: "Cubic", 3: "Smart" } },
    extension: { f: "storage.extension", e: { 0: "REPEAT", 1: "EXTEND", 2: "CLIP", 3: "MIRROR" } },
  },
  ShaderNodeTexNoise: {
    noise_dimensions: { f: "storage.dimensions", e: { 1: "1D", 2: "2D", 3: "3D", 4: "4D" } },
    noise_type: { f: "storage.type", e: { 0: "MULTIFRACTAL", 1: "FBM", 2: "HYBRID_MULTIFRACTAL", 3: "RIDGED_MULTIFRACTAL", 4: "HETERO_TERRAIN" } },
    normalize: { f: "storage.normalize", b: 1 },
  },
  ShaderNodeTexSky: {
    sky_type: { f: "storage.sky_model", e: { 0: "PREETHAM", 1: "HOSEK_WILKIE", 2: "SINGLE_SCATTERING", 3: "MULTIPLE_SCATTERING" } },
    sun_disc: { f: "storage.sun_disc", b: 1 },
  },
  ShaderNodeTexVoronoi: {
    voronoi_dimensions: { f: "storage.dimensions", e: { 1: "1D", 2: "2D", 3: "3D", 4: "4D" } },
    distance: { f: "storage.distance", e: { 0: "EUCLIDEAN", 1: "MANHATTAN", 2: "CHEBYCHEV", 3: "MINKOWSKI" } },
    feature: { f: "storage.feature", e: { 0: "F1", 1: "F2", 2: "SMOOTH_F1", 3: "DISTANCE_TO_EDGE", 4: "N_SPHERE_RADIUS" } },
    normalize: { f: "storage.normalize", b: 1 },
  },
  ShaderNodeTexWave: {
    wave_type: { f: "storage.wave_type", e: { 0: "BANDS", 1: "RINGS" } },
    bands_direction: { f: "storage.bands_direction", e: { 0: "X", 1: "Y", 2: "Z", 3: "DIAGONAL" } },
    rings_direction: { f: "storage.rings_direction", e: { 0: "X", 1: "Y", 2: "Z", 3: "SPHERICAL" } },
    wave_profile: { f: "storage.wave_profile", e: { 0: "SIN", 1: "SAW", 2: "TRI" } },
  },
  ShaderNodeTexWhiteNoise: {
    noise_dimensions: { f: "custom1", e: { 1: "1D", 2: "2D", 3: "3D", 4: "4D" } },
  },
  ShaderNodeUVAlongStroke: {
    use_tips: { f: "custom1", b: 1 },
  },
  ShaderNodeUVMap: {
    from_instancer: { f: "custom1", b: 1 },
  },
  ShaderNodeVectorDisplacement: {
    space: { f: "custom1", e: { 0: "TANGENT", 1: "OBJECT", 2: "WORLD" } },
  },
  ShaderNodeVectorMath: {
    operation: { f: "custom1", e: { 0: "ADD", 1: "SUBTRACT", 2: "MULTIPLY", 3: "DIVIDE", 4: "CROSS_PRODUCT", 5: "PROJECT", 6: "REFLECT", 7: "DOT_PRODUCT", 8: "DISTANCE", 9: "LENGTH", 10: "SCALE", 11: "NORMALIZE", 12: "SNAP", 13: "FLOOR", 14: "CEIL", 15: "MODULO", 16: "FRACTION", 17: "ABSOLUTE", 18: "MINIMUM", 19: "MAXIMUM", 20: "WRAP", 21: "SINE", 22: "COSINE", 23: "TANGENT", 24: "REFRACT", 25: "FACEFORWARD", 26: "MULTIPLY_ADD", 27: "POWER", 28: "SIGN", 29: "ROUND" } },
  },
  ShaderNodeVectorRotate: {
    rotation_type: { f: "custom1", e: { 0: "AXIS_ANGLE", 1: "X_AXIS", 2: "Y_AXIS", 3: "Z_AXIS", 4: "EULER_XYZ" } },
    invert: { f: "custom2", b: 1 },
  },
  ShaderNodeVectorTransform: {
    vector_type: { f: "storage.type", e: { 0: "VECTOR", 1: "POINT", 2: "NORMAL" } },
    convert_from: { f: "storage.convert_from", e: { 0: "WORLD", 1: "OBJECT", 2: "CAMERA" } },
    convert_to: { f: "storage.convert_to", e: { 0: "WORLD", 1: "OBJECT", 2: "CAMERA" } },
  },
  ShaderNodeVolumeCoefficients: {
    phase: { f: "custom1", e: { 0: "HENYEY_GREENSTEIN", 1: "FOURNIER_FORAND", 2: "DRAINE", 3: "RAYLEIGH", 4: "MIE" } },
  },
  ShaderNodeVolumeScatter: {
    phase: { f: "custom1", e: { 0: "HENYEY_GREENSTEIN", 1: "FOURNIER_FORAND", 2: "DRAINE", 3: "RAYLEIGH", 4: "MIE" } },
  },
  ShaderNodeWireframe: {
    use_pixel_size: { f: "custom1", b: 1 },
  },
};
