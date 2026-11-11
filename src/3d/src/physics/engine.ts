// Physics evaluation core (no UI): registers the simulation modifiers and the
// depsgraph pre-evaluation hook that steps rigid bodies.
import { preEvaluateHooks } from '../eval/depsgraph';
import { setPhysicsDoc } from './state';
import { rigidBodyHook } from './rigidbody';
import './cloth';
import './particles';
import './fluid';

preEvaluateHooks.push((graph, doc) => {
  setPhysicsDoc(doc);
  rigidBodyHook(graph, doc);
});

export { loadRapier, rapierReady, rapierFailed, rapierLoaded } from './rigidbody';
