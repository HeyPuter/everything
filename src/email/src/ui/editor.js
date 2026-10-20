import { el } from './dom.js';
import { icon } from './icons.js';
import { attachMenu } from './menu.js';
// Only for the labels: bold and italic are the browser's own shortcuts in a
// contenteditable, not bindings this module makes, so the tooltip just has to
// name the right key.
import { MOD } from './shortcuts.js';
import {
  FONTS, SIZES, COLORS, cleanHtml, textToHtml, normalizeLink,
} from '../lib/richtext.js';

/**
 * The formatting editor in the compose dialog: a `contenteditable` region and
 * a toolbar over it.
 *
 * **Why execCommand.** It is deprecated, and it is also the only thing in the
 * platform that knows what "make the selection bold" means -- including the
 * hard parts: splitting the nodes a selection runs across, merging the marks
 * back together when it is undone, remembering a mark for the *next* thing
 * typed at a collapsed caret, and putting all of it on the browser's own undo
 * stack so ⌘Z still works. A hand-rolled range walker gets the easy case and
 * then quietly loses the caret, the undo history, or both. Every command here
 * is guarded, so where it is missing the editor degrades to a plain typing
 * surface rather than throwing.
 *
 * **Why the font commands are rewritten.** `fontName`, `fontSize` and
 * `foreColor` still emit `<font face size color>`, and `size` is the 1-7 scale
 * from 1995 rather than a length. So each of those runs and its `<font>` tags
 * are immediately turned into `<span style>` -- the vocabulary richtext.js
 * allows and the one every client's CSS actually reads.
 *
 * **Why the selection is saved.** Opening a menu moves focus to a menu item,
 * and a menu item is not in the editor, so by the time the item is chosen the
 * selection this is all about may be gone. The last range that was inside the
 * editor is kept and put back before any command runs.
 *
 * **Why paste is intercepted.** A paste can carry a whole page of markup from
 * anywhere, and it arrives by way of `innerHTML`. It goes through
 * `cleanHtml` first -- which is also what keeps a pasted newsletter from
 * arriving as three screens of table nesting.
 */


/**
 * Whether a computed colour is the one a swatch stands for. A computed style
 * comes back as `rgb(...)` whatever was written, so the swatch's hex is
 * converted rather than the other way round.
 */
const sameColor = (computed, hex) => {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match || !computed) return false;
  const value = parseInt(match[1], 16);
  const channels = [Math.floor(value / 65536) % 256, Math.floor(value / 256) % 256, value % 256];
  return computed.replace(/\s+/g, ' ').trim() === `rgb(${channels.join(', ')})`;
};

/**
 * createEditor({ label, placeholder, onInput, onFiles }) ->
 *   { root, body, getHtml, setHtml, focusStart, focusEnd }
 *
 * `onInput` fires whenever the content changes, from typing or from the
 * toolbar; the compose dialog uses it to autosave. `onFiles` receives files
 * pasted or dropped into the message -- there are no inline images here, so a
 * pasted screenshot becomes an attachment rather than nothing at all.
 */
export function createEditor({ label = 'Message', placeholder = '', onInput, onFiles } = {}) {
  const body = el('div.rte-body', {
    contenteditable: 'true',
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': label,
    // A contenteditable div is focusable but does not match the selector the
    // modal's focus trap uses, so Tab skipped straight past the message body.
    tabindex: '0',
    spellcheck: 'true',
  });
  if (placeholder) body.dataset.placeholder = placeholder;

  // -- the platform, at arm's length ------------------------------------------

  const exec = (command, value = null) => {
    try {
      return Boolean(document.execCommand?.(command, false, value));
    } catch {
      return false;
    }
  };

  const stateOf = (command) => {
    try {
      return Boolean(document.queryCommandState?.(command));
    } catch {
      return false;
    }
  };

  const valueOf = (command) => {
    try {
      return String(document.queryCommandValue?.(command) ?? '');
    } catch {
      return '';
    }
  };

  // -- the selection ----------------------------------------------------------

  let saved = null;

  const remember = () => {
    const selection = document.getSelection?.();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (body.contains(range.commonAncestorContainer)) saved = range.cloneRange();
  };

  const restore = () => {
    // Focusing fires the body's focus listener synchronously. Keep a separate
    // range so that listener cannot replace the intended selection with the
    // browser's temporary caret while returning from an input or menu.
    const target = saved?.cloneRange();
    body.focus({ preventScroll: true });
    // A remembered range whose nodes have since been replaced is worse than
    // none: putting it back would move the caret somewhere that no longer
    // exists. Leaving it out lets the browser keep whatever it has.
    if (!target || !body.contains(target.commonAncestorContainer)) return;
    const selection = document.getSelection?.();
    if (!selection) return;
    try {
      selection.removeAllRanges();
      selection.addRange(target);
      saved = target.cloneRange();
    } catch { /* a range the document no longer accepts */ }
  };

  /**
   * The selection, as character offsets into the body.
   *
   * A range points at nodes, and `normalizeFonts` below replaces the nodes
   * execCommand has just made -- moving the text out of a `<font>` and into a
   * `<span>`, which is a removal as far as the platform is concerned, and
   * collapses any live range inside it. Offsets survive that: the text is the
   * same text however it is wrapped.
   */
  const marks = () => {
    const selection = document.getSelection?.();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!body.contains(range.commonAncestorContainer)) return null;
    const upTo = (container, offset) => {
      const probe = document.createRange();
      probe.selectNodeContents(body);
      probe.setEnd(container, offset);
      return probe.toString().length;
    };
    try {
      return { start: upTo(range.startContainer, range.startOffset),
        end: upTo(range.endContainer, range.endOffset) };
    } catch {
      return null;
    }
  };

  /**
   * The text node holding the character at `target`, and where in it.
   *
   * `>` rather than `>=`: an offset that falls exactly on the boundary
   * between two runs of text belongs to the start of the second, not to the
   * end of the first. They are the same position, and only one of them is
   * *inside* whatever the command has just applied -- which is what the
   * toolbar reads to say what is in effect. Land on the wrong one and the
   * size menu answers Normal for a word that was just made Huge.
   */
  const pointAt = (target) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let count = 0;
    let last = null;
    let node = walker.nextNode();
    while (node) {
      if (count + node.data.length > target) return [node, target - count];
      count += node.data.length;
      last = node;
      node = walker.nextNode();
    }
    // Past the last character, which is where the end of a selection that
    // runs to the end of the message falls.
    return last ? [last, last.data.length] : [body, body.childNodes.length];
  };

  const selectMarks = (at) => {
    try {
      const range = document.createRange();
      range.setStart(...pointAt(at.start));
      range.setEnd(...pointAt(at.end));
      const selection = document.getSelection?.();
      selection?.removeAllRanges();
      selection?.addRange(range);
    } catch { /* the body no longer holds that much text */ }
  };

  const caretTo = (start, within = body) => {
    body.focus({ preventScroll: true });
    try {
      const range = document.createRange();
      range.selectNodeContents(within);
      range.collapse(start);
      const selection = document.getSelection?.();
      selection?.removeAllRanges();
      selection?.addRange(range);
      remember();
      // The caret has moved, so what the toolbar says is in effect is about
      // to be wrong. This is how a draft and a reply are entered: opening a
      // draft that ends in bold put the caret inside the bold, where the next
      // character typed would be bold too, under a Bold button reading off.
      refresh();
    } catch { /* no selection API worth using here */ }
  };

  // The element the caret is in, which is what the toolbar reads to show what
  // is already applied. Taken from the saved range rather than the live
  // selection, because the live one has moved to a menu item by then.
  const caretElement = () => {
    const node = saved?.startContainer;
    const element = node?.nodeType === 3 ? node.parentElement : node;
    return element && body.contains(element) ? element : null;
  };

  const caretStyle = () => {
    const element = caretElement();
    try {
      return element ? window.getComputedStyle(element) : null;
    } catch {
      return null;
    }
  };

  // -- commands ---------------------------------------------------------------

  // The placeholder is CSS on a class rather than an attribute the platform
  // honours, because a contenteditable has no placeholder of its own. A body
  // holding only the filler `<br>` a browser keeps an empty block alive with
  // is still empty, which is why this asks the text and not the markup.
  const markEmpty = () => body.classList.toggle('is-empty', !body.textContent.trim());

  const changed = () => {
    markEmpty();
    refresh();
    onInput?.();
  };

  /**
   * Every toolbar action runs through here: put the selection back, do the
   * work, take a fresh note of where the selection ended up, and tell the
   * dialog something changed. `styleWithCSS` is turned off first and never
   * left on, so Bold stays a `<b>` however the last command was applied.
   */
  const command = (apply) => {
    restore();
    exec('styleWithCSS', 'false');
    apply();
    // Measured before the rewrite and put back after it, because the rewrite
    // replaces the elements the command just made and takes the selection
    // with them. Without this, choosing a font *ended* the selection: a size
    // or a colour over the same words meant selecting them all over again,
    // and there are three of these menus.
    //
    // Only where there was a selection to keep. At a collapsed caret the
    // browser is holding a style for the next character typed, and putting a
    // fresh range back where that caret was is not the same position to the
    // platform -- so the caret is left exactly as the command left it.
    const at = marks();
    if (normalizeFonts() && at && at.end > at.start) selectMarks(at);
    remember();
    changed();
  };

  /**
   * The `<font>` tags execCommand made, as `<span style>` instead -- whenever
   * they turn up. A command over a selection makes them at once; one at a
   * collapsed caret makes them around the first character typed after it;
   * and Redo puts back the ones a command made. Left as `<font>`, which
   * cleanHtml does not keep, words coloured on screen went out plain.
   *
   * `size` is a step on a 1-7 scale rather than a length, so each size is
   * applied as the step of its place in SIZES and read back from it here --
   * at any time, Redo included, not only straight after the command.
   *
   * The text moves out of the `<font>` and into the `<span>`, which to the
   * platform is a removal that collapses a selection inside it: typing after
   * a colour put the caret back before the coloured words, so the next thing
   * typed landed in front of them. The text nodes themselves survive the
   * move, so a selection held in them is put back on the same nodes.
   */
  const normalizeFonts = () => {
    const fonts = [...body.querySelectorAll('font')];
    if (!fonts.length) return false;
    const selection = document.getSelection?.();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const held = range && body.contains(range.commonAncestorContainer)
      ? [range.startContainer, range.startOffset, range.endContainer, range.endOffset]
      : null;
    for (const font of fonts) {
      const span = document.createElement('span');
      const face = font.getAttribute('face');
      const color = font.getAttribute('color');
      const sized = SIZES[Number(font.getAttribute('size')) - 1]?.css;
      if (face) span.style.fontFamily = face;
      if (color) span.style.color = color;
      if (sized) span.style.fontSize = sized;

      if (span.getAttribute('style')) {
        span.append(...font.childNodes);
        font.replaceWith(span);
      } else {
        font.replaceWith(...font.childNodes);
      }
    }
    if (held && body.contains(held[0]) && body.contains(held[2])) {
      try {
        const kept = document.createRange();
        kept.setStart(held[0], held[1]);
        kept.setEnd(held[2], held[3]);
        selection.removeAllRanges();
        selection.addRange(kept);
      } catch { /* the nodes no longer hold those offsets */ }
    }
    // Whether anything was moved, which is what decides whether the selection
    // has to be put back.
    return true;
  };

  const setFont = (stack) => command(() => exec('fontName', stack));

  const setSize = (css) => command(() => {
    exec('fontSize', String(SIZES.findIndex((size) => size.css === css) + 1));
  });

  const setColor = (value) => command(() => exec('foreColor', value));

  const toggleQuote = () => command(() => {
    if (/blockquote/i.test(valueOf('formatBlock'))) exec('outdent');
    else exec('formatBlock', 'blockquote');
  });

  // -- the toolbar ------------------------------------------------------------

  const toggles = [];

  const toggle = (name, iconName, title, key) => {
    const button = el('button.rte-btn', {
      type: 'button',
      title: key ? `${title} (${key})` : title,
      'aria-label': title,
      'aria-pressed': 'false',
      html: icon(iconName, 17),
      // Keeps focus -- and with it the selection -- in the message while the
      // button is pressed. Without it the first click just moves focus and the
      // command lands on an empty selection.
      onmousedown: (event) => event.preventDefault(),
      onclick: () => command(() => exec(name)),
    });
    toggles.push([button, name]);
    return button;
  };

  const menuButton = (iconName, title, buildItems) => {
    const button = el('button.rte-btn', {
      type: 'button', title, 'aria-label': title, html: icon(iconName, 17),
    });
    const anchor = el('span.rte-anchor.menu-anchor', {}, button);
    attachMenu(button, buildItems, { align: 'start' });
    return anchor;
  };

  // A font stack, as loosely as two of them can be compared: the browser
  // rewrites the quoting and spacing of whatever it was given.
  const sameStack = (a, b) =>
    a.replace(/["'\s]/g, '').toLowerCase() === b.replace(/["'\s]/g, '').toLowerCase();

  const fontMenu = menuButton('font', 'Font', () => {
    const current = caretStyle()?.fontFamily ?? '';
    return FONTS.map((font) => ({
      // The name of a font, set in it: the only description of a typeface
      // that does not need words.
      label: el('span', { style: { fontFamily: font.stack } }, font.label),
      checked: Boolean(current) && sameStack(current, font.stack),
      onSelect: () => setFont(font.stack),
    }));
  });

  const sizeMenu = menuButton('textSize', 'Size', () => {
    const current = caretStyle()?.fontSize ?? '';
    return SIZES.map((size) => ({
      label: el('span', { style: { fontSize: size.css } }, size.label),
      checked: current === size.css,
      onSelect: () => setSize(size.css),
    }));
  });

  const colorMenu = menuButton('textColor', 'Text colour', () => {
    const current = caretStyle()?.color ?? '';
    return COLORS.map((color) => ({
      label: el('span.rte-swatch-label', {},
        el('span.rte-swatch', { style: { background: color.value }, 'aria-hidden': 'true' }),
        color.label),
      checked: sameColor(current, color.value),
      onSelect: () => setColor(color.value),
    }));
  });

  const highlightMenu = menuButton('highlight', 'Highlight colour', () => [
    ...[{ label: 'Yellow', value: '#fff2a8' }, { label: 'Green', value: '#c8efcf' },
      { label: 'Blue', value: '#cde6ff' }, { label: 'Pink', value: '#f8d6e6' },
      { label: 'None', value: 'transparent' }].map((color) => ({
      label: color.label,
      onSelect: () => command(() => exec('hiliteColor', color.value)),
    })),
  ]);
  const alignmentMenu = menuButton('align', 'Text alignment', () => [
    ['Left', 'justifyLeft'], ['Centre', 'justifyCenter'], ['Right', 'justifyRight'], ['Justify', 'justifyFull'],
  ].map(([label, name]) => ({ label, checked: stateOf(name), onSelect: () => command(() => exec(name)) })));

  let originalLinkLabel = '';
  let editingLink = null;
  const linkLabel = el('input', { type: 'text', 'aria-label': 'Link text' });
  const linkUrl = el('input', { type: 'text', 'aria-label': 'Link URL', placeholder: 'https://example.com', autocomplete: 'off' });
  const linkError = el('span.rte-link-error', { role: 'status' });
  const closeLink = () => { linkPanel.hidden = true; restore(); };
  const applyLink = () => {
    const href = normalizeLink(linkUrl.value);
    if (!href) {
      linkError.textContent = 'Enter a valid web address or email address.';
      linkUrl.setAttribute('aria-invalid', 'true');
      linkUrl.focus();
      return;
    }
    command(() => {
      if (linkLabel.value === originalLinkLabel && originalLinkLabel) exec('createLink', href);
      else {
        const anchor = el('a', { href }, linkLabel.value || href);
        exec('insertHTML', anchor.outerHTML);
      }
    });
    closeLink();
  };
  const removeLink = el('button.btn', { type: 'button', onclick: () => {
    command(() => exec('unlink'));
    closeLink();
  } }, 'Remove link');
  const linkPanel = el('div.rte-link-panel', {
    role: 'group', 'aria-label': 'Edit link', hidden: true,
    onkeydown: (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' || event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') closeLink();
        else applyLink();
      }
    },
  }, el('label', {}, 'Text', linkLabel), el('label', {}, 'Link', linkUrl), linkError,
  el('div.rte-link-actions', {},
    el('button.btn', { type: 'button', onclick: applyLink }, 'Apply link'), removeLink,
    el('button.btn', { type: 'button', onclick: closeLink }, 'Cancel')));
  const openLink = () => {
    remember();
    editingLink = caretElement()?.closest('a') ?? null;
    if (editingLink && body.contains(editingLink)) {
      const range = document.createRange();
      range.selectNodeContents(editingLink);
      saved = range;
    }
    originalLinkLabel = saved?.toString() || '';
    linkLabel.value = originalLinkLabel;
    linkUrl.value = editingLink?.getAttribute('href') || '';
    removeLink.hidden = !editingLink;
    linkError.textContent = '';
    linkUrl.removeAttribute('aria-invalid');
    linkPanel.hidden = false;
    linkUrl.focus();
  };

  const toolbar = el('div.rte-toolbar', { role: 'toolbar', 'aria-label': 'Formatting' },
    fontMenu,
    sizeMenu,
    el('span.rte-sep', { 'aria-hidden': 'true' }),
    toggle('bold', 'bold', 'Bold', `${MOD}B`),
    toggle('italic', 'italic', 'Italic', `${MOD}I`),
    toggle('underline', 'underline', 'Underline', `${MOD}U`),
    toggle('strikeThrough', 'strikethrough', 'Strikethrough'),
    colorMenu,
    highlightMenu,
    alignmentMenu,
    el('button.rte-btn', {
      type: 'button', title: `Insert or edit link (${MOD}K)`, 'aria-label': 'Insert or edit link',
      html: icon('link', 17), onmousedown: (event) => event.preventDefault(), onclick: openLink,
    }),
    el('span.rte-sep', { 'aria-hidden': 'true' }),
    toggle('insertUnorderedList', 'bulletList', 'Bulleted list'),
    toggle('insertOrderedList', 'numberList', 'Numbered list'),
    el('button.rte-btn', {
      type: 'button', title: 'Quote', 'aria-label': 'Quote', 'aria-pressed': 'false',
      html: icon('quote', 17),
      onmousedown: (event) => event.preventDefault(),
      onclick: toggleQuote,
    }),
    el('span.rte-sep', { 'aria-hidden': 'true' }),
    // The way back out of every mark above, which is why no menu here carries
    // a "default" entry of its own.
    el('button.rte-btn', {
      type: 'button', title: 'Clear formatting', 'aria-label': 'Clear formatting',
      html: icon('clearFormat', 17),
      onmousedown: (event) => event.preventDefault(),
      onclick: () => command(() => exec('removeFormat')),
    }),
  );

  const quoteBtn = toolbar.querySelector('[aria-label="Quote"]');

  /**
   * One tab stop for the whole toolbar, and the arrow keys inside it.
   *
   * Eleven buttons, each its own tab stop, sat between the subject line and
   * the message. Getting from one to the other with the keyboard meant eleven
   * presses past controls nobody was reaching for, and eleven more coming
   * back -- for a strip whose every control is also a menu item or a ⌘ key.
   *
   * This is what `role="toolbar"` has always promised: Tab reaches the
   * toolbar, the arrows move within it, and Tab again leaves for the message.
   * The stop stays on whichever button was used last, so coming back to the
   * toolbar comes back to where you were.
   */
  const controls = () => [...toolbar.querySelectorAll('.rte-btn')];

  const setStop = (button) => {
    for (const control of controls()) control.tabIndex = control === button ? 0 : -1;
  };

  setStop(controls()[0]);

  toolbar.addEventListener('focusin', (event) => {
    if (event.target.classList?.contains('rte-btn')) setStop(event.target);
  });

  toolbar.addEventListener('keydown', (event) => {
    // A menu opens inside the toolbar, so its items are inside this listener's
    // reach. The arrows belong to an open menu, which answers them itself.
    if (!event.target.classList?.contains('rte-btn')) return;
    const list = controls();
    const at = list.indexOf(event.target);
    if (at < 0) return;
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const next = step ? list[(at + step + list.length) % list.length]
      : event.key === 'Home' ? list[0]
      : event.key === 'End' ? list[list.length - 1]
      : null;
    if (!next) return;
    event.preventDefault();
    setStop(next);
    next.focus();
  });

  const refresh = () => {
    for (const [button, name] of toggles) {
      button.setAttribute('aria-pressed', String(stateOf(name)));
    }
    quoteBtn.setAttribute('aria-pressed', String(/blockquote/i.test(valueOf('formatBlock'))));
  };

  // -- typing, pasting, dropping ----------------------------------------------

  // Typing after a command at a collapsed caret, and Undo and Redo, which
  // replay execCommand's own steps, are where a `<font>` turns up now.
  // Not while a word is being composed with an input method: the browser is
  // still editing the text it put in the <font>, and taking it out from under
  // it left the first keystroke of the word behind ("n日本"). Once it is done.
  body.addEventListener('input', (event) => {
    if (!event.isComposing && body.querySelector('font')) normalizeFonts();
    changed();
  });
  body.addEventListener('compositionend', () => {
    if (body.querySelector('font')) normalizeFonts();
  });
  body.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      event.stopPropagation();
      openLink();
    }
  });
  // Where the caret is decides what the toolbar shows and what a menu command
  // will apply to, so both are taken again whenever it may have moved.
  body.addEventListener('keyup', () => { remember(); refresh(); });
  body.addEventListener('focus', () => { remember(); refresh(); });
  /**
   * A drag that starts in the message can end outside it -- past the edge of
   * the field, over the toolbar, anywhere -- and then no mouseup ever reaches
   * this element. The selection it made was never noted, so the toolbar went
   * on describing the selection before last and the next command applied to
   * that one: press Bold after selecting a paragraph that way and some other
   * words go bold.
   *
   * One listener per drag, on the document, removed as soon as it fires. That
   * covers an ordinary click inside the message too, so this is the only
   * mouseup handling here.
   */
  body.addEventListener('mousedown', () => {
    document.addEventListener('mouseup', () => { remember(); refresh(); }, { once: true });
  });

  /**
   * Content arriving from outside. Markup is cleaned and inserted as markup;
   * plain text is inserted as text, so the browser breaks the lines the way it
   * would if they had been typed. Files become attachments: this editor has no
   * inline images, and silently dropping a pasted screenshot would be worse
   * than attaching it.
   */
  const receive = (transfer, { atCaret = true, at = null } = {}) => {
    if (!transfer) return false;
    const files = [...(transfer.files ?? [])];
    const html = transfer.getData?.('text/html') ?? '';
    const text = transfer.getData?.('text/plain') ?? '';
    // Word, Excel, Keynote and Pages put a picture of what was copied on the
    // clipboard beside the markup of it, and the picture used to win: a pasted
    // table arrived as image.png and no text. Markup with words in it means
    // words were copied; a copied image or a screenshot carries none.
    const words = () => {
      const probe = document.createElement('template');
      probe.innerHTML = cleanHtml(html);
      return probe.content.textContent.trim() !== '';
    };
    if (files.length && !(html && words())) {
      onFiles?.(files);
      return true;
    }
    if (!html && !text) return false;
    // A paste goes where the caret is. A drop goes where it was dropped --
    // which the selection does not say yet while the drop event runs, so the
    // point is turned into a caret by the caller. Without one, a drop went
    // wherever the caret had last been.
    if (atCaret) restore();
    else if (at) {
      const selection = document.getSelection?.();
      selection?.removeAllRanges();
      selection?.addRange(at);
    }
    if (html) exec('insertHTML', cleanHtml(html));
    else exec('insertText', text);
    remember();
    changed();
    return true;
  };

  body.addEventListener('paste', (event) => {
    if (receive(event.clipboardData)) event.preventDefault();
  });

  // The compose dialog takes a file drag anywhere on it; text dragged into the
  // message is this editor's business, and would otherwise land as whatever
  // markup the source felt like handing over.
  //
  // Text dragged from one place in the message to another is the browser's
  // own move, and its markup is already the editor's: answered here as a
  // drop from outside, the selection was put back over itself and nothing
  // moved at all.
  let draggingOwn = false;
  body.addEventListener('dragstart', () => { draggingOwn = true; });
  body.addEventListener('dragend', () => { draggingOwn = false; });
  const caretAtPoint = (x, y) => {
    let range = null;
    try {
      const position = document.caretPositionFromPoint?.(x, y);
      if (position) {
        range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
      } else {
        range = document.caretRangeFromPoint?.(x, y) ?? null;
      }
    } catch {
      range = null;
    }
    return range && body.contains(range.startContainer) ? range : null;
  };
  body.addEventListener('drop', (event) => {
    if ([...(event.dataTransfer?.types ?? [])].includes('Files')) return;
    if (draggingOwn) return;
    const at = caretAtPoint(event.clientX, event.clientY);
    if (receive(event.dataTransfer, { atCaret: false, at })) event.preventDefault();
  });

  // Firefox leaves a bare text node per line unless it is told otherwise, and
  // `htmlToText` then has no block to hang a line break on.
  exec('defaultParagraphSeparator', 'div');

  const root = el('div.rte', {}, toolbar, linkPanel, body);

  return {
    root,
    body,

    /** The message as markup, reduced to what richtext.js allows. */
    getHtml: () => cleanHtml(body.innerHTML),

    /**
     * Replace the content. Markup is cleaned -- a draft comes back from
     * storage, which is a place its markup could have been edited by hand.
     */
    setHtml(html) {
      body.innerHTML = cleanHtml(html);
      // Filling the editor is not the writer typing, so no autosave is
      // triggered: this runs while the dialog is being built.
      saved = null;
      markEmpty();
    },

    /** Replace the content with plain text, one block per line. */
    setText(text) {
      this.setHtml(textToHtml(text));
    },

    focusStart: () => caretTo(true),
    focusEnd: () => caretTo(false),

    /**
     * The end of what the writer wrote, which in a resumed reply or forward
     * is above the signature and the message being answered: at the end of
     * the whole body, carrying on typing went in under sixty lines of quote.
     * What ends the writer's part is a signature separator (`-- `), the
     * forwarded-message header, or an attribution line followed by a quote
     * -- not any quote, since the Quote button makes those in the writer's
     * own text too. Without any of them, it is the end of the body.
     */
    focusOwnEnd() {
      const blocks = [...body.children];
      const line = (block) => block.textContent.replace(/\u00a0/g, ' ').trim();
      const tail = blocks.findIndex((block, index) => line(block) === '--'
        || /^-{10} Forwarded message -{10}$/.test(line(block))
        || (/ wrote:$/.test(line(block)) && blocks[index + 1]?.tagName === 'BLOCKQUOTE'));
      if (tail < 0) return caretTo(false);
      const own = blocks.slice(0, tail).reverse().find((block) => line(block));
      return own ? caretTo(false, own) : caretTo(true);
    },
  };
}
