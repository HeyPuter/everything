import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import * as C from '../src/data/comments.js';

describe('comments', () => {
  it('starts threads, replies and resolves them', () => {
    const doc = new Y.Doc();
    const t = C.addThread(doc, { block: 'b1', quote: 'launch date', text: 'Is this final?', by: 'sam' });
    C.reply(doc, t, 'Yes, confirmed.', 'ana');
    expect(C.listThreads(doc)[0]).toMatchObject({ block: 'b1', quote: 'launch date', resolved: false });
    expect(C.listThreads(doc)[0].messages.map((m) => [m.by, m.text])).toEqual([['sam', 'Is this final?'], ['ana', 'Yes, confirmed.']]);
    expect(C.openByBlock(doc).get('b1')).toBe(1);
    C.setResolved(doc, t, true);
    expect(C.openCount(doc)).toBe(0);
    // A reply opens a resolved thread again.
    C.reply(doc, t, 'Wait, one more thing', 'sam');
    expect(C.openCount(doc)).toBe(1);
  });

  it('ignores empty comments', () => {
    const doc = new Y.Doc();
    expect(C.addThread(doc, { text: '   ' })).toBe(null);
    expect(C.listThreads(doc)).toEqual([]);
  });

  it('edits and deletes messages, removing empty threads', () => {
    const doc = new Y.Doc();
    const t = C.addThread(doc, { text: 'first', by: 'sam' });
    const r = C.reply(doc, t, 'second', 'sam');
    C.editMessage(doc, t, r, 'second, edited');
    expect(C.getThread(doc, t).messages[1]).toMatchObject({ text: 'second, edited' });
    const [first] = C.getThread(doc, t).messages;
    C.deleteMessage(doc, t, first.id);
    C.deleteMessage(doc, t, r);
    expect(C.listThreads(doc)).toEqual([]);
  });

  it('merges comments from two people', () => {
    const a = new Y.Doc();
    const t = C.addThread(a, { text: 'start', by: 'sam' });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    C.reply(a, t, 'from a', 'sam');
    C.reply(b, t, 'from b', 'ana');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(C.getThread(a, t).messages.map((m) => m.text).sort()).toEqual(['from a', 'from b', 'start']);
    expect(C.getThread(b, t).messages.map((m) => m.text)).toEqual(C.getThread(a, t).messages.map((m) => m.text));
  });

  it('keeps one copy of a message edited on two devices at once', () => {
    const a = new Y.Doc();
    const t = C.addThread(a, { text: 'start', by: 'sam' });
    C.reply(a, t, 'second', 'sam');
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const [first, second] = C.getThread(a, t).messages;
    C.editMessage(a, t, first.id, 'from a');
    C.editMessage(b, t, first.id, 'from b');
    C.deleteMessage(b, t, second.id);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const messages = C.getThread(a, t).messages;
    expect(messages).toHaveLength(1);
    expect(['from a', 'from b']).toContain(messages[0].text);
    expect(C.getThread(b, t).messages).toEqual(messages);
    expect(a.getMap('threads').get(t).get('messages').length).toBe(2);
  });

  it('reads plain messages from older documents, collapsing duplicate copies', () => {
    const doc = new Y.Doc();
    const t = C.addThread(doc, { text: 'start', by: 'sam' });
    const arr = doc.getMap('threads').get(t).get('messages');
    // What two concurrent edits used to leave: the same message twice.
    doc.transact(() => {
      arr.delete(0, 1);
      arr.insert(0, [{ id: 'm1', by: 'sam', text: 'old', at: 1, edited: 5 }, { id: 'm1', by: 'sam', text: 'older', at: 1, edited: 3 }, { id: 'm2', by: 'ana', text: 'hi', at: 2 }]);
    });
    expect(C.getThread(doc, t).messages.map((m) => m.text)).toEqual(['old', 'hi']);
    C.editMessage(doc, t, 'm1', 'new');
    expect(C.getThread(doc, t).messages.map((m) => [m.id, m.text])).toEqual([['m1', 'new'], ['m2', 'hi']]);
    expect(arr.length).toBe(2);
    expect(arr.get(0)).toBeInstanceOf(Y.Map);
  });

  it('skips a thread whose message list is not a list it can read', () => {
    const doc = new Y.Doc();
    const t = C.addThread(doc, { text: 'start', by: 'sam' });
    const m = doc.getMap('threads').get(t);
    m.set('messages', m.get('messages').toJSON());
    expect(C.listThreads(doc)).toEqual([]);
    expect(C.reply(doc, t, 'hi', 'sam')).toBe(null);
    expect(C.editMessage(doc, t, 'x', 'hi')).toBe(false);
  });
});
