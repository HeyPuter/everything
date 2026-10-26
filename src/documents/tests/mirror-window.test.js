// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';

// The second window (View → New Window) shows the document the original window broadcasts after each
// change. Opening one copy can take longer than the next.
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const opens = [];
vi.mock('../src/lib/engine.js', () => ({
  loadEngine: async () => ({
    openCanvasDocument: () => { const d = deferred(); opens.push(d); return d.promise; },
    loadCanvasFonts: async () => {},
    CanvasEditor: class { setZoom() {} destroy() {} },
  }),
}));
vi.mock('../src/styles/index.css', () => ({}));

it('an older update that fails does not replace the status of a newer one that was shown', async () => {
  let channel;
  vi.stubGlobal('BroadcastChannel', class { constructor() { channel = this; } postMessage() {} });
  document.body.innerHTML = '<div id="app"></div>';
  location.hash = '#window-1';
  await import('../src/mirror.js');
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const status = document.querySelector('.mirror-status');
  channel.onmessage({ data: { type: 'document', name: 'Plan', bytes: new Uint8Array([1]) } });
  channel.onmessage({ data: { type: 'document', name: 'Plan', bytes: new Uint8Array([2]) } });
  await settle();
  expect(opens).toHaveLength(2);
  opens[1].resolve({ pkg: {}, images: new Map(), measure: null });
  await settle();
  expect(status.textContent).toMatch(/^Updated /);
  opens[0].reject(new Error('The document could not be read.'));
  await settle();
  expect(status.textContent).toMatch(/^Updated /);
  vi.unstubAllGlobals();
});
