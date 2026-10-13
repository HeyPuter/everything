import {
  PDFHexString,
  beginText,
  endText,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setFontAndSize,
  setTextRenderingMode,
  showText,
  TextRenderingMode,
} from "pdf-lib";

// Invisible text in any script, for a PDF's text layer: the standard fonts
// encode only Latin text, so a line in Cyrillic, Greek or Japanese written
// with them could be neither found, copied nor read aloud. These fonts have
// empty glyphs, as the text layers of scanned documents do; each holds up
// to 256 characters, each mapped to its Unicode text, which is what
// search, copying and screen readers use.
const WIDTH = 500;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function createUnicodeText(pdf) {
  const fonts = [],
    fontOf = new Map(),
    names = new WeakMap();
  let glyph = null;
  function newFont() {
    glyph ??= pdf.context.register(pdf.context.stream(`${WIDTH} 0 d0`, {}));
    const toUnicode = pdf.context.nextRef();
    const ref = pdf.context.register(
      pdf.context.obj({
        Type: "Font",
        Subtype: "Type3",
        FontBBox: [0, 0, WIDTH, 700],
        FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: { g: glyph },
        Encoding: {
          Type: "Encoding",
          Differences: [0, ...Array(256).fill("g")],
        },
        FirstChar: 0,
        LastChar: 255,
        Widths: Array(256).fill(WIDTH),
        Resources: {},
        ToUnicode: toUnicode,
      }),
    );
    const font = { ref, toUnicode, codes: new Map() };
    fonts.push(font);
    return font;
  }
  // The font and code of each character, as runs of one font each.
  function encode(text) {
    const runs = [];
    for (const { segment } of segmenter.segment(text)) {
      let font = fontOf.get(segment);
      if (!font) {
        font = fonts.at(-1);
        if (!font || font.codes.size === 256) font = newFont();
        font.codes.set(segment, font.codes.size);
        fontOf.set(segment, font);
      }
      const code = font.codes.get(segment).toString(16).padStart(2, "0");
      if (runs.at(-1)?.font === font) runs.at(-1).hex += code;
      else runs.push({ font, hex: code });
    }
    return runs;
  }
  function resourceName(page, font) {
    if (!names.has(page)) names.set(page, new Map());
    const known = names.get(page);
    if (!known.has(font))
      known.set(font, page.node.newFontDictionary("Text", font.ref));
    return known.get(font);
  }
  return {
    // Draws `text` invisibly from (x, y) in the current coordinates, spread
    // across `width` when given.
    draw(page, text, x, y, size, width) {
      const runs = encode(text),
        count = runs.reduce((sum, r) => sum + r.hex.length / 2, 0);
      if (!count) return;
      const natural = (count * WIDTH * size) / 1000,
        squeeze = width > 0 ? (width / natural) * 100 : 100;
      page.pushOperators(
        pushGraphicsState(),
        beginText(),
        setTextRenderingMode(TextRenderingMode.Invisible),
        setCharacterSqueeze(squeeze),
        moveText(x, y),
      );
      for (const { font, hex } of runs)
        page.pushOperators(
          setFontAndSize(resourceName(page, font), size),
          showText(PDFHexString.of(hex)),
        );
      page.pushOperators(endText(), popGraphicsState());
    },
    // Writes each font's map from codes to text, once all is drawn.
    finish() {
      for (const font of fonts) {
        const entries = [...font.codes].map(
          ([text, code]) =>
            `<${code.toString(16).padStart(2, "0")}> <${utf16(text)}>`,
        );
        const blocks = [];
        for (let n = 0; n < entries.length; n += 100) {
          const block = entries.slice(n, n + 100);
          blocks.push(
            `${block.length} beginbfchar\n${block.join("\n")}\nendbfchar`,
          );
        }
        pdf.context.assign(
          font.toUnicode,
          pdf.context.flateStream(
            "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
              "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
              "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
              "1 begincodespacerange\n<00> <FF>\nendcodespacerange\n" +
              `${blocks.join("\n")}\n` +
              "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend",
          ),
        );
      }
    },
  };
}
// UTF-16BE in hexadecimal, as a CMap writes text.
const utf16 = (text) =>
  Array.from({ length: text.length }, (_, n) =>
    text.charCodeAt(n).toString(16).padStart(4, "0"),
  )
    .join("")
    .toUpperCase();
