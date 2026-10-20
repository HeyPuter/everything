import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openCompose } from '../src/ui/compose.js';
import { createDraftStore } from '../src/lib/drafts.js';
import { createDraftFileStore } from '../src/lib/draftfiles.js';
import { memoryStorage } from '../src/lib/readstate.js';

/**
 * A file attached to a message is saved on the device as soon as it is read.
 * Whatever way the message ends without a draft to show for it, the bytes go
 * with it, as the README promises for a sent or discarded draft.
 */

let drafts;
const drop = (modal, files) => {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  event.dataTransfer = { types: ['Files'], files };
  modal.panel.querySelector('form').dispatchEvent(event);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
// Every draft id that has bytes in the attachment store.
const storedIds = () => new Promise((resolve) => {
  const req = indexedDB.open('puter-mail-draft-files', 1);
  req.onsuccess = () => {
    const tx = req.result.transaction('files', 'readonly');
    const keys = tx.objectStore('files').getAllKeys();
    keys.onsuccess = () => {
      resolve(keys.result.map((key) => key[1]));
      req.result.close();
    };
  };
});

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('puter', { ui: {}, APIOrigin: 'https://api.example', authToken: 'test', fs: { write: async () => {} } });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  drafts = createDraftStore('test', memoryStorage());
});
afterEach(() => {
  document.querySelectorAll('.modal-root, .toast').forEach((node) => node.remove());
  vi.unstubAllGlobals();
});

describe('attachment bytes outlive their draft', () => {
  it('a forward opened and closed untouched leaves no attachment bytes behind', async () => {
    const modal = openCompose({ username: 'test', mailPath: '/test/.mail', drafts, prefill: {
      kind: 'forward', subject: 'Fwd: Contract', body: '\n\n---------- Forwarded message ----------\nFrom: x',
      attachments: [{ filename: 'contract.pdf', type: 'application/pdf', read: async () => new Uint8Array([1, 2, 3]) }],
    } });
    await settle();
    modal.close();
    await settle();
    expect(drafts.count).toBe(0); // no row in Drafts...
    // Writes are queued in order; the removal lands after any save before it.
    await vi.waitFor(async () => expect(await storedIds()).toEqual([]), { timeout: 5000 }); // ...and no bytes nobody can reach
  });

  it('discarding a new message right after attaching a file removes the file bytes', async () => {
    const modal = openCompose({ username: 'test', mailPath: '/test/.mail', drafts, prefill: null });
    drop(modal, [{ name: 'scan.pdf', size: 3, type: 'application/pdf', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }]);
    // The read has landed and the file save is in flight; the text save has not run.
    await vi.waitFor(() => expect(modal.panel.querySelector('.compose-save-state').textContent).toBe('Saving attachments…'), { interval: 0 });
    modal.panel.querySelector('[aria-label="Discard draft"]').click();
    await settle();
    expect(drafts.count).toBe(0);
    // Writes are queued in order; the removal lands after any save before it.
    await vi.waitFor(async () => expect(await storedIds()).toEqual([]), { timeout: 5000 });
  });
});
