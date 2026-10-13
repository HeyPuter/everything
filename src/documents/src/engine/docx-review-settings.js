// Review and protection settings (ECMA-376 Part 1 §17.15.1): documentProtection (§17.15.1.29),
// writeProtection (§17.15.1.93), hideSpellingErrors/hideGrammaticalErrors (§17.15.1.50/.49),
// revisionView (§17.15.1.69), doNotTrackMoves/doNotTrackFormatting (§17.15.1.45/.44), plus the
// document's default proofing language (§17.3.2.20 lang in docDefaults, §17.7.5.1) and locked
// styles for formatting restrictions (§17.7.4.7 locked). Only declarations that change are
// rewritten; everything else in the settings and styles parts is kept as it was.
import { strToU8 } from 'fflate';
import { parseXml } from './docx-xml.js';
import { relatedPartPath } from './docx-relationships.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const serialize = n => new XMLSerializer().serializeToString(n).replace(/^(<\?xml[^?]*encoding=)["'][^"']*["']/i, '$1"UTF-8"');
const children = node => node ? [...node.children] : [];
const child = (node, name) => children(node).find(n => n.namespaceURI === W && n.localName === name);
const flag = (node, name) => { const raw = node?.getAttributeNS(W, name); return raw === null || raw === undefined ? null : !['0', 'false', 'off'].includes(raw); };
const present = node => !!node && flag(node, 'val') !== false;

// CT_Settings members that precede defaultTabStop, in schema order.
export const SETTINGS_ORDER = ['writeProtection', 'view', 'zoom', 'removePersonalInformation', 'removeDateAndTime', 'doNotDisplayPageBoundaries', 'displayBackgroundShape', 'printPostScriptOverText', 'printFractionalCharacterWidth', 'printFormsData', 'embedTrueTypeFonts', 'embedSystemFonts', 'saveSubsetFonts', 'saveFormsData', 'mirrorMargins', 'alignBordersAndEdges', 'bordersDoNotSurroundHeader', 'bordersDoNotSurroundFooter', 'gutterAtTop', 'hideSpellingErrors', 'hideGrammaticalErrors', 'activeWritingStyle', 'proofState', 'formsDesign', 'attachedTemplate', 'linkStyles', 'stylePaneFormatFilter', 'stylePaneSortMethod', 'documentType', 'mailMerge', 'revisionView', 'trackRevisions', 'doNotTrackMoves', 'doNotTrackFormatting', 'documentProtection', 'autoFormatOverride', 'styleLockTheme', 'styleLockQFSet'];
const PASSWORD_ATTRIBUTES = ['algorithmName', 'hashValue', 'saltValue', 'spinCount', 'cryptProviderType', 'cryptAlgorithmClass', 'cryptAlgorithmType', 'cryptAlgorithmSid', 'cryptSpinCount', 'cryptProvider', 'algIdExt', 'algIdExtSource', 'cryptProviderTypeExt', 'cryptProviderTypeExtSource', 'hash', 'salt'];
const EDIT_VALUES = ['none', 'readOnly', 'comments', 'trackedChanges', 'forms'];
export const REVISION_VIEW_DEFAULTS = Object.freeze({ markup: true, comments: true, insDel: true, formatting: true, inkAnnotations: true });

function readPassword(node) {
  const out = {};
  for (const name of PASSWORD_ATTRIBUTES) { const value = node.getAttributeNS(W, name); if (value !== null) out[name] = name === 'spinCount' || name === 'cryptSpinCount' || name === 'cryptAlgorithmSid' ? Number(value) : value; }
  return out;
}

/** The review settings of a settings document (and its styles part). Missing settings take their defaults. */
export function readReviewSettings(settingsRoot, stylesRoot = null) {
  const protection = child(settingsRoot, 'documentProtection');
  const write = child(settingsRoot, 'writeProtection');
  const view = child(settingsRoot, 'revisionView');
  const edit = protection?.getAttributeNS(W, 'edit');
  const language = child(child(child(child(stylesRoot, 'docDefaults'), 'rPrDefault'), 'rPr'), 'lang');
  return {
    protection: protection ? { edit: EDIT_VALUES.includes(edit) ? edit : edit ? 'readOnly' : 'none', formatting: !!flag(protection, 'formatting'), enforcement: !!flag(protection, 'enforcement'), ...readPassword(protection) } : null,
    writeProtection: write ? { recommended: !!flag(write, 'recommended'), ...readPassword(write) } : null,
    hideSpellingErrors: present(child(settingsRoot, 'hideSpellingErrors')),
    hideGrammaticalErrors: present(child(settingsRoot, 'hideGrammaticalErrors')),
    doNotTrackMoves: present(child(settingsRoot, 'doNotTrackMoves')),
    doNotTrackFormatting: present(child(settingsRoot, 'doNotTrackFormatting')),
    revisionView: Object.fromEntries(Object.keys(REVISION_VIEW_DEFAULTS).map(key => [key, view ? flag(view, key) ?? true : true])),
    defaultLanguage: language?.getAttributeNS(W, 'val') || null,
    lockedStyles: children(stylesRoot).filter(n => n.namespaceURI === W && n.localName === 'style' && present(child(n, 'locked'))).map(n => n.getAttributeNS(W, 'styleId')).filter(Boolean),
  };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function placeSetting(root, node) {
  const at = SETTINGS_ORDER.indexOf(node.localName);
  root.insertBefore(node, children(root).find(n => n.namespaceURI !== W || !SETTINGS_ORDER.includes(n.localName) || SETTINGS_ORDER.indexOf(n.localName) > at) || null);
}
function setOnOff(doc, name, on) {
  const root = doc.documentElement;
  for (const n of children(root)) if (n.namespaceURI === W && n.localName === name) n.remove();
  if (on) placeSetting(root, doc.createElementNS(W, `w:${name}`));
}
function setProtectionElement(doc, name, record, write) {
  const root = doc.documentElement;
  const existing = child(root, name);
  if (!record) { existing?.remove(); return; }
  const node = existing || doc.createElementNS(W, `w:${name}`);
  for (const attr of [...node.attributes]) if (attr.namespaceURI === W) node.removeAttributeNode(attr);
  write(node);
  for (const key of PASSWORD_ATTRIBUTES) if (record[key] !== undefined && record[key] !== null && record[key] !== '') node.setAttributeNS(W, `w:${key}`, String(record[key]));
  if (!existing) placeSetting(root, node);
}

function openSettingsPart(parts) {
  const related = relatedPartPath(parts, 'settings');
  let path = related || 'word/settings.xml';
  if (!related) for (let i = 1; Object.hasOwn(parts, path); i++) path = `word/settings${i}.xml`;
  return { doc: related ? parseXml(parts[related]) : parseXml(strToU8(`<w:settings xmlns:w="${W}"/>`)), related, path };
}
function storeSettingsPart(parts, { doc, related, path }) {
  if (!related) {
    const relPath = 'word/_rels/document.xml.rels';
    const rels = parts[relPath] ? parseXml(parts[relPath]) : parseXml(strToU8(`<Relationships xmlns="${REL}"/>`));
    const ids = new Set(children(rels.documentElement).map(n => n.getAttribute('Id')));
    let id = 'rSettings'; while (ids.has(id)) id += '_';
    const rel = rels.createElementNS(REL, 'Relationship');
    rel.setAttribute('Id', id); rel.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings'); rel.setAttribute('Target', path.slice('word/'.length));
    rels.documentElement.append(rel); parts[relPath] = strToU8(serialize(rels));
    const types = parseXml(parts['[Content_Types].xml']);
    const type = types.createElementNS(types.documentElement.namespaceURI, 'Override');
    type.setAttribute('PartName', '/' + path); type.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml');
    types.documentElement.append(type); parts['[Content_Types].xml'] = strToU8(serialize(types));
  }
  parts[path] = strToU8(serialize(doc));
}

/**
 * Write the review settings that differ from `initial` into `parts` (mutated). Returns true when
 * anything was written. Unchanged settings never cause the settings or styles part to be reserialized.
 */
export function writeReviewSettings(parts, next, initial) {
  if (!next) return false;
  let changed = false;
  const settingsKeys = ['protection', 'writeProtection', 'hideSpellingErrors', 'hideGrammaticalErrors', 'doNotTrackMoves', 'doNotTrackFormatting', 'revisionView'];
  if (settingsKeys.some(key => !same(next[key], initial?.[key]))) {
    const part = openSettingsPart(parts), doc = part.doc;
    if (!same(next.protection, initial?.protection)) setProtectionElement(doc, 'documentProtection', next.protection, node => {
      const p = next.protection;
      if (p.edit && p.edit !== 'none') node.setAttributeNS(W, 'w:edit', p.edit);
      if (p.formatting) node.setAttributeNS(W, 'w:formatting', '1');
      node.setAttributeNS(W, 'w:enforcement', p.enforcement ? '1' : '0');
    });
    if (!same(next.writeProtection, initial?.writeProtection)) setProtectionElement(doc, 'writeProtection', next.writeProtection, node => { if (next.writeProtection.recommended) node.setAttributeNS(W, 'w:recommended', '1'); });
    for (const key of ['hideSpellingErrors', 'hideGrammaticalErrors', 'doNotTrackMoves', 'doNotTrackFormatting']) if (!!next[key] !== !!initial?.[key]) setOnOff(doc, key, !!next[key]);
    if (!same(next.revisionView, initial?.revisionView)) {
      const view = { ...REVISION_VIEW_DEFAULTS, ...next.revisionView };
      const root = doc.documentElement;
      for (const n of children(root)) if (n.namespaceURI === W && n.localName === 'revisionView') n.remove();
      if (Object.entries(view).some(([key, value]) => value !== REVISION_VIEW_DEFAULTS[key])) {
        const node = doc.createElementNS(W, 'w:revisionView');
        for (const [key, value] of Object.entries(view)) if (!value) node.setAttributeNS(W, `w:${key}`, '0');
        placeSetting(root, node);
      }
    }
    storeSettingsPart(parts, part);
    changed = true;
  }
  const stylesPath = relatedPartPath(parts, 'styles');
  const languageChanged = (next.defaultLanguage || null) !== (initial?.defaultLanguage || null);
  const locksChanged = !same([...(next.lockedStyles || [])].sort(), [...(initial?.lockedStyles || [])].sort());
  if (stylesPath && parts[stylesPath] && (languageChanged || locksChanged)) {
    const doc = parseXml(parts[stylesPath]), root = doc.documentElement;
    const make = name => doc.createElementNS(W, `w:${name}`);
    if (languageChanged) {
      let defaults = child(root, 'docDefaults');
      if (!defaults) { defaults = make('docDefaults'); root.insertBefore(defaults, root.firstElementChild); }
      let rDefault = child(defaults, 'rPrDefault');
      if (!rDefault) { rDefault = make('rPrDefault'); defaults.prepend(rDefault); }
      let rPr = child(rDefault, 'rPr');
      if (!rPr) { rPr = make('rPr'); rDefault.append(rPr); }
      let lang = child(rPr, 'lang');
      if (next.defaultLanguage) {
        if (!lang) { lang = make('lang'); rPr.insertBefore(lang, children(rPr).find(n => n.namespaceURI === W && ['eastAsianLayout', 'specVanish', 'oMath', 'rPrChange'].includes(n.localName)) || null); }
        lang.setAttributeNS(W, 'w:val', next.defaultLanguage);
      } else if (lang) { lang.removeAttributeNS(W, 'val'); if (!lang.attributes.length) lang.remove(); }
    }
    if (locksChanged) {
      const locked = new Set(next.lockedStyles || []);
      const order = ['name', 'aliases', 'basedOn', 'next', 'link', 'autoRedefine', 'hidden', 'uiPriority', 'semiHidden', 'unhideWhenUsed', 'qFormat', 'locked'];
      for (const style of children(root).filter(n => n.namespaceURI === W && n.localName === 'style')) {
        const id = style.getAttributeNS(W, 'styleId'), node = child(style, 'locked');
        if (locked.has(id) && !present(node)) {
          node?.remove();
          style.insertBefore(make('locked'), children(style).find(n => n.namespaceURI !== W || !order.includes(n.localName)) || null);
        } else if (!locked.has(id) && node) node.remove();
      }
    }
    parts[stylesPath] = strToU8(serialize(doc));
    changed = true;
  }
  return changed;
}
