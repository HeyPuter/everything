import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { environment, owner, SERVER, until } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

it('recovers from a request the room could not verify once, sending the change it held back', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan' });
  const client = new RoomClient({ puter: env.sdk(owner), server: SERVER, room, store: memoryOutbox(), poll: 50, noPeers: true });
  open.push(client);
  await client.open();
  // Puter could not confirm the caller's credential for a moment (the worker answers 401), twice in a row, as
  // a retry with a fresh credential meets the same moment.
  let refusals = 2;
  env.route = () => ({
    call: (identity, input) => {
      if (input.op === 'commit' && refusals > 0) { refusals--; throw Object.assign(new Error('Could not verify this collaboration request.'), { status: 401 }); }
      return env.service.call(identity, input);
    },
  });
  client.wb.setInput(client.wb.sheets[0].id, 0, 0, 'held');
  await until(() => refusals === 0, 4000, 'the refusals');
  // The next request goes through: the change is sent without another edit, and the status says so.
  await until(() => !client.replica.pending.length, 4000, 'the change to be sent');
  await until(() => client.status.state === 'connected', 4000, 'the status to recover');
  expect(env.data.get(`ss:${room}:log:${'1'.padStart(12, '0')}`)?.changes?.[0]?.ops?.[0]?.v).toMatchObject({ '0,0': { v: 'held' } });
});
