import { expect, it, vi } from 'vitest';
import { layer, newDocument } from '../src/model/document';

// The merged image the retouching tools sample is cached; closing its
// document frees it instead of keeping a canvas-sized image around.
vi.mock('../src/features/pixels', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  compositeRGBA: vi.fn(async (e: { doc: { width: number; height: number } }) => ({
    width: e.doc.width,
    height: e.doc.height,
    data: new Uint8ClampedArray(e.doc.width * e.doc.height * 4),
  })),
}));

it('forgets the merged image of a closed document', async () => {
  const { mergedImage } = await import('../src/features/retouch/source');
  const { compositeRGBA } = await import('../src/features/pixels');
  const doc = newDocument(8, 6, 'Doc');
  doc.layers.push(layer('solid', 'Fill', 8, 6));
  const closeHooks: ((s: { id: string }) => void)[] = [];
  const session = { id: 'session-1' };
  const e = { doc, session, closeHooks } as never;
  const first = await mergedImage(e);
  expect(await mergedImage(e)).toBe(first);
  for (const hook of closeHooks) hook({ id: 'session-2' });
  expect(await mergedImage(e)).toBe(first);
  for (const hook of closeHooks) hook(session);
  expect(await mergedImage(e)).not.toBe(first);
  expect(compositeRGBA).toHaveBeenCalledTimes(2);
  expect(closeHooks).toHaveLength(1);
});
