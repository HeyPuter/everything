/**
 * Publishing Studio page layout (original). InDesign-inspired — not Adobe InDesign.
 * No LIVE Creative Cloud / print RIP (DOCUMENTED).
 */

/** @typedef {{ id:string, x:number, y:number, w:number, h:number, text:string, columns:number }} TextFrame */
/** @typedef {{ id:string, name:string, width:number, height:number, frames:TextFrame[] }} MasterPage */
/** @typedef {{ id:string, masterId:string, frames:TextFrame[] }} Page */
/** @typedef {{ masters:MasterPage[], pages:Page[], pageWidth:number, pageHeight:number }} Document */

/** @returns {Document} */
export function createDocument(pageWidth = 612, pageHeight = 792) {
  const master = {
    id: 'master-a',
    name: 'A-Master',
    width: pageWidth,
    height: pageHeight,
    frames: [
      {
        id: 'header',
        x: 54,
        y: 36,
        w: pageWidth - 108,
        h: 28,
        text: 'Publication Title',
        columns: 1,
      },
    ],
  };
  return {
    pageWidth,
    pageHeight,
    masters: [master],
    pages: [{ id: 'page-1', masterId: master.id, frames: [] }],
  };
}

/** @param {Document} doc @param {string} masterId @param {Omit<TextFrame,'id'>} frame */
export function addMasterFrame(doc, masterId, frame) {
  const masters = doc.masters.map((m) => {
    if (m.id !== masterId) return m;
    const id = `mf${m.frames.length + 1}`;
    return { ...m, frames: [...m.frames, { id, ...frame }] };
  });
  return { ...doc, masters };
}

/** @param {Document} doc @param {string} pageId @param {Omit<TextFrame,'id'>} frame */
export function addPageFrame(doc, pageId, frame) {
  const pages = doc.pages.map((p) => {
    if (p.id !== pageId) return p;
    const id = `pf${p.frames.length + 1}`;
    return { ...p, frames: [...p.frames, { id, ...frame }] };
  });
  return { ...doc, pages };
}

/** @param {Document} doc @param {string} masterId */
export function addPage(doc, masterId) {
  const id = `page-${doc.pages.length + 1}`;
  return {
    ...doc,
    pages: [...doc.pages, { id, masterId, frames: [] }],
  };
}

/** Resolved frames for a page = master frames + page frames. */
export function resolvedFrames(doc, pageId) {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return [];
  const master = doc.masters.find((m) => m.id === page.masterId);
  return [...(master?.frames || []), ...page.frames];
}

/**
 * Columnized text layout for a frame.
 * @returns {string[]}
 */
export function columnize(text, columns) {
  const cols = Math.max(1, Math.floor(columns));
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (cols === 1) return [words.join(' ')];
  const size = Math.ceil(words.length / cols);
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < cols; i += 1) {
    out.push(words.slice(i * size, (i + 1) * size).join(' '));
  }
  return out;
}

/** Minimal PDF 1.4 text page (DOCUMENTED toy exporter — not a LIVE print RIP). */
export function exportPdf(doc, pageId = doc.pages[0]?.id) {
  const frames = resolvedFrames(doc, pageId);
  const lines = frames.flatMap((f) =>
    columnize(f.text, f.columns).map((c, i) => ({
      x: f.x + (i * f.w) / Math.max(1, f.columns) + 4,
      y: doc.pageHeight - f.y - 14,
      text: c.slice(0, 80),
    })),
  );
  const content = lines
    .map((l) => `BT /F1 11 Tf ${l.x.toFixed(1)} ${l.y.toFixed(1)} Td (${escapePdf(l.text)}) Tj ET`)
    .join('\n');
  const stream = `BT /F1 1 Tf 0 0 Td ET\n${content}`;
  const objects = [];
  objects.push('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n');
  objects.push('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n');
  objects.push(
    `3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${doc.pageWidth} ${doc.pageHeight}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj\n`,
  );
  objects.push(
    `4 0 obj<< /Length ${stream.length} >>stream\n${stream}\nendstream\nendobj\n`,
  );
  objects.push('5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n');
  let body = '%PDF-1.4\n';
  /** @type {number[]} */
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return body;
}

/** @param {string} s */
function escapePdf(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
