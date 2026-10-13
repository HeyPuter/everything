// A small PDF 1.4 writer: pages with JPEG or lossless images, text in the
// standard Helvetica faces, lines and rectangles, document information and
// bookmarks. Enough to export slides, notes pages, handouts and outlines
// without a third-party library.
//
//   const pdf = new PdfWriter({ title, author, subject, keywords });
//   const im = pdf.addJpeg(bytes, width, height);
//   const page = pdf.addPage(widthPt, heightPt);
//   page.image(im, x, y, w, h);          // top-left origin, points
//   page.text("Hello", x, baseline, 12, { bold: true });
//   pdf.addBookmark("Slide 1", 0);
//   const bytes = pdf.output();

import { zlibSync } from "fflate";

const encoder = new TextEncoder();
const latin = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

// Windows-1252 code points 0x80–0x9F, which the standard fonts' WinAnsi
// encoding uses for typographic punctuation.
const WIN_ANSI_EXTRA = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

// The WinAnsi bytes for a string, or null when a character has none (the
// caller then draws that text another way).
export function winAnsi(text) {
  const out = [];
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c === 0x09) out.push(0x20);
    else if ((c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (WIN_ANSI_EXTRA[c]) out.push(WIN_ANSI_EXTRA[c]);
    else if (c === 0x00ad) continue;
    else return null;
  }
  return out;
}

const literal = (bytes) => {
  let s = "(";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c)
      s += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) s += `\\${b.toString(8).padStart(3, "0")}`;
    else s += String.fromCharCode(b);
  }
  return `${s})`;
};

// A text string for the document information or a bookmark: PDFDocEncoding
// for plain ASCII, UTF-16BE with a byte order mark otherwise.
export function pdfTextString(value) {
  const text = String(value ?? "");
  if (/^[\x20-\x7e]*$/.test(text)) return literal(latin(text));
  let hex = "<FEFF";
  for (let i = 0; i < text.length; i++)
    hex += text.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `${hex}>`;
}

const num = (n) => {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};

function rgb(color = "#000000") {
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  const v = m ? parseInt(m[1], 16) : 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => num(c / 255));
}

function pdfDate(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

class Page {
  constructor(writer, width, height) {
    this.writer = writer;
    this.width = width;
    this.height = height;
    this.ops = [];
    this.images = new Set();
    this.fonts = new Set();
  }
  // Top-left origin, as the page layouts use; PDF's own origin is bottom-left.
  #y(y) {
    return this.height - y;
  }
  image(name, x, y, w, h) {
    this.images.add(name);
    this.ops.push(
      `q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.#y(y + h))} cm /${name} Do Q`,
    );
  }
  // Clips what follows to a rectangle until `restore()`.
  clip(x, y, w, h) {
    this.ops.push(
      `q ${num(x)} ${num(this.#y(y + h))} ${num(w)} ${num(h)} re W n`,
    );
  }
  restore() {
    this.ops.push("Q");
  }
  // Draws `text` with its baseline at y. Returns false, drawing nothing,
  // when the text has characters the standard fonts cannot show.
  // `invisible` text is not painted but can be searched and selected, as
  // over a picture of a slide; characters it cannot encode are left out.
  text(
    text,
    x,
    y,
    size,
    {
      bold = false,
      color = "#000000",
      width = 0,
      align = "left",
      invisible = false,
    } = {},
  ) {
    const bytes = invisible
      ? Array.from(String(text)).flatMap((ch) => winAnsi(ch) || [])
      : winAnsi(text);
    if (!bytes || (invisible && !bytes.length)) return false;
    const font = bold ? "F2" : "F1";
    this.fonts.add(font);
    const left =
      align === "right" ? x - width : align === "center" ? x - width / 2 : x;
    this.ops.push(
      `BT /${font} ${num(size)} Tf${invisible ? " 3 Tr" : ""} ${rgb(color).join(" ")} rg ${num(left)} ${num(this.#y(y))} Td ${literal(bytes)} Tj ET`,
    );
    return true;
  }
  line(x1, y1, x2, y2, { width = 1, color = "#000000" } = {}) {
    this.ops.push(
      `q ${num(width)} w ${rgb(color).join(" ")} RG ${num(x1)} ${num(this.#y(y1))} m ${num(x2)} ${num(this.#y(y2))} l S Q`,
    );
  }
  rect(x, y, w, h, { width = 1, color = "#000000", fill = null } = {}) {
    const paint = fill
      ? `${rgb(fill).join(" ")} rg f`
      : `${num(width)} w ${rgb(color).join(" ")} RG S`;
    this.ops.push(
      `q ${num(x)} ${num(this.#y(y + h))} ${num(w)} ${num(h)} re ${paint} Q`,
    );
  }
}

export class PdfWriter {
  constructor(info = {}) {
    this.info = info;
    this.objects = []; // [ [Uint8Array chunks] ] by object number - 1
    this.pages = [];
    this.images = new Map(); // name → object number
    this.bookmarks = [];
    this.catalog = this.#reserve();
    this.pageTree = this.#reserve();
    this.fontObjects = {
      F1: this.#add(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      ),
      F2: this.#add(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
      ),
    };
  }
  #reserve() {
    this.objects.push(null);
    return this.objects.length;
  }
  #set(n, ...chunks) {
    this.objects[n - 1] = chunks.map((c) =>
      typeof c === "string" ? latin(c) : c,
    );
  }
  #add(...chunks) {
    const n = this.#reserve();
    this.#set(n, ...chunks);
    return n;
  }
  #stream(dict, data) {
    return this.#add(
      `<< ${dict} /Length ${data.length} >>\nstream\n`,
      data,
      "\nendstream",
    );
  }
  // A baseline JPEG, embedded as is. `channels` is 1 for grayscale.
  addJpeg(bytes, width, height, { channels = 3 } = {}) {
    const name = `Im${this.images.size + 1}`;
    const space = channels === 1 ? "/DeviceGray" : "/DeviceRGB";
    this.images.set(
      name,
      this.#stream(
        `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode`,
        bytes,
      ),
    );
    return name;
  }
  // Lossless pixels: RGBA bytes as canvas ImageData holds them. Alpha other
  // than fully opaque becomes a soft mask.
  addPixels(rgba, width, height) {
    const count = width * height;
    const color = new Uint8Array(count * 3);
    const alpha = new Uint8Array(count);
    let transparent = false;
    for (let i = 0; i < count; i++) {
      color[i * 3] = rgba[i * 4];
      color[i * 3 + 1] = rgba[i * 4 + 1];
      color[i * 3 + 2] = rgba[i * 4 + 2];
      alpha[i] = rgba[i * 4 + 3];
      if (alpha[i] !== 255) transparent = true;
    }
    let mask = "";
    if (transparent) {
      const smask = this.#stream(
        `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
        zlibSync(alpha, { level: 6 }),
      );
      mask = ` /SMask ${smask} 0 R`;
    }
    const name = `Im${this.images.size + 1}`;
    this.images.set(
      name,
      this.#stream(
        `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${mask}`,
        zlibSync(color, { level: 6 }),
      ),
    );
    return name;
  }
  addPage(width, height) {
    const page = new Page(this, width, height);
    this.pages.push(page);
    return page;
  }
  addBookmark(title, pageIndex) {
    this.bookmarks.push({ title, pageIndex });
  }
  output() {
    if (!this.pages.length) this.addPage(612, 792);
    const pageObjects = [];
    for (const page of this.pages) {
      const content = encoder.encode(page.ops.join("\n"));
      const contents = this.#stream(
        "/Filter /FlateDecode",
        zlibSync(content, { level: 6 }),
      );
      const fonts = [...page.fonts]
        .map((f) => `/${f} ${this.fontObjects[f]} 0 R`)
        .join(" ");
      const images = [...page.images]
        .map((name) => `/${name} ${this.images.get(name)} 0 R`)
        .join(" ");
      pageObjects.push(
        this.#add(
          `<< /Type /Page /Parent ${this.pageTree} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Resources << /ProcSet [/PDF /Text /ImageB /ImageC] /Font << ${fonts} >> /XObject << ${images} >> >> /Contents ${contents} 0 R >>`,
        ),
      );
    }
    this.#set(
      this.pageTree,
      `<< /Type /Pages /Kids [${pageObjects.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageObjects.length} >>`,
    );
    let outlines = "";
    const marks = this.bookmarks.filter(
      (b) => b.pageIndex >= 0 && b.pageIndex < pageObjects.length,
    );
    if (marks.length) {
      const root = this.#reserve();
      const items = marks.map(() => this.#reserve());
      marks.forEach((mark, i) => {
        const links = [
          i > 0 ? `/Prev ${items[i - 1]} 0 R` : "",
          i < items.length - 1 ? `/Next ${items[i + 1]} 0 R` : "",
        ].join(" ");
        this.#set(
          items[i],
          `<< /Title ${pdfTextString(mark.title)} /Parent ${root} 0 R ${links} /Dest [${pageObjects[mark.pageIndex]} 0 R /Fit] >>`,
        );
      });
      this.#set(
        root,
        `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items.at(-1)} 0 R /Count ${items.length} >>`,
      );
      outlines = ` /Outlines ${root} 0 R /PageMode /UseOutlines`;
    }
    this.#set(
      this.catalog,
      `<< /Type /Catalog /Pages ${this.pageTree} 0 R${outlines} >>`,
    );
    const info = this.info;
    const fields = [
      ["Title", info.title],
      ["Author", info.author],
      ["Subject", info.subject],
      ["Keywords", info.keywords],
      ["Creator", info.creator],
      ["Producer", info.producer],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `/${k} ${pdfTextString(v)}`);
    fields.push(`/CreationDate (${pdfDate(info.date || new Date())})`);
    const infoObject = this.#add(`<< ${fields.join(" ")} >>`);

    const chunks = [latin("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
    let offset = chunks[0].length;
    const offsets = [];
    this.objects.forEach((parts, i) => {
      offsets.push(offset);
      const head = latin(`${i + 1} 0 obj\n`);
      const tail = latin("\nendobj\n");
      for (const c of [head, ...(parts || [latin("null")]), tail]) {
        chunks.push(c);
        offset += c.length;
      }
    });
    const xref = [
      `xref\n0 ${this.objects.length + 1}\n`,
      "0000000000 65535 f \n",
      ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`),
      `trailer\n<< /Size ${this.objects.length + 1} /Root ${this.catalog} 0 R /Info ${infoObject} 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    ].join("");
    chunks.push(latin(xref));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}
