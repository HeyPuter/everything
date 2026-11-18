// Puter calls reject with the service's error object rather than an Error.
// Its message reaches the user (not "[object Object]"), and an Open Recent
// entry whose Puter file was moved or deleted is taken off the list.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, setLocalStore } from '../src/persistence/local-store';
import { clearRecent, noteRecent, recentEntries } from '../src/features/files/recent';
import { openRecentEntry } from '../src/features/files/save';
import { cloudWrite, puterError } from '../src/features/files/cloud';
import type { Editor } from '../src/editor';

const editor = () => ({ preferences: { recentCount: 10 } }) as unknown as Editor;
const g = globalThis as unknown as { window?: unknown };
let failure: unknown;

describe('Puter errors', () => {
  beforeEach(() => {
    setLocalStore(new MemoryStore());
    clearRecent(editor());
    g.window = {
      puter: {
        fs: {
          read: () => Promise.reject(failure),
          write: () => Promise.reject(failure),
        },
      },
    };
  });
  afterEach(() => delete g.window);

  it('turns error objects into Errors with their message', () => {
    expect(
      puterError({ code: 'storage_limit_reached', message: 'Not enough storage.' }).message,
    ).toBe('Not enough storage.');
    expect(puterError({ error: { code: 'forbidden', message: 'Access denied.' } }).message).toBe(
      'Access denied.',
    );
    expect(puterError({}).message).toBe('Puter could not complete the request.');
    const own = new Error('mine');
    expect(puterError(own)).toBe(own);
  });

  it('reports a failed write with the service message', async () => {
    failure = { code: 'storage_limit_reached', message: 'Not enough storage.' };
    await expect(cloudWrite('/me/a.photo', new Blob(['x']))).rejects.toThrow('Not enough storage.');
  });

  it('removes an Open Recent entry whose Puter file is gone', async () => {
    const e = editor();
    noteRecent(e, 'kept.psd', { kind: 'puter', path: '/me/kept.psd' });
    noteRecent(e, 'gone.psd', { kind: 'puter', path: '/me/gone.psd' });
    failure = { code: 'subject_does_not_exist', message: 'File or directory not found.' };
    await expect(openRecentEntry(e, recentEntries()[0])).rejects.toThrow(
      'gone.psd is no longer at /me/gone.psd and was removed from Open Recent.',
    );
    expect(recentEntries().map((x) => x.name)).toEqual(['kept.psd']);
    // Other failures (offline, no permission) keep the entry.
    failure = { code: 'forbidden', message: 'Access denied.' };
    await expect(openRecentEntry(e, recentEntries()[0])).rejects.toThrow('Access denied.');
    expect(recentEntries().map((x) => x.name)).toEqual(['kept.psd']);
  });
});
