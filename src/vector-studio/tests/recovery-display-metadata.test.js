import { afterEach, expect, it, vi } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { Autosaver } from '../src/features/files/autosave.js';
import { RecoveryStore } from '../src/features/files/recovery.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { serializeDocument } from '../src/features/files/format.js';
import { handleStore } from '../src/features/files/handles.js';
import { dialogHooks } from '../src/ui/dialogs/dialog.js';

afterEach(() => { dialogHooks.open = null; vi.restoreAllMocks(); });

async function setup(patch) {
  const backend = memoryBackend();
  const store = new RecoveryStore(backend);
  for (const [id, name, saved] of [['drawing', 'Recover this', 2], ['other', 'Other work', 1]]) {
    await store.put(id, { name, saved, session: 'old', data: await serializeDocument(VDocument.create({ name }), { compress: false }) });
  }
  const path = 'recovery/index.0.drawing.json';
  const index = await backend.readJSON(path);
  await backend.writeJSON(path, { ...index, entries: [{ ...index.entries[0], ...patch }] });
  const app = { editors: [], notify: vi.fn(), renderTabs: vi.fn(), addDocument: vi.fn((doc, { file }) => ({ doc, file })) };
  const saver = new Autosaver(app, { store, session: 'current' });
  saver.liveSessions = async () => new Set();
  dialogHooks.open = async () => 'recover';
  return { store, app, saver };
}

it.each([[42], [{}], [[]], [true]])('recovers all document contents when a stored file path is %j', async (path) => {
  const { saver, store } = await setup({ file: { kind: 'puter', path, name: 'Drawing.vstudio' } });
  const opened = await saver.offerRecovery();
  expect(opened.map((ed) => ed.doc.root.name)).toEqual(['Recover this', 'Other work']);
  expect(opened[0].file.kind).toBe('import');
  expect(opened[0].file.name).toBe('Drawing.vstudio [Recovered]');
  expect(await store.list()).toHaveLength(2);
});

it('does not interpret an object-valued stored name as element attributes or markup', async () => {
  const { saver } = await setup({ name: { html: '<span data-injected-recovery="yes">Injected content</span>', title: 'Injected title' } });
  dialogHooks.open = async (opts) => {
    expect(opts.body.querySelector('[data-injected-recovery]')).toBeNull();
    const name = opts.body.querySelector('.files-recover-name');
    expect(name.textContent).toBe('Untitled');
    expect(name.getAttribute('title')).toBeNull();
    return 'recover';
  };
  const opened = await saver.offerRecovery();
  expect(opened.map((ed) => ed.doc.root.name)).toEqual(['Recover this', 'Other work']);
  expect(opened[0].file.name).not.toContain('[object Object]');
});

it('does not attach a non-string file name to a recovered editor', async () => {
  const { saver } = await setup({ file: { kind: 'puter', path: '/u/Drawing.vstudio', name: { title: 'Bad name' } } });
  const [editor] = await saver.offerRecovery();
  expect(editor.file.path).toBe('/u/Drawing.vstudio');
  expect(typeof editor.file.name === 'string' || editor.file.name == null).toBe(true);
  expect(editor.doc.root.name).toBe('Recover this');
});

it('does not request a stored local handle using malformed metadata', async () => {
  const { saver } = await setup({ file: { kind: 'local', name: 'Drawing.vstudio', handleId: ['not', 'an', 'id'] } });
  const get = vi.spyOn(handleStore, 'get').mockResolvedValue({ name: 'Wrong file.vstudio' });
  const [editor] = await saver.offerRecovery();
  expect(get).not.toHaveBeenCalled();
  expect(editor.file.kind).toBe('import');
  expect(editor.file.name).toBe('Drawing.vstudio [Recovered]');
});

it('keeps genuine text names as text and preserves a valid original save location', async () => {
  const name = '<b>Drawing & artwork</b>';
  const { saver } = await setup({ name, file: { kind: 'puter', path: '/u/Drawing.vstudio', name: 'Drawing.vstudio' } });
  dialogHooks.open = async (opts) => {
    const label = opts.body.querySelector('.files-recover-name');
    expect(label.textContent).toBe(name);
    expect(label.querySelector('b')).toBeNull();
    return 'recover';
  };
  const [editor] = await saver.offerRecovery();
  expect(editor.file).toEqual({ kind: 'puter', path: '/u/Drawing.vstudio', name: 'Drawing.vstudio' });
});
