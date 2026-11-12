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
