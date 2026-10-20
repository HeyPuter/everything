import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';
import { createDraftStore } from '../src/lib/drafts.js';
import { memoryStorage } from '../src/lib/readstate.js';
import { createMailbox } from '../src/lib/mailbox.js';

/**
 * A first listing that never answered -- cancelled because the reader went to
 * another folder, or failed -- is not a boundary to look for new mail above.
 * What it would have shown was there all along, and is not news.
 */

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
let root;
beforeEach(() => {
  window.localStorage.clear();
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
});
afterEach(() => {
  root.remove();
  document.querySelectorAll('.toast').forEach((node) => node.remove());
  window.localStorage.clear();
});

describe('leaving the inbox before its first listing finishes', () => {
  it('a sync after a cancelled first listing reports no arrivals', async () => {
    const { fs, objectsPath } = createSampleMailbox();
    const box = createMailbox({ fs, objectsPath });
    const opening = box.open();
    box.cancelLoad();
    await opening;
    // Nothing new has been delivered.
    expect(await box.sync()).toEqual([]);
    expect(box.messages.length).toBeGreaterThan(0);
  });

  it('a sync after a failed first listing reports no arrivals', async () => {
    const { fs, objectsPath } = createSampleMailbox();
    let broken = true;
    const flaky = { ...fs, readdir: (...args) => (broken ? Promise.reject(new Error('offline')) : fs.readdir(...args)) };
    const box = createMailbox({ fs: flaky, objectsPath });
    await box.open();
    expect(box.listError).toBeTruthy();
    broken = false;
    expect(await box.sync()).toEqual([]);
    expect(box.messages.length).toBeGreaterThan(0);
  });

  it('still announces the first mail into a mailbox that had none', async () => {
    const { fs, objectsPath } = createSampleMailbox();
    const missing = Object.assign(new Error('missing'), { code: 'subject_does_not_exist' });
    let empty = true;
    const fresh = { ...fs, readdir: (...args) => (empty ? Promise.reject(missing) : fs.readdir(...args)) };
    const box = createMailbox({ fs: fresh, objectsPath });
    await box.open();
    empty = false;
    expect((await box.sync()).length).toBeGreaterThan(0);
  });

  it('old mail is not announced as new mail', async () => {
    const mailbox = createSampleMailbox();
    const { fs, objectsPath } = mailbox;
    const readdir = fs.readdir.bind(fs);
    let slow = true;
    fs.readdir = async (path, ...rest) => {
      if (slow && path === objectsPath) await settle(200);
      return readdir(path, ...rest);
    };
    renderApp(root, {
      ...mailbox, sample: false, account: { username: 'tester' },
      drafts: createDraftStore('tester', memoryStorage()), onCompose: () => {},
    });
    // Straight to Archive while the inbox is still being listed.
    await settle(20);
    [...root.querySelectorAll('.nav-item')].find((i) => i.textContent.includes('Archive')).click();
    await settle(400);
    slow = false;
    // The tab comes back into view: the app checks for new mail.
    document.dispatchEvent(new Event('visibilitychange'));
    await settle(600);
    const pill = root.querySelector('.new-mail');
    expect(pill.hidden ? '' : pill.textContent).toBe('');
  });
});
