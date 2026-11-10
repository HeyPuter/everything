import { it, expect, vi, afterEach } from 'vitest';
import * as Y from 'yjs';
import { CollabClient } from '../src/collab/client.js';

afterEach(() => { vi.useRealTimers(); });

// A room that cannot take changes for now (offline, a server error) is asked again after a growing pause. Each
// change typed meanwhile used to send at once (40 ms after it), so a person typing against a failing room sent a
// failing request after nearly every keystroke, whatever the pause had grown to.
it('waits out the growing pause after a failed send while the person keeps typing', async () => {
  vi.useFakeTimers();
  let sends = 0, online = false;
  const transport = {
    join: async () => ({ role: 'editor', state: null }),
    send: async () => { sends++; if (!online) throw Object.assign(new Error('Failed to fetch'), { status: 0 }); },
  };
  const client = new CollabClient({ transport, user: { id: 'u1', name: 'Bob' }, room: 'r-backoff' });
  await client.connect();
  const text = client.ydoc.getText('body');
  // Typing for six seconds, a keystroke every 200 ms.
  for (let i = 0; i < 30; i++) { text.insert(text.length, 'a'); await vi.advanceTimersByTimeAsync(200); }
  // 1 s, 2 s, 4 s pauses fit in six seconds: a handful of attempts, not one per keystroke.
  expect(sends).toBeLessThanOrEqual(5);
  expect(client.status).toBe('offline');
  // The room comes back: the next attempt delivers everything typed.
  online = true;
  await vi.advanceTimersByTimeAsync(40000);
  expect(client.outbox.size).toBe(0);
  expect(client.status).toBe('online');
  await client.close();
});
