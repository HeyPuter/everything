import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Doc, publishing, versioning } from '../src/lib/doc.js';

const path = 'Documents/Report.docx';
let files, docs, modified;

beforeEach(() => {
  vi.useFakeTimers();
  docs = []; modified = 100;
  files = new Map([[path, { blob: new Blob(['original']), modified }]]);
  versioning.enabled = false; publishing.enabled = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('puter', { fs: {
    stat: vi.fn(async (name) => {
      const file = files.get(name);
      if (!file) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
      return { path: name, modified: file.modified };
    }),
    read: vi.fn(async (name) => files.get(name).blob),
    write: vi.fn(async (name, blob) => {
      files.set(name, { blob, modified: ++modified });
      return { path: name, modified };
    }),
    rename: vi.fn(async (name, newName) => {
      const file = files.get(name);
      if (!file) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
      const target = name.slice(0, name.lastIndexOf('/') + 1) + newName;
      if (files.has(target)) throw new Error('Already exists');
      files.delete(name);
      files.set(target, { ...file, modified: ++modified });
      return { path: target, modified };
    }),
  } });
});

afterEach(() => {
  docs.forEach((doc) => doc.destroy());
  versioning.enabled = true; publishing.enabled = true;
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function open() {
  const doc = await Doc.fromPath(path);
  docs.push(doc);
  doc.attach(async () => new Blob(['my edits']));
  return doc;
}

it.each(['changed', 'deleted'])('refuses to restore a version over a file another window has %s', async (action) => {
  const doc = await open();
  const versionPath = 'Documents/.versions/Report/1.docx';
  files.set(versionPath, { blob: new Blob(['old version']), modified: 50 });
  if (action === 'changed') await puter.fs.write(path, new Blob(['other window']));
  else files.delete(path);
  puter.fs.write.mockClear();

  await expect(doc.restoreVersion(versionPath)).rejects.toThrow(/another window/);
  expect(puter.fs.write).not.toHaveBeenCalled();
  if (action === 'changed') expect(await files.get(path).blob.text()).toBe('other window');
  else expect(files.has(path)).toBe(false);
  // Nothing was written, so a clean document is still saved.
  expect(doc.status).toBe('saved');
});

it.each(['changed', 'deleted'])('protects the first edit when another window has %s the opened file', async (action) => {
  const doc = await open();
  if (action === 'changed') await puter.fs.write(path, new Blob(['other window']));
  else files.delete(path);
  puter.fs.write.mockClear();
  doc.changed();

  await expect(doc.save()).rejects.toThrow(/another window/);
  expect(puter.fs.write).not.toHaveBeenCalled();
  expect(doc.dirty).toBe(true);
  if (action === 'changed') expect(await files.get(path).blob.text()).toBe('other window');
  else expect(files.has(path)).toBe(false);
});

it('saves the first edit when the opened file is unchanged', async () => {
  const doc = await open();
  doc.changed();
  expect(await doc.save()).toBe(true);
  expect(await files.get(path).blob.text()).toBe('my edits');
});

it('still opens and saves when file metadata is unavailable', async () => {
  puter.fs.stat.mockRejectedValue(new Error('Metadata unavailable'));
  const doc = await open();
  doc.changed();
  expect(await doc.save()).toBe(true);
  expect(await files.get(path).blob.text()).toBe('my edits');
});

it.each(['changed', 'deleted'])('protects a newly created document when another window has %s it', async (action) => {
  const doc = Doc.blank({ name: 'New report' });
  docs.push(doc);
  doc.attach(async () => new Blob(['first save']));
  doc.changed();
  await doc.save();
  const createdPath = doc.path;
  expect(await files.get(createdPath).blob.text()).toBe('first save');

  if (action === 'changed') await puter.fs.write(createdPath, new Blob(['other window']));
  else files.delete(createdPath);
  puter.fs.write.mockClear();
  doc.attach(async () => new Blob(['my next edit']));
  doc.changed();
  await expect(doc.save()).rejects.toThrow(/another window/);
  expect(puter.fs.write).not.toHaveBeenCalled();
  expect(doc.dirty).toBe(true);
  if (action === 'changed') expect(await files.get(createdPath).blob.text()).toBe('other window');
  else expect(files.has(createdPath)).toBe(false);
});

it('continues saving a newly created document when its cloud version is unchanged', async () => {
  const doc = Doc.blank({ name: 'New report' });
  docs.push(doc);
  doc.attach(async () => new Blob(['first save']));
  doc.changed(); await doc.save();
  doc.attach(async () => new Blob(['next edit']));
  doc.changed();
  expect(await doc.save()).toBe(true);
  expect(await files.get(doc.path).blob.text()).toBe('next edit');
});

it.each(['changed', 'deleted'])('protects a renamed document when another window has %s it', async (action) => {
  const doc = await open();
  expect(await doc.rename('Renamed')).toBeNull();
  const renamedPath = doc.path;
  if (action === 'changed') await puter.fs.write(renamedPath, new Blob(['other window']));
  else files.delete(renamedPath);
  puter.fs.write.mockClear();
  doc.changed();
  await expect(doc.save()).rejects.toThrow(/another window/);
  expect(puter.fs.write).not.toHaveBeenCalled();
  expect(doc.dirty).toBe(true);
  if (action === 'changed') expect(await files.get(renamedPath).blob.text()).toBe('other window');
  else expect(files.has(renamedPath)).toBe(false);
});

it('does not treat its own rename as another window’s edit', async () => {
  const doc = await open();
  expect(await doc.rename('Renamed')).toBeNull();
  doc.changed();
  expect(await doc.save()).toBe(true);
  expect(await files.get(doc.path).blob.text()).toBe('my edits');
});

it('does not adopt another window’s changes as its own while renaming', async () => {
  const doc = await open();
  await puter.fs.write(path, new Blob(['other window']));
  expect(await doc.rename('Renamed')).toMatch(/changed in another window/);
  expect(puter.fs.rename).not.toHaveBeenCalled();
  expect(doc.path).toBe(path);
  expect(await files.get(path).blob.text()).toBe('other window');
});

it('reports an autosave refused for another window\'s change, which nothing retries, and leaves an explicit save to throw', async () => {
  const doc = await open();
  const conflicts = [];
  doc.addEventListener('conflict', (e) => conflicts.push(e.detail.message));
  await puter.fs.write(path, new Blob(['other window']));
  puter.fs.write.mockClear();
  doc.changed();
  await vi.advanceTimersByTimeAsync(2000);
  expect(conflicts).toEqual([expect.stringMatching(/changed in another window/)]);
  expect(doc.status).toBe('error');
  // No retry follows on its own.
  await vi.advanceTimersByTimeAsync(60000);
  expect(conflicts).toHaveLength(1);
  // An explicit save reports through its rejection instead.
  await expect(doc.save()).rejects.toThrow(/another window/);
  expect(conflicts).toHaveLength(1);
  expect(puter.fs.write).not.toHaveBeenCalled();
});
