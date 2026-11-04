import { it, expect, beforeEach, afterEach, vi } from 'vitest';

let failing = true;
const writes = [];
vi.mock('../src/lib/puter.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    writeFile: vi.fn(async (path) => { writes.push(Date.now()); if (failing) throw new Error('Storage quota exceeded'); return { path, modified: writes.length + 1 }; }),
    statFile: vi.fn(async path => ({ path, modified: writes.length + 1 })),
  };
});

const { Doc, versioning, publishing, RETRY_MS, MAX_RETRY_MS, needsUnloadWarning } = await import('../src/lib/doc.js');

beforeEach(() => {
  vi.useFakeTimers();
  versioning.enabled = false; publishing.enabled = false;
  writes.length = 0; failing = true;
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const minutes = n => n * 60_000;

/**
 * A save that keeps failing (storage full) used to be tried again every 8 seconds for as long as the document stayed
 * open, exporting all of it each time, also with nobody at the keyboard. The pause doubles up to a few minutes; an edit,
 * coming back online and a successful save start it over, and Save tries at once.
 */
it('waits longer between retries of a save that keeps failing, and starts over after an edit', async () => {
  const doc = new Doc({ name: 'Plan', path: 'Documents/Plan.docx' });
  doc.attach(async () => new Blob(['x']));
  doc.changed();
  await vi.advanceTimersByTimeAsync(minutes(30));
  // 8 s, 16 s, 32 s … up to the cap: a handful of tries in half an hour, not two hundred.
  expect(writes.length).toBeLessThan(14);
  expect(writes.length).toBeGreaterThan(6);
  const gaps = writes.slice(1).map((t, i) => t - writes[i]);
  expect(gaps[0]).toBe(RETRY_MS);
  expect(gaps[1]).toBe(RETRY_MS * 2);
  expect(Math.max(...gaps)).toBe(MAX_RETRY_MS);
  // The status and the leave warning still say the edits are not saved.
  expect(doc.status).toBe('error');
  expect(needsUnloadWarning(doc)).toBe(true);
  // An edit starts the pauses over.
  writes.length = 0;
  doc.changed();
  await vi.advanceTimersByTimeAsync(2000 + RETRY_MS);
  expect(writes.length).toBe(2);
  // Save tries at once, whatever the pause.
  await vi.advanceTimersByTimeAsync(minutes(10));
  writes.length = 0;
  failing = false;
  await doc.save();
  expect(writes.length).toBe(1);
  expect(doc.status).toBe('saved');
});

it('tries at once when the connection comes back, with the pauses started over', async () => {
  const doc = new Doc({ name: 'Plan', path: 'Documents/Plan.docx' });
  doc.attach(async () => new Blob(['x']));
  doc.changed();
  await vi.advanceTimersByTimeAsync(minutes(10));
  writes.length = 0;
  // What the app does on the browser's online event.
  doc.save({ auto: true, fresh: true }).catch(() => {});
  await vi.advanceTimersByTimeAsync(10);
  expect(writes.length).toBe(1);
  await vi.advanceTimersByTimeAsync(RETRY_MS + 10);
  expect(writes.length).toBe(2);
});
