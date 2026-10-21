import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { protectionGuard } from '../src/engine/protection.js';
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
  travelHistory(direction) { this.session[direction](); }
  execute(action) { if (this.readOnly || this.viewOnly) return false; try { this.session.run(() => action(this.model)); return true; } catch { return false; } }
}
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function settle() { for (let i = 0; i < 10; i++) await tick(); }

async function room(text, roles = ['owner', 'editor']) {
  const seed = new TextDocument([paragraph(text)]);
  const hub = new MemoryHub(Y.encodeStateAsUpdate(createSharedDoc(editorState({ session: { body: seed, storyEdits: {} } }))));
  const people = [];
  for (const [i, role] of roles.entries()) {
    const transport = hub.connect(role);
    const name = `Person ${i}`;
    const client = new CollabClient({ transport, user: { id: `u${i}`, name }, room: 'r1', sendDelay: 0 });
    await client.connect();
    const engine = new FakeEngine(), errors = [];
    const live = new LiveSession({ engine, doc: { setSaving() {}, changed() {} }, client, link: { local: true, room: 'r1' }, user: { id: `u${i}`, name },
      commentGuard: protectionGuard({ edit: 'comments', enforcement: true }, { name }), onError: e => errors.push(e.message) });
    people.push({ transport, client, engine, live, errors });
  }
  return { hub, people };
}

describe('changes the room refuses', () => {
  it('starts again from the room after a refusal, so later allowed changes still arrive', async () => {
    const { people: [ann, bob] } = await room('Hello world');
    // Bob types, and the owner makes him a commenter before his change reaches the room.
    bob.engine.execute(m => { m.select(11); m.replace('!!!'); });
    bob.transport.setRole('commenter');
    await settle();
    expect(bob.errors.join()).toMatch(/could not be shared/);
    // Bob's copy matches the room again instead of keeping the refused text.
    expect(bob.engine.model.text).toBe('Hello world');
    expect(bob.client.outbox.size).toBe(0);
    expect(bob.engine.execute(m => { m.select(0, 5); m.addComment({ author: 'Bob', text: 'A comment' }); })).toBe(true);
    await settle();
    expect(ann.engine.session.body.comments?.map(c => c.text)).toEqual(['A comment']);
    expect(bob.client.status).toBe('online');
    expect(ann.engine.model.text).toBe('Hello world');
  });

  it('sends a long queue in batches under the room\'s request limit', async () => {
    const { people: [ann, bob] } = await room('Start');
    bob.transport.maxUpdate = 600;
    bob.transport.setOnline(false);
    for (let i = 0; i < 6; i++) { bob.engine.execute(m => { m.select(m.text.length); m.replace(` ${String(i).repeat(120)}`); }); await settle(); }
    expect(bob.client.outbox.size).toBe(6);
    const sent = [];
    const send = bob.transport.send;
    bob.transport.send = update => { sent.push(Math.ceil(update.length / 3) * 4); return send(update); };
    bob.transport.setOnline(true);
    for (let i = 0; i < 20 && bob.client.outbox.size; i++) await settle();
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every(size => size <= 600)).toBe(true);
    expect(ann.engine.model.text).toBe(bob.engine.model.text);
    expect(ann.engine.model.text).toContain('5'.repeat(120));
  });

  it('keeps a change the room could not verify the sender of and sends it again', async () => {
    const { people: [ann, bob] } = await room('Start');
    // The worker answers 401 when it cannot check the request's credential (an expired one, Puter unreachable).
    const send = bob.transport.send;
    let refusals = 1;
    bob.transport.send = update => (refusals-- > 0 ? Promise.reject(Object.assign(new Error('Could not verify this collaboration request.'), { status: 401 })) : send(update));
    bob.engine.execute(m => { m.select(5); m.replace(' kept'); });
    await settle();
    expect(bob.errors).toEqual([]);
    expect(bob.engine.model.text).toBe('Start kept');
    await vi.waitFor(() => expect(ann.engine.model.text).toBe('Start kept'), { timeout: 5000 });
    expect(bob.client.outbox.size).toBe(0);
  });

  it('refuses one change larger than the limit without blocking the next', async () => {
    const { people: [ann, bob] } = await room('Start');
    bob.transport.maxUpdate = 600;
    bob.engine.execute(m => { m.select(m.text.length); m.replace(` ${'x'.repeat(2000)}`); });
    await settle();
    expect(bob.errors.join()).toMatch(/too large to share/);
    expect(bob.engine.model.text).toBe('Start');
    bob.engine.execute(m => { m.select(m.text.length); m.replace(' and more'); });
    await settle();
    expect(ann.engine.model.text).toBe('Start and more');
  });
});
