import { describe, it, expect, vi } from 'vitest';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { bootAppWithFeatures } from './helpers.js';
import { versionKey } from '../src/features/panels/file-commands.js';

/** Saves in this browser download the file (no cloud, no File System Access): capture the bytes. */
function captureDownloads() {
  const blobs = [];
  const orig = URL.createObjectURL;
  URL.createObjectURL = (blob) => {
    blobs.push(blob);
    return 'blob:x';
  };
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  return {
    blobs,
    restore() {
      click.mockRestore();
      URL.createObjectURL = orig;
    },
  };
}
const versionsSettle = () => new Promise((r) => setTimeout(r, 400));
const paths = (doc) => [...doc.nodes.values()].filter((n) => n.type === 'path').length;

describe('version history', () => {
  it('keeps exactly the content that was saved, not edits made right after', async () => {
    const app = await bootAppWithFeatures();
    const ed = app.newDocument({ name: 'Saved', width: 200, height: 100 });
    const doc = ed.doc;
    const add = (x) =>
      doc.transact('Add', () =>
        doc.insert(createPath(rectangle(x, 0, 10, 10), true), ed.targetLayer().id),
      );
    add(0);
    const dl = captureDownloads();
    try {
      expect(await app.files.service.save(ed)).toBe(true);
      // Edited at once, before the version is written.
      add(20);
      await versionsSettle();
      const list = await app.versions.list(versionKey(ed));
      expect(list.length).toBe(1);
      const kept = await app.versions.read(versionKey(ed), list[0].id);
      expect(paths(kept)).toBe(1);
      // The version stays content only: a copy opened from it is a document of its own.
      expect(kept.fileId).toBe(null);
      // Saving again keeps the edit made after the first save.
      expect(await app.files.service.save(ed)).toBe(true);
      await versionsSettle();
      const after = await app.versions.list(versionKey(ed));
      expect(after.length).toBe(2);
      expect(paths(await app.versions.read(versionKey(ed), after[1].id))).toBe(2);
    } finally {
      dl.restore();
    }
  });

  it('an edit made while the file is written is kept by the next save', async () => {
    const app = await bootAppWithFeatures();
    const ed = app.newDocument({ name: 'Slow', width: 200, height: 100 });
    const doc = ed.doc;
    const add = (x) =>
      doc.transact('Add', () =>
        doc.insert(createPath(rectangle(x, 0, 10, 10), true), ed.targetLayer().id),
      );
    add(0);
    let during = () => {};
    const handle = {
      kind: 'file',
      name: 'Slow.vstudio',
      createWritable: async () => ({ write: async () => during(), close: async () => {} }),
    };
    ed.file = { kind: 'local', name: 'Slow.vstudio', handle, handleId: 'h1' };
    during = () => add(20);
    expect(await app.files.service.save(ed)).toBe(true);
    during = () => {};
    expect(doc.dirty).toBe(true);
    await versionsSettle();
    expect(await app.files.service.save(ed)).toBe(true);
    await versionsSettle();
    const list = await app.versions.list(versionKey(ed));
    expect(list.length).toBe(2);
    expect(paths(await app.versions.read(versionKey(ed), list[0].id))).toBe(1);
    expect(paths(await app.versions.read(versionKey(ed), list[1].id))).toBe(2);
  });

  it('a shared document keeps the content the server had when it counted as saved', async () => {
    const app = await bootAppWithFeatures();
    const ed = app.newDocument({ name: 'Team' });
    ed.file = { kind: 'shared', name: 'Team', server: 'https://x.puter.work', room: 'r1' };
    const doc = ed.doc;
    const add = (x) =>
      doc.transact('Add', () =>
        doc.insert(createPath(rectangle(x, 0, 10, 10), true), ed.targetLayer().id),
      );
    add(0);
    doc.markSaved();
    add(20);
    await versionsSettle();
    const list = await app.versions.list(versionKey(ed));
    expect(list.length).toBe(1);
    expect(paths(await app.versions.read(versionKey(ed), list[0].id))).toBe(1);
  });
});
