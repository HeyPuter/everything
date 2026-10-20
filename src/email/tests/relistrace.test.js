import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';
import { createMailbox } from '../src/lib/mailbox.js';
import { subjectFromFilename } from '../src/lib/mime.js';

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

describe('a re-listing while an undo is in flight', () => {
  it('insert() of the old entry after a re-listing found the file lists it once', async () => {
    const { fs, objectsPath } = createSampleMailbox();
    const box = createMailbox({ fs, objectsPath });
    await box.open();
    const old = box.messages[0];
    box.remove(old);          // archived
    await box.open();         // the undo's move has landed; a refresh lists it again
    box.insert(old);          // the undo's bookkeeping runs afterwards
    expect(box.messages.filter((m) => m.name === old.name)).toHaveLength(1);
  });
});

describe('refresh racing an undo', () => {
  it('shows the restored conversation once', async () => {
    const { fs, mailPath, objectsPath } = createSampleMailbox();
    renderApp(root, { fs, mailPath, objectsPath, sample: true, account: { username: 'sample' } });
    await settle();
    const before = subjects().length;
    const first = root.querySelector('.row');
    const subject = first.querySelector('.row-subject').textContent;
    [...first.querySelectorAll('.row-action')]
      .find((b) => (b.getAttribute('aria-label') || '').startsWith('Archive')).click();
    await settle();
    expect(subjects()).not.toContain(subject);
    // Undo, with the move back slow enough for a refresh to land after the
    // file is back but before the undo's bookkeeping.
    const move = fs.move.bind(fs);
    let release;
    const gate = new Promise((r) => { release = r; });
    fs.move = async (...args) => { const out = await move(...args); await gate; return out; };
    [...document.querySelectorAll('.toast button')].find((b) => b.textContent === 'Undo').click();
    await settle(50);
    root.querySelector('.list-toolbar .icon-btn[aria-label="Refresh this folder"]').click();
    await settle();
    release();
    await settle();
    expect(subjects().filter((s) => s === subject)).toHaveLength(1);
    expect(subjects()).toHaveLength(before);
  });
});

describe('opening the folder a conversation is being moved into', () => {
  it('keeps the conversation listed there once the move lands', async () => {
    const { fs, mailPath, objectsPath } = createSampleMailbox();
    const move = fs.move.bind(fs);
    // The replies in the conversation take a while to move.
    fs.move = async (path, ...rest) => {
      if (subjectFromFilename(path.split('/').pop()).startsWith('Re: Thursday')) await settle(1500);
      return move(path, ...rest);
    };
    renderApp(root, { fs, mailPath, objectsPath, sample: true, account: { username: 'sample' } });
    await settle();
    const row = [...root.querySelectorAll('.row')]
      .find((candidate) => candidate.querySelector('.row-subject').textContent.includes('Thursday walkthrough'));
    row.querySelector('.row-check').click();
    await settle(50);
    root.querySelector('.list-actions [aria-label="Archive"]').click();
    await settle(200);
    [...root.querySelectorAll('.nav-item')].find((item) => item.textContent.includes('Archive')).click();
    await settle(2200);
    expect(subjects().some((subject) => subject.includes('Thursday walkthrough'))).toBe(true);
  });
});
