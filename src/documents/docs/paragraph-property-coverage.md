# Paragraph property coverage

Reviewed 2026-10-09 against the Documents sources in grouped branch baseline
`12ae1368`. This covers the 36 direct children of the supplied Strict and
Transitional `CT_PPr` declarations, including children inherited from
`CT_PPrBase`. It is a bounded contribution to roadmap A01, not an exhaustive
attribute audit or a declaration of native-reference layout equivalence. ECMA-376 Part 1
§17.3.1 defines these paragraph properties; style inheritance is additionally
defined in §17.7, numbering in §17.9, and section behavior in §17.6.

Comparing both schemas does not establish Strict-namespace package import. The
engine currently uses the Transitional WML namespace; Strict import remains a
separate gap. These rows classify property behavior in the supported import path.

The paragraph reader resolves supported declarations through styles and direct
formatting. The existing serializer generally retains source paragraph shells
and rewrites targeted edits. Explicit clear-formatting operations remove
non-retained paragraph properties; preservation is therefore not unconditional.
Properties listed only in `propertyOrder` are not necessarily read or rendered.
Read-only recovery is a separate policy: it protects original downloads, but
cannot compensate for an unsupported property that the reader silently ignores.

| Property | Import / layout and paint | Editing, preservation and remaining work | Evidence |
| --- | --- | --- | --- |
| `pStyle` | Partial: paragraph style selection, defaults and basedOn inheritance. | Style edits exist. Identity/inheritance recovery and unsupported style content need separate coverage; a valid style ID does not prove all properties work. | [styles.js](../src/engine/styles.js), [docx-style-identities.js](../src/engine/docx-style-identities.js) |
| `keepNext` | Bounded pagination flag is parsed and consumed. | Formatting edits serialize the flag. Complete combinations with tables, sections and oversized groups remain verification work. | `PAGINATION_DEFAULTS` in [formatting.js](../src/engine/formatting.js), [layout.js](../src/engine/layout.js) |
| `keepLines` | Bounded paragraph-together pagination. | Flag editing and serialization exist; oversized paragraphs and compound grouping need native controls. | [formatting.js](../src/engine/formatting.js), [layout.js](../src/engine/layout.js) |
| `pageBreakBefore` | Bounded page-break pagination. | Flag editing exists; section, list and spacing interactions require their own controls. | [docx.js](../src/engine/docx.js), [layout.js](../src/engine/layout.js) |
| `framePr` | Partial: grouped horizontal paragraph frames with bounded dimensions, anchors and wrapping. | No complete frame-property authoring contract. Drop caps and restricted cell/column/directional combinations remain unsupported. `anchorLock` is not consumed by the frame layout; audit it separately from anchors. | [paragraph-frames.js](../src/engine/paragraph-frames.js), [docx.js](../src/engine/docx.js) |
| `widowControl` | Bounded pagination with inherited/default flag resolution. | Flag editing exists. Whole-family native pagination fidelity is unproven. | [formatting.js](../src/engine/formatting.js), [layout.js](../src/engine/layout.js) |
| `numPr` | Partial: numId/ilvl references, numbering styles and level geometry. Tracked/unsupported numbering-reference children reject. | List edits serialize numId/ilvl; full list/revision semantics remain open. | `numberingReference` in [docx.js](../src/engine/docx.js), [docx-numbering.js](../src/engine/docx-numbering.js) |
| `suppressLineNumbers` | Supported: resolved through styles and direct formatting, editable, written in `pPr` order; suppressed lines are not counted. | Paragraph style dialog control. | `paragraphProperties` in [docx.js](../src/engine/docx.js); section ledger / roadmap L06 |
| `pBdr` | Partial: parsed side borders, inheritance and bounded grouping/painting. | Supported border edits serialize. Remaining styles and pagination/group interactions need focused controls. | [docx-paragraph-borders.js](../src/engine/docx-paragraph-borders.js), [paragraph-border-layout.js](../src/engine/paragraph-border-layout.js) |
| `shd` | Partial: supported fill/shading resolved and painted. | Supported shading edits serialize. Unsupported patterns and color combinations are separate gaps. | [docx-paragraph-shading.js](../src/engine/docx-paragraph-shading.js), [paragraph-backgrounds.js](../src/engine/paragraph-backgrounds.js) |
| `tabs` | Partial: declared/inherited tab stops, clear records, leaders, and supported alignments. | Tab edits exist; bounded positions and justified non-left tab fields retain restrictions. | `paragraphProperties` / `writeParagraphFormat` in [docx.js](../src/engine/docx.js), [paragraph-geometry.js](../src/engine/paragraph-geometry.js) |
| `suppressAutoHyphens` | Implemented (2026-10-13): direct and style values read; editor writes `w:val` 1/0; a suppressed paragraph is never split by automatic hyphenation. | Manual soft hyphens still apply. | [hyphenation-layout.js](../src/engine/hyphenation-layout.js), [layout.js](../src/engine/layout.js) |
| `kinsoku` | Missing declaration consumer. | Implement prohibited line-start/end behavior, language/settings inheritance and explicit false overrides with East Asian controls. | `paragraphProperties` in [docx.js](../src/engine/docx.js); roadmap L07 |
| `wordWrap` | Missing declaration consumer; ordinary wrapping is implemented separately. | Implement the paragraph-specific Latin-word breaking rule and inherited/false values; compare against normal oversized-word handling. | [layout.js](../src/engine/layout.js), [line-whitespace.js](../src/engine/line-whitespace.js) |
| `overflowPunct` | Missing declaration consumer. | Implement punctuation hanging/overflow behavior with line width, justification and drawing exclusions. | `paragraphProperties` in [docx.js](../src/engine/docx.js); roadmap L07 |
| `topLinePunct` | Missing declaration consumer. | Implement punctuation compression semantics with the related compatibility/grid controls. | `paragraphProperties` in [docx.js](../src/engine/docx.js); roadmap L07 |
| `autoSpaceDE` | Missing declaration consumer. | Implement East Asian/Latin automatic spacing with language and run overrides; retain source text rather than inserting spaces. | `paragraphProperties` in [docx.js](../src/engine/docx.js); roadmap L07 |
| `autoSpaceDN` | Missing declaration consumer. | Implement East Asian/numeric automatic spacing and interactions with `autoSpaceDE` and character pitch. | `paragraphProperties` in [docx.js](../src/engine/docx.js); roadmap L07 |
| `bidi` | Unsupported paragraph direction. Active bidi elements trigger import recovery; `resolvedFormat` also rejects enabled paragraph bidi. Run-level RTL text has a separate implemented path. | Implement paragraph base direction, start/end alignment and directional geometry. The active-node guard currently checks presence even for an explicit off declaration; add controls before revising it. | [docx.js](../src/engine/docx.js), [formatting.js](../src/engine/formatting.js), [bidi-text.js](../src/engine/bidi-text.js) |
| `adjustRightInd` | Missing declaration consumer. | Implement right-indent adjustment against section grids and effective direction. | `paragraphProperties` in [docx.js](../src/engine/docx.js); section grid gap |
| `snapToGrid` | Missing paragraph grid consumer. | Implement with section grid type/pitch, exact line spacing and run overrides; default/no-op declarations must not force an unrelated approximation. | [line-spacing.js](../src/engine/line-spacing.js), section ledger |
| `spacing` | Partial: point/line/automatic before/after spacing and auto/exact/atLeast line rules, with compatibility variations. | Point and line-spacing edits serialize supported values; ranges and grid interactions remain restricted. | [docx-paragraph-spacing.js](../src/engine/docx-paragraph-spacing.js), [formatting.js](../src/engine/formatting.js), [line-spacing.js](../src/engine/line-spacing.js) |
| `ind` | Partial: physical/logical distance indents and first-line/hanging precedence. Nonzero character-unit indents reject; paragraph bidi/mirroring remain restricted. | Distance edits serialize. Implement character-unit and directional behavior with inherited precedence. Strict and Transitional attribute spellings differ; matching row counts do not establish equivalent serialization. | [docx.js](../src/engine/docx.js), [formatting.js](../src/engine/formatting.js), [paragraph-geometry.js](../src/engine/paragraph-geometry.js) |
| `contextualSpacing` | Bounded same-style paragraph spacing suppression. | Editing and serialization exist; tables, list boundaries and style changes require their own regression scopes. | [docx-contextual-spacing.js](../src/engine/docx-contextual-spacing.js), [layout.js](../src/engine/layout.js) |
| `mirrorIndents` | Enabled mirrored paragraph indents explicitly reject; an off value is parsed. | Implement inside/outside paragraph geometry in facing-page layouts, preserving logical and character-unit precedence. | [formatting.js](../src/engine/formatting.js); roadmap L04 |
| `suppressOverlap` | Missing declaration consumer. | Implement frame collision avoidance separately from drawing overlap/wrapping; generic wrapping is not this property. | [paragraph-frames.js](../src/engine/paragraph-frames.js), `paragraphProperties` in [docx.js](../src/engine/docx.js) |
| `jc` | Partial: left/center/right/start/end/both; logical alignment currently maps to horizontal LTR behavior. Arabic kashida, other values and some tab combinations reject. | Supported alignment edits serialize. Implement distributed/Thai/directional variants and required native layout controls. | [formatting.js](../src/engine/formatting.js), [justification.js](../src/engine/justification.js) |
| `textDirection` | Missing paragraph declaration consumer. Table-cell rotation and section guards are distinct contexts. | Implement paragraph-specific direction and its valid contexts rather than reusing cell behavior without controls. | `paragraphProperties` in [docx.js](../src/engine/docx.js), [layout.js](../src/engine/layout.js) |
| `textAlignment` | Missing explicit paragraph value consumer; existing default baseline/object metrics do not implement all declared alignments. | Implement top/center/baseline/bottom/auto mixed-content alignment, including exact line rules and objects. | [line-builder.js](../src/engine/line-builder.js), [line-spacing.js](../src/engine/line-spacing.js) |
| `textboxTightWrap` | Missing declaration consumer. | Implement text-box wrapping modes and paragraph-specific exclusions with floating geometry controls. | `paragraphProperties` in [docx.js](../src/engine/docx.js), [layout.js](../src/engine/layout.js) |
| `outlineLvl` | Bounded levels 0–9, inherited heading/outline resolution. | Outline edits/clearing exist; built-in heading restrictions are explicit. Full outline-generated content is separate field/navigation scope. | [outline.js](../src/engine/outline.js), [model.js](../src/engine/model.js), [docx.js](../src/engine/docx.js) |
| `divId` | Preservation only; no paragraph HTML-division consumer. | Audit division metadata and HTML interchange, including split/join provenance; not an ordinary screen ornament. | Source shells / `propertyOrder` in [docx.js](../src/engine/docx.js) |
| `cnfStyle` | Conditional table regions are derived from current table geometry and look settings, rather than blindly applying cached paragraph flags. | Preserve/recompute behavior already has contradictory-cache controls. Full conditional-property coverage remains partial; arbitrary ignored properties are not thereby supported. | [table-style-regions.js](../src/engine/table-style-regions.js), [conditional controls](../tests/fixtures/conditional-table-styles/README.md) |
| `rPr` | Partial: paragraph-mark run properties affect terminal/empty-line metrics and insertion formatting. This is not identical to formatting every visible run. | Mark formatting edits and serialization exist; nested run-property/mark-revision coverage requires a separate ledger. | [model.js](../src/engine/model.js), `markStyle` in [layout.js](../src/engine/layout.js), [docx.js](../src/engine/docx.js) |
| `sectPr` | Partial: paragraph-held section boundaries and geometry; supported section settings are parsed. | Section edits and story inheritance retention exist. See the separate 22-property section ledger for limitations. | [section ledger](section-property-coverage.md), [section-story-edit.js](../src/engine/section-story-edit.js) |
| `pPrChange` | Previous formatting retained and listed as a formatting revision; current formatting is rendered. | Accept exists for retained formatting revisions; reject does not restore previous formatting. Native original-format/revision controls remain open. | [revisions.js](../src/engine/revisions.js), `resolveRevisions` in [model.js](../src/engine/model.js); roadmap S03 |

## Inventory boundary and verification

Run `python tools/audit-section-schema.py PATH_TO_wml.xsd --type CT_PPr
--ledger docs/paragraph-property-coverage.md` from the app. The historical tool
name remains compatible with section inventory; its default type is `CT_SectPr`.
Both supplied schemas have 36 direct paragraph properties and no own attributes.
`CT_PPrBase` and the style-context `CT_PPrGeneral` have different boundaries;
this ledger does not pretend their content models are identical to body `CT_PPr`.
Immediate nested declarations are inventoried, but their complete attribute/type
semantics, imported types and vendor extensions remain follow-up work.

Schema SHA-256 values: Strict
`44fc2233c5df2cfbe0b3b50e7024bd8412ec99dfe7176313ef58845fdec5498d`;
Transitional `0f7784b36ddc42950e5ff354cd608b83b60e4de39325d5568913f1225365029b`.
The row check catches omissions/duplicates; implementation classifications above
come from code review and existing controls, not schema name matching.

Relevant existing regressions include [pagination](../tests/canvas-pagination.test.js),
[indents/tabs](../tests/canvas-indents-tabs.test.js),
[paragraph spacing](../tests/canvas-paragraph-line-units.test.js),
[contextual spacing](../tests/canvas-contextual-spacing.test.js),
[paragraph marks](../tests/canvas-paragraph-mark-metrics.test.js),
[conditional styles](../tests/canvas-conditional-table-styles.test.js), and
[formatting reset](../tests/canvas-paragraph-reset.test.js). This audit introduces
no rendering change, no new native visual controls and no template-completion
claim. Next controls should target silent East Asian/grid declarations,
explicit bidi-off recovery, frame collision flags and mixed-content alignment.
