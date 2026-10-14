# Documents

A browser word processor with an original canvas editor and `.docx` files stored in your own Puter cloud — an open-source alternative to Microsoft Word.

This branch implements the original canvas engine. **AGPL code and dependencies must not be introduced.** The dependency policy is recorded in [AGENTS.md](AGENTS.md) and checked by `npm run check:licenses` and before production builds.

## Run

```sh
npm ci
npm run dev
```

- **`/playground.html`** — standalone local editor; no account or cloud SDK. Includes two-paragraph and two-page samples, local DOCX opening, and downloads.
- **`/mock.html`** — the app with an in-memory Puter mock for testing save/reopen.
- **`/`** — the app using Puter for cloud storage.

## Canvas editor features

- Review: comment threads in a margin column (reply, edit, resolve, delete) and Track Changes (record, All/Simple/No Markup/Original, accept/reject, change bars, Reviewing Pane); Read Aloud.
- References: table of contents, footnotes at the foot of the page, captions (SEQ), cross-references (REF/PAGEREF), Update Fields (F9).
- Headers and footers: create when missing, page numbers, Different First Page, Different Odd & Even Pages, on-page editing cues.
- Retained content that no longer forces read-only: SEQ/REF/DATE/AUTHOR/citation fields, hidden text, equations (shown linearly), tracked formatting changes.
- Metric-compatible substitutes for Calibri, Cambria, Arial, Times New Roman and Courier New; File → Save as PDF with searchable text.

- Single and double strikethrough with style inheritance, explicit removal and font-based canvas strokes.

- Trailing ordinary spaces stay on their line, with preserved wrapping/underline compatibility flags and bounded caret/selection geometry.

- Kerning thresholds with style inheritance and explicit control of Canvas letter-pair spacing.
- Contextual spacing between paragraphs of the same style, with inheritance and the table compatibility setting.
- Horizontal text scaling from 1–600%, with inheritance and preserved font height and character spacing.
- Expanded/condensed character spacing with style inheritance, zero resets and shared measurement/painting.
- Signed baseline shifts with style inheritance, zero resets and preserved font sizes.
- Superscript/subscript editing and style inheritance, with preserved font sizes and shifted canvas text geometry.
- Text highlighting with the OOXML palette, explicit removal, and inherited flat run shading.
- RGB/automatic text color editing with inherited theme colors, tint/shade and colored single underlines.
- Canvas text rendering with a bundled Noto Sans font.
- Click to place the caret; drag, Shift+click, and keyboard selection across paragraphs and pages.
- Text insertion/deletion, paragraph splitting/merging, bold, italic, single underline, font sizes in half-point steps, undo and redo.
- Left, center, right and justified paragraph alignment; custom line-spacing multiples, exact/minimum point heights and before/after spacing, with inherited resets.
- Single-section Letter/A4/Legal/custom page setup, orientation, margins and gutter; manual page/line breaks and paragraph page breaks.
- Paragraph indents and tab stops with editable dot/dash/line leaders, keep-with-next/keep-lines, and widow/orphan control.
- Bullets and numbering, reusable paragraph and character styles, and inherited formatting with the ECMA-376 toggle-property rules.
- Fixed-width and AutoFit tables, horizontal/vertical cell merges, rows flowing across pages, and repeated headers.
- Editable automatic/minimum row heights, including merged rows, undo/redo and page reflow.
- Editable outline levels and document navigation, with style inheritance and built-in heading semantics.
- Inline PNG/JPEG insertion, sizing, source cropping, horizontal/vertical flips, rotation, alt text and preserved original image bytes.
- Native text input and composition bridge; copy, cut and paste that keep headings, lists, emphasis, color and links (plain text inside tables, fields and controls).
- A native textarea mode for text editing.
- Local DOCX open/download and Puter save/reopen.
- Preservation of untouched DOCX package parts and original run/paragraph properties.

This is a restricted editor prototype. The page preview uses saved single-section dimensions/margins and the bundled Noto Sans upright/italic fonts; it is not a full reproduction of native DOCX layout. Fields, comments, tracked changes, multiple sections, nested tables, floating pictures, automatic paragraph spacing, and other unsupported structures are rejected before editing. The engine guide and conformance record define each supported subset. The built-in templates (Letter, Meeting notes, Report, Résumé, Essay) open as new documents laid out with the canvas engine's styles, lists and tables. Plain-text files import as one paragraph per line, and Markdown and HTML files with their headings, lists, emphasis and links. Advanced features from the previous editor are not yet connected.

See [the engine guide](docs/canvas-engine.md) for architecture, supported scope, the manual acceptance scenario, and the next iterations.

The editor separates the document title and save status, the File/Edit/View/Insert/Format/Table menus, and the everyday formatting toolbar. Less-used controls are available through the menus or **More formatting tools**. Mouse users get wrapping controls in narrow windows; touch users can swipe the toolbar. Keyboard users can move through menu titles and toolbar buttons with the arrow keys, and press Escape to return from the toolbar to the document.

On phone-sized screens, bold, italic, underline, text color and highlight stay in the toolbar. Strikethrough, superscript and subscript move into **More formatting tools** and remain available through Format → Text. Resizing moves the existing controls and preserves their selection state.

Find and Outline share labelled navigation controls at the left edge of the workspace, below formatting. On phones they form a horizontal row, leaving the document its full width. Find and replace and the outline use one left panel on desktop and a scrollable bottom panel on phones. The menus, formatting toolbar and File → Download .docx command remain available while searching. Phone layouts show one navigation/formatting/search panel at a time; Escape closes search and returns to the current match.

In the font-size field, Enter applies a valid size and returns to writing. Escape cancels the draft, including invalid or mixed-selection values, without adding an undo step or closing the phone formatting inspector.

## Checks

```sh
npm run check:licenses
npm test
npm run test:browser
# Requires Python test tools; see docs/conformance.md
npm run check:conformance
npm run build
```

Browser tests use installed Google Chrome by default. For Playwright Chromium, run `npx playwright install chromium` and set `PLAYWRIGHT_CHANNEL=chromium`.

The new tests cover document mutations, format preservation, rejection of unsupported files, pagination, native input events, browser downloads/reopening, and cloud save/reload using the mock. Tests tied to the removed engine have been retired; engine-independent utility, storage, and routing tests remain.

See [the conformance record](docs/conformance.md) for specification clauses, independent schema checks, rendering comparisons and remaining gaps.

## Source layout

```text
src/engine/model.js          document model and editing transactions
src/engine/docx.js           DOCX package preservation and serialization
src/engine/page-settings.js  page measurements, validation and geometry
src/engine/layout.js         wrapping, pagination and source-position geometry
src/engine/font-metrics.js   metrics from the bundled Noto font tables
src/engine/canvas-editor.js  canvas renderer and input adapter
src/views/editor.js         editor controls and storage integration
src/playground.js           standalone local harness
src/lib/doc.js              existing save, conflict, version and lifecycle model
public/fixtures/            independently generated sample DOCX
public/fonts/               Noto Sans, its license and provenance
```

Older app-authored import/export helpers remain for later migration. They do not imply current canvas-engine support for those features.

## Licensing

- Application and original canvas engine: [MIT](../../LICENSE).
- ZIP codec `fflate`: MIT.
- Real-time co-editing (CRDT) `yjs` and its `lib0` and `isomorphic.js` helpers: MIT.
- Noto Sans: [OFL-1.1](public/fonts/OFL.txt), with [source provenance](public/fonts/PROVENANCE.md).
- Other retained dependencies: [third-party notices](public/licenses/THIRD_PARTY.txt).

`tools/check-licenses.mjs` checks all locked dependency license declarations, rejects unknown declarations and removed engine packages, and verifies the vendored font license. This is a dependency-policy check, not a claim that package metadata replaces a source audit. Run `node tools/generate-licenses.mjs` after changing runtime dependencies to refresh distributed notices.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
