# References tab parity

Status of the References tab against desktop word processors. OOXML details
and the exact supported switches are in
[conformance.md](../conformance.md#references-tab-notes-fields-citations-and-generated-tables-2026-10-13).

## Implemented

**Table of Contents** — a gallery of five original designs (Classic, Open,
Ruled, Compact, Linked) with live paper previews; Custom Table of Contents
(levels, page numbers, right alignment, tab leader, hyperlinks, build from
heading styles, outline levels or any paragraph style mapped to a level, live
preview); Add Text (Do Not Show / Level 1–9, applying the heading style when the
document has it, else the outline level); Update Table (page numbers only or the
entire table); Remove Table of Contents. Update Fields (F9) stays on the tab.

**Footnotes** — Insert Footnote (Cmd+Option+F / Ctrl+Alt+F), Insert Endnote
(Cmd+Option+E / Ctrl+Alt+D; Cmd+Option+D is a macOS system chord), Next/Previous
Footnote and Endnote, Show Notes (between a reference and its note), and the
Footnote and Endnote dialog: location (bottom of page / below text; end of
document / end of section), number format including symbols, custom mark,
start at, numbering (continuous / each section / each page), Apply, Insert and
Convert (footnotes to endnotes, back, or swap). Endnotes render after the last
line, continue on added pages, and round-trip through `endnotes.xml`.

**Research** — Smart Lookup: a side pane with a short definition and related
topics from Puter AI for the selection (or the word at the caret), with follow-up
lookups and a web search link. Hidden when AI is unavailable; also in the
document menu and Tools menu.

**Citations & Bibliography** — Insert Citation (document sources, Add New
Source, Add New Placeholder); a source dialog for every standard source type with
the fields each needs, corporate authors, all fields on demand, an automatic
tag and a live preview in the current style; Manage Sources (the account's
master list beside the document's list, copy both ways, edit, delete, new,
search, cited/placeholder markers and a citation + entry preview); a Style
selector (APA 7, Chicago author-date, Harvard, IEEE, MLA 9) that refreshes every
citation and bibliography; the Bibliography gallery (Bibliography, References,
Works Cited) and Insert Bibliography. Document menu on a citation: Edit Citation
(pages, prefix, suffix, suppress author/year/title), Edit Source, Convert to
Static Text, Update Citations and Bibliography.

**Captions** — Insert Caption (Figure/Table/Equation and custom labels with New
Label and Delete Label, five number formats, position, exclude label, live
preview); Insert Table of Figures (label, include label and number, page
numbers, alignment, leader, hyperlinks, preview); Update Table of Figures;
Cross-reference to headings, bookmarks, footnotes, endnotes and every caption
label, with text, page, above/below, note-number and caption-part choices,
"Insert as hyperlink" and "Include above/below".

**Index** — Mark Entry as a modeless panel (main entry, subentry,
cross-reference, current page or page-range bookmark, bold/italic page numbers,
Mark and Mark All; it picks up a new selection when you return to it;
Cmd+Option+Shift+X / Alt+Shift+X); entry codes appear with formatting marks;
Insert Index (indented or run-in, columns, right-aligned pages with leader,
letter-heading formats, language, preview); Update Index.

**Table of Authorities** — Mark Citation as a modeless panel (long and short
citation, category, already-marked list, Next Citation finder, Mark and Mark
All; Cmd+Option+Shift+I / Alt+Shift+I); Insert Table of Authorities (category or
All, passim, keep formatting, leader, preview); Update.

**Menus** — Insert menu: Bookmark…, Cross-reference…, Footnote…, Caption…,
Index and Tables (Index, Table of Contents, Table of Figures, Table of
Authorities). View menu: Footnotes (Show Notes). Tools menu: Smart Lookup.

## Approximated

- Endnotes placed at the end of each section are shown after the last section.
- Hidden XE/TA/TC codes are painted above the line instead of reflowing it.
- Index columns are stored in the field; the page shows one column.
- Footnote and endnote setting changes, and source edits, are saved but are not
  undo steps. Settings apply to the whole document only.
- The citation styles cover the common source types and rules (see
  conformance.md for the limits); no style-sheet language is interpreted.
- TOC designs are direct formatting; a document's own TOC styles still win.

## Gaps

- Caption chapter numbering (`SEQ \s`) and AutoCaption.
- "Save Selection to Bibliography Gallery" and custom TOC/bibliography gallery
  entries.
- Researcher, Insert Table of Figures from styles other than caption labels,
  TOA categories editing (names 8–16), and index AutoMark concordance files.
- Section-level note properties, note separators/continuation notices,
  endnotes split across pages.
- Bibliography language/filter switches and citation `\l` language-specific
  formatting.
