import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  // Typed inside a tracked insertion while someone accepted it, text carried the insertion's mark back after itself
  // over the rest of the document; Reject All would then have removed it. Rejecting at that moment did the same.
  for (const accept of [true, false]) it(`keeps a tracked change ${accept ? 'accepted' : 'rejected'} while someone types inside it off the text after it`, async () => {
    const { hub, people: [ann, bob] } = await room('Alpha beta gamma delta');
    ann.engine.execute(m => { m.trackChanges = true; m.revisionAuthor = 'Ann'; m.select(5); m.replace(' INSERTED'); m.trackChanges = false; });
    await settle();
    ann.binding.undoManager.stopCapturing();
    hub.pause();
    ann.engine.execute(m => m.resolveRevisions(accept));
    bob.engine.execute(m => { m.select(8); m.replace('xx'); });
    await settle(); hub.resume(); await settle(); await settle();
    // Rejected, the insertion's text goes and Bob's stays (where the shared text's diff puts the space beside it).
    const expected = accept ? 'Alpha INxxSERTED beta gamma delta' : 'Alpha xxbeta gamma delta';
    for (const person of [ann, bob]) {
      expect(person.engine.model.text).toBe(expected);
      expect(person.engine.session.body.revisions).toEqual([]);
    }
    // Ann's Undo brings her change back as it was.
    ann.engine.undo();
    await settle();
    for (const person of [ann, bob]) expect(person.engine.session.body.revisions.map(r => [r.type, r.author])).toEqual([['ins', 'Ann']]);
  });

  // The clock stands still, so every change is made in the same second: new tracked text has the very author, kind
  // and time of the change accepted before it, which is all a tracked change records. It is still not a spill.
  describe('with every change in the same second', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-22T12:00:00Z')); });
    afterEach(() => vi.useRealTimers());
    const tracked = (person, at, text) => person.engine.execute(m => { m.trackChanges = true; m.revisionAuthor = 'Bob'; m.select(typeof at === 'function' ? at(m) : at); m.replace(text); m.trackChanges = false; });
    const changes = person => person.engine.session.body.revisions.map(r => [r.type, r.author, person.engine.model.text.slice(r.start, r.end)]);

    it('keeps tracked text typed after an Accept All has arrived', async () => {
      const { people: [ann, bob] } = await room('Alpha beta.\nSecond paragraph.');
      tracked(bob, 5, ' NEW');
      await settle();
      ann.engine.execute(m => m.resolveRevisions(true));
      await settle();
      expect(changes(bob)).toEqual([]);
      // Right after the accepted text, and elsewhere.
      tracked(bob, 9, ' more');
      tracked(bob, m => m.text.length, ' end');
      await settle(); await settle();
      for (const person of [ann, bob]) expect(changes(person)).toEqual([['ins', 'Bob', ' more'], ['ins', 'Bob', ' end']]);
    });

    it('keeps tracked text typed in another paragraph at the moment of an Accept All', async () => {
      const { hub, people: [ann, bob] } = await room('Alpha beta.\nSecond paragraph.');
      tracked(bob, 5, ' NEW');
      await settle();
      hub.pause();
      ann.engine.execute(m => m.resolveRevisions(true));
      tracked(bob, m => m.text.length, ' end');
      await settle(); hub.resume(); await settle(); await settle();
      for (const person of [ann, bob]) expect(changes(person)).toEqual([['ins', 'Bob', ' end']]);
    });

    it('keeps a new paragraph typed inside the accepted text at that moment tracked, and nothing after it', async () => {
      const { hub, people: [ann, bob] } = await room('Alpha beta.\nSecond paragraph.');
      tracked(bob, 5, ' NEW');
      await settle();
      hub.pause();
      ann.engine.execute(m => m.resolveRevisions(true));
      tracked(bob, 7, 'xx\nyy');
      await settle(); hub.resume(); await settle(); await settle();
      for (const person of [ann, bob]) {
        expect(person.engine.model.text).toBe('Alpha Nxx\nyyEW beta.\nSecond paragraph.');
        // "xx", typed into Bob's own insertion with its mark, is part of what Ann accepted; the new paragraph is not.
        // Without the repair, "EW beta." and the paragraph after it came back marked too.
        expect(changes(person)).toEqual([['ins', 'Bob', '\nyy']]);
      }
    });
  });

  it('shares Track Changes turned on for everyone, but keeps tracking just mine to this person', async () => {
    const { people: [ann, bob] } = await room('Alpha beta');
    // For everyone (Review > Track Changes sets it in an unrecorded transaction): it reaches Bob before Ann edits.
    ann.engine.session.run(() => { ann.engine.session.body.trackChanges = true; }, undefined, { record: false });
    await settle();
    expect(bob.engine.session.body.trackChanges).toBe(true);
    bob.engine.execute(m => { m.select(0); m.replace('B'); });
    await settle();
    expect(ann.engine.session.body.trackChanges).toBe(true);
    expect(bob.engine.session.body.revisions.map(r => r.type)).toEqual(['ins']);
    // Just mine: Ann's edits no longer turned tracking on for everyone, and Bob turning it off for everyone no longer
    // turned off what Ann tracks for herself.
    bob.engine.session.run(() => { bob.engine.session.body.trackChanges = false; }, undefined, { record: false });
    await settle();
    expect(ann.engine.session.body.trackChanges).toBe(false);
    Object.assign(ann.engine.session.body, { trackChangesMode: 'mine', trackChanges: true });
    ann.engine.execute(m => { m.select(m.text.length); m.replace(' A'); });
    await settle();
    expect(bob.engine.session.body.trackChanges).toBe(false);
    expect(bob.engine.model.text).toBe('BAlpha beta A');
    bob.engine.execute(m => { m.select(0); m.replace('C'); });
    await settle();
    expect(ann.engine.session.body.trackChanges).toBe(true);
    expect(ann.engine.session.body.revisions.map(r => [r.type, ann.engine.model.text.slice(r.start, r.end)])).toEqual([['ins', 'B'], ['ins', ' A']]);
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

  // A thread deleted while someone else resolved or edited it came back for everyone (the edit wrote the comment
  // again) with no anchor: missing beside the text, but listed and saved without a reference.
  it.each(['edits', 'resolves'])('a thread deleted while someone %s it goes for everyone, with no unanchored comment left', async action => {
    const { hub, people: [ann, bob] } = await room('Alpha beta gamma delta');
    let id;
    ann.engine.execute(m => { m.select(6, 10); id = m.addComment({ author: 'Ann', text: 'Check beta' }); m.select(17, 22); m.addComment({ author: 'Ann', text: 'Keep' }); });
    await settle();
    hub.pause();
    ann.engine.execute(m => m.deleteComment(id));
    bob.engine.execute(m => (action === 'edits' ? m.editComment(id, 'Edited') : m.setCommentDone(id, true)));
    await settle();
    hub.resume();
    await settle();
    for (const person of [ann, bob]) {
      expect(person.engine.session.body.commentList.map(c => [c.text, c.start])).toEqual([['Keep', 17]]);
    }
    expect([...hub.doc.getMap('comments').keys()].filter(key => key !== '$part')).toHaveLength(1);
  });

  it('drops a comment added on words someone else deleted at the same moment, and keeps an unanchored one it had', async () => {
    const { hub, people: [ann, bob] } = await room('Alpha beta gamma delta');
    // A comment without an anchor from the file (as some files have) stays.
    ann.engine.execute(m => { m.comments = [{ id: '5', author: 'Old', initials: 'O', date: '', text: 'From the file', done: false, parentId: null, paraId: null }]; });
    await settle();
    hub.pause();
    ann.engine.execute(m => { m.select(6, 10); m.addComment({ author: 'Ann', text: 'On beta' }); });
    bob.engine.execute(m => { m.select(4, 12); m.replace(''); });
    await settle();
    hub.resume();
    await settle();
    for (const person of [ann, bob]) {
      expect(person.engine.model.text).toBe('Alphamma delta');
      expect(person.engine.session.body.comments.map(c => c.text)).toEqual(['From the file']);
    }
  });

  it('refuses text changes from a commenter on the server side', () => {
    const doc = createSharedDoc(editorState({ session: { body: new TextDocument([paragraph('abc')]), storyEdits: {} } }));
    const copy = new Y.Doc(); Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const vector = Y.encodeStateVector(copy);
    copy.getText('body').insert(0, 'x');
    expect(() => checkCommentOnly(doc, Y.encodeStateAsUpdate(copy, vector))).toThrow(/comment/);
  });

  it('refuses a commenter replacing a shared picture under its existing id', () => {
    const doc = createSharedDoc(editorState({ session: { body: new TextDocument([paragraph('abc')]), storyEdits: {} } }));
    doc.getMap('assets').set('img@1', new Uint8Array([1, 2, 3]));
    doc.getMap('assets').set('img@1#', JSON.stringify({ type: 'image/png', description: 'Logo' }));
    for (const write of [map => map.set('img@1', new Uint8Array([6, 6, 6])), map => map.set('img@1#', JSON.stringify({ type: 'image/png', description: 'Spoof' }))]) {
      const copy = new Y.Doc(); Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
      const vector = Y.encodeStateVector(copy);
      write(copy.getMap('assets'));
      expect(() => checkCommentOnly(doc, Y.encodeStateAsUpdate(copy, vector))).toThrow(/comment/);
    }
    // A comment alone still passes.
    const copy = new Y.Doc(); Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const vector = Y.encodeStateVector(copy);
    copy.getMap('comments').set('1000', JSON.stringify({ id: '1000', text: 'Nice' }));
    expect(() => checkCommentOnly(doc, Y.encodeStateAsUpdate(copy, vector))).not.toThrow();
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

  it('sends a picture added in single-editor mode to the others with its bytes', async () => {
    const { people: [ann, bob] } = await room('form');
    ann.engine.execute(m => { m.paragraphs[0].runs.push({ ...m.paragraphs[0].runs[0], text: '', contentControl: { id: 7, placeholder: true } }); m.didChange(); });
    await settle();
    expect(ann.binding.mode).toBe('single');
    ann.engine.execute(m => { m.assets.logo = { bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png' }; m.select(0); m.insertImage('logo', { width: 100, height: 100 }); });
    await settle();
    const run = bob.engine.model.paragraphs[0].runs.find(r => r.image);
    expect(run).toBeTruthy();
    // Without the picture's bytes the others cannot show it, and the owner's tab cannot save the file.
    expect(bob.engine.session.body.assets[run.image.assetId]?.bytes).toEqual(new Uint8Array([137, 80, 78, 71]));
    // Its id is this person's own, so it cannot stand for another picture someone else adds.
    expect(run.image.assetId).toMatch(/@/);
  });

  it('undoes and redoes the single editor\'s own changes, and shares the result', async () => {
    const { people: [ann, bob] } = await room('form');
    // An empty form field, which the shared text cannot hold, as an opened form brings one.
    ann.engine.execute(m => { m.paragraphs[0].runs = [...m.paragraphs[0].runs, { ...m.paragraphs[0].runs[0], text: '', contentControl: { id: 7, persistent: true } }]; m.didChange(); });
    await settle();
    expect(ann.binding.mode).toBe('single');
    ann.engine.execute(m => { m.select(0); m.replace('Typed '); });
    await settle();
    expect(bob.engine.model.text).toBe('Typed form');
    expect(ann.engine.session.history.length).toBeGreaterThan(0);
    ann.engine.undo();
    await settle();
    expect(ann.engine.model.text).toBe('form');
    expect(bob.engine.model.text).toBe('form');
    expect([ann.engine.session.future.length, ann.binding.mode, ann.binding.holdsLock()]).toEqual([1, 'single', true]);
    ann.engine.redo();
    await settle();
    expect(ann.engine.model.text).toBe('Typed form');
    expect(bob.engine.model.text).toBe('Typed form');
  });

  it('gives people stable, readable colors and parses links', () => {
    expect(colorFor('alice')).toBe(colorFor('alice'));
    expect(PERSON_COLORS).toContain(colorFor('bob'));
    const link = shareLink('https://example.com/app/', { local: true, room: 'room_1', role: 'viewer' });
    expect(parseLink(link)).toEqual({ local: true, server: null, room: 'room_1', token: undefined, role: 'viewer' });
    expect(initials('ada lovelace')).toBe('AL');
  });
});
