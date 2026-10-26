import { invariant } from '../../shared/errors.js';

/** Path C: the worker's `sync`, `repair` and `snapshot` ops. The owner pays these reads. */
const MORE_ROUNDS = 10;

export function createPathC({ store, api, events, uid, minInterval = 0 }) {
  let reread = false;
  async function snapshot(active) {
    const result = await api.snapshot(store.ref);
    if (!active()) return false;
    await store.replace(result);
    return active();
  }
  return {
    name: 'C',
    minInterval,
    async pull(active) {
      // As on path A, data an earlier session skipped is reloaded, once per adapter and only from a snapshot that is not
      // behind the replica (snapshots are rebuilt on a schedule).
      if (store.reread && !reread) {
        reread = true;
        const snap = await api.snapshot(store.ref);
        if (!active()) return null;
        if (snap?.rev >= store.rev) {
          await store.replace(snap);
          return active() ? { applied: true, remote: true, behind: false } : null;
        }
      }
      let applied = false;
      let remote = false;
      for (let round = 1; ; round++) {
        const result = await api.call(store.ref, 'sync', { since: store.rev });
        if (!active()) return null;
        invariant(result && Number.isSafeInteger(result.rev) && result.rev >= store.rev && (result.reset === true || Array.isArray(result.changes)), 'invalid_sync_response');
        if (result.reset) return await snapshot(active) ? { applied: true, remote: true, behind: false } : null;
        const contiguous = [];
        let expected = store.rev + 1;
        for (const record of result.changes) {
          invariant(Number.isSafeInteger(record.rev), 'invalid_revision');
          if (record.rev < expected) continue;
          if (record.rev !== expected) break;
          contiguous.push(record); expected += 1;
        }
        if (contiguous.length) await store.receive(contiguous);
        if (!active()) return null;
        applied ||= contiguous.length > 0;
        remote ||= contiguous.some((record) => record.by !== uid);
        // A capped answer (`more`) is pulled again at once instead of waiting out the gap timer.
        if (!result.more || !contiguous.length || round === MORE_ROUNDS) return { applied, remote, behind: result.rev > store.rev };
      }
    },
    async repair(active) {
      await api.call(store.ref, 'repair', { since: store.rev });
      if (active()) await snapshot(active);
    },
    async chatPage({ cursor } = {}) {
      const result = await api.call(store.ref, 'chat.page', cursor ? { before: cursor } : {});
      const messages = (Array.isArray(result?.msgs) ? result.msgs : []).map((message) => ({ ...message, t: 'msg' }));
      return { messages, cursor: messages.length ? messages.map((message) => message.id).sort()[0] : null };
    },
    subscribe: events?.subscribe ? (notify) => events.subscribe(notify) : undefined,
  };
}
