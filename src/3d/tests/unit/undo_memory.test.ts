// The undo history counts the bytes of the buffers its steps hold incrementally; the count must match
// a full recount after every kind of change to the history.
import { describe, it, expect } from 'vitest';
import { UndoStack, UNDO_TRACKED_BYTES } from '../../src/app/undo';
import type { DocumentData } from '../../src/data/types';

const doc = (bufs: Float32Array[]) => ({ meshes: Object.fromEntries(bufs.map((b, i) => [`m${i}`, { positions: b }])) }) as unknown as DocumentData;

function recount(u: UndoStack) {
  const steps = (u as unknown as { steps: { doc: DocumentData }[] }).steps;
  const seen = new Set<ArrayBufferLike>();
  let total = 0;
  for (const st of steps)
    for (const m of Object.values((st.doc as unknown as { meshes: Record<string, { positions: Float32Array }> }).meshes))
      if (m.positions.byteLength >= UNDO_TRACKED_BYTES && !seen.has(m.positions.buffer)) (seen.add(m.positions.buffer), (total += m.positions.buffer.byteLength));
  return total;
}
const counted = (u: UndoStack) => (u as unknown as { bytes: number }).bytes;

describe('undo history memory accounting', () => {
  it('matches a full recount through push, undo, branch, replace, revert and squash', () => {
    const u = new UndoStack();
    const a = new Float32Array(100000), b = new Float32Array(200000), c = new Float32Array(300000);
    u.reset(doc([a]));
    expect(counted(u)).toBe(recount(u));
    u.push(doc([a, b]), 'b');
    const mark = u.mark();
    u.push(doc([a, b, c]), 'c');
    expect(counted(u)).toBe(recount(u));
    u.undo();
    u.push(doc([a, new Float32Array(50000)]), 'branch'); // drops the redo step holding c
    expect(counted(u)).toBe(recount(u));
    u.replaceTop(doc([new Float32Array(70000)]), 'replaced');
    expect(counted(u)).toBe(recount(u));
    u.push(doc([c]), 'c again');
    u.push(doc([b]), 'b again');
    expect(u.squash(mark, 'squashed')).toBe(true);
    expect(counted(u)).toBe(recount(u));
    u.revertTo(mark);
    expect(counted(u)).toBe(recount(u));
    u.reset(doc([c]));
    expect(counted(u)).toBe(c.byteLength);
  });

  it('does not count small arrays', () => {
    const u = new UndoStack();
    u.reset(doc([new Float32Array(16), new Float32Array(UNDO_TRACKED_BYTES / 4)]));
    expect(counted(u)).toBe(UNDO_TRACKED_BYTES);
  });

  it('drops the oldest steps beyond the limit and keeps the count exact', () => {
    const u = new UndoStack();
    u.memoryLimit = 4_000_000;
    u.reset(doc([new Float32Array(10000)]));
    for (let i = 0; i < 20; i++) u.push(doc([new Float32Array(250000)]), `s${i}`); // 1 MB each
    expect(counted(u)).toBe(recount(u));
    expect(counted(u)).toBeLessThanOrEqual(4_000_000);
    expect(u.history.length).toBeGreaterThanOrEqual(3);
    expect(u.canUndo).toBe(true);
  });
});
