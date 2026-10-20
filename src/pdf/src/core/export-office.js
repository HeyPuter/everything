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
 *     renderPage   async (index, scale) => Uint8Array (PNG). Optional and browser-only: pages
 *                  drawn only with vector art (no text, no pictures) are exported as a picture
 *                  of the page, and PowerPoint slides can use it as their background.
 *     slideBackgrounds  PPTX: put each rendered page behind the slide's text (needs renderPage)
 *     singleSheet  XLSX: one worksheet for the whole document instead of one per page
 *     title, author     document properties (title defaults to the PDF's own title)
 *   }
 *
 *   analyzeDocument(pdf, bytes, options) -> Promise<DocModel>   the layout model the writers use
 *
 * Everything runs in a browser or in Node (no canvas needed): layout analysis is in
 * export-layout.js, pictures in export-images.js, and one writer module per format.
 */
import { readPage, buildDocument } from './export-layout.js';
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
  { pages, onProgress, signal, renderPage, total } = {},
) {
  signal?.throwIfAborted();
  const indices = (
    pages?.length ? pages : Array.from({ length: pdf.numPages }, (_, i) => i)
  ).filter((i) => Number.isInteger(i) && i >= 0 && i < pdf.numPages);
  if (!indices.length) throw new Error('Choose at least one page to export.');
  const source = await createImageSource(pdf, bytes);
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
  const scans = [];
  const count = total ?? indices.length + 1;
  for (const [n, index] of indices.entries()) {
    signal?.throwIfAborted();
    const page = await pdf.getPage(index + 1);
    signal?.throwIfAborted();
    const scan = await readPage(pdf, page, { images, signal });
    scan.index = index;
    // Pages drawn only with vector art keep their look as a picture, when one can be rendered.
    if (
      renderPage &&
      !scan.spans.length &&
      !scan.images.length &&
      (scan.vectors.length || scan.fills.length || scan.rules.length)
    ) {
      try {
        const png = await renderPage(index, 2);
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
    scans.push(scan);
    onProgress?.(n + 1, count);
  }
  signal?.throwIfAborted();
  return buildDocument(scans);
}

async function documentTitle(pdf) {
  try {
    const { info } = await pdf.getMetadata();
    return typeof info?.Title === 'string' ? info.Title.trim() : '';
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
  const model = await analyzeDocument(pdf, bytes, { ...options, total });
  const title = options.title ?? (await documentTitle(pdf));
  let done = pageCount;
  let output;
  const common = { title, author: options.author, signal };
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
          const png = await renderPage(page.index, 2);
          if (png?.length) rendered.set(page.index, png);
        } catch (error) {
          if (signal?.aborted) throw error;
        }
        onProgress?.(++done, total);
      }
    }
    output = await writePptx(model, { ...common, backgrounds: rendered });
  } else if (format === 'txt') output = new TextEncoder().encode(writeText(model));
  else if (format === 'html') output = new TextEncoder().encode(writeHtml(model, { title }));
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
