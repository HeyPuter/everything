# Run direction inside right-to-left paragraphs

`control.docx` is written directly as WordprocessingML by
`tools/rtl_paragraph_direction_fixture.py` (SHA-256
`84e46a1efbb6974f9cd7b45e5eed9ca50d623be4da5d722f0c49a73617ae0ada`). Its twelve
one-line paragraphs vary `w:bidi` on the paragraph and `w:rtl` on its runs over
the same Hebrew (שלום, עולם), Latin, digit and punctuation text.

The file was opened in the reference application (desktop, macOS, version 16.114,
2026-11-10) and the order of each line read from the page as displayed. This is
an observation of ordering and of which margin and tab stop text meets, by eye
and at screen resolution; no glyph coordinates were recorded.

| # | Paragraph | Runs | Displayed, left to right |
| --- | --- | --- | --- |
| 1 | bidi | ordinary `1 שלום עולם.` | `1`, עולם, שלום, `.` at the right margin |
| 2 | bidi | ordinary `2 Hello world.` | `2 Hello world.` at the right margin |
| 3 | bidi | rtl `3 שלום עולם.` | `.`, עולם, שלום, `3` |
| 4 | bidi | rtl `4 Hello world.` | `.`, `Hello world`, `4` |
| 5 | bidi | ordinary `5 abc `, rtl שלום, ordinary ` def.` | ` def.`, שלום, `5 abc ` |
| 6 | bidi | ordinary `6 שלום abc עולם.` | `6`, שלום, `abc`, עולם, `.` |
| 7 | left-to-right | ordinary `7 שלום עולם.` | `7`, עולם, שלום, `.` at the left margin |
| 8 | bidi | ordinary `8 (שלום) 123 abc!` | `8 (`, שלום, `) 123 abc!` |
| 9 | bidi | ordinary `9 שלום`, ` `, `עולם`, `.` (four runs) | as line 1 |
| 10 | bidi, left tab at 2in and right tab at 5in | ordinary `10 a`, tab, `b`, tab, rtl שלום | `10 a` ends at the right margin; `b` ends 2in from it; שלום starts (its left edge) 5in from it |
| 11 | bidi | ordinary `11 שלום: abc, עולם (x) 12.5%` | the text as written, left to right, with each Hebrew word reversed in place |
| 12 | bidi | rtl, same text | `(x) 12.5%`, עולם, `,abc`, `:`, שלום, `12` |

What the lines establish:

- A run without `w:rtl` in a right-to-left paragraph is laid out as it would be
  in a left-to-right paragraph (lines 1, 2, 6, 8, 11 against line 7), as one
  unit placed in the paragraph's right-to-left order (line 5). Consecutive such
  runs form a single unit, however the text is split into runs (line 9).
- A `w:rtl` run is resolved at the paragraph's right-to-left level by the
  ordinary bidirectional algorithm: its Latin words and numbers still read left
  to right, and its spaces and punctuation take the right-to-left direction
  (lines 3, 4, 12).
- Tab positions are measured from the right margin, and a left tab starts the
  following text at the stop, flowing leftwards; a right tab ends it there
  (line 10).

ECMA-376 Part 1 §17.3.1.6 (`bidi`) and §17.3.2.30 (`rtl`) do not state how a run
without `w:rtl` is ordered inside a right-to-left paragraph; the first point is
the reference application's behavior, followed here so documents written there
keep their reading order. `tests/rtl-paragraph-controls.test.js` lays this file
out and checks every row.

One difference remains, in line 12: the reference application shows `(x) 12.5%`
and this engine `12.5% (x)`. UAX #9 rule N0 resolves the brackets around the
Latin `x` to the right-to-left direction of the run; the reference application
keeps them with the letter. It concerns ordering inside any `w:rtl` run, in
paragraphs of either direction, and predates paragraph direction support. The
test checks line 12 without that token and names the gap.

`public/fixtures/rtl-paragraphs.docx` (`tools/rtl_paragraph_fixture.py`) is the
separate editing fixture: alignment, indents, a hanging tab, a list, a style
that carries the direction, a table cell and a right-to-left section. It was
opened in the same reference application; every paragraph met the same margin
and showed the same order as the editor's canvas.
