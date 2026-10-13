# Document settings root coverage

Reviewed 2026-10-09 against baseline `736cda72`, using supplied ECMA-376
Part 1 §17.15.1 and Part 4 schemas. CT_Settings declares 96 Strict children;
Transitional adds hdrShapeDefaults and shapeDefaults (98 total). Neither
variant declares own attributes. This contributes to roadmap A01 and does not
complete nested settings, vendor extensions or every interaction.

The current reader requires Transitional WML. Strict enumeration is not package
support. readSettings validates the part root but has no exhaustive child
behavior whitelist. Some active settings reject explicitly; many are retained
without a consumer. A retained property is not implemented behavior, and an
unconsumed preference does not automatically imply a printed rendering defect.

Source evidence: readSettings/readPageSettings and export in
[docx.js](../src/engine/docx.js), [page-settings.js](../src/engine/page-settings.js),
[page-stories.js](../src/engine/page-stories.js),
[docx-page-story-create.js](../src/engine/docx-page-story-create.js),
[open-document.js](../src/engine/open-document.js),
[footnotes.js](../src/engine/footnotes.js),
[docx-colors.js](../src/engine/docx-colors.js) and font-name/theme metadata in
[docx-fonts.js](../src/engine/docx-fonts.js). No font-program inspection is part
of this audit. Source order lists/writer names alone are not behavior consumers.

## Shared settings declarations

| Property | Current behavior / remaining work |
| --- | --- |
| `writeProtection` | Retained, no write-reservation enforcement found. Distinct from documentProtection; author restriction/save controls before claiming support. |
| `view` | Retained, no imported-setting consumer. App has its own paginated view/zoom; implement applicable stored view preference without treating it as physical page geometry. |
| `zoom` | Retained, no imported-setting consumer. App has its own paginated view/zoom; implement applicable stored view preference without treating it as physical page geometry. |
| `removePersonalInformation` | Retained, no privacy-scrubbing export consumer. Implement explicit metadata policy/round-trip controls; not a page-layout property. |
| `removeDateAndTime` | Retained, no privacy-scrubbing export consumer. Implement explicit metadata policy/round-trip controls; not a page-layout property. |
| `doNotDisplayPageBoundaries` | Retained, no imported-setting consumer. App has its own paginated view/zoom; implement applicable stored view preference without treating it as physical page geometry. |
| `displayBackgroundShape` | Retained, no setting consumer. Background rendering has a separate source path; verify view/print applicability and switch behavior. |
| `printPostScriptOverText` | Retained, no print-setting consumer. Implement applicable print projection/form-data/imposition behavior; basic print/PDF is not full support. |
| `printFractionalCharacterWidth` | Retained, no print-setting consumer. Implement applicable print projection/form-data/imposition behavior; basic print/PDF is not full support. |
| `printFormsData` | Retained, no print-setting consumer. Implement applicable print projection/form-data/imposition behavior; basic print/PDF is not full support. |
| `embedTrueTypeFonts` | Retained save preferences, no general embedding/subsetting authoring. Requires approved font source/licensing; opaque retention is not permission to inspect or redistribute font programs. |
| `embedSystemFonts` | Retained save preferences, no general embedding/subsetting authoring. Requires approved font source/licensing; opaque retention is not permission to inspect or redistribute font programs. |
| `saveSubsetFonts` | Retained save preferences, no general embedding/subsetting authoring. Requires approved font source/licensing; opaque retention is not permission to inspect or redistribute font programs. |
| `saveFormsData` | Retained, no setting consumer. Form/content-control support elsewhere does not implement form design/export/display options. |
| `mirrorMargins` | Unsupported active setting: strict rejects; preview records omission and retains other geometry. Implement facing-page margin/gutter support; false does not activate behavior. |
| `alignBordersAndEdges` | Retained, no setting consumer. Audit page-border alignment behavior separately from ordinary border support. |
| `bordersDoNotSurroundHeader` | Partial: contextual flags consumed by page-story border painting. Broader border/story/display combinations need controls; not general setting authoring. |
| `bordersDoNotSurroundFooter` | Partial: contextual flags consumed by page-story border painting. Broader border/story/display combinations need controls; not general setting authoring. |
| `gutterAtTop` | Partial: affects page margins/writing geometry. Imported flag retained; mutation through page settings rejects. Combined booklet/facing-page controls remain open. |
| `hideSpellingErrors` | Imported automatic spelling visibility (§17.15.1.52); absent/off retains marks, true hides marks and their automatic correction menu. Explicit F7 review remains available. See tests/fixtures/hidden-spelling. |
| `hideGrammaticalErrors` | Retained, no imported proofing-setting consumer. App proofing controls do not establish document-defined visibility, writing-style or saved proof-state behavior. |
| `activeWritingStyle` | Retained, no imported proofing-setting consumer. App proofing controls do not establish document-defined visibility, writing-style or saved proof-state behavior. |
| `proofState` | Completed spelling/grammar flags are invalidated on exported story-text changes (§17.15.1.65) and body language/noProof changes. Completed body spelling uses saved proofErr ranges on initial load; explicit recheck checks all body words. No-edit, unrelated formatting and undo retain completion and source body annotations. Other-story cached display, grammar checking and other-story property-only invalidation remain open. See tests/fixtures/proofing-state and tests/fixtures/cached-proofing. |
| `formsDesign` | Retained, no setting consumer. Form/content-control support elsewhere does not implement form design/export/display options. |
| `attachedTemplate` | Retained, no template-link/style-refresh consumer. Internal/external relationships, explicit resource access and safe style refresh need controls; do not fetch external resources automatically. |
| `linkStyles` | Retained, no template-link/style-refresh consumer. Internal/external relationships, explicit resource access and safe style refresh need controls; do not fetch external resources automatically. |
| `stylePaneFormatFilter` | Retained, no style-pane preference consumer. Implement applicable style listing/filter/sort behavior with named/latent style metadata. |
| `stylePaneSortMethod` | Retained, no style-pane preference consumer. Implement applicable style listing/filter/sort behavior with named/latent style metadata. |
| `documentType` | Retained metadata, no document-type workflow consumer. Verify applicability before classifying a visual failure. |
| `mailMerge` | Partial (§17.14): read and written by the Mailings tab. `mainDocumentType`, `viewMergedData`, `activeRecord`, `mailSubject` and `addressFieldName` are managed; `dataType` is added as `native` for new main documents; data source links, queries and ODSO mappings are preserved but not opened (the recipient list is embedded in a custom XML part instead). Normal Document removes the element. |
| `revisionView` | Retained, no settings-defined revision-view initialization. App has separate view modes; verify stored visibility/author-filter combinations. |
| `trackRevisions` | Partial: imported flag and editing/tracking toggle serialize. Text/paragraph revisions supported subsets; complete formatting/move/table/section revision semantics remain open. |
| `doNotTrackMoves` | Retained, no independent switch consumer. Existing revision support is not proof that these tracking policies are honored. |
| `doNotTrackFormatting` | Retained, no independent switch consumer. Existing revision support is not proof that these tracking policies are honored. |
| `documentProtection` | Any declaration triggers unsupported document protection handling, even inactive declaration. Preview is read-only. Implement supported enforcement/edit semantics without silently dropping restrictions. |
| `autoFormatOverride` | Retained, no settings-defined style/protection consumer. Requires combined formatting-protection and style-lock controls. |
| `styleLockTheme` | Retained, no settings-defined style/protection consumer. Requires combined formatting-protection and style-lock controls. |
| `styleLockQFSet` | Retained, no settings-defined style/protection consumer. Requires combined formatting-protection and style-lock controls. |
| `defaultTabStop` | Partial: validated tab geometry, defaults to 720 twips; supported edits serialize. Measurement bounds and complete story/context inheritance need controls. |
| `autoHyphenation` | Retained, no settings-driven automatic hyphenation consumer. Implement language-aware hyphenation and these controls. Soft/nonbreaking hyphen support is separate. |
| `consecutiveHyphenLimit` | Retained, no settings-driven automatic hyphenation consumer. Implement language-aware hyphenation and these controls. Soft/nonbreaking hyphen support is separate. |
| `hyphenationZone` | Retained, no settings-driven automatic hyphenation consumer. Implement language-aware hyphenation and these controls. Soft/nonbreaking hyphen support is separate. |
| `doNotHyphenateCaps` | Retained, no settings-driven automatic hyphenation consumer. Implement language-aware hyphenation and these controls. Soft/nonbreaking hyphen support is separate. |
| `showEnvelope` | Retained, no envelope-view/workflow consumer. Check applicability separately from ordinary pages. |
| `summaryLength` | Retained, no summary-generation preference consumer. Not physical page layout. |
| `clickAndTypeStyle` | Retained, no settings-defined click-and-type default style consumer. Ordinary caret placement is not this workflow. |
| `defaultTableStyle` | Retained, no settings-defined default table style consumer. Table reader has style/default fallbacks from styles.xml; implement this distinct reference and precedence. |
| `evenAndOddHeaders` | Partial: page-story selection plus supported editing/creation serialize odd/even flag. Complete linked stories/sections and combinations need controls. |
| `bookFoldRevPrinting` | Partial: logical booklet reference margins used for supported landscape geometry. Imported preferences cannot be edited through page settings; this is not physical booklet sheet imposition. |
| `bookFoldPrinting` | Partial: logical booklet reference margins used for supported landscape geometry. Imported preferences cannot be edited through page settings; this is not physical booklet sheet imposition. |
| `bookFoldPrintingSheets` | Retained, no sheet-grouping/imposition consumer. Requires actual booklet print controls. |
| `drawingGridHorizontalSpacing` | Retained, no document-defined drawing-grid display/snapping consumer. Image move/resize exists; implement grid origin/spacing and display frequency separately. |
| `drawingGridVerticalSpacing` | Retained, no document-defined drawing-grid display/snapping consumer. Image move/resize exists; implement grid origin/spacing and display frequency separately. |
| `displayHorizontalDrawingGridEvery` | Retained, no document-defined drawing-grid display/snapping consumer. Image move/resize exists; implement grid origin/spacing and display frequency separately. |
| `displayVerticalDrawingGridEvery` | Retained, no document-defined drawing-grid display/snapping consumer. Image move/resize exists; implement grid origin/spacing and display frequency separately. |
| `doNotUseMarginsForDrawingGridOrigin` | Retained, no document-defined drawing-grid display/snapping consumer. Image move/resize exists; implement grid origin/spacing and display frequency separately. |
| `drawingGridHorizontalOrigin` | Retained, no document-defined drawing-grid display/snapping consumer. Image move/resize exists; implement grid origin/spacing and display frequency separately. |
| `drawingGridVerticalOrigin` | Retained, no document-defined drawing-grid display/snapping consumer. Image move/resize exists; implement grid origin/spacing and display frequency separately. |
| `doNotShadeFormData` | Retained, no setting consumer. Form/content-control support elsewhere does not implement form design/export/display options. |
| `noPunctuationKerning` | Validated and retained; existing native-compatible path retains normal kerning for either value. See punctuation-kerning controls; not a new divergence claim. |
| `characterSpacingControl` | Retained, no explicit settings consumer. Implement relevant East Asian spacing/kinsoku and custom break rules with language/context controls. |
| `printTwoOnOne` | Retained, no print-setting consumer. Implement applicable print projection/form-data/imposition behavior; basic print/PDF is not full support. |
| `strictFirstAndLastChars` | Retained, no explicit settings consumer. Implement relevant East Asian spacing/kinsoku and custom break rules with language/context controls. |
| `noLineBreaksAfter` | Retained, no explicit settings consumer. Implement relevant East Asian spacing/kinsoku and custom break rules with language/context controls. |
| `noLineBreaksBefore` | Retained, no explicit settings consumer. Implement relevant East Asian spacing/kinsoku and custom break rules with language/context controls. |
| `savePreviewPicture` | Retained save preference, no generated-preview authoring consumer. Existing preview rendering is a separate feature. |
| `doNotValidateAgainstSchema` | Retained XML/schema/save metadata, no workflow consumer. Audit custom XML and schema/XSLT applicability; do not weaken import validation merely because a source preference requests it. |
| `saveInvalidXml` | Retained XML/schema/save metadata, no workflow consumer. Audit custom XML and schema/XSLT applicability; do not weaken import validation merely because a source preference requests it. |
| `ignoreMixedContent` | Retained XML/schema/save metadata, no workflow consumer. Audit custom XML and schema/XSLT applicability; do not weaken import validation merely because a source preference requests it. |
| `alwaysShowPlaceholderText` | Retained, no document-level setting consumer. Content-control saved display and editing behavior are separate; test placeholder combinations. |
| `doNotDemarcateInvalidXml` | Retained XML/schema/save metadata, no workflow consumer. Audit custom XML and schema/XSLT applicability; do not weaken import validation merely because a source preference requests it. |
| `saveXmlDataOnly` | Retained XML/schema/save metadata, no workflow consumer. Audit custom XML and schema/XSLT applicability; do not weaken import validation merely because a source preference requests it. |
| `useXSLTWhenSaving` | Retained XML/schema/save metadata, no workflow consumer. Audit custom XML and schema/XSLT applicability; do not weaken import validation merely because a source preference requests it. |
| `saveThroughXslt` | Retained XML/schema/save metadata, no workflow consumer. Audit custom XML and schema/XSLT applicability; do not weaken import validation merely because a source preference requests it. |
| `showXMLTags` | Retained XML/schema/save metadata, no workflow consumer. Audit custom XML and schema/XSLT applicability; do not weaken import validation merely because a source preference requests it. |
| `alwaysMergeEmptyNamespace` | Retained XML/schema/save metadata, no workflow consumer. Audit custom XML and schema/XSLT applicability; do not weaken import validation merely because a source preference requests it. |
| `updateFields` | Partial: validated flag; open-time refresh applies to supported PAGEREF fields when editable. Not generic automatic refresh of every field type. |
| `footnotePr` | Partial: global format/start and supported continuous numbering. Unsupported restart/format recovered with disclosed approximation. Placement, separators and section overrides remain incomplete. |
| `endnotePr` | Retained, no endnote-settings/story layout consumer. Retaining endnoteRef run marks is not complete endnote reference/story behavior. |
| `compat` | Partial: eight Strict / 66 Transitional switches, selective named settings. See compatibility-property-coverage.md for explicit omissions versus unconsumed switches. |
| `docVars` | Retained, no document-variable lookup/edit consumer. Implement DOCVARIABLE evaluation and variable preservation/authoring controls. |
| `rsids` | Retained session metadata, no revision-session lifecycle consumer. Separate from tracked revision display/accept/reject. |
| `mathPr` | Retained, no global math-settings consumer. OMML has a linear read-only approximation; real typography and global math defaults remain missing. |
| `attachedSchema` | Retained XML/schema/save metadata, no workflow consumer. Audit custom XML and schema/XSLT applicability; do not weaken import validation merely because a source preference requests it. |
| `themeFontLang` | Partial: script-language selection for theme font slots. Font-name metadata only; full locale/script fallback and authoring remain open. |
| `clrSchemeMapping` | Partial: maps supported theme color slots in color reader. Unsupported mapped names reject on use; full mapping/theme transform and authoring coverage remain open. |
| `doNotIncludeSubdocsInStats` | Retained, no master/subdocument statistics preference consumer. Ordinary word-count UI is not proof of this behavior. |
| `doNotAutoCompressPictures` | Retained, no setting-driven automatic compression consumer. Preserving source assets is separate from enforcing all future compression preferences. |
| `forceUpgrade` | Retained, no automatic compatibility upgrade consumer. Do not silently rewrite mode/source semantics. |
| `captions` | Retained, no saved caption-catalog/automatic-caption settings consumer. Manual SEQ captions exist; catalog/preferences require separate implementation. |
| `readModeInkLockDown` | Retained, no ink/read-mode policy consumer. Ink payload/read mode applicability needs separate audit. |
| `smartTagType` | Retained smart-tag metadata/save preferences, no workflow consumer. Separate from ordinary hyperlinks and semantic text. |
| `schemaLibrary` | Retained XML/schema/save metadata, no workflow consumer. Audit custom XML and schema/XSLT applicability; do not weaken import validation merely because a source preference requests it. |
| `doNotEmbedSmartTags` | Retained smart-tag metadata/save preferences, no workflow consumer. Separate from ordinary hyperlinks and semantic text. |
| `decimalSymbol` | Retained, no document-locale separator consumer. UI/number parsing/field formatting may use other defaults; implement document setting precedence where applicable. |
| `listSeparator` | Retained, no document-locale separator consumer. UI/number parsing/field formatting may use other defaults; implement document setting precedence where applicable. |

## Transitional additions

| Property | Current behavior / remaining work |
| --- | --- |
| `hdrShapeDefaults` | Retained VML header/footer defaults, no settings-defined consumer. Requires legacy shape/default inheritance and story controls. |
| `shapeDefaults` | Retained VML defaults, no settings-defined consumer. Existing VML handling elsewhere does not implement this declaration's inheritance. |

## Preservation, controls and priority

Imported settings XML is retained through unrelated supported edits; selected
operations patch tracking, default tabs and odd/even headers. Synthesized new
settings parts include only supported authored subsets. This does not establish
byte identity after a settings edit or complete preservation across every
export operation. Protected documents remain read-only; the presence guard does
not implement selective protected editing.

Existing evidence paths include [canvas-settings-location.test.js](../tests/canvas-settings-location.test.js),
[page-setting-recovery.test.js](../tests/page-setting-recovery.test.js),
[tracked-changes.test.js](../tests/tracked-changes.test.js),
[page-stories.test.js](../tests/page-stories.test.js),
[footnotes.test.js](../tests/footnotes.test.js),
[punctuation-kerning.test.js](../tests/punctuation-kerning.test.js) and
[office-math.test.js](../tests/office-math.test.js).
These are pointers to existing controls, not claims that this documentation
audit reran their runtime/native checks.

Prioritize automatic hyphenation/line-break settings, default table-style
precedence, drawing-grid interactions, note placement/endnotes, generic field
refresh and stored revision/proofing preferences. Facing-page margins and
protected editing need explicit controls. Theme, booklet, revision and notes
remain partial families despite accepting some settings. Save metadata,
templates/custom XML, privacy, mail merge and printer workflows need separate
applicability/authoring review; do not classify them all as canvas paint defects.

The [compatibility ledger](compatibility-property-coverage.md) handles child
switches separately. Further audit must enumerate nested settings attributes,
math/custom-XML/relationship payloads and vendor extensions, then verify native
defaults and combined behavior. No document is newly certified complete.

## Inventory verification

Use [audit-section-schema.py](../tools/audit-section-schema.py) with CT_Settings
and Shared settings declarations for Strict; combine Transitional additions
for Transitional. WML schema hashes are recorded in
[numbering-property-coverage.md](numbering-property-coverage.md). Owning
attribute count is zero; referenced/nested types require their own ledgers.

Both variant checks matched all direct property rows without missing, extra or
duplicate names, and confirmed zero own attributes. All relative evidence links
resolved. These checks verify the inventory boundary, not runtime or native-reference compatibility.
