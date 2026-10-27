import { describe, expect, it } from 'vitest';
import {
  composeServices,
  createDemoEngine,
  requestLocalBridge,
  runningCount,
  startContainer,
  stopContainer,
} from '../src/engine/docker.js';

describe('container studio engine', () => {
  it('seeds demo resources and labels demo mode', () => {
    const e = createDemoEngine();
    expect(e.mode).toBe('demo');
    expect(e.notice).toMatch(/DEMO/);
    expect(e.containers.length).toBeGreaterThan(0);
  });

  it('starts and stops containers', () => {
    let e = createDemoEngine();
    e = stopContainer(e, 'c1');
    expect(e.containers.find((c) => c.id === 'c1')?.status).toBe('exited');
    e = startContainer(e, 'c1');
    expect(runningCount(e)).toBeGreaterThanOrEqual(2);
  });

  it('lists compose services', () => {
    expect(composeServices(createDemoEngine(), 'stack')).toEqual(['web', 'api', 'db']);
  });

  it('keeps demo when local bridge unavailable; can simulate bridge in tests', () => {
    let e = requestLocalBridge(createDemoEngine());
    expect(e.mode).toBe('demo');
    expect(e.bridgeAvailable).toBe(false);
    e = requestLocalBridge(e, { simulateAvailable: true });
    expect(e.mode).toBe('local-bridge');
    expect(e.bridgeAvailable).toBe(true);
  });
});
