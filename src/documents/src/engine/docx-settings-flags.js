// On/off document settings in the settings part (CT_Settings, §17.15.1). Elements are placed in
// schema order; the rest of the part is left exactly as it was.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** The element order of CT_Settings (ECMA-376 Part 1, §17.15.1.78). */
export const SETTINGS_ORDER = ['writeProtection', 'view', 'zoom', 'removePersonalInformation', 'removeDateAndTime', 'doNotDisplayPageBoundaries', 'displayBackgroundShape', 'printPostScriptOverText', 'printFractionalCharacterWidth', 'printFormsData', 'embedTrueTypeFonts', 'embedSystemFonts', 'saveSubsetFonts', 'saveFormsData', 'mirrorMargins', 'alignBordersAndEdges', 'bordersDoNotSurroundHeader', 'bordersDoNotSurroundFooter', 'gutterAtTop', 'hideSpellingErrors', 'hideGrammaticalErrors', 'activeWritingStyle', 'proofState', 'formsDesign', 'attachedTemplate', 'linkStyles', 'stylePaneFormatFilter', 'stylePaneSortMethod', 'documentType', 'mailMerge', 'revisionView', 'trackRevisions', 'doNotTrackMoves', 'doNotTrackFormatting', 'documentProtection', 'autoFormatOverride', 'styleLockTheme', 'styleLockQFSet', 'defaultTabStop', 'autoHyphenation', 'consecutiveHyphenLimit', 'hyphenationZone', 'doNotHyphenateCaps', 'showEnvelope', 'summaryLength', 'clickAndTypeStyle', 'defaultTableStyle', 'evenAndOddHeaders', 'bookFoldRevPrinting', 'bookFoldPrinting', 'bookFoldPrintingSheets', 'drawingGridHorizontalSpacing', 'drawingGridVerticalSpacing', 'displayHorizontalDrawingGridEvery', 'displayVerticalDrawingGridEvery', 'doNotUseMarginsForDrawingGridOrigin', 'drawingGridHorizontalOrigin', 'drawingGridVerticalOrigin', 'doNotShadeFormData', 'noPunctuationKerning', 'characterSpacingControl', 'printTwoOnOne', 'strictFirstAndLastChars', 'noLineBreaksAfter', 'noLineBreaksBefore', 'savePreviewPicture', 'doNotValidateAgainstSchema', 'saveInvalidXml', 'ignoreMixedContent', 'alwaysShowPlaceholderText', 'doNotDemarcateInvalidXml', 'saveXmlDataOnly', 'useXSLTWhenSaving', 'saveThroughXslt', 'showXMLTags', 'alwaysMergeEmptyNamespace', 'updateFields', 'hdrShapeDefaults', 'footnotePr', 'endnotePr', 'compat', 'docVars', 'rsids', 'attachedSchema', 'themeFontLang', 'clrSchemeMapping', 'doNotIncludeSubdocsInStats', 'doNotAutoCompressPictures', 'forceUpgrade', 'captions', 'readModeInkLockDown', 'smartTagType', 'shapeDefaults', 'doNotEmbedSmartTags', 'decimalSymbol', 'listSeparator'];

const isOn = node => !node.hasAttributeNS(W, 'val') || ['1', 'true', 'on'].includes(node.getAttributeNS(W, 'val').trim());

/** Insert a settings child before the first later element of CT_Settings; unknown elements stay put. */
export function insertSetting(root, node) {
  const at = SETTINGS_ORDER.indexOf(node.localName);
  const before = [...root.children].find(n => n.namespaceURI === W && SETTINGS_ORDER.indexOf(n.localName) > at);
  root.insertBefore(node, before || null);
  return node;
}

/**
 * Turn an on/off setting on (an empty element) or off (the element removed). Returns whether the
 * part changed: a value already in effect is left as it is written, including an explicit w:val.
 */
export function writeSettingsFlag(settings, name, on) {
  const root = settings.documentElement;
  const existing = [...root.children].filter(n => n.namespaceURI === W && n.localName === name);
  const current = existing.length > 0 && isOn(existing[0]);
  if (current === !!on && existing.length <= 1) return false;
  for (const node of existing) node.remove();
  if (on) insertSetting(root, settings.createElementNS(W, `w:${name}`));
  return true;
}
