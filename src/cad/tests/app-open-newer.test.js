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

  it('opens with a warning, and Save asks before replacing it', async () => {
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
