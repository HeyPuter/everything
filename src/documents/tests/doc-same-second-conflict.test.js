import { it, expect, beforeEach, afterEach, vi } from 'vitest';

// The drive's time stamps count whole seconds. Another window's save in the same second as this window's last
// one left the file's time stamp as this window knew it, and this window's next save wrote over it unseen.
let second = 100, failAfterWrite = 0;
const fs = new Map();
vi.mock('../src/lib/puter.js', async (importOriginal) => {
  const real = await importOriginal();
  const put = (path, blob) => { fs.set(path, { blob, modified: second }); return { path, modified: second, size: blob.size }; };
  return {
    ...real,
    writeFile: vi.fn(async (path, blob) => {
      const item = put(path, blob);
      if (failAfterWrite > 0) { failAfterWrite--; throw new TypeError('Failed to fetch'); }
      return item;
    }),
    statFile: vi.fn(async path => (fs.has(path) ? { path, modified: fs.get(path).modified, size: fs.get(path).blob.size } : null)),
    readFile: vi.fn(async path => fs.get(path).blob),
  };
});

const { Doc, versioning, publishing, RETRY_MS } = await import('../src/lib/doc.js');

beforeEach(() => {
  vi.useFakeTimers();
  versioning.enabled = false; publishing.enabled = false;
  fs.clear(); second = 100; failAfterWrite = 0;
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function opened(text = 'opened') {
  const blob = new Blob([text]);
  fs.set('Documents/Plan.docx', { blob, modified: second });
  const doc = new Doc({ name: 'Plan', path: 'Documents/Plan.docx', blob, modified: second });
  return doc;
}

it('does not write over another window\'s save made in the same second as its own', async () => {
  const doc = opened();
  let content = 'mine';
  doc.attach(async () => new Blob([content]));
  doc.changed();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await fs.get('Documents/Plan.docx').blob.text()).toBe('mine');
  // Another window saves its own edits within the same second.
  fs.set('Documents/Plan.docx', { blob: new Blob(['theirs, longer']), modified: second });
  const conflicts = [];
  doc.addEventListener('conflict', e => conflicts.push(e.detail.message));
  content = 'mine, edited';
  doc.changed();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await fs.get('Documents/Plan.docx').blob.text()).toBe('theirs, longer');
  expect(conflicts).toHaveLength(1);
  expect(doc.status).toBe('error');
});

it('goes on saving over its own writes in the same second, and its own write whose answer was lost', async () => {
  const doc = opened();
  let content = 'first';
  doc.attach(async () => new Blob([content]));
  const conflicts = [];
  doc.addEventListener('conflict', e => conflicts.push(e.detail.message));
  for (const text of ['first edit', 'a second, longer edit', 'third']) {
    content = text; doc.changed();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await fs.get('Documents/Plan.docx').blob.text()).toBe(text);
  }
  // A write of another size lands, but its answer is lost: the retry recognises it as this window's own.
  content = 'fourth, whose answer is lost'; failAfterWrite = 1; doc.changed();
  await vi.advanceTimersByTimeAsync(2000);
  expect(doc.status).toBe('error');
  content = 'fifth'; doc.changed();
  await vi.advanceTimersByTimeAsync(RETRY_MS + 2000);
  expect(conflicts).toEqual([]);
  expect(doc.status).toBe('saved');
  expect(await fs.get('Documents/Plan.docx').blob.text()).toBe('fifth');
});
