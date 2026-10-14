# Insert tab parity

What the Insert tab offers compared with desktop word processors, what is approximated, and what is
missing. File-format details are in [conformance.md](../conformance.md#insert-tab-2026-10-13).

## Implemented

| Group | Commands |
| --- | --- |
| Pages | Cover Page gallery (seven original designs, replaces an existing cover, Remove Current Cover Page), Blank Page, Page Break |
| Illustrations | Pictures (This Device incl. SVG/GIF/WebP/BMP, From Puter, Generate with AI, Screenshot), Shapes (133 presets in eight categories; click or drag on the page, or Enter to insert at the caret), Icons (205 original icons, search, categories, color, multi-select; SVG with PNG fallback), Diagram (eleven layouts from a text outline, five color sets, edit regenerates), Chart (column, bar, line, area, pie, doughnut, scatter with a data grid and live preview; edit data later) |
| Links, Comments | Link, Bookmark, Comment (existing commands; also in the Insert menu) |
| Header & Footer | Header and Footer galleries (blank, three columns, title, title and date, lined, banded, page X of Y, accent bar), Edit, Remove; Page Number (top, bottom, current position; plain, accent bar, page N, page X of Y, dashes, brackets, bold), Format Page Numbers (format, continue or start at), Remove Page Numbers |
| Text | Text Box gallery (simple, sidebar, pull quote, banded, note, rounded callout) and Draw Text Box; Quick Parts: AutoText (save selection with formatting, insert, delete; per user in this browser), Document Property, Field… (20 field types with arguments, date pictures, case and number formats, live code and result preview); WordArt (twelve styles); Drop Cap (None, Dropped, In Margin, options: font, lines, distance); Signature Line; Date & Time (17 formats, update automatically as a field, set default); Object → Text from File (.docx, .md, .html, .txt) |
| Symbols | Equation (linear input with MathML preview, symbol palette, gallery of common equations, Ctrl+= on a Mac / Alt+= elsewhere, edit an existing equation), Symbol (recent symbols; More Symbols with Unicode subsets, character code entry, font, Special Characters) |
| Menus | Insert menu items for the commands above; Format → Drop Cap…; context menu: Edit Diagram…, Edit Chart Data…, Edit Equation… |
| Keyboard | Ctrl+= / Alt+= equation; Alt+Shift+D date field, Alt+Shift+T time field, Alt+Shift+P page number |

## Approximated

- Diagrams are groups of ordinary shapes, not diagram-definition parts: other applications draw them
  exactly, but see shapes rather than an editable diagram there. The outline is kept as alt text.
- WordArt is a text box with outline, fill and shadow text effects; warped (transformed) text is not
  available. Signature lines are drawings, not signature-capable objects.
- Equations show in the document as linear text; the dialog previews them in two dimensions.
- Charts carry their data inline without an embedded workbook.
- AutoText is stored in this browser (per signed-in user), not in a template or the user's cloud.
- Document Property inserts DOCPROPERTY fields rather than content controls bound to the properties,
  and the properties themselves cannot be edited here yet.
- Nonbreaking and optional hyphens are inserted as Unicode characters.
- Drop caps use generic cap-height ratios; caps in indented paragraphs sit at the column edge.

## Gaps

- Page numbers in the page margins, chapter numbers in page numbers, Building Blocks Organizer, Ink
  Equation, 3D models, online/stock pictures, video, add-ins, embedded objects other than text from a
  file, cross-reference (References tab), table galleries (Tables area).
- Shape adjustment handles; shaded shape faces paint flat except darkenLess.
- Fields: numeric picture switch, EDITTIME, fields other than PAGE/NUMPAGES in headers and footers.
- Charts: data labels, axis titles, secondary axes, combination charts, non-Latin labels.
- Equation arrays' alignment points and delimiter separators.
- Format Page Numbers is not part of undo history.
