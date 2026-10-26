// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { createSharedDoc } from '../src/collab/shared-doc.js';
import { editorState } from '../src/collab/binding.js';
import { CollabClient } from '../src/collab/client.js';
import { MemoryHub } from '../src/collab/transports.js';

const hub = new MemoryHub(Y.encodeStateAsUpdate(createSharedDoc(editorState({ session: { body: new TextDocument([paragraph('Shared')]), storyEdits: {} } }))));
let release = null, remembered = null;
vi.mock('../src/collab/room-memory.js', async (importOriginal) => ({ ...await importOriginal(), rememberedRoom: async () => remembered }));
vi.mock('../src/collab/live.js', async (importOriginal) => ({
  ...await importOriginal(),
  // Joining the owner's room takes a few round trips; the test decides when they end.
  reconnect: async () => {
    await new Promise(resolve => { release = resolve; });
    const client = new CollabClient({ transport: hub.connect('owner'), user: { id: 'u0', name: 'Ada' }, room: 'room1', sendDelay: 0 });
    await client.connect();
    return { client, link: { server: 'https://documents-abc.puter.work', room: 'room1' } };
  },
}));
const { createCollaboration } = await import('../src/views/collab.js');

class FakeEngine {
  constructor(text) { this.session = new StorySession(new TextDocument([paragraph(text)])); this.images = new Map(); this.overlays = []; this.viewOnly = false; }
  get model() { return this.session.model; }
  setViewOnly(on) { this.viewOnly = !!on; }
  setRangeTints() {} relayout() {} paint() {} syncInput() {} focus() {} onChange() {} finishComposition() {}
}
const open = engine => createCollaboration({ editor: () => engine, pkg: () => ({ assets: {} }), doc: { path: 'Documents/Plan.docx', setSaving() {}, changed() {}, addEventListener() {}, removeEventListener() {}, keepFileVersion: async () => null },
  local: false, error: e => { throw e; }, user: () => ({ id: 'u0', name: 'Ada' }), documentName: () => 'Plan' });

it('reads only while the room a reopened document was shared in is joined, since its state replaces the editor’s', async () => {
  remembered = { server: 'https://documents-abc.puter.work', room: 'room1' };
  release = null;
  const engine = new FakeEngine('Shared');
  const collab = open(engine);
  const attaching = collab.attach();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(engine.viewOnly).toBe(true);
  expect(collab.banner.hidden).toBe(false);
  expect(collab.banner.textContent).toContain('Connecting to the shared document');
  // Choosing Viewing meanwhile is kept; choosing Editing waits for the room.
  engine.setViewOnly(false);
  expect(engine.viewOnly).toBe(true);
  release();
  await attaching;
  expect(collab.live).not.toBeNull();
  expect(engine.viewOnly).toBe(false);
  expect(collab.banner.hidden).toBe(true);
  collab.destroy();
});

it('opens a document that was never shared for editing without waiting', async () => {
  remembered = null;
  release = null;
  const engine = new FakeEngine('Mine'), modes = [];
  const setViewOnly = engine.setViewOnly;
  engine.setViewOnly = function (on) { modes.push(!!on); setViewOnly.call(this, on); };
  const own = engine.setViewOnly;
  const collab = open(engine);
  await collab.attach();
  // Never read-only, not even while the lookup for a room was on its way.
  expect(modes).toEqual([]);
  expect(release).toBeNull();
  expect(engine.viewOnly).toBe(false);
  expect(engine.setViewOnly).toBe(own);
  expect(collab.banner.hidden).toBe(true);
  collab.destroy();
});

it('keeps Viewing chosen while the room was joined', async () => {
  remembered = { server: 'https://documents-abc.puter.work', room: 'room1' };
  release = null;
  const engine = new FakeEngine('Shared');
  const collab = open(engine);
  const attaching = collab.attach();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  engine.setViewOnly(true);
  release();
  await attaching;
  expect(engine.viewOnly).toBe(true);
  collab.destroy();
});
