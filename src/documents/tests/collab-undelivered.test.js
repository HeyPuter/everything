// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { createSharedDoc } from '../src/collab/shared-doc.js';
import { editorState } from '../src/collab/binding.js';
import { CollabClient } from '../src/collab/client.js';
import { MemoryHub } from '../src/collab/transports.js';
import { Doc } from '../src/lib/doc.js';

const { createCollaboration } = await import('../src/views/collab.js');

class FakeEngine {
  constructor() { this.session = new StorySession(new TextDocument([paragraph('Shared')])); this.images = new Map(); this.composition = null; this.readOnly = false; this.viewOnly = false; this.overlays = []; }
  get model() { return this.session.model; }
  relayout() {} paint() {} syncInput() {} focus() {} onChange() {} setRangeTints() {} finishComposition() {}
  setViewOnly(on) { this.viewOnly = !!on; }
  execute(action) { this.session.run(() => action(this.model)); }
}
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function settle() { for (let i = 0; i < 10; i++) await tick(); }

let hub;
beforeEach(() => {
  hub = new MemoryHub(Y.encodeStateAsUpdate(createSharedDoc(editorState({ session: { body: new TextDocument([paragraph('Shared')]), storyEdits: {} } }))));
});

/** A guest who opened the document from an invitation: the owner saves the file, so the room is where their edits go. */
async function guest() {
  const transport = hub.connect('editor');
  const client = new CollabClient({ transport, user: { id: 'u1', name: 'Bob' }, room: 'r1', sendDelay: 0 });
  await client.connect();
  const engine = new FakeEngine();
  const doc = new Doc({ name: 'Plan' });
  doc.setSaving(false);
  doc.collab = { client, link: { server: 'https://documents-abc.puter.work', room: 'r1' } };
  doc.attach(async () => new Blob([engine.model.text]));
  const collab = createCollaboration({ editor: () => engine, pkg: () => ({ assets: {} }), doc, local: false, error: e => { throw e; }, user: () => ({ id: 'u1', name: 'Bob' }), documentName: () => 'Plan' });
  await collab.attach();
  await settle();
  return { transport, client, engine, doc, collab };
}

describe('a guest\'s changes that have not reached the room', () => {
  it('count as at stake until the room has them, and go out once the connection is back', async () => {
    const { transport, engine, doc, collab } = await guest();
    transport.setOnline(false);
    engine.execute(m => { m.select(6); m.replace(' plan'); });
    await settle();
    // Nothing for the file to save (the owner does), but the edit exists only in this tab.
    expect(doc.dirty).toBe(false);
    expect(collab.undelivered).toBe(true);
    expect(await collab.deliver()).toBe(false);
    transport.setOnline(true);
    expect(await collab.deliver()).toBe(true);
    expect(collab.undelivered).toBe(false);
    expect(hub.doc.getText('body').toString()).toContain('Shared plan');
    collab.destroy();
  });

  it('are none of the guest\'s concern in a document this tab saves', async () => {
    const { transport, engine, doc, collab } = await guest();
    // Sharing ended: the document is this tab's own copy now, which it saves.
    doc.setSaving(true);
    transport.setOnline(false);
    engine.execute(m => { m.select(6); m.replace(' plan'); });
    await settle();
    expect(collab.undelivered).toBe(false);
    expect(await collab.deliver()).toBe(true);
    collab.destroy();
  });
});
