import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';
import { createDraftStore } from '../src/lib/drafts.js';
import { memoryStorage } from '../src/lib/readstate.js';

/**
 * Signing out renders the gate over the same root. Whatever the shell hung on
 * the document, the window or a media query has to come off with it, or it
 * holds the whole shell -- every listing, the index, the last search -- for
 * as long as the page stays open.
 */

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

let root;
beforeEach(() => {
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
});
afterEach(() => {
  root.remove();
  vi.restoreAllMocks();
});

describe('a shell that leaves the page', () => {
  it('takes its document, window and media-query listeners with it', async () => {
    const added = [];
    const removed = [];
    const watchTarget = (target, label) => {
      const add = target.addEventListener;
      vi.spyOn(target, 'addEventListener').mockImplementation(function (type, fn, options) {
        added.push({ label, type, fn, signal: options?.signal ?? null });
        return add.call(this, type, fn, options);
      });
      const remove = target.removeEventListener;
      vi.spyOn(target, 'removeEventListener').mockImplementation(function (type, fn, options) {
        removed.push(fn);
        return remove.call(this, type, fn, options);
      });
    };
    watchTarget(document, 'document');
    watchTarget(window, 'window');
    const media = window.matchMedia;
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
      const list = media.call(window, query);
      watchTarget(list, `media ${query}`);
      return list;
    });

    const mailbox = createSampleMailbox();
    renderApp(root, {
      ...mailbox,
      account: { username: 'tester' },
      events: { onLocal: async () => ({ off: async () => {} }) },
      drafts: createDraftStore('tester', memoryStorage()),
      onCompose: () => {},
    });
    await settle();
    const types = (label) => added.filter((entry) => entry.label === label).map((entry) => entry.type);
    expect(types('document')).toEqual(expect.arrayContaining(['keydown', 'visibilitychange']));
    expect(types('window')).toEqual(expect.arrayContaining(['online', 'offline']));
    expect(added.some((entry) => entry.label.startsWith('media'))).toBe(true);
    const shell = [...added];

    root.replaceChildren(document.createElement('div'));
    await settle(0);
    // Each is gone: aborted through its signal, or taken off by hand.
    for (const entry of shell) {
      expect(entry.signal?.aborted || removed.includes(entry.fn), `${entry.label} ${entry.type}`).toBe(true);
    }
  });
});
