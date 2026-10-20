import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openCompose } from '../src/ui/compose.js';
import { createDraftStore } from '../src/lib/drafts.js';
import { memoryStorage } from '../src/lib/readstate.js';
import { MAX_ATTACHMENT_BYTES } from '../src/lib/compose.js';

/**
 * Attachments share one cap. A file refused for its size takes up none of it.
 */

let drafts;
let modals;
const ready = (extra = {}) => {
  const modal = openCompose({ username: 'test', mailPath: '/test/.mail', drafts,
    prefill: { to: 'a@example.com', subject: 'Report', body: 'Here are the figures.' }, ...extra });
  modals.push(modal);
  return modal;
};
const submit = (modal) => modal.panel.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
const drop = (modal, files) => {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  event.dataTransfer = { types: ['Files'], files };
  modal.panel.querySelector('form').dispatchEvent(event);
};
const small = { name: 'notes.txt', size: 3, type: 'text/plain', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };

beforeEach(() => {
  modals = [];
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('puter', { ui: {}, APIOrigin: 'https://api.example', authToken: 'test', fs: { write: async () => {} } });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  drafts = createDraftStore('test', memoryStorage());
});
afterEach(() => {
  modals.forEach((modal) => modal.close(true));
  document.querySelectorAll('.modal-root, .toast').forEach((node) => node.remove());
  vi.unstubAllGlobals();
});

describe('attachment size cap', () => {
  it('a rejected oversized file does not use up the budget of the files after it', async () => {
    const modal = ready();
    drop(modal, [{ name: 'video.mov', size: MAX_ATTACHMENT_BYTES + 1, type: 'video/quicktime', arrayBuffer: vi.fn() }]);
    // The 3-byte file is well inside the cap on its own.
    drop(modal, [small]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const chips = [...modal.panel.querySelectorAll('.compose-attachments .chip')];
    expect(chips.map((chip) => chip.classList.contains('is-error'))).toEqual([true, false]);
  });

  it('after removing the oversized file, the small one can be sent', async () => {
    const modal = ready();
    drop(modal, [{ name: 'video.mov', size: MAX_ATTACHMENT_BYTES + 1, type: 'video/quicktime', arrayBuffer: vi.fn() }]);
    drop(modal, [small]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    modal.panel.querySelector('[aria-label="Remove video.mov"]').click();
    submit(modal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  });
});
