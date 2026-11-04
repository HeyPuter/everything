import { it, expect, vi } from 'vitest';

vi.mock('../src/collab/auth.js', async (importOriginal) => ({ ...await importOriginal(), authorize: async (puter, server, body) => ({ 'puter-auth': 'restricted', 'x-documents-proof': `signed:${body}` }) }));
const { prepareCall } = await import('../src/collab/api.js');
const { WorkerTransport } = await import('../src/collab/transports.js');
const Y = await import('yjs');
const { encode } = await import('../src/collab/protocol.js');

const tick = () => new Promise(r => setTimeout(r, 0));

/**
 * A tab closing leaves the room at once: the request has to start in the pagehide handler itself, where nothing
 * awaited would run, and outlive the page.
 */
it('sends a goodbye signed ahead, synchronously and keepalive, when the page goes', async () => {
  const sent = [];
  const puter = { workers: { exec: (url, init) => { sent.push({ url, init }); return Promise.resolve(new Response('{}')); } } };
  const server = 'https://documents-abc.puter.work';
  const transport = new WorkerTransport({
    call: async op => (op === 'join' ? { role: 'editor' } : { update: encode(Y.encodeStateAsUpdate(new Y.Doc())), roster: [] }),
    prepare: (op, input) => prepareCall(puter, server, { ...input, op }),
    room: 'room1',
  });
  await transport.join({ session: 's1', update() {}, presence() {}, role() {}, closed() {} });
  await tick();
  transport.farewell();
  // Started in the same turn, not after an await.
  expect(sent).toHaveLength(1);
  const { url, init } = sent[0];
  expect(url).toBe(`${server}/api`);
  expect(init.keepalive).toBe(true);
  expect(JSON.parse(init.body)).toEqual({ room: 'room1', session: 's1', op: 'leave' });
  expect(init.headers['x-documents-proof']).toBe(`signed:${init.body}`);
  transport.left = true; clearTimeout(transport.timer);
});
