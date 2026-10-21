import { describe, it, expect, afterEach } from 'vitest';
import { unusedAssets, swapAsset, createMediaActions } from '../src/ui/media-actions.js';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { EditorStore } from '../src/model/store.js';
import { fixture, clip, onMain, addAsset, s } from './helpers.js';

afterEach(() => document.querySelectorAll('dialog').forEach((d) => d.remove()));

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

  it('does not count files that are still uploading as missing', async () => {
    const { library, actions } = setup();
    library.uploads.set('h3', new Promise(() => {}));
    const missing = await actions.findMissingMedia();
    expect(missing.map((a) => a.id)).toEqual(['silent']);
  });
});
