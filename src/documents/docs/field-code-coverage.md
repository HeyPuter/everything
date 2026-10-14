# Field-code coverage

Reviewed 2026-10-09 against code baseline `8fa68240` and the supplied ECMA-376
Part 1 fifth edition (December 2016), §17.16.5. All 72 actual numbered field
headings were extracted from PDF text and checked against the rows below. This
is a field-code inventory, not a schema enumeration: field instructions are
strings, and enumerating names does not validate their grammar or switches.
It contributes to roadmap A01 and S05/S06; the exhaustive audit remains open.
The current reader expects Transitional WML; this does not establish Strict
package support or coverage of all Transitional/vendor extension fields.

Evidence: [docx-page-fields.js](../src/engine/docx-page-fields.js),
[docx-body-fields.js](../src/engine/docx-body-fields.js),
[field-update.js](../src/engine/field-update.js),
[body-fields.js](../src/engine/body-fields.js),
[open-document.js](../src/engine/open-document.js),
[docx-field-results.js](../src/engine/docx-field-results.js),
[docx-macro-buttons.js](../src/engine/docx-macro-buttons.js),
[toc.js](../src/engine/toc.js) and [references.js](../src/views/references.js).

## Part 1 field codes

The inventory has 11 separately handled codes (all partial), 46 additional
cached-only codes and 15 codes without a dedicated editable-body handler. These
counts describe dispatch paths, not affected-template counts or visual success.
Mail merge (2026-10-13) added a merge evaluator for ADDRESSBLOCK, ASK, FILLIN,
GREETINGLINE, IF, MERGEFIELD, MERGEREC, MERGESEQ, NEXT, NEXTIF, SET and SKIPIF
(and REF to ASK/SET bookmarks) used by preview and merging only, and moved IF,
NEXT, NEXTIF and SKIPIF into the retained, editable set; the counts above predate it.

A retained field is not evaluated merely because its cached text looks correct.
An unhandled field can still show a saved result in read-only recovery. Recovery
is not safe editable support, and no saved result exists to recover in some files.
The table describes the body dispatch; page stories and drawing text have narrower
context-specific readers.

| Field code | Part 1 clause | Current behavior / remaining work |
| --- | --- | --- |
| `ADDRESSBLOCK` | §17.16.5.1 | Mail merge: inserted by the Address Block dialog and evaluated in preview and merge from matched columns. `\f` format groups (`<<…_TOKEN_…>>`), `\c` and `\e` are applied; `\d` (country-specific layout) and `\l` are retained but not applied. Blank lines are dropped. |
| `ADVANCE` | §17.16.5.2 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `ASK` | §17.16.5.3 | Mail merge: inserted by the Ask rule; one answer per prompt is collected before Finish & Merge and assigned to the bookmark for REF. `\d` and `\o` are honored; per-record prompting is not. |
| `AUTHOR` | §17.16.5.4 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `AUTOTEXT` | §17.16.5.5 | No dedicated body instruction handler or retained-code entry; strict editing import rejects it. Read-only recovery can project an available saved result; evaluation remains missing. |
| `AUTOTEXTLIST` | §17.16.5.6 | No dedicated body instruction handler or retained-code entry; strict editing import rejects it. Read-only recovery can project an available saved result; evaluation remains missing. |
| `BIBLIOGRAPHY` | §17.16.5.7 | Partial: result generated from the bibliography custom XML part in five original styles; `\l` retained, other switches not evaluated. See the References section of conformance.md. |
| `CITATION` | §17.16.5.8 | Partial: inline result generated from the bibliography part with `\m`, `\p`, `\f`, `\s`, `\v`, `\n`, `\y`, `\t`; refreshed on style or source changes. |
| `COMMENTS` | §17.16.5.9 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `COMPARE` | §17.16.5.10 | No dedicated body instruction handler or retained-code entry; strict editing import rejects it. Read-only recovery can project an available saved result; evaluation remains missing. |
| `CREATEDATE` | §17.16.5.11 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `DATABASE` | §17.16.5.12 | No dedicated body instruction handler or retained-code entry; strict editing import rejects it. Read-only recovery can project an available saved result; evaluation remains missing. |
| `DATE` | §17.16.5.13 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `DOCPROPERTY` | §17.16.5.14 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `DOCVARIABLE` | §17.16.5.15 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `EDITTIME` | §17.16.5.16 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `FILENAME` | §17.16.5.17 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `FILESIZE` | §17.16.5.18 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `FILLIN` | §17.16.5.19 | Mail merge: inserted by the Fill-in rule; the answer (or `\d` default) is the result in preview and merged output. One answer per prompt for the whole merge. |
| `FORMCHECKBOX` | §17.16.5.20 | No dedicated body instruction handler or retained-code entry; strict editing import rejects it. Read-only recovery can project an available saved result; evaluation remains missing. |
| `FORMDROPDOWN` | §17.16.5.21 | No dedicated body instruction handler or retained-code entry; strict editing import rejects it. Read-only recovery can project an available saved result; evaluation remains missing. |
| `FORMTEXT` | §17.16.5.22 | No dedicated body instruction handler or retained-code entry; strict editing import rejects it. Read-only recovery can project an available saved result; evaluation remains missing. |
| `GOTOBUTTON` | §17.16.5.23 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `GREETINGLINE` | §17.16.5.24 | Mail merge: inserted by the Greeting Line dialog; `\f` format with `_BEFORE_`/`_AFTER_` text and `\e` fallback for empty names are evaluated. `\l` is retained only. |
| `HYPERLINK` | §17.16.5.25 | Partial parsed clickable destination and retained instruction; combined external address plus bookmark is explicitly rejected. |
| `IF` | §17.16.5.26 | Retained with nested instruction fields (operands such as `{ MERGEFIELD City }`) kept in the envelope; editable. Evaluated in mail merge preview/output: `= <> < <= > >=`, numeric comparison, `*`/`?` wildcards for `=`/`<>`. Not refreshed by Update Fields outside a merge; formula operands are not evaluated. |
| `INCLUDEPICTURE` | §17.16.5.27 | No dedicated body instruction handler or retained-code entry; strict editing import rejects it. Read-only recovery can project an available saved result; evaluation remains missing. |
| `INCLUDETEXT` | §17.16.5.28 | No dedicated body instruction handler or retained-code entry; strict editing import rejects it. Read-only recovery can project an available saved result; evaluation remains missing. |
| `INDEX` | §17.16.5.29 | Partial generator: collation, three levels, run-in, letter headings, separators, type/bookmark/letter filters; `\c` columns stored but displayed in one column. |
| `KEYWORDS` | §17.16.5.30 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `LASTSAVEDBY` | §17.16.5.31 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `LINK` | §17.16.5.32 | No dedicated body instruction handler or retained-code entry; strict editing import rejects it. Read-only recovery can project an available saved result; evaluation remains missing. |
| `LISTNUM` | §17.16.5.33 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `MACROBUTTON` | §17.16.5.34 | Partial literal prompt display and formatting with retained command/envelope; command is never executed; prompt replacement requires removing the field. |
| `MERGEFIELD` | §17.16.5.35 | Mail merge: inserted from the ribbon/dialog as complex fields; evaluated in preview and merged output with `\b`, `\f`, `\*` (Upper, Lower, FirstCap, Caps, ordinal/roman/alphabetic), `\#` numeric and `\@` date pictures (common tokens). `\m`/`\v` retained only. Missing columns are reported by Check for Errors. |
| `MERGEREC` | §17.16.5.36 | Mail merge: evaluated as the record's 1-based position in the recipient list. |
| `MERGESEQ` | §17.16.5.37 | Mail merge: evaluated as the 1-based count of documents produced so far (skipped records excluded). |
| `NEXT` | §17.16.5.38 | Retained and editable. Mail merge: moves to the next record within one output copy (label sheets); Update Labels inserts it before each later label. |
| `NEXTIF` | §17.16.5.39 | Retained and editable with nested operands. Mail merge: moves to the next record when the comparison is true. |
| `NOTEREF` | §17.16.5.40 | Partial: Update Fields evaluates the bookmarked note reference number (`\h`, `\f`, `\p`); other switches keep the cache. |
| `NUMCHARS` | §17.16.5.41 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `NUMPAGES` | §17.16.5.42 | Partial evaluation from current layout; no full general-switch semantics. |
| `NUMWORDS` | §17.16.5.43 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `PAGE` | §17.16.5.44 | Partial evaluation from current layout; supported numeric/general formatting only; page-story locked-field behavior has dedicated handling. |
| `PAGEREF` | §17.16.5.45 | Partial bookmark-page refresh, including requested refresh on open; accepting instruction switches does not implement all their semantics. |
| `PRINT` | §17.16.5.46 | No dedicated body instruction handler or retained-code entry; strict editing import rejects it. Read-only recovery can project an available saved result; evaluation remains missing. |
| `PRINTDATE` | §17.16.5.47 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `PRIVATE` | §17.16.5.48 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `QUOTE` | §17.16.5.49 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `RD` | §17.16.5.50 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `REF` | §17.16.5.51 | Partial explicit refresh of plain bookmark text and basic relative position; unsupported/structural/self references keep caches and report issues. |
| `REVNUM` | §17.16.5.52 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `SAVEDATE` | §17.16.5.53 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `SECTION` | §17.16.5.54 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `SECTIONPAGES` | §17.16.5.55 | Partial evaluation of current section page count; locked results retained; complete geometry/section semantics remain dependencies. |
| `SEQ` | §17.16.5.56 | Partial explicit counter refresh with reset/repeat/hidden results and supported number formats (captions write all five general formats); heading restart and bookmark argument semantics remain missing. |
| `SET` | §17.16.5.57 | Mail merge: assigns its bookmark value for REF within the merge. No bookmark is created in the document. |
| `SKIPIF` | §17.16.5.58 | Retained and editable with nested operands. Mail merge: a true comparison leaves the record out of merged documents, printing and email; preview still shows it. |
| `STYLEREF` | §17.16.5.59 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `SUBJECT` | §17.16.5.60 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `SYMBOL` | §17.16.5.61 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `TA` | §17.16.5.62 | Partial: hidden authority entries (`\l`, `\s`, `\c`, `\b`, `\i`) written by Mark Citation and read for TOA. |
| `TC` | §17.16.5.63 | Partial: hidden contents entries; text, `\f`, `\l`, `\n` read by TOC generation. |
| `TEMPLATE` | §17.16.5.64 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `TIME` | §17.16.5.65 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `TITLE` | §17.16.5.66 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `TOA` | §17.16.5.67 | Partial generator: one category per field, `\h`, `\p` passim, `\f`, `\e`, `\l`. |
| `TOC` | §17.16.5.68 | Partial generator: `\o`, `\u`, `\t`, `\c`, `\a`, `\f`, `\l`, `\b`, `\h`, `\n`, `\p`, `\z`; unknown switches retained; only whole-paragraph results rebuild. |
| `USERADDRESS` | §17.16.5.69 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `USERINITIALS` | §17.16.5.70 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `USERNAME` | §17.16.5.71 | Cached result/source retained; no evaluator for this code in the current field refresh path. Implement its instruction, context, switches and result semantics. |
| `XE` | §17.16.5.72 | Partial: Mark Entry writes levels, `\t`, `\r`, `\b`, `\i`, `\f`; INDEX generation evaluates them (`\y` used for sorting). |

## Cross-cutting gaps and implementation work

- Complete valid field envelopes across paragraphs, stories and supported
  structural containers. Body reading supports nested result fields and, since
  the mailings work, fields nested inside an instruction (kept verbatim in the
  outer envelope and shown in braces in its instruction text); the flat
  page-field reader rejects nested result envelopes and non-run content inside
  complex fields. Do not flatten authored
  instructions or treat successful cache projection as support for those forms.
- Implement missing instruction evaluation, including IF comparisons and formula
  dependencies. Audit instruction grammar, argument quoting, result formatting,
  general switches, numeric/date pictures and error results per code. Arbitrary
  retained instruction strings currently bypass tokenization; retention does not
  prove grammar validity or semantic support.
- Complete REF numbering/formatting/structural results, self-reference errors,
  SEQ heading restart and bookmark scopes. The explicit updater skips locked fields
  and parents containing nested fields; it is not a general dependency evaluator.
  Unsupported SEQ tokens must not silently produce a misleading refreshed result.
- Implement consistent dirty/update-on-open behavior and dependencies across
  fields. The current opening path separately refreshes requested body PAGEREF;
  it does not refresh every retained type. Preserve unrequested authored caches.
- Extend TOC generation beyond the current basic outline-heading path. Resolve
  authored switches, custom styles, TC entries, bookmark scope, page suppression
  and other applicable sources before rebuilding an imported TOC. Keep mixed
  paragraph content safe. Implement INDEX generation and full XE semantics;
  implement TOA/TA and citation/bibliography field semantics separately.
- Implement document metadata/variables, dates, statistics, numbered lists,
  section/context references and other cached-only families. Define result and
  export behavior when their required source/context is unavailable.
- Keep unsupported behavior local: preserve field source and usable caches,
  render supported surrounding content, disclose approximations and only enable
  editing/export when retained structures can be preserved safely. Unknown field
  recovery is not permission to discard source or execute a command.
- Audit external data, include/link, mail-merge, legacy forms and interactive
  fields independently. Document unavailable contexts; displaying a saved result
  does not imply external-resource loading, automation or interactive support.

## Other retained codes and inventory boundary

The current retained set also includes `ADDIN`, `AUTONUM`, `AUTONUMLGL`, `AUTONUMOUT`, `BARCODE`, `DISPLAYBARCODE`, `EQ`, `INFO`.
These are outside the 72 Part 1 headings inventoried here. This list comes from
source dispatch, not a completed Part 4 or vendor extension inventory. Formula
instructions and all additional legacy/extension grammar require separate
specification review. Field container attributes, revision forms, cached run
formatting and all code-specific switch grammars are not exhaustively covered
by this name-level ledger.

Existing focused evidence includes
[retained-fields.test.js](../tests/retained-fields.test.js),
[nested-body-fields.test.js](../tests/nested-body-fields.test.js),
[reference-fields.test.js](../tests/reference-fields.test.js),
[sequence-fields.test.js](../tests/sequence-fields.test.js),
[hyperlink-fields.test.js](../tests/hyperlink-fields.test.js),
[index-fields.test.js](../tests/index-fields.test.js),
[macro-button-codec.test.js](../tests/macro-button-codec.test.js),
[numeric-page-fields.test.js](../tests/numeric-page-fields.test.js) and
[story-field-recovery.test.js](../tests/story-field-recovery.test.js).
These controls establish their tested subsets; this documentation checkpoint
adds no new runtime, corpus-rendering or native-reference compatibility claim.
