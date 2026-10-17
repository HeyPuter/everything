import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { Editor } from '../src/editor/editor.js';
import { insertBlocks, listBlocks } from '../src/data/page.js';
import { setSelectionOffsets } from '../src/data/richtext.js';
import { closeAllPopovers } from '../src/ui/popover.js';

let editor;
let host;

function mount(specs, ctx = {}) {
  document.body.innerHTML = '<main id="main"></main><div id="live-region"></div>';
  host = document.createElement('div');
  document.getElementById('main').append(host);
  const doc = new Y.Doc();
  if (specs) insertBlocks(doc, specs);
  editor = new Editor(host, doc, {
    space: { assetUrl: async () => null },
    readOnly: false,
    tree: () => new Y.Doc(),
    navigate: () => {},
    pageTitle: () => 'Linked page',
    toast: () => {},
    createChild: async () => 'child1',
    searchPages: () => [],
    ...ctx,
  });
  return { doc, editor };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const summary = (doc) => listBlocks(doc).map((b) => [b.type, b.delta.map((o) => o.insert).join('')]);

/** Focuses a block's text and puts the caret at an offset (jsdom needs a tab index to focus). */
function caret(id, start, end = start) {
  const el = editor.textEl(id);
  el.tabIndex = 0;
  el.focus();
  setSelectionOffsets(el, start, end);
  return el;
}

/** What typing does: change the DOM, then fire input. */
function typeInto(id, text, data) {
  const el = editor.textEl(id);
  el.textContent = text;
  setSelectionOffsets(el, text.length);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data }));
  return el;
}

afterEach(() => {
  closeAllPopovers();
  editor?.destroy();
});

describe('editor rendering', () => {
  it('renders blocks as labelled text boxes', () => {
    mount([{ type: 'h1', text: 'Title' }, { type: 'todo', text: 'Task', checked: true }, { type: 'numbered', text: 'one' }, { type: 'numbered', text: 'two' }]);
    const boxes = [...host.querySelectorAll('.blk-text')];
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual(['Heading 1', 'To-do list', 'Numbered list', 'Numbered list']);
    expect(boxes.every((b) => b.getAttribute('role') === 'textbox')).toBe(true);
    expect(host.querySelector('.check').getAttribute('aria-checked')).toBe('true');
    expect([...host.querySelectorAll('.number')].map((n) => n.textContent)).toEqual(['1.', '2.']);
  });

  it('hides what is inside a collapsed toggle', async () => {
    const { doc } = mount([{ type: 'toggle', text: 'More', collapsed: true }, { text: 'hidden', indent: 1 }, { text: 'after' }]);
    expect(host.querySelectorAll('.blk')).toHaveLength(2);
    host.querySelector('.toggle').click();
    await tick();
    expect(host.querySelectorAll('.blk')).toHaveLength(3);
    expect(listBlocks(doc)[0].collapsed).toBe(false);
  });

  it('adds a line to type in when the page is empty', async () => {
    const { doc } = mount(null);
    await tick();
    expect(listBlocks(doc)).toHaveLength(1);
    expect(host.querySelectorAll('.blk-text')).toHaveLength(1);
  });

  it('shows changes made by someone else', async () => {
    const { doc } = mount([{ text: 'hello' }]);
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const [b] = listBlocks(other);
    other.getMap('blocks').get(b.id).get('text').insert(5, ' world');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other), 'remote');
    await tick();
    expect(host.querySelector('.blk-text').textContent).toBe('hello world');
  });

  it('is read-only for viewers', () => {
    mount([{ text: 'x' }, { type: 'todo', text: 'y' }], { readOnly: true });
    expect(host.querySelector('.blk-text').getAttribute('contenteditable')).toBe('false');
    expect(host.querySelector('.check').disabled).toBe(true);
    expect(host.querySelector('.blk-handle')).toBeTruthy();
  });
});

describe('editing', () => {
  it('saves typed text into the document', () => {
    const { doc } = mount([{ text: '' }]);
    const [b] = listBlocks(doc);
    typeInto(b.id, 'Hello', 'o');
    expect(summary(doc)).toEqual([['paragraph', 'Hello']]);
  });

  it('turns Markdown typed at the start of a line into blocks', () => {
    const { doc } = mount([{ text: '' }]);
    const [b] = listBlocks(doc);
    caret(b.id, 0);
    typeInto(b.id, '## ', ' ');
    expect(summary(doc)).toEqual([['h2', '']]);
  });

  it('turns **text** into bold as it is closed', () => {
    const { doc } = mount([{ text: '' }]);
    const [b] = listBlocks(doc);
    caret(b.id, 0);
    typeInto(b.id, 'a **b**', '*');
    expect(listBlocks(doc)[0].delta).toEqual([{ insert: 'a ' }, { insert: 'b', attributes: { bold: true } }]);
  });

  it('splits a block with Enter and merges it back with Backspace', async () => {
    const { doc } = mount([{ text: 'hello world' }]);
    const [b] = listBlocks(doc);
    const el = caret(b.id, 5);
    editor.enter(b.id, el);
    await tick();
    expect(summary(doc)).toEqual([['paragraph', 'hello'], ['paragraph', ' world']]);
    const second = listBlocks(doc)[1].id;
    caret(second, 0);
    editor.backspaceAtStart(second);
    await tick();
    expect(summary(doc)).toEqual([['paragraph', 'hello world']]);
  });

  it('leaves a list when Enter is pressed on an empty item', async () => {
    const { doc } = mount([{ type: 'bulleted', text: '' }]);
    const [b] = listBlocks(doc);
    editor.enter(b.id, caret(b.id, 0));
    await tick();
    expect(summary(doc)).toEqual([['paragraph', '']]);
  });

  it('applies bold to selected text', () => {
    const { doc } = mount([{ text: 'make this bold' }]);
    const [b] = listBlocks(doc);
    caret(b.id, 5, 9);
    editor.toggleMark('bold');
    expect(listBlocks(doc)[0].delta).toEqual([{ insert: 'make ' }, { insert: 'this', attributes: { bold: true } }, { insert: ' bold' }]);
    caret(b.id, 5, 9);
    editor.toggleMark('bold');
    expect(listBlocks(doc)[0].delta).toEqual([{ insert: 'make this bold' }]);
  });

  it('turns a line into the block picked in the "/" menu, removing what was typed', async () => {
    const { doc } = mount([{ text: '' }]);
    const [b] = listBlocks(doc);
    caret(b.id, 0);
    typeInto(b.id, '/', '/');
    expect(editor.slash).toBeTruthy();
    typeInto(b.id, '/quo', 'o');
    expect(editor.slash.menu.items.map((i) => i.label)).toEqual(['Quote']);
    editor.handleMenuKey(new KeyboardEvent('keydown', { key: 'Enter' }));
    await tick();
    expect(summary(doc)).toEqual([['quote', '']]);
    expect(editor.slash).toBe(null);
  });

  it('inserts subpages from the "/" menu', async () => {
    let opened = null;
    const { doc } = mount([{ text: '' }], { navigate: (id) => (opened = id) });
    const [b] = listBlocks(doc);
    caret(b.id, 0);
    typeInto(b.id, '/', '/');
    typeInto(b.id, '/page', 'e');
    await editor.applySlash({ action: 'page' });
    expect(listBlocks(doc)[0]).toMatchObject({ type: 'page', page: 'child1' });
    expect(opened).toBe('child1');
  });

  it('pastes Markdown as blocks', async () => {
    const { doc } = mount([{ text: '' }]);
    const [b] = listBlocks(doc);
    caret(b.id, 0);
    const data = { files: [], getData: (t) => (t === 'text/plain' ? '# Plan\n\n- one\n- two' : '') };
    const e = new Event('paste', { bubbles: true, cancelable: true });
    e.clipboardData = data;
    editor.textEl(b.id).dispatchEvent(e);
    await tick();
    expect(summary(doc)).toEqual([['h1', 'Plan'], ['bulleted', 'one'], ['bulleted', 'two']]);
  });

  it('moves, duplicates and deletes selected blocks from the keyboard', async () => {
    const { doc } = mount([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
    const [a] = listBlocks(doc);
    editor.selectBlocks([a.id]);
    editor.onSelectionKey(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, metaKey: true, ctrlKey: true }));
    await tick();
    expect(summary(doc).map((s) => s[1])).toEqual(['b', 'a', 'c']);
    editor.selectBlocks([a.id]);
    editor.onSelectionKey(new KeyboardEvent('keydown', { key: 'Delete' }));
    await tick();
    expect(summary(doc).map((s) => s[1])).toEqual(['b', 'c']);
  });

  it('undoes and redoes edits', async () => {
    const { doc } = mount([{ text: '' }]);
    const [b] = listBlocks(doc);
    typeInto(b.id, 'draft', 't');
    editor.undo.stopCapturing();
    editor.undo.undo();
    await tick();
    expect(summary(doc)).toEqual([['paragraph', '']]);
    editor.undo.redo();
    expect(summary(doc)).toEqual([['paragraph', 'draft']]);
  });
});

describe('tables', () => {
  it('keeps the cell being typed in when the table saves', async () => {
    const { doc } = mount([{ type: 'table', table: { rows: [['a', 'b'], ['c', 'd']], header: true } }]);
    const cell = host.querySelector('td');
    cell.focus();
    cell.textContent = 'typed';
    cell.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 600));
    expect(listBlocks(doc)[0].table.rows[1][0]).toBe('typed');
    // The same element is still there and still focused.
    expect(host.querySelector('td')).toBe(cell);
    expect(document.activeElement).toBe(cell);
  });

  it('rebuilds when rows are added', async () => {
    const { doc } = mount([{ type: 'table', table: { rows: [['a'], ['b']], header: false } }]);
    host.querySelector('.table-controls .btn').click();
    await tick();
    expect(listBlocks(doc)[0].table.rows).toHaveLength(3);
    expect(host.querySelectorAll('tr')).toHaveLength(3);
  });
});

describe('input methods', () => {
  it('keeps text from others that arrives while composing', async () => {
    const { doc } = mount([{ text: 'hello' }]);
    const [b] = listBlocks(doc);
    const el = caret(b.id, 5);
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    // Someone else types at the start meanwhile.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    other.getMap('blocks').get(b.id).get('text').insert(0, 'X');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other), 'remote');
    await tick();
    // The browser's DOM shows the composed text, not the remote change yet.
    el.textContent = 'hello日本';
    setSelectionOffsets(el, 7);
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
    await tick();
    expect(listBlocks(doc)[0].delta.map((o) => o.insert).join('')).toBe('Xhello日本');
    expect(el.textContent).toBe('Xhello日本');
  });
});

describe('structure edge cases', () => {
  it('adds a line after what a collapsed toggle hides', async () => {
    const { doc } = mount([{ type: 'toggle', text: 'More', collapsed: true }, { text: 'inside', indent: 1 }]);
    const [t] = listBlocks(doc);
    editor.enter(t.id, caret(t.id, 4));
    await tick();
    expect(summary(doc).map((x) => x[1])).toEqual(['More', 'inside', '']);
  });

  it('replaces the selection when pasting several blocks', async () => {
    const { doc } = mount([{ text: 'keep REPLACE end' }]);
    const [b] = listBlocks(doc);
    caret(b.id, 5, 12);
    const e = new Event('paste', { bubbles: true, cancelable: true });
    e.clipboardData = { files: [], getData: (t) => (t === 'text/plain' ? '- one\n- two' : '') };
    editor.textEl(b.id).dispatchEvent(e);
    await tick();
    expect(summary(doc)).toEqual([['paragraph', 'keep '], ['bulleted', 'one'], ['bulleted', 'two'], ['paragraph', ' end']]);
  });

  it('keeps typing in an image caption when it saves', async () => {
    const { doc } = mount([{ type: 'image', url: 'https://example.com/a.png' }]);
    await tick();
    const caption = host.querySelector('.media-caption');
    caption.tabIndex = 0;
    caption.focus();
    caption.textContent = 'A cat';
    caption.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 450));
    expect(listBlocks(doc)[0].caption).toBe('A cat');
    expect(host.querySelector('.media-caption')).toBe(caption);
  });

  it('merges table cells typed by two people', async () => {
    const { doc } = mount([{ type: 'table', table: { rows: [['a', 'b'], ['c', 'd']], header: false } }]);
    const T = await import('../src/data/table.js');
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const cells = host.querySelectorAll('td');
    cells[0].textContent = 'mine';
    cells[0].dispatchEvent(new Event('input'));
    // Someone else changes another cell and adds a row before the save.
    const [b] = listBlocks(other);
    T.setCells(other, b.id, [{ row: b.table.rowIds[1], col: b.table.colIds[1], text: 'theirs' }]);
    T.insertRow(other, b.id);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    await tick();
    expect(host.querySelectorAll('tr')).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 600));
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    expect(listBlocks(doc)[0].table.rows).toEqual([['mine', 'b'], ['c', 'theirs'], ['', '']]);
    expect(listBlocks(other)[0].table.rows).toEqual(listBlocks(doc)[0].table.rows);
  });

  it('undoes typing in a table cell, saved or not, and shows it in that cell', async () => {
    const { doc } = mount([{ type: 'table', table: { rows: [['a', 'b']], header: false } }]);
    const cell = () => host.querySelector('td');
    const undo = () => cell().dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, metaKey: true, bubbles: true }));
    cell().tabIndex = 0;
    cell().focus();
    // Undo right after typing, before the cell saved on its own.
    cell().textContent = 'typed';
    cell().dispatchEvent(new Event('input'));
    undo();
    await new Promise((r) => setTimeout(r, 500));
    expect(listBlocks(doc)[0].table.rows).toEqual([['a', 'b']]);
    expect(cell().textContent).toBe('a');
    // Undo after it saved, while the caret is still in the cell.
    cell().textContent = 'again';
    cell().dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 500));
    expect(listBlocks(doc)[0].table.rows).toEqual([['again', 'b']]);
    editor.undo.stopCapturing();
    undo();
    await tick();
    expect(document.activeElement).toBe(cell());
    expect(listBlocks(doc)[0].table.rows).toEqual([['a', 'b']]);
    expect(cell().textContent).toBe('a');
  });
});
