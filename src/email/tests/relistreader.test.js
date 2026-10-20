import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';
import { createDraftStore } from '../src/lib/drafts.js';
import { memoryStorage } from '../src/lib/readstate.js';
import { subjectFromFilename } from '../src/lib/mime.js';
import { locate, planChanges, mailSubject } from '../src/lib/watch.js';

/**
 * A folder listed again under the reader -- a gap in the watch, a change from
 * another device -- builds new entries for the same files. What is open and
 * what is ticked, in the folder or in a search over it, carries on over the
 * new entries without being closed or cleared, and acting on it still works.
 *
 * Set up like watch.test.js: a real account with a fake Events API.
 */

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
// Past the half-second the shell gathers events for, plus a listing.
const acted = () => settle(900);

const MAIL = '/sample/.mail';

const LATE = [
  'From: Ana Petrova <ana@example.com>',
  'To: sample@puter.com',
  'Subject: Late arrival',
  'Date: Mon, 17 Aug 2026 10:30:00 GMT',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'One more thing before the quarter closes.',
].join('\r\n');

/** A fake `puter.events`: records subscriptions and lets a test fire events. */
const fakeEvents = () => {
  const calls = [];
  const events = {
    calls,
    failWith: null,
    async onLocal(subject, handler, options = {}) {
      if (events.failWith) throw events.failWith;
      const sub = { subId: `sub-${calls.length}`, subject, off: vi.fn(async () => {}) };
      calls.push({ subject, handler, options, sub });
      return sub;
    },
    /** What the server would deliver to the subscription standing now. */
    emit: (event) => calls.at(-1)?.handler({ event }),
  };
  return events;
};

let root;
let mailbox;
let events;

const mount = async ({ sample = false } = {}) => {
  mailbox = createSampleMailbox();
  events = fakeEvents();
  renderApp(root, {
    ...mailbox,
    sample,
    events,
    account: { username: sample ? 'sample' : 'tester' },
    ...(sample ? {} : {
      drafts: createDraftStore('tester', memoryStorage()),
      onCompose: () => {},
    }),
  });
  await settle();
};

// Subjects of single-message conversations in the sample inbox: the sample
// also carries a three-message thread, and a test that picked a row by
// position could land on it, where losing one message does not lose the row.
const RECEIPT = 'Your receipt from Nimbus Coffee';
const REPORT = 'Q3 usage report attached';
const NOTES = 'Notes from the roadmap session';

const rows = () => [...root.querySelectorAll('.row')].filter((row) => !row.hidden);
const subjects = () => rows().map((row) => row.querySelector('.row-subject').textContent);
const rowFor = (subject) => rows().find((row) => row.querySelector('.row-subject').textContent === subject);
const pill = () => root.querySelector('.new-mail');

const openFolder = async (label) => {
  [...root.querySelectorAll('.nav-item')]
    .find((item) => item.textContent.includes(label))
    .click();
  await settle(250);
};

const actOn = async (subject, label) => {
  [...rowFor(subject).querySelectorAll('.row-action')]
    .find((button) => (button.getAttribute('aria-label') || '').startsWith(label))
    .click();
  await settle(250);
};

/** Every message file in a folder, as the fs lists it. */
const filesIn = async (dir) => {
  const { fs } = mailbox;
  const days = (await fs.readdir(dir)).filter((item) => item.is_dir).map((item) => item.name).sort();
  const files = [];
  for (const day of days) {
    for (const item of await fs.readdir(`${dir}/${day}`)) if (!item.is_dir) files.push({ ...item, day });
  }
  return files;
};

const fileFor = async (subject, dir = mailbox.objectsPath) =>
  (await filesIn(dir)).find((item) => subjectFromFilename(item.name) === subject);

// Delivered the way emailrx does it: a file that sorts above every real uuid
// v7, in the newest day folder. Returns the path, without telling anyone.
const land = async (raw = LATE, subject = 'Late arrival') => {
  const { fs, objectsPath } = mailbox;
  const days = (await fs.readdir(objectsPath))
    .filter((item) => item.is_dir).map((item) => item.name).sort();
  const name = `ffffffff-ffff-7fff-8fff-ffffffffffff--${btoa(subject).replace(/=+$/, '')}`;
  const path = `${objectsPath}/${days.at(-1)}/${name}`;
  await fs.write(path, new Blob([raw]));
  return path;
};

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


describe('acting from a reader that outlived a re-listing', () => {
  it('archives the open message and takes its row away', async () => {
    await mount();
    rowFor(RECEIPT).click();
    await settle(500);
    const frame = root.querySelector('.app-frame');
    events.emit({ op: 'gap', reason: 'coalesce_limit' });
    await acted();
    expect(frame.classList.contains('reading')).toBe(true);
    root.querySelector('.msg-actions-bar [aria-label="Archive"]').click();
    await settle(500);
    expect(frame.classList.contains('reading')).toBe(false);
    expect(subjects()).not.toContain(RECEIPT);
    await openFolder('Archive');
    expect(subjects()).toEqual([RECEIPT]);
  });
});

describe('acting from a search result that outlived a re-listing', () => {
  it('archives the open result and takes it out of the results', async () => {
    await mount();
    const input = root.querySelector('.search-input');
    input.value = 'Nimbus';
    input.dispatchEvent(new Event('input'));
    await settle(800);
    rowFor(RECEIPT).click();
    await settle(500);
    const frame = root.querySelector('.app-frame');
    events.emit({ op: 'gap', reason: 'coalesce_limit' });
    await acted();
    expect(frame.classList.contains('reading')).toBe(true);
    root.querySelector('.msg-actions-bar [aria-label="Archive"]').click();
    await settle(500);
    expect(frame.classList.contains('reading')).toBe(false);
    expect(subjects()).not.toContain(RECEIPT);
  });
});

describe('a re-listing under an open search result', () => {
  it('keeps the message open when another device restores mail into the inbox', async () => {
    await mount();
    // Another device archives the report.
    const file = await fileFor(REPORT);
    const { path: archived } = await mailbox.fs.move(file.path, `${MAIL}/archive/${file.day}`);
    events.emit({ op: 'move', from: file.path, path: archived });
    await acted();
    expect(subjects()).not.toContain(REPORT);

    // Search, and open a result.
    const input = root.querySelector('.search-input');
    input.value = 'Nimbus';
    input.dispatchEvent(new Event('input'));
    await settle(800);
    expect(subjects()).toEqual([RECEIPT]);
    rowFor(RECEIPT).click();
    await settle(500);
    const frame = root.querySelector('.app-frame');
    expect(frame.classList.contains('reading')).toBe(true);

    // The other device puts the report back.
    const { path } = await mailbox.fs.move(archived, `${mailbox.objectsPath}/${file.day}`);
    events.emit({ op: 'move', from: archived, path });
    await acted();
    expect(frame.classList.contains('reading')).toBe(true);
  });

  it('keeps the message open across a gap', async () => {
    await mount();
    const input = root.querySelector('.search-input');
    input.value = 'Nimbus';
    input.dispatchEvent(new Event('input'));
    await settle(800);
    rowFor(RECEIPT).click();
    await settle(500);
    const frame = root.querySelector('.app-frame');
    events.emit({ op: 'gap', reason: 'coalesce_limit' });
    await acted();
    expect(frame.classList.contains('reading')).toBe(true);
  });

  it('keeps a ticked result ticked across a gap, and acts on it', async () => {
    await mount();
    const input = root.querySelector('.search-input');
    input.value = 'Nimbus';
    input.dispatchEvent(new Event('input'));
    await settle(800);
    rowFor(RECEIPT).querySelector('.row-check').click();
    await settle(100);
    events.emit({ op: 'gap', reason: 'coalesce_limit' });
    await acted();
    expect(rowFor(RECEIPT).querySelector('.row-check').checked).toBe(true);
    expect(root.querySelector('.list-actions').hidden).toBe(false);
    [...root.querySelectorAll('.list-actions button')]
      .find((button) => (button.getAttribute('aria-label') || button.textContent).startsWith('Archive')).click();
    await settle(500);
    expect(subjects()).not.toContain(RECEIPT);
    await openFolder('Archive');
    expect(subjects()).toEqual([RECEIPT]);
  });
});
