// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { Camera } from '../src/render/camera.js';

const records = [];
vi.mock('../src/io/storage.js', () => ({
  recovery: {
    getSession: async () => ({ docs: records.map((r) => r.id), active: records.at(-1)?.id }),
    all: async () => records,
    delete: async () => {},
    put: async () => true,
    setSession: async () => {},
  },
}));
const { App } = await import('../src/app.js');

const FIT = { cx: 500, cy: 500, scale: 0.4 };
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** A minimal App whose canvas is already sized. */
function fakeApp() {
  const app = Object.create(App.prototype);
  Object.assign(app, { docs: [], doc: null, _sized: true, _autosaveTimers: new Map(), _autosaving: new Set(), ownsSession: true });
  app.camera = new Camera();
  app.camera.width = 800;
  app.camera.height = 600;
  app.renderer = { setDrawing() {} };
  app.shell = { emptyState: {} };
  app.editor = { busy: false, attach() {}, zoomExtents: () => (app.camera.state = { ...FIT }) };
  app.refreshAll = () => {};
  app.saveSession = () => {};
  return app;
}

function record(id, view) {
  const d = new Drawing();
  d.transaction('add', () => d.add({ layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1, type: 'line', x1: 0, y1: 0, x2: 1000, y2: 1000 }));
  const json = JSON.stringify({ format: 'cad-drawing', ...d.toJSON() });
  return { id, name: id, file: null, data: { arrayBuffer: async () => new TextEncoder().encode(json).buffer }, view, modified: false };
}

describe('views of restored and new drawings', () => {
  it('keeps the views saved in recovery copies', async () => {
    records.length = 0;
    const vA = { cx: 1, cy: 2, scale: 30 };
    const vB = { cx: 3, cy: 4, scale: 50 };
    records.push(record('A', vA), record('B', vB));
    const app = fakeApp();
    await app.restoreSession();
    await frame();
    expect(app.doc.name).toBe('B');
    expect(app.camera.state).toEqual(vB);
    expect(app.doc.view).toEqual(vB);
    app.activate(app.docs[0]);
    expect(app.camera.state).toEqual(vA);
  });
  it('zooms to the extents of a restored drawing without a saved view', async () => {
    records.length = 0;
    records.push(record('A', null));
    const app = fakeApp();
    await app.restoreSession();
    await frame();
    expect(app.camera.state).toEqual(FIT);
    expect(app.doc.view).toEqual(FIT);
  });
  it('zooms a drawing to its extents when it is first shown', async () => {
    const app = fakeApp();
    const a = app.addDoc(new Drawing(), 'A');
    app.zoomExtentsSoon(a);
    const b = app.addDoc(new Drawing(), 'B'); // opened before the first frame
    await frame();
    expect(app.doc).toBe(b);
    expect(b.view).toEqual(FIT);
    app.camera.state = { cx: 9, cy: 9, scale: 9 };
    app.activate(a);
    await frame();
    expect(a.view).toEqual(FIT);
  });
});
