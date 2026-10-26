import { UnsupportedDocumentError } from './errors.js';
import { serializeFragment } from './docx-compatibility.js';
import { relatedPartPath } from './docx-relationships.js';
import { parseXml, wordText } from './docx-xml.js';
import { bookmarkReader } from './docx-bookmarks.js';
import { bookmarkEntries } from './bookmarks.js';
import { unresolvedBindingReader } from './docx-data-binding.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';
const XMLNS = 'http://www.w3.org/2000/xmlns/';

// The saved sdtContent is the document content in print view, independently of
// whether this editor implements the wrapper's editing/binding behavior. Only
// use this on a disposable read-only DOM, never one serialized from editable
// model content. Retained page stories have a separately validated entry below.
export function projectControlContents(root) {
  const controls = [...root.getElementsByTagNameNS(W, 'sdt')].reverse();
  for (const control of controls) {
    const contents = [...control.children].filter(n => n.namespaceURI === W && n.localName === 'sdtContent');
    if (contents.length !== 1) continue;
    for (const node of [...contents[0].children]) {
      // Namespace declarations can belong to a wrapper that is about to go
      // away; retain them even when only an MC Requires value uses the prefix.
      const bound = new Set();
      for (let at = node; at; at = at.parentElement) for (const a of at.attributes) {
        if (a.namespaceURI === XMLNS && !bound.has(a.name)) {
          bound.add(a.name); node.setAttributeNS(XMLNS, a.name, a.value);
        }
      }
      control.parentNode.insertBefore(node, control);
    }
    control.remove();
  }
}

// Headers/footers are retained package parts, not editable model content. Their
// control properties govern editing/binding; sdtContent supplies saved print
// content. Validate the envelope before projecting that disposable story DOM.
// The original part (including locks, IDs, bindings and gallery metadata) must
// remain untouched on export. Projected children still require strict readers.
export function projectRetainedStoryControls(root) {
  if (root.namespaceURI !== W || !['hdr', 'ftr'].includes(root.localName)) fail('projection outside a retained page story');
  projectRetainedControls(root);
}

// Drawing text is retained atomically too; project only a disposable clone.
export function projectRetainedTextBoxControls(root) {
  if (root.namespaceURI !== W || root.localName !== 'txbxContent') fail('projection outside a retained text box');
  projectRetainedControls(root);
}

function projectRetainedControls(root) {
  const controls = [...root.getElementsByTagNameNS(W, 'sdt')];
  if (controls.length > 2000) fail('more than 2,000 retained story controls');
  for (const control of controls) {
    attributes(control);
    let previous = -1;
    for (const node of children(control)) {
      const order = node.namespaceURI === W ? ['sdtPr', 'sdtEndPr', 'sdtContent'].indexOf(node.localName) : -1;
      if (order <= previous) fail('unknown, duplicate or misordered retained story children');
      previous = order;
    }
    const content = child(control, 'sdtContent');
    if (!content) fail('missing retained story contents');
    attributes(content);
    let depth = 0;
    for (let at = control; at && at !== root; at = at.parentElement) if (at.namespaceURI === W && at.localName === 'sdt' && ++depth > 12) fail('excessive retained story nesting');
  }
  projectControlContents(root);
}
const children = n => [...(n?.children || [])];
const fail = reason => { throw new UnsupportedDocumentError(`content controls with ${reason}`); };
const child = (n, name) => children(n).find(c => c.namespaceURI === W && c.localName === name);
function attributes(node, names = [], ns = W) {
  if ([...node.attributes].some(a => a.namespaceURI !== XMLNS && !(a.namespaceURI === ns && names.includes(a.localName)))) fail(`unsupported ${node.localName} attributes`);
  if ([...node.childNodes].some(n => [3, 4].includes(n.nodeType) && n.textContent.trim())) fail('text outside runs');
}
const REVISIONS = ['ins', 'del', 'moveFrom', 'moveTo'];
const isRevision = n => n.namespaceURI === W && REVISIONS.includes(n.localName);
// The items of inline control contents with tracked-change wrappers replaced by the runs they
// hold (a deletion may sit inside another reviewer's insertion); null when a wrapper holds anything else.
function trackedRuns(nodes, depth = 0) {
  const result = [];
  for (const node of nodes) {
    if (!isRevision(node)) { result.push(node); continue; }
    const inner = depth < 1 ? trackedRuns(children(node), depth + 1) : children(node);
    if (!inner?.some(n => n.namespaceURI === W && n.localName === 'r') || inner.some(n => n.namespaceURI !== W || !['r', 'proofErr', 'bookmarkStart', 'bookmarkEnd'].includes(n.localName))) return null;
    result.push(...inner);
  }
  return result;
}
const deletedRun = r => ['del', 'moveFrom'].includes(r.parentElement?.localName) && r.parentElement.namespaceURI === W;
function leaf(node, names = [], ns = W) { attributes(node, names, ns); if (children(node).length) fail(`nested ${node.localName} properties`); }
function on(node) {
  if (!node) return false;
  leaf(node, ['val']); const val = node.getAttributeNS(W, 'val');
  if (val !== null && !['true', 'false', '1', '0', 'on', 'off'].includes(val)) fail(`invalid ${node.localName} boolean`);
  return val === null || ['true', '1', 'on'].includes(val);
}

export function contentControlReader(readRunProperties, parts = {}) {
  let count = 0; const ids = new Set();
  const readUnresolvedBinding = unresolvedBindingReader(parts);
  let glossary;
  const placeholderRuns = (name, kind) => {
    if (!name) return undefined;
    if (!glossary) {
      glossary = new Map();
      const path = relatedPartPath(parts, 'glossaryDocument');
      if (path) for (const part of parseXml(parts[path]).getElementsByTagNameNS(W, 'docPart')) {
        const name = child(child(part, 'docPartPr'), 'name')?.getAttributeNS(W, 'val');
        if (name) glossary.set(name, child(part, 'docPartBody'));
      }
    }
    const body = glossary.get(name); if (!body) return undefined;
    const paragraphs = children(body).filter(n => n.namespaceURI === W && n.localName === 'p');
    if (!paragraphs.length || kind === 'inline' && paragraphs.length !== 1 || children(body).some(n => n.namespaceURI !== W || !['p', 'sectPr'].includes(n.localName))) fail('non-inline placeholder definitions');
    const result = [], promptParagraphs = [], readBookmark = bookmarkReader();
    for (const paragraph of paragraphs) {
      const runs = [], bookmarks = []; let offset = 0;
      for (const r of children(paragraph)) {
        if (r.namespaceURI === W && ['pPr', 'proofErr'].includes(r.localName)) continue;
        if (r.namespaceURI === W && ['bookmarkStart', 'bookmarkEnd'].includes(r.localName)) {
          bookmarks.push(readBookmark(r, offset)); continue;
        }
        if (r.namespaceURI !== W || r.localName !== 'r') fail('non-text placeholder definitions');
        let text = '';
        for (const n of children(r)) {
          if (n.namespaceURI !== W) fail('unsupported placeholder extensions');
          if (n.localName === 't') text += wordText(n);
          else if (n.localName === 'tab') text += '\t';
          else if (n.localName === 'cr') { leaf(n); text += '\v'; }
          else if (n.localName === 'br') {
            leaf(n, ['type', 'clear']);
            const type = n.getAttributeNS(W, 'type') || 'textWrapping';
            const clear = n.getAttributeNS(W, 'clear');
            if (!['page', 'column', 'textWrapping'].includes(type) || type === 'textWrapping' && clear && clear !== 'none') fail('text-clearing placeholder breaks');
            text += type === 'page' ? '\f' : type === 'column' ? '\u000e' : '\v';
          }
          else if (!['rPr', 'lastRenderedPageBreak'].includes(n.localName)) fail('non-text placeholder definitions');
        }
        if (text) runs.push({ ...readRunProperties(child(r, 'rPr')), text });
        offset += text.length;
      }
      result.push(runs);
      promptParagraphs.push({ id: String(promptParagraphs.length), runs, bookmarks });
    }
    try { bookmarkEntries(promptParagraphs); } catch { fail('invalid placeholder bookmarks'); }
    const runs = kind !== 'inline' ? result.length > 1 || result[0]?.length ? result : undefined : result[0]?.length ? result[0] : undefined;
    if (!runs && promptParagraphs.some(p => p.bookmarks.length)) fail('bookmarks in an empty placeholder definition');
    return runs ? { runs, bookmarks: promptParagraphs.map(p => p.bookmarks) } : undefined;
  };
  return (node, kind = 'inline') => {
    if (count >= 2000) fail('more than 2,000 controls');
    attributes(node);
    const elements = children(node), order = ['sdtPr', 'sdtEndPr', 'sdtContent']; let previous = -1;
    for (const el of elements) {
      const index = el.namespaceURI === W ? order.indexOf(el.localName) : -1;
      if (index <= previous) fail('unknown, duplicate or misordered children'); previous = index;
    }
    const pr = child(node, 'sdtPr'), content = child(node, 'sdtContent'), end = child(node, 'sdtEndPr');
    if (!pr || !content) fail('missing properties or contents');
    attributes(pr); attributes(content);
    const names = new Set();
    for (const p of children(pr)) {
      const key = p.namespaceURI + ':' + p.localName;
      if (names.has(key)) fail('duplicate properties'); names.add(key);
      if (p.namespaceURI === W15 && p.localName === 'appearance') {
        leaf(p, ['val'], W15);
        if (p.getAttributeNS(W15, 'val') !== 'hidden') fail('visible control adornments');
      } else if (p.namespaceURI === W15 && p.localName === 'dataBinding') {
        leaf(p, ['prefixMappings', 'xpath', 'storeItemID']);
        readUnresolvedBinding(p);
      } else if (p.namespaceURI !== W) fail('unknown property extensions');
      else if (['temporary', 'showingPlcHdr'].includes(p.localName)) on(p);
      else if (['richText', 'picture'].includes(p.localName)) leaf(p);
      else if (p.localName === 'text') {
        leaf(p, ['multiLine']);
        const value = p.getAttributeNS(W, 'multiLine');
        if (value !== null && !['true', 'false', '1', '0', 'on', 'off'].includes(value)) fail('invalid plain-text multiLine boolean');
      }
      else if (p.localName === 'rPr') readRunProperties(p);
      else if (['alias', 'tag', 'id', 'lock'].includes(p.localName)) {
        leaf(p, ['val']); const value = p.getAttributeNS(W, 'val');
        if (value === null) fail(`missing ${p.localName} value`);
        if (p.localName === 'lock' && value !== 'unlocked') fail('locked contents or wrappers');
        if (p.localName === 'id') {
          if (!/^[+-]?\d+$/.test(value) || !Number.isInteger(Number(value)) || Number(value) < -2147483648 || Number(value) > 2147483647 || ids.has(Number(value))) fail('invalid or duplicate identifiers');
          ids.add(Number(value));
        }
      } else if (p.localName === 'placeholder') {
        attributes(p); const part = child(p, 'docPart');
        if (children(p).length !== 1 || !part) fail('invalid placeholder reference');
        leaf(part, ['val']); if (!part.getAttributeNS(W, 'val')) fail('missing placeholder reference');
      } else if (p.localName === 'docPartObj') {
        // Saved building-block contents are editable independently of the
        // gallery/category metadata (ECMA-376 Part 1 §17.5.2.13).
        attributes(p);
        const order = ['docPartGallery', 'docPartCategory', 'docPartUnique'];
        const seen = new Set();
        for (const item of children(p)) {
          const index = item.namespaceURI === W ? order.indexOf(item.localName) : -1;
          // Some producers write docPartUnique before docPartCategory, unlike the
          // schema sequence. These independent properties retain their order
          // in the saved shell; accept either ordering without losing metadata.
          if (index < 0 || seen.has(index)) fail('unknown or duplicate document-part properties');
          seen.add(index);
          if (item.localName === 'docPartUnique') on(item);
          else { leaf(item, ['val']); if (item.getAttributeNS(W, 'val') === null) fail('missing document-part value'); }
        }
      } else fail(`unsupported ${p.localName} properties`);
    }
    const persistent = !on(child(pr, 'temporary'));
    const hiddenAppearance = children(pr).some(p => p.namespaceURI === W15 && p.localName === 'appearance');
    const placeholder = on(child(pr, 'showingPlcHdr'));
    const plain = child(pr, 'text'), picture = child(pr, 'picture');
    if (['text', 'richText', 'picture', 'docPartObj'].filter(name => child(pr, name)).length > 1) fail('conflicting content types');
    if (picture && kind !== 'inline') fail('picture block wrappers');
    if (end) {
      attributes(end);
      if (children(end).length > 1 || children(end).some(p => p.namespaceURI !== W || p.localName !== 'rPr')) fail('unsupported end properties');
      for (const p of children(end)) readRunProperties(p);
    }
    // A rich-text control may hold a comment's range ends and its reference mark (§17.13.4).
    const commentable = kind === 'inline' && !plain && !picture;
    const allowed = kind === 'cell' ? ['tc'] : kind === 'block' ? ['p', 'tbl', 'sdt', 'bookmarkStart', 'bookmarkEnd'] : ['r', 'hyperlink', 'proofErr', 'bookmarkStart', 'bookmarkEnd', ...(commentable ? ['commentRangeStart', 'commentRangeEnd'] : [])];
    const emptyRichInline = kind === 'inline' && persistent && !plain && !picture;
    // Tracked insertions and deletions (§17.13.5) wrap a text control's runs, as the editor
    // itself writes them when changes are tracked inside the control; check the runs they hold.
    const inlineItems = kind === 'inline' && !picture ? trackedRuns(children(content)) : children(content);
    if (inlineItems === null || !children(content).length && !emptyRichInline || inlineItems.some(r => r.namespaceURI !== W || !allowed.includes(r.localName))) fail('empty or unsupported contents');
    if (kind === 'cell' && children(content).length !== 1) fail('cell wrappers without exactly one cell');
    if (persistent && kind === 'cell' && children(child(content, 'tc')).some(n => n.namespaceURI === W && ['tbl', 'sdt'].includes(n.localName))) fail('persistent controls around tables or nested blocks');
    if (plain) {
      const container = kind === 'cell' ? child(content, 'tc') : content;
      const paragraphs = kind === 'inline' ? [] : children(container).filter(n => n.namespaceURI === W && n.localName === 'p');
      // Rich, multi-paragraph placeholder caches are permitted even though
      // actual plain-text contents must stay in a single paragraph/cell.
      // Typing replaces the cache; formatting still targets the whole control.
      if (kind !== 'inline' && (!paragraphs.length || paragraphs.length !== 1 && !placeholder || children(container).some(n => n.namespaceURI !== W || !['p', ...(kind === 'cell' ? ['tcPr'] : [])].includes(n.localName)))) fail('plain-text controls spanning multiple paragraphs or tables');
      const runs = kind === 'inline' ? inlineItems : paragraphs.flatMap(p => children(p)).filter(n => n.localName !== 'pPr');
      if (!runs.length || runs.some(n => n.namespaceURI !== W || !['r', 'proofErr', 'bookmarkStart', 'bookmarkEnd'].includes(n.localName))) fail('non-text plain-control contents');
      for (const r of runs.filter(n => n.localName === 'r')) if (children(r).some(n => n.namespaceURI !== W || !['rPr', deletedRun(r) ? 'delText' : 't', 'tab', 'br', 'cr', 'lastRenderedPageBreak'].includes(n.localName))) fail('non-text plain-control runs');
      const formats = runs.filter(n => n.localName === 'r').map(r => readRunProperties(child(r, 'rPr')));
      const signature = r => JSON.stringify([r.styleId, r.directFormat]);
      if (!placeholder && formats.some(r => signature(r) !== signature(formats[0]))) fail('mixed formatting in a plain-text control');
    }
    if (picture) {
      const runs = children(content);
      if (runs.some(r => r.namespaceURI !== W || r.localName !== 'r' || children(r).some(n => n.namespaceURI !== W || !['rPr', 'drawing'].includes(n.localName)))) fail('non-picture control contents');
      const drawings = runs.flatMap(r => children(r).filter(n => n.localName === 'drawing'));
      const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
      const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
      if (!drawings.length || drawings.some(d => {
        const data = [...d.getElementsByTagNameNS(A, 'graphicData')];
        return data.length !== 1 || data[0].getAttribute('uri') !== PIC || children(data[0]).length !== 1 || children(data[0])[0].namespaceURI !== PIC || children(data[0])[0].localName !== 'pic';
      })) fail('non-picture control drawings');
    }
    // The drawing reader still validates each picture's supported contents.
    if (kind === 'inline') for (const item of inlineItems) {
      if (['bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd'].includes(item.localName)) continue;
      const runs = item.localName === 'hyperlink' ? trackedRuns(children(item)) : [item];
      if (!runs?.length || runs.some(r => r.namespaceURI !== W || !['r', 'proofErr', 'bookmarkStart', 'bookmarkEnd'].includes(r.localName))) fail('unsupported hyperlink contents');
      for (const r of runs) {
        if (r.localName === 'proofErr') {
          // Spelling/grammar range markers are annotations, not control text.
          // Keep them in the retained shell; they impose no editing lock.
          leaf(r, ['type']);
          if (!['spellStart', 'spellEnd', 'gramStart', 'gramEnd'].includes(r.getAttributeNS(W, 'type'))) fail('invalid proofing marker type');
        } else if (r.localName === 'r' && children(r).some(t => t.namespaceURI !== W || !['rPr', deletedRun(r) ? 'delText' : 't', 'tab', 'br', 'cr', 'lastRenderedPageBreak', ...(!plain&&!picture?['fldChar','instrText','commentReference']:[]), ...(persistent || picture ? ['drawing'] : [])].includes(t.localName))) fail('non-text contents');
      }
    }
    const prompt = persistent && !picture ? placeholderRuns(child(child(pr, 'placeholder'), 'docPart')?.getAttributeNS(W, 'val'), kind) : undefined;
    return { content, control: { id: `sdt${++count}`, shell: serializeFragment(node), ...(hiddenAppearance ? { hiddenAppearance: true } : {}), ...(picture ? { picture: true } : {}), ...(plain ? { plainText: true, multiLine: ['true', '1', 'on'].includes(plain.getAttributeNS(W, 'multiLine')) } : {}), ...(persistent ? { persistent: true, ...(prompt ? { ...(kind !== 'inline' ? { placeholderParagraphs: prompt.runs } : { placeholderRuns: prompt.runs }), ...(prompt.bookmarks.some(p => p.length) ? { placeholderBookmarks: prompt.bookmarks } : {}) } : {}) } : {}), placeholder, inputRun: readRunProperties(child(pr, 'rPr')) } };
  };
}
