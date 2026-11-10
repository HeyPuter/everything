import { afterEach, expect, it } from 'vitest';
import { kvSet, loadPuter, setPuterForTests, signIn, signOut } from '../src/platform/puter';

// The SDK resolves set() once written; these tests exercise caller ordering.
// https://github.com/HeyPuter/puter/blob/8b64cc50762c01f0b8f6cbb7164640d4f2f5bc86/src/puter-js/src/modules/kv/set.js
afterEach(() => setPuterForTests(null));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

it.each([false, true])('keeps same-key writes ordered when the first write fails: %s', async (fails) => {
  const pending = gate();
  const calls: unknown[] = [];
  let stored: unknown;
  setPuterForTests({ env: 'app', fs: {}, kv: { set: async (_key: string, value: unknown) => {
    calls.push(value);
    if (calls.length === 1) { await pending.promise; if (fails) throw new Error('Offline'); }
    stored = value;
    return true;
  } } } as never);
  const first = kvSet('settings', 'first');
  const second = kvSet('settings', 'second');
  expect(calls).toEqual(['first']);
  pending.release();
  expect(await first).toBe(!fails);
  expect(await second).toBe(true);
  expect(calls).toEqual(['first', 'second']);
  expect(stored).toBe('second');
});

it('snapshots queued values and allows unrelated keys to write independently', async () => {
  const pending = gate();
  const calls: [string, unknown][] = [];
  setPuterForTests({ env: 'app', fs: {}, kv: { set: async (key: string, value: unknown) => {
    calls.push([key, value]);
    if (calls.length === 1) await pending.promise;
    return true;
  } } } as never);
  const first = kvSet('settings', { units: 'IPS' });
  const value = { units: 'MKS' };
  const second = kvSet('settings', value);
  value.units = 'CGS';
  expect(await kvSet('other', 7)).toBe(true);
  expect(calls).toEqual([['settings', { units: 'IPS' }], ['other', 7]]);
  pending.release();
  await Promise.all([first, second]);
  expect(calls[2]).toEqual(['settings', { units: 'MKS' }]);
});

it.each(['sign out', 'sign in'])('does not send queued old preferences after %s changes the session', async (action) => {
  const pending = gate();
  let user = 'A', signedIn = true;
  const calls: [string, unknown][] = [];
  setPuterForTests({ env: 'web', fs: {}, auth: {
    isSignedIn: () => signedIn,
    signIn: async () => { signedIn = true; user = 'B'; },
    signOut: async () => { signedIn = false; },
  }, kv: { set: async (_key: string, value: unknown) => {
    calls.push([user, value]);
    if (calls.length === 1) await pending.promise;
    return true;
  } } } as never);
  const first = kvSet('settings', 'first');
  const stale = kvSet('settings', 'stale');
  if (action === 'sign out') await signOut();
  await signIn();
  const latest = kvSet('settings', 'new');
  pending.release();
  expect(await Promise.all([first, stale, latest])).toEqual([true, false, true]);
  expect(calls).toEqual([['A', 'first'], ['B', 'new']]);
});

it('does not retain signed-out writes for a later sign-in', async () => {
  let signedIn = false;
  const calls: unknown[] = [];
  setPuterForTests({ env: 'web', fs: {}, auth: {
    isSignedIn: () => signedIn, signIn: async () => { signedIn = true; },
  }, kv: { set: async (_key: string, value: unknown) => { calls.push(value); return true; } } } as never);
  expect(await kvSet('settings', 'offline')).toBe(false);
  await signIn();
  expect(await kvSet('settings', 'online')).toBe(true);
  expect(calls).toEqual(['online']);
});

it('stops waiting for the SDK once its script failed to load', async () => {
  const g = globalThis as { window?: unknown };
  const previous = g.window;
  g.window = { __puterFailed: true };
  try {
    const started = Date.now();
    expect(await loadPuter(60_000)).toBeNull();
    // Not the full wait: the deadline is a minute away.
    expect(Date.now() - started).toBeLessThan(30_000);
  } finally {
    g.window = previous;
  }
});
