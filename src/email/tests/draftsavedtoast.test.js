import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { openCompose } from '../src/ui/compose.js';
import { createDraftStore } from '../src/lib/drafts.js';
import { memoryStorage } from '../src/lib/readstate.js';

/** What closing a message says about its draft. */

let drafts;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('puter', { ui: {}, APIOrigin: 'https://api.example', authToken: 'test', fs: { write: async () => {} } });
  drafts = createDraftStore('test', memoryStorage());
});
afterEach(() => {
  vi.useRealTimers();
  document.querySelectorAll('.modal-root, .toast').forEach((node) => node.remove());
  vi.unstubAllGlobals();
});
const toasts = () => [...document.querySelectorAll('.toast')].map((node) => node.textContent);

describe('closing an emptied message', () => {
  it('does not say "Draft saved." when the draft was just thrown away for being empty', async () => {
    const modal = openCompose({ username: 'test', mailPath: '/test/.mail', drafts, prefill: null });
    const body = modal.panel.querySelector('.rte-body');
    body.innerHTML = '<div>Hi Ana</div>';
    body.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(700);
    expect(drafts.count).toBe(1);
    body.innerHTML = '<div><br></div>';
    body.dispatchEvent(new Event('input', { bubbles: true }));
    modal.close();
    expect(drafts.count).toBe(0);
    expect(toasts().some((text) => text.includes('Draft saved'))).toBe(false);
  });

  it('still says so when the draft was kept', async () => {
    const modal = openCompose({ username: 'test', mailPath: '/test/.mail', drafts, prefill: null });
    const body = modal.panel.querySelector('.rte-body');
    body.innerHTML = '<div>Hi Ana</div>';
    body.dispatchEvent(new Event('input', { bubbles: true }));
    modal.close();
    expect(drafts.count).toBe(1);
    expect(toasts().some((text) => text.includes('Draft saved'))).toBe(true);
  });
});
