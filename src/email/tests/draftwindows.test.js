import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDraftStore } from '../src/lib/drafts.js';
import { memoryStorage } from '../src/lib/readstate.js';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';

/**
 * Two windows of the app over the same browser storage. Saving already merged
 * against the stored drafts; reading has to follow them too.
 */

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
const draft = (over = {}) => ({ id: 'a', to: 'a@b.co', cc: '', subject: 'Hi', body: 'text', ...over });

describe('drafts written from another app window', () => {
  it('are what list() and get() answer with', () => {
    const storage = memoryStorage();
    const windowA = createDraftStore('me', storage);
    const windowB = createDraftStore('me', storage);
    windowA.save(draft({ body: 'first version' }));
    // Later, in the other window: the draft is finished off, and another started.
    windowB.save(draft({ body: 'second version, much longer' }));
    windowB.save(draft({ id: 'b', subject: 'Another' }));
    expect(windowA.get('a').body).toBe('second version, much longer');
    expect(windowA.list().map((entry) => entry.id).sort()).toEqual(['a', 'b']);
    expect(windowA.count).toBe(2);
  });

  describe('ui', () => {
    let root;
    beforeEach(() => {
      root = document.createElement('div');
      root.id = 'app';
      document.body.append(root);
    });
    afterEach(() => {
      root.remove();
      document.querySelectorAll('.toast').forEach((node) => node.remove());
    });
    it('Refresh in Drafts shows a draft saved from another window', async () => {
      const storage = memoryStorage();
      const drafts = createDraftStore('sample', storage);
      drafts.save(draft({ subject: 'Old subject' }));
      renderApp(root, {
        ...createSampleMailbox(), sample: true, account: { username: 'sample' }, drafts, onCompose: () => {},
      });
      await settle();
      [...root.querySelectorAll('.nav-item')].find((item) => item.textContent.includes('Drafts')).click();
      await settle();
      createDraftStore('sample', storage).save(draft({ id: 'b', subject: 'From the other window' }));
      root.querySelector('.list-toolbar .icon-btn[aria-label="Refresh this folder"]').click();
      await settle();
      const subjects = [...root.querySelectorAll('.row')].map((row) => row.querySelector('.row-subject').textContent);
      expect(subjects).toContain('From the other window');
    });
  });
});
