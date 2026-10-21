import { blocksInRange, blockOf, currentRange, editableRoot, selectRange } from './selection.js';

/*
 * Text formatting on the current selection. Inline formatting goes through
 * the browser's editing commands so it joins the native undo/typing flow;
 * block-level work (styles, indents, tags) edits the DOM directly.
 */

export const DEFAULT_FONT = 'Default';
export const DEFAULT_SIZE = 11;

export const FONTS = [
  { label: 'Default', value: '' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Tahoma', value: 'Tahoma, Verdana, sans-serif' },
  { label: 'Trebuchet MS', value: "'Trebuchet MS', sans-serif" },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: "'Times New Roman', Times, serif" },
  { label: 'Garamond', value: 'Garamond, Georgia, serif' },
  { label: 'Courier New', value: "'Courier New', Courier, monospace" },
  { label: 'Monospace', value: 'ui-monospace, Menlo, Consolas, monospace' },
];

export const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96];

export const STYLES = [
  { id: 'h1', label: 'Heading 1', tag: 'H1', key: 'Mod+Alt+1' },
  { id: 'h2', label: 'Heading 2', tag: 'H2', key: 'Mod+Alt+2' },
  { id: 'h3', label: 'Heading 3', tag: 'H3', key: 'Mod+Alt+3' },
  { id: 'h4', label: 'Heading 4', tag: 'H4', key: 'Mod+Alt+4' },
  { id: 'h5', label: 'Heading 5', tag: 'H5', key: 'Mod+Alt+5' },
  { id: 'h6', label: 'Heading 6', tag: 'H6', key: 'Mod+Alt+6' },
  { id: 'title', label: 'Page Title', tag: 'P', cls: 'nt-pagetitle' },
  { id: 'cite', label: 'Citation', tag: 'P', cls: 'nt-cite' },
  { id: 'quote', label: 'Quote', tag: 'BLOCKQUOTE' },
  { id: 'code', label: 'Code', tag: 'PRE' },
  { id: 'normal', label: 'Normal', tag: 'P', key: 'Mod+Alt+0' },
];

const STYLE_CLASSES = STYLES.filter((s) => s.cls).map((s) => s.cls);

function exec(cmd, value = null) {
  try {
    return document.execCommand(cmd, false, value);
  } catch {
    return false;
  }
}

function withCss(on, fn) {
  exec('styleWithCSS', on);
  try {
    return fn();
  } finally {
    exec('styleWithCSS', true);
  }
}

export function toggleInline(cmd) {
  // 'strikeThrough', 'bold', 'italic', 'underline', 'subscript', 'superscript'
  if (cmd === 'subscript' && queryCommand('superscript')) exec('superscript');
  if (cmd === 'superscript' && queryCommand('subscript')) exec('subscript');
  withCss(false, () => exec(cmd));
}

export function queryCommand(cmd) {
  try {
    return document.queryCommandState(cmd);
  } catch {
    return false;
  }
}

/** Wraps the selection in spans carrying one style property. */
function applySpanStyle(prop, value) {
  const range = currentRange();
  if (!range) return;
  const root = editableRoot(range.commonAncestorContainer);
  if (!root) return;
  // The browser splits and wraps the selection for us via a sentinel font.
  withCss(false, () => exec('fontName', '__nt_sentinel__'));
  const spans = [];
  for (const font of root.querySelectorAll('font[face="__nt_sentinel__"]')) {
    const span = document.createElement('span');
    if (value) span.style.setProperty(prop, value);
    // Inner spans setting the same property would win; clear them.
    for (const inner of font.querySelectorAll('span')) {
      inner.style.removeProperty(prop);
      if (!inner.getAttribute('style')) inner.removeAttribute('style');
    }
    while (font.firstChild) span.append(font.firstChild);
    font.replaceWith(span);
    spans.push(span);
  }
  for (const span of spans) if (!span.getAttribute('style')) unwrap(span);
  if (spans.length) {
    const r = document.createRange();
    const first = spans.find((s) => s.isConnected) || spans[0];
    const last = [...spans].reverse().find((s) => s.isConnected) || first;
    if (first?.isConnected && last?.isConnected) {
      r.setStartBefore(first);
      r.setEndAfter(last);
      selectRange(r);
    }
  }
  root.dispatchEvent(new Event('input', { bubbles: true }));
}

function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  el.remove();
}

export function setFontName(value) {
  applySpanStyle('font-family', value);
}

export function setFontSize(pt) {
  applySpanStyle('font-size', pt ? `${pt}pt` : '');
}

export function stepFontSize(direction) {
  const current = queryFormat().fontSize || DEFAULT_SIZE;
  const next = direction > 0 ? SIZES.find((s) => s > current) : [...SIZES].reverse().find((s) => s < current);
  if (next) setFontSize(next);
}

export function setColor(color) {
  if (!color) applySpanStyle('color', '');
  else withCss(true, () => exec('foreColor', color));
}

export function setHighlight(color) {
  if (!color) applySpanStyle('background-color', '');
  else withCss(true, () => exec('hiliteColor', color));
}

export function clearFormatting() {
  const range = currentRange();
  const root = range && editableRoot(range.commonAncestorContainer);
  exec('removeFormat');
  exec('unlink');
  if (root?.classList.contains('outline-body')) setBlockStyle('normal');
}

/** Applies a paragraph style (heading, quote, code, normal...). */
export function setBlockStyle(id) {
  const style = STYLES.find((s) => s.id === id);
  const range = currentRange();
  const root = range && editableRoot(range.commonAncestorContainer);
  if (!style || !root || !root.classList.contains('outline-body')) return;
  const blocks = blocksInRange(range, root);
  const saved = range.cloneRange();
  for (const block of blocks) {
    if (block.tagName === 'TD' || block.tagName === 'TH') continue;
    let target = block;
    if (block.tagName === 'LI') {
      // In a list item, style the item's own text block.
      if (style.tag === 'P' && !style.cls) {
        block.classList.remove(...STYLE_CLASSES);
        continue;
      }
      target = wrapLiContent(block);
    }
    const replaced = retag(target, style.tag);
    replaced.classList.remove(...STYLE_CLASSES);
    if (style.cls) replaced.classList.add(style.cls);
    if (!replaced.getAttribute('class')) replaced.removeAttribute('class');
    if (replaced.parentElement?.tagName === 'LI' && style.tag === 'P' && !style.cls) unwrap(replaced);
  }
  try {
    selectRange(saved);
  } catch {
    /* range nodes may have moved */
  }
  root.dispatchEvent(new Event('input', { bubbles: true }));
}

function wrapLiContent(li) {
  const first = li.firstElementChild;
  if (first && ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE'].includes(first.tagName)) return first;
  const p = document.createElement('p');
  while (li.firstChild && !['UL', 'OL'].includes(li.firstChild.nodeName)) p.append(li.firstChild);
  li.prepend(p);
  return p;
}

/** Changes an element's tag, keeping attributes and children. */
export function retag(el, tag) {
  if (el.tagName === tag) return el;
  const next = document.createElement(tag);
  for (const a of el.attributes) next.setAttribute(a.name, a.value);
  while (el.firstChild) next.append(el.firstChild);
  el.replaceWith(next);
  return next;
}

export function toggleList(ordered) {
  exec(ordered ? 'insertOrderedList' : 'insertUnorderedList');
}

/** Sets list-style-type on the lists around the selection. */
export function setListStyle(type, ordered) {
  const range = currentRange();
  const root = range && editableRoot(range.commonAncestorContainer);
  if (!root) return;
  let lists = new Set(blocksInRange(range, root).map((b) => b.closest('ul, ol')).filter(Boolean));
  if (!lists.size || [...lists].some((l) => (l.tagName === 'OL') !== ordered)) {
    toggleList(ordered);
    const r = currentRange();
    lists = new Set(blocksInRange(r, root).map((b) => b.closest('ul, ol')).filter(Boolean));
  }
  for (const l of lists) l.style.listStyleType = type;
  root.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Indent: nests list items; shifts other paragraphs right. */
export function indent(direction = 1) {
  const range = currentRange();
  const root = range && editableRoot(range.commonAncestorContainer);
  if (!root || !root.classList.contains('outline-body')) return;
  const blocks = blocksInRange(range, root);
  if (blocks.some((b) => b.closest('li'))) {
    exec(direction > 0 ? 'indent' : 'outdent');
    // Chrome may add a stray margin style to the nested list.
    for (const l of root.querySelectorAll('ul[style*="margin"], ol[style*="margin"]')) l.style.removeProperty('margin-left');
    return;
  }
  for (const b of blocks) {
    const current = parseFloat(b.style.marginLeft) || 0;
    const next = Math.max(0, current + direction * 30);
    if (next) b.style.marginLeft = `${next}px`;
    else b.style.removeProperty('margin-left');
    if (!b.getAttribute('style')) b.removeAttribute('style');
  }
  root.dispatchEvent(new Event('input', { bubbles: true }));
}

export function align(where) {
  exec({ left: 'justifyLeft', center: 'justifyCenter', right: 'justifyRight' }[where]);
}

export function insertText(text) {
  exec('insertText', text);
}

export function insertHtml(html) {
  exec('insertHTML', html);
}

/**
 * Inserts an element at the caret and puts the caret after it. Used for
 * non-editable embeds, which the browser's insertHTML drops while empty.
 */
export function insertNode(node, { spaceAfter = true } = {}) {
  const range = currentRange();
  const root = range && editableRoot(range.commonAncestorContainer);
  if (!root) return false;
  range.deleteContents();
  // A caret between the body's blocks (a new container's caret sits after
  // its empty paragraph) goes into the neighboring paragraph, so the embed
  // doesn't end up outside any block.
  if (range.collapsed && range.startContainer === root) {
    const before = root.childNodes[range.startOffset - 1];
    const block = before || root.childNodes[range.startOffset];
    if (block?.nodeType === 1 && /^(P|H[1-6]|BLOCKQUOTE|PRE)$/.test(block.nodeName)) {
      if (block.childNodes.length === 1 && block.firstChild.nodeName === 'BR') block.replaceChildren();
      range.selectNodeContents(block);
      range.collapse(!before);
    }
  }
  range.insertNode(node);
  const after = document.createTextNode(spaceAfter ? '\u00a0' : '');
  node.after(after);
  const r = document.createRange();
  r.setStart(after, after.length);
  r.collapse(true);
  selectRange(r);
  root.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** Moves the blocks around the caret up or down one block. */
export function moveBlock(direction) {
  const range = currentRange();
  const root = range && editableRoot(range.commonAncestorContainer);
  if (!root || !root.classList.contains('outline-body')) return false;
  const blocks = blocksInRange(range, root);
  if (!blocks.length) return false;
  const top = (b) => (b.tagName !== 'LI' && b.parentElement?.tagName === 'LI' ? b.parentElement : b);
  const first = top(blocks[0]);
  const last = top(blocks[blocks.length - 1]);
  const saved = range.cloneRange();
  if (direction < 0) {
    const prev = first.previousElementSibling;
    if (!prev) return false;
    last.after(prev);
  } else {
    const next = last.nextElementSibling;
    if (!next) return false;
    first.before(next);
  }
  selectRange(saved);
  root.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** The formatting state at the caret, for the ribbon. */
export function queryFormat() {
  const range = currentRange();
  const root = range && editableRoot(range.commonAncestorContainer);
  if (!root) return { editable: false };
  const anchor = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const cs = getComputedStyle(anchor);
  const block = blockOf(range.startContainer, root);
  const px = parseFloat(cs.fontSize) || 14.667;
  const pt = Math.round(px * 0.75 * 2) / 2;
  let fontName = '';
  for (let n = anchor; n && n !== root; n = n.parentElement) {
    if (n.style?.fontFamily) {
      fontName = n.style.fontFamily;
      break;
    }
  }
  const font = FONTS.find((f) => f.value && normFont(f.value) === normFont(fontName));
  const styleId = (() => {
    if (!block) return 'normal';
    const cls = STYLES.find((s) => s.cls && block.classList.contains(s.cls));
    if (cls) return cls.id;
    const tagged = STYLES.find((s) => !s.cls && s.tag === block.tagName && s.id !== 'normal');
    if (tagged) return tagged.id;
    const q = block.closest('blockquote');
    if (q && root.contains(q)) return 'quote';
    return 'normal';
  })();
  const list = block?.closest('ul, ol');
  return {
    editable: true,
    inBody: root.classList.contains('outline-body'),
    collapsed: range.collapsed,
    bold: queryCommand('bold'),
    italic: queryCommand('italic'),
    underline: queryCommand('underline'),
    strike: queryCommand('strikeThrough'),
    subscript: queryCommand('subscript'),
    superscript: queryCommand('superscript'),
    fontName: font ? font.label : fontName ? fontName.split(',')[0].replace(/['"]/g, '') : DEFAULT_FONT,
    fontSize: pt,
    styleId,
    bullets: list?.tagName === 'UL' && root.contains(list),
    numbering: list?.tagName === 'OL' && root.contains(list),
    align: block ? getComputedStyle(block).textAlign : 'left',
    inTable: Boolean(block?.closest('table') && root.contains(block.closest('table'))),
    block,
    root,
  };
}

function normFont(s) {
  return String(s || '').replace(/['"\s]/g, '').toLowerCase();
}
