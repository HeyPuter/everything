/**
 * Minimal PDF writer that embeds one JPEG image per page.
 * Original code — no proprietary assets.
 */

export function buildPdfFromJpegs(pages) {
  if (!pages.length) throw new Error('no pages to export');
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length; // 1-based object id
  };

  const catalogId = add(''); // placeholder
  const pagesId = add('');
  const pageIds = [];
  const imageIds = [];

  for (const page of pages) {
    const { jpeg, width, height } = page;
    const imgId = add(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${jpeg.byteLength} >>\nstream\n`,
    );
    // We'll patch binary after — store meta for later assembly
    imageIds.push({ id: imgId, jpeg, width, height });
    const pageId = add('');
    pageIds.push({ id: pageId, imgId, width, height });
  }

  // Fill placeholders with correct content after we know ids
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((p) => `${p.id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  for (const p of pageIds) {
    const contentId = add(
      streamObj(`q\n${p.width} 0 0 ${p.height} 0 0 cm\n/Im${p.imgId} Do\nQ\n`),
    );
    objects[p.id - 1] =
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${p.width} ${p.height}] ` +
      `/Resources << /XObject << /Im${p.imgId} ${p.imgId} 0 R >> >> /Contents ${contentId} 0 R >>`;
  }

  for (const img of imageIds) {
    objects[img.id - 1] = {
      header:
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${img.jpeg.byteLength} >>\nstream\n`,
      binary: img.jpeg,
      tail: '\nendstream',
    };
  }

  return assemble(objects);
}

function streamObj(text) {
  const body = text;
  return `<< /Length ${body.length} >>\nstream\n${body}endstream`;
}

function assemble(objects) {
  const encoder = new TextEncoder();
  const chunks = [];
  const push = (part) => {
    if (typeof part === 'string') chunks.push(encoder.encode(part));
    else chunks.push(part);
  };

  push('%PDF-1.4\n');
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(byteLength(chunks));
    push(`${i + 1} 0 obj\n`);
    const obj = objects[i];
    if (typeof obj === 'string') {
      push(obj);
      push('\nendobj\n');
    } else {
      push(obj.header);
      push(obj.binary);
      push(obj.tail);
      push('\nendobj\n');
    }
  }
  const xrefAt = byteLength(chunks);
  push(`xref\n0 ${objects.length + 1}\n`);
  push('0000000000 65535 f \n');
  for (let i = 1; i <= objects.length; i += 1) {
    push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`);
  push(`startxref\n${xrefAt}\n%%EOF\n`);

  const total = byteLength(chunks);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function byteLength(chunks) {
  return chunks.reduce((n, c) => n + c.byteLength, 0);
}
