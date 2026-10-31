// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api.js';
import { createUrlCache } from '../../src/lib/files/cache.js';
import { FileError, errorCode } from '../../src/lib/files/errors.js';
import { fitSize } from '../../src/lib/files/image.js';
import { bindFiles, coverUrl, fileBlob, fileUrl, filesFor, unlinkFile, uploadCover, uploadImage } from '../../src/lib/files/index.js';
import { resetDirect } from '../../src/lib/files/direct.js';
import { storeFile } from '../../src/lib/offline/files.js';
import { createCaches } from './helpers/fake-caches.js';
import { blobType, cleanName, groupOf, previewKind, rejectReason, renameExtension } from '../../src/lib/files/types.js';
import { createUpload, prepareFile, sha256Hex } from '../../src/lib/files/upload.js';
import { K } from '../../worker/keys.js';
import { createHarness } from '../worker/harness.js';

const MB = 1024 * 1024;
const PDF = new TextEncoder().encode('%PDF-1.7\n...');
const file = (name, bytes = PDF, type = '') => new File([bytes], name, { type });
const sized = (name, size) => ({ name, size, type: '' });

/** Just enough of an `openSpace` handle: entities in a map, patches applied locally and recorded. */
function stubSpace(ref, { can = () => true, files = [] } = {}) {
  const ents = new Map(files.map((entity) => [entity.id, entity]));
  const applied = [];
  let seq = 0;
  return {
    ref, applied, ents,
    can: (action) => can(action),
    get: (type, id) => (type === 'file' ? ents.get(id) : undefined),
    select: { file: { all: () => [...ents.values()] } },
    store: { async merge(list, del = []) { for (const { t, ...entity } of list) if (t === 'file') ents.set(entity.id, entity); for (const item of del) ents.delete(item.id); } },
    ops: { patch: (t, id, { set, unset }) => ({ opId: `op${++seq}`, t, id, ...(set ? { set } : {}), ...(unset ? { unset } : {}) }) },
    async apply(ops) {
      applied.push(...ops);
      for (const op of ops) {
        if (op.t !== 'file') continue;
        const entity = structuredClone(ents.get(op.id) ?? {});
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
        ents.set(op.id, entity);
      }
    },
  };
}

describe('file types', () => {
  it('allows the listed types and refuses video, markup, scripts and oversize files', () => {
    expect(rejectReason(sized('Ticket.PDF', 10))).toBeNull();
    expect(rejectReason(sized('boarding.pkpass', 10))).toBeNull();
    expect(rejectReason(sized('IMG_0001.HEIC', 80 * MB))).toBeNull();
    expect(rejectReason(sized('clip.mov', 10))).toBe('video_direct');
    expect(rejectReason({ name: 'clip', size: 10, type: 'video/mp4' })).toBe('video_direct');
    for (const name of ['logo.svg', 'page.html', 'feed.xml', 'run.js', 'setup.exe', 'noext']) expect(rejectReason(sized(name, 10))).toBe('file_type');
    expect(rejectReason(sized('big.pdf', 50 * MB + 1))).toBe('file_too_large');
    expect(rejectReason(sized('empty.txt', 0))).toBe('file_empty');
  });

  it('cleans names, keeps the extension and caps the length', () => {
    expect(cleanName('a/b\\c\u0000d.pdf')).toBe('a b c d.pdf');
    expect(cleanName('.pdf', 'pdf')).toBe('file.pdf');
    expect(cleanName(`${'x'.repeat(400)}.pdf`)).toHaveLength(200);
    expect(renameExtension('IMG_1.HEIC', 'jpg')).toBe('IMG_1.jpg');
  });

  it('types blobs so only images, PDF and plain text ever display', () => {
    expect(blobType('image/png')).toBe('image/png');
    expect(blobType('application/pdf')).toBe('application/pdf');
    expect(blobType('text/markdown')).toBe('text/plain;charset=utf-8');
    expect(blobType('text/html')).toBe('text/plain;charset=utf-8');
    expect(blobType('image/svg+xml')).toBe('application/octet-stream');
    expect(blobType('application/vnd.apple.pkpass')).toBe('application/octet-stream');
    expect(blobType('application/vnd.apple.pkpass', { download: true })).toBe('application/vnd.apple.pkpass');
    expect(previewKind({ mime: 'image/heic' })).toBe('heic');
    expect(previewKind({ mime: 'text/csv' })).toBe('text');
    expect(previewKind({ mime: 'application/msword' })).toBe('none');
    expect(groupOf({ mime: 'text/csv' })).toBe('document');
  });

  it('fits images inside the box and the canvas pixel cap without upscaling', () => {
    expect(fitSize(4032, 3024, 320)).toEqual({ width: 320, height: 240 });
    expect(fitSize(100, 50, 320)).toEqual({ width: 100, height: 50 });
    const big = fitSize(8064, 6048);
    expect(big.width * big.height).toBeLessThanOrEqual(16_000_000);
    expect(fitSize(0, 10, 320)).toBeNull();
  });
});

describe('file errors', () => {
  it('maps worker, network and local failures to string codes', () => {
    expect(errorCode(new ApiError(402, 'owner_credit'))).toBe('owner_credit');
    expect(errorCode(new ApiError(402, 'caller_credit'))).toBe('caller_credit');
    expect(errorCode(new ApiError(413, 'body_too_large'))).toBe('file_too_large');
    expect(errorCode(new ApiError(413, 'space_quota'))).toBe('space_quota');
    expect(errorCode(new ApiError(415, 'file_type'))).toBe('file_type');
    expect(errorCode(new ApiError(429, 'rate_limited'))).toBe('rate_limited');
    expect(errorCode(new ApiError(404, 'upload_missing'))).toBe('upload_missing');
    expect(errorCode(new ApiError(0, 'network'))).toBe('network');
    expect(errorCode(new ApiError(0, 'aborted'))).toBe('aborted');
    expect(errorCode(new ApiError(500, 'internal'))).toBe('unknown');
    expect(errorCode(new FileError('video_direct'))).toBe('video_direct');
  });
});

describe('object URL cache', () => {
  it('evicts least recently used blobs past the byte cap and revokes them', () => {
    let n = 0;
    const urls = { createObjectURL: vi.fn(() => `blob:${++n}`), revokeObjectURL: vi.fn() };
    const cache = createUrlCache({ maxBytes: 10, urls });
    cache.set('a', new Blob(['12345']));
    cache.set('b', new Blob(['12345']));
    expect(cache.get('a')).toBe('blob:1');
    cache.set('c', new Blob(['123']));
    expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:2');
    expect(cache.get('b')).toBeNull();
    expect(cache.bytes).toBe(8);
  });
});

describe('upload pipeline', () => {
  it('keeps HEIC as is when the browser cannot decode it, and hashes the bytes', async () => {
    const prepared = await prepareFile(file('IMG_7.HEIC', new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])));
    expect(prepared).toMatchObject({ name: 'IMG_7.heic', mime: 'image/heic', notice: 'heic_kept' });
    expect(prepared.sha256).toBe(await sha256Hex(new Blob([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])])));
    await expect(prepareFile(file('clip.mp4'))).rejects.toMatchObject({ code: 'video_direct' });
  });

  it('uploads through the real worker, registers the file and links it', async () => {
    const h = await createHarness({ ownerVerified: false });
    const sid = await h.team({ bob: 'editor' });
    const bob = await h.client('bob');
    const space = stubSpace({ w: 'trips-abcdefghij', s: sid, k: 'trip' });
    const states = [];
    const task = createUpload(space, file('Ticket.pdf'), { api: bob.api, link: { t: 'res', id: '0000000000000abc' }, onChange: (state) => states.push(state.status) });
    const { id, duplicate } = await task.run();
    expect(duplicate).toBe(false);
    expect(h.kv()[K.entity(sid, 'file', id)]).toMatchObject({ name: 'Ticket.pdf', mime: 'application/pdf', size: PDF.length, sha256: await sha256Hex(new Blob([PDF])), loc: { mode: 'proxied' } });
    expect(space.ents.get(id)).toMatchObject({ name: 'Ticket.pdf', linked: { res_0000000000000abc: true } });
    expect(space.applied).toEqual([expect.objectContaining({ t: 'file', id, set: { 'linked.res_0000000000000abc': true } })]);
    expect(states).toEqual(expect.arrayContaining(['preparing', 'uploading', 'saving', 'done']));
    expect(filesFor(space, { t: 'res', id: '0000000000000abc' }).map((item) => item.id)).toEqual([id]);
    await unlinkFile(space, id, { t: 'res', id: '0000000000000abc' });
    expect(space.applied.at(-1)).toMatchObject({ t: 'file', id, unset: ['linked.res_0000000000000abc'] });
    expect(filesFor(space, { t: 'res', id: '0000000000000abc' })).toEqual([]);
  });

  it('reuses a file with the same content instead of uploading again', async () => {
    const sha256 = await sha256Hex(new Blob([PDF]));
    const space = stubSpace({ w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' }, { files: [{ id: '00000000000000f1', kind: 'user', sha256, name: 'old.pdf', links: [{ t: 'res', id: '0000000000000abc' }] }] });
    const api = { upload: vi.fn(), call: vi.fn() };
    const result = await createUpload(space, file('again.pdf'), { api, link: { t: 'exp', id: '0000000000000e01' } }).run();
    expect(result).toMatchObject({ id: '00000000000000f1', duplicate: true });
    expect(api.upload).not.toHaveBeenCalled();
    // An older list stays as it is; the new link is its own path.
    expect(space.ents.get('00000000000000f1')).toMatchObject({ links: [{ t: 'res', id: '0000000000000abc' }], linked: { exp_0000000000000e01: true } });
    expect(filesFor(space, { t: 'res', id: '0000000000000abc' })).toHaveLength(1);
    expect(filesFor(space, { t: 'exp', id: '0000000000000e01' })).toHaveLength(1);
  });

  it('resumes after a failed registration without sending the bytes twice, and resends after the upload expired', async () => {
    const space = stubSpace({ w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' });
    const entity = (fileId) => ({ rev: 2, ents: [{ t: 'file', id: fileId, name: 'a.pdf', mime: 'application/pdf', size: PDF.length, sha256: 'a'.repeat(64), kind: 'user', loc: { mode: 'proxied' }, v: 'x', rev: 2, upd: 1, by: 'u', cr: 1 }], del: [] });
    const api = {
      upload: vi.fn(async () => ({ ok: true })),
      call: vi.fn()
        .mockRejectedValueOnce(new ApiError(0, 'network'))
        .mockRejectedValueOnce(new ApiError(404, 'upload_missing'))
        .mockImplementation(async (_ref, _op, input) => entity(input.fileId)),
    };
    const task = createUpload(space, file('a.pdf'), { api, dedupe: false });
    await expect(task.run()).rejects.toMatchObject({ code: 'network' });
    expect(task.state.status).toBe('error');
    await expect(task.run()).rejects.toMatchObject({ code: 'upload_missing' });
    expect(api.upload).toHaveBeenCalledTimes(1);
    const { id } = await task.run();
    expect(api.upload).toHaveBeenCalledTimes(2);
    expect(api.call.mock.calls.every(([, op, input]) => op === 'file.put' && input.fileId === id)).toBe(true);
    expect(task.state.status).toBe('done');
  });

  it('refuses without files.upload and reports cancellation', async () => {
    const space = stubSpace({ w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' }, { can: () => false });
    await expect(createUpload(space, file('a.pdf'), { api: {} }).run()).rejects.toMatchObject({ code: 'forbidden' });
    const open = stubSpace({ w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' });
    const controller = new AbortController();
    const api = { upload: vi.fn((_ref, _id, _blob, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new ApiError(0, 'aborted'))))), call: vi.fn() };
    const task = createUpload(open, file('b.pdf'), { api, signal: controller.signal, dedupe: false });
    const running = task.run();
    await vi.waitFor(() => expect(api.upload).toHaveBeenCalled());
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'aborted' });
    expect(task.state.status).toBe('canceled');
  });
});

describe('trip cover', () => {
  it('uploads an image, links it to the trip and sets meta.cover', async () => {
    const space = stubSpace({ w: 'trips-abcdefghij', s: '0000000000000003', k: 'trip' });
    const api = {
      upload: vi.fn(async () => ({ ok: true })),
      call: vi.fn(async (_ref, _op, input) => ({ rev: 2, del: [], ents: [{ t: 'file', id: input.fileId, name: input.name, mime: input.mime, size: 8, sha256: input.sha256, kind: 'user', loc: { mode: 'proxied' } }] })),
    };
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { id } = await uploadCover(space, file('cover.png', PNG), { api });
    expect(space.applied).toEqual([
      expect.objectContaining({ t: 'file', id, set: { 'linked.meta_meta': true } }),
      expect.objectContaining({ t: 'meta', id: 'meta', set: { cover: id } }),
    ]);
    await expect(uploadCover(space, file('notes.pdf'), { api })).rejects.toMatchObject({ code: 'cover_type' });
    const photo = await uploadImage(space, file('place.png', PNG), { api, links: [{ t: 'place', id: '00000000000000p1' }] });
    expect(space.applied.at(-1)).toMatchObject({ t: 'file', id: photo.id, set: { 'linked.place_00000000000000p1': true } });
    await expect(uploadImage(space, file('notes.pdf'), { api })).rejects.toMatchObject({ code: 'image_type' });
    const owner = stubSpace({ w: 'trips-abcdefghij', s: '0000000000000003', k: 'trip' }, { can: (action) => action !== 'trip.cover' });
    await expect(uploadCover(owner, file('cover.png', PNG), { api })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await coverUrl(space, { url: 'javascript:alert(1)' })).toBeNull();
    expect(await coverUrl(space, { url: 'https://images.example/a.jpg' })).toBe('https://images.example/a.jpg');
  });
});

describe('file URLs', () => {
  it('caches per content version, shares in-flight downloads and types image thumbnails', async () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let n = 0;
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => `blob:${++n}`), revokeObjectURL: vi.fn() }));
    try {
      const api = { download: vi.fn(async () => new Blob([PNG])) };
      bindFiles({ api });
      const space = stubSpace({ w: 'trips-abcdefghij', s: '0000000000000002', k: 'trip' }, { files: [{ id: '00000000000000f2', kind: 'user', mime: 'image/png', sha256: 'c'.repeat(64), thumb: '0000000000000t01' }] });
      const [a, b] = await Promise.all([fileUrl(space, '00000000000000f2', { thumb: true }), fileUrl(space, '00000000000000f2', { thumb: true })]);
      expect(a).toBe(b);
      expect(api.download).toHaveBeenCalledTimes(1);
      expect(URL.createObjectURL.mock.calls[0][0].type).toBe('image/png');
      space.ents.set('00000000000000f2', { ...space.ents.get('00000000000000f2'), thumb: '0000000000000t02' });
      expect(await fileUrl(space, '00000000000000f2', { thumb: true })).not.toBe(a);
      space.ents.set('00000000000000f3', { id: '00000000000000f3', kind: 'user', mime: 'application/pdf', sha256: 'd'.repeat(64) });
      expect(await fileUrl(space, '00000000000000f3', { thumb: true })).toBeNull();
    } finally {
      bindFiles({});
      vi.unstubAllGlobals();
    }
  });
});

describe('offline copies', () => {
  const account = '00000000-0000-4000-8000-000000000001';
  const ref = { w: 'trips-abcdefghij', s: '0000000000000003', k: 'trip' };
  const entity = { id: '00000000000000f4', kind: 'user', name: 'tickets.pdf', mime: 'application/pdf', sha256: 'e'.repeat(64), size: PDF.length, thumb: '0000000000000t04' };
  const offline = () => new ApiError(0, 'network');
  async function setup({ download = async () => { throw offline(); }, access } = {}) {
    const caches = createCaches();
    vi.stubGlobal('caches', caches);
    await storeFile({ account, ref, file: entity, blob: new Blob([PDF], { type: 'application/pdf' }), caches });
    const api = { download: vi.fn(download) };
    bindFiles({ api, account });
    const space = stubSpace(ref, { files: [entity] });
    if (access) space.fileAccess = async () => access;
    return { api, space };
  }
  const text = async (blob) => new TextDecoder().decode(await blob.arrayBuffer());
  afterEach(() => { bindFiles({}); resetDirect(); vi.unstubAllGlobals(); });

  it('reads a kept file from the offline copy when the worker cannot be reached', async () => {
    const { api, space } = await setup();
    const blob = await fileBlob(space, entity.id);
    expect(api.download).toHaveBeenCalledOnce();
    expect(blob.type).toBe('application/pdf');
    expect(await text(blob)).toBe(new TextDecoder().decode(PDF));
    // Thumbnails are not kept.
    await expect(fileBlob(space, entity.id, { thumb: true })).rejects.toMatchObject({ code: 'network' });
  });

  it('skips the network while offline, and never stands in for a refused or aborted read', async () => {
    const { api, space } = await setup({ download: async () => { throw new ApiError(403, 'forbidden'); } });
    await expect(fileBlob(space, entity.id)).rejects.toMatchObject({ status: 403 });
    api.download.mockImplementationOnce(async () => { throw new ApiError(0, 'aborted'); });
    await expect(fileBlob(space, entity.id)).rejects.toMatchObject({ code: 'aborted' });
    vi.stubGlobal('window', { navigator: { onLine: false }, localStorage: { getItem: () => null } });
    api.download.mockClear();
    expect(await text(await fileBlob(space, entity.id, { download: true }))).toContain('%PDF');
    let n = 0;
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => `blob:kept${++n}`), revokeObjectURL: vi.fn() }));
    expect(await fileUrl(space, entity.id)).toBe('blob:kept1');
    expect(api.download).not.toHaveBeenCalled();
  });

  it('falls back from a failed direct read too', async () => {
    const { api, space } = await setup({ access: { mode: 'direct', owner: true, account } });
    const puter = { fs: { read: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) } };
    const blob = await fileBlob(space, entity.id, { puter });
    expect(puter.fs.read).toHaveBeenCalledOnce();
    expect(api.download).not.toHaveBeenCalled();
    expect(await text(blob)).toContain('%PDF');
  });

  it('finds no copy for another account or a changed file', async () => {
    const { space } = await setup();
    bindFiles({ api: { download: async () => { throw offline(); } }, account: '00000000-0000-4000-8000-000000000002' });
    await expect(fileBlob(space, entity.id)).rejects.toMatchObject({ code: 'network' });
    bindFiles({ api: { download: async () => { throw offline(); } }, account });
    space.ents.set(entity.id, { ...entity, sha256: 'f'.repeat(64) });
    await expect(fileBlob(space, entity.id)).rejects.toMatchObject({ code: 'network' });
  });
});

