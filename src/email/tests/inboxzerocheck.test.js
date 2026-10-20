import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';
import { createDraftStore } from '../src/lib/drafts.js';
import { memoryStorage } from '../src/lib/readstate.js';

/**
 * A check for new mail that fails once is not the inbox never having been
 * read: the next one checks as usual, wherever the reader is.
 */

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
const LATE = [
  'From: Ana Petrova <ana@example.com>',
  'To: sample@puter.com',
  'Subject: Late arrival',
  'Date: Mon, 17 Aug 2026 10:30:00 GMT',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'One more thing.',
].join('\r\n');

let root;
let mailbox;
let broken = false;
beforeEach(() => {
  window.localStorage.clear();
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
});
afterEach(() => {
  root.remove();
  document.querySelectorAll('.toast').forEach((node) => node.remove());
});

const openFolder = async (label) => {
  [...root.querySelectorAll('.nav-item')].find((item) => item.textContent.includes(label)).click();
  await settle(400);
};

describe('inbox zero, then one failed check', () => {
  it('still notices new mail while another folder is open', async () => {
    mailbox = createSampleMailbox();
    // Like Puter: an emptied objects folder is still a folder.
    const fs = {
      ...mailbox.fs,
      readdir: async (path, ...rest) => {
        if (broken) throw new Error('offline');
        try {
          return await mailbox.fs.readdir(path, ...rest);
        } catch (error) {
          if (path === mailbox.objectsPath) return [];
          throw error;
        }
      },
    };
    renderApp(root, {
      ...mailbox, fs, sample: false, account: { username: 'tester' },
      drafts: createDraftStore('tester', memoryStorage()), onCompose: () => {},
    });
    await settle(600);
    const box = root.querySelector('.select-all');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await settle(50);
    root.querySelector('.list-actions [aria-label="Archive"]').click();
    await settle(800);
    expect([...root.querySelectorAll('.row')].filter((row) => !row.hidden)).toHaveLength(0);

    // One check fails (a blip).
    broken = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await settle(400);
    broken = false;

    await openFolder('Archive');

    // Mail is delivered to the inbox.
    const { objectsPath } = mailbox;
    const name = `ffffffff-ffff-7fff-8fff-ffffffffffff--${btoa('Late arrival').replace(/=+$/, '')}`;
    await mailbox.fs.write(`${objectsPath}/2099-01-01/${name}`, new Blob([LATE]));
    for (let i = 0; i < 3; i++) {
      document.dispatchEvent(new Event('visibilitychange'));
      await settle(500);
    }
    expect(document.title).toMatch(/\(1\)/);
  });
});
