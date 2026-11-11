// Physics evaluation core (no UI): registers the simulation modifiers and the
// depsgraph pre-evaluation hook that steps rigid bodies.
import { preEvaluateHooks } from '../eval/depsgraph';
import { setPhysicsDoc } from './state';
import { rigidBodyHook } from './rigidbody';
import { cacheMemory, frameOf } from './common';
import './cloth';
import './particles';
import './fluid';

preEvaluateHooks.push((graph, doc) => {
  setPhysicsDoc(doc);
  // cached frames far from this one are dropped first when memory runs short
  cacheMemory.frame = frameOf(graph);
  rigidBodyHook(graph, doc);
});

export { loadRapier, rapierReady, rapierFailed, rapierLoaded } from './rigidbody';
