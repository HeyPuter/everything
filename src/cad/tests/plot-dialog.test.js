// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { SpatialIndex } from '../src/core/spatial.js';
import { plotDialog } from '../src/ui/dialogs.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
  // A 2D context that draws nothing, for the preview.
  HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy({ canvas: this }, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
  };
});
afterEach(() => {
  document.querySelectorAll('dialog').forEach((x) => x.remove());
  localStorage.clear();
});

const wait = () => new Promise((r) => setTimeout(r, 60));
const base = { color: 256, linetype: 'ByLayer', lineweight: -1, layer: '0' };

function plotApp() {
  const d = new Drawing();
  d.transaction('s', () => {
    d.add({ ...base, type: 'line', x1: 0, y1: 0, x2: 1000, y2: 0 });
    d.add({ ...base, type: 'line', x1: 0, y1: 0, x2: 0, y2: 500 });
  });
  const index = new SpatialIndex(d);
  d.on((c) => index.applyChange(c));
  return { doc: { drawing: d, index, name: 'T' }, camera: { bounds: () => [0, 0, 1000, 500] }, editor: {} };
}

/** Open the plot dialog, read the area select and scale hint, and cancel. */
async function open(app, state) {
  const p = plotDialog(app, state);
  await wait();
  const dlg = document.querySelector('dialog[open]');
  const area = dlg.querySelectorAll('select')[2].value;
  const scale = [...dlg.querySelectorAll('.field-hint')].find((x) => /Scale/.test(x.textContent)).textContent;
  [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel').click();
  await p;
  return { area, scale };
}

describe('plot dialog area', () => {
  it('falls back to Extents when Window is remembered but this drawing has no window', async () => {
    const app = plotApp();
    const extents = await open(app);
    await open(app, { areaMode: 'window', window: [0, 0, 10, 10] });
    expect(await open(app)).toEqual({ area: 'extents', scale: extents.scale });
  });
  it("reuses the drawing's last plot window", async () => {
    const app = plotApp();
    const extents = await open(app);
    app.doc.plotWindow = [0, 0, 10, 10];
    const win = await open(app, { areaMode: 'window' });
    expect(win.area).toBe('window');
    expect(win.scale).not.toBe(extents.scale);
    expect(await open(app)).toEqual(win);
  });
});
