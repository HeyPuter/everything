import { describe, it, expect } from 'vitest';
import { History, snapshotOf, applySnapshot } from '../src/editor/history.js';

describe('History', () => {
  it('undoes and redoes snapshots in order', () => {
    const h = new History();
    h.reset('a');
    h.push('b');
    h.push('c');
    expect(h.undo().snapshot).toBe('b');
    expect(h.undo().snapshot).toBe('a');
    expect(h.undo()).toBeNull();
    expect(h.redo().snapshot).toBe('b');
  });

  it('drops the redo branch on a new edit', () => {
    const h = new History();
    h.reset('a');
    h.push('b');
    h.undo();
    h.push('x');
    expect(h.canRedo()).toBe(false);
    expect(h.undo().snapshot).toBe('a');
  });

  it('ignores unchanged snapshots and caps its length', () => {
    const h = new History(3);
    h.reset('a');
    expect(h.push('a')).toBe(false);
    for (const s of ['b', 'c', 'd', 'e']) h.push(s);
    expect(h.stack.length).toBe(3);
  });

  it('drops the oldest entries when the snapshots grow too large', () => {
    const h = new History(200, { budget: 100, keep: 3 });
    h.reset('a'.repeat(30));
    for (const c of 'bcdefg') h.push(c.repeat(30));
    // 7 x 30 characters is over the budget: only the newest that fit stay.
    expect(h.stack.map((e) => e.snapshot[0]).join('')).toBe('efg');
    expect(h.index).toBe(2);
    expect(h.undo().snapshot[0]).toBe('f');
    // A single huge page still keeps the minimum number of steps.
    const big = new History(200, { budget: 10, keep: 3 });
    big.reset('x'.repeat(50));
    for (const c of 'yzw') big.push(c.repeat(50));
    expect(big.stack).toHaveLength(3);
  });

  it('applies the size budget to page snapshots, counting shared ink once', () => {
    const page = { title: 'T', outlines: [{ id: 'o', html: 'x'.repeat(40) }], ink: [{ id: 'i', type: 'stroke', points: Array.from({ length: 50 }, (_, k) => [k, k, 0.5]) }] };
    const ink = JSON.stringify(page.ink).length;
    const doc = snapshotOf(page).doc.length;
    // Room for the ink once plus four page texts, not for the ink per entry.
    const h = new History(200, { budget: ink + doc * 4 + 2, keep: 2 });
    h.reset(snapshotOf(page));
    for (const c of 'abcdef') {
      page.outlines[0].html = c.repeat(40);
      h.push(snapshotOf(page));
    }
    expect(h.stack).toHaveLength(4);
    expect(JSON.parse(h.stack[0].snapshot.doc).outlines[0].html[0]).toBe('c');
  });

  it('snapshots only the editable page state', () => {
    const page = { id: 'p', title: 'T', created: 'c', outlines: [{ id: 'o', html: 'x' }], ink: [], color: null, rules: 'college', ruleColor: null };
    const snap = snapshotOf(page);
    page.title = 'Changed';
    page.outlines = [];
    applySnapshot(page, snap);
    expect(page.title).toBe('T');
    expect(page.outlines).toHaveLength(1);
    expect(page.created).toBe('c');
  });
});

describe('History with ink', () => {
  it('keeps ink apart from page text and restores both', () => {
    const page = { title: 'T', outlines: [{ id: 'o', html: 'a' }], ink: [{ id: 'i', type: 'stroke', points: [[1, 2, 0.5]] }] };
    const h = new History();
    h.reset(snapshotOf(page));
    page.outlines[0].html = 'ab';
    expect(h.push(snapshotOf(page))).toBe(true);
    page.outlines[0].html = 'abc';
    h.push(snapshotOf(page));
    // Ink is kept apart from the page text (string identity isn't observable
    // from JS; the memory saving was measured in the browser).
    expect(h.stack[2].snapshot.ink).toBe(h.stack[0].snapshot.ink);
    expect(h.stack[2].snapshot.doc).not.toBe(h.stack[0].snapshot.doc);
    page.ink = [];
    h.push(snapshotOf(page));
    applySnapshot(page, h.undo().snapshot);
    expect(page.ink).toHaveLength(1);
    expect(page.outlines[0].html).toBe('abc');
    expect(h.push(snapshotOf(page))).toBe(false);
  });
});

describe('PageEditor undo', () => {
  it('keeps focus on the page when undo removes the focused container', async () => {
    const { PageEditor } = await import('../src/editor/page-editor.js');
    const host = document.createElement('div');
    document.body.append(host);
    const store = { pageChanged() {}, assetUrl: async () => null };
    const ed = new PageEditor({ store, host });
    await ed.open({ id: 'p', title: '', created: new Date().toISOString(), outlines: [], ink: [] });
    const el = ed.createOutlineAt(100, 200);
    const bodyEl = el.querySelector('.outline-body');
    bodyEl.innerHTML = '<p>typed</p>';
    ed.dirty.add(el);
    ed.commit();
    expect(document.activeElement).toBe(bodyEl);
    expect(await ed.undo()).toBe(true);
    expect(ed.page.outlines).toHaveLength(0);
    expect(ed.scroller.contains(document.activeElement)).toBe(true);
    expect(await ed.redo()).toBe(true);
    expect(ed.page.outlines[0].html).toBe('<p>typed</p>');
    ed.destroy();
    host.remove();
  });
});

describe('PageEditor undo selection', () => {
  it('puts back the selection a formatting change started from', async () => {
    const { PageEditor } = await import('../src/editor/page-editor.js');
    const host = document.createElement('div');
    document.body.append(host);
    const ed = new PageEditor({ store: { pageChanged() {}, assetUrl: async () => null }, host });
    await ed.open({ id: 'p', title: '', created: new Date().toISOString(), outlines: [{ id: 'o1', x: 40, y: 140, w: null, html: '<p>alpha beta gamma</p>' }], ink: [] });
    const bodyEl = host.querySelector('.outline-body');
    bodyEl.focus();
    const text = bodyEl.querySelector('p').firstChild;
    const sel = document.getSelection();
    sel.setBaseAndExtent(text, 6, text, 10);
    ed.onSelectionChange();
    // Italic the way Chrome does it: the original text node keeps the tail.
    const head = document.createTextNode('alpha ');
    const i = document.createElement('i');
    i.textContent = 'beta';
    text.nodeValue = ' gamma';
    text.before(head, i);
    sel.setBaseAndExtent(i.firstChild, 0, i.firstChild, 4);
    bodyEl.dispatchEvent(new Event('input', { bubbles: true }));
    ed.commit();
    expect(ed.history.stack.length).toBe(2);
    // The caret moves on, then undo.
    sel.setBaseAndExtent(text, 6, text, 6);
    ed.onSelectionChange();
    await ed.undo();
    expect(host.querySelector('.outline-body').innerHTML).toBe('<p>alpha beta gamma</p>');
    expect(document.getSelection().toString()).toBe('beta');
    ed.destroy();
    host.remove();
  });
});
