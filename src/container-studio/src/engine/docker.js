/**
 * Container Studio engine (original). Docker Desktop-inspired UI —
 * not Docker Inc. software. Default mode is a labeled DEMO catalog.
 * Optional “local bridge” is a documented stub that never invents LIVE access.
 */

/** @typedef {{ id:string, name:string, image:string, status:'running'|'exited'|'created', ports:string }} Container */
/** @typedef {{ id:string, repo:string, tag:string, sizeMb:number }} Image */
/** @typedef {{ name:string, driver:string, sizeMb:number }} Volume */
/** @typedef {{ name:string, services:string[] }} ComposeProject */
/** @typedef {'demo'|'local-bridge'} EngineMode */
/** @typedef {{
 *   mode:EngineMode,
 *   containers:Container[],
 *   images:Image[],
 *   volumes:Volume[],
 *   compose:ComposeProject[],
 *   bridgeAvailable:boolean,
 *   notice:string,
 * }} Engine */

/** @returns {Engine} */
export function createDemoEngine() {
  return {
    mode: 'demo',
    bridgeAvailable: false,
    notice: 'DEMO mode — simulated resources. Not connected to a LIVE Docker engine.',
    containers: [
      { id: 'c1', name: 'web', image: 'nginx:alpine', status: 'running', ports: '8080:80' },
      { id: 'c2', name: 'api', image: 'node:20-alpine', status: 'running', ports: '3000:3000' },
      { id: 'c3', name: 'db', image: 'postgres:16', status: 'exited', ports: '5432:5432' },
    ],
    images: [
      { id: 'i1', repo: 'nginx', tag: 'alpine', sizeMb: 42 },
      { id: 'i2', repo: 'node', tag: '20-alpine', sizeMb: 128 },
      { id: 'i3', repo: 'postgres', tag: '16', sizeMb: 420 },
    ],
    volumes: [
      { name: 'pgdata', driver: 'local', sizeMb: 256 },
      { name: 'cache', driver: 'local', sizeMb: 12 },
    ],
    compose: [{ name: 'stack', services: ['web', 'api', 'db'] }],
  };
}

/**
 * Attempt to switch to an authorized local engine bridge.
 * v0 always reports unavailable unless `opts.simulateAvailable` (tests).
 * @param {Engine} engine
 * @param {{ simulateAvailable?:boolean }} [opts]
 */
export function requestLocalBridge(engine, opts = {}) {
  const available = Boolean(opts.simulateAvailable);
  if (!available) {
    return {
      ...engine,
      mode: /** @type {EngineMode} */ ('demo'),
      bridgeAvailable: false,
      notice:
        'Local Docker bridge not available in this browser build. Staying in DEMO mode — no fabricated LIVE engine access.',
    };
  }
  return {
    ...engine,
    mode: /** @type {EngineMode} */ ('local-bridge'),
    bridgeAvailable: true,
    notice: 'Authorized local bridge (simulated in tests). Commands would target the user-approved Docker CLI only.',
  };
}

/** @param {Engine} engine @param {string} id */
export function startContainer(engine, id) {
  return mapContainer(engine, id, (c) => ({ ...c, status: 'running' }));
}

/** @param {Engine} engine @param {string} id */
export function stopContainer(engine, id) {
  return mapContainer(engine, id, (c) => ({ ...c, status: 'exited' }));
}

/** @param {Engine} engine */
export function runningCount(engine) {
  return engine.containers.filter((c) => c.status === 'running').length;
}

/** @param {Engine} engine @param {string} name */
export function composeServices(engine, name) {
  const project = engine.compose.find((p) => p.name === name);
  if (!project) throw new Error(`Unknown compose project: ${name}`);
  return [...project.services];
}

/** @param {Engine} engine @param {string} id @param {(c:Container)=>Container} fn */
function mapContainer(engine, id, fn) {
  const found = engine.containers.some((c) => c.id === id);
  if (!found) throw new Error(`Unknown container: ${id}`);
  return {
    ...engine,
    containers: engine.containers.map((c) => (c.id === id ? fn(c) : c)),
  };
}
