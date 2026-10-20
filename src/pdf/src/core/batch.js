/**
 * Batch processing: one list of steps applied to many PDFs, as a desktop editor's Action
 * Wizard does. Each file goes through the steps in order inside a PdfSession, so every step
 * is a normal edit (validated, swept of replaced objects, metadata kept in step); a file that
 * fails is reported and the others carry on.
 *
 * Steps: { type: 'rotate', degrees } | { type: 'watermark', text, opacity, size, layout, hex }
 *      | { type: 'pageNumbers', format, position } | { type: 'bates', prefix, suffix, start,
 *        digits, position } (numbers continue from one file to the next)
 *      | { type: 'flatten' } | { type: 'sanitize' } | { type: 'ocr' } | { type: 'compress', level }
 *      | { type: 'protect', open, permissions }
 */
import { PdfSession, validatePdf, rotateAllPages } from './document.js';
import { addWatermark, addPageNumbers, addHeaderFooter } from './page-marks.js';
import { flattenDocument } from './flatten.js';
import { sanitizeDocument, SANITIZE_DEFAULTS } from './sanitize.js';
import { compressPdf } from './compress.js';
import { protectPdf } from './security.js';

export const BATCH_STEPS = {
  rotate: 'Rotate all pages',
  watermark: 'Add a watermark',
  pageNumbers: 'Add page numbers',
  bates: 'Add Bates numbers',
  flatten: 'Flatten form fields and comments',
  sanitize: 'Remove hidden information',
  ocr: 'Recognize text (OCR)',
  compress: 'Reduce file size',
  protect: 'Protect with a password',
};

const BATES_SLOTS = {
  'bottom-right': 'bottomRight',
  'bottom-left': 'bottomLeft',
  'bottom-center': 'bottomCenter',
  'top-right': 'topRight',
};

/**
 * Run `steps` over `files` ([{ name, bytes }]). Options: `signal`, `onProgress({ file, step,
 * files, index })`, `codec` (image codec for compression), and `recognize(bytes, pageIndex)`
 * for OCR, which resolves to an OCR result or null (the browser renders and recognizes pages).
 * Resolves to [{ name, bytes } | { name, error }] in the same order.
 */
export async function runBatch(files, steps, { signal, onProgress, codec, recognize } = {}) {
  if (!files.length) throw new Error('Add at least one PDF.');
  if (!steps.length) throw new Error('Choose at least one step.');
  const results = [];
  let batesNext = Number(steps.find((step) => step.type === 'bates')?.start ?? 1);
  for (const [index, file] of files.entries()) {
    signal?.throwIfAborted();
    try {
      await validatePdf(file.bytes).catch((error) => {
        throw error.code === 'encrypted'
          ? new Error('This PDF is password protected; open it to process it.')
          : error;
      });
      const session = new PdfSession(file.bytes);
      let bytes = null;
      // Numbers are taken only by a file that is produced; a file that fails leaves them free.
      let batesUsed = 0;
      for (const step of steps) {
        signal?.throwIfAborted();
        onProgress?.({ file: file.name, step: BATCH_STEPS[step.type], files: files.length, index });
        if (step.type === 'compress') {
          const result = await compressPdf(session.bytes, { level: step.level, codec, signal });
          if (result.bytes.length < session.bytes.length) session.adopt(result.bytes);
          continue;
        }
        if (step.type === 'protect') continue; // applied to the final bytes below
        if (step.type === 'ocr') {
          if (!recognize) throw new Error('Text recognition is not available here.');
          const { addOcrTextLayer, pageNeedsOcr } = await import('./ocr.js');
          const found = [];
          const count = (await validatePdf(session.bytes)).getPageCount();
          for (let page = 0; page < count; page++) {
            signal?.throwIfAborted();
            const result = await recognize(session.bytes, page, { pageNeedsOcr });
            if (result?.words?.length) found.push([page, result]);
          }
          if (found.length)
            await session.change(async (doc) => {
              for (const [page, result] of found) await addOcrTextLayer(doc, page, result);
            });
          continue;
        }
        await session.change(async (doc) => {
          const pages = doc.getPageIndices();
          switch (step.type) {
            case 'rotate':
              rotateAllPages(doc, Number(step.degrees) || 90);
              break;
            case 'watermark':
              await addWatermark(doc, pages, step);
              break;
            case 'pageNumbers':
              await addPageNumbers(doc, pages, step);
              break;
            case 'bates': {
              const slot = BATES_SLOTS[step.position] || 'bottomRight';
              await addHeaderFooter(doc, pages, {
                slots: { [slot]: '{bates}' },
                size: step.size || 10,
                bates: { ...step, start: batesNext + batesUsed },
              });
              batesUsed += pages.length;
              break;
            }
            case 'flatten':
              flattenDocument(doc);
              break;
            case 'sanitize':
              await sanitizeDocument(doc, { ...SANITIZE_DEFAULTS, ...(step.options || {}) });
              break;
            default:
              throw new Error(`Unknown step: ${step.type}`);
          }
        });
      }
      bytes = session.bytes;
      const protect = steps.find((step) => step.type === 'protect');
      if (protect)
        bytes = await protectPdf(bytes, {
          open: protect.open || '',
          permissions: protect.permissions || '',
          allow: protect.allow || {},
        });
      results.push({ name: file.name, bytes });
      batesNext += batesUsed;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      results.push({
        name: file.name,
        error: error?.message || 'This file could not be processed.',
      });
    }
  }
  return results;
}
