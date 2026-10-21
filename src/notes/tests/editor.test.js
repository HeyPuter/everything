import { describe, it, expect, beforeEach } from 'vitest';
import { ensureBlocks, fixNesting, blocksInRange, blockOf, rangeFromOffsets, textOffset, isEmptyBody, selectRange } from '../src/editor/selection.js';
import { toggleTag, removeAllTags, activeTags, tagSpan } from '../src/editor/tag-edit.js';
import { serialize, hydrate, fileSpan, formatBytes } from '../src/editor/embeds.js';
import { tableHtml, insertRow, insertColumn, deleteRow, deleteColumn, moveCell, sortTable, tableToText, toggleHeaderRow, hasHeaderRow } from '../src/editor/table.js';
import { setBlockStyle, indent, retag, moveBlock, insertNode, dropRedundantStyles, ownStyleRuns, toggleInline, clearFormatting, setColor, setHighlight } from '../src/editor/format.js';
import { textToHtml, ruleImage, PageEditor, cleanPastedHtml, freezesStyles } from '../src/editor/page-editor.js';

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

  it('keeps the formatting a join or drag-move carries over from the moved text', () => {
    document.head.innerHTML = '<style>.outline-body{font-size:11pt;color:rgb(27, 27, 27)} .outline-body h1{font-size:16pt;color:rgb(30, 78, 140)}</style>';
    // Before: a heading line with the user's 11pt words, and a paragraph.
    const before = body('<h1>two <span style="font-size: 11pt;">tiny</span></h1><p>para <span style="color: rgb(27, 27, 27);">x</span></p>');
    const own = ownStyleRuns([...before.children]);
    expect(own.map((r) => [r.prop, r.text])).toEqual([['font-size', 'tiny'], ['color', 'x']]);
    // After Chrome's join: its frozen spans, and the user's span rebuilt.
    const el = body('<h1>Big<span style="font-size: 16pt; background-color: transparent;">two </span><span style="background-color: transparent; font-size: 11pt;">tiny</span>'
      + '<span style="color: rgb(27, 27, 27); font-size: 11pt; background-color: transparent;">para </span></h1>');
    dropRedundantStyles([...el.querySelectorAll('span')], { own });
    expect(el.innerHTML).toBe('<h1>Bigtwo <span style="font-size: 11pt;">tiny</span>para </h1>');
    // Without the notes taken before the edit (a paste), all of it is cleaned.
    const pasted = body('<h1>Big<span style="font-size: 11pt;">tiny</span></h1>');
    dropRedundantStyles([...pasted.querySelectorAll('span')]);
    expect(pasted.innerHTML).toBe('<h1>Bigtiny</h1>');
    document.head.innerHTML = '';
  });

  it('notes the formatting in the paragraphs a join or drag-move touches, not on plain deletes', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const ed = new PageEditor({ store: { pageChanged() {}, assetUrl: async () => null }, host });
    await ed.open({ id: 'p', title: '', created: new Date().toISOString(), outlines: [{ id: 'o1', x: 40, y: 140, w: null, html: '<h1>Big</h1><h1>two <span style="font-size: 11pt;">tiny</span></h1>' }], ink: [] });
    const [h1, h2] = host.querySelectorAll('.outline-body h1');
    const before = (inputType, range) => {
      const e = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType });
      e.getTargetRanges = () => [range];
      h1.dispatchEvent(e);
    };
    // Backspace at the start of the second heading joins it to the first.
    before('deleteContentBackward', { startContainer: h1.firstChild, startOffset: 3, endContainer: h2.firstChild, endOffset: 0 });
    expect(ed.ownStyles.runs.map((r) => r.text)).toEqual(['tiny']);
    // A Backspace inside one line notes nothing, and an edit clears the notes.
    before('deleteContentBackward', { startContainer: h2.firstChild, startOffset: 1, endContainer: h2.firstChild, endOffset: 2 });
    expect(ed.ownStyles).toBe(null);
    before('deleteByDrag', { startContainer: h2.querySelector('span').firstChild, startOffset: 0, endContainer: h2.querySelector('span').firstChild, endOffset: 4 });
    expect(ed.ownStyles.drag).toBe(true);
    h2.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteByDrag' }));
    // The drop after a drag-move keeps the notes from its delete.
    before('insertFromDrop', { startContainer: h1.firstChild, startOffset: 1, endContainer: h1.firstChild, endOffset: 1 });
    expect(ed.ownStyles.runs.map((r) => r.text)).toEqual(['tiny']);
    h1.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromDrop' }));
    expect(ed.ownStyles).toBe(null);
    ed.destroy();
    host.remove();
  });

  it("leaves the formatting the user applies to Chrome's frozen-style cleanup alone", () => {
    // A pasted or joined span is cleaned; Enter splitting a formatted span
    // and a color just picked (Format Painter's body color on a heading) are not.
    expect(freezesStyles({ isTrusted: true, inputType: '' })).toBe(true);
    expect(freezesStyles({ isTrusted: true, inputType: 'deleteContentBackward' })).toBe(true);
    expect(freezesStyles({ isTrusted: false, inputType: '' })).toBe(false);
    expect(freezesStyles({ isTrusted: true, inputType: 'insertParagraph' })).toBe(false);
    expect(freezesStyles({ isTrusted: true, inputType: 'insertLineBreak' })).toBe(false);
    const original = document.execCommand;
    const seen = [];
    document.execCommand = (cmd) => {
      if (cmd === 'foreColor' || cmd === 'hiliteColor') seen.push(freezesStyles({ isTrusted: true, inputType: '' }));
      return true;
    };
    try {
      setColor('rgb(27, 27, 27)');
      setHighlight('#ffff00');
    } finally {
      document.execCommand = original;
    }
    expect(seen).toEqual([false, false]);
    expect(freezesStyles({ isTrusted: true, inputType: '' })).toBe(true);
  });

  it('starts inline formatting after a tag at the start of the selection', () => {
    const el = body('<p><span class="nt-tag" data-tag="todo" contenteditable="false"></span>Buy milk</p>');
    const p = el.firstChild;
    const seen = [];
    const original = document.execCommand;
    document.execCommand = (cmd) => {
      const r = document.getSelection().getRangeAt(0);
      seen.push([cmd, r.startContainer, r.startOffset, r.toString()]);
      return true;
    };
    try {
      document.getSelection().setBaseAndExtent(p, 0, p.lastChild, 8);
      toggleInline('bold');
      document.getSelection().setBaseAndExtent(el, 0, el, 1);
      clearFormatting();
    } finally {
      document.execCommand = original;
    }
    const bold = seen.find((c) => c[0] === 'bold');
    expect(bold.slice(1)).toEqual([p, 1, 'Buy milk']);
    const clear = seen.find((c) => c[0] === 'removeFormat');
    expect(clear.slice(1, 3)).toEqual([p, 1]);
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

describe('blocksInRange', () => {
  // The straightforward definition, with Range.intersectsNode (slow in Chrome).
  function reference(range, root) {
    const found = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === 1 && node.tagName !== 'BR' && node.tagName !== 'IMG' && !node.classList.contains('nt-tag')) return NodeFilter.FILTER_SKIP;
        return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3 && !n.nodeValue.length) continue;
      if (n === range.endContainer && range.endOffset === 0 && n.nodeType === 3) continue;
      const b = blockOf(n, root);
      if (b) found.add(b);
    }
    if (!found.size) {
      const b = blockOf(range.startContainer, root);
      if (b) found.add(b);
    }
    return [...found].filter((b) => ![...found].some((o) => o !== b && b.contains(o)));
  }

  it('matches the intersectsNode definition for every pair of boundary points', () => {
    const el = body('<p>ab<b>cd</b></p><ul><li><p>one</p><ul><li>two<br>x</li></ul></li><li>three</li></ul>'
      + '<p><span class="nt-tag" data-tag="todo"></span>tag</p><table><tbody><tr><td>c1</td><td><img>c2</td></tr></tbody></table><p><br></p><h2>end</h2>');
    const points = [];
    (function collect(n) {
      const len = n.nodeType === 3 ? n.nodeValue.length : n.childNodes.length;
      for (let i = 0; i <= len; i++) points.push([n, i]);
      if (n.nodeType === 1) for (const c of n.childNodes) collect(c);
    })(el);
    let checked = 0;
    for (let i = 0; i < points.length; i += 3) {
      for (let j = 0; j < points.length; j += 2) {
        const r = document.createRange();
        try {
          r.setStart(...points[i]);
          r.setEnd(...points[j]);
        } catch {
          continue;
        }
        if (r.collapsed) continue;
        expect(blocksInRange(r, el)).toEqual(reference(r, el));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('stays fast when a long page is selected', () => {
    const el = body('<p>x <b>y</b></p>'.repeat(4000));
    const r = document.createRange();
    r.selectNodeContents(el);
    const t0 = performance.now();
    expect(blocksInRange(r, el)).toHaveLength(4000);
    // The intersectsNode walk took about 4 s here.
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('pasted HTML', () => {
  const item = (level, marker, text, font = 'Symbol') => `<p class=MsoListParagraphCxSpMiddle style='margin-left:${level * 0.5}in;text-indent:-.25in;mso-list:l0 level${level} lfo1'><![if !supportLists]><span style='font-family:${font}'><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>${text}<o:p></o:p></p>\n`;

  it("rebuilds Word's list paragraphs as nested lists", () => {
    const html = '<html><body><!--StartFragment--><p class=MsoNormal>Intro<o:p></o:p></p>\n'
      + item(1, '·', 'One') + item(2, 'o', 'One A', 'Courier New') + item(1, '·', 'Two')
      + '<p class=MsoNormal>Between<o:p></o:p></p>\n'
      + item(1, '1.', 'First', 'Calibri') + item(2, 'a.', 'Sub', 'Calibri') + item(1, '2.', 'Second', 'Calibri')
      + '<!--EndFragment--></body></html>';
    expect(cleanPastedHtml(html)).toBe('<p>Intro</p><ul><li>One<ul><li>One A</li></ul></li><li>Two</li></ul><p>Between</p>'
      + '<ol><li><span style="font-family: Calibri">First</span><ol><li><span style="font-family: Calibri">Sub</span></li></ol></li><li><span style="font-family: Calibri">Second</span></li></ol>'.replace(/<span style="font-family: Calibri">([^<]*)<\/span>/g, '$1'));
  });

  it('keeps the item text when Word wraps the marker and the text together', () => {
    const html = "<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'><b><![if !supportLists]><span style='mso-list:Ignore'>1.<span>&nbsp; </span></span><![endif]>Bold item</b></p>";
    expect(cleanPastedHtml(html)).toBe('<ol><li><b>Bold item</b></li></ol>');
  });

  it('drops line breaks between blocks but keeps spaces between words', () => {
    expect(cleanPastedHtml('<p>a</p>\n  <p>b</p>\n<ul>\n <li>c</li>\n</ul>')).toBe('<p>a</p><p>b</p><ul><li>c</li></ul>');
    expect(cleanPastedHtml('<b>bold</b> <i>it</i> ')).toBe('<b>bold</b> <i>it</i> ');
  });

  it('is still sanitized', () => {
    expect(cleanPastedHtml('<p onclick="x()">a<img src=x onerror=alert(1)><script>alert(1)</script></p>')).toBe('<p>a<img></p>');
  });
});

describe('note containers', () => {
  it('does not pin the width when the resize edge is only clicked', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const ed = new PageEditor({ store: { pageChanged() {}, assetUrl: async () => null }, host });
    await ed.open({ id: 'p', title: '', created: new Date().toISOString(), outlines: [{ id: 'o1', x: 40, y: 140, w: null, html: '<p>short</p>' }], ink: [] });
    const steps = ed.history.stack.length;
    const edge = host.querySelector('.outline-resize');
    edge.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 150 }));
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 100, clientY: 150 }));
    expect(ed.page.outlines[0].w).toBeNull();
    expect(ed.history.stack.length).toBe(steps);
    // A real drag still sets the width.
    edge.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 150 }));
    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 150 }));
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 300, clientY: 150 }));
    expect(host.querySelector('.outline').style.width).toBe('200px');
    expect(host.querySelector('.outline').classList.contains('auto-width')).toBe(false);
    ed.destroy();
    host.remove();
  });
});

describe('ribbon round trips', () => {
  it('remembers the selection a font command just made, not an older saved one', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const ed = new PageEditor({ store: { pageChanged() {}, assetUrl: async () => null }, host });
    await ed.open({ id: 'p', title: '', created: new Date().toISOString(), outlines: [{ id: 'o1', x: 40, y: 140, w: null, html: '<p>one two three</p>' }], ink: [] });
    const text = host.querySelector('.outline-body p').firstChild;
    // The saved caret collapsed when a font command moved the text into a span.
    const stale = document.createRange();
    stale.setStart(text, 0);
    ed.lastRange = stale;
    const now = document.createRange();
    now.setStart(text, 10);
    now.setEnd(text, 13);
    selectRange(now);
    ed.rememberRange();
    expect(ed.restoreRange()).toBe(true);
    expect(document.getSelection().toString()).toBe('ree');
    ed.destroy();
    host.remove();
  });
});

describe('copying and pasting embeds', () => {
  async function setup(html, store = {}) {
    const host = document.createElement('div');
    document.body.append(host);
    const saved = [];
    const st = {
      pageChanged() {},
      assetUrl: async () => null,
      findPage: () => ({ section: { id: 'sec1' } }),
      assetBlob: async (id) => (id.includes('gone') ? null : new Blob([`bytes of ${id}`])),
      saveAsset: async (blob, name, opts) => {
        saved.push({ text: await blob.text(), name, opts });
        return `new${saved.length}.${name.split('.').pop()}`;
      },
      ...store,
    };
    const ed = new PageEditor({ store: st, host });
    await ed.open({ id: 'p', title: '', created: new Date().toISOString(), outlines: [{ id: 'o1', x: 40, y: 140, w: null, html }], ink: [] });
    return { ed, host, saved, body: host.querySelector('.outline-body') };
  }

  // jsdom has no editing commands: insertHTML puts the fragment at the caret.
  function fakeInsertHtml(fn) {
    const original = document.execCommand;
    document.execCommand = (cmd, ui, value) => {
      if (cmd !== 'insertHTML') return false;
      const r = document.getSelection().getRangeAt(0);
      r.deleteContents();
      const frag = r.createContextualFragment(value);
      const last = frag.lastChild;
      r.insertNode(frag);
      if (last) {
        r.setStartAfter(last);
        r.collapse(true);
      }
      return true;
    };
    return Promise.resolve(fn()).finally(() => {
      document.execCommand = original;
    });
  }

  it('pastes equations and attachments working, with their own copy of the file', async () => {
    const { ed, body, saved, host } = await setup('<p>A </p>');
    caretIn(body.querySelector('p').firstChild, 2);
    const failed = [];
    ed.on('insert-failed', (e) => failed.push(e.file.name));
    await fakeInsertHtml(() => ed.pasteHtml('Eq <span class="nt-math" data-tex="x^2" contenteditable="false"></span> and <span class="nt-file" data-asset="a1.txt" data-name="n.txt" data-kind="file" contenteditable="false"></span> <span class="nt-file" data-asset="gone1.txt" data-name="lost.txt" data-kind="file" contenteditable="false"></span><img data-asset="a2.png" alt="pic">'));
    const p = body.querySelector('p');
    expect(p.querySelector('.nt-math').getAttribute('role')).toBe('img');
    const file = p.querySelector('.nt-file');
    expect(file.dataset.asset).toBe('new1.txt');
    expect(file.querySelector('.nt-file-name').textContent).toBe('n.txt');
    expect(p.querySelector('img').dataset.asset).toBe('new2.png');
    expect(saved.map((s) => [s.text, s.opts.sectionId])).toEqual([['bytes of a1.txt', 'sec1'], ['bytes of a2.png', 'sec1']]);
    // A file that can't be read (a locked section's) becomes its name.
    expect(p.textContent).toContain('[lost.txt]');
    expect(failed).toEqual(['lost.txt']);
    expect(ed.page.outlines[0].html).toContain('data-asset="new1.txt"');
    expect(ed.page.outlines[0].html).not.toContain('gone1');
    ed.destroy();
    host.remove();
  });

  it('copies attachments and equations in their stored form', async () => {
    const { ed, body, host } = await setup('<p>Eq <span class="nt-math" data-tex="x^2" contenteditable="false"></span> <span class="nt-file" data-asset="a1.txt" data-name="n.txt" data-kind="file" contenteditable="false"></span></p>');
    const r = document.createRange();
    r.selectNodeContents(body.querySelector('p'));
    selectRange(r);
    const data = {};
    const ev = new Event('copy', { bubbles: true, cancelable: true });
    ev.clipboardData = { setData: (t, v) => (data[t] = v) };
    body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(data['text/html']).toBe('Eq <span class="nt-math" data-tex="x^2" contenteditable="false"></span> <span class="nt-file" data-asset="a1.txt" data-name="n.txt" data-kind="file" contenteditable="false"></span>');
    expect(data['text/plain']).toBe('Eq x^2 n.txt');
    // Plain text keeps the browser's own copy.
    r.setEnd(body.querySelector('p').firstChild, 2);
    selectRange(r);
    const plain = new Event('copy', { bubbles: true, cancelable: true });
    plain.clipboardData = { setData() {} };
    body.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    ed.destroy();
    host.remove();
  });

  it('copies an equation from inside one cell or list item without the table or list', async () => {
    const { ed, body, host } = await setup('<table><tbody><tr><td>a <span class="nt-math" data-tex="x" contenteditable="false"></span> b</td><td>c</td></tr></tbody></table>'
      + '<ul><li>d <span class="nt-math" data-tex="y" contenteditable="false"></span> e</li><li>f</li></ul>');
    const copy = (node) => {
      const r = document.createRange();
      r.selectNodeContents(node);
      selectRange(r);
      const data = {};
      const ev = new Event('copy', { bubbles: true, cancelable: true });
      ev.clipboardData = { setData: (t, v) => (data[t] = v) };
      body.dispatchEvent(ev);
      return data['text/html'];
    };
    expect(copy(body.querySelector('td'))).toBe('a <span class="nt-math" data-tex="x" contenteditable="false"></span> b');
    expect(copy(body.querySelector('li'))).toBe('d <span class="nt-math" data-tex="y" contenteditable="false"></span> e');
    // Across cells or items, the table or list comes along.
    expect(copy(body.querySelector('tr'))).toMatch(/^<table><tbody><tr><td>a /);
    expect(copy(body.querySelector('ul'))).toMatch(/^<ul><li>d /);
    ed.destroy();
    host.remove();
  });
});

describe('editor bookkeeping', () => {
  it('does not pile up DOM records while the user only types', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const ed = new PageEditor({ store: { pageChanged() {}, assetUrl: async () => null }, host });
    await ed.open({ id: 'p', title: '', created: new Date().toISOString(), outlines: [{ id: 'o1', x: 40, y: 140, w: null, html: '<p>words</p>' }], ink: [] });
    const p = host.querySelector('.outline-body p');
    for (let i = 0; i < 50; i++) {
      // A link made as you type replaces a text node with an <a>.
      const a = document.createElement('a');
      a.textContent = `www.example${i}.com`;
      p.append(a, ' ');
      await Promise.resolve();
      p.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' ' }));
    }
    await Promise.resolve();
    expect(ed.addedRecords.length + ed.additions.takeRecords().length).toBeLessThan(3);
    ed.destroy();
    host.remove();
  });
});
