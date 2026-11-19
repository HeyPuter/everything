import { beforeAll, expect, it } from 'vitest';

function fakeContext() {
  return new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

async function makeView() {
  const { App } = await import('../src/app.js');
  const { installCore } = await import('../src/features/core.js');
  const { AudioFile } = await import('../src/model/audio-file.js');
  const { Channel } = await import('../src/audio/channel.js');
  const { WaveformView } = await import('../src/editor/waveform-view.js');
  HTMLCanvasElement.prototype.getContext = (type) => (type === '2d' ? fakeContext() : null);
  localStorage.clear();
  const app = new App();
  installCore(app);
  app.syncGraph = () => {};
  const doc = new AudioFile({ name: 'r.wav', sampleRate: 48000, channels: [0, 1].map(() => Channel.fromSamples(new Float32Array(48000))) });
  app.addDocument(doc);
  const view = new WaveformView(app, doc);
  document.body.replaceChildren(view.el);
  view.layout();
  view.width = 400;
  view.height = 200;
  view.waveHeight = 200;
  view.frame();
  app.currentView = () => view;
  return { app, doc, view };
}

function drag(view, y, x = 100) {
  const s = view.surface;
  s.setPointerCapture = () => {};
  const ev = (type, x) => Object.defineProperty(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }), 'pointerId', { value: 1 });
  s.dispatchEvent(ev('pointerdown', x));
  s.dispatchEvent(ev('pointermove', x + 100));
  s.dispatchEvent(ev('pointerup', x + 100));
}

it('selects one channel from the top of the waveform unless the preference is off', async () => {
  const { app, doc, view } = await makeView();
  const top = view.lanes()[0].top + 2;
  drag(view, top);
  expect(doc.selection.channels).toEqual([true, false]);
  app.prefs.set('channelZones', false);
  doc.setSelection(0, 0);
  // Away from the first drag, so it is not taken for a double-click.
  drag(view, top, 250);
  expect(doc.selection.end).toBeGreaterThan(doc.selection.start);
  expect(doc.selection.channels).toEqual([true, true]);
});
