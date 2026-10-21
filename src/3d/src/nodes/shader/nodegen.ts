// Per-node GLSL generators for shader nodes (registered into codegen's `nodeGenerators`).
import { tileGrid } from '../../render/udim';
import { registerGenerator, fmt, type NodeGen } from './codegen';
import { readRamp, bakeRamp, bakeCurves, type CurveKind } from '../curves';
import { MATH_SINGLE } from './defs';
// generators of the nodes added later
import './extra';
// realtime subsurface scattering parameters (GLSL chunk nd_sss)
import '../../render/realtime/sss';

const enumIndex = (items: string[], v: unknown) => Math.max(0, items.indexOf(String(v)));
const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d);
const linkedOr = (g: NodeGen, id: string, test: (v: number) => boolean) => g.linked(id) || test(num(g.value(id)));

// ---------------------------------------------------------------------------
// Input

registerGenerator('ShaderNodeAmbientOcclusion', (g) => {
  g.out('Color', 'vec4', g.in('Color', 'vec4'));
  g.out('AO', 'float', '1.0');
});

registerGenerator('ShaderNodeAttribute', (g) => {
  const type = g.str('attribute_type');
  const name = g.str('attribute_name');
  let col = 'vec4(0.0)';
  if (type === 'GEOMETRY' || type === '') {
    if (/^(uv|uvmap|uvmap\.\d+|st|uv_?map)$/i.test(name)) col = `vec4(${g.ctx.uv}, 1.0)`;
    else if (name) {
      g.feature('vertexColor');
      col = g.ctx.col;
    }
  } else if (type === 'OBJECT' || type === 'INSTANCER') {
    g.feature('objectInfo');
    if (/^color$/i.test(name)) col = g.ctx.objColor;
    else if (/^location$/i.test(name)) col = `vec4(${g.ctx.objLoc}, 1.0)`;
    else if (/^pass_index$/i.test(name)) col = `vec4(vec3(${g.ctx.objIndex}), 1.0)`;
  }
  const c = g.tmp('vec4', col);
  g.out('Color', 'vec4', `vec4(${c}.rgb, 1.0)`);
  g.out('Vector', 'vec3', `${c}.rgb`);
  g.out('Fac', 'float', `dot(${c}.rgb, vec3(1.0 / 3.0))`);
  g.out('Alpha', 'float', `${c}.a`);
});

registerGenerator('ShaderNodeBevel', (g) => g.out('Normal', 'vec3', g.inOr('Normal', 'vec3', g.ctx.N)));

registerGenerator('ShaderNodeCameraData', (g) => {
  const vp = g.tmp('vec3', g.ctx.viewPos);
  g.out('View Vector', 'vec3', `normalize(vec3(${vp}.xy, -${vp}.z))`);
  g.out('View Z Depth', 'float', `-${vp}.z`);
  g.out('View Distance', 'float', `length(${vp})`);
});

registerGenerator('ShaderNodeVertexColor', (g) => {
  g.feature('vertexColor');
  g.out('Color', 'vec4', `vec4(${g.ctx.col}.rgb, 1.0)`);
  g.out('Alpha', 'float', `${g.ctx.col}.a`);
});

registerGenerator('ShaderNodeFresnel', (g) => {
  g.lib('nd_fresnel');
  const n = g.inOr('Normal', 'vec3', g.ctx.N);
  g.out('Fac', 'float', `nd_fresnel_dielectric(dot(${g.ctx.I}, ${n}), ${g.ctx.back} > 0.5 ? 1.0 / max(${g.in('IOR', 'float')}, 1e-5) : max(${g.in('IOR', 'float')}, 1e-5))`);
});

registerGenerator('ShaderNodeNewGeometry', (g) => {
  g.out('Position', 'vec3', g.ctx.P);
  g.out('Normal', 'vec3', g.ctx.N);
  g.out('Tangent', 'vec3', g.ctx.tangent);
  g.out('True Normal', 'vec3', g.ctx.Ng);
  g.out('Incoming', 'vec3', g.ctx.I);
  g.feature('barycentric');
  g.out('Parametric', 'vec3', g.ctx.bary);
  g.out('Backfacing', 'float', g.ctx.back);
  g.out('Pointiness', 'float', '0.5');
  g.out('Random Per Island', 'float', '0.0');
});

registerGenerator('ShaderNodeLayerWeight', (g) => {
  g.lib('nd_fresnel');
  const n = g.inOr('Normal', 'vec3', g.ctx.N);
  const b = g.tmp('float', `clamp(${g.in('Blend', 'float')}, 0.0, 1.0 - 1e-5)`);
  const cosi = g.tmp('float', `dot(${g.ctx.I}, ${n})`);
  const eta = g.tmp('float', `max(1.0 - ${b}, 1e-5)`);
  g.out('Fresnel', 'float', `nd_fresnel_dielectric(${cosi}, ${g.ctx.back} > 0.5 ? ${eta} : 1.0 / ${eta})`);
  const e = g.tmp('float', `${b} < 0.5 ? 2.0 * ${b} : 0.5 / (1.0 - ${b})`);
  g.out('Facing', 'float', `pow(1.0 - clamp(abs(${cosi}), 0.0, 1.0), ${e})`);
});

registerGenerator('ShaderNodeLightPath', (g) => {
  g.out('Is Camera Ray', 'float', '1.0');
  g.out('Ray Length', 'float', `length(${g.ctx.viewPos})`);
});

registerGenerator('ShaderNodeObjectInfo', (g) => {
  g.feature('objectInfo');
  g.out('Location', 'vec3', g.ctx.objLoc);
  g.out('Color', 'vec4', `vec4(${g.ctx.objColor}.rgb, 1.0)`);
  g.out('Alpha', 'float', `${g.ctx.objColor}.a`);
  g.out('Object Index', 'float', g.ctx.objIndex);
  g.out('Material Index', 'float', g.ctx.matIndex);
  g.out('Random', 'float', g.ctx.objRandom);
});

registerGenerator('ShaderNodeRGB', (g) => {
  const c = (g.node.props['outputs.Color'] as number[] | undefined) ?? [0.5, 0.5, 0.5, 1];
  g.out('Color', 'vec4', g.uniform('vec4', [c[0], c[1], c[2], c[3] ?? 1]));
});

registerGenerator('ShaderNodeValue', (g) => g.out('Value', 'float', g.uniform('float', num(g.node.props['outputs.Value'], 0.5))));

registerGenerator('ShaderNodeTangent', (g) => {
  if (g.str('direction_type') === 'UV_MAP') {
    g.out('Tangent', 'vec3', g.ctx.tangent);
    return;
  }
  const axis =
    {
      X: 'vec3(1.0, 0.0, 0.0)',
      Y: 'vec3(0.0, 1.0, 0.0)',
      Z: 'vec3(0.0, 0.0, 1.0)',
    }[g.str('axis')] ?? 'vec3(0.0, 0.0, 1.0)';
  const t = g.tmp('vec3', g.target === 'WORLD' ? `cross(${axis}, ${g.ctx.P})` : `mat3(modelMatrix) * cross(${axis}, ${g.ctx.obj})`);
  g.out('Tangent', 'vec3', `nd_safe_normalize(${t} - ${g.ctx.N} * dot(${g.ctx.N}, ${t}))`);
});

registerGenerator('ShaderNodeTexCoord', (g) => {
  g.out('Generated', 'vec3', g.ctx.orco);
  g.out('Normal', 'vec3', g.ctx.objN);
  g.out('UV', 'vec3', g.ctx.uv);
  g.out('Object', 'vec3', g.ctx.obj);
  g.out('Camera', 'vec3', g.ctx.cam);
  g.out('Window', 'vec3', g.ctx.win);
  g.out('Reflection', 'vec3', g.ctx.refl);
});

registerGenerator('ShaderNodeUVMap', (g) => g.out('UV', 'vec3', g.ctx.uv));

registerGenerator('ShaderNodeWireframe', (g) => {
  g.feature('barycentric');
  const size = g.in('Size', 'float');
  const b = g.ctx.bary;
  const w = g.prop('use_pixel_size') ? g.tmp('vec3', `fwidth(${b}) * ${size}`) : g.tmp('vec3', `fwidth(${b}) * (${size} / max(length(fwidth(${g.ctx.P})), 1e-6))`);
  const a = g.tmp('vec3', `smoothstep(${w} * 0.5, ${w}, ${b})`);
  g.out('Fac', 'float', `1.0 - min(min(${a}.x, ${a}.y), ${a}.z)`);
});

// ---------------------------------------------------------------------------
// Shader

const N = (g: NodeGen, id = 'Normal') => g.inOr(id, 'vec3', g.ctx.N);

registerGenerator('ShaderNodeAddShader', (g) => g.out('Shader', 'NdClosure', `nd_cl_add(${g.in('Shader', 'NdClosure')}, ${g.in('Shader_001', 'NdClosure')})`));
registerGenerator('ShaderNodeMixShader', (g) => g.out('Shader', 'NdClosure', `nd_cl_mix(${g.in('Shader', 'NdClosure')}, ${g.in('Shader_001', 'NdClosure')}, ${g.in('Fac', 'float')})`));
registerGenerator('ShaderNodeBackground', (g) => g.out('Background', 'NdClosure', `nd_cl_emission(${g.in('Color', 'vec3')} * ${g.in('Strength', 'float')}, ${g.ctx.N})`));
registerGenerator('ShaderNodeEmission', (g) => g.out('Emission', 'NdClosure', `nd_cl_emission(${g.in('Color', 'vec3')} * ${g.in('Strength', 'float')}, ${g.ctx.N})`));
registerGenerator('ShaderNodeBsdfDiffuse', (g) => g.out('BSDF', 'NdClosure', `nd_cl_bsdf(${g.in('Color', 'vec3')}, 0.0, 1.0, 1.5, 0.0, ${N(g)})`));
registerGenerator(['ShaderNodeBsdfTranslucent', 'ShaderNodeSubsurfaceScattering'], (g) => {
  const out = g.node.type === 'ShaderNodeSubsurfaceScattering' ? 'BSSRDF' : 'BSDF';
  g.out(out, 'NdClosure', `nd_cl_bsdf(${g.in('Color', 'vec3')}, 0.0, 1.0, 1.5, ${out === 'BSSRDF' ? '0.25' : '0.0'}, ${N(g)})`);
  if (out === 'BSSRDF' && g.target === 'MATERIAL') {
    g.lib('nd_sss');
    g.stmt(`nd_sss_set(1.0, ${g.in('Radius', 'vec3')}, ${g.in('Scale', 'float')});`);
  }
});
registerGenerator('ShaderNodeBsdfAnisotropic', (g) => {
  const c = g.tmp('NdClosure', `nd_cl_bsdf(${g.in('Color', 'vec3')}, 1.0, ${g.in('Roughness', 'float')}, 1.5, 0.5, ${N(g)})`);
  if (linkedOr(g, 'Anisotropy', (v) => v !== 0)) {
    g.feature('anisotropy');
    g.stmt(`${c}.aniso = ${g.in('Anisotropy', 'float')}; ${c}.anisoRot = ${g.in('Rotation', 'float')};`);
  }
  g.out('BSDF', 'NdClosure', c);
});
registerGenerator('ShaderNodeBsdfMetallic', (g) => {
  let base: string;
  if (g.str('fresnel_type') === 'PHYSICAL_CONDUCTOR') {
    const n = g.tmp('vec3', g.in('IOR', 'vec3')),
      k = g.tmp('vec3', g.in('Extinction', 'vec3'));
    base = `clamp(((${n} - 1.0) * (${n} - 1.0) + ${k} * ${k}) / ((${n} + 1.0) * (${n} + 1.0) + ${k} * ${k}), 0.0, 1.0)`;
  } else base = g.in('Base Color', 'vec3');
  const c = g.tmp('NdClosure', `nd_cl_bsdf(${base}, 1.0, ${g.in('Roughness', 'float')}, 1.5, 0.5, ${N(g)})`);
  if (linkedOr(g, 'Anisotropy', (v) => v !== 0)) {
    g.feature('anisotropy');
    g.stmt(`${c}.aniso = ${g.in('Anisotropy', 'float')}; ${c}.anisoRot = ${g.in('Rotation', 'float')};`);
  }
  if (linkedOr(g, 'Thin Film Thickness', (v) => v > 0)) {
    g.feature('thinFilm');
    g.stmt(`${c}.thinFilm = ${g.in('Thin Film Thickness', 'float')}; ${c}.thinFilmIor = ${g.in('Thin Film IOR', 'float')};`);
  }
  g.out('BSDF', 'NdClosure', c);
});
registerGenerator(['ShaderNodeBsdfGlass', 'ShaderNodeBsdfRefraction'], (g) => {
  g.feature('transmission');
  const c = g.tmp('NdClosure', `nd_cl_bsdf(${g.in('Color', 'vec3')}, 0.0, ${g.in('Roughness', 'float')}, ${g.in('IOR', 'float')}, ${g.node.type === 'ShaderNodeBsdfGlass' ? '0.5' : '0.0'}, ${N(g)})`);
  g.stmt(`${c}.transmission = 1.0;`);
  if (g.node.type === 'ShaderNodeBsdfGlass' && linkedOr(g, 'Thin Film Thickness', (v) => v > 0)) {
    g.feature('thinFilm');
    g.stmt(`${c}.thinFilm = ${g.in('Thin Film Thickness', 'float')}; ${c}.thinFilmIor = ${g.in('Thin Film IOR', 'float')};`);
  }
  g.out('BSDF', 'NdClosure', c);
});
registerGenerator('ShaderNodeHoldout', (g) => g.out('Holdout', 'NdClosure', `nd_cl_bsdf(vec3(0.0), 0.0, 1.0, 1.5, 0.0, ${g.ctx.N})`));
registerGenerator('ShaderNodeBsdfSheen', (g) => {
  g.feature('sheen');
  const c = g.tmp('NdClosure', `nd_cl_bsdf(vec3(0.0), 0.0, 1.0, 1.5, 0.0, ${N(g)})`);
  g.stmt(`${c}.sheen = 1.0; ${c}.sheenTint = ${g.in('Color', 'vec3')}; ${c}.sheenRough = ${g.in('Roughness', 'float')};`);
  g.out('BSDF', 'NdClosure', c);
});
registerGenerator('ShaderNodeBsdfToon', (g) => {
  const glossy = g.str('component') === 'GLOSSY';
  g.out(
    'BSDF',
    'NdClosure',
    `nd_cl_bsdf(${g.in('Color', 'vec3')}, ${glossy ? '1.0' : '0.0'}, ${glossy ? `clamp(${g.in('Size', 'float')} + ${g.in('Smooth', 'float')} * 0.5, 0.0, 1.0)` : '1.0'}, 1.5, 0.0, ${N(g)})`,
  );
});
registerGenerator('ShaderNodeBsdfTransparent', (g) => {
  g.feature('alpha');
  const c = g.tmp('NdClosure', `nd_cl_empty(${g.ctx.N})`);
  g.stmt(`${c}.alpha = clamp(1.0 - nd_luma(${g.in('Color', 'vec3')}), 0.0, 1.0);`);
  g.out('BSDF', 'NdClosure', c);
});
registerGenerator('ShaderNodeEeveeSpecular', (g) => {
  const c = g.tmp('NdClosure', `nd_cl_bsdf(${g.in('Base Color', 'vec3')}, 0.0, ${g.in('Roughness', 'float')}, 1.5, 0.5, ${N(g)})`);
  g.stmt(
    `${c}.specTint = clamp(${g.in('Specular', 'vec3')} / 0.04, 0.0, 25.0); ${c}.emission = ${g.in('Emissive Color', 'vec3')}; ${c}.alpha = 1.0 - clamp(${g.in('Transparency', 'float')}, 0.0, 1.0);`,
  );
  if (linkedOr(g, 'Transparency', (v) => v > 0)) g.feature('alpha');
  if (linkedOr(g, 'Clear Coat', (v) => v > 0)) {
    g.feature('coat');
    g.stmt(`${c}.coat = ${g.in('Clear Coat', 'float')}; ${c}.coatRough = ${g.in('Clear Coat Roughness', 'float')}; ${c}.coatN = ${N(g, 'Clear Coat Normal')};`);
  }
  g.out('BSDF', 'NdClosure', c);
});
registerGenerator('ShaderNodeBsdfPrincipled', (g) => {
  const c = g.tmp(
    'NdClosure',
    `nd_cl_bsdf(${g.in('Base Color', 'vec3')}, clamp(${g.in('Metallic', 'float')}, 0.0, 1.0), clamp(${g.in('Roughness', 'float')}, 0.0, 1.0), max(${g.in('IOR', 'float')}, 1.0), max(${g.in('Specular IOR Level', 'float')}, 0.0), ${N(g)})`,
  );
  g.stmt(`${c}.specTint = ${g.in('Specular Tint', 'vec3')};`);
  g.stmt(`${c}.emission = ${g.in('Emission Color', 'vec3')} * ${g.in('Emission Strength', 'float')};`);
  if (linkedOr(g, 'Alpha', (v) => v < 1)) {
    g.feature('alpha');
    g.stmt(`${c}.alpha = clamp(${g.in('Alpha', 'float')}, 0.0, 1.0);`);
  }
  if (linkedOr(g, 'Transmission Weight', (v) => v > 0)) {
    g.feature('transmission');
    g.stmt(`${c}.transmission = clamp(${g.in('Transmission Weight', 'float')}, 0.0, 1.0);`);
  }
  if (linkedOr(g, 'Coat Weight', (v) => v > 0)) {
    g.feature('coat');
    g.stmt(
      `${c}.coat = ${g.in('Coat Weight', 'float')}; ${c}.coatRough = ${g.in('Coat Roughness', 'float')}; ${c}.coatIor = ${g.in('Coat IOR', 'float')}; ${c}.coatTint = ${g.in('Coat Tint', 'vec3')}; ${c}.coatN = ${N(g, 'Coat Normal')};`,
    );
  }
  if (linkedOr(g, 'Sheen Weight', (v) => v > 0)) {
    g.feature('sheen');
    g.stmt(`${c}.sheen = ${g.in('Sheen Weight', 'float')}; ${c}.sheenRough = ${g.in('Sheen Roughness', 'float')}; ${c}.sheenTint = ${g.in('Sheen Tint', 'vec3')};`);
  }
  if (linkedOr(g, 'Anisotropic', (v) => v > 0)) {
    g.feature('anisotropy');
    g.stmt(`${c}.aniso = ${g.in('Anisotropic', 'float')}; ${c}.anisoRot = ${g.in('Anisotropic Rotation', 'float')};`);
  }
  if (linkedOr(g, 'Thin Film Thickness', (v) => v > 0)) {
    g.feature('thinFilm');
    g.stmt(`${c}.thinFilm = ${g.in('Thin Film Thickness', 'float')}; ${c}.thinFilmIor = ${g.in('Thin Film IOR', 'float')};`);
  }
  if (linkedOr(g, 'Subsurface Weight', (v) => v > 0)) {
    // soften: subsurface reduces specular sharpness and brightens diffuse slightly
    g.stmt(`${c}.base = mix(${c}.base, sqrt(max(${c}.base, vec3(0.0))) * ${c}.base, -0.2 * clamp(${g.in('Subsurface Weight', 'float')}, 0.0, 1.0));`);
    if (g.target === 'MATERIAL') {
      g.lib('nd_sss');
      g.stmt(`nd_sss_set(${g.in('Subsurface Weight', 'float')}, ${g.in('Subsurface Radius', 'vec3')}, ${g.in('Subsurface Scale', 'float')});`);
    }
  }
  g.out('BSDF', 'NdClosure', c);
});
const volume = (g: NodeGen, kind: 'ABS' | 'SCATTER' | 'PRINCIPLED') => {
  g.feature('alpha');
  const c = g.tmp('NdClosure', `nd_cl_empty(${g.ctx.N})`);
  const dens = g.tmp('float', `1.0 - exp(-max(${g.in('Density', 'float')}, 0.0) * 0.7)`);
  const col = g.in('Color', 'vec3');
  g.stmt(`${c}.base = ${kind === 'ABS' ? `${col} * 0.15` : col}; ${c}.alpha = ${dens}; ${c}.weight = ${dens}; ${c}.roughness = 1.0; ${c}.specular = 0.0;`);
  if (kind === 'PRINCIPLED') {
    g.lib('nd_wavelength');
    g.stmt(
      `${c}.emission = ${g.in('Emission Color', 'vec3')} * ${g.in('Emission Strength', 'float')} + nd_blackbody(${g.in('Temperature', 'float')}).rgb * ${g.in('Blackbody Intensity', 'float')} * ${g.in('Blackbody Tint', 'vec3')};`,
    );
  }
  g.out('Volume', 'NdClosure', c);
};
registerGenerator('ShaderNodeVolumeAbsorption', (g) => volume(g, 'ABS'));
registerGenerator('ShaderNodeVolumeScatter', (g) => volume(g, 'SCATTER'));
registerGenerator('ShaderNodeVolumePrincipled', (g) => volume(g, 'PRINCIPLED'));

// ---------------------------------------------------------------------------
// Displacement

registerGenerator('ShaderNodeBump', (g) => {
  g.lib('nd_bump');
  const h = g.tmp('float', g.in('Height', 'float'));
  g.out('Normal', 'vec3', `nd_bump(${g.ctx.P}, ${N(g)}, ${h}, ${g.in('Strength', 'float')}, ${g.in('Distance', 'float')}, ${g.prop('invert') ? 'true' : 'false'})`);
});
registerGenerator('ShaderNodeDisplacement', (g) => {
  const n = N(g);
  const d = g.tmp('vec3', `${n} * (${g.in('Height', 'float')} - ${g.in('Midlevel', 'float')}) * ${g.in('Scale', 'float')}`);
  g.out('Displacement', 'vec3', g.str('space') === 'OBJECT' && g.target === 'MATERIAL' ? `${d} * length(mat3(modelMatrix) * vec3(0.57735))` : d);
});
registerGenerator('ShaderNodeVectorDisplacement', (g) => {
  const v = g.tmp('vec3', `(${g.in('Vector', 'vec3')} - vec3(${g.in('Midlevel', 'float')})) * ${g.in('Scale', 'float')}`);
  const space = g.str('space');
  if (space === 'TANGENT') g.out('Displacement', 'vec3', `${g.ctx.tangent} * ${v}.x + cross(${g.ctx.N}, ${g.ctx.tangent}) * ${v}.y + ${g.ctx.N} * ${v}.z`);
  else if (space === 'OBJECT' && g.target === 'MATERIAL') g.out('Displacement', 'vec3', `mat3(modelMatrix) * ${v}`);
  else g.out('Displacement', 'vec3', v);
});
registerGenerator('ShaderNodeNormalMap', (g) => {
  const space = g.str('space');
  const col = g.tmp('vec3', `${g.in('Color', 'vec3')} * 2.0 - 1.0`);
  if (g.str('convention') === 'DIRECTX') g.stmt(`${col}.y = -${col}.y;`);
  let n: string;
  if (space === 'TANGENT') n = `normalize(${g.ctx.tangent} * ${col}.x + ndB * ${col}.y + ${g.ctx.N} * ${col}.z)`;
  else {
    if (space.startsWith('BLENDER_')) g.stmt(`${col} = vec3(${col}.x, -${col}.y, -${col}.z);`);
    n = space.endsWith('OBJECT') && g.target === 'MATERIAL' ? `normalize(transpose(inverse(mat3(modelMatrix))) * ${col})` : `normalize(${col})`;
  }
  if (space === 'TANGENT' && g.target === 'WORLD') n = g.ctx.N;
  g.out('Normal', 'vec3', `normalize(mix(${g.ctx.N}, ${n}, max(${g.in('Strength', 'float')}, 0.0)))`);
});

// ---------------------------------------------------------------------------
// Color

registerGenerator('ShaderNodeBlackbody', (g) => {
  g.lib('nd_wavelength');
  g.out('Color', 'vec4', `nd_blackbody(${g.in('Temperature', 'float')})`);
});
registerGenerator('ShaderNodeWavelength', (g) => {
  g.lib('nd_wavelength');
  g.out('Color', 'vec4', `nd_wavelength(${g.in('Wavelength', 'float')})`);
});
registerGenerator('ShaderNodeBrightContrast', (g) => {
  const c = g.tmp('vec4', g.in('Color', 'vec4'));
  const ct = g.tmp('float', g.in('Contrast', 'float'));
  g.out('Color', 'vec4', `vec4(max((1.0 + ${ct}) * ${c}.rgb + (${g.in('Bright', 'float')} - ${ct} * 0.5), vec3(0.0)), ${c}.a)`);
});
registerGenerator('ShaderNodeGamma', (g) => {
  const c = g.tmp('vec4', g.in('Color', 'vec4'));
  const gm = g.tmp('float', g.in('Gamma', 'float'));
  g.out('Color', 'vec4', `vec4(mix(${c}.rgb, pow(max(${c}.rgb, vec3(0.0)), vec3(${gm})), step(vec3(0.0), ${c}.rgb)), ${c}.a)`);
});
registerGenerator('ShaderNodeHueSaturation', (g) => {
  g.lib('nd_color');
  const c = g.tmp('vec4', g.in('Color', 'vec4'));
  const hsv = g.tmp('vec3', `nd_rgb2hsv(${c}.rgb)`);
  g.stmt(`${hsv}.x = fract(${hsv}.x + ${g.in('Hue', 'float')} + 0.5); ${hsv}.y = clamp(${hsv}.y * ${g.in('Saturation', 'float')}, 0.0, 1.0); ${hsv}.z *= ${g.in('Value', 'float')};`);
  g.out('Color', 'vec4', `vec4(mix(${c}.rgb, max(nd_hsv2rgb(${hsv}), vec3(0.0)), ${g.in('Fac', 'float')}), ${c}.a)`);
});
registerGenerator('ShaderNodeInvert', (g) => {
  const c = g.tmp('vec4', g.in('Color', 'vec4'));
  g.out('Color', 'vec4', `vec4(mix(${c}.rgb, vec3(1.0) - ${c}.rgb, ${g.in('Fac', 'float')}), ${c}.a)`);
});
registerGenerator('ShaderNodeLightFalloff', (g) => {
  const r = g.tmp('float', `length(${g.ctx.viewPos})`);
  const s = g.tmp('float', g.in('Strength', 'float'));
  const sm = g.tmp('float', g.in('Smooth', 'float'));
  g.stmt(`if (${sm} > 0.0) { float r2 = ${r} * ${r}; ${s} *= r2 / (${sm} + r2); }`);
  g.out('Quadratic', 'float', s);
  g.out('Linear', 'float', `${s} * ${r}`);
  g.out('Constant', 'float', `${s} * ${r} * ${r}`);
});
registerGenerator('ShaderNodeRGBToBW', (g) => g.out('Val', 'float', `nd_luma(${g.in('Color', 'vec3')})`));
registerGenerator('ShaderNodeShaderToRGB', (g) => {
  const c = g.tmp('NdClosure', g.in('Shader', 'NdClosure'));
  g.out('Color', 'vec4', `vec4(${c}.base * ${c}.weight * (0.35 + 0.65 * max(dot(${c}.N, normalize(vec3(0.3, -0.4, 0.86))), 0.0)) + ${c}.emission, 1.0)`);
  g.out('Alpha', 'float', `${c}.alpha`);
});
registerGenerator('ShaderNodeCombineColor', (g) => {
  g.lib('nd_color');
  const v = `vec3(${g.in('Red', 'float')}, ${g.in('Green', 'float')}, ${g.in('Blue', 'float')})`;
  const m = g.str('mode');
  g.out('Color', 'vec4', `vec4(${m === 'HSV' ? `nd_hsv2rgb(${v})` : m === 'HSL' ? `nd_hsl2rgb(${v})` : v}, 1.0)`);
});
registerGenerator('ShaderNodeSeparateColor', (g) => {
  g.lib('nd_color');
  const m = g.str('mode');
  const c = g.tmp('vec3', m === 'HSV' ? `nd_rgb2hsv(${g.in('Color', 'vec3')})` : m === 'HSL' ? `nd_rgb2hsl(${g.in('Color', 'vec3')})` : g.in('Color', 'vec3'));
  g.out('Red', 'float', `${c}.x`);
  g.out('Green', 'float', `${c}.y`);
  g.out('Blue', 'float', `${c}.z`);
});
registerGenerator('ShaderNodeValToRGB', (g) => {
  const ramp = readRamp(g.node.props);
  const lut = g.uniform('sampler2D', {
    kind: 'lut',
    data: bakeRamp(ramp, 256),
    width: 256,
    nearest: ramp.interpolation === 'CONSTANT',
  });
  const f = g.tmp('float', `clamp(${g.in('Fac', 'float')}, 0.0, 1.0)`);
  const c = g.tmp('vec4', `texture(${lut}, vec2((${f} * 255.0 + 0.5) / 256.0, 0.5))`);
  g.out('Color', 'vec4', c);
  g.out('Alpha', 'float', `${c}.a`);
});
function curveLut(g: NodeGen, kind: CurveKind) {
  const { data, min, max } = bakeCurves(g.node.props, kind, 256);
  const lut = g.uniform('sampler2D', { kind: 'lut', data, width: 256 });
  const extrap = g.node.props.curve_extend === 'EXTRAPOLATED';
  return (x: string, ch: string) => {
    const t = g.tmp('float', `(${x} - ${fmt(min)}) / ${fmt(max - min)}`);
    const s = `texture(${lut}, vec2(clamp(${t}, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).${ch}`;
    if (!extrap) return s;
    // linear extension using the end slopes of the table
    const lo = `texture(${lut}, vec2(0.5 / 256.0, 0.5)).${ch}`,
      lo2 = `texture(${lut}, vec2(1.5 / 256.0, 0.5)).${ch}`,
      hi = `texture(${lut}, vec2(255.5 / 256.0, 0.5)).${ch}`,
      hi2 = `texture(${lut}, vec2(254.5 / 256.0, 0.5)).${ch}`;
    return `(${t} < 0.0 ? ${lo} + (${lo2} - ${lo}) * 255.0 * ${t} : (${t} > 1.0 ? ${hi} + (${hi} - ${hi2}) * 255.0 * (${t} - 1.0) : ${s}))`;
  };
}
registerGenerator('ShaderNodeRGBCurve', (g) => {
  const look = curveLut(g, 'RGB');
  const c = g.tmp('vec4', g.in('Color', 'vec4'));
  const r = g.tmp('vec3', `vec3(${look(`${c}.r`, 'r')}, ${look(`${c}.g`, 'g')}, ${look(`${c}.b`, 'b')})`);
  g.out('Color', 'vec4', `vec4(mix(${c}.rgb, ${r}, ${g.in('Fac', 'float')}), ${c}.a)`);
});
registerGenerator('ShaderNodeVectorCurve', (g) => {
  const look = curveLut(g, 'VECTOR');
  const v = g.tmp('vec3', g.in('Vector', 'vec3'));
  const r = g.tmp('vec3', `vec3(${look(`${v}.x`, 'r')}, ${look(`${v}.y`, 'g')}, ${look(`${v}.z`, 'b')})`);
  g.out('Vector', 'vec3', `mix(${v}, ${r}, ${g.in('Fac', 'float')})`);
});
registerGenerator('ShaderNodeFloatCurve', (g) => {
  const look = curveLut(g, 'FLOAT');
  const v = g.tmp('float', g.in('Value', 'float'));
  g.out('Value', 'float', `mix(${v}, ${look(v, 'r')}, ${g.in('Factor', 'float')})`);
});

const BLEND = [
  'MIX',
  'DARKEN',
  'MULTIPLY',
  'BURN',
  'LIGHTEN',
  'SCREEN',
  'DODGE',
  'ADD',
  'OVERLAY',
  'SOFT_LIGHT',
  'LINEAR_LIGHT',
  'DIFFERENCE',
  'EXCLUSION',
  'SUBTRACT',
  'DIVIDE',
  'HUE',
  'SATURATION',
  'COLOR',
  'VALUE',
];
registerGenerator('ShaderNodeMix', (g) => {
  const t = g.str('data_type') || 'FLOAT';
  const clampF = g.prop('clamp_factor') !== false;
  if (t === 'VECTOR') {
    const nonUniform = g.str('factor_mode') === 'NON_UNIFORM';
    let f = nonUniform ? g.in('Factor_Vector', 'vec3') : g.in('Factor_Float', 'float');
    if (clampF) f = nonUniform ? `clamp(${f}, 0.0, 1.0)` : `clamp(${f}, 0.0, 1.0)`;
    g.out('Result_Vector', 'vec3', `mix(${g.in('A_Vector', 'vec3')}, ${g.in('B_Vector', 'vec3')}, ${f})`);
  } else if (t === 'RGBA') {
    g.lib('nd_mix_blend');
    let f = g.in('Factor_Float', 'float');
    if (clampF) f = `clamp(${f}, 0.0, 1.0)`;
    const a = g.tmp('vec4', g.in('A_Color', 'vec4'));
    let r = `nd_blend(${enumIndex(BLEND, g.str('blend_type'))}, ${f}, ${a}.rgb, ${g.in('B_Color', 'vec3')})`;
    if (g.prop('clamp_result')) r = `clamp(${r}, 0.0, 1.0)`;
    g.out('Result_Color', 'vec4', `vec4(${r}, ${a}.a)`);
  } else {
    let f = g.in('Factor_Float', 'float');
    if (clampF) f = `clamp(${f}, 0.0, 1.0)`;
    g.out('Result_Float', 'float', `mix(${g.in('A_Float', 'float')}, ${g.in('B_Float', 'float')}, ${f})`);
  }
});
registerGenerator('ShaderNodeMixRGB', (g) => {
  g.lib('nd_mix_blend');
  const b = g.tmp('vec4', g.in('Color2', 'vec4'));
  let f = `clamp(${g.in('Fac', 'float')}, 0.0, 1.0)`;
  if (g.prop('use_alpha')) f = `(${f} * ${b}.a)`;
  const a = g.tmp('vec4', g.in('Color1', 'vec4'));
  let r = `nd_blend(${enumIndex(BLEND, g.str('blend_type'))}, ${f}, ${a}.rgb, ${b}.rgb)`;
  if (g.prop('use_clamp')) r = `clamp(${r}, 0.0, 1.0)`;
  g.out('Color', 'vec4', `vec4(${r}, ${a}.a)`);
});

// ---------------------------------------------------------------------------
// Textures

const texVector = (g: NodeGen) => g.inOr('Vector', 'vec3', g.ctx.orco);

registerGenerator('ShaderNodeTexChecker', (g) => {
  g.lib('nd_checker');
  const f = g.tmp('float', `nd_checker(${texVector(g)}, ${g.in('Scale', 'float')})`);
  g.out('Color', 'vec4', `mix(${g.in('Color2', 'vec4')}, ${g.in('Color1', 'vec4')}, ${f})`);
  g.out('Fac', 'float', f);
});
registerGenerator('ShaderNodeTexBrick', (g) => {
  g.lib('nd_brick');
  const p = g.tmp('vec3', `${texVector(g)} * ${g.in('Scale', 'float')}`);
  const r = g.tmp(
    'vec2',
    `nd_brick(${p}, ${g.in('Mortar Size', 'float')}, ${g.in('Mortar Smooth', 'float')}, ${g.in('Bias', 'float')}, ${g.in('Brick Width', 'float')}, ${g.in('Row Height', 'float')}, ${g.uniform('float', num(g.prop('offset'), 0.5))}, ${g.uniform('float', num(g.prop('offset_frequency'), 2))}, ${g.uniform('float', num(g.prop('squash'), 1))}, ${g.uniform('float', num(g.prop('squash_frequency'), 2))})`,
  );
  const c1 = g.tmp('vec4', g.in('Color1', 'vec4'));
  const brick = g.tmp('vec4', `mix(${c1}, ${g.in('Color2', 'vec4')}, ${r}.x)`);
  g.out('Color', 'vec4', `mix(${brick}, ${g.in('Mortar', 'vec4')}, ${r}.y)`);
  g.out('Fac', 'float', `${r}.y`);
});
const GRADIENTS = ['LINEAR', 'QUADRATIC', 'EASING', 'DIAGONAL', 'SPHERICAL', 'QUADRATIC_SPHERE', 'RADIAL'];
registerGenerator('ShaderNodeTexGradient', (g) => {
  g.lib('nd_gradient');
  const f = g.tmp('float', `clamp(nd_gradient(${texVector(g)}, ${enumIndex(GRADIENTS, g.str('gradient_type'))}), 0.0, 1.0)`);
  g.out('Color', 'vec4', `vec4(vec3(${f}), 1.0)`);
  g.out('Fac', 'float', f);
});
registerGenerator('ShaderNodeTexMagic', (g) => {
  g.lib('nd_magic');
  const r = g.tmp('vec4', `nd_magic(${texVector(g)} * ${g.in('Scale', 'float')}, ${Math.round(num(g.prop('turbulence_depth'), 2))}, ${g.in('Distortion', 'float')})`);
  g.out('Color', 'vec4', `vec4(${r}.rgb, 1.0)`);
  g.out('Fac', 'float', `${r}.a`);
});
const NOISE_TYPES = ['MULTIFRACTAL', 'RIDGED_MULTIFRACTAL', 'HYBRID_MULTIFRACTAL', 'FBM', 'HETERO_TERRAIN'];
registerGenerator('ShaderNodeTexNoise', (g) => {
  g.lib('nd_noise_tex');
  const dims = g.str('noise_dimensions') || '3D';
  const sc = g.tmp('float', g.in('Scale', 'float'));
  const v = texVector(g);
  const w = () => g.in('W', 'float');
  const p = dims === '1D' ? `${w()} * ${sc}` : dims === '2D' ? `${v}.xy * ${sc}` : dims === '4D' ? `vec4(${v}, ${w()}) * ${sc}` : `${v} * ${sc}`;
  const type = enumIndex(NOISE_TYPES, g.str('noise_type') || 'FBM');
  const r = g.tmp(
    'vec4',
    `nd_noise_tex${dims[0]}(${p}, ${g.in('Detail', 'float')}, ${g.in('Roughness', 'float')}, ${g.in('Lacunarity', 'float')}, ${g.in('Offset', 'float')}, ${g.in('Gain', 'float')}, ${g.in('Distortion', 'float')}, ${type}, ${g.prop('normalize') === false ? 'false' : 'true'})`,
  );
  g.out('Fac', 'float', `${r}.x`);
  g.out('Color', 'vec4', `vec4(${r}.yzw, 1.0)`);
});
registerGenerator('ShaderNodeTexWhiteNoise', (g) => {
  g.lib('nd_white_noise');
  const dims = g.str('noise_dimensions') || '3D';
  const v = texVector(g);
  const p = dims === '1D' ? g.in('W', 'float') : dims === '2D' ? `${v}.xy` : dims === '4D' ? `vec4(${v}, ${g.in('W', 'float')})` : v;
  const r = g.tmp('vec4', `nd_white${dims[0]}(${p})`);
  g.out('Value', 'float', `${r}.x`);
  g.out('Color', 'vec4', `vec4(${r}.yzw, 1.0)`);
});
const VFEAT = ['F1', 'F2', 'SMOOTH_F1', 'DISTANCE_TO_EDGE', 'N_SPHERE_RADIUS'];
const VDIST = ['EUCLIDEAN', 'MANHATTAN', 'CHEBYCHEV', 'MINKOWSKI'];
registerGenerator('ShaderNodeTexVoronoi', (g) => {
  const dims = g.str('voronoi_dimensions') || '3D';
  g.lib(`nd_voronoi${dims[0]}`);
  const v = texVector(g);
  const p = dims === '1D' ? g.in('W', 'float') : dims === '2D' ? `${v}.xy` : dims === '4D' ? `vec4(${v}, ${g.in('W', 'float')})` : v;
  const feature = enumIndex(VFEAT, g.str('feature'));
  const metric = dims === '1D' ? 0 : enumIndex(VDIST, g.str('distance'));
  const r = g.tmp(
    'NdVor',
    `nd_voronoi${dims[0]}(${p}, ${g.in('Scale', 'float')}, ${g.in('Detail', 'float')}, ${g.in('Roughness', 'float')}, ${g.in('Lacunarity', 'float')}, ${g.in('Smoothness', 'float')}, max(${g.in('Exponent', 'float')}, 1e-3), ${g.in('Randomness', 'float')}, ${feature}, ${metric}, ${g.prop('normalize') ? 'true' : 'false'})`,
  );
  g.out('Distance', 'float', `${r}.dist`);
  g.out('Color', 'vec4', `vec4(${r}.col, 1.0)`);
  g.out('Position', 'vec3', dims === '2D' ? `vec3(${r}.pos.xy, 0.0)` : `${r}.pos.xyz`);
  g.out('W', 'float', `${r}.pos.w`);
  g.out('Radius', 'float', `${r}.radius`);
});
registerGenerator('ShaderNodeTexWave', (g) => {
  g.lib('nd_wave');
  const f = g.tmp(
    'float',
    `nd_wave(${texVector(g)} * ${g.in('Scale', 'float')}, ${g.str('wave_type') === 'RINGS' ? 1 : 0}, ${enumIndex(['X', 'Y', 'Z', 'DIAGONAL'], g.str('bands_direction'))}, ${enumIndex(['X', 'Y', 'Z', 'SPHERICAL'], g.str('rings_direction'))}, ${enumIndex(['SIN', 'SAW', 'TRI'], g.str('wave_profile'))}, ${g.in('Distortion', 'float')}, ${g.in('Detail', 'float')}, ${g.in('Detail Scale', 'float')}, ${g.in('Detail Roughness', 'float')}, ${g.in('Phase Offset', 'float')})`,
  );
  g.out('Color', 'vec4', `vec4(vec3(${f}), 1.0)`);
  g.out('Fac', 'float', f);
});
registerGenerator('ShaderNodeTexGabor', (g) => {
  g.lib('nd_gabor');
  const is3 = g.str('gabor_type') === '3D';
  const orient = is3 ? `nd_safe_normalize(${g.in('Orientation 3D', 'vec3')})` : `vec3(cos(${g.in('Orientation 2D', 'float')}), sin(${g.in('Orientation 2D', 'float')}), 0.0)`;
  const r = g.tmp('vec3', `nd_gabor(${texVector(g)}, ${g.in('Scale', 'float')}, ${g.in('Frequency', 'float')}, clamp(${g.in('Anisotropy', 'float')}, 0.0, 1.0), ${orient}, ${is3})`);
  g.out('Value', 'float', `${r}.x`);
  g.out('Phase', 'float', `${r}.y`);
  g.out('Intensity', 'float', `${r}.z`);
});
const INTERP = ['Linear', 'Closest', 'Cubic', 'Smart'];
const EXT = ['REPEAT', 'EXTEND', 'CLIP', 'MIRROR'];
registerGenerator('ShaderNodeTexImage', (g) => {
  g.lib('nd_image');
  const img = (g.prop('image') as string | null) ?? null;
  if (!img || !g.doc.images[img]) {
    g.out('Color', 'vec4', 'vec4(1.0, 0.0, 1.0, 1.0)');
    g.out('Alpha', 'float', '1.0');
    return;
  }
  const interp = Math.min(2, enumIndex(INTERP, g.str('interpolation')));
  const ext = enumIndex(EXT, g.str('extension'));
  const tex = g.uniform('sampler2D', {
    kind: 'image',
    image: img,
    interpolation: g.str('interpolation') || 'Linear',
  });
  const v = g.tmp('vec3', g.inOr('Vector', 'vec3', g.ctx.uv));
  const proj = g.str('projection');
  let c: string;
  if (proj === 'BOX') c = `nd_tex_box(${tex}, ${v}, ${g.ctx.objN}, ${g.uniform('float', num(g.prop('projection_blend'), 0))}, ${interp}, ${ext})`;
  else if (proj === 'SPHERE') c = `nd_tex_sample(${tex}, nd_sphere_uv(${v}), ${interp}, ${ext})`;
  else if (proj === 'TUBE') c = `nd_tex_sample(${tex}, nd_tube_uv(${v}), ${interp}, ${ext})`;
  else c = `nd_tex_sample(${tex}, ${v}.xy, ${interp}, ${ext})`;
  const im = g.doc.images[img];
  if (im.source === 'TILED' && im.tiles?.length && proj !== 'BOX') {
    // UDIM tiles: the texture is an atlas of the tiles (render/udim.ts)
    const { cols, rows } = tileGrid(im.tiles.map((t) => t.number));
    const uv = proj === 'SPHERE' ? `nd_sphere_uv(${v})` : proj === 'TUBE' ? `nd_tube_uv(${v})` : `${v}.xy`;
    c = `nd_tex_udim(${tex}, ${uv}, vec2(${cols}.0, ${rows}.0), ${interp})`;
  }
  const r = g.tmp('vec4', c);
  g.out('Color', 'vec4', `vec4(${r}.rgb, 1.0)`);
  g.out('Alpha', 'float', `${r}.a`);
});
registerGenerator('ShaderNodeTexEnvironment', (g) => {
  g.lib('nd_image');
  const img = (g.prop('image') as string | null) ?? null;
  if (!img || !g.doc.images[img]) {
    g.out('Color', 'vec4', 'vec4(1.0, 0.0, 1.0, 1.0)');
    return;
  }
  const tex = g.uniform('sampler2D', {
    kind: 'image',
    image: img,
    interpolation: g.str('interpolation') || 'Linear',
  });
  const d = g.tmp('vec3', g.inOr('Vector', 'vec3', `(-${g.ctx.I})`));
  const uv = g.str('projection') === 'MIRROR_BALL' ? `nd_mirrorball_uv(${d})` : `nd_equirect_uv(${d})`;
  const interp = Math.min(2, enumIndex(INTERP, g.str('interpolation')));
  g.out('Color', 'vec4', `vec4(nd_tex_sample(${tex}, ${uv}, ${interp}, 0).rgb, 1.0)`);
});
registerGenerator('ShaderNodeTexSky', (g) => {
  g.lib('nd_sky');
  const type = g.str('sky_type') || 'MULTIPLE_SCATTERING';
  const physical = type === 'SINGLE_SCATTERING' || type === 'MULTIPLE_SCATTERING' || type === 'NISHITA';
  let sun: number[];
  let turb: number;
  if (physical) {
    const el = num(g.prop('sun_elevation'), 0.2618),
      rot = num(g.prop('sun_rotation'), 0);
    sun = [Math.sin(rot) * Math.cos(el), Math.cos(rot) * Math.cos(el), Math.sin(el)];
    turb = Math.max(2, Math.min(10, 2.0 + 0.8 * (num(g.prop('aerosol_density'), 1) - 1) + 0.3 * (num(g.prop('air_density'), 1) - 1)));
  } else {
    sun = (g.prop('sun_direction') as number[] | null) ?? [0, 0, 1];
    turb = Math.max(2, num(g.prop('turbidity'), 2.2));
  }
  const disc = physical && g.prop('sun_disc') !== false ? 1 : 0;
  const d = g.tmp('vec3', `(-${g.ctx.I})`);
  const strength = physical ? Math.max(0.0, 1.0 + 0.0 * num(g.prop('ozone_density'), 1)) : 1;
  g.out(
    'Color',
    'vec4',
    `vec4(nd_sky(${d}, ${g.uniform('vec3', sun)}, ${g.uniform('float', turb)}, ${g.uniform('float', disc)}, ${g.uniform('float', num(g.prop('sun_size'), 0.0095) * 0.5)}, ${g.uniform('float', num(g.prop('sun_intensity'), 1))}, ${g.uniform('float', num(g.prop('ground_albedo'), 0.3))}, ndTexel) * ${fmt(strength)}, 1.0)`,
  );
});

// ---------------------------------------------------------------------------
// Utilities

registerGenerator('ShaderNodeClamp', (g) => {
  const mn = g.tmp('float', g.in('Min', 'float')),
    mx = g.tmp('float', g.in('Max', 'float'));
  const v = g.in('Value', 'float');
  g.out('Result', 'float', g.str('clamp_type') === 'RANGE' ? `clamp(${v}, min(${mn}, ${mx}), max(${mn}, ${mx}))` : `min(max(${v}, ${mn}), ${mx})`);
});
registerGenerator('ShaderNodeMapRange', (g) => {
  const vec = g.str('data_type') === 'FLOAT_VECTOR';
  const T = vec ? 'vec3' : 'float';
  const sfx = vec ? '_FLOAT3' : '';
  const v = g.tmp(T, g.in(vec ? 'Vector' : 'Value', T));
  const fmin = g.tmp(T, g.in(vec ? 'From_Min_FLOAT3' : 'From Min', T)),
    fmax = g.tmp(T, g.in(vec ? 'From_Max_FLOAT3' : 'From Max', T)),
    tmin = g.tmp(T, g.in(vec ? 'To_Min_FLOAT3' : 'To Min', T)),
    tmax = g.tmp(T, g.in(vec ? 'To_Max_FLOAT3' : 'To Max', T));
  const interp = g.str('interpolation_type') || 'LINEAR';
  const f = g.tmp(T, `nd_safe_div(${v} - ${fmin}, ${fmax} - ${fmin})`);
  if (interp === 'STEPPED') {
    const steps = g.tmp(T, g.in(`Steps${sfx}`, T));
    g.stmt(`${f} = mix(vec${vec ? '3' : '1'}(0.0), floor(${f} * (${steps} + 1.0)) / max(${steps}, ${T}(1e-6)), step(${T}(1e-6), ${steps}));`.replace('vec1', 'float'));
  } else if (interp === 'SMOOTHSTEP') g.stmt(`${f} = clamp(${f}, 0.0, 1.0); ${f} = ${f} * ${f} * (3.0 - 2.0 * ${f});`);
  else if (interp === 'SMOOTHERSTEP') g.stmt(`${f} = clamp(${f}, 0.0, 1.0); ${f} = ${f} * ${f} * ${f} * (${f} * (${f} * 6.0 - 15.0) + 10.0);`);
  let r = `${tmin} + ${f} * (${tmax} - ${tmin})`;
  if (g.prop('clamp') !== false && (interp === 'LINEAR' || interp === 'STEPPED')) r = `clamp(${r}, min(${tmin}, ${tmax}), max(${tmin}, ${tmax}))`;
  if (vec) g.out('Vector', 'vec3', r);
  else g.out('Result', 'float', r);
});
registerGenerator('ShaderNodeMath', (g) => {
  const op = g.str('operation') || 'ADD';
  const a = g.tmp('float', g.in('Value', 'float'));
  const b = MATH_SINGLE.has(op) ? '0.0' : g.tmp('float', g.in('Value_001', 'float'));
  const c = ['MULTIPLY_ADD', 'COMPARE', 'SMOOTH_MIN', 'SMOOTH_MAX', 'WRAP'].includes(op) ? g.tmp('float', g.in('Value_002', 'float')) : '0.0';
  const e: Record<string, string> = {
    ADD: `${a} + ${b}`,
    SUBTRACT: `${a} - ${b}`,
    MULTIPLY: `${a} * ${b}`,
    DIVIDE: `nd_safe_div(${a}, ${b})`,
    MULTIPLY_ADD: `${a} * ${b} + ${c}`,
    POWER: `nd_safe_pow(${a}, ${b})`,
    LOGARITHM: `nd_safe_log(${a}, ${b})`,
    SQRT: `nd_safe_sqrt(${a})`,
    INVERSE_SQRT: `nd_safe_isqrt(${a})`,
    ABSOLUTE: `abs(${a})`,
    EXPONENT: `exp(${a})`,
    MINIMUM: `min(${a}, ${b})`,
    MAXIMUM: `max(${a}, ${b})`,
    LESS_THAN: `${a} < ${b} ? 1.0 : 0.0`,
    GREATER_THAN: `${a} > ${b} ? 1.0 : 0.0`,
    SIGN: `sign(${a})`,
    COMPARE: `nd_compare(${a}, ${b}, ${c})`,
    SMOOTH_MIN: `nd_smoothmin(${a}, ${b}, ${c})`,
    SMOOTH_MAX: `-nd_smoothmin(-${a}, -${b}, ${c})`,
    ROUND: `nd_round(${a})`,
    FLOOR: `floor(${a})`,
    CEIL: `ceil(${a})`,
    TRUNC: `trunc(${a})`,
    FRACT: `${a} - floor(${a})`,
    MODULO: `nd_fmod(${a}, ${b})`,
    FLOORED_MODULO: `nd_floored_mod(${a}, ${b})`,
    WRAP: `nd_wrap(${a}, ${b}, ${c})`,
    SNAP: `nd_snap(${a}, ${b})`,
    PINGPONG: `nd_pingpong(${a}, ${b})`,
    SINE: `sin(${a})`,
    COSINE: `cos(${a})`,
    TANGENT: `tan(${a})`,
    ARCSINE: `(${a} >= -1.0 && ${a} <= 1.0) ? asin(${a}) : 0.0`,
    ARCCOSINE: `(${a} >= -1.0 && ${a} <= 1.0) ? acos(${a}) : 0.0`,
    ARCTANGENT: `atan(${a})`,
    ARCTAN2: `atan(${a}, ${b})`,
    SINH: `sinh(${a})`,
    COSH: `cosh(${a})`,
    TANH: `tanh(${a})`,
    RADIANS: `radians(${a})`,
    DEGREES: `degrees(${a})`,
  };
  let r = e[op] ?? `${a} + ${b}`;
  if (g.prop('use_clamp')) r = `clamp(${r}, 0.0, 1.0)`;
  g.out('Value', 'float', `(${r})`);
});
registerGenerator('ShaderNodeVectorMath', (g) => {
  const op = g.str('operation') || 'ADD';
  const a = g.tmp('vec3', g.in('Vector', 'vec3'));
  const b = ['NORMALIZE', 'LENGTH', 'ABSOLUTE', 'SIGN', 'FLOOR', 'CEIL', 'FRACTION', 'SINE', 'COSINE', 'TANGENT', 'SCALE'].includes(op) ? 'vec3(0.0)' : g.tmp('vec3', g.in('Vector_001', 'vec3'));
  const c = ['MULTIPLY_ADD', 'FACEFORWARD', 'WRAP'].includes(op) ? g.tmp('vec3', g.in('Vector_002', 'vec3')) : 'vec3(0.0)';
  const s = op === 'SCALE' || op === 'REFRACT' ? g.tmp('float', g.in('Scale', 'float')) : '1.0';
  const vecOps: Record<string, string> = {
    ADD: `${a} + ${b}`,
    SUBTRACT: `${a} - ${b}`,
    MULTIPLY: `${a} * ${b}`,
    DIVIDE: `nd_safe_div(${a}, ${b})`,
    MULTIPLY_ADD: `${a} * ${b} + ${c}`,
    CROSS_PRODUCT: `cross(${a}, ${b})`,
    PROJECT: `nd_project(${a}, ${b})`,
    REFLECT: `reflect(${a}, nd_safe_normalize(${b}))`,
    REFRACT: `refract(${a}, nd_safe_normalize(${b}), ${s})`,
    FACEFORWARD: `faceforward(${a}, ${b}, ${c})`,
    SCALE: `${a} * ${s}`,
    NORMALIZE: `nd_safe_normalize(${a})`,
    ABSOLUTE: `abs(${a})`,
    POWER: `nd_safe_pow(${a}, ${b})`,
    SIGN: `sign(${a})`,
    MINIMUM: `min(${a}, ${b})`,
    MAXIMUM: `max(${a}, ${b})`,
    FLOOR: `floor(${a})`,
    CEIL: `ceil(${a})`,
    FRACTION: `${a} - floor(${a})`,
    MODULO: `nd_fmod(${a}, ${b})`,
    WRAP: `nd_wrap(${a}, ${b}, ${c})`,
    SNAP: `nd_snap(${a}, ${b})`,
    SINE: `sin(${a})`,
    COSINE: `cos(${a})`,
    TANGENT: `tan(${a})`,
  };
  const fOps: Record<string, string> = {
    DOT_PRODUCT: `dot(${a}, ${b})`,
    DISTANCE: `distance(${a}, ${b})`,
    LENGTH: `length(${a})`,
  };
  if (fOps[op]) g.out('Value', 'float', fOps[op]);
  else g.out('Vector', 'vec3', vecOps[op] ?? `${a} + ${b}`);
});
registerGenerator('ShaderNodeCombineXYZ', (g) => g.out('Vector', 'vec3', `vec3(${g.in('X', 'float')}, ${g.in('Y', 'float')}, ${g.in('Z', 'float')})`));
registerGenerator('ShaderNodeSeparateXYZ', (g) => {
  const v = g.tmp('vec3', g.in('Vector', 'vec3'));
  g.out('X', 'float', `${v}.x`);
  g.out('Y', 'float', `${v}.y`);
  g.out('Z', 'float', `${v}.z`);
});
registerGenerator('ShaderNodeMapping', (g) => {
  const t = g.str('vector_type') || 'POINT';
  const v = g.tmp('vec3', g.in('Vector', 'vec3'));
  const R = g.tmp('mat3', `nd_euler_xyz(${g.in('Rotation', 'vec3')})`);
  const S = g.tmp('vec3', g.in('Scale', 'vec3'));
  if (t === 'POINT') g.out('Vector', 'vec3', `${R} * (${v} * ${S}) + ${g.in('Location', 'vec3')}`);
  else if (t === 'TEXTURE') g.out('Vector', 'vec3', `nd_safe_div(transpose(${R}) * (${v} - ${g.in('Location', 'vec3')}), ${S})`);
  else if (t === 'VECTOR') g.out('Vector', 'vec3', `${R} * (${v} * ${S})`);
  else g.out('Vector', 'vec3', `nd_safe_normalize(${R} * nd_safe_div(${v}, ${S}))`);
});
registerGenerator('ShaderNodeNormal', (g) => {
  const n = (g.node.props['outputs.Normal'] as number[] | undefined) ?? [0, 0, 1];
  const nn = g.uniform('vec3', n);
  g.out('Normal', 'vec3', `nd_safe_normalize(${nn})`);
  g.out('Dot', 'float', `dot(nd_safe_normalize(${nn}), nd_safe_normalize(${g.in('Normal', 'vec3')}))`);
});
registerGenerator('ShaderNodeVectorRotate', (g) => {
  const t = g.str('rotation_type') || 'AXIS_ANGLE';
  const inv = g.prop('invert') ? -1 : 1;
  const v = g.tmp('vec3', g.in('Vector', 'vec3'));
  const c = g.tmp('vec3', g.in('Center', 'vec3'));
  if (t === 'EULER_XYZ') {
    const R = g.tmp('mat3', `nd_euler_xyz(${g.in('Rotation', 'vec3')})`);
    g.out('Vector', 'vec3', `${inv < 0 ? `transpose(${R})` : R} * (${v} - ${c}) + ${c}`);
    return;
  }
  const axis = t === 'X_AXIS' ? 'vec3(1.0, 0.0, 0.0)' : t === 'Y_AXIS' ? 'vec3(0.0, 1.0, 0.0)' : t === 'Z_AXIS' ? 'vec3(0.0, 0.0, 1.0)' : g.in('Axis', 'vec3');
  g.out('Vector', 'vec3', `nd_axis_angle(${v} - ${c}, ${axis}, ${inv < 0 ? '-' : ''}${g.in('Angle', 'float')}) + ${c}`);
});
registerGenerator('ShaderNodeVectorTransform', (g) => {
  const v = g.tmp('vec3', g.in('Vector', 'vec3'));
  const from = g.str('convert_from') || 'WORLD',
    to = g.str('convert_to') || 'OBJECT',
    type = g.str('vector_type') || 'VECTOR';
  if (g.target === 'WORLD' || from === to) {
    g.out('Vector', 'vec3', v);
    return;
  }
  // matrices to/from world: object = modelMatrix, camera = flipped view matrix (+Z forward)
  const toWorld: Record<string, string> = {
    OBJECT: 'modelMatrix',
    CAMERA: 'inverse(mat4(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 1.0) * viewMatrix)',
    WORLD: 'mat4(1.0)',
  };
  const fromWorld: Record<string, string> = {
    OBJECT: 'inverse(modelMatrix)',
    CAMERA: '(mat4(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 1.0) * viewMatrix)',
    WORLD: 'mat4(1.0)',
  };
  const M = g.tmp('mat4', `${fromWorld[to]} * ${toWorld[from]}`);
  if (type === 'POINT') g.out('Vector', 'vec3', `(${M} * vec4(${v}, 1.0)).xyz`);
  else if (type === 'NORMAL') g.out('Vector', 'vec3', `nd_safe_normalize(transpose(inverse(mat3(${M}))) * ${v})`);
  else g.out('Vector', 'vec3', `mat3(${M}) * ${v}`);
});
registerGenerator('ShaderNodeSqueeze', (g) => g.out('Value', 'float', `1.0 / (1.0 + exp(-((${g.in('Value', 'float')} - ${g.in('Center', 'float')}) * ${g.in('Width', 'float')})))`));
