import * as pdfjs from 'pdfjs-dist';
import { el } from './lib/ui.js';
import { waitFor } from './lib/abort.js';
import { crc32 } from './lib/crc32.js';

/**
 * The picture with the resolution it was made at written into it (PNG pHYs, JPEG JFIF density),
 * so it prints and places at the page's size. Browsers' encoders record none.
 */
async function withResolution(blob, dpi) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const density = Math.max(1, Math.round(dpi));
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    // A pHYs chunk right after IHDR (8-byte signature, then 25 bytes of IHDR).
    const chunk = new Uint8Array(21);
    const out = new DataView(chunk.buffer);
    out.setUint32(0, 9);
    chunk.set([0x70, 0x48, 0x59, 0x73], 4);
    const perMetre = Math.round(density / 0.0254);
    out.setUint32(8, perMetre);
    out.setUint32(12, perMetre);
    chunk[16] = 1;
    out.setUint32(17, crc32(chunk.subarray(4, 17)));
    return new Blob([bytes.subarray(0, 33), chunk, bytes.subarray(33)], { type: blob.type });
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const jfif =
      bytes[2] === 0xff && bytes[3] === 0xe0 && String.fromCharCode(...bytes.subarray(6, 11));
    if (jfif === 'JFIF\0') {
      bytes[13] = 1;
      view.setUint16(14, density);
      view.setUint16(16, density);
      return new Blob([bytes], { type: blob.type });
    }
    const app0 = new Uint8Array([
      0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0,
    ]);
    const fields = new DataView(app0.buffer);
    fields.setUint16(12, density);
    fields.setUint16(14, density);
    return new Blob([bytes.subarray(0, 2), app0, bytes.subarray(2)], { type: blob.type });
  }
  return blob;
}

/**
 * Render one page to a PNG or JPEG at `dpi`, with its annotations, for saving as a picture.
 * Rejects with an AbortError when `signal` aborts before the picture is ready.
 */
export async function pageImage(
  pdf,
  index,
  { dpi = 144, type = 'image/png', quality = 0.9, signal } = {},
) {
  signal?.throwIfAborted();
  const page = await waitFor(() => pdf.getPage(index + 1), signal);
  signal?.throwIfAborted();
  const natural = page.getViewport({ scale: 1 });
  const scale = Math.min(
    dpi / 72,
    8192 / natural.width,
    8192 / natural.height,
    Math.sqrt(16000000 / (natural.width * natural.height)),
  );
  const viewport = page.getViewport({ scale });
  const canvas = el('canvas', {
    width: Math.max(1, Math.ceil(viewport.width)),
    height: Math.max(1, Math.ceil(viewport.height)),
  });
  try {
    const task = page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      annotationMode: pdfjs.AnnotationMode.ENABLE,
    });
    const abort = () => task.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await task.promise;
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    signal?.throwIfAborted();
    const context = canvas.getContext('2d');
    // JPEG has no transparency: paint the page on white first, as paper would be.
    if (type === 'image/jpeg') {
      context.save();
      context.globalCompositeOperation = 'destination-over';
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.restore();
    }
    const blob = await waitFor(
      () => new Promise((resolve) => canvas.toBlob(resolve, type, quality)),
      signal,
    );
    signal?.throwIfAborted();
    if (!blob) throw new Error('This page could not be turned into a picture.');
    const picture = await waitFor(() => withResolution(blob, scale * 72), signal);
    signal?.throwIfAborted();
    return picture;
  } finally {
    canvas.width = canvas.height = 0;
  }
}

/**
 * Render the given pages of a PDF.js document to full-sheet images and hand them to the
 * browser's print command, one page per sheet. Resolves once the print dialog has closed;
 * rejects with an AbortError when `signal` aborts during preparation.
 */
export async function printPages(pdf, indices, { onProgress, signal, maxDpi = Infinity } = {}) {
  // Sharp text at a typical printer resolution for ordinary documents; very long documents
  // trade some resolution for memory and time.
  const dpi = Math.min(maxDpi, indices.length <= 50 ? 200 : indices.length <= 200 ? 150 : 96);
  const sheets = el('div', { class: 'print-sheets', 'aria-hidden': 'true' });
  const urls = [];
  const cleanup = () => {
    sheets.remove();
    document.body.classList.remove('printing');
    urls.forEach((url) => URL.revokeObjectURL(url));
  };
  try {
    for (const [i, index] of indices.entries()) {
      signal?.throwIfAborted();
      onProgress?.(i, indices.length);
      const page = await waitFor(() => pdf.getPage(index + 1), signal);
      signal?.throwIfAborted();
      const natural = page.getViewport({ scale: 1 });
      const scale = Math.min(
        dpi / 72,
        8192 / natural.width,
        8192 / natural.height,
        Math.sqrt(16000000 / (natural.width * natural.height)),
      );
      const viewport = page.getViewport({ scale });
      const canvas = el('canvas', {
        width: Math.max(1, Math.ceil(viewport.width)),
        height: Math.max(1, Math.ceil(viewport.height)),
      });
      let blob;
      try {
        const task = page.render({
          canvasContext: canvas.getContext('2d'),
          viewport,
          intent: 'print',
          annotationMode: pdfjs.AnnotationMode.ENABLE,
        });
        const abort = () => task.cancel();
        signal?.addEventListener('abort', abort, { once: true });
        try {
          await task.promise;
        } catch (error) {
          if (signal?.aborted) signal.throwIfAborted();
          throw error;
        } finally {
          signal?.removeEventListener('abort', abort);
        }
        signal?.throwIfAborted();
        // A compressed image per page keeps a long document within memory; the canvas goes.
        blob = await waitFor(
          () => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92)),
          signal,
        );
        signal?.throwIfAborted();
        if (!blob) throw new Error('This page could not be prepared for printing.');
      } finally {
        canvas.width = canvas.height = 0;
      }
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const image = el('img', { src: url, alt: `Page ${index + 1}` });
      sheets.append(
        el(
          'div',
          { class: `print-sheet${viewport.width > viewport.height ? ' landscape' : ''}` },
          image,
        ),
      );
      try {
        await waitFor(() => image.decode(), signal);
      } catch {
        signal?.throwIfAborted();
        throw new Error(`Page ${index + 1} could not be prepared for printing. Please try again.`);
      }
    }
    signal?.throwIfAborted();
    onProgress?.(indices.length, indices.length);
    document.body.append(sheets);
    document.body.classList.add('printing');
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.removeEventListener('afterprint', finish);
        resolve();
      };
      window.addEventListener('afterprint', finish);
      window.print();
      // Browsers block in print() while their dialog is open and announce afterprint when
      // it closes; a short wait covers one that does neither.
      setTimeout(finish, 1500);
    });
  } finally {
    cleanup();
  }
}
