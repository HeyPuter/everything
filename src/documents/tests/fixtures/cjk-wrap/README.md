# Chinese and Japanese line breaking

`tools/cjk_wrap_fixture.py` manually constructs five OOXML paragraphs, each on
a separate page, using the original table-shading fixture's package shell. No
template content or third-party engine is used. Right indents narrow each
paragraph so that it wraps. The cases are English words followed by Chinese,
Japanese with brackets, small kana and the prolonged sound mark, Chinese
quotation, dash, ellipsis and title punctuation, Chinese split across source
runs, and Korean, which keeps wrapping between words. `cases.json` lists each
case's runs and writing width in points.

There is no native reference: the tests check the East Asian line rules
(no line starts with closing punctuation, small kana or the prolonged sound
mark, none ends with opening punctuation, a Korean line ends at a space), that
lines beside ideographs are filled, and that the lines rebuild the source text,
rather than comparing exact line positions with another application.
