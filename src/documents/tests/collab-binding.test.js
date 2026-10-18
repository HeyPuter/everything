import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { protectionGuard } from '../src/engine/protection.js';
import { createSharedDoc } from '../src/collab/shared-doc.js';
import { CollabBinding, editorState } from '../src/collab/binding.js';
import { CollabClient } from '../src/collab/client.js';
import { MemoryHub, checkCommentOnly } from '../src/collab/transports.js';
import { colorFor, PERSON_COLORS, shareLink, parseLink, initials } from '../src/collab/protocol.js';

/** Just enough of CanvasEditor for the binding: a story session and no-op painting. */
class FakeEngine {
  constructor(paragraphs) { this.session = new StorySession(new TextDocument(paragraphs)); this.images = new Map(); this.composition = null; this.readOnly = false; this.viewOnly = false; this.changes = 0; }
  get model() { return this.session.model; }
  relayout() {} paint() {} syncInput() {} focus() {}
  onChange() { this.changes++; }
  setViewOnly(on) { this.viewOnly = !!on; }
  travelHistory(direction) { this.session[direction](); }
  undo() { this.travelHistory('undo'); }
  redo() { this.travelHistory('redo'); }
  execute(action) { if (this.readOnly || this.viewOnly) return false; try { this.session.run(() => action(this.model)); return true; } catch { return false; } }
}

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

async function room(text = 'Hello world', roles = ['owner', 'editor']) {
  const seed = new TextDocument([paragraph(text)]);
  const hub = new MemoryHub(Y.encodeStateAsUpdate(createSharedDoc(editorState({ session: { body: seed, storyEdits: {} } }))));
  const people = [];
  for (const [i, role] of roles.entries()) {
    const client = new CollabClient({ transport: hub.connect(role), user: { id: `u${i}`, name: `Person ${i}` }, room: 'r1', sendDelay: 0 });
    const joined = await client.connect();
    const engine = new FakeEngine([paragraph('')]);
    const binding = new CollabBinding({ engine, ydoc: client.ydoc, session: { id: client.session, name: client.user.name } });
    client.attach(binding);
    binding.apply();
    binding.setRole(joined.role, { commentGuard: protectionGuard({ edit: 'comments', enforcement: true }, { name: client.user.name }) });
    people.push({ client, engine, binding });
  }
  return { hub, people };
}

describe('co-editing binding', () => {
  it('starts from the room state and sends local edits to others', async () => {
    const { people: [ann, bob] } = await room();
    expect(bob.engine.model.text).toBe('Hello world');
    ann.engine.execute(m => { m.select(5); m.replace(','); });
    await settle();
    expect(bob.engine.model.text).toBe('Hello, world');
  });

  it('converges when two people type at once, keeping each caret in place', async () => {
    const { hub, people: [ann, bob] } = await room('The cat sat.');
    hub.pause();
    ann.engine.execute(m => { m.select(4); m.replace('black '); });
    bob.engine.execute(m => { m.select(11); m.replace(' down'); });
    await settle();
    hub.resume();
    await settle();
    expect(ann.engine.model.text).toBe('The black cat sat down.');
    expect(bob.engine.model.text).toBe('The black cat sat down.');
    // Bob's caret followed his own insertion although Ann's text arrived before it.
    expect(bob.engine.model.selection.focus).toBe('The black cat sat down'.length);
    expect(ann.engine.model.selection.focus).toBe('The black '.length);
  });

  it('undoes only this person’s own change', async () => {
    const { people: [ann, bob] } = await room('one two');
    ann.engine.execute(m => { m.select(3); m.replace(' and'); });
    await settle();
    bob.engine.execute(m => { m.select(m.text.length); m.replace(' three'); });
    await settle();
    expect(ann.engine.model.text).toBe('one and two three');
    ann.engine.undo();
    await settle();
    expect(ann.engine.model.text).toBe('one two three');
    expect(bob.engine.model.text).toBe('one two three');
    expect(ann.engine.session.future.length).toBe(1);
    ann.engine.redo();
    await settle();
    expect(bob.engine.model.text).toBe('one and two three');
    // Bob's history holds only his own step.
    expect(bob.engine.session.history.length).toBe(1);
  });

  it('carries remote carets through edits made before them', async () => {
    const { people: [ann, bob] } = await room('abc def');
    let roster = [];
    ann.client.addEventListener('presence', e => { roster = e.detail.roster; });
    bob.engine.model.select(4, 7);
    bob.client.setPresence(bob.binding.localPresence());
    await settle();
    ann.engine.execute(m => { m.select(0); m.replace('xyz '); });
    await settle();
    const remote = roster.find(p => p.session === bob.client.session);
    expect(remote.name).toBe('Person 1');
    expect(ann.binding.resolve(remote)).toEqual({ anchor: 8, focus: 11 });
    expect(ann.engine.model.text.slice(8, 11)).toBe('def');
  });

  it('keeps viewers from changing the document', async () => {
    const { people: [, viewer] } = await room('Read me', ['owner', 'viewer']);
    expect(viewer.engine.viewOnly).toBe(true);
    // The editing-mode switch cannot turn editing back on.
    viewer.engine.setViewOnly(false);
    expect(viewer.engine.viewOnly).toBe(true);
    expect(viewer.engine.execute(m => m.replace('x'))).toBe(false);
  });

  it('lets commenters add comments but not change the text', async () => {
    const { people: [owner, commenter] } = await room('Discuss this', ['owner', 'commenter']);
    expect(commenter.engine.execute(m => { m.select(0); m.replace('Edited '); })).toBe(false);
    expect(commenter.engine.model.text).toBe('Discuss this');
    commenter.engine.session.body.comments ||= [];
    const added = commenter.engine.execute(m => { m.select(0, 7); m.addComment({ author: 'Person 1', text: 'Why?' }); });
    expect(added).toBe(true);
    await settle();
    expect(owner.engine.session.body.comments?.map(c => c.text)).toEqual(['Why?']);
  });

  it('keeps both comments when two people comment at once', async () => {
    const { hub, people: [ann, bob] } = await room('Alpha beta gamma delta');
    hub.pause();
    ann.engine.execute(m => { m.select(0, 5); m.addComment({ author: 'Ann', text: 'Check Alpha' }); });
    bob.engine.execute(m => { m.select(17, 22); m.addComment({ author: 'Bob', text: 'Check delta' }); });
    await settle();
    hub.resume();
    await settle();
    for (const person of [ann, bob]) {
      const comments = person.engine.session.body.comments;
      expect(comments.map(c => c.text).sort()).toEqual(['Check Alpha', 'Check delta']);
      // Ids stay whole numbers that fit Word's 32-bit comment ids.
      expect(comments.every(c => /^\d+$/.test(c.id) && Number(c.id) < 2 ** 31)).toBe(true);
    }
    // Once the session ends, numbering starts from the lowest free id again.
    ann.binding.destroy();
    expect(ann.engine.session.body.commentIdFloor).toBeUndefined();
  });

  it('refuses text changes from a commenter on the server side', () => {
    const doc = createSharedDoc(editorState({ session: { body: new TextDocument([paragraph('abc')]), storyEdits: {} } }));
    const copy = new Y.Doc(); Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const vector = Y.encodeStateVector(copy);
    copy.getText('body').insert(0, 'x');
    expect(() => checkCommentOnly(doc, Y.encodeStateAsUpdate(copy, vector))).toThrow(/comment/);
  });

  it('keeps changes made offline and sends them when the connection returns', async () => {
    const { hub, people: [ann, bob] } = await room('base');
    const annTransport = hub.peers.get([...hub.peers.keys()][0]);
    annTransport.online = false;
    ann.engine.execute(m => { m.select(4); m.replace(' text'); });
    await settle();
    expect(bob.engine.model.text).toBe('base');
    expect(ann.client.outbox.size).toBeGreaterThan(0);
    expect(ann.client.status).toBe('offline');
    annTransport.online = true; annTransport.handlers.online(true);
    await tick(1200);
    await settle();
    expect(bob.engine.model.text).toBe('base text');
    expect(ann.client.outbox.size).toBe(0);
  });

  it('switches to single-editor mode for content the shared text cannot hold', async () => {
    const { people: [ann, bob] } = await room('form');
    ann.engine.execute(m => { m.paragraphs[0].runs.push({ ...m.paragraphs[0].runs[0], text: '', contentControl: { id: 7, placeholder: true } }); m.didChange(); });
    await settle();
    expect(ann.binding.mode).toBe('single');
    expect(ann.binding.holdsLock()).toBe(true);
    expect(bob.binding.mode).toBe('single');
    expect(bob.engine.viewOnly).toBe(true);
    // The holder's edits reach the others as snapshots.
    ann.engine.execute(m => { m.select(0); m.replace('A '); });
    await settle();
    expect(bob.engine.model.text).toBe('A form');
    // Once the holder leaves, someone else can take over.
    ann.binding.releaseLock();
    await settle();
    bob.binding.takeLock();
    expect(bob.engine.viewOnly).toBe(false);
  });

  it('gives people stable, readable colors and parses links', () => {
    expect(colorFor('alice')).toBe(colorFor('alice'));
    expect(PERSON_COLORS).toContain(colorFor('bob'));
    const link = shareLink('https://example.com/app/', { local: true, room: 'room_1', role: 'viewer' });
    expect(parseLink(link)).toEqual({ local: true, server: null, room: 'room_1', token: undefined, role: 'viewer' });
    expect(initials('ada lovelace')).toBe('AL');
  });
});
