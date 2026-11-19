// New Multitrack Session: the Mix (master) choice and mono masters.
import { describe, it, expect } from 'vitest';
import { renderBlock, ChunkStore, createScratch } from '../src/engine/mixcore.js';
import { createSessionState } from '../src/model/session-edits.js';
import { buildSessionGraph } from '../src/model/session-graph.js';

async function makeApp() {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { FEATURES } = await import('../src/features.js');
  const app = new App();
  for (const install of FEATURES) install(app);
  app.syncGraph = () => {};
  return app;
}

describe('mono master', () => {
  it('folds the mix to mono', () => {
    const store = new ChunkStore();
    store.put('s', 0, [new Float32Array(128).fill(1)]);
    const clip = { id: 'c', source: 's', channels: 1, start: 0, offset: 0, length: 128, gain: 1, fadeIn: 0, fadeOut: 0 };
    const mix = (mono) => {
      // Panned hard left.
      const graph = { rate: 48000, tracks: [{ id: 't', gain: 1, pan: -1, mute: false, solo: false, clips: [clip] }], master: { gain: 1, mono } };
      const out = [new Float32Array(128), new Float32Array(128)];
      renderBlock(graph, store, 0, 128, out, createScratch(128));
      return [out[0][10], out[1][10]];
    };
    const [l, r] = mix(false);
    expect(r).toBeCloseTo(0);
    const [ml, mr] = mix(true);
    expect(ml).toBeCloseTo((l + r) / 2);
    expect(mr).toBeCloseTo(ml);
  });

  it('marks the graph of a session with a mono master', () => {
    const state = createSessionState({ tracks: 1, masterChannels: 1 });
    expect(state.master.channels).toBe(1);
    expect(buildSessionGraph(state, new Map()).graph.master.mono).toBe(true);
    expect(buildSessionGraph(createSessionState({ tracks: 1 }), new Map()).graph.master.mono).toBeUndefined();
  });

  it('creates a session with the Mix chosen in the dialog and remembers it', async () => {
    const app = await makeApp();
    const done = app.commands.run('file.newSession');
    const dialog = [...document.querySelectorAll('.dialog')].pop();
    const mixSel = dialog.querySelector('[aria-label="Mix"]');
    expect(mixSel.disabled).toBe(false);
    mixSel.value = '1';
    dialog.querySelector('.dialog-foot .btn.primary').click();
    await done;
    await new Promise((r) => setTimeout(r, 0));
    expect(app.active.kind).toBe('session');
    expect(app.active.state.master.channels).toBe(1);
    expect(app.prefs.get('newSessionMix')).toBe(1);
  });

  it('remembers the folder chosen for the new session as the place Save offers', async () => {
    const app = await makeApp();
    window.puter = { auth: { isSignedIn: () => true }, ui: { showDirectoryPicker: async () => ({ path: '/u/Projects' }) } };
    try {
      const done = app.commands.run('file.newSession');
      const dialog = [...document.querySelectorAll('.dialog')].pop();
      expect(dialog.querySelector('.io-path').textContent).toBe('~/AudioStudio');
      [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Browse...').click();
      await new Promise((r) => setTimeout(r, 0));
      expect(dialog.querySelector('.io-path').textContent).toBe('/u/Projects');
      dialog.querySelector('.dialog-foot .btn.primary').click();
      await done;
      expect(app.prefs.get('sessionSaveFolder')).toBe('/u/Projects');
    } finally {
      delete window.puter;
    }
  });
});
