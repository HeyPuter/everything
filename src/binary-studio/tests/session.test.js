import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteSession,
  listSessions,
  loadSession,
  saveSession,
  sha256Hex,
} from '../src/engine/session.js';

describe('session persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saves and loads annotations via localStorage', () => {
    const store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    });

    const saved = saveSession({
      name: 'demo.exe',
      format: 'PE',
      arch: 'x86-64',
      fileName: 'demo.exe',
      fileSize: 12,
      sha256: 'abc',
      annotations: {
        symbols: {},
        bookmarks: [{ offset: 0x200, note: 'entry' }],
        comments: { '512': 'start here' },
      },
    });

    expect(saved.id).toBeTruthy();
    expect(listSessions()).toHaveLength(1);
    const loaded = loadSession(saved.id);
    expect(loaded.annotations.comments['512']).toBe('start here');
    expect(loaded.annotations.bookmarks[0].offset).toBe(0x200);

    deleteSession(saved.id);
    expect(listSessions()).toHaveLength(0);
  });

  it('hashes bytes with sha256Hex', async () => {
    const hex = await sha256Hex(Uint8Array.from([1, 2, 3]));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
