import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';
import { createMailbox } from '../src/lib/mailbox.js';

/**
 * A folder listed again while a move or an undo is in flight -- Refresh, a
 * gap in the watch, a sent copy filed -- builds entries of its own for the
 * files it finds. What the move or the undo does when it lands has to find
 * those entries by the file, not by the object it started with.
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
  document.querySelectorAll('.toast').forEach((node) => node.remove());
});

const subjects = () => [...root.querySelectorAll('.row')].filter((r) => !r.hidden)
  .map((row) => row.querySelector('.row-subject').textContent);

describe('a re-listing while a move is in flight', () => {
  it('remove() of an entry from before the listing takes out the listed one', async () => {
    const { fs, objectsPath } = createSampleMailbox();
    const box = createMailbox({ fs, objectsPath });
    await box.open();
    const old = box.messages[0];
    await box.open(); // refresh: new entry objects for the same files
    box.remove(old);  // the move of `old` finishes afterwards
    expect(box.find(old.name)).toBe(null);
    expect(box.messages.map((m) => m.name)).not.toContain(old.name);
  });

  it('an archived row does not come back after a refresh raced the move', async () => {
    const { fs, mailPath, objectsPath } = createSampleMailbox();
    let release;
    const gate = new Promise((r) => { release = r; });
    const move = fs.move.bind(fs);
    fs.move = async (...args) => { await gate; return move(...args); };
    renderApp(root, { fs, mailPath, objectsPath, sample: true, account: { username: 'sample' } });
    await settle();
    const first = root.querySelector('.row');
    const subject = first.querySelector('.row-subject').textContent;
    [...first.querySelectorAll('.row-action')]
      .find((b) => (b.getAttribute('aria-label') || '').startsWith('Archive')).click();
    await settle(50);
    root.querySelector('.list-toolbar .icon-btn[aria-label="Refresh this folder"]').click();
    await settle();
    release();
    await settle();
    // The file is in archive/ now; the inbox must not list it.
    const listed = (await fs.readdir(objectsPath)).length;
    expect(listed).toBeGreaterThan(0);
    expect(subjects()).not.toContain(subject);
    // and a later re-render (e.g. switching folders and back) still agrees
    [...root.querySelectorAll('.nav-item')].find((i) => i.textContent.includes('Starred')).click();
    await settle();
    [...root.querySelectorAll('.nav-item')].find((i) => i.textContent.includes('Inbox')).click();
    await settle();
    expect(subjects()).not.toContain(subject);
  });
});
