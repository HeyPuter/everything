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

async function room(seed) {
  const hub = new MemoryHub(Y.encodeStateAsUpdate(createSharedDoc(editorState({ session: { body: seed, storyEdits: {} } }))));
  const people = [];
  for (const [i, name] of ['Ann', 'Bob'].entries()) {
    const client = new CollabClient({ transport: hub.connect('editor'), user: { id: `u${i}`, name }, room: 'r1', sendDelay: 0 });
    await client.connect();
    const engine = new FakeEngine();
    const binding = new CollabBinding({ engine, ydoc: client.ydoc, session: { id: client.session, name } });
    client.attach(binding);
    binding.apply();
    people.push({ client, engine, binding, conflicts: 0 });
    binding.addEventListener('conflict', () => { people[i].conflicts++; });
  }
  return { hub, people };
}
const inCell = (m, cellId) => m.select(m.paragraphOffset(m.paragraphs.findIndex(p => p.cellId === cellId)));
const rows = m => m.tables.map(t => t.rows.length);

/**
 * A table's register is rewritten only when the table changes. Its recorded place among the tables used to count as
 * a change: whoever added or removed a table above another rewrote that one too, with their copy of it, which undid
 * a row someone else added to it meanwhile.
 */
it('keeps a row added to one table while someone else deletes another table', async () => {
  // Concurrent writes to one register keep one of them, chosen by the writers' random client ids: a few rooms try both.
  for (let attempt = 0; attempt < 8; attempt++) {
    const seed = new TextDocument([paragraph('Intro'), paragraph('Middle'), paragraph('End')]);
    seed.select(5); seed.insertTable(2, 2);
    seed.select(seed.paragraphOffset(seed.paragraphs.findIndex(p => p.runs.some(r => r.text === 'Middle'))) + 6); seed.insertTable(2, 2);
    const { hub, people: [ann, bob] } = await room(seed);
    const [first, second] = ann.engine.model.tables.map(t => t.rows[0].cells[0].id);
    hub.pause();
    ann.engine.execute(m => { inCell(m, first); m.deleteTablePart('table'); });
    bob.engine.execute(m => { inCell(m, second); m.insertTableRow(); });
    await settle();
    hub.resume();
    await settle();
    for (const person of [ann, bob]) {
      expect(rows(person.engine.model)).toEqual([3]);
      expect(person.conflicts).toBe(0);
    }
  }
});

it('undoes a table someone else has since added a table above, for everyone', async () => {
  const seed = new TextDocument([paragraph('Intro'), paragraph('End')]);
  const { hub, people: [ann, bob] } = await room(seed);
  // Ann adds a table at the end; Bob, before it reaches him, one after "Intro".
  hub.pause();
  ann.engine.execute(m => { m.select(m.text.length); m.insertTable(2, 2); });
  bob.engine.execute(m => { m.select(5); m.insertTable(2, 2); });
  await settle();
  hub.resume();
  await settle();
  // Bob types elsewhere, then Ann takes her table back.
  bob.engine.execute(m => { m.select(2); m.replace('x'); });
  await settle();
  expect(rows(ann.engine.model)).toEqual([2, 2]);
  ann.engine.undo();
  await settle();
  for (const person of [ann, bob]) {
    expect(person.conflicts).toBe(0);
    expect(rows(person.engine.model)).toEqual([2]);
  }
  expect(bob.engine.model.text).toBe(ann.engine.model.text);
});
