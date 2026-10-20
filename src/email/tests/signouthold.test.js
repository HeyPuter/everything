import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openCompose, closeComposers, isDraftSending } from '../src/ui/compose.js';

/**
 * Signing out closes every composer first. A message held for Undo Send is
 * past its composer, and has to be given back to Drafts the way leaving the
 * page gives it back -- not posted once the hold runs out.
 */

const draftStore = () => {
  const held = new Map();
  return {
    list: () => [...held.values()],
    get: (id) => held.get(id) ?? null,
    get count() { return held.size; },
    save(draft) {
      held.set(draft.id, draft);
      return true;
    },
    remove(id) { return held.delete(id); },
  };
};
let posts;
let drafts;
beforeEach(() => {
  vi.useFakeTimers();
  posts = [];
  drafts = draftStore();
  vi.stubGlobal('puter', { ui: {}, APIOrigin: 'https://api.example', authToken: 't', fs: { write: async () => {} } });
  vi.stubGlobal('fetch', async (url, init) => {
    posts.push({ url, body: init.body, auth: init.headers.authorization });
    return { ok: true, json: async () => ({}) };
  });
});
afterEach(() => {
  vi.useRealTimers();
  document.querySelectorAll('.modal-root, .toast, .toast-region, .compose-dock').forEach((node) => node.remove());
  vi.unstubAllGlobals();
});

describe('sign-out during an Undo Send hold', () => {
  it('signing out gives the held message back to Drafts instead of posting it afterwards', async () => {
    const modal = openCompose({ username: 'me', mailPath: '/me/.mail', prefill: null, drafts, undoSend: 5 });
    const input = modal.panel.querySelector('#compose-to');
    input.value = 'ana@example.com';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    modal.panel.querySelector('#compose-subject').value = 'Numbers';
    modal.panel.querySelector('.compose-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(isDraftSending({ username: 'me', mailPath: '/me/.mail', id: drafts.list()[0].id })).toBe(true);

    // main.js signOut(): closeComposers() then puter.auth.signOut().
    expect(closeComposers()).toBe(true);
    puter.authToken = null;
    await vi.advanceTimersByTimeAsync(6000);
    expect(posts).toEqual([]);
    expect(drafts.count).toBe(1);
  });
});
