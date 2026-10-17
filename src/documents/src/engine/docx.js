import { writeTableStyleDefinition } from './docx-table-styles.js';
import { MAX_DOCUMENT_CHARACTERS, DOCUMENT_CHARACTER_LIMIT_MESSAGE } from './text-limits.js';
import { pruneReleasedMedia } from './docx-media-release.js';
import { invalidateProofingState } from './docx-proofing-state.js';
import { completedSpelling, bodySpellingCache, proofingFingerprint } from './docx-proofing-cache.js';
import { retainSectionStoryReferences } from './section-story-edit.js';
import { readPreviewProperties } from './docx-property-recovery.js';
import { drawingTextFrames, sceneAtPath, drawingBranchOwnership } from './drawing-text-edit.js';
import { drawingImageCorrespondence, drawingTextSourcePart } from './drawing-image-correspondence.js';
import { textBox } from './docx-shapes.js';
import { recoverStyleIdentities, recoverStyleInheritance } from './docx-style-identities.js';
import { inlineDrawingPlaceholder } from './docx-drawing-preview.js';
import { readPageBorders, writePageBorders } from './docx-page-borders.js';
import { readPageBackground } from './docx-page-background.js';
import { writeSettingsFlag } from './docx-settings-flags.js';
import { readHyphenationSettings, writeHyphenationSettings } from './docx-hyphenation.js';
import { HYPHENATION_KEYS, withoutHyphenation } from './hyphenation-settings.js';
import { readTextFill, writeTextFill } from './text-fill.js';
import { readText3d, writeText3d } from './text-3d.js';
import { readTextShadow, writeTextShadow } from './text-shadow.js';
import { readTextOutline, writeTextOutline, W14 } from './text-outline.js';
import { readSectionColumns } from './section-columns.js';
import { fontReader, writeFontProperties, removeFontProperty } from './docx-fonts.js';
import { FONT_DEFAULTS } from './font-families.js';
import { previewParagraphs } from './docx-preview.js';
import { recordPreviewIssue } from './preview-issues.js';
import { previewMacroButtons, readMacroButtonField, writeMacroButtonLabel } from './docx-macro-buttons.js';
import { formatPageNumber } from './page-numbering.js';
import { contentControlReader, projectControlContents, projectRetainedStoryControls } from './docx-content-controls.js';
import { blockControlGroups, blockControlSignature, changedBlockControls } from './block-controls.js';
import { appendControlledBlocks } from './docx-block-controls.js';
import { relatedPartPath } from './docx-relationships.js';
import { readCoreProperties, writeCoreProperties, corePropertiesPath, cleanCoreValue, CORE_FIELDS, w3cdtf } from './docx-core-properties.js';
import { readPageStories, activePageStoryPaths } from './page-stories.js';
import { pageFieldSegments, pageFieldInstruction } from './docx-page-fields.js';
import { bodyFieldReader, bodyFieldBoundary, bodyFieldSimpleShell } from './docx-body-fields.js';
import { readMailMerge, writeMailMerge } from './docx-mail-merge.js';
import { readDocumentView, writeDocumentView } from './docx-view-settings.js';
import { bodyFieldRanges } from './body-fields.js';
import { projectCachedFieldResults } from './docx-field-results.js';
import { shapeHasFields } from './shape-page-fields.js';
import { controlSignature, controlContentSignature, contentControlRanges, changedContentControls } from './content-controls.js';
import { MC, alternateBranch, activeDescendants, serializeFragment, bindUsedNamespaces } from './docx-compatibility.js';
import { readParagraphBorders, writeParagraphBorders } from './docx-paragraph-borders.js';
import { checkJustificationText } from './justification.js';
import { readParagraphShading, writeParagraphShading } from './docx-paragraph-shading.js';
import { hyperlinkReader, hyperlinkWriter, bindHyperlinkNamespaces } from './docx-hyperlinks.js';
import { hyperlinkBoundaryChanges } from './hyperlinks.js';
import { bookmarkEntries, bookmarkInlineEvents } from './bookmarks.js';
import { bookmarkReader, writeBookmark } from './docx-bookmarks.js';
import { readComments, writeComments, readCommentMarker } from './docx-comments.js';
import { isPermissionElement, readPermissionMarker } from './docx-permissions.js';
import { readReviewSettings, writeReviewSettings } from './docx-review-settings.js';
import { createPageStoryPart, writeCreatedStoryReferences, createFootnotesPart, writeTitlePages, writeEvenAndOdd, writePageNumbering } from './docx-page-story-create.js';
import { footnoteReferences, footnoteStoryPath, footnoteStoryId, noteReferences, NOTE_KINDS } from './footnotes.js';
import { readNoteSettings, writeNoteSettings, createNotesPart, separatorIds, NOTE_DEFAULTS } from './docx-notes.js';
import { isMathElement, linearMath } from './office-math.js';
import { commentMarker } from './comments.js';
import { readUnderline } from './docx-underlines.js';
import { underlinePattern } from './underlines.js';
import { readCapitalization } from './docx-capitalization.js';
import { checkedCapitalization, resolveCapitalization, capitalizationDeclarations } from './capitalization.js';
import { readStrike } from './docx-strikethrough.js';
import { checkedStrike, resolveStrike } from './strikethrough.js';
import { readLigatures, writeLigatures, readOpenTypeFeatures } from './ligatures.js';
import { readKerning } from './docx-kerning.js';
import { readContextualFlag } from './docx-contextual-spacing.js';
import { readParagraphSpacing } from './docx-paragraph-spacing.js';
import { mergeSpacing } from './line-spacing.js';
import { TAB_LEADERS } from './tab-leaders.js';
import { readPositionalTab } from './positional-tabs.js';
import { readTextScale } from './docx-text-scale.js';
import { readRunSpacing } from './docx-run-spacing.js';
import { readRunVertical } from './docx-vertical-align.js';
import { readRunBackground, rejectStyleHighlight } from './docx-backgrounds.js';
import { colorReader } from './docx-colors.js';
import { readTable, writeTable } from './docx-tables.js';
import { imageReader, imageWriter, bindImageNamespaces, WP } from './docx-images.js';
import { resizedPictureShell } from './picture-resize.js';
import { OBJECT } from './images.js';
import { isPageBasedCellPosition, isCellRelativePosition } from './positioned-images.js';
import { documentBlocks } from './tables.js';
import { emptyStyles, resolveStyledParagraph, resolveCharacterRun, styleProperties, paragraphRunStyle, styleRun } from './styles.js';
import { resolvedFormat, geometryPatch, checkedRunFormat, PARAGRAPH_FLAGS } from './formatting.js';
import { UnsupportedDocumentError } from './errors.js';
export { UnsupportedDocumentError } from './errors.js';
import { parseXml as xml, wordText } from './docx-xml.js';
import { emptyNumbering, levelFor, listMarkers } from './numbering.js';
import { readNumbering, writeNumbering } from './docx-numbering.js';
import { validateIndent, normalizeTabStops } from './paragraph-geometry.js';
import { DEFAULT_PAGE_SETTINGS, validatePageSettings } from './page-settings.js';
import { checkedLineNumbers } from './line-number-settings.js';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { paragraph, paragraphFormat, runFormat, documentText, paragraphText, PAGINATION_DEFAULTS } from './model.js';

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML = 'http://www.w3.org/XML/1998/namespace';
const serialize = node => new XMLSerializer().serializeToString(node);
const children = node => node ? [...node.children] : [];
const child = (node, name) => children(node).find(n => n.namespaceURI === W && n.localName === name);
const value = node => node?.getAttributeNS(W, 'val');
const enabled = node => node ? !['0', 'false', 'off'].includes(value(node)) : null;
const signature = p => JSON.stringify(p);

// Resolve spacing attribute-by-attribute through docDefaults, basedOn, and direct pPr.
function paragraphProperties(pPr, inherited = {}, readColor) {
  const result = { ...inherited, spacing: { ...inherited.spacing }, ind: { ...inherited.ind }, tabs: [...(inherited.tabs || [])], tabChanges: [...(inherited.tabChanges || [])] };
  const frame = child(pPr, 'framePr');
  if (frame) result.frameProperties = Object.fromEntries([...frame.attributes].filter(a => a.namespaceURI === W).map(a => [a.localName, a.value]));
  const borders = readParagraphBorders(pPr, readColor);
  if (borders !== undefined) result.paragraphBorders = borders;
  const shading = readParagraphShading(pPr, readColor);
  if (shading !== undefined) result.paragraphShading = shading;
  const outlines = children(pPr).filter(n => n.namespaceURI === W && n.localName === 'outlineLvl');
  if (outlines.length > 1) throw new UnsupportedDocumentError('duplicate outline levels');
  if (outlines.length) {
    const node = outlines[0], raw = value(node)?.trim(), level = Number(raw);
    if (!/^[+-]?\d+$/.test(raw || '') || !Number.isInteger(level) || level < 0 || level > 9 || children(node).length || [...node.attributes].some(a => a.namespaceURI === W && a.localName !== 'val')) throw new UnsupportedDocumentError('invalid outline level');
    result.outlineLevel = level;
  }
  for (const name of ['mirrorIndents', 'bidi', 'suppressLineNumbers', 'suppressAutoHyphens']) {
    const node = child(pPr, name);
    if (node) result[name] = enabled(node);
  }
  const noHyphens = child(pPr, 'suppressAutoHyphens');
  if (noHyphens) result.suppressAutoHyphens = enabled(noHyphens);
  const ind = child(pPr, 'ind');
  // First-line and hanging are mutually exclusive forms of the same indent.
  const special = ['firstLine', 'hanging', 'firstLineChars', 'hangingChars'];
  for (const pair of [['firstLine', 'hanging'], ['firstLineChars', 'hangingChars']]) {
    if (pair.some(name => ind?.hasAttributeNS(W, name))) for (const name of pair) delete result.ind[name];
  }
  for (const [logical, physical] of [['start', 'left'], ['end', 'right']]) {
    for (const suffix of ['', 'Chars']) {
      if (ind?.hasAttributeNS(W, logical + suffix) || ind?.hasAttributeNS(W, physical + suffix)) {
        result.ind[physical + suffix] = twips(ind, logical + suffix, twips(ind, physical + suffix, 0), true);
      }
    }
  }
  for (const name of special) if (ind?.hasAttributeNS(W, name)) result.ind[name] = twips(ind, name, 0);
  const tabSets = children(pPr).filter(n => n.namespaceURI === W && n.localName === 'tabs');
  if (tabSets.length > 1 || tabSets.some(n => [...n.attributes].some(a => a.namespaceURI === W) || [...n.childNodes].some(c => [3, 4].includes(c.nodeType) && c.textContent.trim()))) throw new UnsupportedDocumentError('malformed custom tab stops');
  for (const tab of children(tabSets[0])) {
    if (tab.namespaceURI !== W || tab.localName !== 'tab') throw new UnsupportedDocumentError('unknown tab stop properties');
    if (children(tab).length || tab.textContent.trim() || [...tab.attributes].some(a => a.namespaceURI === W && !['val', 'pos', 'leader'].includes(a.localName)) || tab.hasAttributeNS(W, 'leader') && !Object.hasOwn(TAB_LEADERS, tab.getAttributeNS(W, 'leader'))) throw new UnsupportedDocumentError('invalid custom tab leader or content');
    const position = twips(tab, 'pos', NaN, true), type = value(tab);
    if (!Number.isInteger(position) || Math.abs(position) > 31680 || !type) throw new UnsupportedDocumentError('invalid custom tab stops');
    result.tabs = result.tabs.filter(t => t.position !== position);
    result.tabChanges = result.tabChanges.filter(t => t.position !== position);
    result.tabChanges.push({ position, alignment: { start: 'left', end: 'right', num: 'left' }[type] || type, leader: tab.getAttributeNS(W, 'leader') || 'none', ...(type === 'num' ? { numberingOnly: true } : {}) });
    if (type !== 'clear') result.tabs.push({ position, alignment: { start: 'left', end: 'right', num: 'left' }[type] || type, leader: tab.getAttributeNS(W, 'leader') || 'none', ...(type === 'num' ? { numberingOnly: true } : {}) });
  }
  for (const name of Object.keys(PAGINATION_DEFAULTS)) {
    const node = child(pPr, name);
    if (node) {
      if (value(node) !== null && !['0', '1', 'false', 'true', 'off', 'on'].includes(value(node))) throw new UnsupportedDocumentError(`invalid ${name} value`);
      result[name] = enabled(node);
    }
  }
  const alignments = children(pPr).filter(n => n.namespaceURI === W && n.localName === 'jc'), jc = alignments[0];
  if (alignments.length > 1) throw new UnsupportedDocumentError('duplicate paragraph alignment');
  if (jc) {
    if (!value(jc) || children(jc).length || jc.textContent.trim() || [...jc.attributes].some(a => a.namespaceURI === W && a.localName !== 'val')) throw new UnsupportedDocumentError('malformed paragraph alignment');
    result.alignment = value(jc);
  }
  const contextual = readContextualFlag(pPr);
  if (contextual !== undefined) result.contextualSpacing = contextual;
  const suppressedNumbers = readContextualFlag(pPr, 'suppressLineNumbers');
  if (suppressedNumbers !== undefined) result.suppressLineNumbers = suppressedNumbers;
  result.spacing = mergeSpacing(result.spacing, readParagraphSpacing(pPr));
  return result;
}

function numberingReference(pPr, inherited = {}, inTableStyle = false) {
  const node = child(pPr, 'numPr'), result = { ...inherited };
  for (const item of children(node)) {
    if (item.namespaceURI !== W || !['ilvl', 'numId'].includes(item.localName)) throw new UnsupportedDocumentError('tracked or unsupported numbering reference');
    if (!/^\d+$/.test(value(item) || '') || !Number.isSafeInteger(Number(value(item)))) throw new UnsupportedDocumentError('invalid numbering reference');
    if (item.localName === 'ilvl') {
      if (Number(value(item)) > 8) throw new UnsupportedDocumentError('numbering levels beyond nine');
      // Style ilvl is retained despite the §17.3.1.19 omission rule, as existing documents expect.
      if (!inTableStyle) result.level = Number(value(item));
    } else result.numId = String(Number(value(item)));
  }
  return result;
}

// Keep pPr children in schema order while leaving unrelated paragraph properties intact.
const propertyOrder = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];
const retainedParagraphProperty = node => node.namespaceURI === W && ['pStyle', 'rPr', 'sectPr'].includes(node.localName);
function writeParagraphFormat(node, p, make, numbering) {
  const patch = p.shell || p.styleContext || p.paragraphPropertiesCleared ? { ...p.formatOverrides } : { ...paragraphFormat({ ...p, list: null }, numbering) };
  const writeList = p.listChanged || !p.shell && p.list && (!p.styleContext || p.list.direct);
  if (!p.shell && p.list) for (const key of ['indentLeft', 'indentRight', 'firstLine', 'tabs']) if (!(key in (p.formatOverrides || {}))) delete patch[key];
  if (!Object.keys(patch).length && !p.styleChanged && !writeList && !p.outlineLevelCleared && !p.lineSpacingCleared && !p.paragraphPropertiesCleared && !p.framePropertiesChanged) return;
  let pPr = child(node, 'pPr');
  if (!pPr) { pPr = make('pPr'); node.prepend(pPr); }
  if (p.paragraphPropertiesCleared) for (const property of children(pPr)) if (!retainedParagraphProperty(property)) property.remove();
  const ensure = name => {
    let property = child(pPr, name);
    if (!property) {
      property = make(name);
      pPr.insertBefore(property, children(pPr).find(n => propertyOrder.indexOf(n.localName) > propertyOrder.indexOf(name)) || null);
    }
    return property;
  };
  if (p.styleChanged) {
    if (p.styleId) ensure('pStyle').setAttributeNS(W, 'w:val', p.styleId); else child(pPr, 'pStyle')?.remove();
  }
  if (p.framePropertiesChanged) {
    // §17.3.1.11: rewrite the paragraph's own (direct) frame declaration,
    // attribute for attribute, as the reader produced it (e.g. drop caps).
    child(pPr, 'framePr')?.remove();
    const declared = p.styleContext ? p.styleContext.properties.frameProperties : p.frameProperties;
    if (declared) { const frame = ensure('framePr'); for (const [name, v] of Object.entries(declared)) frame.setAttributeNS(W, `w:${name}`, String(v)); }
  }
  if (writeList) {
    const numPr = ensure('numPr'); numPr.replaceChildren();
    if (p.list) { const level = make('ilvl'); level.setAttributeNS(W, 'w:val', String(p.list.level)); numPr.append(level); }
    const id = make('numId'); id.setAttributeNS(W, 'w:val', p.list?.numId || '0'); numPr.append(id);
  }
  for (const key of [...Object.keys(PAGINATION_DEFAULTS), 'contextualSpacing', ...Object.keys(PARAGRAPH_FLAGS)]) if (key in patch) ensure(key).setAttributeNS(W, 'w:val', patch[key] ? '1' : '0');
  if ('paragraphBorders' in patch) writeParagraphBorders(ensure('pBdr'), patch.paragraphBorders, make);
  if ('paragraphShading' in patch) writeParagraphShading(ensure('shd'), patch.paragraphShading);
  if ('alignment' in patch) ensure('jc').setAttributeNS(W, 'w:val', patch.alignment);
  if (p.outlineLevelCleared) child(pPr, 'outlineLvl')?.remove();
  if ('outlineLevel' in patch) ensure('outlineLvl').setAttributeNS(W, 'w:val', String(patch.outlineLevel));
  const format = { ...paragraphFormat({ ...p, list: null }, numbering) };
  if (['indentLeft', 'indentRight', 'firstLine'].some(k => k in patch)) {
    const ind = ensure('ind');
    for (const [key, physical, logical] of [['indentLeft', 'left', 'start'], ['indentRight', 'right', 'end']]) if (key in patch) {
      // Both spellings keep the override effective for older and newer consumers.
      for (const name of [physical, logical]) ind.setAttributeNS(W, `w:${name}`, String(format[key]));
    }
    if ('firstLine' in patch) {
      for (const name of ['firstLine', 'hanging']) ind.removeAttributeNS(W, name);
      ind.setAttributeNS(W, format.firstLine < 0 ? 'w:hanging' : 'w:firstLine', String(Math.abs(format.firstLine)));
    }
  }
  if ('tabs' in patch) {
    const tabs = ensure('tabs');
    tabs.replaceChildren();
    const stops = normalizeTabStops(format.tabs);
    const records = [
      ...[...new Set([...(p.inheritedTabPositions || []), ...(p.list ? (levelFor(numbering, p.list).geometry.tabs || []).map(t => t.position) : [])])].filter(position => !stops.some(t => t.position === position)).map(position => ({ position, alignment: 'clear' })),
      ...stops,
    ].sort((a, b) => a.position - b.position);
    for (const stop of records) {
      const tab = make('tab');
      tab.setAttributeNS(W, 'w:val', stop.numberingOnly ? 'num' : stop.alignment); tab.setAttributeNS(W, 'w:pos', String(stop.position));
      if (stop.leader) tab.setAttributeNS(W, 'w:leader', stop.leader);
      tabs.append(tab);
    }
    if (!records.length) tabs.remove();
  }
  if (p.lineSpacingCleared) {
    const spacing = child(pPr, 'spacing');
    for (const name of ['line', 'lineRule']) spacing?.removeAttributeNS(W, name);
    if (spacing && !spacing.attributes.length) spacing.remove();
  }
  if (['lineSpacing', 'lineRule', 'spaceBefore', 'spaceAfter'].some(k => k in patch)) {
    const spacing = ensure('spacing');
    if ('lineSpacing' in patch || 'lineRule' in patch) {
      spacing.setAttributeNS(W, 'w:line', String(Math.round(format.lineSpacing * (format.lineRule === 'auto' ? 240 : 20))));
      spacing.setAttributeNS(W, 'w:lineRule', format.lineRule);
    }
    for (const side of ['Before', 'After']) if (`space${side}` in patch) {
      const name = side.toLowerCase();
      spacing.setAttributeNS(W, `w:${name}`, String(Math.round(format[`space${side}`] * 20)));
      // Explicitly turn off inherited line/automatic spacing so the point
      // edit survives reopening in other applications as well as in this editor.
      spacing.setAttributeNS(W, `w:${name}Lines`, '0');
      spacing.setAttributeNS(W, `w:${name}Autospacing`, '0');
    }
  }
}

function readCharacterStyle(rPr) {
  const references = children(rPr).filter(n => n.namespaceURI === W && n.localName === 'rStyle');
  if (references.length > 1) throw new UnsupportedDocumentError('duplicate character style references');
  if (references[0] && value(references[0]) === null) throw new UnsupportedDocumentError('a character style reference without an ID');
  return value(references[0]);
}
const hasDirectProperties = rPr => children(rPr).some(n => n.namespaceURI !== W || n.localName !== 'rStyle');

// Read absolute declarations. Style toggle combination is applied once per hierarchy level.
function runProperties(rPr, inherited = runFormat(), readColor, readFonts) {
  const result = { ...inherited, ...readFonts?.(rPr) };
  Object.assign(result, readTextFill(rPr, readColor));
  for (const [key, tag] of [['bold', 'b'], ['italic', 'i'], ['boldCs', 'bCs'], ['italicCs', 'iCs']]) {
    const flag = enabled(child(rPr, tag));
    if (flag !== null) result[key] = flag;
  }
  Object.assign(result, readTextOutline(rPr, readColor), readTextShadow(rPr, readColor), readText3d(rPr));
  Object.assign(result, readRunBackground(rPr, readColor), readRunVertical(rPr), readRunSpacing(rPr), readTextScale(rPr), readKerning(rPr), readLigatures(rPr), readStrike(rPr), readCapitalization(rPr));
  const color = readColor?.(rPr); if (color !== undefined) result.color = color;
  for (const [key, tag] of [['fontSize', 'sz'], ['fontSizeCs', 'szCs']]) {
    const size = child(rPr, tag);
    if (size) result[key] = Number(value(size)) / 2;
  }
  Object.assign(result, readUnderline(rPr, readColor));
  for (const tag of ['cs', 'rtl', 'vanish']) {
    const flag = enabled(child(rPr, tag));
    if (flag !== null) result[tag] = flag;
  }
  for (const tag of ['webHidden', 'noProof']) {
    const flag = readContextualFlag(rPr, tag);
    if (flag !== undefined) result[tag] = flag;
  }
  return result;
}
const runOrder = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange'];
function writeRunFormat(properties, patch, make, inheritedStrike = 'none', inheritedCaps = 'normal') {
  if (Object.keys(FONT_DEFAULTS).some(key => key in patch)) {
    properties ||= make('rPr');
    const ensure = tag => {
      let node = child(properties, tag);
      if (!node) {
        node = make(tag);
        properties.insertBefore(node, children(properties).find(n => runOrder.indexOf(n.localName) > runOrder.indexOf(tag)) || null);
      }
      return node;
    };
    writeFontProperties(patch, ensure);
  }
  if ('capitalization' in patch) {
    properties ||= make('rPr');
    const mode = patch.capitalization, base = inheritedCaps === 'smallCaps' ? 'smallCaps' : 'caps';
    const tag = mode === 'normal' ? base : mode.startsWith('smallCaps') ? 'smallCaps' : 'caps';
    for (const n of children(properties)) if (n.namespaceURI === W && ['caps', 'smallCaps'].includes(n.localName)) n.remove();
    for (const declaration of capitalizationDeclarations(mode)) {
      const name = declaration === 'normal' ? tag : declaration.startsWith('smallCaps') ? 'smallCaps' : 'caps';
      const node = make(name); node.setAttributeNS(W, 'w:val', ['caps', 'smallCaps'].includes(declaration) ? '1' : '0');
      properties.insertBefore(node, children(properties).find(n => runOrder.indexOf(n.localName) > runOrder.indexOf(name)) || null);
    }
  }
  if ('strikethrough' in patch) {
    properties ||= make('rPr');
    const mode = patch.strikethrough, base = inheritedStrike === 'double' ? 'double' : 'single';
    const kind = mode === 'none' ? base : mode.startsWith('double') ? 'double' : 'single';
    for (const tag of ['strike', 'dstrike']) for (const n of children(properties)) if (n.namespaceURI === W && n.localName === tag) n.remove();
    const tag = kind === 'single' ? 'strike' : 'dstrike', node = make(tag);
    node.setAttributeNS(W, 'w:val', mode === 'single' || mode === 'double' ? '1' : '0');
    properties.insertBefore(node, children(properties).find(n => runOrder.indexOf(n.localName) > runOrder.indexOf(tag)) || null);
  }
  for (const [key, tag] of [['bold', 'b'], ['italic', 'i'], ['boldCs', 'bCs'], ['italicCs', 'iCs'], ['fontSizeCs', 'szCs'], ['cs', 'cs'], ['rtl', 'rtl'], ['noProof', 'noProof'], ['vanish', 'vanish'], ['color', 'color'], ['characterSpacing', 'spacing'], ['textScale', 'w'], ['kerning', 'kern'], ['baselineShift', 'position'], ['fontSize', 'sz'], ['highlight', 'highlight'], ['underline', 'u'], ['shading', 'shd'], ['verticalAlign', 'vertAlign']]) {
    if (!(key in patch) && !(key === 'underline' && ('underlineColor' in patch || 'underlineStyle' in patch))) continue;
    properties ||= make('rPr');
    const old = child(properties, tag);
    const node = key === 'underline' && old ? old.cloneNode(true) : make(tag);
    for (const node of children(properties)) if (node.namespaceURI === W && node.localName === tag) node.remove();
    if (key in patch) node.setAttributeNS(W, 'w:val', key === 'shading' ? patch[key] === 'foreground' ? 'solid' : 'clear' : ['color', 'highlight', 'verticalAlign', 'textScale'].includes(key) ? patch[key] : key === 'characterSpacing' ? String(Math.round(patch[key] * 20)) : ['fontSize', 'fontSizeCs', 'baselineShift', 'kerning'].includes(key) ? String(patch[key] * 2) : key === 'underline' ? underlinePattern(patch) : patch[key] ? '1' : '0');
    if (key === 'shading') { node.setAttributeNS(W, 'w:color', 'auto'); node.setAttributeNS(W, 'w:fill', patch[key] === 'foreground' ? 'auto' : patch[key]); }
    if (key === 'underline') {
      if ('underline' in patch || 'underlineStyle' in patch) node.setAttributeNS(W, 'w:val', underlinePattern(patch));
      if ('underlineColor' in patch) {
        for (const attr of ['themeColor', 'themeTint', 'themeShade']) node.removeAttributeNS(W, attr);
        node.setAttributeNS(W, 'w:color', patch.underlineColor);
      }
    }
    properties.insertBefore(node, children(properties).find(n => runOrder.indexOf(n.localName) > runOrder.indexOf(tag)) || null);
  }
  if ('ligatures' in patch) { properties ||= make('rPr'); writeLigatures(properties, patch.ligatures); }
  if ('textFill' in patch) { properties ||= make('rPr'); writeTextFill(properties, patch.textFill); }
  if ('textShadow' in patch) { properties ||= make('rPr'); writeTextShadow(properties, patch.textShadow); }
  if ('textOutline' in patch) { properties ||= make('rPr'); writeTextOutline(properties, patch.textOutline); }
  for (const key of ['textScene', 'text3d']) if (key in patch && (properties || patch[key])) { properties ||= make('rPr'); writeText3d(properties, patch[key], key); }
  return properties;
}

function writeRunStyle(properties, id, changed, make) {
  if (!changed) return properties;
  if (!properties && !id) return null;
  properties ||= make('rPr');
  for (const node of children(properties)) if (node.namespaceURI === W && node.localName === 'rStyle') node.remove();
  if (id) { const node = make('rStyle'); node.setAttributeNS(W, 'w:val', id); properties.prepend(node); }
  return properties;
}

function twips(node, name, fallback, signed = false) {
  const raw = node?.getAttributeNS(W, name);
  if (raw === null || raw === undefined) return fallback;
  const units = /^(\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)$/.exec(raw);
  const signedUnits = /^(-?\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)$/.exec(raw);
  const match = signed || ['top', 'bottom'].includes(name) ? signedUnits : units;
  if (match) return Math.round(Number(match[1]) * { mm: 1440 / 25.4, cm: 1440 / 2.54, in: 1440, pt: 20, pc: 240, pi: 240 }[match[2]]);
  if (!/^[+-]?\d+$/.test(raw)) throw new UnsupportedDocumentError('invalid document measurements');
  return Number(raw);
}
function readPageSettings(section, settings, readColor, attempt = read => read()) {
  const size = child(section, 'pgSz'), margins = child(section, 'pgMar');
  const result = { ...DEFAULT_PAGE_SETTINGS,
    // An unsupported border affects decoration, not otherwise valid writing
    // margins, page size or columns. Preview omits only that component; strict
    // import still rejects it and export remains the untouched original.
    pageBorders: attempt(() => readPageBorders(section, readColor, attempt), null),
    bordersDoNotSurroundHeader: readContextualFlag(settings, 'bordersDoNotSurroundHeader') ?? false,
    bordersDoNotSurroundFooter: readContextualFlag(settings, 'bordersDoNotSurroundFooter') ?? false,
    sectionType: ['continuous', 'evenPage', 'oddPage'].includes(value(child(section, 'type'))) ? value(child(section, 'type')) : 'nextPage',
    width: twips(size, 'w', DEFAULT_PAGE_SETTINGS.width), height: twips(size, 'h', DEFAULT_PAGE_SETTINGS.height),
    orientation: size?.getAttributeNS(W, 'orient') || 'portrait',
    defaultTabStop: child(settings, 'defaultTabStop') ? twips(child(settings, 'defaultTabStop'), 'val', NaN) : 720,
    gutterAtTop: enabled(child(settings, 'gutterAtTop')) ?? false,
    ...readHyphenationSettings(settings),
  };
  for (const key of ['splitPgBreakAndParaMark', 'suppressSpBfAfterPgBrk', 'noTabHangInd', 'forgetLastTabAlignment']) result[key] = enabled(child(child(settings, 'compat'), key)) ?? false;
  const modes = children(child(settings, 'compat')).filter(n => n.namespaceURI === W && n.localName === 'compatSetting' && n.getAttributeNS(W, 'name') === 'compatibilityMode' && n.getAttributeNS(W, 'uri') === 'http://schemas.microsoft.com/office/word');
  if (modes.length > 1 || modes.length && !/^\d+$/.test(value(modes[0]) || '')) throw new UnsupportedDocumentError('invalid compatibility mode');
  result.compatibilityMode = modes.length ? Number(value(modes[0])) : 12;
  // Normal run kerning is retained for either noPunctuationKerning value,
  // including punctuation pairs (see the independent native reference controls).
  // Validate the declaration and preserve its original settings-part bytes.
  readContextualFlag(settings, 'noPunctuationKerning');
  // Unsupported behavior should not erase otherwise valid section geometry.
  // The strict reader still throws; display-only import records each omission.
  attempt(() => { if (readContextualFlag(child(settings, 'compat'), 'useAnsiKerningPairs')) throw new UnsupportedDocumentError('useAnsiKerningPairs'); }, null);
  for (const tag of ['suppressTopSpacing', 'suppressBottomSpacing', 'suppressSpacingAtTopOfPage']) attempt(() => { if (readContextualFlag(child(settings, 'compat'), tag)) throw new UnsupportedDocumentError(`${tag} line-spacing compatibility`); }, null);
  for (const key of ['allowSpaceOfSameStyleInTable', 'wrapTrailSpaces', 'ulTrailSpace', 'doNotExpandShiftReturn', 'doNotUseHTMLParagraphAutoSpacing']) result[key] = readContextualFlag(child(settings, 'compat'), key) ?? false;
  for (const name of ['top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter']) result[name] = twips(margins, name, result[name]);
  for (const name of ['bookFoldPrinting', 'bookFoldRevPrinting', 'mirrorMargins', 'printTwoOnOne']) result[name] = readContextualFlag(settings, name) ?? false;
  attempt(() => { if (enabled(child(section, 'rtlGutter')) || value(child(section, 'textDirection')) && value(child(section, 'textDirection')) !== 'lrTb') throw new UnsupportedDocumentError('right-to-left gutters or vertical page text'); }, null);
  const alignment = children(section).filter(n => n.namespaceURI === W && n.localName === 'vAlign');
  if (alignment.length > 1 || alignment[0] && (alignment[0].textContent.trim() || children(alignment[0]).length || [...alignment[0].attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && !(a.namespaceURI === W && a.localName === 'val')))) throw new UnsupportedDocumentError('invalid vertical page alignment');
  result.verticalAlignment = alignment.length ? value(alignment[0]) : 'top';
  // Line numbering (§17.6.8). A declaration this editor cannot use stays in the
  // retained section XML and shows no numbers rather than rejecting the page.
  result.lineNumbers = attempt(() => readLineNumbers(child(section, 'lnNumType')), null);
  const cols = child(section, 'cols');
  try {
    const columns = readSectionColumns(cols);
    if (columns.count > 1 || !columns.equalWidth) result.columns = columns;
  } catch (error) { throw new UnsupportedDocumentError(`unsupported section columns (${error.message})`); }
  try { return validatePageSettings(result); }
  catch (e) { throw new UnsupportedDocumentError(`unsupported page settings (${e.message})`); }
}
function readLineNumbers(node) {
  if (!node) return null;
  const number = (name, fallback) => {
    const raw = node.getAttributeNS(W, name);
    if (raw === null) return fallback;
    if (!/^\+?\d+$/.test(raw)) throw new UnsupportedDocumentError('invalid line numbering');
    return Number(raw);
  };
  // countBy is what makes numbers visible; without it the declaration is retained only.
  const countBy = number('countBy', 0);
  if (countBy < 1) return null;
  const restart = node.getAttributeNS(W, 'restart') || 'newPage';
  try {
    return checkedLineNumbers({ countBy: Math.min(countBy, 100), start: number('start', 0), distance: node.hasAttributeNS(W, 'distance') ? twips(node, 'distance', null) : null, restart });
  } catch (e) { throw new UnsupportedDocumentError(`unsupported line numbering (${e.message})`); }
}
function writeLineNumbers(node, settings) {
  for (const name of ['countBy', 'start', 'distance', 'restart']) node.removeAttributeNS(W, name);
  node.setAttributeNS(W, 'w:countBy', String(settings.countBy));
  if (settings.start) node.setAttributeNS(W, 'w:start', String(settings.start));
  if (settings.distance !== null) node.setAttributeNS(W, 'w:distance', String(settings.distance));
  node.setAttributeNS(W, 'w:restart', settings.restart);
}
const sectionOrder = ['headerReference', 'footerReference', 'footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders', 'lnNumType', 'pgNumType', 'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter', 'docGrid', 'printerSettings', 'sectPrChange'];
function writePageSettings(section, settings, initial, make, fresh) {
  const ensure = name => {
    let node = child(section, name);
    if (!node) {
      node = make(name);
      section.insertBefore(node, children(section).find(n => sectionOrder.indexOf(n.localName) > sectionOrder.indexOf(name)) || null);
    }
    return node;
  };
  const sizeKeys = { width: 'w', height: 'h', orientation: 'orient' };
  if (fresh && settings.pageBorders || JSON.stringify(settings.pageBorders) !== JSON.stringify(initial.pageBorders)) {
    if (settings.pageBorders) writePageBorders(ensure('pgBorders'), settings.pageBorders, make);
    else child(section, 'pgBorders')?.remove();
  }
  if (fresh && settings.lineNumbers || JSON.stringify(settings.lineNumbers) !== JSON.stringify(initial.lineNumbers)) {
    if (settings.lineNumbers) writeLineNumbers(ensure('lnNumType'), settings.lineNumbers);
    else child(section, 'lnNumType')?.remove();
  }
  if (settings.verticalAlignment !== initial.verticalAlignment || fresh && settings.verticalAlignment !== 'top') ensure('vAlign').setAttributeNS(W, 'w:val', settings.verticalAlignment);
  // How the section starts (§17.6.22); next page is the default when the element is absent.
  if (settings.sectionType !== initial.sectionType || fresh && settings.sectionType !== 'nextPage') {
    if (settings.sectionType === 'nextPage') child(section, 'type')?.remove();
    else ensure('type').setAttributeNS(W, 'w:val', settings.sectionType);
  }
  if (fresh && settings.columns || JSON.stringify(settings.columns) !== JSON.stringify(initial.columns)) {
    const cols = ensure('cols');
    for (const name of ['equalWidth', 'num', 'space', 'sep']) cols.removeAttributeNS(W, name);
    while (cols.firstChild) cols.removeChild(cols.firstChild);
    cols.setAttributeNS(W, 'w:equalWidth', settings.columns?.equalWidth === false ? '0' : '1');
    cols.setAttributeNS(W, 'w:num', String(settings.columns?.count || 1));
    cols.setAttributeNS(W, 'w:space', String(settings.columns?.space ?? 720));
    if (settings.columns?.separator) cols.setAttributeNS(W, 'w:sep', '1');
    if (settings.columns?.equalWidth === false) for (const entry of settings.columns.entries) {
      const col = make('col'); col.setAttributeNS(W, 'w:w', String(entry.width));
      col.setAttributeNS(W, 'w:space', String(entry.space)); cols.appendChild(col);
    }
  }
  const missingSize = !child(section, 'pgSz');
  for (const [key, attr] of Object.entries(sizeKeys)) if (fresh || settings[key] !== initial[key]) {
    const size = ensure('pgSz');
    if (missingSize) for (const [name, attribute] of Object.entries(sizeKeys)) size.setAttributeNS(W, `w:${attribute}`, String(settings[name]));
    size.setAttributeNS(W, `w:${attr}`, String(settings[key]));
    if (key !== 'orientation') size.removeAttributeNS(W, 'code'); // A printer paper code may no longer match the new size.
  }
  const sides = ['top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter'];
  const missingMargins = !child(section, 'pgMar');
  for (const key of sides) if (fresh || settings[key] !== initial[key]) {
    const margins = ensure('pgMar');
    if (missingMargins || fresh) for (const name of sides) margins.setAttributeNS(W, `w:${name}`, String(settings[name]));
    else margins.setAttributeNS(W, `w:${key}`, String(settings[key]));
  }
}

// CT_Settings order up to defaultTabStop. Later settings and extension markup stay in place.
const beforeDefaultTab = new Set(['writeProtection', 'view', 'zoom', 'removePersonalInformation', 'removeDateAndTime', 'doNotDisplayPageBoundaries', 'displayBackgroundShape', 'printPostScriptOverText', 'printFractionalCharacterWidth', 'printFormsData', 'embedTrueTypeFonts', 'embedSystemFonts', 'saveSubsetFonts', 'saveFormsData', 'mirrorMargins', 'alignBordersAndEdges', 'bordersDoNotSurroundHeader', 'bordersDoNotSurroundFooter', 'gutterAtTop', 'hideSpellingErrors', 'hideGrammaticalErrors', 'activeWritingStyle', 'proofState', 'formsDesign', 'attachedTemplate', 'linkStyles', 'stylePaneFormatFilter', 'stylePaneSortMethod', 'documentType', 'mailMerge', 'revisionView', 'trackRevisions', 'doNotTrackMoves', 'doNotTrackFormatting', 'documentProtection', 'autoFormatOverride', 'styleLockTheme', 'styleLockQFSet']);
function writeDefaultTabStop(parts, distance, initial, fresh) {
  if (distance === initial && (!fresh || distance === 720)) return;
  const related = relatedPartPath(parts, 'settings');
  let path = related || 'word/settings.xml';
  if (!related) for (let i = 1; Object.hasOwn(parts, path); i++) path = `word/settings${i}.xml`;
  const settings = related ? readSettings(parts) : xml(`<w:settings xmlns:w="${W}"/>`);
  const root = settings.documentElement;
  let stop = child(root, 'defaultTabStop');
  if (!stop) {
    stop = settings.createElementNS(W, 'w:defaultTabStop');
    root.insertBefore(stop, children(root).find(n => n.namespaceURI === W && !beforeDefaultTab.has(n.localName)) || null);
  }
  stop.setAttributeNS(W, 'w:val', String(distance));
  saveSettings(parts, settings, related, path);
}
function openSettings(parts) {
  const related = relatedPartPath(parts, 'settings');
  let path = related || 'word/settings.xml';
  if (!related) for (let i = 1; Object.hasOwn(parts, path); i++) path = `word/settings${i}.xml`;
  return { settings: related ? readSettings(parts) : xml(`<w:settings xmlns:w="${W}"/>`), related, path };
}
/** Turn Track Changes on or off for the document (§17.15.1.90). */
function writeTrackRevisions(parts, on) {
  const { settings, related, path } = openSettings(parts), root = settings.documentElement;
  const existing = child(root, 'trackRevisions');
  if ((!!existing && enabled(existing) !== false) === !!on) return;
  if (!on) existing.remove();
  else if (existing) existing.removeAttributeNS(W, 'val');
  else {
    const order = [...beforeDefaultTab], at = order.indexOf('trackRevisions');
    const node = settings.createElementNS(W, 'w:trackRevisions');
    root.insertBefore(node, children(root).find(n => n.namespaceURI === W && (!beforeDefaultTab.has(n.localName) || order.indexOf(n.localName) > at)) || null);
  }
  saveSettings(parts, settings, related, path);
}
function saveSettings(parts, settings, related, path) {
  if (!related) {
    const relPath = 'word/_rels/document.xml.rels';
    const rels = parts[relPath] ? xml(parts[relPath]) : xml(`<Relationships xmlns="${REL}"/>`);
    const ids = new Set(children(rels.documentElement).map(n => n.getAttribute('Id')));
    let id = 'rSettings';
    while (ids.has(id)) id += '_';
    const rel = rels.createElementNS(REL, 'Relationship');
    rel.setAttribute('Id', id); rel.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings'); rel.setAttribute('Target', path.slice('word/'.length));
    rels.documentElement.append(rel); parts[relPath] = strToU8(serialize(rels));
    const types = xml(parts['[Content_Types].xml']);
    const type = types.createElementNS(types.documentElement.namespaceURI, 'Override');
    type.setAttribute('PartName', '/' + path); type.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml');
    types.documentElement.append(type); parts['[Content_Types].xml'] = strToU8(serialize(types));
  }
  parts[path] = strToU8(serialize(settings).replace(/^(<\?xml[^?]*encoding=)["'][^"']*["']/i, '$1"UTF-8"'));
}

// Style Definitions is an implicit relationship, not a prescribed ZIP filename.
function stylesPath(parts) {
  return relatedPartPath(parts, 'styles');
}

function readSettings(parts) {
  const path = relatedPartPath(parts, 'settings');
  if (!path) return null;
  const doc = xml(parts[path]);
  if (doc.documentElement.namespaceURI !== W || doc.documentElement.localName !== 'settings') throw new UnsupportedDocumentError('an invalid settings root');
  return doc;
}

function readStyles(parts, parsed, readColor, readFonts, onUnsupported = null) {
  if (!readColor || !readFonts) {
    const settings = readSettings(parts)?.documentElement;
    readColor ||= colorReader(parts, settings); readFonts ||= fontReader(parts, settings);
  }
  const path = parsed ? null : stylesPath(parts);
  const result = emptyStyles(), doc = parsed || (path ? xml(parts[path]) : null);
  const readStyleProperties = (node, parse) => readPreviewProperties(node, parse, onUnsupported);
  const readStyleRun = (node, inherited = {}) => readStyleProperties(node, candidate => {
    rejectStyleHighlight(candidate);
    return runProperties(candidate, inherited, readColor, readFonts);
  });
  const readStyleParagraph = (node, inTableStyle = false) => readStyleProperties(node, candidate => ({
    properties: paragraphProperties(candidate, {}, readColor),
    reference: numberingReference(candidate, {}, inTableStyle),
  }));
  // The imported-text default when no sz is declared in the hierarchy.
  // Keep the editor's authored-document default separate (serialized explicitly).
  result.defaults.run.fontSize = 10;
  // An absent rPrDefault invokes application defaults (§17.7.5.5).
  // A present, even empty, category instead leaves undeclared kerning off.
  // New editor documents serialize rPrDefault and keep their authored default.
  result.defaults.run.kerning = 1;
  result.defaults.run.ligatures = 'standardContextual';
  // An omitted defaults category invokes consumer defaults; an explicitly
  // empty pPrDefault does not. These are the defaults the native reference materialized in
  // the independent default-paragraph-spacing controls, not authored values.
  const applicationParagraphDefaults = { spacing: { after: '160', line: '278', lineRule: 'auto' } };
  result.fontCharsets = readFonts.fontCharsets();
  const alternatives = readFonts.fontAlternatives();
  if (Object.keys(alternatives).length) result.fontAlternatives = alternatives;
  if (!doc) {
    result.defaults.properties = applicationParagraphDefaults; return result;
  }
  const root = doc.documentElement;
  if (root.namespaceURI !== W || root.localName !== 'styles') throw new UnsupportedDocumentError('invalid styles part');
  const defaults = child(root, 'docDefaults'), defaultP = child(child(defaults, 'pPrDefault'), 'pPr');
  if (child(defaults, 'rPrDefault')) {
    result.defaults.run.kerning = 0;
    result.defaults.run.ligatures = 'none';
  }
  const defaultParagraph = readStyleParagraph(defaultP);
  result.defaults = { ...defaultParagraph, properties: child(defaults, 'pPrDefault') ? defaultParagraph.properties : applicationParagraphDefaults, run: readStyleRun(child(child(defaults, 'rPrDefault'), 'rPr'), result.defaults.run) };
  result.defaults.run.capitalization = resolveCapitalization('normal', result.defaults.run.capitalization);
  result.defaults.run.strikethrough = resolveStrike('none', result.defaults.run.strikethrough);
  for (const node of children(root).filter(n => n.namespaceURI === W && n.localName === 'style')) {
    const id = node.getAttributeNS(W, 'styleId'), type = node.getAttributeNS(W, 'type') || 'paragraph';
    if (!id || Object.hasOwn(result.definitions, id)) throw new UnsupportedDocumentError('missing or duplicate style IDs');
    const definition = { id, type, name: value(child(node, 'name')) || id, basedOn: value(child(node, 'basedOn')), next: value(child(node, 'next')) };
    try {
      Object.assign(definition, type === 'character' ? { properties: {}, reference: {} } : readStyleParagraph(child(node, 'pPr'), type === 'table'));
      definition.run = readStyleRun(child(node, 'rPr'));
      if (type === 'table') {
        definition.conditionals = {};
        for (const region of children(node).filter(n => n.namespaceURI === W && n.localName === 'tblStylePr')) {
          const name = region.getAttributeNS(W, 'type');
          if (name === 'wholeTable') continue;
          if (!['band1Horz', 'band2Horz', 'band1Vert', 'band2Vert', 'firstCol', 'lastCol', 'firstRow', 'lastRow', 'nwCell', 'neCell', 'swCell', 'seCell'].includes(name) || Object.hasOwn(definition.conditionals, name)) throw new UnsupportedDocumentError('unknown or duplicate conditional table regions');
          const group = {};
          if (child(region, 'pPr')) {
            Object.assign(group, readStyleParagraph(child(region, 'pPr'), true));
          }
          if (child(region, 'rPr')) {
            group.run = readStyleRun(child(region, 'rPr'));
          }
          definition.conditionals[name] = group;
        }
      }
    } catch (e) { definition.error = e.message; }
    Object.defineProperty(result.definitions, id, { value: definition, enumerable: true, configurable: true, writable: true });
    if (['1', 'true', 'on'].includes(node.getAttributeNS(W, 'default'))) {
      if (type === 'paragraph') result.defaultParagraph = id;
      if (type === 'character') result.defaultCharacter = id;
      if (type === 'table') result.defaultTable = id;
    }
  }
  return result;
}

// Modify only requested declarations; retain latent styles, links and extension XML.
function writeStyles(parts, styles) {
  const changed = Object.values(styles.definitions).filter(s => s.changes || s.generated);
  const deleted = (styles.deleted || []).filter(id => !Object.hasOwn(styles.definitions, id));
  if (!changed.length && !deleted.length) return;
  const existingPath = stylesPath(parts);
  let path = existingPath || 'word/styles.xml';
  // Preserve any unrelated/orphan part occupying the conventional name.
  if (!existingPath) for (let i = 1; Object.hasOwn(parts, path); i++) path = `word/styles${i}.xml`;
  const doc = existingPath ? xml(parts[path]) : xml(`<w:styles xmlns:w="${W}"/>`), root = doc.documentElement;
  const make = name => doc.createElementNS(W, `w:${name}`);
  // Deleted styles leave the part; every other definition keeps its XML.
  for (const node of children(root)) if (node.namespaceURI === W && node.localName === 'style' && deleted.includes(node.getAttributeNS(W, 'styleId'))) node.remove();
  const order = ['name', 'aliases', 'basedOn', 'next', 'link', 'autoRedefine', 'hidden', 'uiPriority', 'semiHidden', 'unhideWhenUsed', 'qFormat', 'locked', 'personal', 'personalCompose', 'personalReply', 'rsid', 'pPr', 'rPr', 'tblPr', 'trPr', 'tcPr', 'tblStylePr'];
  for (const style of changed) {
    let node = children(root).find(n => n.namespaceURI === W && n.localName === 'style' && n.getAttributeNS(W, 'styleId') === style.id);
    if (!node) { node = make('style'); node.setAttributeNS(W, 'w:type', style.type); node.setAttributeNS(W, 'w:styleId', style.id); node.setAttributeNS(W, 'w:customStyle', '1'); root.append(node); }
    const ensure = name => {
      let n = child(node, name);
      if (!n) { n = make(name); node.insertBefore(n, children(node).find(c => order.indexOf(c.localName) > order.indexOf(name)) || null); }
      return n;
    };
    const patch = style.changes || {};
    for (const key of ['name', 'basedOn', 'next']) if (key in patch || style.generated) {
      if (style[key]) ensure(key).setAttributeNS(W, 'w:val', style[key]); else child(node, key)?.remove();
    }
    // Table styles described by a spec (New/Modify Table Style, the style library) write their whole formatting.
    if (style.type === 'table' && style.tableSpec && (style.generated || patch.table)) { writeTableStyleDefinition(node, style.tableSpec, make); continue; }
    const pp = patch.paragraph || {}, rp = patch.run || {};
    if (Object.keys(pp).length) {
      const wrapper = make('p'), properties = child(node, 'pPr')?.cloneNode(true);
      if (properties) wrapper.append(properties);
      const pPr = () => child(wrapper, 'pPr');
      for (const [key, val] of Object.entries(pp)) if (val === null) {
        const attrs = { indentLeft: ['ind', 'left', 'start'], indentRight: ['ind', 'right', 'end'], firstLine: ['ind', 'firstLine', 'hanging'], spaceBefore: ['spacing', 'before', 'beforeLines', 'beforeAutospacing'], spaceAfter: ['spacing', 'after', 'afterLines', 'afterAutospacing'], lineSpacing: ['spacing', 'line'], lineRule: ['spacing', 'lineRule'] }[key];
        if (attrs) { const n = child(pPr(), attrs[0]); for (const attr of attrs.slice(1)) n?.removeAttributeNS(W, attr); if (n && !n.attributes.length) n.remove(); }
        else child(pPr(), { alignment: 'jc', outlineLevel: 'outlineLvl', paragraphShading: 'shd', paragraphBorders: 'pBdr' }[key] || key)?.remove();
      }
      // Style line/lineRule declarations can inherit independently. The direct
      // paragraph writer intentionally authors both; do not freeze inherited
      // values (or undo an explicit removal) when editing a shared style.
      const explicit = Object.fromEntries(Object.entries(pp).filter(([k,v]) => v !== null && !['lineSpacing', 'lineRule'].includes(k)));
      writeParagraphFormat(wrapper, { shell: true, formatOverrides: explicit, format: resolvedFormat(styleProperties(styles, style.id)), inheritedTabPositions: [] }, make);
      for (const [key, attr] of [['lineSpacing', 'line'], ['lineRule', 'lineRule']]) if (key in pp && pp[key] !== null) {
        if (!pPr()) wrapper.prepend(make('pPr'));
        let spacing = child(pPr(), 'spacing');
        if (!spacing) {
          spacing = make('spacing');
          pPr().insertBefore(spacing, children(pPr()).find(n => propertyOrder.indexOf(n.localName) > propertyOrder.indexOf('spacing')) || null);
        }
        spacing.setAttributeNS(W, `w:${attr}`, style.properties.spacing[attr]);
      }
      if (pPr()) { const old = ensure('pPr'); old.replaceWith(pPr()); }
    }
    if (Object.keys(rp).length) {
      if (rp.capitalization !== undefined && rp.capitalization !== null) checkedCapitalization(rp.capitalization, true);
      if (rp.capitalization === null) for (const tag of ['caps', 'smallCaps']) child(child(node, 'rPr'), tag)?.remove();
      if (rp.strikethrough !== undefined && rp.strikethrough !== null) checkedStrike(rp.strikethrough, true);
      if (rp.strikethrough === null) for (const tag of ['strike', 'dstrike']) child(child(node, 'rPr'), tag)?.remove();
      if (rp.ligatures === null) for (const n of children(child(node, 'rPr'))) if (n.namespaceURI === W14 && n.localName === 'ligatures') n.remove();
      if (rp.textFill === null) for (const n of children(child(node, 'rPr'))) if (n.namespaceURI === W14 && n.localName === 'textFill') n.remove();
      if (rp.textShadow === null) for (const n of children(child(node, 'rPr'))) if (n.namespaceURI === W14 && n.localName === 'shadow') n.remove();
      if (rp.textOutline === null) for (const n of children(child(node, 'rPr'))) if (n.namespaceURI === W14 && n.localName === 'textOutline') n.remove();
      for (const [key, name] of [['text3d', 'props3d'], ['textScene', 'scene3d']]) if (rp[key] === null) for (const n of children(child(node, 'rPr'))) if (n.namespaceURI === W14 && n.localName === name) n.remove();
      const u = child(child(node, 'rPr'), 'u');
      if (rp.underlineStyle === null || rp.underline === null) u?.removeAttributeNS(W, 'val');
      if (rp.underlineColor === null) for (const attr of ['color', 'themeColor', 'themeTint', 'themeShade']) u?.removeAttributeNS(W, attr);
      if (u && !u.attributes.length) u.remove();
      for (const [key, val] of Object.entries(rp)) if (val === null && Object.hasOwn(FONT_DEFAULTS, key)) removeFontProperty(child(node, 'rPr'), key);
      for (const [key, val] of Object.entries(rp)) if (val === null && !Object.hasOwn(FONT_DEFAULTS, key) && !['underline', 'underlineStyle', 'underlineColor'].includes(key)) child(child(node, 'rPr'), { bold: 'b', italic: 'i', boldCs: 'bCs', italicCs: 'iCs', fontSizeCs: 'szCs', cs: 'cs', rtl: 'rtl', underline: 'u', underlineStyle: 'u', underlineColor: 'u', color: 'color', highlight: 'highlight', shading: 'shd', verticalAlign: 'vertAlign', baselineShift: 'position', characterSpacing: 'spacing', textScale: 'w', kerning: 'kern', fontSize: 'sz' }[key])?.remove();
      writeRunFormat(ensure('rPr'), Object.fromEntries(Object.entries(rp).filter(([,v]) => v !== null)), make);
    }
  }
  if (!parts[path]) {
    const relPath = 'word/_rels/document.xml.rels', rels = parts[relPath] ? xml(parts[relPath]) : xml(`<Relationships xmlns="${REL}"/>`);
    const ids = new Set(children(rels.documentElement).map(n => n.getAttribute('Id'))); let id = 'rStyles'; while (ids.has(id)) id += '_';
    const rel = rels.createElementNS(REL, 'Relationship'); rel.setAttribute('Id', id); rel.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles'); rel.setAttribute('Target', path.slice(5)); rels.documentElement.append(rel); parts[relPath] = strToU8(serialize(rels));
    const types = xml(parts['[Content_Types].xml']), type = types.createElementNS(types.documentElement.namespaceURI, 'Override'); type.setAttribute('PartName', '/' + path); type.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'); types.documentElement.append(type); parts['[Content_Types].xml'] = strToU8(serialize(types));
  }
  parts[path] = strToU8(serialize(doc).replace(/^(<\?xml[^?]*encoding=)["'][^"']*["']/i, '$1"UTF-8"'));
}

// The styles of a package made from scratch. New documents also get the title
// and heading set word processors offer, so heading shortcuts have targets.
const BASIC_STYLES = `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Noto Sans" w:hAnsi="Noto Sans"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="180" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="180" w:after="90"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="character" w:styleId="Emphasis"><w:name w:val="Emphasis"/><w:rPr><w:i/></w:rPr></w:style><w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style></w:styles>`;
export const WRITING_STYLES = `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Noto Sans" w:hAnsi="Noto Sans"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="180" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:after="120"/></w:pPr><w:rPr><w:sz w:val="52"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="30"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="180" w:after="90"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="Heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="140" w:after="60"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="Heading 5"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="120" w:after="60"/><w:outlineLvl w:val="4"/></w:pPr><w:rPr><w:b/><w:color w:val="595959"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="Heading 6"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="120" w:after="60"/><w:outlineLvl w:val="5"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="character" w:styleId="Emphasis"><w:name w:val="Emphasis"/><w:rPr><w:i/></w:rPr></w:style><w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style></w:styles>`;

export function createDocx(paragraphs = [paragraph()], pageSettings, numbering = emptyNumbering(), styles, tables = [], assets = {}, stylesXml = BASIC_STYLES) {
  const mode = validatePageSettings(pageSettings).compatibilityMode;
  const parts = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),
    '_rels/.rels': strToU8(`<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/document.xml': strToU8(`<w:document xmlns:w="${W}"><w:body><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`),
    'word/styles.xml': strToU8(stylesXml),
    'word/_rels/document.xml.rels': strToU8(`<Relationships xmlns="${REL}"><Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
  };
  if (pageSettings?.bordersDoNotSurroundHeader || pageSettings?.bordersDoNotSurroundFooter || mode !== 12 || pageSettings?.gutterAtTop || pageSettings?.splitPgBreakAndParaMark || pageSettings?.suppressSpBfAfterPgBrk || pageSettings?.noTabHangInd || pageSettings?.forgetLastTabAlignment || pageSettings?.allowSpaceOfSameStyleInTable || pageSettings?.wrapTrailSpaces || pageSettings?.ulTrailSpace || pageSettings?.doNotExpandShiftReturn || pageSettings?.doNotUseHTMLParagraphAutoSpacing) {
    const compat = ['noTabHangInd', 'ulTrailSpace', 'doNotExpandShiftReturn', 'doNotUseHTMLParagraphAutoSpacing', 'suppressSpBfAfterPgBrk', 'wrapTrailSpaces', 'forgetLastTabAlignment', 'allowSpaceOfSameStyleInTable', 'splitPgBreakAndParaMark'].filter(key => pageSettings?.[key]).map(key => `<w:${key}/>`).join('') + (mode !== 12 ? `<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="${mode}"/>` : '');
    parts['word/settings.xml'] = strToU8(`<w:settings xmlns:w="${W}">${pageSettings.bordersDoNotSurroundHeader ? '<w:bordersDoNotSurroundHeader/>' : ''}${pageSettings.bordersDoNotSurroundFooter ? '<w:bordersDoNotSurroundFooter/>' : ''}${pageSettings.gutterAtTop ? '<w:gutterAtTop/>' : ''}${compat ? `<w:compat>${compat}</w:compat>` : ''}</w:settings>`);
    parts['[Content_Types].xml'] = strToU8(new TextDecoder().decode(parts['[Content_Types].xml']).replace('</Types>', '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>'));
    parts['word/_rels/document.xml.rels'] = strToU8(new TextDecoder().decode(parts['word/_rels/document.xml.rels']).replace('</Relationships>', '<Relationship Id="rSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>'));
  }
  return new DocxPackage(parts, paragraphs, new Map(), pageSettings, numbering, styles, tables, assets);
}

let revisionIds = 0x3F000000;
/** A w:ins or w:del element for a revision record (§17.13.5.18, §17.13.5.14). */
function revisionElement(doc, revision) {
  const node = doc.createElementNS(W, revision.move ? (revision.type === 'del' ? 'w:moveFrom' : 'w:moveTo') : revision.type === 'del' ? 'w:del' : 'w:ins');
  node.setAttributeNS(W, 'w:id', String(revisionIds++));
  node.setAttributeNS(W, 'w:author', revision.author || '');
  if (revision.date) node.setAttributeNS(W, 'w:date', revision.date);
  return node;
}
/** Write (or clear) a tracked paragraph mark in pPr/rPr; revision elements come first there. */
function writeMarkRevision(node, revision, make) {
  let pPr = child(node, 'pPr'), rPr = child(pPr, 'rPr');
  for (const n of children(rPr)) if (n.namespaceURI === W && ['ins', 'del', 'moveFrom', 'moveTo'].includes(n.localName)) n.remove();
  if (!revision) { if (rPr && !rPr.children.length && !rPr.attributes.length) rPr.remove(); return; }
  if (!pPr) { pPr = make('pPr'); node.prepend(pPr); }
  if (!rPr) { rPr = make('rPr'); pPr.insertBefore(rPr, children(pPr).find(n => n.namespaceURI === W && ['sectPr', 'pPrChange'].includes(n.localName)) || null); }
  const { inserted, ...own } = revision;
  rPr.prepend(revisionElement(node.ownerDocument, own));
  if (inserted) rPr.prepend(revisionElement(node.ownerDocument, { type: 'ins', ...inserted }));
}
const FORMAT_CHANGE_STRIP = ['rPrChange', 'ins', 'del', 'moveFrom', 'moveTo'];
/** Append a regenerated rPrChange (§17.13.5.30) recording a run's former properties; it is the last child of rPr. */
function writeRunChange(properties, revision, make, previousProperties) {
  for (const n of children(properties)) if (n.namespaceURI === W && n.localName === 'rPrChange') n.remove();
  if (!revision) return properties;
  properties ||= make('rPr');
  const former = previousProperties || make('rPr');
  for (const n of children(former)) if (n.namespaceURI === W && FORMAT_CHANGE_STRIP.includes(n.localName)) n.remove();
  const change = make('rPrChange');
  change.setAttributeNS(W, 'w:id', revision.id || String(revisionIds++));
  change.setAttributeNS(W, 'w:author', revision.author || '');
  if (revision.date) change.setAttributeNS(W, 'w:date', revision.date);
  change.append(former); properties.append(change);
  return properties;
}
/** Insert move range markers around each run of moveFrom/moveTo wrappers (§17.13.5.22–.27). */
function writeMoveRanges(node, names, counters, make) {
  const containers = [node, ...[...node.getElementsByTagNameNS(W, 'hyperlink')]];
  for (const container of containers) {
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const first = group[0], kind = first.localName, base = names.get(first) || 'move';
      const key = `${kind}:${base}`, index = (counters.get(key) || 0) + 1; counters.set(key, index);
      const id = String(revisionIds++);
      const start = make(`${kind}RangeStart`); start.setAttributeNS(W, 'w:id', id); start.setAttributeNS(W, 'w:name', index > 1 ? `${base}_${index}` : base);
      start.setAttributeNS(W, 'w:author', first.getAttributeNS(W, 'author') || ''); if (first.getAttributeNS(W, 'date')) start.setAttributeNS(W, 'w:date', first.getAttributeNS(W, 'date'));
      const end = make(`${kind}RangeEnd`); end.setAttributeNS(W, 'w:id', id);
      first.before(start); group.at(-1).after(end); group = [];
    };
    for (const n of children(container)) {
      const move = n.namespaceURI === W && ['moveFrom', 'moveTo'].includes(n.localName);
      if (move && (!group.length || group[0].localName === n.localName && names.get(group[0]) === names.get(n))) group.push(n);
      else { flush(); if (move) group.push(n); }
    }
    flush();
  }
}
function paragraphWriter(doc, styles, numbering, originals, writeImage, writeLink, sectionSource = p => ({ xml: p.sectionProperties, settings: p.sectionEnd })) {
  const make = name => doc.createElementNS(W, `w:${name}`);
  const moveNames = new WeakMap(), moveCounters = new Map();
  return p => {
    const inheritedCaps = id => styleRun(styles, id || styles.defaultCharacter, paragraphRunStyle(p, styles), 'character').capitalization;
    const inheritedStrike = id => styleRun(styles, id || styles.defaultCharacter, paragraphRunStyle(p, styles), 'character').strikethrough;
    const original = originals.get(p.id);
    let node;
    if (original?.signature === signature(p)) node = doc.importNode(xml(original.xml).documentElement, true);
    else {
      node = p.shell ? doc.importNode(xml(p.shell).documentElement, true) : make('p');
      if (!original) for (const attr of [...node.attributes]) if (['paraId', 'textId'].includes(attr.localName)) node.removeAttributeNode(attr);
      child(child(node, 'pPr'), 'sectPr')?.remove();
      if (p.sectionEnd) {
        let properties = child(node, 'pPr'); if (!properties) { properties = make('pPr'); node.prepend(properties); }
        // The section's source properties, with this section's page settings written over them.
        const source = sectionSource(p), sectPr = source.xml ? doc.importNode(xml(source.xml).documentElement, true) : make('sectPr');
        writePageSettings(sectPr, p.sectionEnd, source.settings || DEFAULT_PAGE_SETTINGS, make, !source.xml);
        properties.append(sectPr);
      }
      writeParagraphFormat(node, p, make, numbering);
      if (p.markOverrides || p.markStyleChanged || p.markPropertiesChanged || !p.shell && p.markFormat && !p.styleContext) {
        let pPr = child(node, 'pPr');
        if (!pPr) { pPr = make('pPr'); node.prepend(pPr); }
        let old = child(pPr, 'rPr');
        if (p.markPropertiesChanged) { old?.remove(); old = null; }
        const properties = old || (p.markProperties ? doc.importNode(xml(p.markProperties).documentElement, true) : null);
        let updated = writeRunFormat(properties, p.markOverrides || (p.styleContext ? {} : runFormat(p.markFormat)), make, inheritedStrike(p.markStyleId), inheritedCaps(p.markStyleId));
        updated = writeRunStyle(updated, p.markStyleId, p.markStyleChanged || p.markPropertiesChanged, make);
        if (!old && updated) pPr.insertBefore(updated, child(pPr, 'sectPr') || null);
      }
      writeMarkRevision(node, p.markRevision, make);
      {
        // A recorded paragraph formatting change: pPrChange holds the former pPr (§17.13.5.29).
        const pPr = child(node, 'pPr');
        if (p.formatRevision?.previous) {
          for (const n of children(pPr)) if (n.namespaceURI === W && n.localName === 'pPrChange') n.remove();
          const previous = { ...p, ...p.formatRevision.previous };
          const scratch = previous.shell ? doc.importNode(xml(previous.shell).documentElement, true) : make('p');
          writeParagraphFormat(scratch, previous, make, numbering);
          const former = child(scratch, 'pPr') || make('pPr');
          for (const n of children(former)) if (n.namespaceURI === W && ['rPr', 'sectPr', 'pPrChange'].includes(n.localName)) n.remove();
          const change = make('pPrChange');
          change.setAttributeNS(W, 'w:id', p.formatRevision.id || String(revisionIds++));
          change.setAttributeNS(W, 'w:author', p.formatRevision.author || '');
          if (p.formatRevision.date) change.setAttributeNS(W, 'w:date', p.formatRevision.date);
          change.append(former);
          let target = pPr; if (!target) { target = make('pPr'); node.prepend(target); }
          target.append(change);
        }
      }
      let linkId = null, parent = node, linkParent = node;
      const fieldContainers = [], fieldContainer = () => fieldContainers.at(-1)?.node || node;
      const writtenControls = new Map();
      const controlRanges = contentControlRanges([p]);
      const unchangedControls = new Set(controlRanges.filter(({ control, runs, localStart, start, end }) => !control.hasBookmarks && !control.hasFields && control.signature === controlSignature(runs) && !p.bookmarks?.some(m => m.offset > localStart && m.offset < localStart + end - start)).map(({ control }) => control.id));
      const events = bookmarkInlineEvents(p, p.fieldMarkers, original?.proofText === paragraphText(p) ? original.proofAnchors : []);
      const followingLinks = []; let following;
      for (let i = events.length - 1; i >= 0; i--) { followingLinks[i] = following; if (events[i].run) following = events[i].run.link; }
      const useLink = (link, container = node) => {
        if(fieldContainers.at(-1)?.macro && container===fieldContainer())link=null;
        if(link?.fieldId)link=null; // The retained HYPERLINK envelope owns it.
        if (link) {
          if (linkId !== link.id || linkParent !== container) { parent = writeLink(link); container.append(parent); }
          linkId = link.id;
        } else { linkId = null; parent = container; }
        linkParent = container;
      };
      const writeControl = control => {
        if (!writtenControls.has(control.id)) {
          const wrapper = doc.importNode(xml(control.shell).documentElement, true), content = child(wrapper, 'sdtContent');
          if (control.persistent) {
            const properties = child(wrapper, 'sdtPr'), showing = child(properties, 'showingPlcHdr');
            const wasPlaceholder = !!showing && !['false', '0', 'off'].includes(value(showing));
            if (control.placeholder !== wasPlaceholder) {
              if (!control.placeholder) showing?.remove();
              else if (showing) showing.removeAttributeNS(W, 'val');
              else properties.insertBefore(make('showingPlcHdr'), children(properties).find(n => n.namespaceURI !== W || !['rPr', 'alias', 'tag', 'id', 'lock', 'placeholder', 'temporary'].includes(n.localName)) || null);
            }
          }
          if (!unchangedControls.has(control.id)) content.replaceChildren();
          fieldContainer().append(wrapper); writtenControls.set(control.id, content);
        }
        return writtenControls.get(control.id);
      };
      // Tracked runs sit in w:ins/w:del wrappers; neighbours with the same revision share one.
      const matches = (node, revision) => node?.namespaceURI === W && node.localName === (revision.move ? (revision.type === 'del' ? 'moveFrom' : 'moveTo') : revision.type === 'del' ? 'del' : 'ins') && node.getAttributeNS(W, 'author') === (revision.author || '') && (node.getAttributeNS(W, 'date') || '') === (revision.date || '') && (moveNames.get(node) || '') === (revision.move ? revision.moveName || 'move' : '');
      const place = (r, run) => {
        if (!run.revision) { parent.append(r); return; }
        const { inserted, ...revision } = run.revision;
        let host = parent;
        if (inserted) {
          // A deleted insertion: w:del inside the other reviewer's w:ins.
          const outer = { type: 'ins', ...inserted };
          if (matches(parent.lastElementChild, outer)) host = parent.lastElementChild;
          else { host = revisionElement(doc, outer); parent.append(host); }
        }
        if (matches(host.lastElementChild, revision)) { host.lastElementChild.append(r); return; }
        const wrapper = revisionElement(doc, revision);
        if (revision.move) moveNames.set(wrapper, revision.moveName || 'move');
        wrapper.append(r); host.append(wrapper);
      };
      for (let i = 0; i < events.length; i++) {
        const { run, marker } = events[i];
        if (events[i].proofMarker) {
          const proof = events[i].proofMarker;
          const owner = controlRanges.find(range => range.control.id === proof.controlId && range.localStart <= proof.offset && proof.offset <= range.localStart + range.end - range.start);
          if (owner && unchangedControls.has(owner.control.id)) continue;
          const container = owner ? writeControl(owner.control) : fieldContainer();
          const nextLink = followingLinks[i];
          if (proof.linkId && proof.linkId === nextLink?.id) useLink(nextLink, container);
          else if (linkParent !== container || !proof.linkId || linkId !== proof.linkId) useLink(null, container);
          parent.append(doc.importNode(xml(proof.xml).documentElement, true));
          continue;
        }
        if(events[i].fieldMarker){
          const boundary=events[i].fieldMarker;
          const owner=boundary.contentControlId&&controlRanges.find(r=>r.control.id===boundary.contentControlId&&r.localStart<=boundary.offset&&boundary.offset<=r.localStart+r.end-r.start);
          const container=owner?writeControl(owner.control):fieldContainer();
          if(boundary.field.type==='MACROBUTTON'){
            if(boundary.type==='start')fieldContainers.push({node:make('p'),id:boundary.field.id,macro:true,startOffset:boundary.offset,before:[],after:[]});
            else {
              const prompt=fieldContainers.pop();
              if(!prompt?.macro||prompt.id!==boundary.field.id)throw new Error('Invalid MACROBUTTON boundaries.');
              useLink(boundary.link,fieldContainer());
              parent.append(...prompt.before,...writeMacroButtonLabel(boundary.field,children(prompt.node),doc),...prompt.after);
            }
          }else {
          useLink(boundary.link,container);
          if(boundary.type==='start' && boundary.field.simple && p.fieldMarkers.some(m=>m.type==='end'&&m.field.id===boundary.field.id)){
            const wrapper=bodyFieldSimpleShell(boundary.field,doc);fieldContainer().append(wrapper);fieldContainers.push({node:wrapper,id:boundary.field.id});
          }else if(boundary.type==='end'&&fieldContainers.at(-1)?.id===boundary.field.id){fieldContainers.pop();}
          else parent.append(...bodyFieldBoundary(boundary,doc));
          }
          continue;
        }
        if (marker) {
          const prompt=fieldContainers.at(-1);
          if(prompt?.macro){(marker.offset===prompt.startOffset?prompt.before:prompt.after).push(writeBookmark(marker,doc));continue;}
          const nextLink = followingLinks[i];
          const owner = controlRanges.find(r => marker.contentControlId === r.control.id
            ? r.localStart <= marker.offset && marker.offset <= r.localStart + r.end - r.start
            : r.control.persistent && r.localStart < marker.offset && marker.offset < r.localStart + r.end - r.start);
          const container = owner ? writeControl(owner.control) : fieldContainer();
          if (marker.linkId && marker.linkId === nextLink?.id) useLink(nextLink, container);
          else if (linkParent !== container || !(linkId && (marker.linkId === linkId || nextLink?.id === linkId))) useLink(null, container);
          parent.append(writeBookmark(marker, doc)); continue;
        }
        if (run.contentControl) {
          const control = run.contentControl;
          writeControl(control);
          if (!run.text || unchangedControls.has(control.id)) { useLink(null); continue; }
          useLink(run.link, writtenControls.get(control.id));
        } else useLink(run.link, fieldContainer());
        if (run.field) {
          if (run.text !== OBJECT || Object.keys(run.overrides || {}).length || run.styleChanged) throw new Error('Editing page-field results or their formatting is not supported in page stories yet.');
          const envelope = xml(`<w:p xmlns:w="${W}">${run.field.source}</w:p>`).documentElement;
          const segments = pageFieldSegments(envelope);
          if (segments.length !== 1 || !segments[0].field || segments[0].field.instruction !== run.field.instruction) throw new Error('Invalid retained page-story field.');
          for (const child of [...envelope.children]) parent.append(doc.importNode(child, true));
          continue;
        }
        const r = make('r');
        let properties = run.properties ? doc.importNode(xml(run.properties).documentElement, true) : null;
        properties = writeRunFormat(properties, run.properties ? run.overrides || {} : run.styleManaged ? { ...run.directFormat, ...run.overrides } : runFormat(run), make, inheritedStrike(run.styleId), inheritedCaps(run.styleId));
        properties = writeRunStyle(properties, run.styleId, run.styleChanged || !run.properties && run.styleId, make);
        if (run.formatRevision?.previous) {
          const prev = run.formatRevision.previous;
          let former = prev.properties ? doc.importNode(xml(prev.properties).documentElement, true) : null;
          former = writeRunFormat(former, prev.properties ? prev.overrides || {} : prev.styleManaged ? { ...prev.directFormat, ...prev.overrides } : runFormat(prev), make, inheritedStrike(prev.styleId), inheritedCaps(prev.styleId));
          former = writeRunStyle(former, prev.styleId, prev.styleChanged || !prev.properties && prev.styleId, make);
          properties = writeRunChange(properties, run.formatRevision, make, former);
        }
        if (properties) r.append(properties);
        if (run.math) {
          if (run.text !== OBJECT) throw new Error('An equation must occupy one document position.');
          parent.append(doc.importNode(xml(run.math.xml).documentElement, true)); continue;
        }
        if (run.noBreakHyphen) {
          if (run.text !== '\u2011') throw new Error('Invalid retained nonbreaking hyphen.');
          r.append(make('noBreakHyphen')); place(r, run); continue;
        }
        if (run.breakClear) {
          if (run.text !== '\v' || !['none', 'left', 'right', 'all'].includes(run.breakClear)) throw new Error('Invalid retained text-clearing break.');
          const br = make('br'); br.setAttributeNS(W, 'w:clear', run.breakClear);
          r.append(br); place(r, run); continue;
        }
        if(run.bodySymbol){
          const {font,code}=run.bodySymbol;
          const value=parseInt(code,16);
          if(run.text!==OBJECT||!font?.trim()||!/^[\da-f]{4}$/i.test(code)||value<32||value>=0xd800&&value<=0xdfff)throw new Error('Invalid retained body symbol.');
          const symbol=make('sym');symbol.setAttributeNS(W,'w:font',font);symbol.setAttributeNS(W,'w:char',code);
          r.append(symbol);place(r, run);continue;
        }
        if(run.noteMark){
          if(!['footnoteRef','endnoteRef','footnoteReference','endnoteReference'].includes(run.noteMark.kind)||run.text!==run.noteMark.text)throw new Error('Invalid retained note mark.');
          const mark=make(run.noteMark.kind);
          if(run.noteMark.custom)mark.setAttributeNS(W,'w:customMarkFollows','1');
          if(run.noteMark.kind.endsWith('Reference'))mark.setAttributeNS(W,'w:id',run.noteMark.id);
          r.append(mark);place(r, run);continue;
        }
        if (run.image) {
          if (run.text !== OBJECT) throw new Error('An inline image must occupy one document position.');
          r.append(writeImage(run.image)); place(r, run); continue;
        }
        // Internal controls are never emitted as illegal XML characters.
        for (const piece of run.text.split(/([\t\v\f\u000e\u00ad])/)) {
          if (!piece) continue;
          if (piece === '\u00ad') r.append(make('softHyphen'));
          else if (piece === '\t') {
            const tab = make(run.positionalTab ? 'ptab' : 'tab');
            if (run.positionalTab) for (const key of ['alignment', 'relativeTo', 'leader']) tab.setAttributeNS(W, 'w:' + key, run.positionalTab[key]);
            r.append(tab);
          }
          else if (piece === '\v' || piece === '\f' || piece === '\u000e') {
            const br = make('br');
            if (piece === '\f' || piece === '\u000e') br.setAttributeNS(W, 'w:type', piece === '\f' ? 'page' : 'column');
            r.append(br);
          } else { const t = make(run.revision?.type === 'del' ? 'delText' : 't'); t.setAttributeNS(XML, 'xml:space', 'preserve'); t.textContent = piece; r.append(t); }
        }
        place(r, run);
      }
      writeMoveRanges(node, moveNames, moveCounters, make);
    }
    return node;
  };
}

// Controls in a retained drawing belong to its separately validated text story.
// Header/footer controls outside drawings remain guarded by the story writer.
function hasPageStoryControls(root) {
  return [...root.getElementsByTagNameNS(W, 'sdt')].some(control => {
    for (let node = control.parentElement; node && node !== root; node = node.parentElement) {
      if (node.namespaceURI === W && ['drawing', 'pict'].includes(node.localName)) return false;
    }
    return true;
  });
}

export class DocxPackage {
  constructor(parts, paragraphs, originals = new Map(), pageSettings, numbering = emptyNumbering(), styles, tables = [], assets = {}) {
    this.assets = assets;
    this.reviewSettings = readReviewSettings(null); this.initialReviewSettings = readReviewSettings(null);
    this.comments = []; this.initialComments = '[]'; this.trackRevisions = false; this.createdStories = []; this.titlePages = new Map(); this.pageNumberings = new Map(); this.evenAndOdd = null;
    this.mailMerge = null; this.initialMailMerge = 'null';
    this.documentView = null; this.initialDocumentView = null;
    this.tables = tables; this.initialTables = JSON.stringify(tables);
    this.styles = styles || readStyles(parts); this.initialStyles = JSON.stringify(this.styles);
    this.numbering = numbering; this.initialNumbering = JSON.stringify(numbering);
    this.parts = parts;
    this.paragraphs = paragraphs;
    this.originals = originals;
    this.storyOriginals = new Map();
    this.initial = JSON.stringify(paragraphs);
    this.pageSettings = validatePageSettings(pageSettings);
    this.initialPageSettings = { ...this.pageSettings };
  }
  static async open(input, { bestEffort = false } = {}) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) throw new Error('This editor currently opens DOCX files up to 20 MB.');
    let total = 0, count = 0, parts;
    try {
      parts = unzipSync(bytes, { filter: entry => {
        total += entry.originalSize;
        if (++count > 2000 || total > 50 * 1024 * 1024) throw new Error('DOCX expanded size exceeds the editor limit.');
        return true;
      } });
    } catch (e) { throw new Error(`Could not read this DOCX archive: ${e.message}`); }
    if (!parts['word/document.xml'] || !parts['[Content_Types].xml'] || !parts['_rels/.rels']) throw new Error('This file is not a supported DOCX document.');
    const types = xml(parts['[Content_Types].xml']);
    if (![...types.getElementsByTagNameNS('*', 'Override')].some(n => n.getAttribute('PartName') === '/word/document.xml' && n.getAttribute('ContentType') === `${DOCX_TYPE}.main+xml`)) {
      throw new Error('Only standard .docx files are supported in this version.');
    }
    const relations = xml(parts['_rels/.rels']);
    if (![...relations.getElementsByTagNameNS(REL, 'Relationship')].some(n => /\/officeDocument$/.test(n.getAttribute('Type')) && /^\/?word\/document.xml$/.test(n.getAttribute('Target')) && n.getAttribute('TargetMode') !== 'External')) throw new Error('Unsupported DOCX document location.');
    try { return this.#read(parts); }
    catch (e) {
      if (!bestEffort || !(e instanceof UnsupportedDocumentError)) throw e;
      const issues = new Set(); recordPreviewIssue(issues, e);
      let pkg;
      try { pkg = this.#read(parts, true, issues); }
      catch (fallbackError) {
        if (!(fallbackError instanceof UnsupportedDocumentError)) throw fallbackError;
        recordPreviewIssue(issues, fallbackError);
        pkg = this.preview(parts);
      }
      pkg.readOnly = true;
      pkg.previewIssues = [...issues];
      return pkg;
    }
  }
  static preview(parts) {
    const doc = xml(parts['word/document.xml']);
    const body = [...doc.documentElement.children].find(n => n.localName === 'body');
    if (!body) throw new Error('The DOCX has no document body.');
    projectCachedFieldResults(body);
    const paragraphs = previewParagraphs(body);
    if (!paragraphs.length) paragraphs.push(paragraph());
    if (documentText(paragraphs).length > MAX_DOCUMENT_CHARACTERS) throw new Error(DOCUMENT_CHARACTER_LIMIT_MESSAGE);
    const pkg = new DocxPackage(parts, paragraphs, new Map(), DEFAULT_PAGE_SETTINGS, emptyNumbering(), emptyStyles());
    pkg.readOnly = true;
    return pkg;
  }
  static #read(parts, preview = false, issues = new Set()) {
    const unsupported = feature => {
      const error = new UnsupportedDocumentError(feature);
      if (!preview) throw error;
      recordPreviewIssue(issues, error);
    };
    const attempt = (read, fallback) => {
      try { return read(); }
      catch (e) {
        if (!preview || !(e instanceof UnsupportedDocumentError)) throw e;
        recordPreviewIssue(issues, e);
        return typeof fallback === 'function' ? fallback() : fallback;
      }
    };
    if (Object.keys(parts).some(name => /vbaProject|^_xmlsignatures\//i.test(name))) unsupported('macros or digital signatures');
    const settings = attempt(() => readSettings(parts), null);
    const savedSpellingComplete = completedSpelling(settings?.documentElement), spellingAnchors = new Map();
    const doc = xml(parts['word/document.xml']);
    if (doc.documentElement.namespaceURI !== W) throw new UnsupportedDocumentError('a different OOXML namespace');
    const activeNodes = attempt(() => activeDescendants(doc.documentElement), () => [...doc.getElementsByTagNameNS(W, '*')]);
    const sectionSourceIndices = new Map(activeNodes.filter(n => n.namespaceURI === W && n.localName === 'sectPr').map((node, index) => [node, index]));
    if (activeNodes.some(n => n.namespaceURI === W && n.localName === 'sdt')) bindUsedNamespaces(doc.documentElement);
    if (preview) projectControlContents(doc.documentElement);
    const body = child(doc.documentElement, 'body');
    if (!body) throw new Error('The DOCX has no document body.');
    const sectionSourceNodes = [...sectionSourceIndices.keys()];
    if (!child(body, 'sectPr')) sectionSourceNodes.push(doc.createElementNS(W, 'w:sectPr'));
    const noteFormats=new WeakMap(),defaultNoteFormat=value(child(child(settings?.documentElement,'footnotePr'),'numFmt'))||'decimal';
    let noteFormat=defaultNoteFormat;
    for(let i=activeNodes.length-1;i>=0;i--){
      const node=activeNodes[i];
      if(node.namespaceURI===W&&node.localName==='sectPr')noteFormat=value(child(child(node,'footnotePr'),'numFmt'))||defaultNoteFormat;
      if(node.namespaceURI===W&&node.localName==='p')noteFormats.set(node,noteFormat);
    }
    if (children(body).filter(n => n.namespaceURI === W && n.localName === 'sectPr').length > 1) unsupported('multiple sections');
    const readColor = attempt(() => colorReader(parts, settings?.documentElement), () => colorReader({}));
    const pageSettings = attempt(() => readPageSettings(child(body, 'sectPr'), settings?.documentElement, readColor, attempt), () => ({ ...DEFAULT_PAGE_SETTINGS }));
    // Effective run validation still rejects active rtl/cs. An explicit off
    // declaration is ordinary inherited formatting, not unsupported direction.
    // Tracked formatting changes (rPrChange/pPrChange) are retained in the
    // property XML; the previous formatting they record is never displayed.
    const forbidden = ['bidi'];
    const recordedFormatting = node => { for (let a = node.parentNode; a; a = a.parentNode) if (a.namespaceURI === W && ['rPrChange', 'pPrChange'].includes(a.localName)) return true; return false; };
    for (const name of forbidden) {
      const nodes = activeNodes.filter(n => n.namespaceURI === W && n.localName === name && !recordedFormatting(n));
      if (nodes.length) unsupported(name);
    }
    for (const [index, section] of activeNodes.filter(n => n.namespaceURI === W && n.localName === 'sectPr').entries()) {
      if (section.parentNode !== body && !(section.parentNode === child(section.parentNode?.parentNode, 'pPr') && section.parentNode.parentNode.parentNode === body)) unsupported('nested section properties');
      const types = children(section).filter(n => n.namespaceURI === W && n.localName === 'type');
      const type = types.length ? value(types[0]) : 'nextPage';
      if (types.length > 1 || !['nextPage', 'continuous', 'nextColumn', 'oddPage', 'evenPage'].includes(type)) unsupported('an invalid section type');
      // Â§17.6.22 describes placement relative to the preceding section. The
      // first section has no preceding section, regardless of its stored type.
      if (index > 0 && type === 'nextColumn') unsupported('next-column section breaks');
      if (!preview) readPageSettings(section, settings?.documentElement, readColor);
    }
    const stylePart = stylesPath(parts), excludedStyleIds = new Set();
    let stylesDoc = stylePart ? xml(parts[stylePart]) : null;
    if (preview) stylesDoc = recoverStyleIdentities(stylesDoc, stylePart, error => recordPreviewIssue(issues, error), excludedStyleIds);
    if (preview) stylesDoc = recoverStyleInheritance(stylesDoc, stylePart, error => recordPreviewIssue(issues, error));
    let effectsStyles;
    // Most documents resolve every table in the main styles part. Do not parse
    // the potentially large companion copy unless a table needs its fallback.
    const readEffectsStyles = () => effectsStyles === undefined ? effectsStyles = attempt(() => {
      const path = relatedPartPath(parts, 'stylesWithEffects', 'http://schemas.microsoft.com/office/2007/relationships/stylesWithEffects');
      if (!path) return null;
      let document = xml(parts[path]);
      // Do not resurrect a rejected primary identity from its companion copy.
      // Companion-only defects must not invalidate healthy primary styles.
      document = recoverStyleIdentities(document, path, error => {
        if (!preview) throw new UnsupportedDocumentError(error.message);
        recordPreviewIssue(issues, error);
      }, new Set(excludedStyleIds));
      if (preview) document = recoverStyleInheritance(document, path, error => recordPreviewIssue(issues, error));
      const root = document.documentElement;
      if (root.namespaceURI !== W || root.localName !== 'styles') throw new UnsupportedDocumentError('invalid stylesWithEffects part');
      return root;
    }, null) : effectsStyles;
    const assets = {};
    const background = attempt(() => readPageBackground(doc.documentElement, readColor, parts, assets), { color: 'auto', picture: null });
    pageSettings.background = background.color;
    pageSettings.backgroundPicture = background.picture;
    const readFonts = fontReader(parts, settings?.documentElement);
    const styles = attempt(() => readStyles(parts, stylesDoc, readColor, readFonts, preview ? error => recordPreviewIssue(issues, error) : null), emptyStyles);
    styles.openTypeFeatures = attempt(() => readOpenTypeFeatures(settings?.documentElement, pageSettings.compatibilityMode), false);
    const tocHyperlinkRuns = preview ? projectCachedFieldResults(body, styles) : new WeakSet();
    let numbering;
    try { numbering = readNumbering(parts, node => geometryPatch(paragraphProperties(node), true), readColor, readFonts, preview ? error => recordPreviewIssue(issues, error) : null); } catch (e) { if (preview) { recordPreviewIssue(issues, e); numbering = emptyNumbering(); } else throw e instanceof UnsupportedDocumentError ? e : new UnsupportedDocumentError(e.message); }
    const checkMarkers = paragraphs => {
      const report = error => recordPreviewIssue(issues, error);
      try { listMarkers(paragraphs, numbering, preview ? report : null); }
      catch (error) {
        if (!preview) throw new UnsupportedDocumentError(error.message);
        numbering.previewMarkerRecovery = true;
        try { listMarkers(paragraphs, numbering, report); }
        catch (fallbackError) { throw new UnsupportedDocumentError(fallbackError.message); }
      }
    };
    const fieldRuns = new WeakMap();
    let bodyInlineOrder = 0;
    const commentReferences = [];
    let currentRevision = null;
    // Open move ranges (§17.13.5.22–.27) name the moveFrom/moveTo content they enclose.
    const moveNames = { from: null, to: null };
    const readMoveRange = node => {
      const side = node.localName.startsWith('moveFrom') ? 'from' : 'to';
      moveNames[side] = node.localName.endsWith('Start') ? node.getAttributeNS(W, 'name') || '' : null;
    };
    const isMoveRange = node => node.namespaceURI === W && ['moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd'].includes(node.localName);
    const readRevision = node => {
      for (const attr of [...node.attributes]) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && !(attr.namespaceURI === W && ['id', 'author', 'date', 'name'].includes(attr.localName))) throw new UnsupportedDocumentError(`revision attribute ${attr.name}`);
      const type = ['ins', 'moveTo'].includes(node.localName) ? 'ins' : 'del';
      const move = ['moveFrom', 'moveTo'].includes(node.localName);
      return { type, author: node.getAttributeNS(W, 'author') || '', date: node.getAttributeNS(W, 'date') || '', ...(move ? { move: true, moveName: moveNames[node.localName === 'moveFrom' ? 'from' : 'to'] || '' } : {}) };
    };
    // A recorded formatting change keeps its former formatting for rejection (§17.13.5.29/.30).
    const changeMeta = change => ({ type: 'format', author: change.getAttributeNS(W, 'author') || '', date: change.getAttributeNS(W, 'date') || '', ...(change.getAttributeNS(W, 'id') ? { id: change.getAttributeNS(W, 'id') } : {}) });
    const readRunChange = rPr => {
      const change = child(rPr, 'rPrChange'); if (!change) return null;
      const inner = child(change, 'rPr');
      return { ...changeMeta(change), previous: { styleId: readCharacterStyle(inner), directFormat: readDirectRun(inner), hasDirectProperties: hasDirectProperties(inner), styleManaged: true, properties: inner ? serialize(inner) : '', overrides: {} } };
    };
    const readParagraphChange = (pPr, shell, mark) => {
      const change = child(pPr, 'pPrChange'); if (!change) return null;
      const inner = child(change, 'pPr');
      const previousShell = shell.cloneNode(true), target = child(previousShell, 'pPr');
      for (const n of children(target)) if (!(n.namespaceURI === W && ['rPr', 'sectPr'].includes(n.localName))) n.remove();
      for (const n of children(inner)) if (!(n.namespaceURI === W && ['rPr', 'sectPr', 'pPrChange'].includes(n.localName))) target.insertBefore(n.cloneNode(true), child(target, 'rPr') || child(target, 'sectPr') || null);
      const styleContext = { ...recoverProperties(inner, candidate => ({ properties: paragraphProperties(candidate, {}, readColor), reference: numberingReference(candidate) })), numberingDirect: !!child(inner, 'numPr'), mark };
      return { ...changeMeta(change), previous: { shell: serializeFragment(previousShell), styleId: value(child(inner, 'pStyle')), styleContext, hasDirectParagraphProperties: children(inner).some(n => !retainedParagraphProperty(n)) } };
    };
    const bodyFields = bodyFieldReader(()=>bodyInlineOrder++);
    const normalizeFields = (node, refreshFormatting = false) => {
      const normalized = node.cloneNode(false), pPr = child(node, 'pPr');
      node.ownerDocument.documentElement.cloneNode(false).appendChild(normalized);
      if (pPr) normalized.appendChild(pPr.cloneNode(true));
      for (const segment of pageFieldSegments(node)) {
        if (segment.node) normalized.appendChild(segment.node.cloneNode(true));
        else {
          const run = node.ownerDocument.createElementNS(W, 'w:r');
          // Body fields without MERGEFORMAT regenerate using instruction-run
          // formatting (paragraph defaults for a simple field's attribute).
          const properties = refreshFormatting && !segment.field.locked && !segment.field.mergeFormat
            ? segment.instructionProperties : child(segment.resultNodes.find(n => n.namespaceURI === W && n.localName === 'r'), 'rPr');
          if (properties) run.appendChild(properties.cloneNode(true));
          const text = node.ownerDocument.createElementNS(W, 'w:t'); text.textContent = OBJECT; run.appendChild(text);
          fieldRuns.set(run, { ...segment.field, cachedText: segment.resultNodes.map(n => n.textContent).join('') });
          normalized.appendChild(run);
        }
      }
      return normalized;
    };
    const readDrawingBlocks = (nodes, drawingRunDefaults, pageStory, editable = false) => {
      const tables = [];
      const paragraphs = readBlocks(nodes, { drawingText: true, ...(editable ? { editableDrawingText: true } : {}), ...(drawingRunDefaults ? { drawingRunDefaults } : {}), ...(pageStory ? { pageStory } : {}) }, 0, tables);
      return { paragraphs, tables, compatibilityMode: pageSettings.compatibilityMode };
    };
    const paragraphs = [], tables = [], originals = new Map(), readImage = imageReader(parts, assets, (node, drawingRunDefaults) => readParagraph(node, { drawingText: true, ...(drawingRunDefaults ? { drawingRunDefaults } : {}) }), readColor.drawingScheme, readFonts.drawingFont, 'word/document.xml', { preview, compatibilityMode: pageSettings.compatibilityMode, readTextBlocks: readDrawingBlocks });
    const readLink = attempt(() => hyperlinkReader(parts), () => () => undefined), readBookmark = bookmarkReader();
    let strictDrawingDraft = false;
    let draftImageReaders;
    const recoverProperties = (node, parse) => readPreviewProperties(node, parse, preview && !strictDrawingDraft ? error => recordPreviewIssue(issues, error) : null);
    const readDirectRun = node => recoverProperties(node, candidate => runProperties(candidate, {}, readColor, readFonts));
    const makeControlReader = () => contentControlReader(rPr => ({ styleId: readCharacterStyle(rPr), directFormat: readDirectRun(rPr), hasDirectProperties: hasDirectProperties(rPr), styleManaged: true, properties: rPr ? serializeFragment(rPr) : '', overrides: {} }), parts);
    let readControl = makeControlReader();
    const storyImageReaders = new Map(), storyLinkReaders = new Map();
    const macroPrompts = new WeakMap();
    const projectPrompts = container => previewMacroButtons(container, (labels, source) => {
      const holder = container.cloneNode(false);
      for(const node of source)holder.append(node.cloneNode(true));
      let top=holder;
      for(let ancestor=container.parentElement;ancestor;ancestor=ancestor.parentElement){const shell=ancestor.cloneNode(false);shell.append(top);top=shell;}
      const {field}=readMacroButtonField(holder);
      const wrapper=container.ownerDocument.createElementNS(W,'w:fldSimple');
      wrapper.append(...labels);macroPrompts.set(wrapper,field);return [wrapper];
    });
    const readParagraph = (node, context = {}) => {
      const sourceNode=node;
      if (preview) node = previewMacroButtons(node);
      else if(!context.drawingText&&!context.pageStory)node=projectPrompts(node);
      if (context.drawingText) node = normalizeFields(node, !context.pageStory);
      if (context.pageStory && !storyImageReaders.has(context.pageStory)) {
        storyImageReaders.set(context.pageStory, imageReader(parts, assets,
          (node, drawingRunDefaults) => readParagraph(node, { pageStory: context.pageStory, drawingText: true, ...(drawingRunDefaults ? { drawingRunDefaults } : {}) }),
          readColor.drawingScheme, readFonts.drawingFont, context.pageStory, { preview, compatibilityMode: pageSettings.compatibilityMode, readTextBlocks: (nodes, defaults) => readDrawingBlocks(nodes, defaults, context.pageStory) }));
      }
      let paragraphImageReader = context.pageStory ? storyImageReaders.get(context.pageStory) : readImage;
      if (strictDrawingDraft) {
        const part = context.pageStory || 'word/document.xml';
        if (!draftImageReaders.has(part)) draftImageReaders.set(part, imageReader(parts, assets,
          (node, defaults) => readParagraph(node, { drawingText: true, ...(defaults ? { drawingRunDefaults: defaults } : {}), ...(context.pageStory ? { pageStory: part } : {}) }),
          readColor.drawingScheme, readFonts.drawingFont, part, { compatibilityMode: pageSettings.compatibilityMode, readTextBlocks: (nodes, defaults) => readDrawingBlocks(nodes, defaults, context.pageStory) }));
        paragraphImageReader = draftImageReaders.get(part);
      }
      // A tracked paragraph mark (§17.13.5.16/.14) is held apart from the
      // mark's formatting; the source node keeps it for unchanged paragraphs.
      let markRevision = null;
      {
        const markProps = child(child(node, 'pPr'), 'rPr');
        const revisionNodes = children(markProps).filter(n => n.namespaceURI === W && ['ins', 'del', 'moveFrom', 'moveTo'].includes(n.localName));
        if (revisionNodes.length) {
          const pair = revisionNodes.length === 2 && revisionNodes[0].localName === 'ins' && revisionNodes[1].localName === 'del';
          if (context.drawingText || context.pageStory || revisionNodes.length > 1 && !pair) throw new UnsupportedDocumentError('tracked paragraph marks outside the main body');
          markRevision = pair ? { ...readRevision(revisionNodes[1]), inserted: (({ author, date }) => ({ author, date }))(readRevision(revisionNodes[0])) } : readRevision(revisionNodes[0]);
          node = node.cloneNode(true);
          for (const n of children(child(child(node, 'pPr'), 'rPr'))) if (n.namespaceURI === W && ['ins', 'del', 'moveFrom', 'moveTo'].includes(n.localName)) n.remove();
        }
      }
      const pPr = child(node, 'pPr');
      const styleId = value(child(pPr, 'pStyle'));
      const styleContext = { ...recoverProperties(pPr, candidate => ({ properties: paragraphProperties(candidate, {}, readColor), reference: numberingReference(candidate) })), numberingDirect: !!child(pPr, 'numPr'), mark: readDirectRun(child(pPr, 'rPr')) };
      const runs = [], bookmarks = [], controls = [], fieldMarkers = [], proofAnchors = []; let textPosition = 0, controlDepth = 0, proofingSafe = true;
      const readRun = (r, link) => {
        if (r.namespaceURI === W && r.localName === 'proofErr') {
          if (!context.drawingText && !context.pageStory) proofAnchors.push({ type: r.getAttributeNS(W, 'type'), offset: textPosition, order: bodyInlineOrder++, xml: serializeFragment(r), ...(controlDepth ? { controlId: controls.at(-1).id } : {}), ...(link ? { linkId: link.id } : {}) });
          return;
        }
        if (r.namespaceURI === W && ['bookmarkStart', 'bookmarkEnd'].includes(r.localName)) {
          if (!context.drawingText && !context.pageStory && bodyFields.inCode) throw new UnsupportedDocumentError('bookmarks inside a body field instruction');
          bookmarks.push({ ...readBookmark(r, textPosition, link, context), ...(!context.drawingText&&!context.pageStory?{bodyOrder:bodyInlineOrder++}:{}) }); return;
        }
        if (isPermissionElement(r) && !context.drawingText && !context.pageStory) {
          if (bodyFields.inCode) throw new UnsupportedDocumentError('permission ranges inside a body field instruction');
          bookmarks.push(readPermissionMarker(r, textPosition, bodyInlineOrder++)); return;
        }
        if (r.namespaceURI === W && ['commentRangeStart', 'commentRangeEnd'].includes(r.localName)) {
          if (context.drawingText || context.pageStory) throw new UnsupportedDocumentError('comments outside the main body');
          if (bodyFields.inCode) throw new UnsupportedDocumentError('comments inside a body field instruction');
          bookmarks.push(readCommentMarker(r, textPosition, bodyInlineOrder++)); return;
        }
        if (r.namespaceURI !== W || r.localName !== 'r') {
          if (!preview) throw new UnsupportedDocumentError(r.localName);
          // This child has not touched run, bookmark or field state. Project
          // only its visible contents; throwing here would flatten its whole
          // enclosing hyperlink and discard successfully imported siblings.
          recordPreviewIssue(issues, new UnsupportedDocumentError(r.localName));
          proofingSafe = false;
          const recovered = previewParagraphs(r).flatMap(p => p.runs);
          runs.push(...recovered);
          textPosition += recovered.reduce((length, run) => length + run.text.length, 0);
          return;
        }
        const rPr = child(r, 'rPr');
        const formatRevision = rPr && !context.drawingText ? readRunChange(rPr) : null;
        const characterStyleId=readCharacterStyle(rPr),characterStyle=styles.definitions?.[characterStyleId];
        let text = '';
        const push = (image, positionalTab) => {
          // Reject unsupported cell coordinate systems while the read-only
          // importer can still replace just this drawing. Deferring this to
          // layout would discard the surrounding tables and page geometry.
          if (image?.anchor && context.cellId && (image.anchor.wrap !== 'none' || !isPageBasedCellPosition(image) && !isCellRelativePosition(image))) {
            throw new UnsupportedDocumentError('drawing coordinate combinations inside table cells');
          }
          if (/[\n\r]/.test(text)) throw new UnsupportedDocumentError('line breaks inside text runs');
          const tocHyperlink=tocHyperlinkRuns.has(r)||!context.drawingText&&!context.pageStory&&bodyFields.inToc&&characterStyle?.type==='character'&&characterStyle.name.toLowerCase()==='hyperlink';
          const resultLink=link||(!context.drawingText&&!context.pageStory?bodyFields.link:null);
          if (text || image) runs.push({ text: image ? OBJECT : text, ...(currentRevision ? { revision: { ...currentRevision } } : {}), ...(formatRevision ? { formatRevision: structuredClone(formatRevision) } : {}), ...(image ? { image } : {}), ...(positionalTab ? { positionalTab } : {}), ...(fieldRuns.has(r) ? { field: fieldRuns.get(r) } : {}), ...(tocHyperlink ? { tocHyperlink: true } : {}), ...(resultLink ? { link:resultLink } : {}), styleId: characterStyleId, directFormat: readDirectRun(rPr), hasDirectProperties: hasDirectProperties(rPr), styleManaged: true, properties: rPr ? serialize(rPr) : '', overrides: {} });
          textPosition += image ? 1 : text.length;
          text = '';
        };
        const pushDrawing = (drawing, read) => {
          push();
          try { push(read()); }
          catch (error) {
            if (!preview || !(error instanceof UnsupportedDocumentError)) throw error;
            // A drawing failure must not roll back supported siblings in this
            // same run. Its source remains in the read-only original package.
            recordPreviewIssue(issues, error);
            const placeholder = inlineDrawingPlaceholder(drawing, assets);
            if (placeholder) push(placeholder);
          }
        };
        const pendingChildren = [children(r)[Symbol.iterator]()];
        while (pendingChildren.length) {
          const next = pendingChildren.at(-1).next();
          if (next.done) { pendingChildren.pop(); continue; }
          const t = next.value;
          if (t === rPr) continue;
          if (!context.drawingText && !context.pageStory && t.namespaceURI === W && ['fldChar','instrText'].includes(t.localName)) {
            push();bodyFields.token(t,r,textPosition,fieldMarkers,link);continue;
          }
          if (!context.drawingText && !context.pageStory && bodyFields.inCode) { if (bodyFields.absorb(t, r)) continue; throw new UnsupportedDocumentError('visible content inside a body field instruction'); }
          if (t.namespaceURI === W && t.localName === 't') text += wordText(t);
          else if (t.namespaceURI === W && t.localName === 'delText' && currentRevision?.type === 'del') text += wordText(t);
          else if (t.namespaceURI === W && t.localName === 'sym') {
            const font = t.getAttributeNS(W, 'font'), code = t.getAttributeNS(W, 'char');
            if (!font?.trim() || !/^[\da-f]{4}$/i.test(code || '') || t.children.length || t.textContent.trim() || [...t.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && !(a.namespaceURI === W && ['font', 'char'].includes(a.localName)))) throw new UnsupportedDocumentError('malformed symbols');
            const value = parseInt(code, 16);
            if (value < 32 || value >= 0xd800 && value <= 0xdfff) throw new UnsupportedDocumentError('invalid symbol character');
            push();
            text = OBJECT; push(); runs.at(-1).bodySymbol = { font, code };
          }
          else if (t.namespaceURI === W && t.localName === 'noBreakHyphen') {
            if (t.children.length || [...t.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/') || t.textContent.trim()) throw new UnsupportedDocumentError('malformed nonbreaking hyphens');
            // Keep semantic text for selection/copy, and retain the element's
            // separate hyphen-minus glyph identity for layout and serialization.
            push(); text = '\u2011'; push(); runs.at(-1).noBreakHyphen = true;
          }
          else if (t.namespaceURI === W && t.localName === 'softHyphen') {
            if (t.children.length || [...t.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/') || t.textContent.trim()) throw new UnsupportedDocumentError('malformed soft hyphens');
            text += '\u00ad';
          }
          else if (t.namespaceURI === W && t.localName === 'tab') text += '\t';
          else if (t.namespaceURI === W && t.localName === 'ptab') { push(); text = '\t'; push(null, readPositionalTab(t)); }
          else if (t.namespaceURI === W && t.localName === 'lastRenderedPageBreak') continue;
          else if (t.namespaceURI === W && t.localName === 'commentReference' && !context.drawingText && !context.pageStory) {
            // The reference mark is regenerated after each range end on save.
            const raw = t.getAttributeNS(W, 'id');
            if (!/^[+-]?\d+$/.test(raw || '') || t.children.length) throw new UnsupportedDocumentError('an invalid comment reference');
            push(); commentReferences.push({ id: BigInt(raw).toString(), offset: textPosition, bookmarks });
          }
          else if (t.namespaceURI === W && (t.localName === 'footnoteReference' || t.localName === 'endnoteReference')) {
            const kind = t.localName === 'footnoteReference' ? 'footnote' : 'endnote';
            if (context.drawingText || context.pageStory) throw new UnsupportedDocumentError(`${kind} references outside the main body`);
            const raw = t.getAttributeNS(W, 'id');
            if (!/^[+-]?\d+$/.test(raw || '') || t.children.length || t.textContent.trim()) throw new UnsupportedDocumentError(`an invalid ${kind} reference`);
            const custom = t.getAttributeNS(W, 'customMarkFollows') || '';
            if (custom && !['0', '1', 'true', 'false', 'on', 'off'].includes(custom)) throw new UnsupportedDocumentError(`an invalid ${kind} custom mark flag`);
            push(); text = OBJECT; push();
            // A custom mark (§17.11.14 customMarkFollows) is the run text that follows; the reference shows no number.
            runs.at(-1).noteMark = { kind: t.localName, id: BigInt(raw).toString(), text: OBJECT, display: '', ...(['1', 'true', 'on'].includes(custom) ? { custom: true } : {}) };
          }
          else if (t.namespaceURI === W && (t.localName === 'footnoteRef' || t.localName === 'endnoteRef') && context.noteStory === (t.localName === 'footnoteRef' ? 'footnote' : 'endnote')) {
            if (t.children.length || t.textContent.trim()) throw new UnsupportedDocumentError('malformed note marks');
            push(); text = OBJECT; push(); runs.at(-1).noteMark = { kind: t.localName, text: OBJECT, display: '' };
          }
          else if (t.namespaceURI === W && ['footnoteRef','endnoteRef'].includes(t.localName)) {
            // Ordinal one is displayed using the section's FOOTNOTE format
            // for both orphan mark kinds; numStart is not applied. The spec
            // permits ignoring these marks, but doing so loses visible ink.
            if(t.children.length||t.textContent.trim()||[...t.attributes].some(a=>a.namespaceURI!=='http://www.w3.org/2000/xmlns/'))throw new UnsupportedDocumentError('malformed inactive note marks');
            if(context.drawingText||context.pageStory)throw new UnsupportedDocumentError('note marks outside the main body');
            let display;try{display=formatPageNumber(1,noteFormats.get(sourceNode)||defaultNoteFormat);}catch(e){throw new UnsupportedDocumentError(e.message);}
            push();text=display;push();runs.at(-1).noteMark={kind:t.localName,text:display};
          }
          else if (t.namespaceURI === W && t.localName === 'cr') text += '\v';
          else if (t.namespaceURI === W && t.localName === 'drawing') pushDrawing(t, () => paragraphImageReader(t));
          else if (t.namespaceURI === MC && t.localName === 'AlternateContent') {
            const branch = alternateBranch(t);
            if (branch.children.length !== 1 || branch.firstElementChild.namespaceURI !== W || branch.firstElementChild.localName !== 'drawing') {
              if (!preview) throw new UnsupportedDocumentError('alternate content other than one drawing');
              // Part 3 substitutes the selected branch's contents, which can
              // contain several run items or none. Keep the owning run and
              // field state, and use the ordinary readers for each item. An
              // unsupported selected item must not select a different branch.
              issues.add(`Alternate run content in ${context.pageStory || 'word/document.xml'}: rendering the selected branch in read-only mode; editing this alternate-content wrapper is not supported.`);
              pendingChildren.push(children(branch)[Symbol.iterator]());
              continue;
            }
            pushDrawing(branch.firstElementChild, () => {
              const image = paragraphImageReader(branch.firstElementChild); image.shell = serializeFragment(t); image.retainedDrawing = true; return image;
            });
          }
          else if (t.namespaceURI === W && t.localName === 'br') {
            const type = t.getAttributeNS(W, 'type') || 'textWrapping';
            const clear = t.getAttributeNS(W, 'clear');
            if (!['page', 'column', 'textWrapping'].includes(type)) throw new UnsupportedDocumentError('text-clearing breaks');
            if (type === 'textWrapping' && clear && clear !== 'none') {
              if (!['left', 'right', 'all'].includes(clear)) throw new UnsupportedDocumentError('text-clearing breaks');
            }
            if (type === 'textWrapping' && clear) {
              // Keep the break as one semantic character. Its clearance must
              // survive paragraph edits without spreading into typed text.
              push(); text = '\v'; push(); runs.at(-1).breakClear = clear;
              continue;
            }
            text += type === 'page' ? '\f' : type === 'column' ? '\u000e' : '\v';
          }
          else {
            if (!preview) throw new UnsupportedDocumentError(t.localName);
            // This unrecognized child has not changed field or bookmark state.
            // Project only its visible text, retaining supported siblings in
            // the current run and hyperlink. Do not catch failures from known
            // readers here: those may have partially changed their own state.
            push();
            text = previewParagraphs(t).flatMap(p => p.runs).map(r => r.text).join('');
            issues.add(`Unsupported run content ${t.nodeName} in ${context.pageStory || 'word/document.xml'}: shown as inline text where available. Formatting and objects inside this content may be omitted, so layout can differ.`);
            proofingSafe = false;
            push();
          }
        }
        if (/[\n\r]/.test(text)) throw new UnsupportedDocumentError('line breaks inside text runs');
        push();
      };
      const readInline = r => {
        if (isMathElement(r)) {
          // An equation is one retained object: its XML is saved unchanged.
          if (context.drawingText) throw new UnsupportedDocumentError('equations inside drawing text');
          const text = linearMath(r).replace(/[ \t\r\n]+/g, ' ').trim() || 'Equation';
          runs.push({ text: OBJECT, math: { xml: serializeFragment(r), text }, ...(currentRevision ? { revision: { ...currentRevision } } : {}), styleId: null, directFormat: {}, hasDirectProperties: false, styleManaged: true, properties: '', overrides: {} });
          textPosition += 1; return;
        }
        if (r.namespaceURI === W && ['ins', 'del', 'moveFrom', 'moveTo'].includes(r.localName)) {
          if (context.drawingText) throw new UnsupportedDocumentError('revisions inside drawing text');
          const outer = currentRevision, revision = readRevision(r);
          // A deletion can nest inside another reviewer's insertion (a deleted insertion).
          if (outer && !(outer.type === 'ins' && revision.type === 'del' && !outer.inserted)) throw new UnsupportedDocumentError('nested revisions');
          currentRevision = outer ? { ...revision, inserted: { author: outer.author, date: outer.date } } : revision;
          try { for (const nested of children(r)) readInline(nested); }
          finally { currentRevision = outer; }
          return;
        }
        if (isMoveRange(r)) { readMoveRange(r); return; }
        if(macroPrompts.has(r)){
          if(controlDepth)throw new UnsupportedDocumentError('body fields inside inline content controls');
          bodyFields.prompt(macroPrompts.get(r),children(r),()=>textPosition,fieldMarkers,readRun);
        } else if (!context.drawingText && !context.pageStory && r.namespaceURI === W && r.localName === 'fldSimple') {
          if(controlDepth)throw new UnsupportedDocumentError('body fields inside inline content controls');
          bodyFields.simple(r,()=>textPosition,fieldMarkers,readInline);
        } else if (r.namespaceURI === W && r.localName === 'hyperlink') {
          if (context.pageStory && !storyLinkReaders.has(context.pageStory)) storyLinkReaders.set(context.pageStory, hyperlinkReader(parts, context.pageStory));
          // A rejected destination does not invalidate the wrapper's visible
          // contents. Preview them without an active link, retaining pictures
          // and supported formatting through the normal run reader.
          const link = attempt(() => (context.pageStory ? storyLinkReaders.get(context.pageStory) : readLink)(r), undefined), before = runs.length, beforeFields=fieldMarkers.length;
          const content=preview||context.drawingText||context.pageStory?r:projectPrompts(r);
          for (const nested of children(content)) {
            if(macroPrompts.has(nested))bodyFields.prompt(macroPrompts.get(nested),children(nested),()=>textPosition,fieldMarkers,readRun,link);
            else if (nested.namespaceURI === W && ['ins', 'del', 'moveFrom', 'moveTo'].includes(nested.localName)) {
              if (currentRevision) throw new UnsupportedDocumentError('nested revisions');
              currentRevision = readRevision(nested);
              try { for (const item of children(nested)) readRun(item, link); }
              finally { currentRevision = null; }
            }
            else readRun(nested, link);
          }
          if (runs.length === before && fieldMarkers.length === beforeFields) throw new UnsupportedDocumentError('empty hyperlinks');
        } else readRun(r);
      };
      for (const r of children(node)) {
        if (r === pPr) continue;
        const before = { runs: runs.length, bookmarks: bookmarks.length, controls: controls.length, textPosition };
        try {
          if (r.namespaceURI === W && r.localName === 'sdt') {
            if (context.drawingText && !context.editableDrawingText) throw new UnsupportedDocumentError('content controls inside drawing text');
            const { control, content } = readControl(r), before = runs.length, firstBookmark = bookmarks.length, firstField = fieldMarkers.length, fieldScope=bodyFields.scope;
            if(bodyFields.inCode)throw new UnsupportedDocumentError('content controls inside a body field instruction');
            controls.push(control);
            controlDepth++;
            try { for (const nested of children(content)) readInline(nested); }
            finally { controlDepth--; }
            if(bodyFields.scope!==fieldScope)throw new UnsupportedDocumentError('body fields crossing inline content controls');
            if(fieldMarkers.length>firstField)control.hasFields=true;
            for(const marker of fieldMarkers.slice(firstField))marker.contentControlId=control.id;
            // Remember source envelope ownership, including markers exactly at
            // a control boundary. Unwrapping leaves their text positions intact.
            if (bookmarks.length > firstBookmark) control.hasBookmarks = true;
            for (const marker of bookmarks.slice(firstBookmark)) marker.contentControlId = control.id;
            let contents = runs.slice(before);
            if (!contents.length) {
              if (!control.persistent || control.picture || control.plainText) throw new UnsupportedDocumentError('empty content controls');
              // A zero-length run carries the wrapper's identity without adding
              // a character to the document, clipboard or layout.
              const empty = { ...structuredClone(control.inputRun), text: '' };
              runs.push(empty); contents = [empty];
            }
            // Displayed placeholder contents are cached presentation, not a
            // glossary definition. Without a declared prompt, the control restores
            // its default five spaces after clearing entered text.
            control.signature = controlSignature(contents);
            control.contentSignature = controlContentSignature(contents, control);
            for (const run of contents) run.contentControl = control;
          } else readInline(r);
        } catch (e) {
          if (!preview || context.editableDrawingText || !(e instanceof UnsupportedDocumentError)) throw e;
          recordPreviewIssue(issues, e);
          runs.length = before.runs; bookmarks.length = before.bookmarks; controls.length = before.controls;
          proofingSafe = false;
          const fallbackRuns = previewParagraphs(r).flatMap(p => p.runs);
          runs.push(...fallbackRuns);
          textPosition = before.textPosition + fallbackRuns.reduce((length, run) => length + run.text.length, 0);
        }
      }
      const shell = node.cloneNode(false);
      if (hyperlinkBoundaryChanges(runs).length) throw new UnsupportedDocumentError('hyperlink boundaries inside grapheme clusters');
      if (pPr) shell.append(pPr.cloneNode(true));
      const mark = child(pPr, 'rPr');
      const paragraphChange = pPr && !context.drawingText ? readParagraphChange(pPr, shell, styleContext.mark) : null;
      const p = paragraph('', { ...context, runs, ...(bookmarks.length || commentReferences.at(-1)?.bookmarks === bookmarks ? { bookmarks } : {}), shell: serializeFragment(shell), ...(child(pPr, 'sectPr') ? { sectionEnd: readPageSettings(child(pPr, 'sectPr'), settings?.documentElement, readColor, attempt), sectionProperties: serializeFragment(child(pPr, 'sectPr')) } : {}), styleId, styleContext, hasDirectParagraphProperties: children(pPr).some(n => !retainedParagraphProperty(n)), markStyleId: readCharacterStyle(mark), markProperties: mark ? serialize(mark) : '', markHasDirectProperties: hasDirectProperties(mark) });
      if (p.sectionEnd && !context.drawingText && !context.pageStory) p.sectionSourceIndex = sectionSourceIndices.get(child(pPr, 'sectPr'));
      if (markRevision) p.markRevision = markRevision;
      if (paragraphChange) p.formatRevision = paragraphChange;
      if(fieldMarkers.length)p.fieldMarkers=fieldMarkers;
      try {
        resolveStyledParagraph(p, styles, numbering, { displayOnly: preview, onNumberingError: preview ? error => recordPreviewIssue(issues, error) : undefined });
        for (const control of [...controls, ...(context.blockControls || [])]) resolveCharacterRun({ ...control.inputRun, text: '' }, styles, paragraphRunStyle(p, styles), { displayOnly: preview });
      } catch (e) { throw e instanceof UnsupportedDocumentError ? e : new UnsupportedDocumentError(e.message); }
      if (controls.length && changedContentControls([p]).size) throw new UnsupportedDocumentError('content control boundaries inside grapheme clusters');
      checkJustificationText(paragraphText(p), p.format.alignment);
      if (p.cellId && p.format.pageBreakBefore) {
        if (!preview) throw new UnsupportedDocumentError('paragraph page breaks inside table cells');
        issues.delete('paragraph page breaks inside table cells');
        issues.add(`Table cell in ${context.pageStory || 'word/document.xml'}: paragraph page break is ignored in this read-only preview; its text, formatting and pictures are retained.`);
      }
      if (!context.drawingText && !context.pageStory) {
        originals.set(p.id, { signature: signature(p), xml: serializeFragment(sourceNode), ...(proofingSafe && proofAnchors.length ? { proofAnchors, proofText: paragraphText(p) } : {}) });
        if (savedSpellingComplete && proofingSafe) spellingAnchors.set(p.id, proofAnchors);
      }
      return p;
    };
    const stylesRoot = stylesDoc?.documentElement;
    const readBlocks = (nodes, context = {}, depth = 0, blockTables = tables) => {
      if (depth > 12) throw new UnsupportedDocumentError('excessive block nesting');
      const result = [], pending = [], leading = [];
      // A paragraph that received markers from between blocks cannot reuse its source XML, which lacks them.
      const adopted = p => { const original = originals.get(p.id); if (original) original.blockMarkers = true; };
      const takeLeading = paragraphs => { if (leading.length && paragraphs[0]) { paragraphs[0].bookmarks = [...leading.splice(0), ...(paragraphs[0].bookmarks || [])]; adopted(paragraphs[0]); } };
      const tableAt = p => {
        const owner = id => blockTables.find(t => t.rows.some(row => row.cells.some(cell => cell.id === id)));
        let table = p?.cellId && p.cellId !== context.cellId ? owner(p.cellId) : null;
        while (table && (table.parentCellId || null) !== (context.cellId || null)) table = table.parentCellId ? owner(table.parentCellId) : null;
        return table?.id;
      };
      for (const node of nodes) {
        const tableCount = blockTables.length;
        try {
          if (node.namespaceURI !== W) throw new UnsupportedDocumentError(node.localName);
          if (node.localName === 'sectPr' && !depth && !context.cellId) continue;
          if (isPermissionElement(node) && node.localName === 'permStart' && !context.drawingText && !context.pageStory) {
            // A range opening between blocks starts with the next paragraph.
            leading.push(readPermissionMarker(node, 0, bodyInlineOrder++));
            continue;
          }
          if ((['commentRangeStart', 'commentRangeEnd'].includes(node.localName) || isPermissionElement(node)) && !context.drawingText && !context.pageStory) {
            const previous = result.at(-1);
            const marker = (isPermissionElement(node) ? readPermissionMarker : readCommentMarker)(node, previous ? paragraphText(previous).length : 0, bodyInlineOrder++);
            if (previous) { (previous.bookmarks ||= []).push(marker); adopted(previous); } else pending.push(marker);
            continue;
          }
          if (isMoveRange(node) && !context.drawingText) { readMoveRange(node); continue; }
          if (['bookmarkStart', 'bookmarkEnd'].includes(node.localName)) {
            if (!context.drawingText && !context.pageStory && bodyFields.inCode) throw new UnsupportedDocumentError('bookmarks inside a body field instruction');
            const previous = result.at(-1);
            const marker = { ...readBookmark(node, previous ? paragraphText(previous).length + 1 : 0, null, context), blockBoundary: previous ? 'after' : 'before', blockScope: context.cellId || null, blockControls: context.blockControls || [] };
            if (tableAt(previous)) marker.blockTableId = tableAt(previous);
            if (previous) (previous.bookmarks ||= []).push(marker); else pending.push(marker);
            continue;
          }
          if (node.localName === 'p') {
            const p = readParagraph(context.pageStory ? normalizeFields(node) : node, context);
            takeLeading([p]);
            if (context.pageStory || context.drawingText) {
              if (p.sectionEnd) throw new UnsupportedDocumentError('section properties in a header/footer');
              p.storySource = serializeFragment(node);
            }
            result.push(p);
          }
          else if (node.localName === 'sdt') {
            const { control, content } = readControl(node, 'block');
            if (control.persistent && children(content).some(n => n.namespaceURI === W && n.localName === 'tbl'))
              throw new UnsupportedDocumentError('persistent controls around tables');
            control.scope = context.cellId || null;
            result.push(...readBlocks(children(content), { ...context, blockControls: [...(context.blockControls || []), control] }, depth + 1, blockTables));
          } else if (node.localName === 'tbl') {
            if (context.blockControls?.some(control => control.persistent)) throw new UnsupportedDocumentError('persistent controls around tables');
            const parsed = readTable(node, readParagraph, stylesRoot, readColor, (contents, cellContext) => readBlocks(contents, { ...context, ...cellContext, ...((context.blockControls || cellContext.blockControls) ? { blockControls: [...(context.blockControls || []), ...(cellContext.blockControls || [])] } : {}) }, depth + 1, blockTables).map(p => ({ source: p.storySource || originals.get(p.id).xml, paragraph: p })), readBookmark, blockTables, p => resolveStyledParagraph(p, styles, numbering, { displayOnly: preview }), readControl, pageSettings.compatibilityMode, preview, readEffectsStyles, error => recordPreviewIssue(issues, error));
            if (context.cellId) parsed.table.parentCellId = context.cellId;
            if (context.blockControls) parsed.table.blockControls = context.blockControls;
            blockTables.push(parsed.table); takeLeading(parsed.paragraphs); result.push(...parsed.paragraphs);
          } else throw new UnsupportedDocumentError(node.localName);
        } catch (e) {
          if (!preview || context.drawingText || !(e instanceof UnsupportedDocumentError)) throw e;
          recordPreviewIssue(issues, e);
          blockTables.length = tableCount;
          // Keep recovered blocks in their owning cell/story. Losing cellId
          // promotes text to the body and invalidates the surrounding table.
          // Keep a source for the table reader even when strict paragraph import
          // failed before it could register an original. This is display-only.
          const recovered = previewParagraphs(node);
          if (context.cellId && !recovered.length) recovered.push(paragraph());
          for (const p of recovered) Object.assign(p, context, { storySource: serializeFragment(node) });
          result.push(...recovered);
        }
      }
      if (leading.length) {
        if (!result.length) throw new UnsupportedDocumentError('permission ranges without paragraph content');
        const last = result.at(-1); (last.bookmarks ||= []).push(...leading.splice(0).map(m => ({ ...m, offset: paragraphText(last).length }))); adopted(last);
      }
      if (pending.length) {
        if (!result.length) throw new UnsupportedDocumentError('block bookmarks without paragraph content');
        const tableId = tableAt(result[0]); if (tableId) for (const marker of pending) marker.blockTableId = tableId;
        (result[0].bookmarks ||= []).push(...pending);
        if (pending.some(m => m.comment || m.perm)) adopted(result[0]);
      }
      return result;
    };
    paragraphs.push(...readBlocks(children(body)));
    bodyFields.finish();
    const comments = attempt(() => readComments(parts), []);
    {
      const known = new Set(comments.map(c => c.id)), anchored = new Set();
      for (const p of paragraphs) for (const m of p.bookmarks || []) if (m.comment) anchored.add(m.commentId);
      // A reference without a range anchors the comment at its mark.
      for (const ref of commentReferences) if (known.has(ref.id) && !anchored.has(ref.id)) {
        anchored.add(ref.id);
        ref.bookmarks.push(commentMarker(ref.id, 'start', ref.offset, bodyInlineOrder++), commentMarker(ref.id, 'end', ref.offset, bodyInlineOrder++));
      }
      for (const p of paragraphs) if (p.bookmarks && !p.bookmarks.length) delete p.bookmarks;
      for (const p of paragraphs) if (p.bookmarks?.some(m => m.comment && !known.has(m.commentId))) {
        p.bookmarks = p.bookmarks.filter(m => !m.comment || known.has(m.commentId));
        if (!p.bookmarks.length) delete p.bookmarks;
      }
    }
    try { bodyFieldRanges(paragraphs); } catch(error) { throw new UnsupportedDocumentError(error.message); }
    for (const group of blockControlGroups(paragraphs)) group.control.signature = blockControlSignature(group.paragraphs, group.control);
    for (const p of paragraphs) {
      const original = originals.get(p.id); if (original && !original.blockMarkers) original.signature = signature(p);
    }
    documentBlocks(paragraphs, tables);
    try {
      const invalid = new Set();
      bookmarkEntries(paragraphs, tables, preview ? (id, error) => {
        invalid.add(id); issues.delete(error.message);
        issues.add(`Bookmark ${id} in word/document.xml is unavailable in this read-only preview: ${error.message} Other valid bookmarks are retained.`);
      } : undefined);
      if (invalid.size) for (const p of paragraphs) {
        if (p.bookmarks) p.bookmarks = p.bookmarks.filter(marker => !invalid.has(marker.id));
        if (!p.bookmarks?.length) delete p.bookmarks;
      }
    } catch (e) { throw new UnsupportedDocumentError(e.message); }
    if (!paragraphs.length || paragraphs.at(-1).sectionEnd) paragraphs.push(paragraph());
    if (documentText(paragraphs).length > MAX_DOCUMENT_CHARACTERS) throw new Error(DOCUMENT_CHARACTER_LIMIT_MESSAGE);
    checkMarkers(paragraphs);
    const pkg = new DocxPackage(parts, paragraphs, originals, pageSettings, numbering, styles, tables, assets);
    pkg.comments = comments; pkg.initialComments = JSON.stringify(comments);
    pkg.mailMerge = attempt(() => readMailMerge(parts), null); pkg.initialMailMerge = JSON.stringify(pkg.mailMerge);
    pkg.documentView = pkg.initialDocumentView = attempt(() => readDocumentView(parts), null);
    pkg.trackRevisions = attempt(() => { const node = child(settings?.documentElement, 'trackRevisions'); return !!node && !['0', 'false', 'off'].includes(node.getAttributeNS(W, 'val') || ''); }, false);
    pkg.updateFields = attempt(() => readContextualFlag(settings?.documentElement, 'updateFields') ?? false, false);
    pkg.hideSpellingErrors = attempt(() => readContextualFlag(settings?.documentElement, 'hideSpellingErrors') ?? false, false);
    pkg.reviewSettings = attempt(() => readReviewSettings(settings?.documentElement, stylesDoc?.documentElement), () => readReviewSettings(null));
    pkg.initialReviewSettings = { ...structuredClone(pkg.reviewSettings), hideSpellingErrors: pkg.hideSpellingErrors };
    pkg.savedSpelling = savedSpellingComplete ? bodySpellingCache(paragraphs, spellingAnchors) : null;
    pkg.initialProofingFingerprint = savedSpellingComplete || child(settings?.documentElement, 'proofState')?.getAttributeNS(W, 'grammar') === 'clean' ? proofingFingerprint(paragraphs) : null;
    if (activeNodes.some(n => n.namespaceURI === W && (['headerReference', 'footerReference', 'pgNumType'].includes(n.localName))) || Object.values(assets).some(a => a.scene && shapeHasFields(a.scene))) {
      pkg.pageStories = attempt(() => readPageStories(parts, sectionSourceNodes, settings?.documentElement, preview ? error => recordPreviewIssue(issues, error) : null), null);
      const activeStories = pkg.pageStories ? activePageStoryPaths(pkg.pageStories) : new Set();
      for (const [path, story] of Object.entries(pkg.pageStories?.stories || {})) {
        if (!activeStories.has(path)) { story.paragraphs = []; story.tables = []; continue; }
        story.paragraphs = attempt(() => {
          const root = xml(parts[path]).documentElement;
          story.editable = !preview && !hasPageStoryControls(root);
          if (preview) {
            projectControlContents(root);
            projectCachedFieldResults(root, styles, field => {
              try { pageFieldInstruction(field.instruction); return false; }
              catch (error) {
                if (!(error instanceof UnsupportedDocumentError)) throw error;
                recordPreviewIssue(issues, error); return true;
              }
            });
          } else projectRetainedStoryControls(root);
          // Tables and relationships have story-local registries.
          // In preview, let readBlocks recover locally instead of losing the story.
          if (children(root).some(n => n.namespaceURI !== W || !['p', 'tbl'].includes(n.localName))) unsupported('page story blocks not yet implemented');
          // Story bookmarks still need an editable identity scope.
          // Runs, drawings, scoped hyperlinks and page fields use strict readers.
          if (activeDescendants(root).filter(p => p.namespaceURI === W && p.localName === 'p').some(p => children(p).some(n => n.namespaceURI !== W || !['pPr', 'r', 'fldSimple', 'hyperlink'].includes(n.localName)))) unsupported('unsupported header/footer structure');
          if (activeDescendants(root).some(n => n.namespaceURI === W && ['bookmarkStart', 'bookmarkEnd'].includes(n.localName))) unsupported('header/footer bookmark scope');
          if (activeDescendants(root).some(n => n.namespaceURI === W && forbidden.includes(n.localName) && !recordedFormatting(n))) unsupported('unsupported header/footer formatting');
          story.tables = [];
          const paragraphs = readBlocks(children(root), { pageStory: path }, 0, story.tables);
          documentBlocks(paragraphs, story.tables);
          checkMarkers(paragraphs);
          return paragraphs;
        }, null);
        if (story.paragraphs) pkg.storyOriginals.set(path, {
          signature: JSON.stringify({ paragraphs: story.paragraphs, tables: story.tables }),
          paragraphs: new Map(story.paragraphs.map(p => [p.id, { signature: signature(p), xml: p.storySource }])),
        });
      }
    }
    pkg.initialNotes = {};
    for (const kind of ['footnote', 'endnote']) {
      const names = NOTE_KINDS[kind], referencedNotes = noteReferences(paragraphs, kind);
      if (!referencedNotes.length) continue;
      attempt(() => {
        const notesPath = relatedPartPath(parts, names.part);
        if (!notesPath) throw new UnsupportedDocumentError(`a missing ${names.part} part`);
        const root = xml(parts[notesPath]).documentElement;
        if (root.namespaceURI !== W || root.localName !== names.part) throw new UnsupportedDocumentError(`an invalid ${names.part} part`);
        const definition = pkg.pageStories ||= { sections: sectionSourceNodes.map(() => ({ header: {}, footer: {}, firstPageDifferent: false })), stories: {}, evenAndOdd: false };
        pkg.initialNotes[kind] = [...new Set(referencedNotes.map(r => r.id))];
        if (kind === 'footnote') pkg.initialFootnotes = pkg.initialNotes[kind];
        const settingsKey = kind === 'footnote' ? 'footnotes' : 'endnotes';
        definition[settingsKey] = { part: notesPath, ...readNoteSettings(child(settings?.documentElement, `${kind}Pr`), kind) };
        try { formatPageNumber(1, definition[settingsKey].format); }
        catch {
          unsupported(`${kind} numbering format ${definition[settingsKey].format}; note numbers displayed as decimal in read-only preview`);
          definition[settingsKey].format = 'decimal';
        }
        const wanted = new Set(referencedNotes.map(r => r.id));
        for (const node of children(root)) {
          if (node.namespaceURI !== W || node.localName !== names.element) continue;
          const type = node.getAttributeNS(W, 'type');
          const id = BigInt(node.getAttributeNS(W, 'id') || '0').toString();
          if (type && type !== 'normal' || !wanted.has(id)) continue;
          const noteTables = [];
          const noteParagraphs = readBlocks(children(node), { pageStory: notesPath, noteStory: kind }, 0, noteTables);
          documentBlocks(noteParagraphs, noteTables);
          checkMarkers(noteParagraphs);
          const path = footnoteStoryPath(notesPath, id);
          const editable = !preview && !noteParagraphs.some(p => p.bookmarks?.length || p.fieldMarkers?.length || p.sectionEnd) && !noteTables.length;
          definition.stories[path] = { kind, noteId: id, paragraphs: noteParagraphs, tables: noteTables, editable };
          pkg.storyOriginals.set(path, { signature: JSON.stringify({ paragraphs: noteParagraphs, tables: noteTables }), paragraphs: new Map(noteParagraphs.map(p => [p.id, { signature: signature(p), xml: p.storySource }])) });
          wanted.delete(id);
        }
        if (wanted.size) throw new UnsupportedDocumentError(`a missing ${kind}`);
      }, null);
    }
    pkg.hasPlainTextControls = paragraphs.some(p => p.blockControls?.some(c => c.plainText) || p.runs.some(r => r.contentControl?.plainText));
    // Editing a plain drawing frame reuses the strict WML reader and the shape
    // renderer's feature checks, without reparsing or rasterizing the package.
    pkg.readDrawingTextParagraph = (node, defaults, story) => readParagraph(node, { drawingText: true, ...(defaults ? { drawingRunDefaults: defaults } : {}), ...(story ? { pageStory: story } : {}) });
    const readEditableDrawing = read => {
      // Each synchronous draft read owns control/drawing IDs and placeholder state.
      // Reopening a drawing must not consume the main story reader's ID set.
      const previous = readControl, previousStrict = strictDrawingDraft, previousImages = draftImageReaders;
      readControl = makeControlReader(); strictDrawingDraft = true; draftImageReaders = new Map();
      try { return read(); }
      finally { readControl = previous; strictDrawingDraft = previousStrict; draftImageReaders = previousImages; }
    };
    pkg.readDrawingTextBlocks = (nodes, defaults, story) => readEditableDrawing(() => {
      const result = readDrawingBlocks(nodes, defaults, story, true);
      for (const group of blockControlGroups(result.paragraphs)) group.control.signature = blockControlSignature(group.paragraphs, group.control);
      return result;
    });
    pkg.readDrawingTextBox = (node, defaults, story) => readEditableDrawing(() => textBox(node,
      (paragraph, runDefaults) => pkg.readDrawingTextParagraph(paragraph, runDefaults, story), defaults,
      (nodes, runDefaults) => readDrawingBlocks(nodes, runDefaults, story)));
    pkg.resizeDrawingPicture = (image,width,height,sourcePart='word/document.xml') => {
      if(pkg.readOnly)throw new Error('This document is read-only.');
      const next=resizedPictureShell(image,width,height), rebuiltAssets={};
      const read=imageReader(parts,rebuiltAssets,()=>{throw new Error('Picture resizing cannot edit drawing text.');},readColor.drawingScheme,readFonts.drawingFont,sourcePart,{compatibilityMode:pageSettings.compatibilityMode});
      const drawing = xml(next.shell).documentElement;
      // A retained fragment carries namespace declarations, but mc:Ignorable
      // can belong to its paragraph/story ancestors. Rebuild under that source
      // context without changing the original tree or exporting a new wrapper.
      const owner = sourcePart === 'word/document.xml' ? doc : xml(parts[sourcePart]);
      const sourceId = drawing.getElementsByTagNameNS(WP, 'docPr')[0]?.getAttribute('id');
      const source = [...owner.getElementsByTagNameNS(WP, 'docPr')]
        .find(node => node.getAttribute('id') === sourceId)?.parentElement?.parentElement;
      let contextual = drawing;
      for (let at = source?.parentElement || owner.documentElement; at; at = at.parentElement) {
        const parent = at.cloneNode(false);
        parent.append(contextual);
        contextual = parent;
      }
      const rebuilt=read(drawing);
      if(!rebuilt.retainedDrawing)throw new Error('The picture no longer has a retained drawing scene.');
      return {image:{...next},asset:rebuiltAssets[rebuilt.assetId]};
    };
    return pkg;
  }
  drawingTextDraft(image, asset, frame) {
    const display = { paragraphs: frame.node.text.paragraphs, tables: frame.node.text.tables || [], reason: frame.reason };
    if (frame.reason || !frame.content.getElementsByTagNameNS(W, 'sdt').length && !display.tables.length) return display;
    this.drawingTextDraftCache ||= new WeakMap();
    let cache = this.drawingTextDraftCache.get(asset);
    if (!cache || cache.shell !== image.shell) {
      cache = { shell: image.shell, frames: new Map() };
      this.drawingTextDraftCache.set(asset, cache);
    }
    if (!cache.frames.has(frame.index)) {
      try {
        const draft = this.readDrawingTextBlocks(children(frame.content), display.paragraphs[0].drawingRunDefaults, display.paragraphs[0].pageStory);
        documentBlocks(draft.paragraphs, draft.tables);
        const unsupported = draft.paragraphs.some(p => p.sectionEnd || p.bookmarks?.length || p.runs.some(r => r.noteMark || r.link));
        cache.frames.set(frame.index, { ...draft, reason: unsupported ? 'Editing notes, links or bookmarks inside drawing text is not supported yet.' : null });
      } catch (error) { cache.frames.set(frame.index, { ...display, reason: `This drawing story cannot be edited yet: ${error.message}` }); }
    }
    return cache.frames.get(frame.index);
  }
  drawingTextFrames(image, assets = this.assets) {
    const asset = assets[image?.assetId];
    return this.drawingTextSources(image, asset).map(frame => ({ index: frame.index, ...this.drawingTextDraft(image, asset, frame) }));
  }
  drawingTextSources(image, asset) {
    return drawingTextFrames(image, asset, id => {
      const part = drawingTextSourcePart(asset?.scene) || 'word/document.xml';
      this.drawingImageKeys ||= new Map();
      if (!this.drawingImageKeys.has(part)) this.drawingImageKeys.set(part, drawingImageCorrespondence(this.parts, part));
      return this.drawingImageKeys.get(part)(id);
    });
  }
  prepareDrawingTextEdit(image, index, paragraphs, assets = this.assets, styles = this.styles, numbering = this.numbering, tables) {
    if (this.readOnly) throw new Error('This document is open read-only.');
    const asset = assets[image?.assetId], frame = this.drawingTextSources(image, asset)[index];
    if (!Number.isInteger(index) || !frame || frame.reason) throw new Error(frame?.reason || 'Select an existing drawing text frame.');
    const draft = this.drawingTextDraft(image, asset, frame);
    if (draft.reason) throw new Error(draft.reason);
    tables ??= draft.tables;
    if (!Array.isArray(paragraphs) || !paragraphs.length || !Array.isArray(tables)) throw new Error('A drawing text frame needs valid paragraphs and tables.');
    if (JSON.stringify(styles) !== this.initialStyles || JSON.stringify(numbering) !== this.initialNumbering) throw new Error('Drawing text editing after document style changes is not supported yet.');
    const retainedFields = new Map();
    for (const p of draft.paragraphs) for (const r of p.runs) if (r.field) {
      const key = JSON.stringify(r.field); retainedFields.set(key, (retainedFields.get(key) || 0) + 1);
    }
    for (const p of paragraphs) for (const r of p.runs) if (r.field) {
      const key = JSON.stringify(r.field), count = retainedFields.get(key) || 0;
      if (!count || r.text !== OBJECT || Object.keys(r.overrides || {}).length || r.styleChanged) throw new Error('Page-field instructions, results and formatting must be retained. Edit the surrounding text instead.');
      retainedFields.set(key, count - 1);
    }
    // Pictures keep their source relationship and drawing identity. The common
    // picture writer handles the same geometry edits as the main story; new
    // resources and duplicated identities need a separate package transaction.
    const retainedPictures = new Map(draft.paragraphs.flatMap(p => p.runs).filter(r => r.image).map(r => [r.image.id, r.image]));
    const mutablePictureKeys = new Set(['width', 'height', 'alt', 'crop', 'flipH', 'flipV', 'rotation', 'effectExtent', 'anchor', 'sizeChanged', 'altChanged', 'cropChanged', 'flipHChanged', 'flipVChanged', 'rotationChanged', 'extentChanged', 'anchorChanged']);
    const pictureSource = value => JSON.stringify(Object.entries(value).filter(([key]) => !mutablePictureKeys.has(key)).sort(([a], [b]) => a.localeCompare(b)));
    for (const p of paragraphs) for (const r of p.runs) if (r.image) {
      const original = retainedPictures.get(r.image.id);
      if (!original?.shell || r.text !== OBJECT || r.field || r.bodySymbol || pictureSource(original) !== pictureSource(r.image)) throw new Error('Drawing pictures must retain their source identity and relationships.');
      retainedPictures.delete(r.image.id);
    }
    const invalidRun = r => r.noteMark || r.link || r.text.includes('\ufffc') && ((!r.bodySymbol && !r.field && !r.image) || r.text !== '\ufffc');
    if (paragraphs.some(p => !p.drawingText || p.pageStory && p.pageStory !== draft.paragraphs[0].pageStory || p.sectionEnd || p.bookmarks?.length || p.runs.some(invalidRun))) throw new Error('Only supported text, symbols, existing pictures and tables can be edited in this drawing frame.');
    if (changedContentControls(paragraphs).size || changedBlockControls(paragraphs, tables).size) throw new Error('Modified temporary drawing controls must be unwrapped before saving.');
    const blocks = documentBlocks(paragraphs, tables);
    if (JSON.stringify({ paragraphs, tables }) === JSON.stringify({ paragraphs: draft.paragraphs, tables: draft.tables })) return null;
    const unavailable = () => { throw new Error('Objects and links cannot be added to drawing text yet.'); };
    const defaults = frame.node.text.paragraphs[0].drawingRunDefaults;
    const complex = frame.content.getElementsByTagNameNS(W, 'sdt').length || draft.tables.length;
    for (const content of frame.contents) {
      // Parse each equivalent branch independently to retain its paragraph XML,
      // including nested/merged cells and control wrappers. Draft IDs remain stable.
      const own = complex ? this.readDrawingTextBlocks(children(content), defaults, draft.paragraphs[0].pageStory).paragraphs
        : content !== frame.content ? draft.paragraphs.map((p, i) => {
          const node = content.children[i], shell = node.cloneNode(false), properties = child(node, 'pPr');
          if (properties) shell.append(properties.cloneNode(true));
          return { ...p, shell: serializeFragment(shell), storySource: serializeFragment(node) };
        }) : null;
      if (own && own.length !== draft.paragraphs.length) throw new Error('An alternate drawing story changed its paragraph structure.');
      const ownership = own && content !== frame.content ? drawingBranchOwnership(draft.paragraphs, own, content) : null;
      const original = new Map(draft.paragraphs.map((p, i) => [p.id, { signature: signature(ownership ? ownership.paragraph(p) : p), xml: own ? own[i].storySource : serializeFragment(content.children[i]) }]));
      let writePicture = unavailable;
      if (paragraphs.some(p => p.runs.some(r => r.image))) {
        const pictureParts = { ...this.parts };
        writePicture = imageWriter(pictureParts, paragraphs, assets, frame.doc, draft.paragraphs[0].pageStory || 'word/document.xml');
        if (Object.keys(pictureParts).length !== Object.keys(this.parts).length || Object.keys(pictureParts).some(key => pictureParts[key] !== this.parts[key])) throw new Error('Drawing picture edits cannot add or change package resources yet.');
      }
      const write = paragraphWriter(frame.doc, styles, numbering, original, writePicture, unavailable);
      const branchBlocks = ownership ? documentBlocks(paragraphs.map(p => ownership.paragraph(p)), tables.map(t => ownership.table(t))) : blocks;
      content.replaceChildren();
      appendControlledBlocks(content, branchBlocks.map(block => ({ ...block, blockControls: (block.type === 'table' ? block.table : block.paragraph).blockControls })), block => block.type === 'table' ? writeTable(block, frame.doc, write) : write(block.paragraph), frame.doc);
    }
    // Validate the saved representation and rebuild only this frame's display.
    const text = this.readDrawingTextBox(frame.content.parentElement.parentElement, defaults, draft.paragraphs[0].pageStory);
    if (Object.hasOwn(frame.node.text, 'outlineWidth')) text.outlineWidth = frame.node.text.outlineWidth;
    const scene = structuredClone(asset.scene);
    sceneAtPath(scene, frame.path).text = text;
    return { shell: serializeFragment(frame.doc.documentElement), asset: { ...asset, scene } };
  }
  export(paragraphs = this.paragraphs, pageSettings = this.pageSettings, numbering = this.numbering, styles = this.styles, tables = this.tables, assets = this.assets, storyEdits, comments = this.comments, trackRevisions = this.trackRevisions) {
    const parts = this.exportBodyParts(paragraphs, pageSettings, numbering, styles, tables, assets, comments, trackRevisions);
    if (storyEdits !== undefined) this.writeStoryEdits(parts, storyEdits, numbering, styles, assets);
    // Mail merge settings and the embedded recipient list (docx-mail-merge.js), only when changed.
    if (JSON.stringify(this.mailMerge ?? null) !== this.initialMailMerge) writeMailMerge(parts, this.mailMerge);
    // The view the document was last shown in (docx-view-settings.js), only when the user changed it.
    if (this.documentView && this.documentView !== (this.initialDocumentView ?? 'print')) writeDocumentView(parts, this.documentView);
    this.pruneFootnotes(parts, paragraphs);
    // Media that Compress Pictures replaced, once nothing in the package uses it (docx-media-release.js).
    pruneReleasedMedia(parts, this.releasedMedia);
    this.writeNoteSettingsParts(parts);
    invalidateProofingState(parts, this.parts, this.initialProofingFingerprint !== null && this.initialProofingFingerprint !== undefined && proofingFingerprint(paragraphs) !== this.initialProofingFingerprint);
    this.writeCoreProperties(parts);
    return new Blob([zipSync(parts)], { type: DOCX_TYPE });
  }
  /** Document properties (Part 2 §11): the file's values with this session's edits over them. */
  get coreProperties() { return { ...readCoreProperties(this.parts), ...(this.coreEdits || {}) }; }
  /** Change title, subject, author, keywords… on the next export. An empty value removes one. */
  setCoreProperties(patch) {
    if (this.readOnly) throw new Error('This document is open read-only.');
    const edits = Object.fromEntries(Object.entries(patch || {}).filter(([key]) => Object.hasOwn(CORE_FIELDS, key) && key !== 'modified').map(([key, value]) => [key, cleanCoreValue(value)]));
    const current = this.coreProperties;
    const changed = Object.entries(edits).filter(([key, value]) => current[key] !== value);
    if (!changed.length) return false;
    // An unreadable part would make every later save fail; refuse the edit instead.
    const existing = corePropertiesPath(this.parts);
    if (existing) try { xml(this.parts[existing]); } catch { throw new Error('This document’s properties part cannot be read, so its properties cannot be changed.'); }
    this.coreEdits = { ...(this.coreEdits || {}), ...Object.fromEntries(changed) };
    return true;
  }
  /**
   * Edited properties are written with a fresh modification time and author. Content edits alone leave
   * the part as it was, so an unedited part (and an undone edit) still saves byte for byte.
   */
  writeCoreProperties(parts) {
    const edits = { ...(this.coreEdits || {}) };
    if (!Object.keys(edits).length) return;
    const existing = corePropertiesPath(this.parts);
    const now = w3cdtf(this.clock?.() || new Date());
    edits.modified = now;
    if (this.coreAuthor) edits.lastModifiedBy = this.coreAuthor;
    if (!existing) { edits.created ??= now; if (this.coreAuthor) edits.creator ??= this.coreAuthor; }
    writeCoreProperties(parts, edits);
  }
  /** Reserve a new footnote in the notes part (created if needed): { id, part, path, settings }. */
  addFootnote() { return this.addNote('footnote'); }
  /** Reserve a new endnote in the endnotes part (created if needed): { id, part, path, settings }. */
  addEndnote() { return this.addNote('endnote'); }
  addNote(kind) {
    if (this.readOnly) throw new Error('This document is open read-only.');
    const names = NOTE_KINDS[kind], key = `${kind}s`;
    this.notesParts ||= {};
    let part = this.pageStories?.[key]?.part || this.notesParts[kind] || relatedPartPath(this.parts, names.part);
    if (!part) part = kind === 'footnote' ? createFootnotesPart(this.parts) : createNotesPart(this.parts, kind);
    const used = new Set([...xml(this.parts[part]).getElementsByTagNameNS(W, names.element)].map(n => Number(n.getAttributeNS(W, 'id'))));
    for (const path of this.storyOriginals.keys()) { const id = footnoteStoryId(path); if (id !== null && path.startsWith(`${part}#`)) used.add(Number(id)); }
    let id = 1; while (used.has(id)) id++;
    const path = footnoteStoryPath(part, String(id));
    this.storyOriginals.set(path, { signature: '', paragraphs: new Map() });
    this.notesParts[kind] = part;
    if (kind === 'footnote') { this.footnotesPart = part; (this.createdFootnotes ||= new Set()).add(String(id)); }
    ((this.createdNotes ||= {})[kind] ||= new Set()).add(String(id));
    return { id: String(id), part, path, settings: { ...NOTE_DEFAULTS[kind], ...this.noteSettings?.[kind], ...this.pageStories?.[key], part } };
  }
  /** Note numbering and placement for the whole document (settings footnotePr/endnotePr); written on the next export. */
  setNoteSettings(kind, values) {
    if (this.readOnly) throw new Error('This document is open read-only.');
    (this.noteSettings ||= {})[kind] = { ...this.noteSettings[kind], ...values };
  }
  /** Add an empty header or footer story; its section reference is written on the next export. */
  addPageStory(kind, { variant = 'default', section = 0 } = {}) {
    if (this.readOnly) throw new Error('This document is open read-only.');
    const { path, id } = createPageStoryPart(this.parts, kind);
    this.createdStories.push({ kind, id, path, variant, section });
    this.storyOriginals.set(path, { signature: '', paragraphs: new Map() });
    return path;
  }
  writeStoryEdits(parts, edits, numbering, styles, assets) {
    if (!edits || typeof edits !== 'object' || Array.isArray(edits) || edits instanceof Map) throw new Error('Page-story edits must be keyed by their existing part paths.');
    const noteDocs = new Map();
    for (const [path, edit] of Object.entries(edits)) {
      const original = this.storyOriginals.get(path);
      if (!original || !edit || !Array.isArray(edit.paragraphs) || !Array.isArray(edit.tables)) throw new Error('Only parsed, existing page stories can be edited.');
      const { paragraphs, tables } = edit;
      if (JSON.stringify({ paragraphs, tables }) === original.signature) continue;
      // A note story is one w:footnote or w:endnote inside its shared notes part.
      const noteId = footnoteStoryId(path), part = noteId === null ? path : path.slice(0, path.lastIndexOf('#'));
      let doc, root;
      if (noteId === null) { doc = xml(this.parts[path]); root = doc.documentElement; }
      else {
        if (!noteDocs.has(part)) noteDocs.set(part, xml(parts[part]));
        doc = noteDocs.get(part);
        const element = doc.documentElement.localName === 'endnotes' ? 'endnote' : 'footnote';
        root = children(doc.documentElement).find(n => n.namespaceURI === W && n.localName === element && n.getAttributeNS(W, 'id') !== null && BigInt(n.getAttributeNS(W, 'id')).toString() === noteId);
        if (!root) { root = doc.createElementNS(W, `w:${element}`); root.setAttributeNS(W, 'w:id', noteId); doc.documentElement.append(root); }
      }
      if (hasPageStoryControls(root)) throw new Error('Page stories containing content controls are retained without editing.');
      if (paragraphs.some(p => p.sectionEnd || p.bookmarks?.length || p.pageStory && p.pageStory !== part)) throw new Error('Invalid page-story paragraph scope.');
      if (changedContentControls(paragraphs).size || changedBlockControls(paragraphs, tables).size) throw new Error('Modified page-story controls are not supported.');
      const blocks = documentBlocks(paragraphs, tables);
      listMarkers(paragraphs, numbering);
      const writeImage = imageWriter(parts, paragraphs, assets, doc, part);
      const writeLink = hyperlinkWriter(parts, paragraphs, doc, part);
      const writeParagraph = paragraphWriter(doc, styles, numbering, original.paragraphs, writeImage, writeLink);
      root.replaceChildren();
      appendControlledBlocks(root, blocks.map(block => ({ ...block, blockControls: (block.type === 'table' ? block.table : block.paragraph).blockControls })), block => block.type === 'table' ? writeTable(block, doc, writeParagraph) : writeParagraph(block.paragraph), doc);
      for (const hint of [...doc.getElementsByTagNameNS(W, 'lastRenderedPageBreak')]) hint.remove();
      bindImageNamespaces(doc); bindHyperlinkNamespaces(doc);
      if (noteId === null) parts[path] = strToU8(serialize(doc).replace(/^(<\?xml[^?]*encoding=)["'][^"']*["']/i, '$1"UTF-8"'));
    }
    for (const [part, doc] of noteDocs) parts[part] = strToU8(serialize(doc).replace(/^(<\?xml[^?]*encoding=)["'][^"']*["']/i, '$1"UTF-8"'));
  }
  /** Different first page for a section (titlePg); written on the next export. */
  setTitlePage(section, on) { if (this.readOnly) throw new Error('This document is open read-only.'); this.titlePages.set(section, !!on); }
  /** A section's page number format and starting number (w:pgNumType); null removes both; written on the next export. */
  setPageNumbering(section, value) { if (this.readOnly) throw new Error('This document is open read-only.'); this.pageNumberings.set(section, value ? { format: value.format || 'decimal', ...(Number.isInteger(value.start) ? { start: value.start } : {}) } : null); }
  /** Different odd and even page headers (settings evenAndOddHeaders); written on the next export. */
  setEvenAndOdd(on) { if (this.readOnly) throw new Error('This document is open read-only.'); this.evenAndOdd = !!on; }
  /** Remove footnotes and endnotes whose body reference was deleted. */
  pruneFootnotes(parts, paragraphs) {
    for (const kind of ['footnote', 'endnote']) {
      const names = NOTE_KINDS[kind];
      const part = this.pageStories?.[`${kind}s`]?.part || this.notesParts?.[kind] || (kind === 'footnote' ? this.footnotesPart : null);
      if (!part || !parts[part]) continue;
      const referenced = new Set(noteReferences(paragraphs, kind).map(r => r.id));
      const created = this.createdNotes?.[kind] || new Set(), initial = this.initialNotes?.[kind] || [];
      const orphanCreated = [...created].some(id => !referenced.has(id));
      if (!orphanCreated && JSON.stringify([...referenced].sort()) === JSON.stringify([...initial].sort())) continue;
      const doc = xml(parts[part]);
      let changed = false;
      for (const node of children(doc.documentElement)) {
        if (node.namespaceURI !== W || node.localName !== names.element || (node.getAttributeNS(W, 'type') || 'normal') !== 'normal') continue;
        if (!referenced.has(BigInt(node.getAttributeNS(W, 'id') || '0').toString())) { node.remove(); changed = true; }
      }
      if (changed) parts[part] = strToU8(serialize(doc).replace(/^(<\?xml[^?]*encoding=)["'][^"']*["']/i, '$1"UTF-8"'));
    }
  }
  /** Write changed note settings into settings.xml. */
  writeNoteSettingsParts(parts) {
    if (!this.noteSettings) return;
    const { settings, related, path } = openSettings(parts);
    let changed = false;
    for (const [kind, values] of Object.entries(this.noteSettings)) {
      const part = this.pageStories?.[`${kind}s`]?.part || this.notesParts?.[kind] || relatedPartPath(parts, NOTE_KINDS[kind].part);
      changed = writeNoteSettings(settings, kind, values, separatorIds(parts, part, kind)) || changed;
    }
    if (changed) saveSettings(parts, settings, related, path);
  }
  exportBodyParts(paragraphs = this.paragraphs, pageSettings = this.pageSettings, numbering = this.numbering, styles = this.styles, tables = this.tables, assets = this.assets, comments = this.comments, trackRevisions = this.trackRevisions) {
    if (this.readOnly) throw new Error('This document is open read-only. Download the original file to preserve unsupported content.');
    bookmarkEntries(paragraphs, tables);
    if (changedContentControls(paragraphs).size) throw new Error('Modified temporary controls must be unwrapped before saving.');
    if (changedBlockControls(paragraphs, tables).size) throw new Error('Modified temporary block controls must be unwrapped before saving.');
    pageSettings = validatePageSettings(pageSettings);
    if (this.pageStories && JSON.stringify(styles) !== this.initialStyles) {
      for (const story of Object.values(this.pageStories.stories)) {
        const resolved = story.paragraphs.map(p => resolveStyledParagraph(structuredClone(p), styles, numbering));
        listMarkers(resolved, numbering);
      }
    }
    for (const key of ['bordersDoNotSurroundHeader', 'bordersDoNotSurroundFooter', 'compatibilityMode', 'splitPgBreakAndParaMark', 'suppressSpBfAfterPgBrk', 'noTabHangInd', 'forgetLastTabAlignment', 'allowSpaceOfSameStyleInTable', 'wrapTrailSpaces', 'ulTrailSpace', 'doNotExpandShiftReturn', 'doNotUseHTMLParagraphAutoSpacing']) if (pageSettings[key] !== this.initialPageSettings[key]) throw new Error('Page compatibility settings are retained from the source document.');
    const parts = { ...this.parts };
    if (comments) writeComments(parts, comments, this.initialComments ?? '[]');
    if (!!trackRevisions !== !!this.trackRevisions) writeTrackRevisions(parts, trackRevisions);
    writeReviewSettings(parts, { ...this.reviewSettings, hideSpellingErrors: !!this.hideSpellingErrors }, this.initialReviewSettings);
    // No edits means no XML reserialization, including unknown package parts.
    if (this.evenAndOdd !== null) { const { settings, related, path } = openSettings(parts); if (writeEvenAndOdd(settings, this.evenAndOdd)) saveSettings(parts, settings, related, path); }
    // Document-wide page layout settings (§17.15.1): gutter position, mirrored margins, booklets, two pages per sheet.
    const pageFlags = ['gutterAtTop', 'mirrorMargins', 'bookFoldPrinting', 'bookFoldRevPrinting', 'printTwoOnOne'].filter(key => pageSettings[key] !== this.initialPageSettings[key] || !this.originals.size && pageSettings[key]);
    if (pageFlags.length) {
      const { settings, related, path } = openSettings(parts);
      if (pageFlags.map(key => writeSettingsFlag(settings, key, pageSettings[key])).some(Boolean)) saveSettings(parts, settings, related, path);
    }
    if (HYPHENATION_KEYS.some(key => pageSettings[key] !== this.initialPageSettings[key])) { const { settings, related, path } = openSettings(parts); if (writeHyphenationSettings(settings.documentElement, pageSettings, this.initialPageSettings)) saveSettings(parts, settings, related, path); }
    if (!this.createdStories.length && !this.titlePages.size && !this.pageNumberings.size && this.originals.size && JSON.stringify(paragraphs) === this.initial && JSON.stringify(withoutHyphenation(pageSettings)) === JSON.stringify(withoutHyphenation(this.initialPageSettings)) && JSON.stringify(numbering) === this.initialNumbering && JSON.stringify(styles) === this.initialStyles && JSON.stringify(tables) === this.initialTables) return parts;
    let blocks = documentBlocks(paragraphs, tables);
    listMarkers(paragraphs, numbering);
    writeNumbering(parts, numbering);
    writeStyles(parts, styles);
    writeDefaultTabStop(parts, pageSettings.defaultTabStop, this.initialPageSettings.defaultTabStop, !this.originals.size);
    const doc = xml(parts['word/document.xml']);
    if (pageSettings.backgroundPicture && JSON.stringify(pageSettings.backgroundPicture) !== JSON.stringify(this.initialPageSettings.backgroundPicture)) throw new Error('Creating a picture page background is not supported.');
    if (pageSettings.background !== this.initialPageSettings.background || !!pageSettings.backgroundPicture !== !!this.initialPageSettings.backgroundPicture || !this.originals.size && pageSettings.background !== 'auto') {
      if (pageSettings.backgroundPicture) throw new Error('Remove the picture background before changing its page color.');
      child(doc.documentElement, 'background')?.remove();
      if (pageSettings.background !== 'auto') {
        const background = doc.createElementNS(W, 'w:background');
        background.setAttributeNS(W, 'w:color', pageSettings.background);
        doc.documentElement.prepend(background);
      }
    }
    const writeImage = imageWriter(parts, paragraphs, assets, doc);
    const writeLink = hyperlinkWriter(parts, paragraphs, doc);
    const body = child(doc.documentElement, 'body');
    let section = child(body, 'sectPr');
    for (const node of [...body.childNodes]) if (node !== section) node.remove();
    const make = name => doc.createElementNS(W, `w:${name}`);
    if (this.hasPlainTextControls) {
      const prepared = new Map();
      paragraphs = paragraphs.map(p => {
        const prepare = control => {
          if (!control.inputChanged) return control;
          if (!prepared.has(control.id)) {
            const wrapper = doc.importNode(xml(control.shell).documentElement, true), pr = child(wrapper, 'sdtPr');
            const run = control.inputRun, inherited = styleRun(styles, run.styleId || styles.defaultCharacter, paragraphRunStyle(p, styles), 'character');
            let properties = run.properties ? doc.importNode(xml(run.properties).documentElement, true) : null;
            properties = writeRunFormat(properties, run.properties ? run.overrides || {} : run.styleManaged ? { ...run.directFormat, ...run.overrides } : runFormat(run), make, inherited.strikethrough, inherited.capitalization);
            properties = writeRunStyle(properties, run.styleId, run.styleChanged || !run.properties && run.styleId, make);
            child(pr, 'rPr')?.remove(); if (properties) pr.prepend(properties);
            prepared.set(control.id, { ...control, shell: serializeFragment(wrapper) });
          }
          return prepared.get(control.id);
        };
        return { ...p, runs: p.runs.map(r => r.contentControl ? { ...r, contentControl: prepare(r.contentControl) } : r),
          ...(p.blockControls ? { blockControls: p.blockControls.map(prepare) } : {}) };
      });
    }
    if (this.hasPlainTextControls) blocks = documentBlocks(paragraphs, tables);
    if (!section && (!this.originals.size || JSON.stringify(withoutHyphenation(pageSettings)) !== JSON.stringify(withoutHyphenation(this.initialPageSettings)))) { section = make('sectPr'); body.append(section); }
    // Sections keep their source properties; a new section break copies those of the section it splits.
    const sourceSections = new Map(this.paragraphs.filter(p => p.sectionEnd).map(p => [p.sectionProperties, p.sectionEnd]));
    const finalSource = { xml: section && this.originals.size ? serializeFragment(section) : null, settings: this.initialPageSettings };
    const sectionSource = p => p.sectionProperties ? { xml: p.sectionProperties, settings: sourceSections.get(p.sectionProperties) || p.sectionEnd } : finalSource;
    if (section) writePageSettings(section, pageSettings, this.initialPageSettings, make, !this.originals.size);
    const writeParagraph = paragraphWriter(doc, styles, numbering, this.originals, writeImage, writeLink, sectionSource);
    appendControlledBlocks(body, blocks.map(block => ({ ...block, blockControls: (block.type === 'table' ? block.table : block.paragraph).blockControls })), block => block.type === 'table' ? writeTable(block, doc, writeParagraph) : writeParagraph(block.paragraph), doc, null, section || null);
    const sectionParagraphs = paragraphs.filter(p => p.sectionEnd);
    const sourceSectionCount = this.paragraphs.filter(p => p.sectionEnd).length + 1;
    const sectionIndices = [...sectionParagraphs.map((p, i) => p.sectionSourceIndex ?? i), sourceSectionCount - 1];
    if (sectionIndices.length !== sourceSectionCount || sectionIndices.some((index, i) => index !== i)) {
      const originalDoc = xml(this.parts['word/document.xml']);
      const sourceSections = activeDescendants(originalDoc.documentElement).filter(n => n.namespaceURI === W && n.localName === 'sectPr');
      if (!child(child(originalDoc.documentElement, 'body'), 'sectPr')) sourceSections.push(originalDoc.createElementNS(W, 'w:sectPr'));
      const targetSections = activeDescendants(doc.documentElement).filter(n => n.namespaceURI === W && n.localName === 'sectPr');
      const implicitFinal = !section ? make('sectPr') : null;
      if (implicitFinal) targetSections.push(implicitFinal);
      retainSectionStoryReferences(sourceSections, targetSections, sectionIndices);
      if (implicitFinal?.children.length) body.append(implicitFinal);
    }
    const outputSections = activeDescendants(doc.documentElement).filter(n => n.namespaceURI === W && n.localName === 'sectPr');
    if (this.createdStories.length) writeCreatedStoryReferences(outputSections, this.createdStories);
    if (this.titlePages.size) writeTitlePages(outputSections, this.titlePages, sectionOrder);
    if (this.pageNumberings.size) writePageNumbering(outputSections, this.pageNumberings, sectionOrder);
    // These are cached renderer hints, not author-inserted breaks; edits invalidate them.
    for (const hint of [...doc.getElementsByTagNameNS(W, 'lastRenderedPageBreak')]) hint.remove();
    bindImageNamespaces(doc);
    bindHyperlinkNamespaces(doc);
    // Retained/relative drawing fragments can carry local extension aliases too.
    // Hoist only unambiguous aliases: serializers must not reuse a preceding
    // sibling's declaration outside its scope when assembling the document.
    if (paragraphs.some(p => p.blockControls?.length || p.runs.some(r => r.contentControl || r.image?.retainedDrawing || r.image?.anchor?.relativeSize))) bindUsedNamespaces(doc.documentElement);
    parts['word/document.xml'] = strToU8(serialize(doc).replace(/^(<\?xml[^?]*encoding=)["'][^"']*["']/i, '$1"UTF-8"'));
    return parts;
  }
}
