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

/**
 * The text layer's codes: a character of the Basic Multilingual Plane is its own two-byte code; one beyond
 * it (an emoji, a rare CJK character) gets a code of its own from the surrogate range, which no character
 * uses, and the ToUnicode map gives the character back. `astral` collects those as they are first met.
 */
function codeHex(text, astral) {
  let hex = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    let code = cp;
    if (cp > 0xffff) {
      if (!astral.has(cp) && astral.size < 0x800) astral.set(cp, 0xd800 + astral.size);
      code = astral.get(cp) ?? 0xfffd;
    } else if (cp >= 0xd800 && cp <= 0xdfff) code = 0xfffd;
    hex += code.toString(16).padStart(4, '0');
  }
  return hex.toUpperCase();
}

/** Text-layer operators for one page: lines of [{ text, x, baseline, width, fontSize }] in page pixels. */
export function textLayer(fragments, pageHeightPx, astral = new Map()) {
  const ops = ['BT', '3 Tr'];
  for (const f of fragments) {
    const text = f.text.replace(/[\u0000-\u001f￼­]/g, ' ');
    if (!text.trim()) continue;
    const size = Math.max(1, f.fontSize || 12), width = Math.max(1, f.width * PT_PER_PX);
    // Each code advances half an em in the text font; horizontal scaling fits the run's painted width.
    const scale = Math.max(1, Math.min(10000, width / ([...text].length * size * 0.5) * 100));
    ops.push(`/F1 ${size.toFixed(2)} Tf ${scale.toFixed(2)} Tz 1 0 0 1 ${(f.x * PT_PER_PX).toFixed(2)} ${((pageHeightPx - f.baseline) * PT_PER_PX).toFixed(2)} Tm <${codeHex(text, astral)}> Tj`);
  }
  ops.push('ET');
  return ops.join('\n');
}

/**
 * The ToUnicode map: the BMP codes map to themselves, in ranges that keep to one high byte (§9.10.3) and
 * leave out the surrogate block, whose codes stand for the characters beyond the BMP collected in `astral`.
 */
function toUnicodeMap(astral) {
  const hex = n => n.toString(16).toUpperCase().padStart(4, '0');
  const blocks = (entries, name) => {
    let out = '';
    for (let i = 0; i < entries.length; i += 100) out += `${Math.min(100, entries.length - i)} begin${name}\n${entries.slice(i, i + 100).join('\n')}\nend${name}\n`;
    return out;
  };
  const ranges = [];
  for (let high = 0; high < 0x100; high++) if (high < 0xd8 || high > 0xdf) ranges.push(`<${hex(high << 8)}> <${hex((high << 8) | 0xff)}> <${hex(high << 8)}>`);
  const chars = [...astral].map(([cp, code]) => `<${hex(code)}> <${utf16Hex(String.fromCodePoint(cp))}>`);
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${blocks(ranges, 'bfrange')}${blocks(chars, 'bfchar')}endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

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
  // Text beyond printable ASCII is written in UTF-16BE with a byte order mark (§7.9.2.2), not as "?".
  const pdfString = s => /[^\x20-\x7e]/.test(String(s)) ? `<FEFF${utf16Hex(String(s))}>` : `(${String(s).replace(/[\\()]/g, m => '\\' + m)})`;

  const catalog = reserve(), pagesId = reserve(), font = reserve(), cidFont = reserve(), descriptor = reserve(), toUnicode = reserve(), info = reserve();
  define(info, `<< /Title ${pdfString(title)} /Author ${pdfString(author)} /Producer (Documents) /Creator (Documents) >>`);
  const astral = new Map();
  define(descriptor, '<< /Type /FontDescriptor /FontName /DocumentsTextLayer /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>');
  define(cidFont, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DocumentsTextLayer /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 500 /CIDToGIDMap /Identity >>`);
  define(font, `<< /Type /Font /Subtype /Type0 /BaseFont /DocumentsTextLayer /Encoding /Identity-H /DescendantFonts [${cidFont} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
  const kids = [];
  for (const page of pages) {
    const pageId = reserve(), image = reserve(), content = reserve();
    kids.push(pageId);
    const w = page.widthPx * PT_PER_PX, h = page.heightPx * PT_PER_PX;
    define(image, { dict: `/Type /XObject /Subtype /Image /Width ${page.imageWidth} /Height ${page.imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, stream: page.jpeg });
    define(content, { stream: encoder.encode(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} 0 0 cm /Im1 Do Q\n${textLayer(page.fragments, page.heightPx, astral)}`) });
    define(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${w.toFixed(2)} ${h.toFixed(2)}] /Resources << /XObject << /Im1 ${image} 0 R >> /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  }
  // Written once every page's text has met its characters beyond the BMP.
  define(toUnicode, { stream: encoder.encode(toUnicodeMap(astral)) });
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
