import { it, expect } from 'vitest';
import * as Y from 'yjs';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { protectionGuard } from '../src/engine/protection.js';
import { createSharedDoc } from '../src/collab/shared-doc.js';
import { CollabBinding, editorState } from '../src/collab/binding.js';
import { CollabClient } from '../src/collab/client.js';
import { MemoryHub } from '../src/collab/transports.js';

class FakeEngine {
  constructor() { this.session = new StorySession(new TextDocument([paragraph('')])); this.images = new Map(); this.composition = null; this.readOnly = false; this.viewOnly = false; }
  get model() { return this.session.model; }
  relayout() {} paint() {} syncInput() {} focus() {} onChange() {}
  setViewOnly(on) { this.viewOnly = !!on; }
  travelHistory(direction) { this.session[direction](); }
  undo() { this.travelHistory('undo'); }
  redo() { this.travelHistory('redo'); }
  execute(action) { this.session.run(() => action(this.model)); }
}
const tick = () => new Promise(r => setTimeout(r, 2));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

/**
 * Someone whose access becomes comment-only (or view-only) can no longer take back their earlier edits: Undo would
 * change the text, which the room refuses, throwing away whatever else they had queued. Their history goes.
 */
it('clears the history of edits someone can no longer make once their role is lowered', async () => {
  const hub = new MemoryHub(Y.encodeStateAsUpdate(createSharedDoc(editorState({ session: { body: new TextDocument([paragraph('Plan')]), storyEdits: {} } }))));
  const transport = hub.connect('editor');
  const client = new CollabClient({ transport, user: { id: 'u1', name: 'Bob' }, room: 'r1', sendDelay: 0 });
  await client.connect();
  const engine = new FakeEngine();
  const binding = new CollabBinding({ engine, ydoc: client.ydoc, session: { id: client.session, name: 'Bob' } });
  client.attach(binding);
  binding.apply();
  const guard = protectionGuard({ edit: 'comments', enforcement: true }, { name: 'Bob' });
  binding.setRole('editor', { commentGuard: guard });
  client.addEventListener('role', e => binding.setRole(e.detail.role, { commentGuard: guard }));
  const refused = [];
  client.addEventListener('refused', e => refused.push(e.detail.message));
  engine.execute(m => { m.select(4); m.replace(' A'); });
  await settle();
  expect(engine.session.history.length).toBe(1);
  transport.setRole('commenter');
  expect(engine.session.history.length).toBe(0);
  engine.undo();
  await settle();
  expect(engine.model.text).toBe('Plan A');
  expect(refused).toEqual([]);
});
