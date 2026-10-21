// Ocean ▸ Bake and Explode ▸ Refresh. object.ocean_bake computes the ocean fields of every frame
// in the modifier's bake range (following its animated time), with foam building up and fading over
// time. The baked frames stay in memory; the modifier shows them while it is marked cached.
import { app, registerOperators } from '../app/app';
import type { ModifierBase } from '../data/types';
import { bakeOcean, oceanBakeKey, oceanBakes, oceanParams } from '../eval/mods/ocean';
import { freeCache } from './common';
import { particleCacheKey } from './particles';

type Rec = Record<string, unknown>;

function oceanMod(name: string): { obId: string; mod: ModifierBase } | null {
  const ob = app.activeObject;
  if (!ob) return null;
  const mod = ob.modifiers.find((m) => m.type === 'OCEAN' && (!name || m.name === name));
  return mod ? { obId: ob.id, mod } : null;
}

registerOperators([
  {
    idname: 'object.ocean_bake',
    label: 'Bake Ocean',
    description: 'Bake the ocean surface (and its foam over time) for the bake frame range',
    props: [
      { id: 'modifier', label: 'Modifier', type: 'string', default: '', hidden: true },
      { id: 'free', label: 'Free', type: 'bool', default: false },
    ],
    redo: false,
    poll: () => !!oceanMod(''),
    exec: (ctx, p) => {
      const t = oceanMod(String(p.modifier ?? ''));
      if (!t) return 'CANCELLED';
      const r = t.mod as unknown as Rec;
      const key = `${t.obId}:${t.mod.id}`;
      if (p.free) {
        oceanBakes.delete(key);
        r.is_cached = false;
        app.changed('frame');
        return 'FINISHED';
      }
      const start = Math.round((r.frame_start as number) ?? 1),
        end = Math.max(start, Math.round((r.frame_end as number) ?? 250));
      const doc = ctx.doc;
      const cur = doc.scene.frame_current,
        sub = doc.scene.frame_subframe;
      const t0 = performance.now();
      let bake;
      try {
        bake = bakeOcean(
          (f) => {
            // evaluate the scene at f so an animated time (or other animated settings) applies
            doc.scene.frame_current = f;
            doc.scene.frame_subframe = 0;
            app.graph.evaluate(doc);
            const live = doc.objects[t.obId]?.modifiers.find((m) => m.id === t.mod.id) ?? t.mod;
            return oceanParams(live, true);
          },
          start,
          end,
          Math.max(0, Math.min(1, (r.bake_foam_fade as number) ?? 0.98)),
          oceanBakeKey(t.mod, true),
        );
      } finally {
        doc.scene.frame_current = cur;
        doc.scene.frame_subframe = sub;
      }
      oceanBakes.set(key, bake);
      r.is_cached = true;
      app.report('INFO', `Baked the ocean: ${bake.frames.size} frames in ${((performance.now() - t0) / 1000).toFixed(2)} s`);
      app.changed('frame');
    },
  },
]);

// Explode ▸ Refresh: simulate the particles carrying the faces again
registerOperators([
  {
    idname: 'object.explode_refresh',
    label: 'Explode Refresh',
    description: 'Simulate the particle system driving the Explode modifier again',
    props: [{ id: 'modifier', label: 'Modifier', type: 'string', default: '', hidden: true }],
    poll: () => !!app.activeObject?.modifiers.some((m) => m.type === 'EXPLODE'),
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      const i = ob.modifiers.findIndex((m) => m.type === 'EXPLODE' && (!p.modifier || m.name === p.modifier));
      if (i < 0) return 'CANCELLED';
      // the particle system above the modifier
      const pm = ob.modifiers.slice(0, i).find((m) => m.type === 'PARTICLE_SYSTEM');
      if (!pm) {
        app.report('ERROR', 'The Explode modifier needs a particle system above it');
        return 'CANCELLED';
      }
      freeCache(particleCacheKey(ob, pm));
      app.changed('frame');
    },
  },
]);
