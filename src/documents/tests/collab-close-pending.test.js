import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { createSharedDoc } from '../src/collab/shared-doc.js';
import { editorState } from '../src/collab/binding.js';
import { CollabClient } from '../src/collab/client.js';
import { MemoryHub } from '../src/collab/transports.js';
import { LiveSession } from '../src/collab/live.js';

class FakeEngine {
  constructor() { this.session = new StorySession(new TextDocument([paragraph('')])); this.images = new Map(); this.composition = null; this.readOnly = false; this.viewOnly = false; this.overlays = []; }
  get model() { return this.session.model; }
  relayout() {} paint() {} syncInput() {} focus() {} onChange() {} setRangeTints() {}
  setViewOnly(on) { this.viewOnly = !!on; }
  execute(action) { this.session.run(() => action(this.model)); }
}
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function settle() { for (let i = 0; i < 20; i++) await tick(); }

async function person(hub, role, i, transport = hub.connect(role)) {
  const client = new CollabClient({ transport, user: { id: `u${i}`, name: `Person ${i}` }, room: 'r1', sendDelay: 0 });
  await client.connect();
  const engine = new FakeEngine();
  const live = new LiveSession({ engine, doc: { setSaving() {}, changed() {} }, client, link: { local: true, room: 'r1' }, user: { id: `u${i}`, name: `Person ${i}` } });
  return { client, engine, live };
}

describe('closing a shared document', () => {
  it('sends the changes queued behind a batch still on its way before leaving the room', async () => {
    const hub = new MemoryHub(Y.encodeStateAsUpdate(createSharedDoc(editorState({ session: { body: new TextDocument([paragraph('Notes')]), storyEdits: {} } }))));
    const ann = await person(hub, 'owner', 0);
    // Bob's connection takes a moment to answer each change.
    const slow = hub.connect('editor'), send = slow.send;
    slow.send = async update => { await tick(40); return send(update); };
    const bob = await person(hub, 'editor', 1, slow);
    await settle();
    bob.engine.execute(m => { m.select(5); m.replace(' one'); });
    await tick(10);
    // The first change is on its way; the second waits behind it when Bob closes the document.
    bob.engine.execute(m => { m.select(9); m.replace(' two'); });
    bob.live.destroy();
    await settle();
    expect(ann.engine.model.text).toBe('Notes one two');
    expect(bob.client.closed).toBe(true);
    ann.live.destroy();
  });

  it('sends every batch of a long queue before leaving a room that limits its requests', async () => {
    const hub = new MemoryHub(Y.encodeStateAsUpdate(createSharedDoc(editorState({ session: { body: new TextDocument([paragraph('Start')]), storyEdits: {} } }))));
    const ann = await person(hub, 'owner', 0);
    const offline = hub.connect('editor');
    const bob = await person(hub, 'editor', 1, offline);
    await settle();
    // Written offline, the changes queue up; the connection is back as Bob closes the document.
    offline.setOnline(false);
    for (let i = 0; i < 12; i++) { bob.engine.execute(m => { m.select(m.text.length); m.replace(` word${i}`); }); await tick(1); }
    await settle();
    expect(bob.client.outbox.size).toBeGreaterThan(2);
    bob.client.transport.maxUpdate = 120;
    offline.setOnline(true);
    bob.live.destroy();
    await settle();
    expect(ann.engine.model.text).toBe(`Start${Array.from({ length: 12 }, (_, i) => ` word${i}`).join('')}`);
    ann.live.destroy();
  });
});
