// .blend import: the scene's texture baking settings (RenderData.bake) and the path tracer's bake
// type (stored in the scene's "cycles" ID properties).
import type { BStruct } from './reader';
import type { Ctx } from './context';
import type { RenderSettings } from '../../data/types';
import { defaultBakeSettings, BAKE_TYPES, type NormalSwizzle } from '../../bake/settings';

const SWIZZLE: NormalSwizzle[] = ['POS_X', 'POS_Y', 'POS_Z', 'NEG_X', 'NEG_Y', 'NEG_Z'];
// BakeData.flag and pass_filter bits
const FLAG = { clear: 1, toActive: 4, multires: 16, lores: 32, cage: 256 };
const PASS = { emit: 2, diffuse: 4, glossy: 8, transmission: 16, direct: 64, indirect: 128, color: 256 };

/** An int ID property inside the scene's ID property group `group`. */
function sceneIntProp(sc: BStruct, group: string, key: string): number | null {
  const id = sc.sub('id');
  // registered (add-on) properties: system properties in newer files, ID properties in older ones
  const roots = (['system_properties', 'properties'] as const).map((k) => (id?.has(k) ? id.ref(k) : null));
  for (const g of roots.flatMap((root) => root?.sub('data')?.list('group') ?? [])) {
    if (g.str('name') !== group || g.num('type') !== 6) continue;
    for (const p of g.sub('data')?.list('group') ?? []) if (p.str('name') === key && p.num('type') === 1) return p.sub('data')?.num('val') ?? null;
  }
  return null;
}

export function importBakeSettings(sc: BStruct, r: RenderSettings, ctx: Ctx) {
  const bd = sc.sub('r')?.sub('bake');
  if (bd) {
    const b = defaultBakeSettings();
    const flag = bd.num('flag');
    const pass = bd.num('pass_filter');
    b.margin = bd.num('margin');
    b.margin_type = bd.num('margin_type') === 1 ? 'EXTEND' : 'ADJACENT_FACES';
    b.cage_extrusion = bd.num('cage_extrusion');
    b.max_ray_distance = bd.num('max_ray_distance');
    b.normal_space = bd.num('normal_space') === 2 ? 'OBJECT' : 'TANGENT';
    const sw = bd.nums('normal_swizzle', 3);
    [b.normal_r, b.normal_g, b.normal_b] = [0, 1, 2].map((i) => SWIZZLE[sw[i]] ?? SWIZZLE[i]) as [NormalSwizzle, NormalSwizzle, NormalSwizzle];
    b.target = bd.num('target') === 1 ? 'VERTEX_COLORS' : 'IMAGE_TEXTURES';
    b.type = bd.num('type') === 1 ? 'DISPLACEMENT' : 'NORMALS';
    b.use_clear = (flag & FLAG.clear) !== 0;
    b.use_selected_to_active = (flag & FLAG.toActive) !== 0;
    b.use_multires = (flag & FLAG.multires) !== 0;
    b.use_lores_mesh = (flag & FLAG.lores) !== 0;
    b.use_cage = (flag & FLAG.cage) !== 0;
    b.use_pass_emit = (pass & PASS.emit) !== 0;
    b.use_pass_diffuse = (pass & PASS.diffuse) !== 0;
    b.use_pass_glossy = (pass & PASS.glossy) !== 0;
    b.use_pass_transmission = (pass & PASS.transmission) !== 0;
    b.use_pass_direct = (pass & PASS.direct) !== 0;
    b.use_pass_indirect = (pass & PASS.indirect) !== 0;
    b.use_pass_color = (pass & PASS.color) !== 0;
    b.cage_object = ctx.objectRef(bd.ref('cage_object'));
    r.bake = b;
  }
  const t = sceneIntProp(sc, 'cycles', 'bake_type');
  if (t !== null && BAKE_TYPES[t]) r.bake_type = BAKE_TYPES[t][0];
}
