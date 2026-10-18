import { afterEach, beforeEach, expect, it } from 'vitest';
import { savePref, syncPref } from '../src/lib/user-prefs.js';
import { memoryStorage } from './helpers/memory-storage.js';

let kv;
let reachable;
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  kv = new Map();
  reachable = true;
  globalThis.puter = {
    auth: { isSignedIn: () => true },
    kv: {
      get: async (key) => { if (!reachable) throw new Error('offline'); return kv.get(key) ?? null; },
      set: async (key, value) => { if (!reachable) throw new Error('offline'); kv.set(key, value); return true; },
    },
  };
});
afterEach(() => { delete globalThis.puter; });

it("puts a preference changed while the account's store could not be reached in the store once it can be", async () => {
  savePref('options', { enterDirection: 'right' });
  await Promise.resolve();
  // Changed again while offline: only this browser has it.
  reachable = false;
  savePref('options', { enterDirection: 'left' });
  await new Promise((r) => setTimeout(r, 0));
  reachable = true;
  expect(await syncPref('options')).toEqual({ enterDirection: 'left' });
  // Another device reads the account's copy: the newer choice.
  await new Promise((r) => setTimeout(r, 0));
  expect(JSON.parse(kv.get('spreadsheet:pref:options')).value).toEqual({ enterDirection: 'left' });
});

it("takes the account's copy when it is the newer one, and leaves it as it is", async () => {
  kv.set('spreadsheet:pref:options', JSON.stringify({ at: Date.now() + 1000, value: { enterDirection: 'up' } }));
  savePref('options', { enterDirection: 'left' });
  kv.set('spreadsheet:pref:options', JSON.stringify({ at: Date.now() + 1000, value: { enterDirection: 'up' } }));
  expect(await syncPref('options')).toEqual({ enterDirection: 'up' });
  expect(JSON.parse(kv.get('spreadsheet:pref:options')).value).toEqual({ enterDirection: 'up' });
});
