// The document's view setting in the settings part: w:view (ECMA-376 Part 1 §17.15.1.92, ST_View
// §17.18.102). The editor opens a document in the view it was saved in and records the view the user
// chose when the document is saved. Only w:view is read or written here; every other setting, and the
// rest of the package, is kept byte for byte.
import { strToU8 } from 'fflate';
import { parseXml } from './docx-xml.js';
import { relatedPartPath } from './docx-relationships.js';
import { viewFromSetting, settingFromView } from './document-views.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SETTINGS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings';
const SETTINGS_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml';
/** CT_Settings children that precede w:view. */
const BEFORE_VIEW = new Set(['writeProtection']);

const serialize = doc => new XMLSerializer().serializeToString(doc).replace(/^(<\?xml[^?]*encoding=)["'][^"']*["']/i, '$1"UTF-8"');
const wChildren = node => [...(node?.children || [])].filter(n => n.namespaceURI === W);
const settingsPart = parts => { try { return relatedPartPath(parts, 'settings'); } catch { return null; } };

/** The saved view: 'print' | 'web' | 'outline' | 'draft', or null when the document does not say. */
export function readDocumentView(parts) {
  const path = settingsPart(parts);
  if (!path) return null;
  try {
    const view = wChildren(parseXml(parts[path]).documentElement).find(n => n.localName === 'view');
    return view ? viewFromSetting(view.getAttributeNS(W, 'val') ?? view.getAttribute('w:val')) : null;
  } catch { return null; }
}

/**
 * Record `kind` as the document's view. A view without an ST_View value (Read Mode) leaves the setting
 * alone, and Print Layout is only written over an existing setting, so a document that never named a
 * view stays as it was.
 */
export function writeDocumentView(parts, kind) {
  const value = settingFromView(kind);
  if (!value) return false;
  let path = settingsPart(parts);
  let doc;
  if (path) doc = parseXml(parts[path]);
  else {
    if (value === 'print') return false;
    path = 'word/settings.xml';
    for (let i = 1; Object.hasOwn(parts, path); i++) path = `word/settings${i}.xml`;
    doc = parseXml(`<w:settings xmlns:w="${W}"/>`);
    addSettingsPart(parts, path);
  }
  const root = doc.documentElement;
  let view = wChildren(root).find(n => n.localName === 'view');
  if (!view && value === 'print') return false;
  if (view && (view.getAttributeNS(W, 'val') ?? view.getAttribute('w:val')) === value) return false;
  if (!view) {
    view = doc.createElementNS(W, 'w:view');
    root.insertBefore(view, wChildren(root).find(n => !BEFORE_VIEW.has(n.localName)) || null);
  }
  view.setAttributeNS(W, 'w:val', value);
  parts[path] = strToU8(serialize(doc));
  return true;
}

/** A settings part for a package that had none: its relationship from the main document and its content type. */
function addSettingsPart(parts, path) {
  const relPath = 'word/_rels/document.xml.rels';
  const rels = parts[relPath] ? parseXml(parts[relPath]) : parseXml(`<Relationships xmlns="${REL}"/>`);
  const ids = new Set([...rels.documentElement.children].map(n => n.getAttribute('Id')));
  let id = 'rViewSettings';
  for (let i = 1; ids.has(id); i++) id = `rViewSettings${i}`;
  const link = rels.createElementNS(REL, 'Relationship');
  link.setAttribute('Id', id); link.setAttribute('Type', SETTINGS); link.setAttribute('Target', path.slice('word/'.length));
  rels.documentElement.append(link);
  parts[relPath] = strToU8(serialize(rels));
  const types = parseXml(parts['[Content_Types].xml']);
  const override = types.createElementNS(types.documentElement.namespaceURI, 'Override');
  override.setAttribute('PartName', '/' + path); override.setAttribute('ContentType', SETTINGS_TYPE);
  types.documentElement.append(override);
  parts['[Content_Types].xml'] = strToU8(serialize(types));
}
