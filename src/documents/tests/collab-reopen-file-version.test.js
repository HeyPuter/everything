// @vitest-environment jsdom
import { it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { createSharedDoc } from '../src/collab/shared-doc.js';
import { editorState } from '../src/collab/binding.js';
import { CollabClient } from '../src/collab/client.js';
import { MemoryHub } from '../src/collab/transports.js';

let hub;
vi.mock('../src/collab/live.js', async (importOriginal) => ({
  ...await importOriginal(),
  // The owner reopening a document they shared: the room is the test's hub.
  reconnect: async () => {
    const client = new CollabClient({ transport: hub.connect('owner'), user: { id: 'u0', name: 'Ada' }, room: 'r1', sendDelay: 0 });
    await client.connect();
    return { client, link: { server: 'https://documents-abc.puter.work', room: 'r1' } };
  },
}));
const { createCollaboration } = await import('../src/views/collab.js');

const room = text => new MemoryHub(Y.encodeStateAsUpdate(createSharedDoc(editorState({ session: { body: new TextDocument([paragraph(text)]), storyEdits: {} } }))));
const engineWith = text => ({ session: new StorySession(new TextDocument([paragraph(text)])), images: new Map(), overlays: [], get model() { return this.session.model; }, setRangeTints() {}, relayout() {}, paint() {}, syncInput() {}, focus() {}, onChange() {} });

let kept;
beforeEach(() => { kept = []; });

async function reopen(fileText) {
  const engine = engineWith(fileText);
  const doc = { path: 'Documents/Plan.docx', setSaving() {}, changed() {}, addEventListener() {}, removeEventListener() {},
    keepFileVersion: vi.fn(async meta => { kept.push({ meta, text: engine.session.body.text }); return { time: 1 }; }) };
  const collab = createCollaboration({ editor: () => engine, pkg: () => ({ assets: {} }), doc, local: false, error: e => { throw e; }, user: () => ({ id: 'u0', name: 'Ada' }), documentName: () => 'Plan' });
  await collab.attach();
  await vi.waitFor(() => expect(collab.live).not.toBeNull());
  return { engine, doc, collab };
}

it('keeps the file as a version when the shared document it reopens into differs from it', async () => {
  // Changed outside the room (another app, a session that could not reach the room): the room does not have it.
  hub = room('Shared');
  const { engine, doc, collab } = await reopen('Shared, then edited elsewhere');
  expect(engine.session.body.text).toBe('Shared');
  expect(doc.keepFileVersion).toHaveBeenCalledTimes(1);
  expect(kept[0].meta).toEqual({ label: 'Before the shared changes' });
  collab.destroy();
});

it('keeps no version when the file and the shared document agree', async () => {
  hub = room('Shared');
  const { doc, collab } = await reopen('Shared');
  expect(doc.keepFileVersion).not.toHaveBeenCalled();
  collab.destroy();
});
