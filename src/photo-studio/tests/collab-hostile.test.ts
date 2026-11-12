// Hostile or malformed shared state from another person must never stop a
// browser from showing the shared document.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { newDocument, findLayer, type PhotoDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { Assets } from '../src/model/assets';
import { validateDocument } from '../src/model/serialization';
import { SharedProject, ORIGIN } from '../src/collab/shared-project';
import { TileIndex } from '../src/collab/tile-index';

function participant() {
  const assets = new Assets();
  const tiles = new TileIndex(assets.tiles);
  return { assets, tiles, project: new SharedProject(tiles) };
}
async function setup() {
  const a = participant();
  const doc: PhotoDocument = newDocument(600, 400);
  const bg = newPixelLayer('Background', doc);
  const top = newPixelLayer('Top', doc);
  doc.layers = [bg, top];
  a.project.write(null, doc, await a.project.prepare(doc, a.assets));
  return { a, ids: { bg: bg.id, top: top.id } };
}

describe('malformed shared layers from another person', () => {
  const cases: [string, (m: Y.Map<unknown>, doc: Y.Map<unknown>) => void][] = [
    ['a tile grid with an invalid channel count', (m) => m.set('g:pixels', { channels: 3, x: 0, y: 0 })],
    ['a tile grid placement that is not an object', (m) => m.set('g:pixels', null)],
    ['a tile key of another shape', (m) => (m.get('t:pixels') as Y.Map<string>).set('nope', 'x')],
    ['a deeply nested property', (m) => {
      let v: unknown = 1;
      for (let i = 0; i < 80; i++) v = [v];
      m.set('p:name', v);
    }],
    ['an embedded grid reference that is invalid', (m) => m.set('p:style', { $grid: 1, channels: 2, x: 0, y: 0, tiles: {} })],
  ];
  for (const [what, edit] of cases)
    it(`leave out only that layer: ${what}`, async () => {
      const { a, ids } = await setup();
      a.project.project({ selection: null });
      a.project.ydoc.transact(() => edit(a.project.layers.get(ids.top)!, a.project.doc), ORIGIN.remote);
      const result = a.project.project({ selection: null });
      expect(() => validateDocument(result.document)).not.toThrow();
      expect(findLayer(result.document.layers, ids.bg)).toBeTruthy();
      expect(findLayer(result.document.layers, ids.top)).toBeUndefined();
      expect(result.dropped.length).toBe(1);
    });
  it('leave out a document setting holding an invalid grid reference', async () => {
    const { a, ids } = await setup();
    a.project.ydoc.transact(() => a.project.doc.set('patterns', { $grid: 1, channels: 9, x: 0, y: 0, tiles: {} }), ORIGIN.remote);
    const result = a.project.project({ selection: null });
    expect(findLayer(result.document.layers, ids.top)).toBeTruthy();
    expect(result.dropped.join()).toContain('patterns');
  });
});
