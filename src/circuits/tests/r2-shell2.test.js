// Round-two shell review, second pass: storage ordering, shortcuts inside
// dialogs, panel fields and accessibility.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { setPuterForTests } from '../src/app/puter.js';
import { UserLibrary } from '../src/app/user-library.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('My library with slow storage', () => {
  const PATH = 'Libraries/My components.circuitslib';
  const def = (id) => ({ id, name: id, symbol: { pins: [], graphics: [] }, footprint: null });
  const idsIn = (text) =>
    JSON.parse(text)
      .components.map((c) => c.id)
      .sort();

  /** A cloud whose reads and writes finish only when the test releases them. */
  function slowCloud(initial) {
    const files = new Map(initial ? [[PATH, initial]] : []);
    const writes = [];
    const reads = [];
    const fs = {
      read(path) {
        return new Promise((resolve, reject) => {
          reads.push(() => {
            if (files.has(path)) resolve(new Blob([files.get(path)]));
            else
              reject(
                Object.assign(new Error('subject_does_not_exist'), {
                  code: 'subject_does_not_exist',
                }),
              );
          });
        });
      },
      write(path, text) {
        return new Promise((resolve) => {
          writes.push(() => {
            files.set(path, text);
            resolve({ path });
          });
        });
      },
    };
    setPuterForTests({ env: 'web', auth: { isSignedIn: () => true }, fs });
    return { files, writes, reads };
  }

  afterEach(() => {
    setPuterForTests(null);
    vi.restoreAllMocks();
  });

  it('stores both components when two are added quickly and the first write is slow', async () => {
    const cloud = slowCloud();
    const lib = new UserLibrary();
    const loading = lib.load();
    await tick();
    cloud.reads.shift()();
    await loading;
    const a = lib.put(def('a'));
    const b = lib.put(def('b'));
    // Release whatever writes are pending newest first, as a slow network may.
    for (let i = 0; i < 6; i++) {
      await tick();
      while (cloud.writes.length) cloud.writes.pop()();
    }
    await Promise.all([a, b]);
    expect(idsIn(cloud.files.get(PATH))).toEqual(['a', 'b']);
  });
});
