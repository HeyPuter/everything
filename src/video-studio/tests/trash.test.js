import { describe, it, expect, beforeEach } from 'vitest';
import { Library, TRASH_DAYS } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';

const DAY = 24 * 60 * 60 * 1000;
// Fixed instants (UTC) so the tests do not depend on the clock or time zone.
const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);
const json = (backend, path) => JSON.parse(backend.files.get(path));

describe('Trash', () => {
  let backend;
  let lib;
  beforeEach(() => {
    backend = memoryBackend();
    lib = new Library(backend);
  });

  it('moves a project to the Trash without deleting its files', async () => {
    const keep = await lib.createProject({ name: 'Keep' });
    const gone = await lib.createProject({ name: 'Gone' });
    await lib.saveCover(gone.id, 'cover');
    await lib.trashProject(gone.id, T0);
    expect((await lib.listProjects()).map((p) => p.id)).toEqual([keep.id]);
    const trash = await lib.listTrash();
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ id: gone.id, name: 'Gone', deletedAt: T0 });
    expect(json(backend, `projects/${gone.id}.json`).deletedAt).toBe(T0);
    expect(backend.files.get(`covers/${gone.id}.jpg`)).toBe('cover');
  });

  it.each([
    ['missing', null],
    ['damaged', '{"oops'],
    ['not a project', '{"format":"other"}'],
  ])('moves a project whose file is %s to the Trash and deletes it for good', async (_, content) => {
    const p = await lib.createProject({ name: 'Broken' });
    if (content === null) backend.files.delete(`projects/${p.id}.json`);
    else backend.files.set(`projects/${p.id}.json`, content);
    await lib.trashProject(p.id, T0);
    expect(await lib.listProjects()).toEqual([]);
    expect((await lib.listTrash()).map((x) => [x.name, x.deletedAt])).toEqual([['Broken', T0]]);
    await lib.restoreProject(p.id);
    expect((await lib.listProjects()).map((x) => x.name)).toEqual(['Broken']);
    await lib.trashProject(p.id, T0);
    await lib.deleteProject(p.id);
    expect(await lib.listTrash()).toEqual([]);
    expect(backend.files.has(`projects/${p.id}.json`)).toBe(false);
  });

  it('does not touch the list when the project file cannot be read for another reason', async () => {
    const p = await lib.createProject({ name: 'Offline' });
    backend.failNext = 1;
    await expect(lib.trashProject(p.id, T0)).rejects.toThrow('Simulated network failure');
    expect((await lib.listProjects()).map((x) => x.name)).toEqual(['Offline']);
  });

  it('restores a project from the Trash', async () => {
    const p = await lib.createProject({ name: 'Back' });
    await lib.trashProject(p.id, T0);
    await lib.restoreProject(p.id);
    expect((await lib.listProjects()).map((x) => x.id)).toEqual([p.id]);
    expect(await lib.listTrash()).toEqual([]);
    expect('deletedAt' in json(backend, `projects/${p.id}.json`)).toBe(false);
    expect('deletedAt' in (await lib.openProject(p.id))).toBe(false);
  });

  it('keeps the Trash when the index is rebuilt from project files', async () => {
    const a = await lib.createProject({ name: 'Alive' });
    const b = await lib.createProject({ name: 'Trashed' });
    await lib.trashProject(b.id, T0);
    backend.files.delete('index.json');
    const fresh = new Library(backend);
    expect((await fresh.listProjects()).map((x) => x.id)).toEqual([a.id]);
    expect((await fresh.listTrash()).map((x) => x.id)).toEqual([b.id]);
  });

  it('opens older projects saved before the Trash existed', async () => {
    backend.files.set('projects/old.json', JSON.stringify({ format: 'video-studio-project', id: 'old', name: 'Old one', modified: T0 }));
    backend.files.set('index.json', JSON.stringify([{ id: 'old', name: 'Old one', modified: T0, created: T0, duration: 0, ratio: '16:9' }]));
    expect((await lib.listProjects()).map((x) => x.id)).toEqual(['old']);
    expect(await lib.listTrash()).toEqual([]);
  });

  it('deletes a project for good, and empties the Trash', async () => {
    const a = await lib.createProject({ name: 'A' });
    const b = await lib.createProject({ name: 'B' });
    const c = await lib.createProject({ name: 'C' });
    await lib.trashProject(a.id, T0);
    await lib.trashProject(b.id, T0 + 1000);
    await lib.deleteProject(a.id);
    expect(backend.files.has(`projects/${a.id}.json`)).toBe(false);
    expect((await lib.listTrash()).map((x) => x.id)).toEqual([b.id]);
    expect(await lib.emptyTrash()).toEqual([b.id]);
    expect(backend.files.has(`projects/${b.id}.json`)).toBe(false);
    expect(await lib.listTrash()).toEqual([]);
    expect((await lib.listProjects()).map((x) => x.id)).toEqual([c.id]);
  });

  it(`purges projects that have been in the Trash for ${TRASH_DAYS} days`, async () => {
    expect(TRASH_DAYS).toBe(30);
    const old = await lib.createProject({ name: 'Old' });
    const recent = await lib.createProject({ name: 'Recent' });
    const live = await lib.createProject({ name: 'Live' });
    await lib.trashProject(old.id, T0);
    await lib.trashProject(recent.id, T0 + 10 * DAY);
    // One millisecond short of 30 days: nothing goes.
    expect(await lib.purgeTrash({ now: T0 + 30 * DAY - 1 })).toEqual([]);
    expect(await lib.purgeTrash({ now: T0 + 30 * DAY })).toEqual([old.id]);
    expect(backend.files.has(`projects/${old.id}.json`)).toBe(false);
    expect((await lib.listTrash()).map((x) => x.id)).toEqual([recent.id]);
    expect((await lib.listProjects()).map((x) => x.id)).toEqual([live.id]);
    expect(await lib.purgeTrash({ now: T0 + 40 * DAY })).toEqual([recent.id]);
  });

  it('does not carry the Trash mark into a duplicate', async () => {
    const p = await lib.createProject({ name: 'Orig' });
    await lib.trashProject(p.id, T0);
    const copy = await lib.duplicateProject(p.id);
    expect(copy.deletedAt).toBeUndefined();
    expect((await lib.listProjects()).map((x) => x.id)).toEqual([copy.id]);
  });

  it('reports storage usage', async () => {
    const a = await lib.createProject({ name: 'A' });
    await lib.createProject({ name: 'B' });
    await lib.trashProject(a.id, T0);
    backend.files.set('media/abc.mp4', new Blob(['12345']));
    const usage = await lib.storageUsage();
    expect(usage).toMatchObject({ projects: 1, trashed: 1, mediaFiles: 1 });
    // The memory backend does not report sizes.
    expect(usage.mediaBytes).toBe(null);
  });
});
