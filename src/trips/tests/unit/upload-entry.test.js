// Upload entry points in modules, with the files module's upload calls stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkKey } from '../../src/shared/file-links.js';

vi.mock('../../src/lib/files/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  chooseLocalFiles: vi.fn(),
  uploadImage: vi.fn(),
  uploadCover: vi.fn(),
  uploadFile: vi.fn(),
  coverUrl: vi.fn(async () => null),
}));

const files = await import('../../src/lib/files/index.js');
const { openPlaceForm } = await import('../../src/views/trip/places/form.js');
const { openMetaForm } = await import('../../src/views/collections/metaform.js');
const { attachReceipts } = await import('../../src/views/trip/costs/receipt/attach.js');
const { openFilePicker } = await import('../../src/lib/files/ui.js');
const { offlineDownloader } = await import('../../src/lib/files/offline.js');
const { resetDirect } = await import('../../src/lib/files/direct.js');

const ref = { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' };
let seq = 0;
const nextId = () => `00000000000000${String(++seq).padStart(2, '0')}`;
const dialog = () => [...document.querySelectorAll('[role=dialog]')].at(-1);
const byText = (root, text) => [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === text);
const photo = (name = 'tower.jpg') => new File([new Uint8Array([0xff, 0xd8, 0xff, 1])], name, { type: 'image/jpeg' });

/** Entities by type, ops recorded; patches apply by path. */
function stubSpace({ ents = {}, can = () => true } = {}) {
  const store = Object.fromEntries(Object.entries(ents).map(([type, list]) => [type, new Map(list.map((item) => [item.id, item]))]));
  const applied = [];
  return {
    ref, applied,
    /** What an upload's `file.put` answer adds to the replica. */
    addFile(entity) { (store.file ??= new Map()).set(entity.id, entity); },
    can: (action) => can(action),
    get: (type, id) => store[type]?.get(id) ?? null,
    select: new Proxy({}, { get: (_, type) => ({ all: () => [...(store[type]?.values() ?? [])] }) }),
    subscribe: () => () => {},
    ops: {
      create: (t, put) => ({ opId: nextId(), t, id: nextId(), put }),
      patch: (t, id, { set, unset }) => ({ opId: nextId(), t, id, ...(set ? { set } : {}), ...(unset ? { unset } : {}) }),
    },
    apply: vi.fn(async (ops) => { applied.push(...ops); }),
  };
}

beforeEach(() => { vi.mocked(files.chooseLocalFiles).mockReset(); vi.mocked(files.uploadImage).mockReset(); vi.mocked(files.uploadFile).mockReset(); vi.mocked(files.uploadCover).mockReset(); });
afterEach(() => { document.body.replaceChildren(); resetDirect(); });

describe('place photos', () => {
  async function addWithPhoto(type) {
    const space = stubSpace({ ents: { meta: [{ id: 'meta', currency: 'EUR' }] } });
    vi.mocked(files.chooseLocalFiles).mockResolvedValue([photo()]);
    vi.mocked(files.uploadImage).mockImplementation(async () => { space.addFile({ id: 'f0000000000000p1', kind: 'user' }); return { id: 'f0000000000000p1', duplicate: false }; });
    const saved = openPlaceForm({ space, type });
    const form = dialog();
    form.querySelector('input').value = 'Belém Tower';
    globalThis.URL.createObjectURL ??= () => 'blob:x';
    globalThis.URL.revokeObjectURL ??= () => {};
    byText(form, 'Upload a photo').click();
    await vi.waitFor(() => expect(form.textContent).toContain('tower.jpg is uploaded when you save.'));
    form.querySelector('form').requestSubmit();
    const id = await saved;
    return { space, id };
  }

  it('uploads the photo before saving and links it to the new place', async () => {
    const { space, id } = await addWithPhoto('place');
    expect(files.uploadImage).toHaveBeenCalledWith(space, expect.any(File), expect.any(Object));
    const create = space.applied.find((op) => op.put);
    expect(create).toMatchObject({ t: 'place', id, put: { name: 'Belém Tower', img: { fileId: 'f0000000000000p1' } } });
    expect(space.applied.find((op) => op.t === 'file')).toMatchObject({ id: 'f0000000000000p1', set: { [`linked.${linkKey({ t: 'place', id })}`]: true } });
  });

  it('links a saved place photo to the saved place', async () => {
    const { space, id } = await addWithPhoto('saved');
    expect(space.applied.find((op) => op.t === 'file')).toMatchObject({ set: { [`linked.saved_${id}`]: true } });
  });

  it('keeps the form open when the upload fails', async () => {
    const space = stubSpace();
    vi.mocked(files.chooseLocalFiles).mockResolvedValue([photo()]);
    vi.mocked(files.uploadImage).mockRejectedValue(Object.assign(new Error('x'), { status: 0, code: 'network' }));
    openPlaceForm({ space });
    const form = dialog();
    form.querySelector('input').value = 'Belém Tower';
    byText(form, 'Upload a photo').click();
    await vi.waitFor(() => expect(form.textContent).toContain('is uploaded when you save'));
    form.querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(form.querySelector('.pl-alert').hidden).toBe(false));
    expect(space.apply).not.toHaveBeenCalled();
    expect(form.isConnected).toBe(true);
  });

  it('replacing a photo unlinks the old file', async () => {
    const place = { id: '00000000000000a1', name: 'Tower', img: { fileId: 'f0000000000000o1' } };
    const space = stubSpace({ ents: { place: [place], file: [{ id: 'f0000000000000o1', kind: 'user', linked: { [`place_${place.id}`]: true } }] } });
    vi.mocked(files.chooseLocalFiles).mockResolvedValue([photo('new.jpg')]);
    vi.mocked(files.uploadImage).mockImplementation(async () => { space.addFile({ id: 'f0000000000000n1', kind: 'user' }); return { id: 'f0000000000000n1' }; });
    const saved = openPlaceForm({ space, place });
    const form = dialog();
    byText(form, 'Replace photo').click();
    await vi.waitFor(() => expect(form.textContent).toContain('new.jpg is uploaded when you save.'));
    form.querySelector('form').requestSubmit();
    await saved;
    expect(space.applied.find((op) => op.t === 'place')).toMatchObject({ set: { img: { fileId: 'f0000000000000n1' } } });
    expect(space.applied.find((op) => op.t === 'file' && op.id === 'f0000000000000o1')).toMatchObject({ unset: [`linked.place_${place.id}`] });
  });
});

describe('collection covers', () => {
  it('uploads a cover from the edit form and keeps it on save', async () => {
    const meta = { id: 'meta', name: 'Food' };
    const space = stubSpace({ ents: { meta: [meta] } });
    vi.mocked(files.chooseLocalFiles).mockResolvedValue([photo('cover.jpg')]);
    vi.mocked(files.uploadCover).mockImplementation(async () => { meta.cover = 'f0000000000000c1'; return { id: 'f0000000000000c1' }; });
    const onSubmit = vi.fn(async () => {});
    openMetaForm({ space, meta, title: 'Edit', submitLabel: 'Save', onSubmit });
    const form = dialog();
    byText(form, 'Upload a cover image').click();
    await vi.waitFor(() => expect(form.textContent).toContain('Cover saved.'));
    expect(files.uploadCover).toHaveBeenCalledWith(space, expect.any(File));
    form.querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: 'Food', cover: 'f0000000000000c1' });
  });

  it('offers no upload when creating a collection', () => {
    openMetaForm({ title: 'New', submitLabel: 'Create', onSubmit: async () => {} });
    expect(byText(dialog(), 'Upload a cover image')).toBeUndefined();
  });
});

describe('expense receipts', () => {
  it('uploads each receipt linked to the saved expense', async () => {
    const space = stubSpace({ ents: { exp: [{ id: '00000000000000e1' }] } });
    vi.mocked(files.uploadFile).mockResolvedValue({ id: 'f1' });
    const session = { api: {} };
    await attachReceipts({ space, id: '00000000000000e1', files: [photo('a.jpg'), photo('b.jpg')], session });
    expect(files.uploadFile).toHaveBeenCalledTimes(2);
    expect(files.uploadFile.mock.calls[0][2]).toMatchObject({ link: { t: 'exp', id: '00000000000000e1' }, api: session.api });
  });

  it('never uploads for a private expense', async () => {
    await attachReceipts({ space: stubSpace(), id: '00000000000000e2', files: [photo()], session: { api: {} } });
    expect(files.uploadFile).not.toHaveBeenCalled();
  });
});

describe('file picker options', () => {
  it('starts from `selected`, lists only matching files and caps the choice', async () => {
    const file = (id, mime) => ({ id, name: `${id}.${mime.split('/')[1]}`, mime, size: 10, kind: 'user', cr: 1 });
    const space = stubSpace({ ents: { file: [file('00000000000000i1', 'image/png'), file('00000000000000i2', 'image/png'), file('00000000000000i3', 'image/png'), file('00000000000000d1', 'application/pdf')] } });
    const picked = openFilePicker(space, { selected: ['00000000000000i1'], filter: (entry) => entry.mime.startsWith('image/'), max: 2 });
    const panel = dialog();
    const items = () => [...panel.querySelectorAll('.file-pick-item')];
    expect(items().map((node) => node.dataset.id).sort()).toEqual(['00000000000000i1', '00000000000000i2', '00000000000000i3']);
    expect(items().find((node) => node.dataset.id === '00000000000000i1').getAttribute('aria-checked')).toBe('true');
    items().find((node) => node.dataset.id === '00000000000000i2').click();
    expect(items().find((node) => node.dataset.id === '00000000000000i3').disabled).toBe(true);
    byText(panel, 'Done').click();
    expect((await picked).sort()).toEqual(['00000000000000i1', '00000000000000i2']);
    expect(space.apply).not.toHaveBeenCalled();
  });

  it('links and unlinks in one apply when given a target', async () => {
    const target = { t: 'res', id: '00000000000000r1' };
    const space = stubSpace({ ents: { file: [
      { id: '00000000000000f1', name: 'a.pdf', mime: 'application/pdf', size: 1, kind: 'user', links: [target] },
      { id: '00000000000000f2', name: 'b.pdf', mime: 'application/pdf', size: 1, kind: 'user' },
    ] } });
    const picked = openFilePicker(space, { link: target });
    const panel = dialog();
    for (const node of panel.querySelectorAll('.file-pick-item')) node.click();
    byText(panel, 'Done').click();
    await picked;
    expect(space.apply).toHaveBeenCalledTimes(1);
    expect(space.applied).toEqual([
      expect.objectContaining({ t: 'file', id: '00000000000000f2', set: { 'linked.res_00000000000000r1': true } }),
      expect.objectContaining({ t: 'file', id: '00000000000000f1', unset: ['links'] }),
    ]);
  });
});

describe('offline downloads', () => {
  const file = { id: '00000000000000f1', name: 'ticket.pdf', mime: 'application/pdf', size: 3, sha256: 'a'.repeat(64), kind: 'user', loc: { mode: 'direct', uid: 'file-uid-1' } };
  const bytes = new Blob(['pdf']);
  function setup({ directFiles = true, own = null, entry = null, trip = null } = {}) {
    const api = { download: vi.fn(async () => bytes) };
    const puter = { fs: { read: vi.fn(async () => bytes), stat: vi.fn(async () => ({ is_dir: true, path: `/alice/AppData/trips/spaces/${ref.s}/files` })) } };
    const session = {
      api, account: { uuid: '00000000-0000-4000-8000-000000000001' }, trip,
      ownWorker: async () => own,
      personal: { spaces: { list: async () => (entry ? [entry] : []) } },
    };
    return { api, puter, download: offlineDownloader({ session, puter, features: async () => ({ directFiles }) }) };
  }

  it('reads straight from the owner\'s storage for a member in direct mode', async () => {
    const { api, puter, download } = setup({ entry: { ref, files: { mode: 'direct', uid: 'folder-1' } } });
    const blob = await download(ref, file, {});
    expect(blob.size).toBe(3);
    // By path inside the trip folder the worker named, never by the entity's uid.
    expect(puter.fs.stat).toHaveBeenCalledWith({ uid: 'folder-1' });
    expect(puter.fs.read).toHaveBeenCalledWith(`/alice/AppData/trips/spaces/${ref.s}/files/00000000000000f1/ticket.pdf`);
    expect(api.download).not.toHaveBeenCalled();
  });

  it('reads the owner\'s own files directly', async () => {
    const { api, puter, download } = setup({ own: ref.w });
    await download(ref, file, {});
    expect(puter.fs.read).toHaveBeenCalled();
    expect(api.download).not.toHaveBeenCalled();
  });

  it('goes through the worker when direct files are off or the trip is proxied', async () => {
    for (const options of [{ directFiles: false, own: ref.w }, { entry: { ref, files: { mode: 'proxied' } } }]) {
      const { api, puter, download } = setup(options);
      await download(ref, file, {});
      expect(api.download).toHaveBeenCalledWith(ref, file.id, expect.objectContaining({ thumb: false }));
      expect(puter.fs.read).not.toHaveBeenCalled();
    }
  });

  it('uses the open trip when it is the same one', async () => {
    const space = { ref, get: () => file, fileAccess: vi.fn(async () => ({ mode: 'direct', owner: true, account: 'x' })) };
    const { puter, download } = setup({ directFiles: false, trip: { space } });
    await download(ref, file, {});
    expect(space.fileAccess).toHaveBeenCalled();
    expect(puter.fs.read).toHaveBeenCalled();
  });
});
