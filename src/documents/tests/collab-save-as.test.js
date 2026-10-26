// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';

vi.mock('../src/lib/puter.js', async (importOriginal) => {
  const real = await importOriginal();
  const files = new Map();
  let clock = 1;
  return {
    ...real,
    __files: files,
    fileExists: async (path) => files.has(path),
    statFile: async (path) => (files.has(path) ? { path, modified: files.get(path).modified } : null),
    writeFile: vi.fn(async (path, blob) => { files.set(path, { blob, modified: ++clock }); return { path, modified: clock }; }),
  };
});

import { TextDocument, paragraph } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { createSharedDoc } from '../src/collab/shared-doc.js';
import { editorState } from '../src/collab/binding.js';
import { CollabClient } from '../src/collab/client.js';
import { MemoryHub } from '../src/collab/transports.js';
import { Doc, versioning, publishing } from '../src/lib/doc.js';
import * as P from '../src/lib/puter.js';

let hub = null;
let joinAs = null;
vi.mock('../src/collab/live.js', async (importOriginal) => ({
  ...await importOriginal(),
  // The owner reopening a document they shared: the room is the test's hub.
  reconnect: async () => {
    const client = new CollabClient({ transport: hub.connect(joinAs.role), user: joinAs.user, room: 'r1', sendDelay: 0 });
    await client.connect();
    return { client, link: { server: 'https://documents-abc.puter.work', room: 'r1' } };
  },
}));
const { createCollaboration } = await import('../src/views/collab.js');

class FakeEngine {
  constructor() { this.session = new StorySession(new TextDocument([paragraph('Shared')])); this.images = new Map(); this.composition = null; this.readOnly = false; this.viewOnly = false; this.overlays = []; }
  get model() { return this.session.model; }
  relayout() {} paint() {} syncInput() {} focus() {} onChange() {} setRangeTints() {} finishComposition() {}
  setViewOnly(on) { this.viewOnly = !!on; }
  execute(action) { this.session.run(() => action(this.model)); }
}
/** An edit, reported to the document as the editor does. */
const type = (engine, doc, at, text) => { engine.execute(m => { m.select(at); m.replace(text); }); doc.changed(); };
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function settle() { for (let i = 0; i < 10; i++) await tick(); }
const PATH = 'Documents/Plan.docx';
/** What the room holds, so a change that reached it shows. */
const roomState = () => Y.encodeStateVector(hub.doc).join(',');
/** A file's bytes as text (jsdom's Blob cannot read itself). */
const file = path => P.__files.get(path)?.blob.content;
const bytes = content => Object.assign(new Blob([content]), { content });

async function openShared({ role, user, path }) {
  joinAs = { role, user };
  const engine = new FakeEngine();
  const doc = new Doc({ name: 'Plan', path, modified: path ? 1 : null });
  // A guest opens the document from an invitation: the room's client comes with it, and the owner saves the file.
  if (!path) {
    const client = new CollabClient({ transport: hub.connect(role), user, room: 'r1', sendDelay: 0 });
    await client.connect();
    doc.setSaving(false);
    doc.collab = { client, link: { server: 'https://documents-abc.puter.work', room: 'r1' } };
  }
  doc.attach(async () => bytes(engine.model.text));
  const collab = createCollaboration({ editor: () => engine, pkg: () => ({ assets: {} }), doc, local: false, error: e => { throw e; }, user: () => user, documentName: () => 'Plan' });
  await collab.attach();
  await settle();
  return { engine, doc, collab };
}

describe('Save As in a shared document', () => {
  beforeEach(() => {
    versioning.enabled = false;
    publishing.enabled = false;
    P.__files.clear();
    P.__files.set(PATH, { blob: bytes('Shared'), modified: 1 });
    hub = new MemoryHub(Y.encodeStateAsUpdate(createSharedDoc(editorState({ session: { body: new TextDocument([paragraph('Shared')]), storyEdits: {} } }))));
  });

  it('goes on in a copy that is not shared: what is typed in it stays out of the room', async () => {
    const { engine, doc, collab } = await openShared({ role: 'owner', user: { id: 'u0', name: 'Ada' }, path: PATH });
    expect(collab.live).not.toBeNull();
    // Before the copy, the owner's changes reach the room.
    const before = roomState();
    type(engine, doc, 6, ' plan');
    await settle();
    expect(roomState()).not.toBe(before);
    expect(await doc.saveAs('Private')).toBeNull();
    await settle();
    expect(doc.path).toBe('Documents/Private.docx');
    expect(collab.live).toBeNull();
    expect(collab.banner.textContent).toContain('not shared');
    const after = roomState();
    type(engine, doc, 11, ' (mine)');
    await settle();
    expect(roomState()).toBe(after);
    // The copy saves its own edits; the original keeps what it had.
    expect(await doc.save()).toBe(true);
    expect(file('Documents/Private.docx')).toBe('Shared plan (mine)');
    expect(file(PATH)).toBe('Shared');
    collab.destroy();
  });

  it('gives a guest a copy of their own to save', async () => {
    const { engine, doc, collab } = await openShared({ role: 'editor', user: { id: 'u1', name: 'Bob' }, path: null });
    expect(doc.writes).toBe(false);
    expect(await doc.saveAs('Bob notes')).toBeNull();
    await settle();
    expect(collab.live).toBeNull();
    type(engine, doc, 6, ' and mine');
    await settle();
    expect(doc.dirty).toBe(true);
    expect(await doc.save()).toBe(true);
    expect(file('Documents/Bob notes.docx')).toBe('Shared and mine');
    collab.destroy();
  });

  it("keeps the room when the document only changes its file name (a rename)", async () => {
    const { doc, collab } = await openShared({ role: 'owner', user: { id: 'u0', name: 'Ada' }, path: PATH });
    doc._emitPath();
    expect(collab.live).not.toBeNull();
    collab.destroy();
  });
});
