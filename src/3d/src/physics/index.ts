// Physics subsystem entry point: simulation modifiers, rigid body world, particles,
// force fields, point caches, operators and the Physics / Particles properties tabs.
import { app } from '../app/app';
import { preEvaluateHooks } from '../eval/depsgraph';
import { rapierReady, loadRapier } from './engine';
import { simBudget, startBudget, caches } from './common';
import { freeRigidBodyLive } from './rigidbody';
import { particleDraw } from './particles';
import { smokeDraw } from './fluid';
import { physicsState } from './runtime';
import './ops';
import './ui-physics';
import './ui-particles';
import './draw';
import './timelinecache';

/** Interactive evaluations simulate at most this long, then continue on the next tick. */
const BUDGET_MS = 120;

preEvaluateHooks.unshift(() => startBudget(physicsState.baking ? Infinity : BUDGET_MS));

let pending = false;
function continueSimulation() {
  if (!simBudget.exceeded || pending) return;
  simBudget.exceeded = false;
  pending = true;
  setTimeout(() => {
    pending = false;
    app?.changed('frame');
  }, 0);
}

/** Drop caches and draw data of simulations whose object or modifier no longer exists. */
function pruneCaches() {
  const doc = app.doc;
  const alive = (ob: string, mod: string) => !!doc.objects[ob]?.modifiers.some((m) => m.id === mod);
  for (const [key, c] of caches) {
    const [kind, ob, mod] = key.split(':');
    const keep = kind === 'RIGIDBODY' ? !!doc.scene.rigidbody_world : alive(ob, mod);
    if (!keep) {
      if (kind === 'RIGIDBODY') freeRigidBodyLive();
      c.reset('');
      caches.delete(key);
    }
  }
  for (const map of [particleDraw, smokeDraw] as Map<string, unknown>[])
    for (const key of map.keys()) {
      const [ob, mod] = key.split(':');
      if (!alive(ob, mod)) map.delete(key);
    }
}

let pruneTimer = 0;
// the app is created before modules register; subscribe lazily
queueMicrotask(() => {
  app?.subscribe((kinds) => {
    continueSimulation();
    if (kinds.has('doc') && !pruneTimer)
      pruneTimer = window.setTimeout(() => {
        pruneTimer = 0;
        pruneCaches();
      }, 1000);
  });
  if (app?.doc.scene.rigidbody_world) void loadRapier();
});
rapierReady.add(() => app?.changed('frame'));
