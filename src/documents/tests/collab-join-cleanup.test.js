import { describe, it, expect, vi, afterEach } from 'vitest';
import * as Y from 'yjs';

const calls = [];
vi.mock('../src/collab/api.js', async () => {
  const { encode } = await import('../src/collab/protocol.js');
  return {
    deploy: vi.fn(),
    call: vi.fn(async (owner, server, input) => {
      calls.push(input.op);
      if (input.op === 'join') return { room: input.room, name: 'Plan', role: 'editor' };
      if (input.op === 'sync') return { update: encode(Y.encodeStateAsUpdate(new Y.Doc())), roster: [] };
      if (input.op === 'base') throw Object.assign(new Error('The shared document could not be read.'), { status: 0 });
      return { ok: true };
    }),
  };
});

const { joinRoom } = await import('../src/collab/live.js');

describe('joining a shared document', () => {
  afterEach(() => { vi.useRealTimers(); calls.length = 0; });

  it('leaves the room again when the document it holds cannot be read', async () => {
    vi.useFakeTimers();
    const link = { local: false, server: 'https://owner-docs.puter.work', room: 'room1', token: undefined };
    await expect(joinRoom(link, { id: 'u1', name: 'Bob' })).rejects.toThrow('could not be read');
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(20000);
    // No synchronization keeps running for an editor that never opened.
    expect(calls.filter((op) => op === 'sync')).toEqual([]);
  });
});
