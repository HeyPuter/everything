// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Drawing } from '../src/core/drawing.js';

vi.mock('../src/io/storage.js', () => ({ recovery: {}, errorText: () => '', addRecent: () => {} }));
const { App } = await import('../src/app.js');

async function open(data) {
  const app = Object.create(App.prototype);
  const log = [];
  Object.assign(app, { docs: [], cmdline: { log: (t) => log.push(t) }, zoomExtentsSoon() {} });
  app.addDoc = vi.fn((drawing, name, file) => ({ drawing, name, file }));
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const doc = await app.openBuffer(bytes, 'plan.cad', { source: 'cloud', path: '/u/plan.cad' });
  return { doc, log };
}

describe('a .cad file written by a newer version of the app', () => {
  const file = { format: 'cad-drawing', ...new Drawing().toJSON() };

  it('opens with a warning', async () => {
    const { doc, log } = await open({ ...file, version: file.version + 1, views: [{ name: 'future' }] });
    expect(doc.file.dropped).toMatch(/newer version/);
    expect(log.some((t) => /newer version/.test(t))).toBe(true);
  });

  it('is not suspected of a file of this version, or one without a version', async () => {
    for (const data of [file, { ...file, version: undefined }]) {
      const { doc, log } = await open(data);
      expect(doc.file.dropped).toBeUndefined();
      expect(log.some((t) => /newer version/.test(t))).toBe(false);
    }
  });
});

describe('saving a drawing opened from a .cad file', () => {
  it('saves it as a new file instead of writing the .cad file', async () => {
    const { doc } = await open({ format: 'cad-drawing', ...new Drawing().toJSON() });
    expect(doc.file.kind).toBe('native');
    const app = Object.create(App.prototype);
    Object.assign(app, { doc });
    app.saveAs = vi.fn(async () => true);
    app.writeFile = vi.fn(async () => true);
    expect(await app.save(doc)).toBe(true);
    expect(app.saveAs).toHaveBeenCalledWith(doc);
    expect(app.writeFile).not.toHaveBeenCalled();
  });
});
