import { describe, expect, it, vi } from 'vitest';
import type { Editor } from '../src/editor';
import { clearQueue, frameImage, frameKey } from '../src/features/animation/render';
import { createAnimation, duplicateFrames } from '../src/model/animation';
import { newDocument } from '../src/model/document';
import { TileStore, gridFromImage } from '../src/model/tiles';

const editor = { session: { id: 'render-test' } } as Editor;

describe('animation thumbnail keys', () => {
  it('changes after document-wide lighting changes', () => {
    const doc = newDocument(32, 32);
    doc.animation = createAnimation(doc);
    doc.globalLight = { angle: 30, altitude: 30 };
    const changed = structuredClone(doc);
    changed.globalLight!.angle = 120;
    expect(frameKey(editor, changed, 0)).not.toBe(frameKey(editor, doc, 0));
  });

  it('changes after document pattern pixels change', () => {
    const doc = newDocument(32, 32);
    doc.animation = createAnimation(doc);
    const store = new TileStore();
    const grid = (red: number) => gridFromImage(store, { width: 1, height: 1, data: new Uint8ClampedArray([red, 0, 0, 255]) });
    doc.patterns = [{ id: 'pattern', name: 'Pattern', width: 1, height: 1, grid: grid(0) }];
    const changed = structuredClone(doc);
    changed.patterns![0].grid = grid(255);
    expect(frameKey(editor, changed, 0)).not.toBe(frameKey(editor, doc, 0));
  });
});


describe('animation thumbnail queue', () => {
  it('does not clone frame documents while waiting for an editing gesture', async () => {
    const doc = newDocument(32, 32);
    doc.animation = createAnimation(doc);
    for (let i = 0; i < 12; i++) duplicateFrames(doc, [i]);
    const busyEditor = { session: { id: 'busy-test' }, busy: true } as Editor;
    vi.useFakeTimers();
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      for (let i = 0; i < doc.animation.frames.length; i++) frameImage(busyEditor, doc, i, `busy-${i}`);
      expect(clone.mock.calls.length).toBe(0);
    } finally {
      clearQueue();
      await vi.advanceTimersByTimeAsync(120);
      clone.mockRestore();
      vi.useRealTimers();
    }
  });
});
