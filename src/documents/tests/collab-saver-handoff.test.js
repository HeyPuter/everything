import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';

vi.mock('../src/lib/puter.js', async (importOriginal) => {
  const real = await importOriginal();
  const files = new Map();
  let clock = 1;
  return {
    ...real,
    __files: files,
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
import { LiveSession } from '../src/collab/live.js';
import { Doc, versioning, publishing } from '../src/lib/doc.js';
import * as P from '../src/lib/puter.js';

class FakeEngine {
  constructor() { this.session = new StorySession(new TextDocument([paragraph('')])); this.images = new Map(); this.composition = null; this.readOnly = false; this.viewOnly = false; this.overlays = []; }
  get model() { return this.session.model; }
  relayout() {} paint() {} syncInput() {} focus() {} onChange() {} setRangeTints() {}
  setViewOnly(on) { this.viewOnly = !!on; }
  execute(action) { this.session.run(() => action(this.model)); }
}
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function settle() { for (let i = 0; i < 10; i++) await tick(); }

const PATH = 'Documents/Plan.docx';

async function ownerTab(hub, session) {
  const client = new CollabClient({ transport: hub.connect('owner'), user: { id: 'u0', name: 'Ada' }, room: 'r1', sendDelay: 0 });
  client.session = session;
  await client.connect();
  const engine = new FakeEngine();
  // Both tabs opened the file as it was then.
  const doc = new Doc({ name: 'Plan', path: PATH, modified: 1 });
  doc.attach(async () => new Blob([engine.model.text]));
  const live = new LiveSession({ engine, doc, client, link: { server: 'https://documents-abc.puter.work', room: 'r1' }, user: { id: 'u0', name: 'Ada' } });
  return { client, engine, doc, live };
}

describe('the owner tab that saves a shared document', () => {
  beforeEach(() => {
    versioning.enabled = false;
    publishing.enabled = false;
    P.__files.clear();
    P.__files.set(PATH, { blob: new Blob(['Shared']), modified: 1 });
  });

  it('takes over saving from another owner tab that leaves without reporting a conflict', async () => {
    const hub = new MemoryHub(Y.encodeStateAsUpdate(createSharedDoc(editorState({ session: { body: new TextDocument([paragraph('Shared')]), storyEdits: {} } }))));
    const first = await ownerTab(hub, 'a'), second = await ownerTab(hub, 'b');
    await settle();
    expect(first.doc.writes).toBe(true);
    expect(second.doc.writes).toBe(false);
    // The first tab writes the room's changes to the file.
    first.engine.execute(m => { m.select(6); m.replace(' plan'); });
    await settle();
    expect(await first.doc.save()).toBe(true);
    expect(await P.__files.get(PATH).blob.text()).toBe('Shared plan');
    // It closes; the second tab now saves, and its next write is not refused as another window's change.
    first.live.destroy();
    await settle();
    expect(second.doc.writes).toBe(true);
    second.engine.execute(m => { m.select(11); m.replace('!'); });
    await settle();
    expect(await second.doc.save()).toBe(true);
    expect(second.doc.status).toBe('saved');
    expect(await P.__files.get(PATH).blob.text()).toBe('Shared plan!');
    second.live.destroy();
  });
});
