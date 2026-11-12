import { describe, it, expect } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { serializeDocument, parseDocument } from '../src/features/files/format.js';

describe('native format keeps what the document needs', () => {
  it('keeps an embedded color profile the document is assigned to', async () => {
    const doc = VDocument.create({ name: 'Profiled' });
    doc.assets.set('icc-00000000deadbeef', {
      mime: 'application/vnd.iccprofile',
      data: 'data:application/vnd.iccprofile;base64,AAAA',
      name: 'Test RGB',
    });
    doc.transact('Assign Profile', () => doc.updateRoot({ colorProfile: 'icc:00000000deadbeef' }));
    // An image asset nothing uses is still dropped.
    doc.assets.set('img-unused', { mime: 'image/png', data: 'data:image/png;base64,AAAA' });
    const { doc: back } = await parseDocument(await serializeDocument(doc));
    expect(back.root.colorProfile).toBe('icc:00000000deadbeef');
    expect(back.assets.get('icc-00000000deadbeef')?.data).toBe(
      'data:application/vnd.iccprofile;base64,AAAA',
    );
    expect(back.assets.has('img-unused')).toBe(false);
  });
});

describe('damaged documents', () => {
  const damaged = (mutate) => {
    const data = JSON.parse(JSON.stringify(VDocument.create({ name: 'Damaged' }).toJSON()));
    mutate(data.nodes);
    return new TextEncoder().encode(JSON.stringify(data));
  };

  it('replaces artboards that are all unusable, even when as many are left', async () => {
    const { doc, repaired } = await parseDocument(
      damaged((nodes) => {
        nodes.root.artboards = [null];
        nodes.root.type = '';
      }),
    );
    expect(doc.artboards).toHaveLength(1);
    expect(doc.artboards[0]).toMatchObject({ x: 0, y: 0, w: 612, h: 792 });
    expect(doc.root.type).toBe('root');
    expect(repaired).toBe(0);
  });

  it('repairs a root whose type is not text instead of failing with a program error', async () => {
    const { doc } = await parseDocument(
      damaged((nodes) => {
        nodes.root.type = [];
      }),
    );
    expect(doc.root.type).toBe('root');
    expect(doc.layers()).toHaveLength(1);
  });
});

describe('damaged object settings', () => {
  it('leaves out settings of the wrong kind so damaged objects draw and select', async () => {
    const { bootAppWithFeatures } = await import('./helpers.js');
    const { createPath, createText } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const src = VDocument.create({ name: 'Damaged' });
    const L = src.layers()[0].id;
    const ids = {};
    src.transact('Add', () => {
      for (const k of ['effects', 'effects2', 'stops', 'dash', 'dash2'])
        ids[k] = src.insert(createPath(rectangle(0, 0, 10, 10), true), L).id;
      ids.text = src.insert(
        createText('Hello there', 0, 40, { runs: [{ len: 5, fontWeight: 700 }, { len: 6 }] }),
        L,
      ).id;
    });
    const data = JSON.parse(JSON.stringify(src.toJSON()));
    const n = data.nodes;
    n[ids.effects].effects = true;
    n[ids.effects2].effects = [
      'x',
      null,
      { type: 'dropShadow', x: 2, y: 2, blur: 2, color: '#000000', opacity: 0.5 },
    ];
    n[ids.stops].fill = { type: 'linear', stops: {} };
    n[ids.dash].dash = 'x';
    n[ids.dash2].dash = [4, null, 2];
    n[ids.text].para.align = {};
    n[ids.text].para.indentFirst = [true];
    n[ids.text].char.fontSize = 'big';
    n[ids.text].runs = [null, { len: 5, fontWeight: 'x' }];
    n.root.guides = [null, { axis: 'x', pos: 10 }];
    const { doc } = await parseDocument(new TextEncoder().encode(JSON.stringify(data)));
    expect(doc.get(ids.effects).effects).toBeUndefined();
    expect(doc.get(ids.effects2).effects.map((e) => e.type)).toEqual(['dropShadow']);
    expect(doc.get(ids.stops).fill).toBeUndefined();
    expect(doc.get(ids.dash).dash).toBeUndefined();
    expect(doc.get(ids.dash2).dash).toEqual([4, 2]);
    const t = doc.get(ids.text);
    expect(t.para.align).toBeUndefined();
    expect(t.para.indentFirst).toBeUndefined();
    expect(t.char.fontSize).toBeUndefined();
    expect(t.runs).toEqual([{ len: 5 }]);
    expect(doc.root.guides).toEqual([{ axis: 'x', pos: 10 }]);
    // The repaired document draws, selects and shows its settings.
    const app = await bootAppWithFeatures();
    const ed = app.addDocument(doc);
    const view = app.views.get(ed);
    expect(() => {
      view.renderNow();
      ed.select(doc.get(L).children);
      view.renderNow();
      app.refreshChrome();
    }).not.toThrow();
  });

  it('keeps every setting of an intact document as it is', async () => {
    const { createPath, createText } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const src = VDocument.create({ name: 'Intact' });
    const L = src.layers()[0].id;
    src.transact('Add', () => {
      src.insert(
        createPath(rectangle(0, 0, 10, 10), true, {
          dash: [3, 1],
          effects: [{ type: 'dropShadow', x: 1 }],
          fill: {
            type: 'radial',
            stops: [
              { offset: 0, color: '#ff0000' },
              { offset: 1, color: '#0000ff' },
            ],
          },
        }),
        L,
      );
      src.insert(createText('Hi', 0, 40, { runs: [{ len: 1, fontWeight: 700 }, { len: 1 }] }), L);
    });
    const data = JSON.parse(JSON.stringify(src.toJSON()));
    const { validateData } = await import('../src/features/files/format.js');
    const out = validateData(data);
    expect(out.repaired).toBe(0);
    for (const id of Object.keys(data.nodes)) expect(out.data.nodes[id]).toBe(data.nodes[id]);
  });
});

describe('recovery copies', () => {
  it('never forgets other copies when the list of copies cannot be read for a moment', async () => {
    const { RecoveryStore } = await import('../src/features/files/recovery.js');
    const { memoryBackend } = await import('../src/features/files/backends.js');
    const cloud = memoryBackend();
    const local = memoryBackend();
    const store = new RecoveryStore([cloud, local]);
    await store.put('r1', { name: 'First', data: new Uint8Array([1]), session: 's', saved: 1 });
    // The connection drops while the list is read (the copy itself was written).
    const readJSON = cloud.readJSON;
    cloud.readJSON = async () => {
      cloud.readJSON = readJSON;
      throw new Error('Network error');
    };
    await store.put('r2', { name: 'Second', data: new Uint8Array([2]), session: 's', saved: 2 });
    expect((await store.list()).map((e) => e.name).sort()).toEqual(['First', 'Second']);
    // A damaged list is started over, so copies can still be kept.
    cloud.files.set('recovery/index.json', '{not json');
    await store.put('r3', { name: 'Third', data: new Uint8Array([3]), session: 's', saved: 3 });
    expect((await store.list()).map((e) => e.name)).toContain('Third');
  });
});

describe('shared documents carry what an edit needs', () => {
  it('sends an embedded color profile with the edit that assigns it', async () => {
    const { network, shareNew, joinClient, settle, alice, bob } =
      await import('./collab-helpers.js');
    const net = network();
    const { room, client: a } = await shareNew(net);
    const { token } = await net.service.call(alice, { op: 'invite', room, role: 'editor' });
    const b = await joinClient(net, bob, room, { invite: token });
    a.doc.assets.set('icc-00000000deadbeef', {
      mime: 'application/vnd.iccprofile',
      data: 'data:application/vnd.iccprofile;base64,AAAA',
      name: 'Test RGB',
    });
    a.doc.transact('Assign Profile', () =>
      a.doc.updateRoot({ colorProfile: 'icc:00000000deadbeef' }),
    );
    await settle(a, b);
    expect(b.doc.root.colorProfile).toBe('icc:00000000deadbeef');
    expect(b.doc.assets.get('icc-00000000deadbeef')?.data).toBe(
      'data:application/vnd.iccprofile;base64,AAAA',
    );
  });
});

describe('closing with unsaved changes', () => {
  const waitDialog = async () => {
    for (let i = 0; i < 50 && !document.querySelector('dialog[open]'); i++)
      await new Promise((r) => setTimeout(r, 10));
    return document.querySelector('dialog[open]');
  };
  const click = (dlg, label) =>
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === label).click();

  it('keeps an edit made while Close > Save is writing', async () => {
    const { bootAppWithFeatures } = await import('./helpers.js');
    const { createPath } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const app = await bootAppWithFeatures({ env: 'app', user: { username: 'u' } });
    const files = new Map();
    let release = null;
    app.puter = {
      fs: {
        write: async (path, blob) => {
          if (!release) await new Promise((r) => (release = r));
          files.set(path, new Uint8Array(await blob.arrayBuffer()));
          return { path, name: path.split('/').pop() };
        },
      },
    };
    const doc = VDocument.create({ name: 'Logo' });
    const ed = app.addDocument(doc, {
      file: { kind: 'puter', path: '/u/Logo.vstudio', name: 'Logo.vstudio' },
    });
    const layer = doc.layers()[0].id;
    doc.transact('Add', () => doc.insert(createPath(rectangle(0, 0, 10, 10), true), layer));
    const closing = app.closeDocument(ed);
    click(await waitDialog(), 'Save');
    for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 10));
    // The prompt is gone while the file is written: the user keeps drawing.
    doc.transact('Add', () => doc.insert(createPath(rectangle(20, 0, 10, 10), true), layer));
    release();
    // Asked again rather than closing without the new change.
    const again = await waitDialog();
    expect(again.textContent).toMatch(/Save changes to "Logo.vstudio"/);
    click(again, 'Save');
    expect(await closing).toBe(true);
    expect(app.editors.includes(ed)).toBe(false);
    const { doc: back } = await parseDocument(files.get('/u/Logo.vstudio'));
    expect(back.get(layer).children.length).toBe(2);
    await app.files.autosaver.busy;
  });
});

describe('scripts', () => {
  it('does not count the time a prompt waits for an answer against the time limit', async () => {
    const { bootAppWithFeatures } = await import('./helpers.js');
    const { runScript } = await import('../src/features/scripts/runner.js');
    const app = await bootAppWithFeatures();
    app.newDocument();
    const run = runScript(app, 'return await vs.prompt("Name");', { name: 'Ask', timeoutMs: 400 });
    const frame = document.querySelector('iframe[sandbox]');
    // The script side (running in the sandboxed frame in a browser) asks for a value.
    const send = (data) =>
      window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
    send({ __vs: 'call', id: 1, method: 'prompt', args: ['Name', ''] });
    let dlg = null;
    for (let i = 0; i < 50 && !dlg; i++) {
      await new Promise((r) => setTimeout(r, 10));
      dlg = document.querySelector('dialog[open]');
    }
    // The user takes longer than the time limit to answer.
    await new Promise((r) => setTimeout(r, 800));
    let settled = false;
    run.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await new Promise((r) => setTimeout(r, 0));
    send({ __vs: 'done', value: 'Ada' });
    expect(await run).toMatchObject({ ok: true, value: 'Ada' });
  });
});

describe('a shared document shown in two windows', () => {
  it('keeps sharing edits after the window it was opened in is closed', async () => {
    const { bootAppWithFeatures } = await import('./helpers.js');
    const { network, shareNew, settle, rect, alice, bob, SERVER } =
      await import('./collab-helpers.js');
    const { memoryOutbox } = await import('../src/features/collab/outbox.js');
    const net = network();
    const { room, client: owner } = await shareNew(net);
    const { token } = await net.service.call(alice, { op: 'invite', room, role: 'editor' });
    const app = await bootAppWithFeatures({ user: bob });
    app.collab.transportFor = () => net.transport(bob);
    app.collab.deployServer = async () => SERVER;
    app.collab.outbox = memoryOutbox();
    app.collab.sessionOptions = { timers: false };
    const first = await app.collab.open({ server: SERVER, room, invite: token });
    await app.commands.run('window.newWindow');
    const second = app.editor;
    expect(second).not.toBe(first);
    expect(second.doc).toBe(first.doc);
    await app.closeDocument(first);
    const session = app.collab.sessionOf(second);
    expect(session).toBeTruthy();
    const L = second.doc.root.children[0];
    second.doc.transact('Add', () => second.doc.insert(rect('fromSecond', 5, 5), L));
    await settle({ session }, owner);
    expect(owner.doc.get('fromSecond')).toBeTruthy();
    session.close();
  });

  it('saves and comments in the second window as in the first, instead of treating it as a personal file', async () => {
    const { bootAppWithFeatures } = await import('./helpers.js');
    const { network, shareNew, settle, alice, bob, SERVER } = await import('./collab-helpers.js');
    const { memoryOutbox } = await import('../src/features/collab/outbox.js');
    const net = network();
    const { room, client: owner } = await shareNew(net);
    const { token } = await net.service.call(alice, { op: 'invite', room, role: 'editor' });
    const app = await bootAppWithFeatures({ user: bob });
    app.collab.transportFor = () => net.transport(bob);
    app.collab.deployServer = async () => SERVER;
    app.collab.outbox = memoryOutbox();
    app.collab.sessionOptions = { timers: false };
    const first = await app.collab.open({ server: SERVER, room, invite: token });
    const session = app.collab.sessionOf(first);
    await app.commands.run('window.newWindow');
    const second = app.editor;
    expect(app.collab.sessionOf(second)).toBe(session);
    expect(second.collab).toBe(session);
    // Save sends what is pending (no Save As dialog for a personal copy).
    expect(await app.commands.run('file.save', { editor: second })).toBe(true);
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(second.file.kind).toBe('shared');
    // A comment made there reaches the others.
    app.comments.addThread('Hello from the second window', { x: 10, y: 10 });
    await settle({ session }, owner);
    expect(JSON.stringify(owner.doc.comments)).toContain('Hello from the second window');
    session.close();
  });
});

describe('a document shown in two windows', () => {
  async function twoWindows() {
    const { bootAppWithFeatures } = await import('./helpers.js');
    const { createPath } = await import('../src/model/nodes.js');
    const { rectangle } = await import('../src/model/shapes.js');
    const app = await bootAppWithFeatures({ env: 'app', user: { username: 'u' } });
    const files = new Map();
    app.puter = {
      fs: {
        write: async (path, blob) => {
          files.set(path, new Uint8Array(await blob.arrayBuffer()));
          return { path, name: path.split('/').pop() };
        },
      },
      ui: {
        showSaveFilePicker: async (blob, name) => {
          const path = `/u/Other/${name}`;
          files.set(path, new Uint8Array(await blob.arrayBuffer()));
          return { path, name };
        },
      },
    };
    app.prefs.set('filesSaveDialog', 'puter');
    const doc = VDocument.create({ name: 'Logo' });
    const first = app.addDocument(doc, {
      file: { kind: 'puter', path: '/u/Logo.vstudio', name: 'Logo.vstudio' },
    });
    await app.commands.run('window.newWindow');
    const second = app.editor;
    const add = () =>
      doc.transact('Add', () =>
        doc.insert(createPath(rectangle(0, 0, 10, 10), true), doc.layers()[0].id),
      );
    return { app, files, doc, first, second, add };
  }

  it('saves to the file chosen with Save As in the other window', async () => {
    const { app, files, doc, first, second, add } = await twoWindows();
    add();
    expect(await app.files.service.saveAs(first)).toBe(true);
    expect(first.file.path).toBe('/u/Other/Logo.vstudio');
    add();
    expect(await app.files.service.save(second)).toBe(true);
    const { doc: back } = await parseDocument(files.get('/u/Other/Logo.vstudio'));
    expect(back.get(doc.layers()[0].id).children).toHaveLength(2);
    expect(files.has('/u/Logo.vstudio')).toBe(false);
  });

  it('keeps one recovery copy for the document, gone once it is saved', async () => {
    const { RecoveryStore } = await import('../src/features/files/recovery.js');
    const { memoryBackend } = await import('../src/features/files/backends.js');
    const { app, first, second, add } = await twoWindows();
    const store = new RecoveryStore([memoryBackend()]);
    app.files.autosaver.fixedStore = store;
    add();
    await app.files.autosaver.flush();
    expect(await store.list()).toHaveLength(1);
    expect(await app.files.service.save(second)).toBe(true);
    await store.queue;
    expect(await store.list()).toHaveLength(0);
    // Closing one window of an unsaved document keeps the copy for the other.
    add();
    await app.files.autosaver.flush();
    await app.closeDocument(first);
    await store.queue;
    expect(await store.list()).toHaveLength(1);
  });
});
