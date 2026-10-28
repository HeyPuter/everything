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
let release = null, remembered = null, failures = 0;
vi.mock('../src/collab/room-memory.js', async (importOriginal) => ({ ...await importOriginal(), rememberedRoom: async () => remembered }));
vi.mock('../src/collab/live.js', async (importOriginal) => ({
  ...await importOriginal(),
  // Joining the owner's room takes a few round trips; the test decides when they end.
  reconnect: async () => {
    await new Promise(resolve => { release = resolve; });
    // The service could not be reached (a network failure, a server error): the room is still there.
    if (failures > 0) { failures--; throw Object.assign(new Error('Failed to fetch'), { status: 0 }); }
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

it('stays read-only with a way to try again when the room of a reopened shared document cannot be reached', async () => {
  remembered = { server: 'https://documents-abc.puter.work', room: 'room1' };
  release = null; failures = 1;
  const engine = new FakeEngine('Shared');
  const collab = open(engine);
  collab.attach();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const first = release;
  release = null;
  first();
  // Edits made now would neither reach the others nor survive: the room's state replaces the editor's once joined.
  await vi.waitFor(() => expect(collab.banner.textContent).toContain('Could not connect to the shared document'));
  expect(engine.viewOnly).toBe(true);
  expect(collab.live).toBeNull();
  const retry = [...collab.banner.querySelectorAll('button')].find(b => b.textContent === 'Try Again');
  retry.click();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  release();
  await vi.waitFor(() => expect(collab.live).not.toBeNull());
  expect(engine.viewOnly).toBe(false);
  collab.destroy();
});
