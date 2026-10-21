// @vitest-environment jsdom
import { it, expect } from 'vitest';
import * as Y from 'yjs';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { createSharedDoc } from '../src/collab/shared-doc.js';
import { editorState } from '../src/collab/binding.js';
import { CollabClient } from '../src/collab/client.js';
import { MemoryHub } from '../src/collab/transports.js';
import { createCollaboration } from '../src/views/collab.js';

const hub = new MemoryHub(Y.encodeStateAsUpdate(createSharedDoc(editorState({ session: { body: new TextDocument([paragraph('Shared')]), storyEdits: {} } }))));

async function invitation() {
  const client = new CollabClient({ transport: hub.connect('editor'), user: { id: 'u1', name: 'Bob' }, room: 'room1', sendDelay: 0 });
  await client.connect();
  const doc = { path: null, collab: { client, link: { server: 'https://documents-abc.puter.work', room: 'room1' } }, setSaving() {}, changed() {}, addEventListener() {}, removeEventListener() {} };
  return { client, doc };
}
const collaboration = (doc, editor) => createCollaboration({ editor, pkg: () => ({ assets: {} }), doc, local: false, error: () => {}, user: () => ({ id: 'u1', name: 'Bob' }), documentName: () => 'Plan' });

it('leaves the room it joined from an invitation when the editor closes before the document opened', async () => {
  const { client, doc } = await invitation();
  const collab = collaboration(doc, () => null);
  collab.destroy();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(client.closed).toBe(true);
  expect(hub.peers.size).toBe(0);
});

it('leaves the room it joined from an invitation when the document could not be opened', async () => {
  const { client, doc } = await invitation();
  // The editor failed: there is no engine to share the document with.
  const collab = collaboration(doc, () => null);
  await collab.attach();
  collab.destroy();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(client.closed).toBe(true);
  expect(hub.peers.size).toBe(0);
});
