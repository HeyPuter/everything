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
