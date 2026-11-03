import { CLEANUP_PERMIT, KV_PERMIT, createEvidence, errorStatus, requirePermit, requireRunId } from './evidence.js';
import { guardedCall, isAccountChange, pinBrowserAccount } from './account.js';

const slots = ['batch-a', 'batch-b', 'missing', 'paths', 'counter', 'append', 'ttl', 'small', 'large', 'claim'];
export const kvKeys = (runId) => slots.map((slot) => `spike:${requireRunId(runId)}:${slot}`);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const entries = (result) => Array.isArray(result) ? result : result?.items;

/** Exact generated keys only: never list or flush to discover cleanup targets. */
export async function cleanupKv({ puter, runId, permit, account }) {
  requirePermit(permit, CLEANUP_PERMIT);
  requireRunId(runId);
  try { account ??= await pinBrowserAccount(puter); }
  catch (error) {
    if (!isAccountChange(error)) throw error;
    return { attempted: 0, failed: 0, cleanupRequired: true, originalAccountRequired: true };
  }
  let attempted = 0;
  let failed = 0;
  let originalAccountRequired = false;
  for (const key of kvKeys(runId)) {
    try {
      await guardedCall(account, () => { attempted++; return puter.kv.del(key); });
    } catch (error) {
      if (isAccountChange(error)) { originalAccountRequired = true; break; }
      failed++;
    }
  }
  return { attempted, failed, cleanupRequired: failed > 0 || originalAccountRequired, originalAccountRequired };
}

/** Imports are inert. Calling this function explicitly authorizes bounded synthetic writes. */
export async function runKvProbes({ puter, runId, environment, permit, account, ttl = false, size = false, conditional = false, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => performance.now() }) {
  requirePermit(permit, KV_PERMIT);
  requireRunId(runId);
  if (![ttl, size, conditional].every((value) => typeof value === 'boolean')) throw new Error('spike_invalid_options');
  const evidence = createEvidence({ runId, environment });
  account ??= await pinBrowserAccount(puter);
  const keys = Object.fromEntries(slots.map((slot, index) => [slot, kvKeys(runId)[index]]));
  let calls = 0;
  let writes = 0;
  let changed = false;
  const call = async (method, ...args) => {
    return guardedCall(account, () => {
      if (++calls > 40) throw new Error('spike_call_budget');
      if (['set', 'update', 'incr', 'add', 'expire'].includes(method) && ++writes > 20) throw new Error('spike_write_budget');
      return puter.kv[method](...args);
    });
  };
  async function probe(id, operation) {
    if (changed) { evidence.record(id, 'pending'); return; }
    const started = now();
    try {
      const pass = await operation();
      evidence.record(id, pass ? 'pass' : 'fail', { elapsedMs: Math.max(0, now() - started) });
    } catch (error) {
      changed ||= isAccountChange(error);
      evidence.record(id, 'error', { status: errorStatus(error), ...(changed ? { cleanupRequired: true, originalAccountRequired: true } : {}) });
    }
  }
  try {
    await probe('kv.batch', async () => {
      await call('set', keys['batch-a'], { fixture: 'a' });
      await call('set', keys['batch-b'], { fixture: 'b' });
      return equal(await call('get', [keys['batch-a'], keys['batch-b']]), [{ fixture: 'a' }, { fixture: 'b' }]);
    });
    await probe('kv.updateMissing', async () => {
      await call('update', keys.missing, { 'nested.count': 1 });
      return equal(await call('get', keys.missing), { nested: { count: 1 } });
    });
    await probe('kv.updatePaths', async () => {
      await call('set', keys.paths, { keep: true, nested: { first: 1, second: 2 } });
      await call('update', keys.paths, { 'nested.first': 3, 'nested.third': 4 });
      return equal(await call('get', keys.paths), { keep: true, nested: { first: 3, second: 2, third: 4 } });
    });
    await probe('kv.incr', async () => {
      const first = await call('incr', keys.counter, 2);
      const second = await call('incr', keys.counter);
      return first === 2 && second === 3 && await call('get', keys.counter) === 3;
    });
    await probe('kv.add', async () => {
      const first = await call('add', keys.append, { items: ['a', 'b'] });
      const second = await call('add', keys.append, { items: 'c' });
      return equal(first, { items: ['a', 'b'] }) && equal(second, { items: ['a', 'b', 'c'] }) && equal(await call('get', keys.append), second);
    });
    await probe('kv.listObject', async () => {
      const found = entries(await call('list', { pattern: `spike:${runId}:batch-*`, returnValues: true, limit: 10 }));
      return Array.isArray(found) && found.length === 2 && found.every((item) => item && [keys['batch-a'], keys['batch-b']].includes(item.key) && equal(item.value, { fixture: item.key.endsWith('a') ? 'a' : 'b' }));
    });
    await probe('kv.listStringConfig', async () => {
      const found = entries(await call('list', `spike:${runId}:batch-*`, { returnValues: true }));
      return Array.isArray(found) && found.length === 2 && found.every((item) => typeof item === 'string' && [keys['batch-a'], keys['batch-b']].includes(item));
    });
    if (ttl) await probe('kv.ttl', async () => {
      await call('set', keys.ttl, 'synthetic-ttl');
      await call('expire', keys.ttl, 2);
      const before = await call('get', keys.ttl);
      await wait(2500);
      return before === 'synthetic-ttl' && await call('get', keys.ttl) === null;
    });
    else evidence.record('kv.ttl', 'pending');
    if (size) await probe('kv.size', async () => {
      await call('set', keys.small, 's'.repeat(398 * 1024 - 2));
      const stored = await call('get', keys.small);
      if (typeof stored !== 'string' || stored.length !== 398 * 1024 - 2) return false;
      try { await call('set', keys.large, 's'.repeat(401 * 1024 - 2)); }
      catch (error) {
        if (isAccountChange(error)) throw error;
        return errorStatus(error) === 400 || errorStatus(error) === 413;
      }
      return false;
    });
    else evidence.record('kv.size', 'pending');
    if (conditional) await probe('kv.conditional', async () => {
      const first = await call('set', keys.claim, 'first', { onlyIfAbsent: true });
      const second = await call('set', keys.claim, 'second', { onlyIfAbsent: true });
      return first === true && second === false && await call('get', keys.claim) === 'first';
    });
    else evidence.record('kv.conditional', 'pending');
  } finally {
    const cleanup = await cleanupKv({ puter, runId, permit: CLEANUP_PERMIT, account });
    evidence.record('cleanup.kv', cleanup.cleanupRequired ? 'fail' : 'pass', { ...cleanup, calls, writes });
  }
  return evidence.report();
}
