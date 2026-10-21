import { describe, it, expect, beforeEach } from 'vitest';
import { ensureBlocks, fixNesting, blocksInRange, rangeFromOffsets, textOffset, isEmptyBody, selectRange } from '../src/editor/selection.js';
import { toggleTag, removeAllTags, activeTags, tagSpan } from '../src/editor/tag-edit.js';
import { serialize, hydrate, fileSpan, formatBytes } from '../src/editor/embeds.js';
import { tableHtml, insertRow, insertColumn, deleteRow, deleteColumn, moveCell, sortTable, tableToText, toggleHeaderRow, hasHeaderRow } from '../src/editor/table.js';
import { setBlockStyle, indent, retag, moveBlock, insertNode, dropRedundantStyles } from '../src/editor/format.js';
import { textToHtml, ruleImage, PageEditor } from '../src/editor/page-editor.js';

function body(html) {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'outline-body';
  el.contentEditable = 'true';
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

function caretIn(node, offset = 0) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  selectRange(r);
  return r;
}

describe('selection helpers', () => {
  it('wraps stray inline content into paragraphs', () => {
    const el = body('Hello <b>world</b><ul><li>x</li></ul>tail');
    ensureBlocks(el);
    expect(el.innerHTML).toBe('<p>Hello <b>world</b></p><ul><li>x</li></ul><p>tail</p>');
  });

  it('gives an empty body a placeholder paragraph', () => {
    const el = body('');
    ensureBlocks(el);
    expect(el.innerHTML).toBe('<p><br></p>');
    expect(isEmptyBody(el)).toBe(true);
  });

  it('unwraps paragraphs the browser wrapped around lists', () => {
    const el = body('');
    const p = document.createElement('p');
    p.innerHTML = '<ul><li>a</li></ul>';
    el.append(p);
    fixNesting(el);
    expect(el.innerHTML).toBe('<ul><li>a</li></ul>');
  });

  it('maps character offsets to ranges and back', () => {
    const el = body('<p>Hello</p><p>World</p>');
    const r = rangeFromOffsets(el, 7, 9);
    expect(r.toString()).toBe('rl');
    expect(textOffset(el, r.startContainer, r.startOffset)).toBe(7);
  });

  it('finds the blocks a selection touches', () => {
    const el = body('<p>one</p><p>two</p><p>three</p>');
    const r = document.createRange();
    r.setStart(el.children[0].firstChild, 1);
    r.setEnd(el.children[1].firstChild, 2);
    expect(blocksInRange(r, el).map((b) => b.textContent)).toEqual(['one', 'two']);
  });
});

describe('tags', () => {
  let el;
  beforeEach(() => {
    el = body('<p>Call Sam</p><p>Buy milk</p>');
  });

  it('adds, completes and removes a To Do with the shortcut cycle', () => {
    caretIn(el.children[0].firstChild, 2);
    expect(toggleTag('todo', { cycle: true })).toBe('added');
    expect(el.querySelector('.nt-tag').getAttribute('role')).toBe('checkbox');
    expect(activeTags().has('todo')).toBe(true);
    caretIn(el.children[0].lastChild, 2);
    expect(toggleTag('todo', { cycle: true })).toBe('done');
    expect(el.querySelector('.nt-tag').dataset.done).toBe('true');
    expect(toggleTag('todo', { cycle: true })).toBe('removed');
    expect(el.querySelector('.nt-tag')).toBeNull();
  });

  it('stacks different tags on one paragraph and clears them all', () => {
    caretIn(el.children[1].firstChild, 0);
    toggleTag('important');
    toggleTag('question');
    expect([...el.children[1].querySelectorAll('.nt-tag')].map((t) => t.dataset.tag)).toEqual(['important', 'question']);
    removeAllTags();
    expect(el.querySelector('.nt-tag')).toBeNull();
  });

  it('tags every selected paragraph', () => {
    const r = document.createRange();
    r.setStart(el.children[0].firstChild, 0);
    r.setEnd(el.children[1].firstChild, 3);
    selectRange(r);
    toggleTag('important');
    expect(el.querySelectorAll('.nt-tag')).toHaveLength(2);
  });
});

describe('embeds', () => {
  it('serializes without display-only markup', async () => {
    const el = body('<p><span class="nt-tag" data-tag="todo" data-done="false" contenteditable="false"></span>x</p><p><img data-asset="a1.png" alt="Cat"></p>');
    el.querySelector('p').append(fileSpan({ asset: 'a2.pdf', name: 'Plan.pdf', size: 2048, type: 'application/pdf' }));
    const store = { assetUrl: async (id) => `blob:${id}` };
    await hydrate(el, store);
    expect(el.querySelector('img').getAttribute('src')).toBe('blob:a1.png');
    expect(el.querySelector('.nt-file').textContent).toContain('Plan.pdf');
    const html = serialize(el);
    expect(html).not.toContain('src=');
    expect(html).not.toContain('role=');
    expect(html).not.toContain('Plan.pdf</span>');
    expect(html).toContain('data-name="Plan.pdf"');
  });

  it('puts an embed inside the paragraph when the caret sits after it', () => {
    const el = body('<p><br></p>');
    caretIn(el, 1); // where a new container's caret lands
    insertNode(fileSpan({ asset: 'a2.pdf', name: 'Plan.pdf' }));
    expect(el.innerHTML).toMatch(/^<p><span class="nt-file"[^>]*><\/span>&nbsp;<\/p>$/);
    const two = body('<p>One</p>');
    caretIn(two, 1);
    insertNode(fileSpan({ asset: 'a3.pdf', name: 'B.pdf' }));
    expect(two.firstChild.textContent.startsWith('One')).toBe(true);
    expect(two.children.length).toBe(1);
  });

  it('makes a recording without a stored duration show its length', async () => {
    const el = body('');
    el.append(fileSpan({ asset: 'a4.webm', name: 'Audio recording.webm', type: 'audio/webm', kind: 'audio' }));
    await hydrate(el, { assetUrl: async () => 'blob:rec' });
    const media = el.querySelector('audio');
    let duration = Infinity;
    const seeks = [];
    Object.defineProperty(media, 'duration', { get: () => duration });
    Object.defineProperty(media, 'currentTime', { get: () => seeks.at(-1) ?? 0, set: (v) => seeks.push(v) });
    media.dispatchEvent(new Event('loadedmetadata'));
    expect(seeks[0]).toBeGreaterThan(1e6); // seek past the end to find the length
    media.dispatchEvent(new Event('durationchange')); // still unknown
    duration = 4.2;
    media.dispatchEvent(new Event('durationchange'));
    expect(seeks).toHaveLength(2);
    expect(seeks[1]).toBe(0);
  });

  it('treats a lone placeholder as empty', () => {
    expect(serialize(body('<p><br></p>'))).toBe('');
  });

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('tables', () => {
  let el;
  const cell = (r, c) => el.querySelectorAll('tr')[r].children[c];
  beforeEach(() => {
    el = body(tableHtml(2, 2));
    cell(0, 0).textContent = 'b';
    cell(1, 0).textContent = 'a';
    caretIn(cell(0, 0).firstChild, 0);
  });

  it('inserts and deletes rows and columns', () => {
    insertRow('below');
    expect(el.querySelectorAll('tr')).toHaveLength(3);
    insertColumn('right');
    expect(el.querySelectorAll('tr')[0].children).toHaveLength(3);
    caretIn(cell(0, 0).firstChild, 0);
    deleteColumn();
    expect(el.querySelectorAll('tr')[0].children).toHaveLength(2);
    caretIn(cell(0, 0).firstChild, 0);
    deleteRow();
    expect(el.querySelectorAll('tr')).toHaveLength(2);
  });

  it('adds a row when tabbing past the last cell', () => {
    caretIn(cell(1, 1), 0);
    expect(moveCell(1)).toBe(true);
    expect(el.querySelectorAll('tr')).toHaveLength(3);
  });

  it('sorts rows by the caret column and converts to text', () => {
    sortTable();
    expect(cell(0, 0).textContent).toBe('a');
    caretIn(cell(0, 0).firstChild, 0);
    toggleHeaderRow();
    expect(el.querySelector('th')).not.toBeNull();
    caretIn(el.querySelector('td'), 0);
    tableToText();
    expect(el.querySelector('table')).toBeNull();
    expect(el.textContent).toContain('a');
  });

  it('sorts body rows without moving them into a <thead>', () => {
    el = body('<table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>b</td></tr><tr><td>a</td></tr></tbody></table>');
    caretIn(el.querySelector('td').firstChild, 0);
    sortTable();
    expect(el.querySelectorAll('thead tr')).toHaveLength(1);
    expect([...el.querySelectorAll('tbody td')].map((c) => c.textContent)).toEqual(['a', 'b']);
  });

  it('keeps the caret in its cell when toggling the header row', () => {
    caretIn(cell(0, 1), 0);
    expect(hasHeaderRow()).toBe(false);
    toggleHeaderRow();
    expect(hasHeaderRow()).toBe(true);
    expect(document.getSelection().anchorNode).toBe(cell(0, 1));
    caretIn(cell(0, 0).firstChild, 1);
    toggleHeaderRow();
    expect(hasHeaderRow()).toBe(false);
    const sel = document.getSelection();
    expect(sel.anchorNode).toBe(cell(0, 0).firstChild);
    expect(sel.anchorOffset).toBe(1);
  });
});

describe('paragraph formatting', () => {
  it('applies and clears styles on the caret block', () => {
    const el = body('<p>Title</p>');
    caretIn(el.firstChild.firstChild, 1);
    setBlockStyle('h2');
    expect(el.innerHTML).toBe('<h2>Title</h2>');
    caretIn(el.firstChild.firstChild, 1);
    setBlockStyle('cite');
    expect(el.innerHTML).toBe('<p class="nt-cite">Title</p>');
    caretIn(el.firstChild.firstChild, 1);
    setBlockStyle('normal');
    expect(el.innerHTML).toBe('<p>Title</p>');
  });

  it('keeps the caret where it was when a style changes the block', () => {
    const el = body('<p>Head</p><p><br></p>');
    const text = el.firstChild.firstChild;
    caretIn(text, 4);
    setBlockStyle('h1');
    const sel = document.getSelection();
    expect(el.firstChild.tagName).toBe('H1');
    expect(sel.anchorNode).toBe(text);
    expect(sel.anchorOffset).toBe(4);
    setBlockStyle('cite');
    expect(sel.anchorNode).toBe(text);
    expect(sel.anchorOffset).toBe(4);
    // An empty paragraph: the caret sits on the block element itself.
    caretIn(el.children[1], 0);
    setBlockStyle('h2');
    expect(el.children[1].tagName).toBe('H2');
    expect(sel.anchorNode).toBe(el.children[1]);
    expect(sel.anchorOffset).toBe(0);
    // A list item gets a styled paragraph inside it; the caret follows.
    const li = body('<ul><li>item</li></ul>').querySelector('li');
    const t = li.firstChild;
    caretIn(t, 2);
    setBlockStyle('h3');
    expect(li.innerHTML).toBe('<h3>item</h3>');
    expect(sel.anchorNode).toBe(t);
    expect(sel.anchorOffset).toBe(2);
    setBlockStyle('normal');
    expect(li.innerHTML).toBe('item');
    expect(sel.anchorNode).toBe(t);
    expect(sel.anchorOffset).toBe(2);
  });

  it("drops the styles Chrome's editing freezes onto moved text", () => {
    document.head.innerHTML = '<style>.outline-body{font-size:11pt;color:rgb(27, 27, 27)} .outline-body h1{font-size:16pt;color:rgb(30, 78, 140)}</style>';
    const el = body('<h1>Title <span style="font-size: 11pt; background-color: transparent;">pasted</span> <a href="#x" style="color: rgb(27, 27, 27); font-size: 11pt;">link</a></h1>'
      + '<p>keep <span style="color: red; font-size: 20px;">red</span> <b style="font-size: 11pt;">b</b> <mark style="background-color: transparent;">m</mark></p>');
    const spans = [...el.querySelectorAll('[style]')];
    const text = el.querySelector('h1 span').firstChild;
    caretIn(text, 3);
    dropRedundantStyles(spans);
    expect(el.innerHTML).toBe('<h1>Title pasted <a href="#x">link</a></h1>'
      + '<p>keep <span style="color: red; font-size: 20px;">red</span> <b>b</b> <mark style="background-color: transparent;">m</mark></p>');
    // The caret stays in the text that was inside the unwrapped span.
    expect(document.getSelection().anchorNode).toBe(text);
    expect(document.getSelection().anchorOffset).toBe(3);
    document.head.innerHTML = '';
  });

  it('indents plain paragraphs with a margin', () => {
    const el = body('<p>x</p>');
    caretIn(el.firstChild.firstChild, 0);
    indent(1);
    indent(1);
    expect(el.firstChild.style.marginLeft).toBe('60px');
    indent(-1);
    indent(-1);
    expect(el.firstChild.getAttribute('style')).toBeNull();
  });

  it('moves paragraphs up and down', () => {
    const el = body('<p>a</p><p>b</p><p>c</p>');
    caretIn(el.children[2].firstChild, 0);
    expect(moveBlock(-1)).toBe(true);
    expect(el.textContent).toBe('acb');
    expect(moveBlock(-1)).toBe(true);
    expect(moveBlock(-1)).toBe(false);
    expect(el.textContent).toBe('cab');
  });

  it('retags elements keeping attributes', () => {
    const el = body('<p style="text-align: center">x</p>');
    expect(retag(el.firstChild, 'H1').outerHTML).toBe('<h1 style="text-align: center">x</h1>');
  });
});

describe('page helpers', () => {
  it('turns pasted text into paragraphs and links', () => {
    expect(textToHtml('see https://example.com.')).toBe('see <a href="https://example.com">https://example.com</a>.');
    expect(textToHtml('a\n\nb')).toBe('<p>a</p><p><br></p><p>b</p>');
    expect(textToHtml('<b>')).toBe('&lt;b&gt;');
  });

  it('draws rule lines and grids as SVG tiles', () => {
    expect(decodeURIComponent(ruleImage('college'))).toContain("height='24'");
    expect(decodeURIComponent(ruleImage('grid-small'))).toContain("width='13'");
  });

  it('builds tag spans that are not editable', () => {
    const span = tagSpan('todo');
    expect(span.contentEditable).toBe('false');
    expect(span.dataset.done).toBe('false');
  });
});

describe('auto links', () => {
  it('links a typed web address when a space follows', async () => {
    const { PageEditor } = await import('../src/editor/page-editor.js');
    document.body.innerHTML = '<div id="host"></div>';
    const store = { assetUrl: async () => null, pageChanged() {}, findPage: () => null };
    const ed = new PageEditor({ store, host: document.getElementById('host') });
    await ed.open({ id: 'p', title: '', created: new Date().toISOString(), outlines: [{ id: 'o', x: 0, y: 0, w: null, html: '<p>see www.example.com </p>' }], ink: [] });
    const p = ed.outlinesEl.querySelector('p');
    caretIn(p.firstChild, p.firstChild.length);
    ed.autoLink();
    const a = p.querySelector('a');
    expect(a.getAttribute('href')).toBe('https://www.example.com');
    expect(a.textContent).toBe('www.example.com');
    ed.destroy();
  });
});

describe('ribbon key hints', () => {
  it('gives every label a unique key that is never a prefix of another', async () => {
    const { assignKeys } = await import('../src/ui/keytips.js');
    const keys = assignKeys(['Paste', 'Cut', 'Copy', 'Format Painter', 'Bold', 'Bullets', 'Bold', 'Italic']);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe('P');
    for (const a of keys) for (const b of keys) if (a !== b) expect(b.startsWith(a)).toBe(false);
  });
});

describe('shortcut matching', () => {
  it('matches Ctrl+ specs off Apple platforms', async () => {
    const { matchShortcut } = await import('../src/lib/platform.js');
    expect(matchShortcut(new KeyboardEvent('keydown', { key: 'PageDown', code: 'PageDown', ctrlKey: true }), 'Ctrl+PageDown')).toBe(true);
    expect(matchShortcut(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true }), 'Mod+Alt+N')).toBe(true);
    expect(matchShortcut(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true }), 'Mod+Alt+N')).toBe(false);
  });
});

describe('page editor setup', () => {
  it('makes Enter create <p> paragraphs, not <div>s', () => {
    const calls = [];
    const original = document.execCommand;
    document.execCommand = (...args) => {
      calls.push(args);
      return true;
    };
    try {
      const host = document.createElement('div');
      document.body.append(host);
      const ed = new PageEditor({ store: {}, host });
      ed.destroy();
    } finally {
      document.execCommand = original;
    }
    expect(calls).toContainEqual(['defaultParagraphSeparator', false, 'p']);
  });
});

describe('page editor keys', () => {
  it('leaves keys to an input method while it is composing', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const ed = new PageEditor({ store: { pageChanged() {}, assetUrl: async () => null }, host });
    await ed.open({ id: 'p', title: '', created: new Date().toISOString(), outlines: [{ id: 'o1', x: 40, y: 140, w: null, html: '<p>にほん</p>' }], ink: [] });
    const bodyEl = host.querySelector('.outline-body');
    bodyEl.focus();
    caretIn(bodyEl.querySelector('p').firstChild, 3);
    const key = (init) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      bodyEl.dispatchEvent(e);
      return e;
    };
    // Escape cancels the IME candidate; it must not leave the note.
    expect(key({ key: 'Escape', isComposing: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(bodyEl);
    expect(ed.selectedOutlines.size).toBe(0);
    expect(key({ key: 'Tab', isComposing: true }).defaultPrevented).toBe(false);
    expect(bodyEl.innerHTML).toBe('<p>にほん</p>');
    // Outside composition Escape still selects the container.
    key({ key: 'Escape' });
    expect(ed.selectedOutlines.size).toBe(1);
    ed.destroy();
    host.remove();
  });
});
