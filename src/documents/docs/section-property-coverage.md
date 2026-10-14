# Section property coverage

Reviewed 2026-10-09 against engine baseline `157215fa`. This is a bounded part of
roadmap A01, not a completed DOCX specification audit or a claim of native-reference compatibility.
The supplied ECMA-376 Part 1 fifth-edition Strict `wml.xsd` declares 22 direct
`CT_SectPr` child properties and four revision-session attributes. The inventory
tool checks the table against the actual schema rather than the serializer's
property-order list. ECMA-376 Part 1 §17.6 defines section semantics; §17.10
defines page stories and §17.11 notes.

Comparing Strict and Transitional schemas inventories declarations, not package
import support. The engine currently uses the Transitional WML namespace; full
Strict-namespace package import remains a separate gap.

Source preservation is a separate dimension: existing section XML is retained
and targeted supported settings are rewritten on export. That does not prove
behavioral support or exact preservation after every section split/join. Preview
documents with unsupported content download their original package and cannot
save edits. Test new preservation claims with edits and reopen, not just import.

| Property | Import / layout and paint | Editing and remaining work | Evidence |
| --- | --- | --- | --- |
| `headerReference` | Partial: relationship resolution, inherited default/first/even header stories. | Story creation and bounded content editing exist; complete story contents and per-section linking need further review. | [page-stories.js](../src/engine/page-stories.js), [docx-page-story-create.js](../src/engine/docx-page-story-create.js) |
| `footerReference` | Partial: relationship resolution and inherited footer stories. | Same bounded authoring path as headers; do not infer support for all footer content. | [page-stories.js](../src/engine/page-stories.js) |
| `footnotePr` | Partial: a legacy inline-marker path reads section `numFmt`; the actual footnote story definition reads global settings, not section overrides. | Implement section `pos`, `numStart`, `numRestart`, and effective format resolution for real notes. Existing global restart recovery does not implement section semantics. | `noteFormats` and `definition.footnotes` in [docx.js](../src/engine/docx.js) |
| `endnotePr` | Missing section behavior. | Implement section overrides and actual endnote placement, format and numbering; preserved declarations are insufficient. | `readPageSettings` in [docx.js](../src/engine/docx.js) |
| `type` | Partial: nextPage and continuous; later nextColumn/oddPage/evenPage declarations trigger unsupported recovery. First section has no preceding boundary. | Section boundary editing exists. Implement column/odd-even page transitions and controls with headers, numbering and tables. | `sectionSourceNodes` import loop in [docx.js](../src/engine/docx.js), [section-story-edit.js](../src/engine/section-story-edit.js) |
| `pgSz` | Partial: width, height and orientation affect geometry; printer paper `code` is not consumed. | Page geometry edits exist. Separate printer paper metadata from visible size; revalidate transition combinations. | `readPageSettings` / `writePageSettings` in [docx.js](../src/engine/docx.js) |
| `pgMar` | Partial: top/right/bottom/left/header/footer/gutter values. Mirror margins and RTL gutters remain restricted. | Supported margin edits exist. Implement inside/outside and directional geometry. | [docx.js](../src/engine/docx.js), [page-settings.js](../src/engine/page-settings.js) |
| `paperSrc` | Preservation only; printer tray selection is not a screen-layout feature. | Define a host-print capability for `first`/`other`; no browser tray selection currently established. | No consumer in `readPageSettings`; [docx.js](../src/engine/docx.js) |
| `pgBorders` | Partial: bounded side borders, display/offset/z-order; individual unsupported components recover locally. | Supported border settings can serialize. Complete art/style and combination coverage requires controls and licensed assets. | [docx-page-borders.js](../src/engine/docx-page-borders.js) |
| `lnNumType` | Supported subset: countBy/start/distance/restart read, edited and painted per section, with paragraph suppression and per-column labels ([conformance](conformance.md#section-line-numbering-and-paragraph-suppression-2026-10-13)). | Verify native label placement in column gaps, bidi sections and `docGrid` interactions. | `readPageSettings` in [docx.js](../src/engine/docx.js); [line-numbers.js](../src/engine/line-numbers.js) |
| `pgNumType` | Partial: format and start affect page-number sequencing; `chapStyle` is stored but not applied, `chapSep` accepted but not consumed. | Implement chapter prefix and separator, remaining number formats and continuous-section restart interactions. | [page-numbering.js](../src/engine/page-numbering.js) |
| `cols` | Partial: equal/unequal widths, spacing and separator parsed and laid out. | Supported settings serialize; unequal-column tables and floating-content combinations still need completion. | [section-columns.js](../src/engine/section-columns.js), [layout.js](../src/engine/layout.js); roadmap L02 |
| `formProt` | Missing section protection behavior. | Apply in conjunction with document-level protection; absence of a section consumer is not proof that the whole document is unprotected. | `readPageSettings` in [docx.js](../src/engine/docx.js) |
| `vAlign` | Partial: top/center/bottom/both within bounded page layouts. | Settings serialize; columns and continuous-section combinations have restrictions. | [page-vertical-alignment.js](../src/engine/page-vertical-alignment.js), [layout.js](../src/engine/layout.js) |
| `noEndnote` | Missing: retained without section-endnote placement behavior. | Implement suppression/deferral with endnote stories and section boundaries. | `readPageSettings` in [docx.js](../src/engine/docx.js) |
| `titlePg` | Implemented bounded first-page story selection, flag parsing and serialization. | Toggle exists; full header/footer content fidelity remains separately partial. | [page-stories.js](../src/engine/page-stories.js), `writeTitlePages` / `titlePages` in [docx.js](../src/engine/docx.js) |
| `textDirection` | Partial: ordinary horizontal flow; other section directions rejected with local preview recovery. | Implement vertical/directional page text with columns, stories and objects. | `readPageSettings` in [docx.js](../src/engine/docx.js) |
| `bidi` | Unsupported: active bidi elements are explicitly rejected, including section bidi. | Implement section directional layout and interactions; do not classify this as silently ignored. | `forbidden` active-node check in [docx.js](../src/engine/docx.js) |
| `rtlGutter` | Unsupported active RTL gutter; local preview recovery retains other geometry. | Implement directional gutter placement, including mirror/duplex combinations. | `readPageSettings` in [docx.js](../src/engine/docx.js) |
| `docGrid` | Missing: no section grid layout consumer. | Implement type/linePitch/charSpace and paragraph/run snap behavior; distinguish absent/default/no-op declarations from active grids. | `readPageSettings` in [docx.js](../src/engine/docx.js); roadmap L06 |
| `printerSettings` | Preservation only; relationship references device-specific printer settings. | Host-print integration needs a defined contract; not a screen-layout promise. Verify resource retention after edits. | Section serialization in [docx.js](../src/engine/docx.js) |
| `sectPrChange` | Previous section-property snapshot retained; no accept/reject implementation. Nested section import restrictions need a focused revision control. | Implement revision views and accept/reject while preserving current/previous section properties correctly. | Active section loop and serialization in [docx.js](../src/engine/docx.js) |

The own attributes `rsidRPr`, `rsidDel`, `rsidR`, and `rsidSect` are revision-session
metadata, not rendering features. Existing XML retention does not establish
correct provenance metadata for synthesized sections. Add split/join/export
controls before claiming complete metadata handling.

## Reproducing the inventory

Run `python tools/audit-section-schema.py PATH_TO_wml.xsd --ledger
docs/section-property-coverage.md` from the app. The schema stays external. The
JSON reports the schema hash, direct declarations, and each direct property's
immediate attributes/children. It does not recursively resolve all nested types,
external relationship/shared types, or vendor extensions, and it does not infer
implementation status. Run against both supplied Strict and Transitional schemas;
matching row counts alone are not proof of equivalent attribute/type semantics.

The 2026-10-09 check verified 22 rows and four own attributes against each schema.
Strict SHA-256: `44fc2233c5df2cfbe0b3b50e7024bd8412ec99dfe7176313ef58845fdec5498d`.
Transitional SHA-256: `0f7784b36ddc42950e5ff354cd608b83b60e4de39325d5568913f1225365029b`.
The Strict inventory also matched the preceding independent extraction's
property/attribute declarations exactly. This checks inventory completeness
within the stated boundary, not the manual support classifications.

## Corpus observations

A recursive source-only scan on 2026-10-09 found 377 `.docx` filenames: 368 readable
packages and nine `~$` editor lock files that were not ZIP packages. It inspected
only `word/document.xml` direct body sections and direct body-paragraph sections;
sections inside tables, controls, revision snapshots, or alternate main-part
paths are outside this scan. It did not register or inspect font programs.

Within that scope, 365 packages contain `docGrid`, 14 contain `pgNumType`, 12
contain `noEndnote`, and four contain `paperSrc`. No grid declaration supplies
`type`, and no page-number declaration supplies `chapStyle` or `chapSep`. No
section `lnNumType`, `footnotePr`, or `endnotePr` declaration was found. These
are presence observations, not rendering assessments. In particular, the grid
count must not be reported as 365 demonstrated defects; effective defaults,
script content, snap flags and compatibility settings still need controls.

The supplied §17.6.5 text (printed pages 560–564) describes distinct grid behavior
for East Asian and Latin characters and paragraph/run overrides, including exact
paragraph line spacing and table compatibility. An implementation must resolve
those semantics rather than applying every stored `linePitch` to every line.

Next verification should add independent controls for silent section-note
overrides, grid/line numbering, chapter page numbers, and revision snapshots.
Existing section, columns, alignment, page-border, and story regressions support
their bounded implementations; this audit adds no new visual-fidelity evidence and
does not promote any original template to complete.

Relevant existing regression sources include [section edits](../tests/section-editing.test.js),
[continuous geometry](../tests/continuous-geometry.test.js),
[column parsing](../tests/section-columns.test.js),
[page number sequencing](../tests/section-page-numbers.test.js),
[alignment recovery](../tests/section-alignment-recovery.test.js),
[page borders](../tests/page-borders.test.js), and
[page stories](../tests/page-stories.test.js). These are evidence for their stated
subsets, not a substitute for native controls of the missing properties above.
