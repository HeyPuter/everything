# Format area parity

The Home tab's font, paragraph, styles and editing depth and the Format menu's dialogs, compared with
desktop word processors. File-format details are in
[conformance.md](../conformance.md#format-area-2026-10-13).

## Implemented

| Area | What is there |
| --- | --- |
| Font dialog (Cmd/Ctrl+D) | Font, style, size, colour, underline style and colour; strikethrough, double strikethrough, superscript, subscript, small caps, all caps and **hidden**; Advanced: scale, spacing, position, kerning, and ligatures where the document renders OpenType features; live preview; **Set As Default** (Normal style); **Text Effects…** |
| Text Effects | Format Text Effects dialog (fill or no fill, outline colour and width, outer shadow with colour, transparency, blur, distance, angle and presets) and the Home Text Effects menu with a link to it |
| Hidden text | Stored as `w:vanish`; hidden until Show Formatting Marks is on, then shown with a dotted underline |
| Paragraph dialog (Paragraph Settings, Cmd+Option+M on a Mac) | Indents and Spacing: alignment, outline level, left/right (inside/outside with **mirror indents**), first-line/hanging, before/after, line spacing (single, 1.5, double, at least, exactly, multiple), don’t add space between paragraphs of the same style, live preview. Line and Page Breaks: widow/orphan, keep with next, keep lines together, page break before, suppress line numbers, don’t hyphenate. **Tabs…** and **Set As Default** |
| Tabs dialog | Stop list, position entry, default stops, left/center/right/decimal/**bar**, leaders, Set/Clear/Clear All, stops to be cleared |
| Borders and Shading | Borders tab: None/Box/All presets, style, colour, width, per-side toggles by clicking the preview or with buttons (Top, Bottom, Left, Right, Between), distance from text. Page Border tab: Box/None, style, colour, width, apply to whole document / first page / all but first, measure from text or page edge, in front of text, margins. Shading tab: fill, pattern (clear, solid, 5%–95%), pattern colour, apply to paragraph or text, preview. Home **Borders** split button: bottom/top/left/right/all/outside/inside/none and the dialog |
| Bullets and Numbering | Format menu dialog with bullet, number and multilevel libraries; **Define New Bullet** (symbol grid, any character, symbol picker, font, colour, alignment), **Define New Number Format** (style, text before/after, start, alignment, font, bold/italic), **Define New Multilevel List** (all nine levels: style, format with level numbers, start, alignment, positions, follow with), **Set Numbering Value** (new list or continue, advance value), **Adjust List Indents**; list context menu: Restart at 1, Continue Numbering, Set Numbering Value…, Adjust List Indents… |
| Styles | Styles pane (Home **Styles Pane**, Cmd+Option+Shift+S): current style, Select All N Instances, New Style…, Clear Formatting, apply, per-style menu (Modify, Delete, Select All Instances, Update to Match Selection), Recommended / In use / All, previews on/off, Manage Styles…. **Style Inspector** (paragraph and text formatting with separate clears) and **Reveal Formatting** (Shift+F1; font, paragraph and section values, direct versus style, links to the dialogs). **Apply Styles** box (Cmd/Ctrl+Shift+S; apply, reapply, create by typing a new name, modify). Format → **Style…** dialog (description, New, Modify, Delete, Apply). New Style from Formatting |
| Select menu | Select All, Select Objects (cycles pictures, shapes and text boxes), Select All Text With Similar Formatting |
| Paste | Paste menu: Keep Source Formatting, **Merge Formatting**, Keep Text Only, **Paste Special…** (HTML, merged formatted text, unformatted text, picture); Paste and Match Formatting (Cmd+Option+Shift+V); a paste-options chip after each paste switches the mode in place |
| Find and Replace | More options: wildcards, match prefix/suffix, ignore punctuation/white space, search the document, the selection or **headers and footers**, **Format** (font, paragraph, style, highlight) for Find and for Replace, No Formatting, **Special** characters menu |
| Format Painter | Click once, double-click to keep painting until Escape; Cmd/Ctrl+Shift+C copies formatting and Cmd/Ctrl+Shift+V pastes it; a selection that includes the paragraph mark copies paragraph formatting too |
| Change Case | Home menu (five conversions), Shift+F3 cycle, Format → Change Case… dialog |
| Dictate | Home **Dictate** (Voice group) where the browser offers speech recognition; listening banner with the words being recognized, spoken punctuation (period, comma, new line, new paragraph…), Escape to stop, one undo step per phrase |
| Menus | `extendMenu('format')`: Font, Text Effects, Paragraph, Bullets and Numbering, Borders and Shading, Tabs, Change Case, Style. `extendMenu('edit')`: Paste Special, Paste and Match Formatting, Advanced Find and Replace, Select ▸, Start Dictation. `extendMenu('view')`: Styles Pane, Reveal Formatting, Style Inspector. Context menu: Font, Paragraph, Bullets and Numbering, Styles ▸, Select Text with Similar Formatting; list items |

## Approximated

- Several discontiguous selections are not available: Select All N Instances and similar-formatting
  selection select the first range (or one contiguous block) and highlight the rest, with a link to
  Find formatting to change them all.
- Shading patterns are saved as the flat colour they paint.
- Set As Default changes the Normal style rather than the document defaults.
- Defining bullets, number formats or list indents gives the whole list a new definition (other
  documents keep theirs); restarts already in that list are kept by their instances.
- Hidden text, line-number suppression and hyphenation suppression are stored faithfully; the last
  two have no visible effect because line numbering and automatic hyphenation are not laid out.
- The Paragraph dialog's preview is schematic; the Font dialog's preview uses browser fonts.

## Gaps

- Borders on text (character borders), art page borders, page borders per section, shadow and 3-D
  border settings, horizontal line.
- Reflection, glow, soft edges and 3-D text effects (imported ones are kept), number forms, number
  spacing and stylistic sets.
- Picture bullets, legal-style numbering, linking list levels to styles, list galleries in other
  documents.
- Styles: linked-style toggling, style guides, Style Organizer (copy between documents), style
  visibility/priority settings.
- Find: sounds like, all word forms, replacing with paragraph marks inside table cells, footnotes and
  text boxes as search scopes.
- Paste: RTF and other legacy clipboard formats, default paste settings.
- Dictation: language choice; punctuation commands are English only.
EOF
git add docs/conformance.md docs/parity/format.md && git commit -q -m "Document the Format area: conformance record and parity notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && echo ok