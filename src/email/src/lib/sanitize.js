/**
 * Sanitizer for the HTML view.
 *
 * The frame this feeds is already the real defence: `sandbox` with neither
 * `allow-scripts` nor `allow-same-origin` means no mail script can run and
 * the frame is a unique opaque origin that cannot reach this app's storage or
 * its Puter token, and a `Content-Security-Policy` inside the frame stops
 * remote content loading. This runs anyway, because a typo in a sandbox
 * attribute should not be the difference between a rendered newsletter and a
 * disclosed auth token.
 *
 * It is an allowlist, not a blocklist: an element or attribute that is not
 * named here does not survive, so a tag nobody thought of is dropped by
 * default rather than passed through.
 */

import { misleadingLink, linkHost, disguisedHost } from './linkify.js';


// Layout and text elements real mail is built out of. Tables are in there
// because that is still how most HTML mail is laid out.
const ELEMENTS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big',
  'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col',
  'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hgroup', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main',
  'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small',
  'span', 'strike', 'strong', 'style', 'sub', 'summary', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul',
  'var', 'wbr',
]);

/**
 * Elements whose content is code, a form, or another document. These go with
 * everything inside them; anything else not on the allowlist is unwrapped
 * instead, because the text inside an unknown container is content while the
 * text inside a <script> is a program.
 */
const DROP_WITH_CONTENT = new Set([
  'applet', 'audio', 'base', 'body', 'button', 'canvas', 'embed', 'form',
  'frame', 'frameset', 'head', 'html', 'iframe', 'input', 'link', 'map',
  'math', 'meta', 'noscript', 'object', 'option', 'script', 'select', 'slot',
  'source', 'svg', 'template', 'textarea', 'title', 'track', 'video',
]);

// Attributes that carry presentation or meaning, and nothing that carries
// behaviour. `target` and `rel` are set by this module, never copied.
const GLOBAL_ATTRS = new Set([
  'align', 'alt', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'class',
  'color', 'colspan', 'dir', 'face', 'height', 'hspace', 'id', 'lang',
  'rowspan', 'size', 'span', 'start', 'style', 'title', 'type', 'valign',
  'vspace', 'width',
]);

const URL_ATTRS = { a: 'href', img: 'src' };

// The only schemes a mail body may point at. `javascript:` and `data:` in an
// href would be a real vulnerability; `data:` is allowed for an image, and
// only for an image.
const LINK_SCHEMES = /^(https?:|mailto:)/i;
const IMAGE_SCHEMES = /^(https?:|data:image\/(png|jpeg|jpg|gif|webp|avif|bmp|x-icon|svg\+xml);)/i;

// Whitespace and control characters are stripped before a scheme is judged:
// "java<tab>script:alert(1)" is javascript:, and so is " JavaScript:".
const scheme = (value = '') => String(value)
  .replace(/[\u0000-\u0020\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]/g, '')
  .toLowerCase();

// CSS that is executable somewhere, or that pulls in another stylesheet.
const EXECUTABLE_CSS = /expression\(|javascript:|behaviou?r\s*:|-moz-binding|@import/i;

/**
 * A `url()` that would leave the message: an absolute http(s) one, or the
 * protocol-relative form. Only http(s) counts as *detectable* remote content
 * below -- a protocol-relative URL cannot resolve from a srcdoc frame -- but
 * both are stripped when remote content is refused.
 *
 * The quote and the space around it are written `(?:['"]\s*)?` rather than
 * `['"]?\s*` after a `\s*` of their own. Two runs of optional whitespace with
 * only an optional quote between them can be divided in as many ways as there
 * are spaces, and all of them are tried before `url(` followed by a hundred
 * thousand spaces is given up on -- twenty seconds of frozen tab, from a
 * style attribute in a message, on showing its original formatting. With the
 * space that follows a quote tied to the quote there is one way to read it,
 * and the same stylesheets match.
 *
 * What is inside the brackets is a URL, and 4 KB is more than any of them:
 * the limit is there because an unterminated `url(` reads to the end of the
 * stylesheet before it gives up, and ten thousand of them read to the end ten
 * thousand times. A `url()` longer than that keeps its address in the markup
 * and still cannot fetch it -- the frame's CSP is what stops the request, and
 * this pass is the second lock on the same door.
 */
const REMOTE_CSS_URL = /url\(\s*(?:['"]\s*)?(?:https?:)?\/\/[^)]{0,4096}\)/gi;
const REMOTE_CSS_FETCH = /url\(\s*(?:['"]\s*)?https?:/i;

/**
 * The frame's CSP is what actually stops a remote fetch, but a stylesheet
 * that would make one has no business surviving a sanitizer that has just
 * stripped the same URL off an `img`. Executable CSS empties the whole
 * declaration; a remote `url()` is replaced with one that goes nowhere.
 */
const safeStyle = (value = '', allowRemote = true) => {
  if (EXECUTABLE_CSS.test(value)) return '';
  return allowRemote ? value : String(value).replace(REMOTE_CSS_URL, 'url(about:invalid)');
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

const sanitizeLink = (element) => {
  const href = element.getAttribute('href') ?? '';
  if (!LINK_SCHEMES.test(scheme(href))) {
    element.removeAttribute('href');
    return;
  }
  // A mail link always leaves the frame, and must not be able to reach back
  // into whatever opened it.
  element.setAttribute('target', '_blank');
  element.setAttribute('rel', 'noopener noreferrer');
  // Hovering shows the real target rather than whatever title the message
  // chose for it.
  element.setAttribute('title', href.trim());

  // A link whose text claims one host and whose href points at another is the
  // shape of every phishing link there has ever been. The real host goes next
  // to it, as text, so the reader can see the difference. So is an href that
  // names its host in a form other than the one the browser connects to -- a
  // homograph, or userinfo in front of the real host -- whatever its text says.
  if (misleadingLink(element.textContent ?? '', href) || disguisedHost(href)) {
    element.after(element.ownerDocument.createTextNode(` (${linkHost(href)})`));
  }
};

const sanitizeImage = (element, { resolveCid, allowRemoteImages }) => {
  const src = element.getAttribute('src') ?? '';
  const cleaned = scheme(src);

  if (cleaned.startsWith('cid:')) {
    // An inline image is part of the message, not remote content, so it is
    // rewritten to the bytes that came with it.
    const id = src.trim().slice(4).replace(/^</, '').replace(/>$/, '');
    const resolved = resolveCid?.(id);
    // The part declares its own Content-Type, and this is going into an
    // `img` src: anything that is not an image data: URL has no business
    // here, whatever the message said it was.
    if (resolved && /^data:image\//i.test(resolved)) element.setAttribute('src', resolved);
    else element.removeAttribute('src');
    return;
  }

  if (!IMAGE_SCHEMES.test(cleaned) || (!allowRemoteImages && /^https?:/i.test(cleaned))) {
    element.removeAttribute('src');
  }
};

/**
 * sanitizeHtml(html, { resolveCid, allowRemoteImages })
 *
 * `resolveCid(cid)` turns a `cid:` reference into a data: URL from the
 * matching MIME part -- without it, inline images show as broken even when
 * images are allowed. `allowRemoteImages` only decides whether an http(s)
 * image URL is kept in the markup; whether it *loads* is the frame's CSP,
 * which is what actually stops a tracking pixel.
 */
export function sanitizeHtml(html, { resolveCid = null, allowRemoteImages = true } = {}) {
  // A missing body is nothing to render, not the string "null".
  const doc = new DOMParser().parseFromString(html == null ? '' : String(html), 'text/html');
  if (!doc.body) return '';

  // Most newsletters put their CSS in <head><style>, and only the body is
  // returned -- so the styles are moved into it, in order, before anything is
  // judged. They are sanitized with everything else.
  for (const style of [...(doc.head?.querySelectorAll('style') ?? [])].reverse()) {
    doc.body.prepend(style);
  }

  // A comment can hide markup from a naive parser, and no comment in a mail
  // body is worth keeping.
  for (const comment of collectComments(doc.body)) comment.remove();

  for (const element of [...doc.body.querySelectorAll('*')]) {
    // A node inside something already removed went with it.
    if (!doc.body.contains(element)) continue;

    const tag = element.tagName?.toLowerCase();
    if (!ELEMENTS.has(tag)) {
      if (DROP_WITH_CONTENT.has(tag)) element.remove();
      else element.replaceWith(...element.childNodes);
      continue;
    }

    const urlAttr = URL_ATTRS[tag];
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      if (name === urlAttr) continue;
      // Every on* handler goes, whether or not the allowlist would have kept
      // the attribute.
      if (name.startsWith('on') || !GLOBAL_ATTRS.has(name)) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (name === 'style') {
        const safe = safeStyle(attr.value, allowRemoteImages);
        if (safe) element.setAttribute('style', safe);
        else element.removeAttribute('style');
      }
    }

    if (tag === 'a') sanitizeLink(element);
    if (tag === 'img') sanitizeImage(element, { resolveCid, allowRemoteImages });
    if (tag === 'style') {
      element.textContent = safeStyle(element.textContent || '', allowRemoteImages);
    }
  }

  return doc.body.innerHTML;
}

/**
 * Whether a body would try to fetch anything from the network.
 *
 * The whole document is judged, not just the body: most newsletters put their
 * CSS in `<head><style>`, and sanitizeHtml moves that into the body to render
 * it. Looking only at the body as it arrived missed every tracker that lived
 * in a head stylesheet.
 */
export const hasRemoteContent = (html) => {
  const doc = new DOMParser().parseFromString(html == null ? '' : String(html), 'text/html');
  const root = doc.documentElement ?? doc;

  for (const img of root.querySelectorAll('img')) {
    if (/^\s*https?:/i.test(img.getAttribute('src') ?? '')) return true;
  }

  const css = [
    ...[...root.querySelectorAll('style')].map((node) => node.textContent ?? ''),
    ...[...root.querySelectorAll('[style]')].map((node) => node.getAttribute('style') ?? ''),
  ].join('\n');
  return REMOTE_CSS_FETCH.test(css);
};
