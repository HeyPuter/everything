import { it, expect, beforeEach, afterEach, vi } from 'vitest';

let clock = 1, failAfterWrite = 0;
const fs = new Map();
vi.mock('../src/lib/puter.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    writeFile: vi.fn(async (path, blob) => {
      fs.set(path, { blob, modified: ++clock });
      // The write lands, but its answer never comes back (the connection dropped).
      if (failAfterWrite > 0) { failAfterWrite--; throw new TypeError('Failed to fetch'); }
      return { path, modified: clock };
    }),
    uniqueName: async base => { const stem = real.stripExtension(base); let name = `${stem}.docx`, n = 2; while (fs.has(`Documents/${name}`)) name = `${stem} ${n++}.docx`; return name; },
    createFileWithMetadata: vi.fn(async (path, blob) => {
      fs.set(path, { blob, modified: ++clock });
      if (failAfterWrite > 0) { failAfterWrite--; throw new TypeError('Failed to fetch'); }
      return { path, modified: clock };
    }),
    statFile: vi.fn(async path => (fs.has(path) ? { path, modified: fs.get(path).modified } : null)),
    readFile: vi.fn(async path => fs.get(path).blob),
  };
});

const { Doc, versioning, publishing, RETRY_MS } = await import('../src/lib/doc.js');

beforeEach(() => {
  vi.useFakeTimers();
  versioning.enabled = false; publishing.enabled = false;
  fs.clear(); clock = 1; failAfterWrite = 0;
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/**
 * A save whose write reached the drive but whose answer was lost left the file with a time stamp this window did not
 * know, so every later save took it for another window's change ("changed in another window") and stopped saving.
 */
it('recognises its own write whose answer was lost, and goes on saving', async () => {
  fs.set('Documents/Plan.docx', { blob: new Blob(['opened']), modified: 1 });
  const doc = new Doc({ name: 'Plan', path: 'Documents/Plan.docx', modified: 1 });
  let content = 'opened';
  doc.attach(async () => new Blob([content]));
  const conflicts = [];
  doc.addEventListener('conflict', e => conflicts.push(e.detail.message));
  content = 'first edit'; failAfterWrite = 1;
  doc.changed();
  await vi.advanceTimersByTimeAsync(2000);
  expect(doc.status).toBe('error');
  await vi.advanceTimersByTimeAsync(RETRY_MS + 100);
  expect(conflicts).toEqual([]);
  expect(doc.status).toBe('saved');
  expect(await fs.get('Documents/Plan.docx').blob.text()).toBe('first edit');
  // Edits after it save too.
  content = 'second edit';
  doc.changed();
  await vi.advanceTimersByTimeAsync(2000);
  expect(doc.status).toBe('saved');
  expect(await fs.get('Documents/Plan.docx').blob.text()).toBe('second edit');
});

it('still stops for a change another window made after a lost answer', async () => {
  fs.set('Documents/Plan.docx', { blob: new Blob(['opened']), modified: 1 });
  const doc = new Doc({ name: 'Plan', path: 'Documents/Plan.docx', modified: 1 });
  let content = 'mine';
  doc.attach(async () => new Blob([content]));
  const conflicts = [];
  doc.addEventListener('conflict', e => conflicts.push(e.detail.message));
  failAfterWrite = 1;
  doc.changed();
  await vi.advanceTimersByTimeAsync(2000);
  // Another window writes over it before the retry.
  fs.set('Documents/Plan.docx', { blob: new Blob(['theirs']), modified: ++clock });
  content = 'mine, edited';
  await vi.advanceTimersByTimeAsync(RETRY_MS + 100);
  expect(conflicts).toHaveLength(1);
  expect(await fs.get('Documents/Plan.docx').blob.text()).toBe('theirs');
});

it('does not make a second file when the answer to a new document\'s first save was lost', async () => {
  const doc = new Doc({ name: 'Notes' });
  let content = 'first';
  doc.attach(async () => new Blob([content]));
  failAfterWrite = 1;
  doc.changed();
  await vi.advanceTimersByTimeAsync(2000);
  expect(doc.status).toBe('error');
  expect([...fs.keys()]).toEqual(['Documents/Notes.docx']);
  content = 'first, then more';
  await vi.advanceTimersByTimeAsync(RETRY_MS + 100);
  expect(doc.status).toBe('saved');
  expect(doc.path).toBe('Documents/Notes.docx');
  expect([...fs.keys()]).toEqual(['Documents/Notes.docx']);
  expect(await fs.get('Documents/Notes.docx').blob.text()).toBe('first, then more');
});
