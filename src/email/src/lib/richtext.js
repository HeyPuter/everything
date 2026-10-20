/**
 * The rich text side of composing: the small HTML vocabulary the compose
 * editor is allowed to hold, and the conversions in and out of it.
 *
 * Three rules shape everything here.
 *
 * **A message is still text.** Every rich message goes out as
 * `multipart/alternative`: a `text/plain` part built by `htmlToText` and a
 * `text/html` part built by `messageHtml`. A recipient reading in a terminal,
 * a screen reader, or a client that refuses HTML gets a real message rather
 * than a note saying they need a better client. That is also why `hasFormatting`
 * exists: a message with nothing marked up in it is sent as plain text alone,
 * exactly as before, instead of carrying an HTML part that says the same thing
 * twice.
 *
 * **The vocabulary is deliberately small.** Bold, italic, underline,
 * strikethrough, one of a few fonts, one of a few sizes, a colour, lists,
 * quotes, links. No tables, no images, no floats, no positioning. Everything
 * on that list survives in Gmail, Apple Mail, Outlook and mutt; the things
 * left off it are where HTML mail turns into something that renders one way
 * here and another way everywhere else. `cleanHtml` is the definition of that
 * vocabulary, and it is an allowlist -- of elements, of style properties, and
 * of the values each property may take.
 *
 * **Pasted markup is not trusted.** A paste can carry a whole page's worth of
 * markup from anywhere, and it reaches the editor by way of `innerHTML`. So
 * `cleanHtml` runs on the way in, again on the way out, and once more over a
 * draft coming back from storage. Like sanitize.js it drops what it does not
 * recognise rather than hunting for what it knows to be bad.
 *
 * Pure functions over strings, like compose.js and mime.js: no DOM beyond a
 * parser, and nothing here knows the editor exists.
 */

import { linkify } from './linkify.js';
import { showsTarget } from './mime.js';

// -- the choices the toolbar offers ------------------------------------------------

/**
 * Fonts, by the role they play rather than by name, and every stack ending in
 * a generic family. A font is a *request*: the recipient's client renders the
 * first of these it happens to have, which is why the list is web-safe faces
 * and not the ones this machine happens to have installed.
 */
export const FONTS = [
  { id: 'sans', label: 'Sans serif', stack: 'Arial, Helvetica, sans-serif' },
  { id: 'serif', label: 'Serif', stack: 'Georgia, "Times New Roman", serif' },
  { id: 'mono', label: 'Fixed width', stack: '"Courier New", Courier, monospace' },
  { id: 'wide', label: 'Wide', stack: 'Verdana, Geneva, sans-serif' },
  { id: 'narrow', label: 'Narrow', stack: '"Arial Narrow", Arial, sans-serif' },
];

/**
 * Sizes as four steps rather than a number box. Absolute px, because `em` and
 * `%` compound when one span ends up inside another and a client's own wrapper
 * is one more multiplier this app cannot see.
 */
export const SIZES = [
  { id: 'small', label: 'Small', css: '12px' },
  { id: 'normal', label: 'Normal', css: '14px' },
  { id: 'large', label: 'Large', css: '18px' },
  { id: 'huge', label: 'Huge', css: '26px' },
];

/**
 * Colours that stay legible on a white background and on a dark one, since
 * the writer may be composing in either theme and has no idea which the
 * recipient reads in. Seven of them, and one hue each: the menu opens
 * downward inside a dialog, and a palette long enough to need scrolling is a
 * palette nobody reaches the end of.
 *
 * There is no "default" entry: a colour is un-chosen with Clear formatting,
 * which is one predictable control rather than a per-menu reset that cannot
 * know what to reset *to*.
 */
export const COLORS = [
  { label: 'Black', value: '#202124' },
  { label: 'Grey', value: '#5f6368' },
  { label: 'Red', value: '#c5221f' },
  { label: 'Orange', value: '#b06000' },
  { label: 'Green', value: '#137333' },
  { label: 'Blue', value: '#1967d2' },
  { label: 'Purple', value: '#8430ce' },
];

// -- the allowlist ------------------------------------------------------------------

/**
 * Every element the editor may hold. `b`/`strong`, `i`/`em` and `s`/`strike`/
 * `del` are all here because `document.execCommand` emits a different one of
 * each pair depending on the browser, and a paste can bring either.
 */
const ELEMENTS = new Set([
  'a', 'b', 'blockquote', 'br', 'del', 'div', 'em', 'i', 'li', 'ol', 'p',
  's', 'span', 'strike', 'strong', 'u', 'ul',
]);

/**
 * Elements that go with everything inside them, because what is inside them
 * is a program, a form, or another document rather than text.
 */
const DROP_WITH_CONTENT = new Set([
  'applet', 'audio', 'base', 'body', 'button', 'canvas', 'embed', 'form',
  'frame', 'frameset', 'head', 'html', 'iframe', 'input', 'link', 'map',
  'math', 'meta', 'noscript', 'object', 'option', 'script', 'select', 'slot',
  'source', 'style', 'svg', 'template', 'textarea', 'title', 'track', 'video',
]);

/**
 * Elements that are a block of their own but that this editor has no control
 * for. They keep their place and lose their identity: each becomes a `div`.
 *
 * Unwrapping them instead is what a first attempt does, and it runs a pasted
 * heading into the paragraph under it -- `<h2>Q3</h2><p>Up 4%</p>` arriving as
 * `Q3Up 4%`. A pasted table is the same problem a hundred times over. One div
 * per block costs a little nesting and keeps every line break that was on the
 * page it came from.
 */
const AS_DIV = new Set([
  'address', 'article', 'aside', 'caption', 'center', 'dd', 'details',
  'dialog', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'main', 'nav', 'pre',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
]);

const COLOR_VALUE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]{1,40}\)|[a-z]{3,20})$/i;
const CSS_WIDE = /^(inherit|initial|unset|revert(-layer)?)$/i;

/**
 * The style properties that may survive, each with the shape its value has to
 * take. Filtering the property name alone is not enough: `font-family` is a
 * perfectly ordinary property and `font-family: x; } body { display: none`
 * is a perfectly ordinary attempt at breaking out of it. A value that does not
 * match its pattern is dropped rather than repaired.
 */
const STYLE_VALUES = {
  'font-family': /^[\w\s,'"-]{1,120}$/,
  'font-size': /^(\d{1,3}(\.\d+)?(px|pt|em|rem|%)|x?x-(small|large)|small|medium|large|smaller|larger)$/,
  'font-weight': /^(normal|bold|bolder|lighter|[1-9]00)$/,
  'font-style': /^(normal|italic|oblique)$/,
  'text-decoration': /^(none|underline|line-through|overline|underline line-through)$/,
  'text-decoration-line': /^(none|underline|line-through|underline line-through)$/,
  'text-align': /^(left|right|center|justify)$/,
  color: COLOR_VALUE,
  'background-color': COLOR_VALUE,
};

/**
 * A style attribute, reduced to the declarations that are on the list and
 * whose values look like what they claim to be. Everything else -- a
 * `position`, a `url()`, an `expression()`, a stray closing brace -- is simply
 * not carried across, so there is nothing to get the escaping of wrong.
 */
const safeStyle = (value) => {
  const kept = [];
  for (const declaration of String(value ?? '').split(';')) {
    const at = declaration.indexOf(':');
    if (at < 1) continue;
    const property = declaration.slice(0, at).trim().toLowerCase();
    const setting = declaration.slice(at + 1)
      .replace(/!important/i, '')
      .trim()
      .replace(/\s+/g, ' ');
    // `inherit` and its relatives say "do what you would have done anyway".
    // Chrome's own `insertHTML` sprinkles half a dozen of them over every
    // paste, and keeping them would fill drafts with declarations that mean
    // nothing -- and, because a style attribute is what `hasFormatting` looks
    // for, would send an HTML part for a message nobody formatted.
    if (CSS_WIDE.test(setting)) continue;
    const shape = Object.prototype.hasOwnProperty.call(STYLE_VALUES, property)
      && STYLE_VALUES[property];
    if (!shape || !setting || !shape.test(setting)) continue;
    kept.push(`${property}: ${setting}`);
  }
  return kept.join('; ');
};

// Whitespace and control characters come out before a scheme is judged:
// "java<tab>script:" is javascript:, and so is " JavaScript:".
const bareScheme = (value) => String(value)
  .replace(/[\u0000-\u0020\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]/g, '')
  .toLowerCase();

/**
 * The schemes a link in an outgoing message may use. Anything else loses its
 * href and the link is unwrapped: an outgoing `javascript:` link is a trap
 * this app would be handing to someone else, and a relative URL has no base
 * to resolve against once the message has been sent.
 */
const safeHref = (value) => {
  const href = String(value ?? '').trim();
  return /^(https?:|mailto:)/i.test(bareScheme(href)) ? href : '';
};

/** Validate a user-entered link; bare hostnames and email addresses are handy. */
export const normalizeLink = (value) => {
  let href = String(value ?? '').trim();
  if (!href || /[\u0000-\u0020\u007f]/.test(href)) return '';
  if (/^[^:@/]+@[^@/]+\.[^@/]+$/.test(href)) href = `mailto:${href}`;
  else if (!/^[a-z][a-z\d+.-]*:/i.test(href)) href = `https://${href}`;
  try {
    const url = new URL(href);
    if (url.protocol === 'mailto:') return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(url.pathname) ? href : '';
    return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
};

const collectComments = (root) => {
  const found = [];
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 8) found.push(child);
      else if (child.nodeType === 1) walk(child);
    }
  };
  walk(root);
  return found;
};

/**
 * cleanHtml(html) -> the same content, reduced to the editor's vocabulary.
 *
 * Runs on paste, on every read of the editor, and over a draft coming back
 * from storage. Attributes are not filtered one by one but dropped wholesale
 * and the two that are allowed -- `style` and, on a link, `href` -- put back,
 * so an attribute nobody thought of cannot survive by not being on a list.
 */
export const cleanHtml = (html) => {
  const doc = new DOMParser().parseFromString(html == null ? '' : String(html), 'text/html');
  if (!doc.body) return '';

  // A comment can hide markup from a naive parser, and there is nothing a
  // comment could be doing in a message being written here.
  for (const comment of collectComments(doc.body)) comment.remove();

  for (const element of [...doc.body.querySelectorAll('*')]) {
    // A node inside something already removed went with it.
    if (!doc.body.contains(element)) continue;

    const tag = element.tagName?.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) {
      element.remove();
      continue;
    }
    // Not a block, and not on the allowlist: an `<abbr>` or a `<font>` is its
    // contents as far as this editor is concerned.
    if (!ELEMENTS.has(tag) && !AS_DIV.has(tag)) {
      element.replaceWith(...element.childNodes);
      continue;
    }

    const style = safeStyle(element.getAttribute('style'));
    const href = tag === 'a' ? safeHref(element.getAttribute('href')) : '';

    if (!ELEMENTS.has(tag)) {
      const div = doc.createElement('div');
      if (style) div.setAttribute('style', style);
      div.append(...element.childNodes);
      element.replaceWith(div);
      continue;
    }

    for (const attr of [...element.attributes]) element.removeAttribute(attr.name);
    if (style) element.setAttribute('style', style);
    if (href) element.setAttribute('href', href);

    // A span with nothing left to say, and a link with nowhere left to go,
    // are not markup any more. Unwrapping them is what keeps an editor that
    // has been formatted and unformatted a few times from filling up with
    // empty nesting.
    // A styled span with no words in it is what Undo leaves of a font, a
    // size or a colour: it styles nothing, and must not make a message that
    // has no formatting left go out as HTML mail.
    if ((tag === 'span' && (!style || !element.textContent.trim())) || (tag === 'a' && !href)) {
      element.replaceWith(...element.childNodes);
    }
  }

  return doc.body.innerHTML;
};

/**
 * Whether a body actually uses any of this. A message the writer never
 * formatted is sent as `text/plain` and nothing else, the way this app sent
 * every message before there was an editor -- so the common case does not
 * quietly become HTML mail.
 *
 * Blockquote is not on the list on purpose: a reply's quoted text survives
 * `htmlToText` as the `> ` lines it came from, so quoting alone is not a
 * reason to send an HTML part. Explicit links do count, so custom link text
 * remains clickable rather than turning into a label followed by a URL.
 */
export const hasFormatting = (html) => {
  const doc = new DOMParser().parseFromString(html == null ? '' : String(html), 'text/html');
  return Boolean(doc.body?.querySelector(
    'a[href], b, strong, i, em, u, s, strike, del, ul, ol, [style]'));
};

// -- HTML in, text out ----------------------------------------------------------------

// Elements that start on a line of their own. `li` and `blockquote` are
// handled before this is consulted, since they add a marker or a prefix.
const BLOCKS = new Set([
  'address', 'article', 'aside', 'div', 'dd', 'dl', 'dt', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'ol', 'p', 'pre',
  'section', 'table', 'tr', 'ul',
]);

const SKIP = new Set(['head', 'noscript', 'script', 'style', 'template', 'title']);

// A link this app keeps the target of; anything else was going nowhere useful.
const KEPT_HREF = /^\s*(https?:\/\/|mailto:)/i;

const atLineStart = (out) => out === '' || out.endsWith('\n');

// The line that separates a message from its signature, space included.
const SIGNATURE_SEPARATOR = '-- ';

// Quoted text is quoted text: `> ` per line, and a bare `>` on an empty one
// rather than a line with a trailing space on it.
const quotePrefix = (text) => text
  .split('\n')
  .map((line) => (line ? `> ${line}` : '>'))
  .join('\n');

/**
 * A block's own content. A single trailing line break is the filler `<br>`
 * that browsers keep an empty block alive with, not a line anybody typed --
 * without dropping it, every paragraph of a message would arrive followed by
 * a blank line that is not there on screen.
 */
const contentOf = (node) => render(node).replace(/\n$/, '');

function render(node) {
  let out = '';
  let item = 0;

  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      // HTML collapses a run of whitespace to one space when it renders, so
      // flattening it has to as well: the line breaks of the markup are not
      // line breaks of the message. A no-break space is left alone here: it
      // is how the editor keeps a run of spaces the writer typed, or quoted
      // -- the columns of a receipt, the indent of a line of code -- and
      // collapsing it with the rest is what mangled every one of those in
      // the text part, which for an unformatted message is the message.
      const text = (child.nodeValue ?? '').replace(/[ \t\r\n\f\v]+/g, ' ');
      out += atLineStart(out) ? text.replace(/^ /, '') : text;
      continue;
    }
    if (child.nodeType !== 1) continue;

    const tag = child.tagName.toLowerCase();
    if (SKIP.has(tag)) continue;

    if (tag === 'br') {
      out += '\n';
      continue;
    }

    if (tag === 'a') {
      const label = render(child);
      const href = child.getAttribute('href') ?? '';
      out += label;
      // Where the text of a link is not the URL itself, the URL goes beside
      // it: a plain-text reader has no other way to follow "the dashboard".
      if (KEPT_HREF.test(href) && !showsTarget(label, href)) out += ` <${href.trim()}>`;
      continue;
    }

    if (tag === 'li') {
      item += 1;
      const marker = node.tagName?.toLowerCase() === 'ol' ? `${item}. ` : '- ';
      out = `${atLineStart(out) ? out : `${out}\n`}${marker}${contentOf(child).trim()}\n`;
      continue;
    }

    if (tag === 'blockquote') {
      out = `${atLineStart(out) ? out : `${out}\n`}${quotePrefix(contentOf(child))}\n`;
      continue;
    }

    if (BLOCKS.has(tag)) {
      out = `${atLineStart(out) ? out : `${out}\n`}${contentOf(child)}\n`;
      continue;
    }

    out += render(child);
  }

  return out;
}

/**
 * htmlToText(html) -> the message as text.
 *
 * Not a fallback in the apologetic sense: this is the `text/plain` part of
 * every message sent from here, and for plenty of recipients it is the whole
 * message. Bold and colour have no text equivalent and simply go; structure
 * does, and is kept -- a list becomes `- item`, a quote becomes `> line`, a
 * link whose text is not its URL keeps the URL beside it.
 */
const trimSpacesEnd = (line) => {
  let end = line.length;
  while (end && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  return end === line.length ? line : line.slice(0, end);
};

export const htmlToText = (html) => {
  const doc = new DOMParser().parseFromString(html == null ? '' : String(html), 'text/html');
  return (doc.body ? render(doc.body) : '')
    // Whitespace at the head of a line is the markup's indentation, not the
    // message's -- the message's arrives as no-break spaces, which this
    // leaves where they are.
    .replace(/\n[ \t]+/g, '\n')
    // Those no-break spaces are ordinary spaces in text: a plain-text reader
    // has no use for the distinction, and mutt shows the character itself.
    .replace(/\u00a0/g, ' ')
    // Trailing whitespace is the markup's, not the message's -- except on
    // the one line where it is the message: the signature separator is
    // `-- ` with the space (RFC 3676), and without it Thunderbird does not
    // grey the signature out and mutt does not trim it from a quote. Every
    // message signed here carried `--` instead, because this pass took the
    // space off on the way out.
    //
    // Walked back line by line rather than matched: the regex this was is
    // quadratic on a run of spaces that does not end its line -- which is what
    // a reply quoting a hostile message carries, on every autosave.
    .split('\n')
    .map((line) => (line === SIGNATURE_SEPARATOR ? line : trimSpacesEnd(line)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    // Blank lines either end are the markup's; an indent on the first line
    // that is there is the writer's.
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd();
};

// -- text in, HTML out ------------------------------------------------------------------

// Only ever inserted between tags, never into an attribute, so the three
// characters that could start a tag or an entity are the three that matter.
const escapeText = (value) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\t/g, '    ')
  // A run of spaces collapses to one when HTML renders, and the indentation
  // of a quoted code block or an aligned table of figures is content.
  .replace(/ {2,}/g, (run) => `${'&nbsp;'.repeat(run.length - 1)} `)
  .replace(/^ /, '&nbsp;');

const QUOTED_LINE = /^>\s?/;

/**
 * Lines to markup. A run of `> ` lines becomes one blockquote, one level per
 * pass, so a reply to a reply to a reply keeps its nesting instead of
 * flattening into a single quote -- and `htmlToText` turns it straight back
 * into the same `> ` lines.
 */
const renderLines = (rows) => {
  let html = '';
  let at = 0;
  while (at < rows.length) {
    if (QUOTED_LINE.test(rows[at])) {
      const group = [];
      while (at < rows.length && QUOTED_LINE.test(rows[at])) {
        group.push(rows[at].replace(QUOTED_LINE, ''));
        at += 1;
      }
      html += `<blockquote>${renderLines(group)}</blockquote>`;
      continue;
    }
    html += rows[at] ? `<div>${escapeText(rows[at])}</div>` : '<div><br></div>';
    at += 1;
  }
  return html;
};

/**
 * textToHtml(text) -> the editor's markup for a plain text body.
 *
 * This is how a reply, a forward, and a draft written before there was an
 * editor arrive in it: as text, which is turned into the same `div`-per-line
 * shape the editor itself produces. Nothing is linkified here -- that happens
 * once, in `messageHtml`, so there is a single place where a link is made.
 */
export const textToHtml = (text) =>
  renderLines(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'));

// -- the html part of the message ---------------------------------------------------

// Where a URL in the text is already a link, or is being shown as code.
const ALREADY_LINKED = new Set(['a', 'code', 'pre']);

/**
 * Turn the URLs and addresses in the text into links.
 *
 * Explicit links are kept intact. Bare URLs are linked on the way out, as
 * readers expect in HTML mail. Doing it here means the same pass
 * covers a URL the writer typed, a URL inside the text they quoted, and a URL
 * that was pasted as bare text -- and `linkify` is the same scanner the reader
 * uses, so a link is judged by one set of rules in both directions.
 */
const autoLink = (root) => {
  const doc = root.ownerDocument;
  const targets = [];

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (/\S/.test(child.nodeValue ?? '')) targets.push(child);
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (ALREADY_LINKED.has(child.tagName.toLowerCase())) continue;
      walk(child);
    }
  };
  walk(root);

  for (const node of targets) {
    const segments = linkify(node.nodeValue ?? '');
    if (!segments.some((segment) => segment.url || segment.email)) continue;

    const fragment = doc.createDocumentFragment();
    for (const segment of segments) {
      if (segment.text !== undefined) {
        fragment.append(doc.createTextNode(segment.text));
        continue;
      }
      const anchor = doc.createElement('a');
      anchor.setAttribute('href', segment.email ? `mailto:${segment.email}` : segment.url);
      anchor.textContent = segment.label;
      fragment.append(anchor);
    }
    node.replaceWith(fragment);
  }
};

/**
 * messageHtml(html) -> the `text/html` part, as a whole small document.
 *
 * A document rather than a bare fragment because that is what every other
 * client sends and what the oldest ones expect. There is deliberately no
 * wrapper imposing a font, a size or a colour on the message: the spans the
 * writer created say what they chose, and everything they did not choose is
 * left for the reading client to render in its own default -- which is the
 * only way a message can look right in both a light client and a dark one.
 */
export const messageHtml = (html) => {
  const doc = new DOMParser().parseFromString(cleanHtml(html), 'text/html');
  if (!doc.body) return '';
  autoLink(doc.body);
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'
    + `${doc.body.innerHTML}</body></html>`;
};
