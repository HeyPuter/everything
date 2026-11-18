import { expect, it, vi } from 'vitest';
import { layer, newDocument } from '../src/model/document';

// The composite beneath an adjustment layer is cached for its editor; closing
// the document frees it instead of keeping canvas-sized images around.
vi.mock('../src/features/pixels', () => ({
  compositeRGBA: vi.fn(async (_e: unknown, doc: { width: number; height: number }) => ({
    width: doc.width,
    height: doc.height,
    data: new Uint8ClampedArray(doc.width * doc.height * 4),
  })),
}));

it('forgets the composites of a closed document', async () => {
  const { belowSource } = await import('../src/features/adjust/source');
  const { compositeRGBA } = await import('../src/features/pixels');
  const doc = newDocument(8, 6, 'Doc');
  const adj = layer('adjustment', 'Levels', 8, 6);
  doc.layers.push(layer('solid', 'Fill', 8, 6), adj);
  const closeHooks: ((s: { id: string }) => void)[] = [];
  const session = { id: 'session-1' };
  const e = { doc, session, closeHooks } as never;
  const first = belowSource(e, adj.id);
  expect(belowSource(e, adj.id)).toBe(first);
  expect(compositeRGBA).toHaveBeenCalledTimes(1);
  // Another document's close leaves it cached.
  for (const hook of closeHooks) hook({ id: 'session-2' });
  expect(belowSource(e, adj.id)).toBe(first);
  for (const hook of closeHooks) hook(session);
  expect(belowSource(e, adj.id)).not.toBe(first);
  expect(compositeRGBA).toHaveBeenCalledTimes(2);
  // The hook is registered once per editor.
  expect(closeHooks).toHaveLength(1);
});
