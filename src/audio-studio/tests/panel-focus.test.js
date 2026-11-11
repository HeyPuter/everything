// Docked panels that rebuild their rows keep keyboard focus on the same item.
import { describe, it, expect, beforeAll } from 'vitest';
import { Session } from '../src/model/session.js';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

async function appWithSession() {
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { installCore } = await import('../src/features/core.js');
  const { installMultitrack } = await import('../src/features/multitrack.js');
  const { visibilityCommands } = await import('../src/multitrack/visibility.js');
  const app = new App();
  installCore(app);
  installMultitrack(app);
  app.commands.register(visibilityCommands(app));
  app.syncGraph = () => {};
  const doc = new Session({ name: 'Test.asesx', sampleRate: 48000, tracks: 3 });
  app.addDocument(doc);
  return { app, doc };
}

describe('Tracks panel', () => {
  it('keeps focus on a track after Space hides it', async () => {
    const { app, doc } = await appWithSession();
    const { tracksPanel } = await import('../src/panels/tracks.js');
    const panel = tracksPanel(app);
    document.body.replaceChildren(panel.el);
    const id = doc.state.tracks[1].id;
    const row = () => panel.el.querySelector(`.track-row[data-id="${id}"]`);
    row().click();
    expect(document.activeElement).toBe(row());
    row().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(doc.state.tracks[1].hidden).toBe(true);
    await new Promise((r) => requestAnimationFrame(r));
    expect(row().classList.contains('hidden-track')).toBe(true);
    expect(document.activeElement).toBe(row());
  });
});
