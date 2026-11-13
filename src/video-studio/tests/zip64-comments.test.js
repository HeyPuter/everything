import { it, expect } from 'vitest';
import { zipBlobs, readZip } from '../src/storage/zip.js';
import { importProjectBundle } from '../src/storage/bundle.js';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { createProject } from '../src/model/project.js';

async function commentedZip(entries, length, { force64 = true, damageLocator = false } = {}) {
  const zip = await zipBlobs(entries, { force64 });
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer);
  view.setUint16(bytes.length - 2, length, true);
  if (damageLocator) view.setUint32(bytes.length - 42, 0, true);
  return new Blob([bytes, new Uint8Array(length).fill(65)]);
}

it.each([0, 1, 65514, 65515, 65516, 65535])('reads a ZIP64 archive with a %i-byte comment', async length => {
  const zip = await commentedZip([{ name: 'project.json', data: '{"name":"Keep this project"}' }], length);
  const entries = await readZip(zip);
  expect(entries.map(e => e.name)).toEqual(['project.json']);
  expect(await (await entries[0].blob()).text()).toBe('{"name":"Keep this project"}');
});

it('keeps ordinary ZIP archives with maximum comments readable', async () => {
  const entries = await readZip(await commentedZip([{ name: 'data', data: 'kept' }], 65535, { force64: false }));
  expect(await (await entries[0].blob()).text()).toBe('kept');
});

it('reads an empty ZIP64 archive with a maximum comment', async () => {
  expect(await readZip(await commentedZip([], 65535))).toEqual([]);
});

it('rejects a damaged ZIP64 locator preceding the tail window', async () => {
  const zip = await commentedZip([{ name: 'data', data: 'kept' }], 65535, { damageLocator: true });
  await expect(readZip(zip)).rejects.toThrow(/damaged/);
});

it.each([0, 65515, 65516, 65535])('reads only the missing 20-byte locator when needed (comment %i)', async length => {
  // A payload larger than the tail window makes the read ranges observable.
  const zip = await commentedZip([{ name: 'data', data: new Uint8Array(70000) }], length);
  const ranges = [];
  const entries = await readZip({ size: zip.size, slice(start, end) { ranges.push([start, end]);return zip.slice(start, end); } });
  expect(entries).toHaveLength(1);
  expect(ranges[0]).toEqual([zip.size - 22 - 65535, zip.size]);
  expect(ranges).toHaveLength(length > 65515 ? 4 : length === 0 ? 1 : 3);
  if (length > 65515) expect(ranges[1]).toEqual([zip.size - 22 - length - 20, zip.size - 22 - length]);
});

it('imports a commented ZIP64 project and its media through the real library', async () => {
  const source = new Library(memoryBackend());
  const project = createProject({ name: 'Commented backup' });
  const asset = await source.addMediaBlob({ id: 'audio', kind: 'audio', name: 'Original take', ext: 'wav', mime: 'audio/wav', duration: 1000000 }, new Blob(['original recording bytes']));
  project.assets[asset.id] = asset;
  const zip = await commentedZip([
    { name: 'project.json', data: JSON.stringify(project) },
    { name: `media/${asset.hash}.wav`, data: await source.mediaBlob(asset) },
  ], 65535);
  const target = new Library(memoryBackend());
  const imported = await importProjectBundle(target, zip);
  expect(imported.project.id).not.toBe(project.id);
  expect(imported.missing).toEqual([]);
  const reopened = await target.openProject(imported.project.id);
  expect(reopened.name).toBe(project.name);
  expect(await (await target.mediaBlob(reopened.assets.audio)).text()).toBe('original recording bytes');
  expect(await target.listProjects()).toHaveLength(1);
  source.releaseMedia();target.releaseMedia();
});
