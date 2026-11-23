/**
 * Export a PDF to Word, Excel, PowerPoint, plain text, HTML or RTF ("Export a PDF").
 *
 *   exportDocument(pdf, bytes, format, options) -> Promise<{ bytes, blob, mime, extension }>
 *
 *   pdf      PDF.js PDFDocumentProxy of the document (text, drawing operations and decoded
 *            pictures come from it)
 *   bytes    Uint8Array of the same PDF (used to hand over JPEG pictures unchanged); optional
 *   format   'docx' | 'xlsx' | 'pptx' | 'txt' | 'html' | 'rtf'
 *   options  {
 *     pages        zero-based page indices to export (default: every page)
 *     onProgress   (done, total) => void, called as pages are read and when the file is written
 *     signal       AbortSignal; aborting rejects with the signal's reason
 *     renderPage   async (index, scale, { text, areas, rotation }) => Uint8Array (PNG): the
 *                  page turned to `rotation` when given (as the export reads it). Optional and
 *                  browser-only: pages drawn only with vector art (no text, no pictures) are
 *                  exported as a picture of the page, and charts and diagrams on text pages as
 *                  pictures of their areas: given `areas` ([{ x, y, w, h }] in points from the
 *                  top left of the page as shown), it resolves to one PNG per area.
 *                  PowerPoint slides can use the page picture as their
 *                  background, drawn with `text: false`: without the page text, which the slide
 *                  shows in its own editable text boxes.
 *     slideBackgrounds  PPTX: put each rendered page behind the slide's text (needs renderPage)
 *     singleSheet  XLSX: one worksheet for the whole document instead of one per page
 *     title, author     document properties (title defaults to the PDF's own title)
 *     layers       PDF.js optional content config (or a promise of one): content on layers it
 *                  hides is left out; defaults to the document's own default visibility
 *   }
 *
 *   analyzeDocument(pdf, bytes, options) -> Promise<DocModel>   the layout model the writers use
 *
 * Everything runs in a browser or in Node (no canvas needed): layout analysis is in
 * export-layout.js, pictures in export-images.js, and one writer module per format.
 */
import { readPage, buildDocument, figureRegions } from './export-layout.js';
import { createImageSource, pictureBytes } from './export-images.js';
import { writeDocx } from './export-docx.js';
import { writeXlsx } from './export-xlsx.js';
import { writePptx } from './export-pptx.js';
import { writeText, writeHtml, writeRtf } from './export-text.js';

export const EXPORT_FORMATS = {
  docx: {
    label: 'Microsoft Word document',
    extension: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  xlsx: {
    label: 'Microsoft Excel workbook',
    extension: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  pptx: {
    label: 'Microsoft PowerPoint presentation',
    extension: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  rtf: { label: 'Rich Text Format', extension: 'rtf', mime: 'application/rtf' },
  txt: {
    label: 'Plain text',
    extension: 'txt',
    mime: 'text/plain;charset=utf-8',
  },
  html: {
    label: 'Web page',
    extension: 'html',
    mime: 'text/html;charset=utf-8',
  },
};

/** Read and analyse the chosen pages into the layout model every writer consumes. */
export async function analyzeDocument(
  pdf,
  bytes,
  { pages, onProgress, signal, renderPage, total, layers, figures = true } = {},
) {
  signal?.throwIfAborted();
  const indices = (
    pages?.length ? pages : Array.from({ length: pdf.numPages }, (_, i) => i)
  ).filter((i) => Number.isInteger(i) && i >= 0 && i < pdf.numPages);
  if (!indices.length) throw new Error('Choose at least one page to export.');
  const source = await createImageSource(pdf, bytes);
  // Read the layer visibility once for every page.
  const shown = layers ?? pdf.getOptionalContentConfig?.({ intent: 'display' });
  shown?.catch?.(() => {});
  const images = {
    resolve: (page, id, orientation) => source.resolve(page, id, orientation),
    inline: async (data, orientation) => {
      const png = await pictureBytes(data, orientation);
      if (!png) return null;
      const sideways = orientation?.across[0] === 0;
      return {
        key: `inline:${inlineCount++}`,
        mime: 'image/png',
        extension: 'png',
        bytes: png,
        width: sideways ? data.height : data.width,
        height: sideways ? data.width : data.height,
      };
    },
  };
  let inlineCount = 0;
  const scans = [],
    drawing = [];
  const count = total ?? indices.length + 1;
  for (const [n, index] of indices.entries()) {
    signal?.throwIfAborted();
    const page = await pdf.getPage(index + 1);
    signal?.throwIfAborted();
    const scan = await readPage(pdf, page, { images, signal, layers: shown });
    scan.index = index;
    // Its pictures are in the scan now. PDF.js keeps a page's decoded pictures until told
    // otherwise, so exporting a long scan held every page's, gigabytes, until the tab ran out.
    page.cleanup();
    // Pages drawn only with vector art keep their look as a picture, when one can be rendered.
    if (
      renderPage &&
      !scan.spans.length &&
      !scan.images.length &&
      (scan.vectors.length || scan.fills.length || scan.rules.length)
    ) {
      try {
        const png = await renderPage(index, 2, { rotation: scan.rotation });
        signal?.throwIfAborted();
        if (png?.length)
          scan.images.push({
            x: 0,
            y: 0,
            w: scan.width,
            h: scan.height,
            picture: {
              key: `page:${index}`,
              mime: 'image/png',
              extension: 'png',
              bytes: png,
              width: Math.round(scan.width * 2),
              height: Math.round(scan.height * 2),
            },
          });
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    // Charts and diagrams drawn among the text keep their look as pictures of their areas,
    // with their labels; the writers have no vector drawing of their own. A few pages draw
    // while the next ones are read: each drawing waits for a frame, mostly idle.
    if (renderPage && figures && scan.spans.length) {
      const areas = figureRegions(scan);
      if (areas.length) {
        const job = Promise.resolve()
          .then(() =>
            renderPage(index, 2, {
              areas: areas.map(({ x, y, w, h }) => ({ x, y, w, h })),
              rotation: scan.rotation,
            }),
          )
          .then(
            (pngs) => () => placeFigures(scan, areas, pngs),
            (error) => {
              if (signal?.aborted) throw error;
              return () => {};
            },
          );
        job.catch(() => {});
        drawing.push(job);
        if (drawing.length > 3) (await drawing.shift())();
      }
    }
    scans.push(scan);
    onProgress?.(n + 1, count);
  }
  while (drawing.length) (await drawing.shift())();
  signal?.throwIfAborted();
  return buildDocument(scans);
}

/** Put the pictures of a page's drawn areas in place of what they show. */
function placeFigures(scan, areas, pngs) {
  areas.forEach((area, k) => {
    const png = pngs?.[k];
    if (!png?.length) return;
    const taken = new Set(area.spans);
    const within = (b) =>
      b.x >= area.x - 1 &&
      b.y >= area.y - 1 &&
      b.x + b.w <= area.x + area.w + 1 &&
      b.y + b.h <= area.y + area.h + 1;
    scan.spans = scan.spans.filter((s) => !taken.has(s));
    scan.vectors = scan.vectors.filter((v) => !within(v));
    scan.fills = scan.fills.filter((f) => !within(f));
    scan.rules = scan.rules.filter((r) =>
      r.horizontal
        ? !within({ x: r.x0, y: r.y, w: r.x1 - r.x0, h: 0 })
        : !within({ x: r.x, y: r.y0, w: 0, h: r.y1 - r.y0 }),
    );
    scan.images.push({
      x: area.x,
      y: area.y,
      w: area.w,
      h: area.h,
      picture: {
        key: `figure:${scan.index}:${k}`,
        mime: 'image/png',
        extension: 'png',
        bytes: png,
        width: Math.round(area.w * 2),
        height: Math.round(area.h * 2),
      },
    });
  });
}

async function documentTitle(pdf) {
  try {
    const { info } = await pdf.getMetadata();
    return typeof info?.Title === 'string' ? info.Title.trim() : '';
  } catch {
    return '';
  }
}
/** The PDF's own language (its /Lang), when it is a usable language tag. */
async function documentLanguage(pdf) {
  try {
    const { info } = await pdf.getMetadata();
    const lang = typeof info?.Language === 'string' ? info.Language.trim() : '';
    return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(lang) ? lang : '';
  } catch {
    return '';
  }
}

/** Export the PDF to `format`; see the module comment for options. */
export async function exportDocument(pdf, bytes, format, options = {}) {
  const spec = EXPORT_FORMATS[format];
  if (!spec) throw new Error(`Unsupported export format: ${format}`);
  const { signal, onProgress, renderPage } = options;
  const pageCount = options.pages?.length || pdf.numPages;
  const backgrounds = format === 'pptx' && options.slideBackgrounds && renderPage;
  const total = pageCount + 1 + (backgrounds ? pageCount : 0);
  // Plain text and spreadsheets have no pictures; slides drawn over their page pictures
  // already show the drawings.
  const figures = format !== 'txt' && format !== 'xlsx' && !backgrounds;
  const model = await analyzeDocument(pdf, bytes, { ...options, total, figures });
  const title = options.title ?? (await documentTitle(pdf));
  let done = pageCount;
  let output;
  // Screen readers pronounce the exported text in the PDF's own language.
  const lang = (await documentLanguage(pdf)) || undefined;
  const common = { title, author: options.author, signal, lang };
  if (format === 'docx') output = await writeDocx(model, common);
  else if (format === 'xlsx')
    output = await writeXlsx(model, {
      ...common,
      singleSheet: options.singleSheet,
    });
  else if (format === 'pptx') {
    let rendered = null;
    if (backgrounds) {
      rendered = new Map();
      for (const page of model.pages) {
        signal?.throwIfAborted();
        try {
          const png = await renderPage(page.index, 2, { text: false, rotation: page.rotation });
          if (png?.length) rendered.set(page.index, png);
        } catch (error) {
          if (signal?.aborted) throw error;
        }
        onProgress?.(++done, total);
      }
    }
    output = await writePptx(model, { ...common, backgrounds: rendered });
  } else if (format === 'txt') output = new TextEncoder().encode(writeText(model));
  else if (format === 'html') output = new TextEncoder().encode(writeHtml(model, { title, lang }));
  else output = new TextEncoder().encode(writeRtf(model));
  signal?.throwIfAborted();
  onProgress?.(total, total);
  return {
    bytes: output,
    blob: typeof Blob === 'function' ? new Blob([output], { type: spec.mime }) : undefined,
    mime: spec.mime,
    extension: spec.extension,
  };
}
