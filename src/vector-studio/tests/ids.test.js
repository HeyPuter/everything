import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

/** A fresh copy of the ids module, as a new browser session loads it. */
async function session() {
  vi.resetModules();
  return import('../src/lib/ids.js');
}

describe('object ids', () => {
  it('use a fixed-length random prefix from the crypto generator per session', async () => {
    // Two sessions whose Math.random() happens to start the same (or any weak source) still differ.
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    const a = await session();
    const b = await session();
    const ida = a.uid('p');
    const idb = b.uid('p');
    expect(ida).not.toBe(idb);
    expect(ida).toMatch(/^p[0-9a-z]{8}1$/);
    expect(a.uid('img')).toMatch(/^img[0-9a-z]{8}2$/);
  });

  it('stay unique within a session and valid collaboration ids', async () => {
    const { uid } = await session();
    const seen = new Set();
    for (let i = 0; i < 5000; i++) seen.add(uid('p'));
    expect(seen.size).toBe(5000);
    for (const id of seen) expect(id).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
  });
});
