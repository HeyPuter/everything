import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFilesView, mount } from '../../src/views/trip/files/index.js';
import { attachmentList } from '../../src/lib/files/ui.js';
import { fileLinks } from '../../src/shared/file-links.js';

const ref = { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' };
const fileEntity = (id, fields) => ({ id, kind: 'user', mime: 'application/pdf', size: 1200, sha256: 'a'.repeat(64), loc: { mode: 'proxied' }, v: 'v', rev: 1, upd: 1, by: 'u', cr: 1_700_000_000_000, ...fields });

function stubSpace({ role = 'editor', files = [], others = {} } = {}) {
  const ents = { file: new Map(files.map((file) => [file.id, file])), ...Object.fromEntries(Object.entries(others).map(([type, list]) => [type, new Map(list.map((item) => [item.id, item]))])) };
  const listeners = new Set();
  const all = (type) => [...(ents[type]?.values() ?? [])];
  const emit = (type) => { for (const listener of listeners) listener({ changed: new Set(), types: new Set([type]), rev: 2 }); };
  return {
    ref,
    state: { rev: 1, sync: 'synced' },
    can: (action) => role !== 'viewer' || action === 'collab.post',
    get: (type, id) => ents[type]?.get(id),
    select: new Proxy({}, { get: (_, type) => ({ all: () => all(type) }) }),
    subscribe: (target, fn) => { const listener = typeof target === 'function' ? target : fn; listeners.add(listener); return () => listeners.delete(listener); },
    onState: () => () => {},
    store: { merge: async () => {} },
    ops: { patch: (t, id, { set, unset }) => ({ opId: 'op', t, id, set, unset }) },
    apply: vi.fn(async (ops) => {
      for (const op of ops) {
        const entity = structuredClone(ents[op.t].get(op.id));
        for (const [path, value] of Object.entries(op.set ?? {})) {
          const keys = path.split('.');
          let at = entity;
          for (const key of keys.slice(0, -1)) at = at[key] ??= {};
          at[keys.at(-1)] = value;
        }
        for (const path of op.unset ?? []) {
          const keys = path.split('.');
          let at = entity;
          for (const key of keys.slice(0, -1)) at = at?.[key];
          if (at) delete at[keys.at(-1)];
        }
        ents[op.t].set(op.id, entity);
      }
      emit('file');
    }),
    put(entity) { ents.file.set(entity.id, entity); emit('file'); },
  };
}

afterEach(() => { document.body.replaceChildren(); });

describe('Files tab', () => {
  it('lists files with links, filters them and opens the trash', async () => {
    const space = stubSpace({
      files: [
        fileEntity('00000000000000f1', { name: 'Ticket.pdf', links: [{ t: 'res', id: '00000000000000r1' }] }),
        fileEntity('00000000000000f2', { name: 'Beach.jpg', mime: 'image/jpeg', star: true, cr: 1_700_000_100_000 }),
        fileEntity('00000000000000f3', { name: 'Old.pdf', trashed: Date.now() - 86_400_000 }),
      ],
      others: { res: [{ id: '00000000000000r1', title: 'Flight to Lisbon' }] },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const view = createFilesView({ container, space });
    const names = () => [...container.querySelectorAll('.file-row-name')].map((node) => node.textContent);
    expect(names()).toEqual(['Beach.jpg', 'Ticket.pdf']);
    expect(container.querySelector('.file-link-chip').textContent).toContain('Flight to Lisbon');
    const starred = [...container.querySelectorAll('.seg button')].find((node) => node.textContent === 'Starred');
    starred.click();
    expect(names()).toEqual(['Beach.jpg']);
    const trashButton = [...container.querySelectorAll('.files-actions button')].find((node) => node.textContent.includes('Trash (1)'));
    trashButton.click();
    expect(names()).toEqual(['Old.pdf']);
    expect(container.textContent).toContain('Days until deleted: 29');
    view.destroy();
  });

  it('stars through the outbox and hides editing for viewers', async () => {
    const space = stubSpace({ files: [fileEntity('00000000000000f1', { name: 'Ticket.pdf' })] });
    const container = document.createElement('div');
    document.body.append(container);
    const view = createFilesView({ container, space });
    container.querySelector('.file-star').click();
    expect(space.apply).toHaveBeenCalledWith([expect.objectContaining({ t: 'file', id: '00000000000000f1', set: { star: true } })]);
    view.destroy();
    const viewer = stubSpace({ role: 'viewer', files: [fileEntity('00000000000000f1', { name: 'Ticket.pdf', star: true })] });
    const other = document.createElement('div');
    document.body.append(other);
    const readOnly = createFilesView({ container: other, space: viewer });
    expect(other.querySelector('.file-star')).toBeNull();
    expect(other.querySelector('.file-star-static')).not.toBeNull();
    expect([...other.querySelectorAll('.files-actions button')].filter((node) => !node.hidden).map((node) => node.textContent)).toEqual([]);
    readOnly.destroy();
  });

  it('shows an empty state and a clear message without a space', async () => {
    const container = document.createElement('div');
    await mount(container, {});
    expect(container.textContent).toContain('Files are not available');
    const empty = document.createElement('div');
    const view = createFilesView({ container: empty, space: stubSpace() });
    expect(empty.textContent).toContain('No files yet');
    view.destroy();
  });

  it('renders attachments for an entity and follows link changes', () => {
    const space = stubSpace({ files: [fileEntity('00000000000000f1', { name: 'Receipt.pdf', links: [{ t: 'exp', id: '00000000000000e1' }] })] });
    const list = attachmentList(space, { t: 'exp', id: '00000000000000e1' });
    expect(list.element.textContent).toContain('Receipt.pdf');
    space.put(fileEntity('00000000000000f2', { name: 'Second.pdf', links: [{ t: 'exp', id: '00000000000000e1' }] }));
    expect(list.element.textContent).toContain('Second.pdf');
    list.destroy();
  });
});

describe('uploads in the Files tab', () => {
  it('queues dropped files, shows progress and the new file', async () => {
    const { File: NodeFile } = await import('node:buffer');
    const { bindFiles } = await import('../../src/lib/files/index.js');
    const space = stubSpace();
    space.store.merge = async (ents) => { for (const { t, ...entity } of ents) space.put(entity); };
    let release;
    const api = {
      upload: vi.fn((_ref, _id, _blob, { onProgress }) => new Promise((resolve) => { onProgress?.({ loaded: 5, total: 10 }); release = () => resolve({ ok: true }); })),
      call: vi.fn(async (_ref, _op, input) => ({ rev: 2, del: [], ents: [{ t: 'file', ...fileEntity(input.fileId, { name: input.name, sha256: input.sha256 }) }] })),
    };
    bindFiles({ api });
    const container = document.createElement('div');
    document.body.append(container);
    const view = createFilesView({ container, space });
    view.addFiles([new NodeFile([new TextEncoder().encode('%PDF-1.7')], 'Hotel.pdf')]);
    await vi.waitFor(() => expect(container.querySelector('.file-upload-status')?.textContent).toBe('50% of 10 bytes'));
    expect(container.querySelector('.file-upload progress').value).toBe(5);
    release();
    await vi.waitFor(() => expect([...container.querySelectorAll('.file-row-name')].map((node) => node.textContent)).toEqual(['Hotel.pdf']));
    expect(api.call).toHaveBeenCalledWith(space.ref, 'file.put', expect.objectContaining({ name: 'Hotel.pdf', mime: 'application/pdf', kind: 'user' }));
    view.addFiles([new NodeFile(['<svg/>'], 'logo.svg')]);
    await vi.waitFor(() => expect(container.querySelector('.file-upload.is-error')?.textContent).toContain('cannot be added'));
    view.destroy();
    bindFiles({});
  });
});

describe('file dialogs', () => {
  it('previews markdown safely, edits details and toggles links', async () => {
    const { bindFiles } = await import('../../src/lib/files/index.js');
    const { openPreview, openFilePicker } = await import('../../src/lib/files/ui.js');
    const { openDetails, openLinkChooser } = await import('../../src/views/trip/files/details.js');
    // jsdom's Blob has no text().
    vi.stubGlobal('Blob', NodeBlob);
    const api = { download: vi.fn(async () => new Blob(['# Plan\n\n<img src=x onerror=alert(1)> [site](javascript:alert(1))'])) };
    bindFiles({ api });
    const space = stubSpace({
      files: [fileEntity('00000000000000f1', { name: 'plan.md', mime: 'text/markdown' })],
      others: { place: [{ id: '00000000000000p1', name: 'Belém Tower' }] },
    });
    const preview = openPreview(space, '00000000000000f1');
    await vi.waitFor(() => expect(preview.panel.querySelector('.markdown h1')?.textContent).toBe('Plan'));
    expect(preview.panel.querySelector('img')).toBeNull();
    expect(preview.panel.querySelector('a[href^="javascript"]')).toBeNull();
    preview.close();

    const details = openDetails(space, '00000000000000f1');
    details.panel.querySelector('textarea').value = 'Day one';
    details.panel.querySelector('textarea').dispatchEvent(new Event('input'));
    [...details.panel.querySelectorAll('button')].find((node) => node.textContent === 'Save').click();
    await vi.waitFor(() => expect(space.apply).toHaveBeenCalledWith([expect.objectContaining({ set: { desc: 'Day one' } })]));
    details.close();

    const chooser = openLinkChooser(space, '00000000000000f1');
    const option = chooser.panel.querySelector('[role="checkbox"]');
    expect(option.textContent).toContain('Belém Tower');
    option.click();
    await vi.waitFor(() => expect(fileLinks(space.get('file', '00000000000000f1'))).toEqual([{ t: 'place', id: '00000000000000p1' }]));
    chooser.close();

    const picked = openFilePicker(space, { link: { t: 'place', id: '00000000000000p1' } });
    const pickerPanel = document.querySelector('[role="dialog"]');
    expect(pickerPanel.querySelector('[role="checkbox"]').getAttribute('aria-checked')).toBe('true');
    pickerPanel.querySelector('[role="checkbox"]').click();
    [...pickerPanel.querySelectorAll('button')].find((node) => node.textContent === 'Done').click();
    expect(await picked).toEqual([]);
    expect(fileLinks(space.get('file', '00000000000000f1'))).toEqual([]);
    bindFiles({});
    vi.unstubAllGlobals();
  });
});
