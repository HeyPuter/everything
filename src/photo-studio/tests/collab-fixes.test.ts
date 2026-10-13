// Regression tests for reviewed collaboration bugs: refused commits never
// persist, invitation links never override the owner's access decisions,
// comment names are the committer's own, outboxes of several tabs, demoted
// editors with queued tiles, Undo in lockstep, unprojectable merges and
// identifiers that could carry markup.
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { decode, encode, hash } from '../src/collab/protocol';
import { readThreads, writeThread } from '../src/collab/ycomments';
import { newThread } from '../src/collab/comments';
import type { Identity } from '../src/collab/server/service';
import { call } from '../src/collab/api';
import { commenter, editor, environment, owner, until, viewer, wait } from './collab-helpers';
import { closeAll, connect, idOf, invite, SERVER, settle, share, type Env } from './collab-session-helpers';

afterEach(closeAll);

/** A Yjs copy of the worker's state, for writing raw updates to commit. */
async function replica(env: Env, user: Identity, room: string) {
  const y = new Y.Doc();
  const res = (await env.service.call(user, { op: 'sync', room })) as { update: string };
  Y.applyUpdate(y, decode(res.update));
  return y;
}
/** The update `fn` makes to `y`, ready to commit. */
async function change(y: Y.Doc, fn: () => void) {
  let out: Uint8Array | undefined;
  const take = (u: Uint8Array) => (out = out ? Y.mergeUpdates([out, u]) : u);
  y.on('update', take);
  y.transact(fn);
  y.off('update', take);
  return { update: encode(out!), id: await hash(out!) };
}
const commit = (env: Env, user: Identity, room: string, c: { update: string; id: string }) => env.service.call(user, { op: 'commit', room, ...c });
const layerNames = (y: Y.Doc) => [...y.getMap<Y.Map<unknown>>('layers').values()].map((l) => l.get('p:name'));

describe('refused commits', () => {
  it('never reach a checkpoint or another person’s synchronization, even interleaved with accepted commits', async () => {
    const env = environment();
    const { room, a } = await share(env);
    await connect(env, commenter, room, { token: await invite(env, room, 'commenter') });
    const bg = idOf(a, 'Background');
    const mine = await replica(env, owner, room);
    const theirs = await replica(env, commenter, room);
    // 99 accepted edits; the next one writes the checkpoint at 100.
    const opacity = async (v: number) => change(mine, () => mine.getMap<Y.Map<unknown>>('layers').get(bg)!.set('p:opacity', v));
    for (let i = 1; i <= 99; i++) await commit(env, owner, room, await opacity(i / 100));
    const forged = await change(theirs, () => theirs.getMap<Y.Map<unknown>>('layers').get(bg)!.set('p:name', 'Forged'));
    const synced: string[] = [];
    const sync = async (service = env.service) => {
      const r = (await service.call(owner, { op: 'sync', room })) as { update: string };
      const y = new Y.Doc();
      Y.applyUpdate(y, decode(r.update));
      synced.push(...(layerNames(y) as string[]));
    };
    // Pause the worker at chosen storage calls to interleave requests exactly.
    const gates: { op: string; key: string; hit: () => void; open: Promise<void> }[] = [];
    const gate = (op: string, key: string) => {
      let hit!: () => void, release!: () => void;
      const reached = new Promise<void>((r) => (hit = r));
      const open = new Promise<void>((r) => (release = r));
      gates.push({ op, key, hit, open });
      return { reached, release };
    };
    for (const op of ['get', 'incr'] as const) {
      const original = env.kv[op].bind(env.kv) as (...a: unknown[]) => Promise<never>;
      (env.kv as unknown as Record<string, unknown>)[op] = async (...args: unknown[]) => {
        const at = gates.findIndex((g) => g.op === op && g.key === args[0]);
        if (at >= 0) {
          const [g] = gates.splice(at, 1);
          g.hit();
          await g.open;
        }
        return original(...args);
      };
    }
    // The accepted commit stops just before numbering its log record...
    const numbering = gate('incr', `ps:${room}:seq`);
    const accepted = commit(env, owner, room, await opacity(1));
    await numbering.reached;
    // ...a synchronization stops while refreshing the loaded copy...
    const refreshing = gate('get', `ps:${room}:seq`);
    const reading = sync();
    await refreshing.reached;
    // ...and the commenter's refused change arrives meanwhile.
    const refused = commit(env, commenter, room, forged);
    // (It finishes here unless commits are taken one at a time.)
    await Promise.race([refused.catch(() => {}), wait(100)]);
    refreshing.release();
    numbering.release();
    const results = await Promise.allSettled([accepted, refused, reading]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(synced).not.toContain('Forged');
    const cp = env.data.get(`ps:${room}:cp`) as { seq: number; path: string };
    expect(cp?.seq).toBe(100);
    const saved = new Y.Doc();
    Y.applyUpdate(saved, decode(env.files.get(cp.path)!));
    expect(layerNames(saved)).not.toContain('Forged');
    expect(layerNames(saved)).toContain('Background');
    // A later reader (a fresh instance from the checkpoint) does not have it either.
    await sync(env.instance());
    expect(synced).not.toContain('Forged');
  });
});

describe('invitation links and existing members', () => {
  it('never raise a role the owner lowered, never lift an expiry, and never lock out a member', async () => {
    const env = environment();
    const { room } = await share(env);
    const sdk = env.sdk(owner);
    const token = await invite(env, room, 'editor');
    await env.service.call(editor, { op: 'join', room, token });
    await call(sdk, SERVER, { op: 'role', room, uuid: editor.uuid, role: 'viewer' });
    // The old editor link does not undo the demotion.
    expect(((await env.service.call(editor, { op: 'join', room, token })) as { role: string }).role).toBe('viewer');
    // An expired member stays expired, with the expiry kept.
    const expires = env.now - 1;
    await call(sdk, SERVER, { op: 'role', room, uuid: editor.uuid, role: 'editor', expires });
    await expect(env.service.call(editor, { op: 'join', room, token })).rejects.toThrow(/expired/);
    expect((env.data.get(`ps:${room}:member:${editor.uuid}`) as { expires: number }).expires).toBe(expires);
    // A current member opening an expired link is still let in.
    const old = await invite(env, room, 'commenter');
    await env.service.call(commenter, { op: 'join', room, token: old });
    env.now += 8 * 86_400_000;
    expect(((await env.service.call(commenter, { op: 'join', room, token: old })) as { role: string }).role).toBe('commenter');
    // Someone new with that expired link is not.
    await expect(env.service.call(viewer, { op: 'join', room, token: old })).rejects.toThrow(/expired or was revoked/);
  });
});

describe('comment author names', () => {
  it('must be the committer’s own Puter username', async () => {
    const env = environment();
    const { room, a } = await share(env);
    await connect(env, commenter, room, { token: await invite(env, room, 'commenter') });
    const y = await replica(env, commenter, room);
    // A new thread under someone else's name (own ID): refused.
    await expect(commit(env, commenter, room, await change(y, () => writeThread(y, newThread({ x: 1, y: 1 }, { id: commenter.uuid, name: 'alice' }, 'Hi'))))).rejects.toThrow(/own name/);
    const y2 = await replica(env, commenter, room);
    const t = newThread({ x: 1, y: 1 }, { id: commenter.uuid, name: commenter.username }, 'Hi');
    await commit(env, commenter, room, await change(y2, () => writeThread(y2, t)));
    // A reply and a resolution under a forged name: refused.
    const msgs = () => y2.getMap<Y.Map<Y.Map<unknown>>>('comments').get(t.id)!.get('msgs') as Y.Map<unknown>;
    await expect(commit(env, commenter, room, await change(y2, () => msgs().set('m2', { id: 'm2', author: { id: commenter.uuid, name: 'alice' }, text: 'x', created: 5 })))).rejects.toThrow(/own name/);
    const y3 = await replica(env, commenter, room);
    await expect(commit(env, commenter, room, await change(y3, () => y3.getMap<Y.Map<unknown>>('comments').get(t.id)!.set('resolved', { by: { id: commenter.uuid, name: 'alice' }, at: 5 })))).rejects.toThrow(/own name/);
    await settle(a);
    expect(readThreads(a.client.ydoc).map((x) => x.author.name)).toEqual(['dee']);
  });
});
