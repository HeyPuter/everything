/**
 * Save as PDF: each page is embedded as the editor paints it for printing (twice screen
 * resolution), with an invisible text layer on top so the PDF can be searched, selected and
 * copied, as an exported word-processor PDF can. The writer is original and dependency-free:
 * pages carry a JPEG image and a Type0/Identity-H text font that is never drawn (render mode 3)
 * and whose ToUnicode map returns the original characters.
 */

const encoder = new TextEncoder();
const PT_PER_PX = 0.75;

/** UTF-16BE hex for a PDF hex string. */
export function utf16Hex(text) {
  let hex = '';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0');
  return hex.toUpperCase();
}

/** Text-layer operators for one page: lines of [{ text, x, baseline, width, fontSize }] in page pixels. */
export function textLayer(fragments, pageHeightPx) {
  const ops = ['BT', '3 Tr'];
  for (const f of fragments) {
    const text = f.text.replace(/[\u0000-\u001f￼­]/g, ' ');
    if (!text.trim()) continue;
    const size = Math.max(1, f.fontSize || 12), width = Math.max(1, f.width * PT_PER_PX);
    // Each code advances half an em in the text font; horizontal scaling fits the run's painted width.
    const scale = Math.max(1, Math.min(10000, width / (text.length * size * 0.5) * 100));
    ops.push(`/F1 ${size.toFixed(2)} Tf ${scale.toFixed(2)} Tz 1 0 0 1 ${(f.x * PT_PER_PX).toFixed(2)} ${((pageHeightPx - f.baseline) * PT_PER_PX).toFixed(2)} Tm <${utf16Hex(text)}> Tj`);
  }
  ops.push('ET');
  return ops.join('\n');
}

const TO_UNICODE = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfrange
<0000> <FFFF> <0000>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

/**
 * Build a PDF from pages: [{ widthPx, heightPx, jpeg: Uint8Array, imageWidth, imageHeight, fragments }].
 * Returns a Uint8Array.
 */
export function buildPdf(pages, { title = 'Document', author = '' } = {}) {
  const chunks = [], offsets = [];
  let length = 0;
  const push = data => { const bytes = typeof data === 'string' ? encoder.encode(data) : data; chunks.push(bytes); length += bytes.length; };
  const objects = []; // index -> producer
  const reserve = () => { objects.push(null); return objects.length; };
  const define = (id, body) => { objects[id - 1] = body; };
  const pdfString = s => `(${String(s).replace(/[\\()]/g, m => '\\' + m).replace(/[^\x20-\x7e]/g, '?')})`;

  const catalog = reserve(), pagesId = reserve(), font = reserve(), cidFont = reserve(), descriptor = reserve(), toUnicode = reserve(), info = reserve();
  define(info, `<< /Title ${pdfString(title)} /Author ${pdfString(author)} /Producer (Documents) /Creator (Documents) >>`);
  define(toUnicode, { stream: encoder.encode(TO_UNICODE) });
  define(descriptor, '<< /Type /FontDescriptor /FontName /DocumentsTextLayer /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>');
  define(cidFont, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DocumentsTextLayer /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 500 /CIDToGIDMap /Identity >>`);
  define(font, `<< /Type /Font /Subtype /Type0 /BaseFont /DocumentsTextLayer /Encoding /Identity-H /DescendantFonts [${cidFont} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
  const kids = [];
  for (const page of pages) {
    const pageId = reserve(), image = reserve(), content = reserve();
    kids.push(pageId);
    const w = page.widthPx * PT_PER_PX, h = page.heightPx * PT_PER_PX;
    define(image, { dict: `/Type /XObject /Subtype /Image /Width ${page.imageWidth} /Height ${page.imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, stream: page.jpeg });
    define(content, { stream: encoder.encode(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} 0 0 cm /Im1 Do Q\n${textLayer(page.fragments, page.heightPx)}`) });
    define(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${w.toFixed(2)} ${h.toFixed(2)}] /Resources << /XObject << /Im1 ${image} 0 R >> /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  }
  define(pagesId, `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  define(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  push(new Uint8Array([...encoder.encode('%PDF-1.7\n%'), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  for (let i = 0; i < objects.length; i++) {
    offsets[i] = length;
    const body = objects[i];
    if (typeof body === 'string') push(`${i + 1} 0 obj\n${body}\nendobj\n`);
    else {
      push(`${i + 1} 0 obj\n<< ${body.dict ? body.dict + ' ' : ''}/Length ${body.stream.length} >>\nstream\n`);
      push(body.stream);
      push('\nendstream\nendobj\n');
    }
  }
  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length); let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** The visible text runs of a laid-out page, for the text layer. */
export function pageFragments(lines, page) {
  const out = [];
  for (const line of lines) {
    if (line.page !== page || line.virtual || line.cellText) continue;
    for (const f of line.fragments || []) if (f.text && !f.image) out.push({ text: f.text, x: f.x, baseline: line.baseline, width: f.width, fontSize: f.fontSize });
  }
  return out;
}

const jpegOf = canvas => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? blob.arrayBuffer().then(b => resolve(new Uint8Array(b)), reject) : reject(new Error('The page could not be encoded.')), 'image/jpeg', 0.92));

/** Export the editor's document as a PDF Blob. */
export async function exportPdf(engine, { title } = {}) {
  await engine.fontRefresh;
  const sheets = engine.printSheets();
  // The authored pages printed, even when a screen view (web, draft, read) is showing.
  const { layout, storyLayout } = engine.printedLayout || engine;
  const lines = [...layout.lines, ...(layout.repeatedLines || []), ...(storyLayout?.lines || [])];
  const pages = [];
  for (const [index, canvas] of sheets.entries()) {
    const geometry = layout.pages[index] || layout.page;
    pages.push({ widthPx: geometry.width, heightPx: geometry.height, jpeg: await jpegOf(canvas), imageWidth: canvas.width, imageHeight: canvas.height, fragments: pageFragments(lines, index) });
  }
  return new Blob([buildPdf(pages, { title })], { type: 'application/pdf' });
}
