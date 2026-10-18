// PDF pages to images, with optional text extraction, through an injected
// pdf.js loader. In the browser the loader is src/content/pdf-loader.js,
// which loads pdf.js lazily; tests inject the Node build.
export const PDF_BYTES = 50 * 1024 * 1024;
export const MAX_PAGES = 50;
const LONG_SIDE = 1600,
  IMAGE_CHARACTERS = Math.floor((5 * 1024 * 1024 * 4) / 3),
  PARAGRAPH = 20000,
  // Notes beside a page's picture; more would run far below it.
  PAGE_NOTES = 40;

// Lines of a paragraph, joined with spaces. A word broken with a hyphen at
// the end of a line is joined back: without the hyphen before a lowercase
// letter, as in "hyphen-" "ation", and with it otherwise, as in "COVID-"
// "19". Hyphens within a line, as in "pre- and post-war", stay.
// The paragraph always ends with the line before, so only that line is
// checked, and joining stops past the 20,000 characters a note keeps; the
// import shortens the note and says so.
function joinLines(lines) {
  let out = lines[0];
  for (let n = 1; n < lines.length && out.length <= PARAGRAPH; n++) {
    const text = lines[n];
    out = /\p{L}-$/u.test(lines[n - 1])
      ? /^\p{Ll}/u.test(text)
        ? out.slice(0, -1) + text
        : out + text
      : `${out} ${text}`;
  }
  return out;
}
// Groups text items into lines, and lines into paragraphs at larger gaps.
export function pdfParagraphs(items) {
  const lines = [];
  let line = null;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform?.[5] ?? 0,
      h = Math.abs(item.height || item.transform?.[3] || 10);
    if (!line) line = { text: "", y, h };
    line.text += item.str;
    line.h = Math.max(line.h, h);
    if (item.hasEOL) {
      lines.push(line);
      line = null;
    }
  }
  if (line) lines.push(line);
  const paragraphs = [];
  let current = [],
    previous = null;
  for (const l of lines) {
    const text = l.text.replace(/\s+/g, " ").trim();
    const gap = previous ? Math.abs(previous.y - l.y) : 0;
    if (!text || (previous && gap > Math.max(previous.h, l.h) * 1.8)) {
      if (current.length) paragraphs.push(joinLines(current));
      current = [];
    }
    if (text) current.push(text);
    previous = text ? l : previous;
  }
  if (current.length) paragraphs.push(joinLines(current));
  return paragraphs;
}

export async function extractPdf(bytes, options) {
  const {
    loadPdfjs,
    createCanvas = (w, h) =>
      Object.assign(document.createElement("canvas"), { width: w, height: h }),
    encode = (canvas, quality) => canvas.toDataURL("image/jpeg", quality),
    maxPages = MAX_PAGES,
    text = false,
    signal,
    progress = () => {},
  } = options;
  if (bytes.length > PDF_BYTES) throw Error("Choose a PDF smaller than 50 MB.");
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    // No scripting, no remote font or character map fetches, no eval.
    isEvalSupported: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
    verbosity: 0,
  });
  const abort = () => task.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  let doc;
  try {
    try {
      doc = await task.promise;
    } catch (error) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      if (error?.name === "PasswordException")
        throw Error("Password-protected PDFs are not supported.");
      throw Error("This PDF is damaged or is not supported.");
    }
    const count = Math.min(doc.numPages, Math.max(1, maxPages));
    const pages = [];
    for (let n = 1; n <= count; n++) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      progress(n, count);
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(
        3,
        LONG_SIDE / Math.max(base.width, base.height, 1),
      );
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.round(viewport.width)),
        height = Math.max(1, Math.round(viewport.height));
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      // Pages are rendered on white: JPEG has no transparency.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      await page.render({ canvasContext: context, canvas, viewport }).promise;
      let src = encode(canvas, 0.85);
      if (src.length > IMAGE_CHARACTERS) src = encode(canvas, 0.6);
      const found = text
        ? pdfParagraphs((await page.getTextContent()).items)
        : [];
      const texts = found.slice(0, PAGE_NOTES),
        omittedTexts = found.length - texts.length;
      page.cleanup?.();
      canvas.width = canvas.height = 0;
      if (src.length > IMAGE_CHARACTERS || !src.startsWith("data:image/jpeg"))
        pages.push({ index: n, skipped: true, texts, omittedTexts });
      else pages.push({ index: n, src, width, height, texts, omittedTexts });
    }
    return { kind: "pdf", pageCount: doc.numPages, pages };
  } catch (error) {
    // Cancelling destroys the document, which fails the page in progress.
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    doc?.destroy?.();
  }
}
