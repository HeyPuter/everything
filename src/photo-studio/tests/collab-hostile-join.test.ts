// A tile or asset someone refers to but never uploaded must not keep the
// browsers in the room downloading in a loop or stop anyone from joining.
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { decode, encode, hash } from '../src/collab/protocol';
import type { Identity } from '../src/collab/server/service';
import { editor, environment, viewer } from './collab-helpers';
import { closeAll, connect, idOf, invite, share, type Env } from './collab-session-helpers';
import { findLayer } from '../src/model/document';

afterEach(closeAll);

async function replica(env: Env, user: Identity, room: string) {
  const y = new Y.Doc();
  const res = (await env.service.call(user, { op: 'sync', room })) as { update: string };
  Y.applyUpdate(y, decode(res.update));
  return y;
}
async function change(y: Y.Doc, fn: () => void) {
  let out: Uint8Array | undefined;
  const take = (u: Uint8Array) => (out = out ? Y.mergeUpdates([out, u]) : u);
  y.on('update', take);
  y.transact(fn);
  y.off('update', take);
  return { update: encode(out!), id: await hash(out!) };
}

describe('content another person referred to but never uploaded', () => {
  it('neither keeps others asking for it in a loop nor stops people from joining', async () => {
    const env = environment();
    const { room, a } = await share(env);
    await connect(env, editor, room, { token: await invite(env, room, 'editor') });
    const top = idOf(a, 'Top');
    const y = await replica(env, editor, room);
    const c = await change(y, () => {
      const entry = y.getMap<Y.Map<unknown>>('layers').get(top)!;
      entry.set('g:pixels', { channels: 4, x: 0, y: 0 });
      const t = new Y.Map<string>();
      entry.set('t:pixels', t);
      t.set('0,0', 'a'.repeat(64));
    });
    await env.service.call(editor, { op: 'commit', room, ...c });
    await a.client.sync();
    a.binding.project(false);
    const before = env.calls.length;
    await new Promise((r) => setTimeout(r, 1000));
    const gets = env.calls.slice(before).filter((c) => c.op === 'asset.get').length;
    // Asked again after a pause, not in a loop.
    expect(gets).toBeLessThanOrEqual(3);
    const token = await invite(env, room, 'viewer');
    const v = await connect(env, viewer, room, { token });
    // The joiner sees the document without the missing tile.
    expect(findLayer(v.binding.history.document.layers, idOf(v, 'Background'))).toBeTruthy();
    expect(findLayer(v.binding.history.document.layers, top)!.pixels!.tiles).toEqual({});
  });
});
