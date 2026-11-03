// The only module that knows puter.js KV call shapes, so live-check findings (docs/live-checks.md) land in one place.
const GET_BATCH = 1000;

export { pool } from '../../src/shared/pool.js';

export function createStore(kv) {
  return {
    get: (key) => kv.get(key),
    /** One call per 1,000 keys; `null` for missing. */
    async getMany(keys) {
      if (!keys.length) return [];
      const out = [];
      for (let i = 0; i < keys.length; i += GET_BATCH) {
        const values = await kv.get(keys.slice(i, i + GET_BATCH));
        out.push(...values);
      }
      return out;
    },
    set(key, value, { expireAt } = {}) {
      return expireAt ? kv.set(key, value, Math.ceil(expireAt / 1000)) : kv.set(key, value);
    },
    /**
     * Resolves false when a live entry holds the key. The check is per region: two regions can both claim a key
     * before replication, and the later write wins. Only `optConfig.onlyIfAbsent` counts.
     */
    setIfAbsent(key, value, { expireAt } = {}) {
      return expireAt ? kv.set(key, value, Math.ceil(expireAt / 1000), { onlyIfAbsent: true }) : kv.set(key, value, { onlyIfAbsent: true });
    },
    /** Non-atomic batch; items `{key, value, expireAt?(ms)}`. */
    async setMany(items) {
      if (!items.length) return;
      for (let i = 0; i < items.length; i += 1000) {
        await kv.set(items.slice(i, i + 1000).map(({ key, value, expireAt }) => (expireAt ? { key, value, expireAt: Math.ceil(expireAt / 1000) } : { key, value })));
      }
    },
    update: (key, paths) => kv.update(key, paths),
    remove: (key, paths) => kv.remove(key, ...paths),
    incr: (key, by = 1) => kv.incr(key, by),
    incrPaths: (key, paths) => kv.incr(key, paths),
    del: (key) => kv.del(key),
    expire: (key, seconds) => kv.expire(key, seconds),
    share: (args) => kv.share(args),
    unshare: (handle) => kv.unshare(handle),
    listSharedByMe: (options) => kv.listSharedByMe(options),
    list: (options) => kv.list(options),
  };
}

/** Dotted paths whose segments need no quoting in `update`/`remove` path syntax. */
export const plainPath = (path) => path.split('.').every((segment) => segment.length > 0 && !/[\s[\]"'\\]/.test(segment));
