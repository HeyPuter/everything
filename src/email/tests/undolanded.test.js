import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';

/**
 * Undo pressed after opening the folder the message was filed in. That folder
 * listed the file under an entry of its own, and the undo has to take it out
 * of there as well as put it back where it came from.
 */

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
let root;
const mount = () => {
  const { fs, mailPath, objectsPath } = createSampleMailbox();
  renderApp(root, { fs, mailPath, objectsPath, sample: true, account: { username: 'sample' } });
};
const openFolder = async (label) => {
  [...root.querySelectorAll('.nav-item')].find((i) => i.textContent.includes(label)).click();
  await settle();
};
const subjects = () => [...root.querySelectorAll('.row')].filter((row) => !row.hidden)
  .map((row) => row.querySelector('.row-subject').textContent);
const rowFor = (s) => [...root.querySelectorAll('.row')].find((r) => r.querySelector('.row-subject').textContent === s);
const actOn = async (s, label) => {
  [...rowFor(s).querySelectorAll('.row-action')].find((b) => (b.getAttribute('aria-label') || '').startsWith(label)).click();
  await settle();
};
const SUBJECT = 'Welcome to your Puter mailbox';
beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  root.remove();
  document.querySelectorAll('.toast, .modal-root').forEach((node) => node.remove());
});

describe('undo after looking in the destination folder', () => {
  it('takes the row out of Archive when the archive is undone from there', async () => {
    mount();
    await settle();
    await actOn(SUBJECT, 'Archive');
    const undoBtn = [...document.querySelectorAll('.toast-action')].pop();
    await openFolder('Archive');
    expect(subjects()).toEqual([SUBJECT]);
    undoBtn.click();
    await settle();
    // The file is back in the inbox...
    await openFolder('Inbox');
    expect(subjects()).toContain(SUBJECT);
    // ...and no longer in Archive.
    await openFolder('Archive');
    expect(subjects()).toEqual([]);
  });

  it('while still looking at Archive', async () => {
    mount();
    await settle();
    await actOn(SUBJECT, 'Archive');
    const undoBtn = [...document.querySelectorAll('.toast-action')].pop();
    await openFolder('Archive');
    expect(subjects()).toEqual([SUBJECT]);
    undoBtn.click();
    await settle();
    expect(subjects()).toEqual([]);
  });
});
