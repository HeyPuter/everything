import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { call } from '../src/collab/api.js';
import { Doc } from '../src/lib/doc.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { environment, owner, editor, SERVER } from './collab-helpers.js';

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

// Someone a shared workbook was shared with has no file of it: renaming it changed the name in their own title bar
// alone, as if it had worked, while everyone else (and they themselves, on opening it again) kept the owner's name.
it('tells someone a shared workbook was shared with that only its owner can rename it', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const token = (await call(env.sdk(owner), SERVER, { op: 'invite', room, role: 'editor' })).token;
  const client = new RoomClient({ puter: env.sdk(editor), server: SERVER, room, token, store: memoryOutbox(), poll: 50, noPeers: true });
  open.push(client);
  await client.open();
  const doc = Doc.forRoom(client);
  const renamed = [];
  doc.addEventListener('path', (e) => renamed.push(e.detail.name));
  expect(await doc.rename('Budget')).toMatch(/only its owner can rename it/i);
  expect(doc.name).toBe('Plan');
  expect(renamed).toEqual([]);
  doc.destroy();
});
