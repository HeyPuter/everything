// The main-thread engine facade without Web Audio (jsdom): graceful failure,
// the fallback transport clock and the documented API surface.
import { describe, it, expect } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { Store } from '../src/model/store.js';
import { Prefs } from '../src/lib/prefs.js';
import { newProject, demoProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';
import { createMixerTrack } from '../src/model/project.js';

const mem = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
};

describe('engine facade', () => {
  it('reports why audio is unavailable once and keeps the clock running', async () => {
    const store = new Store(newProject());
    const engine = new Engine(store, new Prefs(mem()));
    const errors = [];
    engine.on('error', (e) => errors.push(e.message));
    const states = [];
    engine.on('state', () => states.push(engine.playing));
    await engine.play();
    expect(engine.playing).toBe(true);
    expect(engine.ready).toBe(false);
    expect(engine.unavailable).toMatch(/unavailable/);
    expect(errors.length).toBe(1);
    expect(await engine.start()).toBe(false);
    expect(errors.length).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.position).toBeGreaterThan(0);
    expect(engine.position).toBeLessThan(engine.range().end);
    engine.seek(96);
    expect(engine.position).toBeGreaterThanOrEqual(96);
    engine.stop();
    expect(engine.position).toBe(0);
    expect(states).toContain(true);
    // Live notes and auditions are ignored without audio.
    engine.noteOn(store.project.channels[0].id, 60, 1);
    engine.noteOff(store.project.channels[0].id, 60);
    expect(typeof engine.audition({ type: 'drum', params: {} }, 60, 1)).toBe('function');
  });

  it('follows the mode, the project and a growing mixer', () => {
    const store = new Store(demoProject());
    const engine = new Engine(store, new Prefs(mem()));
    engine.mode = 'song';
    expect(engine.mode).toBe('song');
    expect(engine.range()).toEqual({ start: 0, end: 384 * 8 });
    store.apply('Add insert', (p) => ({ ...p, mixer: [...p.mixer, createMixerTrack(p.mixer.length)] }));
    store.apply('Mute', (p) => E.updateMixerTrack(p, 1, { mute: true }));
    store.load(newProject());
    expect(engine.playing).toBe(false);
    expect(engine.meters.length).toBeGreaterThanOrEqual(store.project.mixer.length * 2);
  });

  it('rejects an already aborted render', async () => {
    const engine = new Engine(new Store(newProject()), new Prefs(mem()));
    const ac = new AbortController();
    ac.abort();
    await expect(engine.render({ signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
