// Object ▸ Quick Effects ▸ Quick Explode: the selected meshes break into pieces that fly apart,
// driven by a particle system and an Explode modifier (available when the modifier is registered).
import { app, registerOperators, type OpContext } from '../app/app';
import { uid } from '../data/defaults';
import { modifierTypes, newModifier } from '../eval/modifiers';
import { defaultParticleSettings, defaultPointCache, type ObjectPhysics, type ParticleSystemX } from './types';

const meshes = () => app.selectedObjects().filter((o) => o.type === 'MESH');

registerOperators([
  {
    idname: 'object.quick_explode',
    label: 'Quick Explode',
    description: 'Break the selected meshes into pieces that fly apart',
    props: [
      { id: 'amount', label: 'Number of Pieces', type: 'int', default: 100, min: 2, max: 10000 },
      { id: 'frame_duration', label: 'Duration', type: 'int', default: 50, min: 1, max: 300000 },
      { id: 'frame_start', label: 'Start Frame', type: 'int', default: 1, min: 1, max: 300000 },
      { id: 'frame_end', label: 'End Frame', type: 'int', default: 10, min: 1, max: 300000 },
      { id: 'velocity', label: 'Outwards Velocity', type: 'float', default: 1, min: 0, max: 300000, softMax: 10 },
    ],
    poll: (ctx: OpContext) => ctx.doc.mode === 'OBJECT' && meshes().length > 0 && !!modifierTypes.EXPLODE,
    exec: (ctx, p) => {
      const doc = ctx.doc;
      for (const o of meshes()) {
        const ob = o as ObjectPhysics;
        let name = 'Explode';
        for (let i = 1; Object.values(doc.particles).some((x) => x.name === name); i++) name = `Explode.${String(i).padStart(3, '0')}`;
        const s = defaultParticleSettings(uid('pa'), name);
        const start = p.frame_start as number;
        Object.assign(s, {
          count: p.amount as number,
          frame_start: start,
          frame_end: Math.max(start, p.frame_end as number),
          lifetime: p.frame_duration as number,
          normal_factor: p.velocity as number,
          emit_from: 'FACE',
          render_type: 'NONE',
          display_method: 'NONE',
        });
        doc.particles[s.id] = s;
        const ps: ParticleSystemX & { id: string } = { name, settings: s.id, seed: ob.particle_systems.length, id: uid('psys'), point_cache: defaultPointCache(doc.scene.frame_start, doc.scene.frame_end) };
        ob.particle_systems = [...ob.particle_systems, ps];
        const pm = newModifier('PARTICLE_SYSTEM', uid('md'), ob.modifiers);
        pm.name = name;
        pm.particle_system = ps.id;
        const ex = newModifier('EXPLODE', uid('md'), [...ob.modifiers, pm]);
        ob.modifiers = [...ob.modifiers, pm, ex];
        ob.active_particle_system_index = ob.particle_systems.length - 1;
      }
    },
  },
]);
