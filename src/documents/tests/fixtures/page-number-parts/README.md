# Page-number building blocks in headers and footers

`build.mjs` writes `page-number-parts.docx` from hand-authored WordprocessingML (it does not use the
editor's writer). Its three stories follow the structure word processors save for Insert > Page Number:

- `header1.xml`: Top of Page, one block `w:sdt` with `w:docPartObj`/`w:docPartGallery w:val="Page Numbers (Top of Page)"`
  around a right-aligned paragraph holding a complex `PAGE` field, followed by an ordinary empty paragraph.
- `footer1.xml`: Bottom of Page, the same wrapper with the "Page Numbers (Bottom of Page)" gallery and an
  `w:sdtEndPr`, centred, with a `w:fldSimple` `PAGE`.
- `footer2.xml` (first page): "Page X of Y", a Bottom of Page wrapper nesting a Top of Page wrapper, as the
  "Bold Numbers" design is saved, with `PAGE` and `NUMPAGES` fields.

Run `node tests/fixtures/page-number-parts/build.mjs` to regenerate the file.
