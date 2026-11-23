import { PDFName } from 'pdf-lib';
import { contentReport, filterContent } from './content-filter.js';
import { pageSource, setPageSource } from './text-edit.js';
import { savePdf } from './version.js';

/**
 * The pictures PowerPoint export can put behind slides: the pages as they look, less the text
 * that becomes the slides' editable text boxes. With that text in the picture as well, every
 * word showed twice (in the slide's font over the PDF's), and an edited word still showed its
 * old wording underneath.
 *
 * `doc` is a pdf-lib document the caller no longer needs: its `pages` (zero-based) are changed
 * in place and the document is saved once, for one more PDF.js document to draw them all.
 * Text that draws nothing (invisible OCR text) or clips other content stays, so clipped art is
 * unchanged; so does text in comments and fields, which export does not turn into text boxes.
 * A page whose content cannot be read keeps its text. Resolves to the saved bytes.
 */
export async function textFreePages(doc, pages, { signal } = {}) {
  const fontIds = new Map();
  const fontId = (font) => {
    if (!fontIds.has(font)) fontIds.set(font, fontIds.size);
    return fontIds.get(font);
  };
  const policy = {
    // Fill, stroke, and fill-and-stroke text; the clipping modes (4 to 7) stay.
    glyph: (quad, { mode }) => mode <= 2,
    form: () => 'descend',
    formFailed: () => 'keep',
    // A form's result depends on the text state it inherits, never on where it is placed, so
    // a form drawn on every page (a letterhead) is read once.
    memoKey: (form, gs) => [gs.Tr, gs.size, gs.Tc, gs.Tw, gs.Th, fontId(gs.font)].join('|'),
  };
  const memo = new Map();
  for (const index of new Set(pages)) {
    signal?.throwIfAborted();
    const page = doc.getPage(index);
    try {
      const result = await filterContent(doc, {
        source: pageSource(page),
        resources: page.node.Resources(),
        policy,
        report: contentReport(),
        memo,
      });
      if (!result.changed) continue;
      if (result.resources) page.node.set(PDFName.of('Resources'), result.resources);
      setPageSource(doc, page, result.source);
    } catch {
      // Unreadable content is drawn as it is, text and all.
    }
  }
  signal?.throwIfAborted();
  return savePdf(doc, { useObjectStreams: false });
}
