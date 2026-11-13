import { expect, it } from 'vitest';
import { Assets } from '../src/model/assets';
import { newDocument } from '../src/model/document';
import { applySelection } from '../src/model/selection';
import { deserialize, serialize } from '../src/model/serialization';
import { filledMask, readMask } from '../src/model/tiles';

it.each([false, true])('omits temporary selection state without changing the live document (grid: %s)', async (withGrid) => {
  const assets = new Assets();
  const doc = newDocument(16, 12);
  const rect = { x: 2, y: 3, width: 4, height: 5 };
  const grid = filledMask(assets.tiles, rect);
  if (withGrid) applySelection(doc, grid);
  else doc.selection = rect;
  doc.quickMask = grid;
  doc.channels = [{ id: 'saved', name: 'Saved selection', grid }];
  const before = structuredClone(doc);
  const loaded = await deserialize(await serialize(doc, assets));
  expect(doc).toEqual(before);
  expect(loaded.document.selection).toBeNull();
  expect(loaded.document.selectionMask).toBeUndefined();
  expect(loaded.document.quickMask).toBeUndefined();
  expect(readMask(loaded.assets.tiles, loaded.document.channels![0].grid, rect).data).toEqual(new Uint8Array(20).fill(255));
});
