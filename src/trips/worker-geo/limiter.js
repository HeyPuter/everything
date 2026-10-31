const unverified = () => Object.assign(new Error('global_limiter_unverified'), { code: 'global_limiter_unverified', status: 503 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Global window limiter on KV `incr('rl:<provider>:<windowStartSecond>')` with a short expiry.
 * KV `incr` is atomic only within one region, so the deployment must declare how many regions can run
 * the worker; each region then gets `limit / regions` requests per window. Without that declaration,
 * or if this runtime's `incr` does not count atomically, upstream calls are refused. Windows are aligned across
 * regions, so with several regions a short burst can exceed `limit` inside one window; the average stays within it.
 */
export function createKvLimiter(kv, { now = Date.now, sleep = pause, maxWait = 1000, random = () => Math.random().toString(36).slice(2) } = {}) {
  let verified = false;
  const verify = async () => {
    if (verified) return;
    const key = `rl:probe:${random()}`;
    try {
      const first = await kv.incr(key); const second = await kv.incr(key);
      await kv.expire(key, 5);
      if (!Number.isInteger(first) || second !== first + 1) throw unverified();
    } catch { throw unverified(); }
    verified = true;
  };
  // Windows this isolate saw fill up; another `incr` there would only cost a write.
  const full = new Set();
  return async (provider, { regions, limit = 1 } = {}) => {
    if (!Number.isInteger(regions) || regions < 1 || regions > 16 || !(limit > 0 && limit <= 10)) throw unverified();
    await verify();
    const seconds = Math.max(1, Math.ceil(regions / limit));
    const budget = Math.max(1, Math.floor(limit * seconds / regions));
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = Math.floor(now() / 1000 / seconds) * seconds;
      const key = `rl:${provider}:${start}`;
      if (!full.has(key)) {
        const count = await kv.incr(key);
        if (count === 1) await kv.expire(key, seconds + 4);
        if (count <= budget) return { ok: true };
        if (full.size > 64) full.clear();
        full.add(key);
      }
      const wait = (start + seconds) * 1000 - now();
      if (attempt || wait > maxWait) break;
      await sleep(Math.max(0, wait));
    }
    return { ok: false, retryAfter: seconds };
  };
}
