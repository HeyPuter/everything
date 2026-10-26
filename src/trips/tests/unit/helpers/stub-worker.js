// Test-only trip host: writes the data-model §1 KV layout and answers the §6 ops the client uses, so client tests do
// not depend on the real worker. Identity comes from the restricted proof file's owner; signatures are not checked.
import { createClock } from '../../../src/shared/hlc.js';
import { newId } from '../../../src/shared/ids.js';

const fail = (code, status, extra = {}) => Object.assign(new Error(code), { code, status, ...extra });
const CONFLICT = new Set(['place', 'visit', 'res', 'exp', 'pack', 'note', 'saved']);

export function stubWorker({ name, build = 'stub000001', builtAt = 1, mintHandles = true, now = () => Date.now() } = {}) {
  return async ({ router, me }) => {
    const kv = me.puter.kv;
    const clock = createClock({ node: '0000000000000000', now });
    const self = await me.puter.auth.getUser();
    const key = (space, rest) => `shared:${space}:${rest}`;
    const entityKey = (space, t, id) => key(space, t === 'msg' ? `m:${id}` : `e:${t}:${id}`);

    async function acl(space) {
      const value = await kv.get(`sp:${space}:acl`);
      if (!value) throw fail('not_found', 404);
      return value;
    }
    async function member(space, uid) {
      const value = await acl(space);
      const role = value.members[uid]?.role;
      if (!role) throw fail('forbidden', 403);
      return { acl: value, role };
    }
    async function write(space, by, writes, { opIds = [] } = {}) {
      const rev = await kv.incr(`sp:${space}:rev`);
      const at = now();
      const ents = []; const del = []; const sum = [];
      for (const item of writes) {
        if (item.del) {
          const tombstone = { id: item.id, t: item.t, deleted: true, rev, v: clock.tick() };
          await kv.set(entityKey(space, item.t, item.id), tombstone);
          del.push({ t: item.t, id: item.id, v: tombstone.v }); sum.push({ t: item.t, id: item.id, name: item.name ?? '', fields: [] });
        } else {
          const entity = { ...item.data, id: item.id, v: clock.tick(), rev, upd: at, by, cr: item.data.cr ?? at };
          await kv.set(entityKey(space, item.t, item.id), entity);
          ents.push({ t: item.t, ...entity }); sum.push({ t: item.t, id: item.id, name: entity.name ?? entity.title ?? '', fields: item.fields ?? [] });
        }
      }
      const record = { rev, parts: 1, at, by, ents, del, sum };
      await kv.set(key(space, `ch:${rev}:0`), record);
      for (const opId of opIds) await kv.set(`sp:${space}:opdone:${opId}`, rev);
      await kv.set(key(space, 'sig'), JSON.stringify(record).length > 16_384 ? { rev } : record);
      return { rev, ents, del };
    }

    const handlers = {
      hello: async () => ({ build, builtAt, protocol: 1, features: [] }),
      async 'space.create'(body, uid) {
        if (uid !== self.uuid) throw fail('forbidden', 403);
        const space = newId();
        await kv.set(`sp:${space}:acl`, { stamp: 1, members: { [uid]: { role: 'owner', username: self.username } }, removed: {} });
        await kv.update('idx', { [space]: { k: body.kind ?? 'trip', created: now() } });
        await write(space, uid, [
          { t: 'meta', id: 'meta', data: { title: body.title ?? 'Trip', currency: 'EUR' } },
          { t: 'member', id: uid, data: { name: self.username, role: 'owner' } },
        ]);
        return { space };
      },
      async open(body, uid) {
        const { role } = await member(body.space, uid);
        const handles = await kv.get(`sp:${body.space}:h:${uid}`);
        return { role, rev: (await kv.get(`sp:${body.space}:rev`)) ?? 0, ...(handles ? { handles: { read: handles.read, write: handles.write } } : {}), files: { mode: 'proxied' }, protocol: 1 };
      },
      async 'invite.create'(body, uid) {
        const { role } = await member(body.space, uid);
        if (role !== 'owner') throw fail('forbidden', 403);
        const invitee = body.named;
        const invite = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const exp = now() + 14 * 24 * 60 * 60_000;
        const meta = await kv.get(entityKey(body.space, 'meta', 'meta'));
        await kv.set(`sp:${body.space}:inv:${invite}`, { role: body.role ?? 'editor', exp, named: invitee });
        await kv.set(`shared:inv:${invite}:info`, { invite, worker: name, space: body.space, kind: 'trip', title: meta.title, ownerName: self.username, role: body.role ?? 'editor', exp });
        const share = await kv.share({ prefix: `shared:inv:${invite}:`, recipient: { uid: invitee }, access: 'read', label: `${meta.title} · from ${self.username}` });
        await kv.update(`sp:${body.space}:inv:${invite}`, { stub: share.handle });
        return { invite };
      },
      async join(body, uid) {
        const record = await kv.get(`sp:${body.space}:inv:${body.invite}`);
        if (!record || record.named !== uid || record.exp <= now()) throw fail('invite_invalid', 403);
        const current = await acl(body.space);
        current.members[uid] = { role: record.role, joined: now(), via: 'named' };
        current.stamp += 1;
        await kv.set(`sp:${body.space}:acl`, current);
        const { rev } = await write(body.space, uid, [{ t: 'member', id: uid, data: { name: uid.slice(-4), role: record.role } }]);
        let handles;
        if (mintHandles) {
          const read = await kv.share({ prefix: key(body.space, ''), recipient: { uid }, access: 'read' });
          const writeHandle = await kv.share({ prefix: key(body.space, `u:${uid}:`), recipient: { uid }, access: 'write' });
          handles = { read: read.handle, write: writeHandle.handle };
          await kv.set(`sp:${body.space}:h:${uid}`, { ...handles, minted: now() });
        }
        if (record.stub) await kv.unshare(record.stub).catch(() => {});
        await kv.del(`shared:inv:${body.invite}:info`); await kv.del(`sp:${body.space}:inv:${body.invite}`);
        return { role: record.role, rev, ...(handles ? { handles } : {}), files: { mode: 'proxied' } };
      },
      async 'invite.decline'(body, uid) {
        const record = await kv.get(`sp:${body.space}:inv:${body.invite}`);
        if (!record || record.named !== uid) throw fail('invite_invalid', 403);
        if (record.stub) await kv.unshare(record.stub).catch(() => {});
        await kv.del(`shared:inv:${body.invite}:info`); await kv.del(`sp:${body.space}:inv:${body.invite}`);
        return {};
      },
      async commit(body, uid) {
        const { role } = await member(body.space, uid);
        const done = {}; const writes = []; const fresh = [];
        for (const op of body.ops) {
          const prior = await kv.get(`sp:${body.space}:opdone:${op.opId}`);
          if (prior) { done[op.opId] = prior; continue; }
          if (role === 'viewer' && op.t !== 'msg') throw fail('forbidden', 403, { op: op.opId });
          const current = await kv.get(entityKey(body.space, op.t, op.id));
          if (op.put) {
            if (current) throw fail('already_exists', 409, { op: op.opId, server: { t: op.t, ...current } });
            writes.push({ t: op.t, id: op.id, data: op.put, fields: Object.keys(op.put) });
          } else {
            if (!current || current.deleted) throw fail('gone', 409, { op: op.opId, ...(current ? { server: current } : {}) });
            if (op.base && CONFLICT.has(op.t) && current.v !== op.base) throw fail('stale', 409, { op: op.opId, server: { t: op.t, ...current } });
            if (op.del) writes.push({ t: op.t, id: op.id, del: true, name: current.name });
            else {
              const { id: _id, v: _v, rev: _rev, upd: _upd, by: _by, ...data } = current;
              for (const [path, value] of Object.entries(op.set ?? {})) {
                const parts = path.split('.'); let target = data;
                for (const part of parts.slice(0, -1)) target = target[part] ??= {};
                target[parts.at(-1)] = value;
              }
              for (const path of op.unset ?? []) { const parts = path.split('.'); let target = data; for (const part of parts.slice(0, -1)) target = target?.[part]; if (target) delete target[parts.at(-1)]; }
              writes.push({ t: op.t, id: op.id, data, fields: [...Object.keys(op.set ?? {}), ...(op.unset ?? [])] });
            }
          }
          fresh.push(op.opId);
        }
        if (!writes.length) return { rev: Math.max(0, ...Object.values(done)), ents: [], del: [], done };
        const result = await write(body.space, uid, writes, { opIds: fresh });
        for (const opId of fresh) done[opId] = result.rev;
        return { ...result, done };
      },
      async sync(body, uid) {
        await member(body.space, uid);
        const rev = (await kv.get(`sp:${body.space}:rev`)) ?? 0;
        if (rev <= body.since) return { rev, changes: [] };
        const keys = Array.from({ length: Math.min(100, rev - body.since) }, (_, i) => key(body.space, `ch:${body.since + 1 + i}:0`));
        const changes = [];
        for (const record of await kv.get(keys)) { if (!record) break; const { parts: _parts, ...rest } = record; changes.push(rest); }
        return { rev, changes };
      },
      async snapshot(body, uid) {
        await member(body.space, uid);
        const rev = (await kv.get(`sp:${body.space}:rev`)) ?? 0;
        const items = await kv.list({ pattern: key(body.space, 'e:*'), returnValues: true });
        const ents = []; const tombstones = [];
        for (const { key: itemKey, value } of items) {
          const t = itemKey.split(':')[3];
          if (value.deleted) tombstones.push(value); else ents.push({ t, ...value });
        }
        return { raw: { rev, ents, tombstones } };
      },
      async repair(body, uid) { await member(body.space, uid); return { snap: { rev: (await kv.get(`sp:${body.space}:rev`)) ?? 0 } }; },
      async pres(body, uid) {
        await member(body.space, uid);
        await kv.update(`sp:${body.space}:pres`, { [uid]: now() });
        return { active: (await kv.get(`sp:${body.space}:pres`)) ?? {} };
      },
      async heads(body, uid) {
        const heads = {};
        for (const space of body.spaces ?? []) {
          try {
            const { role } = await member(space, uid);
            const meta = await kv.get(entityKey(space, 'meta', 'meta'));
            heads[space] = { rev: (await kv.get(`sp:${space}:rev`)) ?? 0, title: meta.title, start: meta.start ?? null, end: meta.end ?? null, role };
          } catch { /* Unavailable spaces are omitted. */ }
        }
        return { heads };
      },
    };

    router.get('/health', () => ({ ok: true, build, builtAt, protocol: 1 }));
    router.post('/api', async ({ request, user }) => {
      try {
        const body = await request.json();
        const proof = JSON.parse(request.headers.get('x-trips-proof') ?? 'null');
        if (!proof?.path || !user?.puter) throw fail('credential_rejected', 401);
        const stat = await user.puter.fs.stat(proof.path).catch(() => { throw fail('credential_rejected', 401); });
        const handler = Object.hasOwn(handlers, body.op) ? handlers[body.op] : null;
        if (!handler) throw fail('unknown_op', 400);
        const result = await handler(body, stat.owner.uuid);
        return result.raw ? Response.json(result.raw) : Response.json({ ok: true, ...result });
      } catch (error) {
        return Response.json({ code: error.code ?? 'internal', message: String(error.message), ...(error.op ? { op: error.op } : {}), ...(error.server ? { server: error.server } : {}) }, { status: error.status ?? 500 });
      }
    });
  };
}
