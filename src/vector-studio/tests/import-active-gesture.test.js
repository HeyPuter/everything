import { expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createImage } from '../src/model/nodes.js';
import { placeImage, placeSVG } from '../src/features/io/place.js';
import { replaceImage, unembedImages } from '../src/features/panels/links.js';
import { placeForeign } from '../src/features/interop/lazy.js';

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const pointer = (x, y) => ({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, timeStamp: 1000 });
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  ed.doc.assets.set('original', { mime: 'image/png', data: 'data:image/png;base64,original' });
  const node = createImage('original', 10, 10);
  ed.doc.transact('Image', () => ed.doc.insert(node, ed.targetLayer().id));
  ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  app.setTool('rectangle');
  app.input.down(pointer(100, 100));
  app.input.move(pointer(200, 200));
  expect(ed.doc.tx).toBeTruthy();
  return { app, ed, node };
}

// Observe actual decoding, without replacing the decoder or the document transaction code.
function observeDecode() {
  let ready;
  const decoded = new Promise((resolve) => { ready = resolve; });
  const read = FileReader.prototype.readAsDataURL;
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (blob) {
    this.addEventListener('loadend', ready, { once: true });
    return read.call(this, blob);
  });
  return decoded;
}

it.each(['place', 'replace', 'unembed', 'svg', 'eps'].flatMap((kind) => ['cancel', 'commit'].map((ending) => [kind, ending])))('%s stays independent of a drawing gesture that ends with %s', async (kind, ending) => {
  const { app, ed, node } = await setup();
  const gesture = ed.doc.tx;
  const history = ed.doc.undoStack.length;
  const vector = kind === 'svg' || kind === 'eps';
  let loading;
  try {
    if (kind === 'unembed') {
      vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob([png], { type: 'image/png' }) })));
      app.user = { username: 'test' };
      app.puter = { ui: { showSaveFilePicker: vi.fn(async () => ({ path: '/u/Image.png' })) } };
      loading = unembedImages(app, ed, [node.id]);
      await vi.waitFor(() => expect(app.puter.ui.showSaveFilePicker).toHaveBeenCalledOnce());
    } else if (vector) {
      app.root.removeAttribute('aria-busy');
      loading = kind === 'svg'
        ? placeSVG(app, ed, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="30"/></svg>')
        : placeForeign(app, ed, new File(['%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 20 30\n0 0 20 30 rectfill\n'], 'Shape.eps'), 'eps');
      await vi.waitFor(() => expect(app.root.getAttribute('aria-busy')).toBe('false'));
    } else {
      const decoded = observeDecode();
      const blob = new Blob([png], { type: 'image/png' });
      loading = kind === 'place' ? placeImage(app, ed, blob) : replaceImage(app, ed, [node.id], blob);
      await decoded;
    }
    let settled = false;
    loading.then(() => { settled = true; });
    await turn();
    expect.soft(settled).toBe(false);
    expect.soft(ed.doc.tx === gesture).toBe(true);
    expect.soft(ed.doc.assets.size).toBe(1);
    // The user's drawing remains responsive while the import waits.
    app.input.move(pointer(300, 300));
    if (ending === 'cancel') app.input.cancel(pointer(300, 300));
    else app.input.up(pointer(300, 300));
    expect(await loading).toBeTruthy();
    const paths = () => ed.doc.leaves().filter((n) => n.type === 'path');
    const drawn = ending === 'commit' ? 1 : 0;
    expect(paths()).toHaveLength(drawn + (vector ? 1 : 0));
    if (kind === 'place') expect(ed.doc.leaves().filter((n) => n.type === 'image')).toHaveLength(2);
    if (kind === 'replace') expect(ed.doc.get(node.id).asset).not.toBe('original');
    if (kind === 'unembed') expect(ed.doc.get(node.id).link?.path).toBe('/u/Image.png');
    expect(ed.doc.undoStack.length).toBe(history + drawn + 1);
    ed.doc.undo();
    expect(paths()).toHaveLength(drawn);
    expect(ed.doc.leaves().filter((n) => n.type === 'image')).toHaveLength(1);
    expect(ed.doc.get(node.id).asset).toBe('original');
    expect(ed.doc.get(node.id).link).toBeUndefined();
    ed.doc.redo();
    if (kind === 'replace') expect(ed.doc.get(node.id).asset).not.toBe('original');
    if (kind === 'unembed') expect(ed.doc.get(node.id).link?.path).toBe('/u/Image.png');
    expect(paths()).toHaveLength(drawn + (vector ? 1 : 0));
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
    await loading;
  }
});

it('discards a waiting import when its background shared window closes without ending the other window’s gesture', async () => {
  const { app, ed } = await setup();
  const background = app.addDocument(ed.doc, { activate: false });
  const gesture = ed.doc.tx;
  const decoded = observeDecode();
  try {
    const loading = placeImage(app, background, new Blob([png], { type: 'image/png' }));
    await decoded;
    await turn();
    await app.closeDocument(background, { force: true });
    expect(await loading).toBeNull();
    expect(ed.doc.tx === gesture).toBe(true);
    expect(ed.doc.assets.size).toBe(1);
    app.input.up(pointer(200, 200));
    expect(ed.doc.leaves().filter((n) => n.type === 'path')).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
    for (const editor of [...app.editors]) await app.closeDocument(editor, { force: true });
  }
});

it('waits for another transaction started by a commit listener before applying the import', async () => {
  const { app, ed, node } = await setup();
  const decoded = observeDecode();
  let next;
  const off = ed.doc.on('change', ({ commit }) => {
    if (!commit || ed.doc.tx || next) return;
    next = ed.doc.begin('Next edit');
    ed.doc.update(node.id, { transform: [2, 0, 0, 2, 30, 40] });
  });
  try {
    const loading = placeImage(app, ed, new Blob([png], { type: 'image/png' }));
    await decoded;
    await turn();
    app.input.up(pointer(200, 200));
    await turn();
    expect(next).toBeTruthy();
    expect(ed.doc.tx === next).toBe(true);
    expect(ed.doc.assets.size).toBe(1);
    next.cancel();
    expect(await loading).toBeTruthy();
    expect(ed.doc.assets.size).toBe(2);
    ed.doc.undo();
    expect(ed.doc.leaves().filter((n) => n.type === 'path')).toHaveLength(1);
    expect(ed.doc.get(node.id).transform).toEqual(node.transform);
  } finally {
    off();
    next?.cancel();
    vi.restoreAllMocks();
    await app.closeDocument(ed, { force: true });
  }
});

it('rechecks replacement ownership after waiting, so a superseded request adds no artwork or history', async () => {
  const { app, ed, node } = await setup();
  let history = ed.doc.undoStack.length;
  try {
    let decoded = observeDecode();
    const older = replaceImage(app, ed, [node.id], new Blob([png], { type: 'image/png' }), { link: { path: '/u/Older.png' } });
    await decoded;
    await turn();
    vi.restoreAllMocks();
    decoded = observeDecode();
    const newer = replaceImage(app, ed, [node.id], new Blob([png], { type: 'image/png' }), { link: { path: '/u/Newer.png' } });
    await decoded;
    await turn();
    app.input.cancel(pointer(200, 200));
    expect(await older).toBeNull();
    expect(await newer).toBeTruthy();
    expect(ed.doc.get(node.id).link.path).toBe('/u/Newer.png');
    expect(ed.doc.assets.size).toBe(2);
    expect(ed.doc.undoStack.length).toBe(history + 1);
    ed.doc.undo();
    expect(ed.doc.get(node.id).asset).toBe('original');
  } finally {
    vi.restoreAllMocks();
    await app.closeDocument(ed, { force: true });
  }
});
