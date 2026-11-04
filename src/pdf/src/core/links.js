/**
 * Link annotations: a web address or a page in the same PDF behind an area of the page. New
 * links are invisible rectangles, as most editors make them; readers show the pointer over them.
 */
import { PDFDict, PDFName, PDFRef, PDFString } from 'pdf-lib';
import { annotationForEdit, annotationList, annotationsOf } from './structure.js';

const name = PDFName.of;
export const MAX_URL_LENGTH = 2048;
function requireEditableLink(dict) {
  const flags = dict.lookup(name('F'))?.asNumber?.() || 0;
  if (flags & (64 | 128)) throw new Error('This link is read-only or locked.');
}
/** PDF.js names annotations by object number and, when not zero, generation: "12R", "12R1". */
export const annotationId = (ref) =>
  ref instanceof PDFRef ? `${ref.objectNumber}R${ref.generationNumber || ''}` : String(ref);

/** The address schemes a link in a PDF may open. PDF.js allows the same set, plus ftp. */
const OPEN_PROTOCOLS = ['http:', 'https:', 'ftp:', 'mailto:', 'tel:'];
/**
 * A link address found in a PDF, if it is one a browser may open: PDF.js hands over the
 * addresses it could not validate as `unsafeUrl`, and those include javascript:, data:, and
 * file: targets that must not become anchors. Anything else resolves to null.
 */
export function safeLinkUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value.trim());
    return OPEN_PROTOCOLS.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** A web address as typed: bare domains get https; only web, mail, and phone links are allowed. */
export function normalizeUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('Enter the web address to link to.');
  if (text.length > MAX_URL_LENGTH) throw new Error('Keep the address under 2,048 characters.');
  // A domain followed by a port also matches URI-scheme syntax ("example.com:"). Treat it
  // as a web host, leaving the URL parser to validate the port and the address itself.
  const hostWithPort = /^(?:[^/:?#\s]+\.[^/:?#\s]+|localhost):\d+(?:[/?#]|$)/i.test(text);
  // A bare email address is a mail link, also with a subject or other fields after it. Given
  // https, it would read as a sign-in name for the domain instead ("https://name@example.com/")
  // and open that site.
  const email = /^[^\s/:?#@]+@[^\s/:?#@]+\.[^\s/:?#@]+(?:\?.*)?$/.test(text);
  // A bare phone number, such as "+1 (555) 123-4567", is a phone link. Phone links leave out
  // the spaces, which their syntax does not allow.
  const phone = /^\+?[\d\s()-]+$/.test(text) && (text.match(/\d/g) || []).length >= 3;
  const withScheme = email
    ? `mailto:${text}`
    : phone
      ? `tel:${text.replace(/\s+/g, '')}`
      : /^[a-z][a-z0-9+.-]*:/i.test(text) && !hostWithPort
        ? text
        : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('Enter a valid web address, like example.com/page.');
  }
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol))
    throw new Error('Links can open web pages, email addresses, or phone numbers.');
  if (url.protocol === 'mailto:' && !url.pathname.trim())
    throw new Error('Enter the email address to link to.');
  if (url.protocol === 'tel:' && !/\d/.test(url.pathname))
    throw new Error('Enter the phone number to link to.');
  if (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    !url.hostname.includes('.') &&
    url.hostname !== 'localhost' &&
    !url.hostname.startsWith('[') // The URL parser accepts bracketed hosts only for valid IPv6.
  )
    throw new Error('Enter a valid web address, like example.com/page.');
  // The URL parser reads a bare number as an IPv4 address ("12" as 0.0.0.12); only an
  // address typed out in full is meant as one.
  if (/^[\d.]+$/.test(url.hostname) && !withScheme.toLowerCase().includes(url.hostname))
    throw new Error('Enter a valid web address, like example.com/page.');
  // Encoding Unicode and adding https can expand a short input. Validate the stored value
  // here too, so the dialog can keep it open for correction before add/update normalizes again.
  if (url.href.length > MAX_URL_LENGTH) throw new Error('Keep the address under 2,048 characters.');
  return url.href;
}

/**
 * A PDF literal string: `(`, `)`, and `\` are the delimiters and escape of that syntax, and
 * pdf-lib writes the value as given, so an address holding them would end the string early
 * and let the rest be read as dictionary keys. Readers undo these escapes when they parse.
 */
export const pdfLiteral = (value) => PDFString.of(String(value).replace(/[\\()]/g, '\\$&'));

function linkDestination(doc, { url, page }) {
  if (page == null) return { A: { S: 'URI', URI: pdfLiteral(normalizeUrl(url)) } };
  const to = Number(page);
  if (!Number.isInteger(to) || to < 0 || to >= doc.getPageCount())
    throw new Error(`Choose a page between 1 and ${doc.getPageCount()}.`);
  return { Dest: [doc.getPage(to).ref, 'Fit'] };
}

/** Add a link over `rect` (PDF points) to `url`, or to zero-based `page`. Returns its id. */
export function addLink(doc, index, { rect, url, page } = {}) {
  if (!(rect?.width > 0 && rect?.height > 0))
    throw new Error('Choose the area that should be a link.');
  const dict = {
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    Border: [0, 0, 0],
    F: 4,
  };
  Object.assign(dict, linkDestination(doc, { url, page }));
  const ref = doc.context.register(doc.context.obj(dict));
  annotationList(doc.getPage(index)).push(ref);
  return annotationId(ref);
}

/** Change this page's link destination, preserving its appearance and bounds. */
export function updateLink(doc, index, id, destination) {
  const annots = annotationsOf(doc.getPage(index));
  for (const ref of annots?.asArray() ?? []) {
    const dict = doc.context.lookup(ref);
    if (
      annotationId(ref) !== id ||
      !(dict instanceof PDFDict) ||
      dict.lookup(name('Subtype')) !== name('Link')
    )
      continue;
    requireEditableLink(dict);
    // Validate before modifying the annotation, and remove the competing destination.
    const [key, value] = Object.entries(linkDestination(doc, destination))[0];
    const own = annotationForEdit(doc.getPage(index), dict);
    own.set(name(key), doc.context.obj(value));
    own.delete(name(key === 'A' ? 'Dest' : 'A'));
    return true;
  }
  return false;
}

/** The links on a page: their PDF.js ids, rectangles, and web addresses (null for page links). */
export function listLinks(doc, index) {
  const annots = annotationsOf(doc.getPage(index));
  if (!annots) return [];
  const links = [];
  for (const ref of annots.asArray()) {
    const dict = doc.context.lookup(ref);
    if (!(dict instanceof PDFDict) || dict.lookup(name('Subtype')) !== name('Link')) continue;
    const action = dict.lookup(name('A'));
    const uri =
      action instanceof PDFDict && action.get(name('S')) === name('URI')
        ? action.lookup(name('URI'))
        : null;
    links.push({
      id: annotationId(ref),
      rect:
        dict
          .lookup(name('Rect'))
          ?.asArray?.()
          .map((n) => n.asNumber?.()) ?? null,
      url: uri?.decodeText?.() ?? null,
    });
  }
  return links;
}

/** Remove the link with PDF.js id `id`. Returns false when the page has no such link. */
export function removeLink(doc, index, id) {
  const annots = annotationsOf(doc.getPage(index));
  if (!annots) return false;
  for (let i = annots.size() - 1; i >= 0; i--) {
    const ref = annots.get(i);
    const dict = doc.context.lookup(ref);
    if (
      annotationId(ref) === id &&
      dict instanceof PDFDict &&
      dict.lookup(name('Subtype')) === name('Link')
    ) {
      requireEditableLink(dict);
      annotationList(doc.getPage(index)).remove(i);
      return true;
    }
  }
  return false;
}
