/**
 * On-device text recognition with tesseract.js. Everything it loads (the worker script, the
 * WebAssembly core and the English model) is served by this app from `ocr/` next to the page
 * (see `vite.config.js`), so page images never leave the device and no CDN is contacted.
 *
 * One worker is reused across pages and created on first use; aborting a recognition
 * terminates it, and the next call starts a fresh one.
 */

/** tesseract.js's LSTM-only engine mode, which needs only the smaller `*-lstm` cores. */
const LSTM_ONLY = 1;
/** Share of the reported progress spent starting the worker and loading the model. */
const STARTUP = 0.3;

const abortError = () => new DOMException('Text recognition was canceled.', 'AbortError');
/**
 * A recognizer that could not start: its worker, core or English model did not load (offline,
 * say). tesseract.js says so in a bare string, or not at all ("failed: undefined").
 */
const startFailure = (cause) =>
  new Error('Text recognition could not start. Check the connection and try again.', { cause });
/** tesseract.js rejects with bare strings; give callers an Error. */
const failure = (error) =>
  error instanceof Error || error instanceof DOMException
    ? error
    : new Error(`Text recognition failed: ${error}`);

/** The app's OCR asset folder in a browser: `ocr/` beside the app's base URL. */
function defaultBase() {
  const appBase = import.meta.env?.BASE_URL ?? './';
  return new URL(`${appBase}ocr/`, document.baseURI).href;
}

/**
 * The image as bytes tesseract.js can decode. Pixels become a binary PGM (8-bit gray), which
 * its image reader takes directly and is far cheaper to produce than a PNG. Encoded image
 * bytes and Blobs pass through after their size is read.
 */
async function imageInput(source) {
  if (source instanceof Uint8Array) return { bytes: source, ...encodedSize(source) };
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const bitmap = await createImageBitmap(source);
    try {
      return imageInput(bitmap);
    } finally {
      bitmap.close();
    }
  }
  let pixels = source;
  if (!(source?.data && source.width > 0 && source.height > 0)) {
    const { width, height } = source || {};
    if (!(width > 0 && height > 0)) throw new Error('Choose an image to recognize.');
    // Canvas elements, OffscreenCanvas and ImageBitmaps all draw onto a 2D canvas.
    let context = source.getContext?.('2d', { willReadFrequently: true });
    if (!context) {
      const canvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(width, height)
          : Object.assign(document.createElement('canvas'), { width, height });
      context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(source, 0, 0);
    }
    pixels = context.getImageData(0, 0, width, height);
  }
  const { data, width, height } = pixels;
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  const bytes = new Uint8Array(header.length + width * height);
  bytes.set(header);
  for (let i = 0, j = header.length; i < data.length; i += 4, j++) {
    // Transparent pixels (an unpainted canvas) read as white paper, not black.
    const alpha = data[i + 3];
    const gray = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    bytes[j] = alpha === 255 ? gray : (255 - ((255 - gray) * alpha) / 255) | 0;
  }
  return { bytes, width, height };
}

/** Width and height from a PNG, JPEG or PGM header; zero when the format is not one of these. */
function encodedSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes.length >= 24)
    return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) break;
      const marker = bytes[at + 1];
      const length = view.getUint16(at + 2);
      // Start-of-frame markers, excluding DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return {
          width: view.getUint16(at + 7),
          height: view.getUint16(at + 5),
        };
      at += 2 + length;
    }
  }
  const pgm = new TextDecoder().decode(bytes.subarray(0, 64)).match(/^P5\s+(\d+)\s+(\d+)/);
  if (pgm) return { width: Number(pgm[1]), height: Number(pgm[2]) };
  return { width: 0, height: 0 };
}

const box = ({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 });

/** tesseract.js's block tree flattened into lines and words in reading order. */
function readResult(data, width, height) {
  const words = [],
    lines = [];
  for (const block of data.blocks || [])
    for (const paragraph of block.paragraphs || [])
      for (const line of paragraph.lines || []) {
        const baseline = line.baseline?.has_baseline === false ? null : line.baseline;
        const entry = {
          text: line.text.trim(),
          bbox: box(line.bbox),
          baseline: baseline ? box(baseline) : null,
          confidence: line.confidence,
          words: [],
        };
        for (const word of line.words || []) {
          if (!word.text.trim()) continue;
          const item = {
            text: word.text.trim(),
            bbox: box(word.bbox),
            confidence: word.confidence,
            baseline: entry.baseline,
            // Tesseract's row height approximates the line's font size in pixels.
            fontSize: line.rowAttributes?.rowHeight || undefined,
          };
          entry.words.push(item);
          words.push(item);
        }
        if (entry.words.length) lines.push(entry);
      }
  return {
    words,
    lines,
    text: data.text || '',
    width,
    height,
    confidence: data.confidence,
  };
}

/**
 * Create a recognizer. `base` is the URL of the OCR asset folder (the app's `ocr/` by default);
 * `workerPath`, `corePath` and `langPath` override single locations. Under Node, tesseract.js
 * uses its own worker thread and core from node_modules, so only `langPath` (a directory holding
 * `eng.traineddata.gz`) is needed there.
 */
export function createOcrEngine({ base, workerPath, corePath, langPath } = {}) {
  const browser = typeof document !== 'undefined';
  const root = base ?? (browser ? defaultBase() : '');
  const folder = (path) => (root ? new URL(path, root.endsWith('/') ? root : `${root}/`).href : '');
  const paths = browser
    ? {
        workerPath: workerPath ?? folder('worker.min.js'),
        corePath: corePath ?? folder('core/'),
        langPath: langPath ?? folder('lang/'),
      }
    : { langPath: langPath ?? folder('lang/') };
  let worker = null,
    workerLang = null,
    listener = null,
    queue = Promise.resolve();

  const logger = (message) => listener?.(message);
  async function start(lang) {
    if (worker && workerLang === lang) return worker;
    await stop();
    const { createWorker } = await import('tesseract.js');
    // tesseract.js settles a new worker only when its core fails to load: a model that does not
    // load (offline) left it pending, and the recognition waiting, for good. The job's failure
    // still reaches the error handler, which ends the wait.
    let failedStart;
    const startFailed = new Promise((_, reject) => (failedStart = reject));
    startFailed.catch(() => {});
    const pending = createWorker(lang, LSTM_ONLY, {
      ...paths,
      // Load the worker by URL rather than from a blob: URL, and keep the model out of
      // IndexedDB: the HTTP cache already holds it and nothing else is stored on the device.
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
      logger,
      errorHandler: (error) => failedStart?.(error),
    });
    worker = pending;
    workerLang = lang;
    let ready;
    try {
      ready = await Promise.race([pending, startFailed]);
    } catch (error) {
      if (worker === pending) worker = workerLang = null;
      throw startFailure(error);
    } finally {
      failedStart = null;
    }
    // Aborted while starting: `stop` already let go of this worker.
    if (worker !== pending) {
      await ready.terminate();
      throw abortError();
    }
    return (worker = ready);
  }
  async function stop() {
    const current = worker;
    worker = workerLang = null;
    if (current)
      await Promise.resolve(current).then(
        (w) => w.terminate(),
        () => {},
      );
  }

  async function run(image, { lang = 'eng', onProgress, signal } = {}) {
    if (signal?.aborted) throw abortError();
    let reported = 0;
    const report = (value) => {
      if (value > reported) onProgress?.((reported = Math.min(1, value)));
    };
    report(0);
    let rejectAbort;
    const aborted = new Promise((_, reject) => (rejectAbort = reject));
    const onAbort = () => {
      // tesseract.js cannot cancel a job; ending the worker is the only way to stop it.
      stop();
      rejectAbort(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const input = await Promise.race([imageInput(image), aborted]);
      const warm = !!worker && workerLang === lang;
      listener = ({ status, progress }) => {
        const p = Number(progress) || 0;
        if (status === 'recognizing text') report(warm ? p : STARTUP + (1 - STARTUP) * p);
        else if (!warm && status === 'loading language traineddata')
          report(STARTUP * (0.2 + 0.8 * p));
        else if (!warm) report(STARTUP * 0.2 * p);
      };
      const tesseract = await Promise.race([start(lang), aborted]);
      const { data } = await Promise.race([
        tesseract.recognize(input.bytes, {}, { text: true, blocks: true }).catch((error) => {
          throw failure(error);
        }),
        aborted,
      ]);
      report(1);
      return readResult(data, input.width, input.height);
    } finally {
      listener = null;
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    /**
     * Recognize text in `image` (a canvas, OffscreenCanvas, ImageBitmap, ImageData, Blob, or
     * encoded image bytes). Resolves to `{ words, lines, text, width, height, confidence }` with
     * boxes in image pixels; `onProgress` receives 0..1. Calls run one at a time.
     */
    recognize(image, options) {
      const job = queue.then(() => run(image, options));
      queue = job.catch(() => {});
      return job;
    },
    /** Stop the worker and free its memory; a later `recognize` starts a new one. */
    terminate() {
      return stop();
    },
  };
}
