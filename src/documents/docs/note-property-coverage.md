# Footnote and endnote property coverage

Updated 2026-10-13 for endnotes, note settings and custom marks (see the
References section of [conformance.md](conformance.md)); the tables below record
the remaining gaps. Reviewed 2026-10-09 against baseline `1a20ad67`, using supplied ECMA-376
Part 1 §17.11 schemas. This inventories document/section note settings, reference
attributes and part containers in both variants. It contributes to roadmap A01,
not full note-story, nested property or continuation semantics. The current
importer expects Transitional WML; Strict inventories do not establish package
support.

Evidence: note import/export in [docx.js](../src/engine/docx.js),
[footnotes.js](../src/engine/footnotes.js),
[footnote-layout.js](../src/engine/footnote-layout.js),
[note-marks.js](../src/engine/note-marks.js),
[page-numbering.js](../src/engine/page-numbering.js) and
[docx-page-story-create.js](../src/engine/docx-page-story-create.js).
Supported footnotes have reference-order numbering, editable simple stories,
page reservations and retained source. Read-only recovery with approximation
is not full restart/format/placement support.

## Document footnote settings

CT_FtnDocProps. No own attributes in the supplied schemas. The Footnote and Endnote
dialog writes only the properties changed from the document's current settings: an
unchanged Apply leaves `settings.xml` as it is, and a footnote change adds no `endnotePr`.
Settings changes are not yet undoable (they are package settings, outside the edit history).

| Property | Current behavior / remaining work |
| --- | --- |
| `pos` | `pageBottom` and `beneathText` laid out; written by the Footnote and Endnote dialog. |
| `numFmt` | Partial: decimal/decimalZero/letter/Roman/chicago; other formats disclose a decimal read-only approximation. |
| `numStart` | Partial: digit-only global start, fallback one. Complete value/default validation and numbering ranges need controls. |
| `numRestart` | continuous, eachSect and eachPage implemented and written. |
| `footnote` | Retained separator-note reference, no layout consumer. Resolve configured separator/continuation notes instead of only fixed default rule. |

## Document endnote settings

CT_EdnDocProps. No own attributes in the supplied schemas.

| Property | Current behavior / remaining work |
| --- | --- |
| `pos` | `docEnd` laid out; `sectEnd` stored and approximated at document end. |
| `numFmt` | Used for endnote numbering (default lowerRoman). |
| `numStart` | Used for endnote numbering. |
| `numRestart` | continuous and eachSect implemented. |
| `endnote` | Retained separator reference, no endnote separator/continuation consumer. |

## Section footnote settings

CT_FtnProps. No own attributes in the supplied schemas.

| Property | Current behavior / remaining work |
| --- | --- |
| `pos` | Retained, no section-specific note placement consumer. |
| `numFmt` | Read for orphan mark compatibility projection only; actual footnote stories use global settings. Implement section-specific real-reference numbering. |
| `numStart` | Retained, no section-specific start for real notes. |
| `numRestart` | Retained, no section-specific restart for real notes. |

## Section endnote settings

CT_EdnProps. No own attributes in the supplied schemas.

| Property | Current behavior / remaining work |
| --- | --- |
| `pos` | Retained, no section-end endnote layout. |
| `numFmt` | Retained, no section-specific endnote numbering. |
| `numStart` | Retained, no section-specific endnote start. |
| `numRestart` | Retained, no section-specific endnote restart. |

## Footnote part

CT_Footnotes. No own attributes in the supplied schemas.

| Property | Current behavior / remaining work |
| --- | --- |
| `footnote` | Partial: referenced normal note bodies imported as stories. Unreferenced and separator/continuation types retained but not displayed; full identity/body/default/separator behavior remains open. |

## Endnote part

CT_Endnotes. No own attributes in the supplied schemas.

| Property | Current behavior / remaining work |
| --- | --- |
| `endnote` | Referenced normal endnotes import as editable stories and lay out after the body; new parts are created with separators. |

## References

CT_FtnEdnRef has no direct children. The same schema type describes footnote
and endnote references; runtime support differs.

| Attribute | Current behavior / remaining work |
| --- | --- |
| `@customMarkFollows` | Footnote and endnote custom marks import, edit and save; the reference shows no number and the following run holds the mark. |
| `@id` | Footnote and endnote reference IDs parsed into canonical identity and resolved to referenced normal stories; missing/malformed IDs reject. Complete duplicate/reference/story identity validation remains open. |

Footnote references outside the main body reject, including drawing text and
other page stories. Atomic reference selection/formatting preserves semantic
marks in the supported subset. Changed-run serialization emits a supported
reference subset; retention of all optional/unknown attributes through every
mutation is not certified.

## Separator references

CT_FtnEdnSepRef has no direct children.

| Attribute | Current behavior / remaining work |
| --- | --- |
| `@id` | Retained document-setting link to separator note, without a consumer. Implement referenced separator/continuation/notice content and identities. |

## Note body and placement boundaries

CT_FtnEdn body attributes are type and required id. Their names were inspected
directly in each schema; a complete body content-model ledger is still open.
The reader imports wanted normal notes, skips other types and unreferenced
notes, and checks that wanted IDs were found. Full duplicate/body-ID validation
and custom note-kind semantics need focused controls.

Simple note bodies can edit; bookmarks, fields, sections or tables restrict
story editing. Supported body readers still govern imported content. Source
footnote parts retain unused/separator nodes; new parts create default separator
records. Layout nevertheless paints a fixed rule and reserves each entire note
on its reference page; authored separator content and continuation across pages
are not implemented. Multi-column, large-note, section geometry and combined
pagination behavior require native controls.

The legacy orphan footnoteRef/endnoteRef path displays ordinal one using the
section's footnote format, without numStart. This is an existing documented
native compatibility behavior, not actual endnote support or a new divergence
claim. Real note-reference numbering comes from the global story definition,
which must be extended for section overrides.

Existing evidence paths include [footnotes.test.js](../tests/footnotes.test.js),
[export-notes.test.js](../tests/export-notes.test.js),
[inactive-note-marks.test.js](../tests/inactive-note-marks.test.js),
[note-mark-metrics.test.js](../tests/note-mark-metrics.test.js) and
[footnote-recovery.spec.js](../tests/browser/footnote-recovery.spec.js).
These identify current controls, not runtime/native checks newly run for this
documentation audit.

Prioritize section overrides, real restart modes/formats, placement, authored
separators/continuation and endnote stories. Add independent note/reference
identity and mutation controls, then native pagination checks. Best-effort
recovery must retain supported note/body content and exact original download
when unsafe editing remains.

## Inventory verification

Use [audit-section-schema.py](../tools/audit-section-schema.py) with --direct-only,
--type and the matching sections for CT_FtnDocProps, CT_EdnDocProps, CT_FtnProps,
CT_EdnProps, CT_Footnotes, CT_Endnotes, CT_FtnEdnRef and CT_FtnEdnSepRef.
Attribute tables use @ names. Child types, imported groups, nested attributes
and full body/wrapper semantics remain unexpanded. Supplied WML hashes are
recorded in [numbering-property-coverage.md](numbering-property-coverage.md).

All 16 type/variant checks matched child and own-attribute row sets without
missing, extra or duplicate names. Note-body type/id attributes were separately
checked against both schemas, and all relative evidence links resolved. These
checks validate inventory scope, not note pagination or native visual fidelity.
