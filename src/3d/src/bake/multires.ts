// Bake from Multires (object.bake_image): the detail of a Multiresolution modifier's highest level
// stored as a tangent-space normal map or a displacement map for the mesh at its preview level.
// Every level subdivides the same base mesh, so the levels share their UV layout: both are
// rasterized in texture space and compared texel by texel (no ray casting needed).
import { app, registerOperators } from '../app/app';
import { renderContext } from '../render/context';
import { baseEvalMesh } from '../eval/depsgraph';
import { multiresAtLevel, displacedTop, multiresTotal } from '../eval/mods/multires';
import { readPixels, writePixels } from '../render/final/imageops';
import type { ModifierBase, ObjectData } from '../data/types';
import { planTargets } from './targets';
import { bakeSettings } from './settings';
import { imageSurface, bakeState } from './job';
import { newBuffer, BAKED, toTangentSpace, encodeUnit, extendMargin, adjacentFacesMargin, seamEdges, composite, storeBytes, type BakeBuffer } from './encode';

/** The first enabled Multiresolution modifier with detail levels. */
export function multiresModifier(ob: ObjectData): ModifierBase | null {
  const m = (ob.modifiers ?? []).find((x) => x.type === 'MULTIRES' && x.show_viewport !== false);
  return m && multiresTotal(m) > 0 ? m : null;
}

export interface MultiresOutcome {
  ok: boolean;
  message: string;
}

/** Bake every selected object with a multires modifier (synchronous: rasterization only). */
export function bakeMultires(): MultiresOutcome {
  if (!renderContext) return { ok: false, message: 'Baking needs the 3D renderer' };
  const renderer = renderContext.engine.renderer;
  const doc = app.doc;
  const b = bakeSettings(doc.scene.render);
  const obs = app.selectedObjects().filter((o) => o.type === 'MESH');
  if (!obs.length) return { ok: false, message: 'Select the mesh objects to bake' };
  const without = obs.filter((o) => !multiresModifier(o));
  if (without.length) return { ok: false, message: `"${without[0].name}" has no Multiresolution modifier with subdivision levels` };
  const plan = planTargets(doc, obs, 'IMAGE_TEXTURES');
  if (plan.errors.length) return { ok: false, message: plan.errors.join('; ') };
  app.evaluate();
  const accum = new Map<string, BakeBuffer>();
  let lo = Infinity,
    hi = -Infinity;
  for (const t of plan.targets) {
    const ob = t.object;
    const mod = multiresModifier(ob)!;
    const world = app.graph.get(ob.id)?.world;
    const me = doc.meshes[ob.data!];
    if (!world) continue;
    const base = baseEvalMesh(me);
    const level = b.type === 'DISPLACEMENT' && b.use_lores_mesh ? 0 : Math.round(Number(mod.levels ?? 0));
    const low = multiresAtLevel(base, mod, level);
    const high = displacedTop(base, mod);
    const img = doc.images[t.image!];
    const pixels = readPixels(img);
    if (!pixels) return { ok: false, message: `Image "${img.name}" is still loading` };
    const W = pixels.width,
      H = pixels.height;
    const ls = imageSurface(renderer, { mesh: low, world }, t.slots, W, H, null);
    const hs = imageSurface(renderer, { mesh: high, world }, t.slots, W, H, null);
    const out = newBuffer(W, H);
    for (let i = 0; i < W * H; i++) {
      if (!ls.covered[i] || !hs.covered[i]) continue;
      const k = i * 4;
      if (b.type === 'NORMALS') {
        out.data.set(encodeUnit(toTangentSpace(hs.N.subarray(k, k + 3), ls.T.subarray(k, k + 3), ls.B.subarray(k, k + 3), ls.N.subarray(k, k + 3))), k);
      } else {
        const d = (hs.P[k] - ls.P[k]) * ls.N[k] + (hs.P[k + 1] - ls.P[k + 1]) * ls.N[k + 1] + (hs.P[k + 2] - ls.P[k + 2]) * ls.N[k + 2];
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
        // the Displacement node's default mid level (0.5) and scale (1)
        out.data.set([0.5 + d, 0.5 + d, 0.5 + d], k);
      }
      out.data[k + 3] = 1;
      out.mask[i] = BAKED;
    }
    if (b.margin > 0) {
      if (b.margin_type === 'ADJACENT_FACES') {
        const slots = new Set(t.slots);
        adjacentFacesMargin(out, b.margin, seamEdges(low, W, H, (f) => slots.has(low.material_index?.[f] ?? 0)));
      } else extendMargin(out, b.margin);
    }
    const acc = accum.get(t.image!);
    if (acc) composite(acc, out);
    else accum.set(t.image!, out);
  }
  const clear: [number, number, number, number] = b.type === 'NORMALS' ? [0.5, 0.5, 1, 1] : [0.5, 0.5, 0.5, 1];
  for (const [id, buf] of accum) {
    const img = doc.images[id];
    const prev = readPixels(img);
    const bytes = storeBytes(buf, prev?.data ?? null, { srgb: img.colorspace === 'sRGB', clear: b.use_clear ? clear : null });
    writePixels(img, new ImageData(bytes as Uint8ClampedArray<ArrayBuffer>, buf.width, buf.height));
  }
  app.changed('doc');
  const names = [...accum.keys()].map((id) => `"${doc.images[id].name}"`).join(', ');
  const range = b.type === 'DISPLACEMENT' && lo <= hi ? ` (heights ${lo.toFixed(4)} to ${hi.toFixed(4)} around 0.5)` : '';
  return { ok: true, message: `Baked multires ${b.type === 'NORMALS' ? 'normals' : 'displacement'} into ${names}${range}` };
}

registerOperators([
  {
    idname: 'object.bake_image',
    label: 'Bake',
    description: 'Bake the detail of the Multiresolution modifier into the image textures of the selected objects',
    redo: false,
    poll: (ctx) => !bakeState() && ctx.doc.mode === 'OBJECT' && app.selectedObjects().some((o) => o.type === 'MESH' && !!multiresModifier(o)),
    exec: () => {
      const r = bakeMultires();
      app.report(r.ok ? 'INFO' : 'ERROR', r.message);
      return r.ok ? 'FINISHED' : 'CANCELLED';
    },
  },
]);
