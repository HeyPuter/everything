// Reading and writing the document's hyphenation settings in the settings part
// (ECMA-376 Part 1 §17.15.1.10, .22, .37 and hyphenationZone). Only changed elements are written,
// in CT_Settings order; every other setting stays as it was.
import { HYPHENATION_DEFAULTS } from './hyphenation-settings.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
// CT_Settings children up to defaultTableStyle, in schema order.
const ORDER = ['writeProtection', 'view', 'zoom', 'removePersonalInformation', 'removeDateAndTime', 'doNotDisplayPageBoundaries', 'displayBackgroundShape', 'printPostScriptOverText', 'printFractionalCharacterWidth', 'printFormsData', 'embedTrueTypeFonts', 'embedSystemFonts', 'saveSubsetFonts', 'saveFormsData', 'mirrorMargins', 'alignBordersAndEdges', 'bordersDoNotSurroundHeader', 'bordersDoNotSurroundFooter', 'gutterAtTop', 'hideSpellingErrors', 'hideGrammaticalErrors', 'activeWritingStyle', 'proofState', 'formsDesign', 'attachedTemplate', 'linkStyles', 'stylePaneFormatFilter', 'stylePaneSortMethod', 'documentType', 'mailMerge', 'revisionView', 'trackRevisions', 'doNotTrackMoves', 'doNotTrackFormatting', 'documentProtection', 'autoFormatOverride', 'styleLockTheme', 'styleLockQFSet', 'defaultTabStop', 'autoHyphenation', 'consecutiveHyphenLimit', 'hyphenationZone', 'doNotHyphenateCaps', 'showEnvelope', 'summaryLength', 'clickAndTypeStyle', 'defaultTableStyle'];
const UNITS = { mm: 1440 / 25.4, cm: 1440 / 2.54, in: 1440, pt: 20, pc: 240, pi: 240 };

const own = (root, name) => [...(root?.children || [])].filter(n => n.namespaceURI === W && n.localName === name);
const val = node => node?.getAttributeNS(W, 'val')?.trim() ?? null;
function onOff(node) {
  if (!node) return null;
  const value = val(node);
  return value === null || !['0', 'false', 'off'].includes(value);
}
function twips(value) {
  if (value === null) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^(\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)$/.exec(value);
  return match ? Math.round(Number(match[1]) * UNITS[match[2]]) : null;
}

/**
 * The settings in a settings root (or null), with the defaults the specification gives for
 * omitted elements. A malformed value falls back to its default; the element itself is
 * retained unless the user changes that setting.
 */
export function readHyphenationSettings(root) {
  const result = { ...HYPHENATION_DEFAULTS };
  if (!root) return result;
  for (const key of ['autoHyphenation', 'doNotHyphenateCaps']) {
    const node = own(root, key)[0];
    if (node) result[key] = onOff(node);
  }
  const zone = twips(val(own(root, 'hyphenationZone')[0]));
  if (zone !== null && zone <= 31680) result.hyphenationZone = zone;
  const limit = val(own(root, 'consecutiveHyphenLimit')[0]);
  if (limit !== null && /^\+?\d+$/.test(limit) && Number(limit) <= 32767) result.consecutiveHyphenLimit = Number(limit);
  return result;
}

function ensure(root, name) {
  const existing = own(root, name)[0];
  if (existing) return existing;
  const node = root.ownerDocument.createElementNS(W, 'w:' + name), at = ORDER.indexOf(name);
  const before = [...root.children].find(n => !(n.namespaceURI === W && ORDER.indexOf(n.localName) >= 0 && ORDER.indexOf(n.localName) < at));
  root.insertBefore(node, before || null);
  return node;
}

/** Write the settings that differ from `initial` into the settings root; returns whether anything changed. */
export function writeHyphenationSettings(root, settings, initial = HYPHENATION_DEFAULTS) {
  let changed = false;
  for (const key of ['autoHyphenation', 'doNotHyphenateCaps']) {
    if (settings[key] === initial[key]) continue;
    changed = true;
    if (settings[key]) ensure(root, key).removeAttributeNS(W, 'val');
    else for (const node of own(root, key)) node.remove();
  }
  if (settings.consecutiveHyphenLimit !== initial.consecutiveHyphenLimit) {
    changed = true;
    if (settings.consecutiveHyphenLimit) ensure(root, 'consecutiveHyphenLimit').setAttributeNS(W, 'w:val', String(settings.consecutiveHyphenLimit));
    else for (const node of own(root, 'consecutiveHyphenLimit')) node.remove();
  }
  if (settings.hyphenationZone !== initial.hyphenationZone) {
    changed = true;
    if (settings.hyphenationZone === HYPHENATION_DEFAULTS.hyphenationZone && !own(root, 'hyphenationZone').length) return changed;
    ensure(root, 'hyphenationZone').setAttributeNS(W, 'w:val', String(settings.hyphenationZone));
  }
  return changed;
}
