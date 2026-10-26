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
const joined = [];
let release;
// The file was shared before: its room is remembered.
vi.mock('../src/collab/room-memory.js', async (importOriginal) => ({ ...await importOriginal(), rememberedRoom: async () => ({ server: 'https://documents-abc.puter.work', room: 'room1' }) }));
vi.mock('../src/collab/live.js', async (importOriginal) => ({
  ...await importOriginal(),
  // Joining the owner's room takes a few round trips; the test decides when they end.
  reconnect: async () => {
    await new Promise(resolve => { release = resolve; });
    const client = new CollabClient({ transport: hub.connect('owner'), user: { id: 'u0', name: 'Ada' }, room: 'room1', sendDelay: 0 });
    await client.connect();
    joined.push(client);
    return { client, link: { server: 'https://documents-abc.puter.work', room: 'room1' } };
  },
}));
const { createCollaboration } = await import('../src/views/collab.js');

it('leaves the room it was rejoining when the editor closes meanwhile', async () => {
  const engine = { session: new StorySession(new TextDocument([paragraph('Shared')])), images: new Map(), overlays: [], setRangeTints() {}, relayout() {}, paint() {}, syncInput() {}, focus() {}, onChange() {} };
  const doc = { path: 'Documents/Plan.docx', setSaving() {}, changed() {}, addEventListener() {}, removeEventListener() {} };
  const collab = createCollaboration({ editor: () => engine, pkg: () => ({ assets: {} }), doc, local: false, error: e => { throw e; }, user: () => ({ id: 'u0', name: 'Ada' }), documentName: () => 'Plan' });
  const attaching = collab.attach();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 15000 });
  collab.destroy();
  release();
  await attaching;
  expect(collab.live).toBeNull();
  await vi.waitFor(() => expect(joined[0]?.closed).toBe(true), { timeout: 15000 });
  expect(hub.peers.size).toBe(0);
});
