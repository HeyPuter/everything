import { it, expect } from 'vitest';
import * as Y from 'yjs';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
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
 * Undoing a table someone else has since restructured cannot take the table back whole: its structure is theirs now.
 * The Undo used to remove this person's cells under the other person's structure, which nobody's editor could show,
 * and everyone was left with the "could not be combined" notice. It is refused instead, and nothing changes.
 */
it('refuses to undo a table someone else has restructured since, and leaves the document whole for everyone', async () => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const hub = new MemoryHub(Y.encodeStateAsUpdate(createSharedDoc(editorState({ session: { body: new TextDocument([paragraph('Intro'), paragraph('End')]), storyEdits: {} } }))));
    const people = [];
    for (const name of ['Ann', 'Bob']) {
      const client = new CollabClient({ transport: hub.connect('editor'), user: { id: name, name }, room: 'r1', sendDelay: 0 });
      await client.connect();
      const engine = new FakeEngine();
      const binding = new CollabBinding({ engine, ydoc: client.ydoc, session: { id: client.session, name } });
      client.attach(binding);
      binding.apply();
      const person = { engine, binding, conflicts: 0, refused: 0 };
      binding.addEventListener('conflict', e => { person.conflicts += e.detail.error ? 1 : -1; });
      binding.addEventListener('refused-undo', () => { person.refused++; });
      people.push(person);
    }
    const [ann, bob] = people;
    ann.engine.execute(m => { m.select(5); m.insertTable(2, 2); });
    await settle();
    bob.engine.execute(m => { m.selectCell(m.tables[0].rows[0].cells[0].id); m.insertTableColumn(); });
    await settle();
    expect(ann.engine.model.tables[0].grid).toHaveLength(3);
    ann.engine.undo();
    await settle();
    for (const person of people) {
      expect(person.binding.conflict).toBeNull();
      // Any notice that showed for a moment was taken back.
      expect(person.conflicts).toBe(0);
      expect(person.engine.model.tables).toHaveLength(1);
      expect(person.engine.model.tables[0].grid).toHaveLength(3);
    }
    expect(bob.engine.model.text).toBe(ann.engine.model.text);
    expect(ann.refused).toBe(1);
  }
});
