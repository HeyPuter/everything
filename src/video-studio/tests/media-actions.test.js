import { describe, it, expect, afterEach, vi } from 'vitest';
import { unusedAssets, swapAsset, createMediaActions } from '../src/ui/media-actions.js';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { EditorStore } from '../src/model/store.js';
import { MediaService } from '../src/media/media-service.js';
import { createCompound } from '../src/model/compound.js';
import { normalizeAsset, normalizeProject } from '../src/model/project.js';
import { fixture, clip, onMain, addAsset, s } from './helpers.js';

afterEach(() => {
  document.querySelectorAll('dialog').forEach((d) => d.remove());
  vi.restoreAllMocks();
});

describe('media housekeeping', () => {
  it('finds assets no clip uses, keeping reversed pairs together', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 2));
    addAsset(p, { id: 'rev', kind: 'video', duration: s(10), reversedOf: 'silent' });
    const ids = unusedAssets(p).map((a) => a.id).sort();
    expect(ids).toEqual(['aud', 'img', 'rev', 'silent']);
    p.tracks[0].clips[0].assetId = 'rev';
    expect(unusedAssets(p).map((a) => a.id).sort()).toEqual(['aud', 'img', 'vid']);
  });

  it('points every clip at a new file', () => {
    const p = fixture();
    const [a, b] = onMain(p, clip('video', 0, 2, { name: 'vid' }), clip('video', 2, 2, { name: 'Custom' }));
    p.assets.vid.folder = 'f1';
    const n = swapAsset(p, 'vid', { id: 'new', kind: 'video', name: 'take2.mp4', duration: s(10) });
    expect(n).toBe(2);
    expect(p.assets.vid).toBeUndefined();
    expect(p.assets.new.folder).toBe('f1');
    expect(a.assetId).toBe('new');
    expect(a.name).toBe('take2.mp4');
    expect(b.name).toBe('Custom');
  });
});

describe('replacing a video with a photo', () => {
  it('turns its video clips into photo clips and drops the clips that played its sound', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 4, { in: s(2), speed: 2, reversed: true }));
    p.tracks.push({ id: 'ta', kind: 'audio', locked: false, hidden: false, muted: false, clips: [clip('audio', 0, 4, { assetId: 'vid' })] });
    const n = swapAsset(p, 'vid', normalizeAsset({ id: 'still', kind: 'image', name: 'still.png', hash: 'h', ext: 'png', width: 100, height: 100 }));
    expect(n).toBe(1);
    const reopened = normalizeProject(JSON.parse(JSON.stringify(p)));
    const clips = reopened.tracks.flatMap((t) => t.clips);
    expect(clips.map((c) => [c.id, c.type, c.assetId])).toEqual([[v.id, 'image', 'still']]);
  });

  it('asks first when clips play the video\'s sound', async () => {
    const p = fixture();
    onMain(p, clip('video', 0, 4));
    p.tracks.push({ id: 'ta', kind: 'audio', locked: false, hidden: false, muted: false, clips: [clip('audio', 0, 4, { assetId: 'vid' })] });
    const store = new EditorStore(p);
    const library = { importFile: async () => normalizeAsset({ id: 'still', kind: 'image', name: 'still.png', hash: 'h', ext: 'png', width: 10, height: 10 }) };
    const actions = createMediaActions({ store, library });
    const pick = () => {
      const input = document.querySelector('input[type=file]');
      Object.defineProperty(input, 'files', { value: [new File(['x'], 'still.png', { type: 'image/png' })] });
      input.dispatchEvent(new Event('change'));
    };
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const first = actions.replaceAssetFile('vid');
    pick();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('dialog[open]').textContent).toContain('1 audio clip');
    [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Cancel').click();
    expect(await first).toBeNull();
    expect(store.project.assets.vid).toBeTruthy();
    const second = actions.replaceAssetFile('vid');
    pick();
    await new Promise((r) => setTimeout(r, 0));
    [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Replace').click();
    expect((await second).id).toBe('still');
    expect(store.project.tracks.flatMap((t) => t.clips).map((c) => c.type)).toEqual(['image']);
  });
});

describe('find missing media', () => {
  function setup() {
    const backend = memoryBackend();
    const library = new Library(backend);
    const p = fixture();
    for (const [id, hash] of [['vid', 'h1'], ['aud', 'h2'], ['img', 'h3'], ['silent', 'h4']]) Object.assign(p.assets[id], { hash, ext: 'mp4' });
    backend.files.set('media/h1.mp4', new Blob(['v']));
    backend.files.set('media/h2.mp4', new Blob(['a']));
    const store = new EditorStore(p);
    return { backend, library, store, actions: createMediaActions({ store, library }) };
  }

  it('checks storage with one listing instead of downloading every file', async () => {
    const { backend, library, actions } = setup();
    let reads = 0;
    const read = backend.readBlob;
    backend.readBlob = async (path) => (reads++, read(path));
    // In memory from this session, but never stored: that is not "present".
    library.blobs.set('h3', new Blob(['i']));
    const missing = await actions.findMissingMedia();
    expect(missing.map((a) => a.id).sort()).toEqual(['img', 'silent']);
    expect(reads).toBe(0);
    expect(document.querySelector('dialog[open]')?.textContent).toContain('2 files are missing');
  });

  it('checks on open, marks the missing files and offers to find them', async () => {
    const { store, library } = setup();
    const media = new MediaService(library);
    const events = [];
    media.on('missing', () => events.push([...media.missing].sort()));
    const actions = createMediaActions({ store, library, media });
    expect(await actions.checkMissingMedia({ notify: true })).toBe(2);
    expect(events).toEqual([['h3', 'h4']]);
    const t = [...document.querySelectorAll('.toast')].at(-1);
    expect(t.textContent).toContain('2 media files are missing');
    t.querySelector('.toast-action').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('dialog[open]')?.textContent).toContain('Missing media');
  });

  it('says nothing on open when every file is there', async () => {
    const { store, library, backend } = setup();
    backend.files.set('media/h3.mp4', new Blob(['i']));
    backend.files.set('media/h4.mp4', new Blob(['s']));
    const before = document.querySelectorAll('.toast').length;
    const media = new MediaService(library);
    expect(await createMediaActions({ store, library, media }).checkMissingMedia({ notify: true })).toBe(0);
    expect(document.querySelectorAll('.toast').length).toBe(before);
    expect(media.missing.size).toBe(0);
  });

  it('does not count files that are still uploading as missing', async () => {
    const { library, actions } = setup();
    library.uploads.set('h3', new Promise(() => {}));
    const missing = await actions.findMissingMedia();
    expect(missing.map((a) => a.id)).toEqual(['silent']);
  });
});

describe('media actions while a compound clip is open', () => {
  function setup() {
    const p = fixture();
    const [, b] = onMain(p, clip('video', 0, 5), clip('video', 5, 5, { assetId: 'silent' }));
    const comp = createCompound(p, [b.id], { ripple: true, linkOverlays: true });
    const store = new EditorStore(p);
    store.openCompound(comp.id);
    return { store, actions: createMediaActions({ store, library: null }) };
  }
  const confirm = async () => {
    await new Promise((r) => setTimeout(r, 0));
    [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Remove').click();
  };

  it('Remove unused media keeps media used outside the compound clip, and undo brings removed media back', async () => {
    const { store, actions } = setup();
    const done = actions.removeUnusedMedia();
    await confirm();
    expect(await done).toBe(2);
    expect(Object.keys(store.project.assets).sort()).toEqual(['silent', 'vid']);
    store.undo();
    expect(Object.keys(store.project.assets).sort()).toEqual(['aud', 'img', 'silent', 'vid']);
    store.redo();
    store.closeCompound();
    expect(Object.keys(store.project.assets).sort()).toEqual(['silent', 'vid']);
    store.undo();
    expect(Object.keys(store.project.assets).sort()).toEqual(['aud', 'img', 'silent', 'vid']);
  });

  it('Replace file switches clips outside the compound clip too', async () => {
    const { store } = setup();
    const library = { importFile: async () => normalizeAsset({ id: 'take2', kind: 'video', name: 'take2.mp4', hash: 'h', ext: 'mp4', duration: s(20) }) };
    const actions = createMediaActions({ store, library });
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function click() {
      Object.defineProperty(this, 'files', { value: [new File(['x'], 'take2.mp4', { type: 'video/mp4' })] });
      this.dispatchEvent(new Event('change'));
    });
    await actions.replaceAssetFile('vid');
    const saved = normalizeProject(JSON.parse(JSON.stringify(store.projectForSave())));
    expect(saved.tracks.flatMap((t) => t.clips).map((c) => c.assetId)).toEqual(['take2', undefined]);
    expect(saved.assets.vid).toBeUndefined();
  });

  it('knows which media clips outside the compound clip use', () => {
    const { store, actions } = setup();
    expect(actions.usedOutsideCompound(['vid', 'silent', 'aud'])).toEqual(['vid']);
    store.closeCompound();
    expect(actions.usedOutsideCompound(['vid', 'silent'])).toEqual([]);
  });
});
