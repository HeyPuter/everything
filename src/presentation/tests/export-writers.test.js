import { describe, expect, it } from "vitest";
import { unzlibSync } from "fflate";
import { PdfWriter, winAnsi, pdfTextString } from "../src/export/pdf-writer.js";
import { GifEncoder, quantize } from "../src/export/gif-encoder.js";
import { WebmMuxer, vint } from "../src/export/webm-muxer.js";
import { Mp4Muxer } from "../src/export/mp4-muxer.js";
import {
  outlineToRtf,
  outlineToText,
  rtfEscape,
} from "../src/export/outline-writer.js";

const latin = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};

describe("PDF writer", () => {
  function sample() {
    const pdf = new PdfWriter({
      title: "Quarterly review",
      author: "Zoë",
      date: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
    });
    const pixels = new Uint8Array(2 * 2 * 4).fill(255);
    pixels[3] = 0; // one transparent pixel
    const im = pdf.addPixels(pixels, 2, 2);
    const jpeg = pdf.addJpeg(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9), 1, 1);
    const a = pdf.addPage(720, 405);
    a.image(im, 0, 0, 720, 405);
    expect(a.text("Café – “quoted”", 10, 20, 12, { bold: true })).toBe(true);
    expect(a.text("日本", 10, 40, 12)).toBe(false);
    expect(a.text("日本 search me", 10, 60, 12, { invisible: true })).toBe(
      true,
    );
    a.line(0, 0, 10, 10, { width: 0.5, color: "#808080" });
    a.rect(1, 1, 5, 5);
    const b = pdf.addPage(612, 792);
    b.image(jpeg, 10, 10, 100, 100);
    pdf.addBookmark("First slide", 0);
    pdf.addBookmark("Ünïcode", 1);
    return latin(pdf.output());
  }

  it("writes a well-formed file whose cross-reference table points at each object", () => {
    const text = sample();
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    const start = Number(/startxref\n(\d+)/.exec(text)[1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const [, first, count] = /xref\n(\d+) (\d+)/.exec(text.slice(start));
    expect(Number(first)).toBe(0);
    const rows = text
      .slice(start)
      .split("\n")
      .slice(3, 2 + Number(count));
    rows.forEach((row, i) => {
      const offset = Number(row.slice(0, 10));
      expect(text.slice(offset, offset + 12)).toMatch(
        new RegExp(`^${i + 1} 0 obj\\n`),
      );
    });
  });

  it("has the pages, sizes, fonts, soft mask, bookmarks and information asked for", () => {
    const text = sample();
    expect(text).toContain("/Type /Pages /Kids [");
    expect(text).toContain("/Count 2");
    expect(text).toContain("/MediaBox [0 0 720 405]");
    expect(text).toContain("/MediaBox [0 0 612 792]");
    expect(text).toContain("/BaseFont /Helvetica-Bold");
    expect(text).toContain("/SMask");
    expect(text).toContain("/Filter /DCTDecode");
    expect(text).toContain("/Title (Quarterly review)");
    expect(text).toContain("/Author <FEFF005A006F00EB>");
    expect(text).toContain("/CreationDate (D:20260102030405Z)");
    expect(text).toContain("/Type /Outlines");
    expect(text).toContain("/Title (First slide)");
    expect(text).toContain("/PageMode /UseOutlines");
  });

  it("encodes page text in WinAnsi with escapes", () => {
    const text = sample();
    // Find the first page's content stream and inflate it.
    const m = /<< \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/.exec(
      text,
    );
    const begin = m.index + m[0].length;
    const bytes = Uint8Array.from(
      text.slice(begin, begin + Number(m[1])),
      (c) => c.charCodeAt(0),
    );
    const content = latin(unzlibSync(bytes));
    expect(content).toContain("/F2 12 Tf");
    expect(content).toContain("(Caf\\351 \\226 \\223quoted\\224) Tj");
    // Top-left coordinates flip to PDF's bottom-left origin.
    expect(content).toContain("10 385 Td");
    expect(content).toContain("/Im1 Do");
    expect(content).toContain(
      "/F1 12 Tf 3 Tr 0 0 0 rg 10 345 Td ( search me) Tj",
    );
  });

  it("maps text to WinAnsi bytes or reports it cannot", () => {
    expect(winAnsi("A€")).toEqual([0x41, 0x80]);
    expect(winAnsi("Ω")).toBeNull();
    expect(pdfTextString("a(b)")).toBe("(a\\(b\\))");
  });
});

// A GIF reader just thorough enough to check what the encoder wrote.
function readGif(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(latin(bytes.subarray(0, 6))).toBe("GIF89a");
  const width = view.getUint16(6, true),
    height = view.getUint16(8, true);
  let at = 13;
  const frames = [];
  let delay = 0;
  let canvas = new Uint8Array(width * height * 3);
  let loop = false;
  while (at < bytes.length) {
    const b = bytes[at++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = bytes[at++];
      if (label === 0xf9) delay = view.getUint16(at + 2, true) * 10;
      if (
        label === 0xff &&
        latin(bytes.subarray(at + 1, at + 12)) === "NETSCAPE2.0"
      )
        loop = true;
      while (bytes[at] !== 0) at += bytes[at] + 1;
      at++;
      continue;
    }
    expect(b).toBe(0x2c);
    const x = view.getUint16(at, true),
      y = view.getUint16(at + 2, true),
      w = view.getUint16(at + 4, true),
      h = view.getUint16(at + 6, true);
    const packed = bytes[at + 8];
    at += 9;
    const size = 1 << ((packed & 7) + 1);
    const palette = bytes.subarray(at, at + size * 3);
    at += size * 3;
    const minCode = bytes[at++];
    const data = [];
    while (bytes[at] !== 0) {
      data.push(...bytes.subarray(at + 1, at + 1 + bytes[at]));
      at += bytes[at] + 1;
    }
    at++;
    const indices = lzwDecode(data, minCode, w * h);
    canvas = canvas.slice();
    for (let i = 0; i < w * h; i++) {
      const px = x + (i % w),
        py = y + Math.floor(i / w);
      canvas.set(
        palette.subarray(indices[i] * 3, indices[i] * 3 + 3),
        (py * width + px) * 3,
      );
    }
    frames.push({ delay, rgb: canvas, rect: [x, y, w, h] });
  }
  return { width, height, frames, loop };
}
function lzwDecode(data, minCode, count) {
  const clear = 1 << minCode,
    end = clear + 1;
  let size = minCode + 1;
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = [];
    dict[end] = [];
    size = minCode + 1;
  };
  reset();
  const out = [];
  let bit = 0,
    prev = null;
  while (out.length < count) {
    let code = 0;
    for (let i = 0; i < size; i++, bit++)
      code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === end) break;
    let entry;
    if (code < dict.length) entry = dict[code];
    else entry = [...dict[prev], dict[prev][0]];
    out.push(...entry);
    if (prev !== null && dict.length < 4096)
      dict.push([...dict[prev], entry[0]]);
    if (dict.length === 1 << size && size < 12) size++;
    prev = code;
  }
  return out;
}

describe("GIF encoder", () => {
  const solid = (w, h, [r, g, b]) => {
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) out.set([r, g, b, 255], i * 4);
    return out;
  };

  it("round-trips frames, merges repeats and draws only what changed", () => {
    const w = 40,
      h = 30;
    const red = solid(w, h, [255, 0, 0]);
    const marked = red.slice();
    for (let y = 10; y < 15; y++)
      for (let x = 5; x < 9; x++) marked.set([0, 0, 255, 255], (y * w + x) * 4);
    const gif = new GifEncoder(w, h);
    gif.addFrame(red, 500);
    gif.addFrame(red, 500);
    gif.addFrame(marked, 300);
    const decoded = readGif(gif.finish());
    expect(decoded.loop).toBe(true);
    expect(decoded.frames).toHaveLength(2);
    expect(decoded.frames[0].delay).toBe(1000);
    expect(decoded.frames[1].delay).toBe(300);
    expect(decoded.frames[1].rect).toEqual([5, 10, 4, 5]);
    const at = (f, x, y) =>
      Array.from(f.rgb.subarray((y * w + x) * 3, (y * w + x) * 3 + 3));
    expect(at(decoded.frames[0], 0, 0)).toEqual([252, 4, 4]);
    expect(at(decoded.frames[1], 6, 12)).toEqual([4, 4, 252]);
    expect(at(decoded.frames[1], 30, 20)).toEqual([252, 4, 4]);
  });

  it("encodes a many-colored frame past the 4096-code table reset", () => {
    const w = 128,
      h = 128;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++)
      rgba.set([(i * 7) & 255, (i * 13) & 255, (i * 29) & 255, 255], i * 4);
    const gif = new GifEncoder(w, h);
    gif.addFrame(rgba, 100);
    const decoded = readGif(gif.finish());
    expect(decoded.frames).toHaveLength(1);
    const { map, palette } = quantize(rgba, 256);
    expect(palette.length).toBeLessThanOrEqual(256);
    // Every pixel decodes to its own palette color.
    for (const i of [0, 1, 777, w * h - 1]) {
      const c = palette[map(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2])];
      expect(
        Array.from(decoded.frames[0].rgb.subarray(i * 3, i * 3 + 3)),
      ).toEqual(c);
    }
  });
});

describe("WebM muxer", () => {
  it("writes an EBML header, track, cues and a cluster per key frame", () => {
    expect(Array.from(vint(1))).toEqual([0x81]);
    expect(Array.from(vint(200))).toEqual([0x40, 200]);
    const webm = new WebmMuxer({ codec: "V_VP9", width: 1280, height: 720 });
    webm.addFrame(Uint8Array.of(1, 2, 3), 0, true);
    webm.addFrame(Uint8Array.of(4, 5), 500, false);
    webm.addFrame(Uint8Array.of(6), 5000, true);
    const bytes = webm.finish(7000);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    const text = latin(bytes);
    expect(text).toContain("webm");
    expect(text).toContain("V_VP9");
    // Two clusters, each starting at a key frame.
    expect(text.split("\x1f\x43\xb6\x75")).toHaveLength(3);
    // Cues list both clusters.
    expect(text.split("\xbb").length - 1).toBeGreaterThanOrEqual(2);
    // The last frame carries a block duration that runs to the end.
    expect(text).toContain("\x9b\x82\x07\xd0");
  });
});

function readBoxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let at = start; at < end;) {
    const size = view.getUint32(at);
    out.push({
      type: latin(bytes.subarray(at + 4, at + 8)),
      start: at,
      size,
    });
    at += size;
  }
  return out;
}

describe("MP4 muxer", () => {
  it("writes the movie box first with sample tables that address the media data", () => {
    const mp4 = new Mp4Muxer({
      width: 1920,
      height: 1080,
      avcC: Uint8Array.of(1, 0x64, 0, 0x28, 0xff, 0xe0, 0),
    });
    mp4.addFrame(Uint8Array.of(9, 9, 9, 9), 0, true);
    mp4.addFrame(Uint8Array.of(8, 8), 1000, false);
    mp4.addFrame(Uint8Array.of(7), 2000, false);
    const bytes = mp4.finish(5000);
    const top = readBoxes(bytes);
    expect(top.map((b) => b.type)).toEqual(["ftyp", "moov", "mdat"]);
    expect(top.at(-1).start + top.at(-1).size).toBe(bytes.length);
    const text = latin(bytes);
    const view = new DataView(bytes.buffer);
    const stco = text.indexOf("stco");
    const offset = view.getUint32(stco + 12);
    expect(offset).toBe(top[2].start + 8);
    expect(Array.from(bytes.subarray(offset, offset + 4))).toEqual([
      9, 9, 9, 9,
    ]);
    const stsz = text.indexOf("stsz");
    expect(view.getUint32(stsz + 12)).toBe(3);
    const mvhd = text.indexOf("mvhd");
    expect(view.getUint32(mvhd + 16)).toBe(1000);
    expect(view.getUint32(mvhd + 20)).toBe(5000);
    const stss = text.indexOf("stss");
    expect(view.getUint32(stss + 8)).toBe(1);
    expect(text).toContain("avcC");
  });
});

describe("outline export", () => {
  const slides = [
    {
      number: 1,
      title: "Plan {draft}",
      outline: [
        { text: "Goals", level: 0 },
        { text: "Grow — fast", level: 1 },
      ],
    },
    { number: 2, title: "", outline: [] },
  ];
  it("writes indented plain text", () => {
    expect(outlineToText(slides)).toBe(
      "Plan {draft}\r\n\tGoals\r\n\t\tGrow — fast\r\n\r\nSlide 2\r\n",
    );
  });
  it("writes RTF with escapes and indents", () => {
    const rtf = outlineToRtf(slides, { title: "Deck" });
    expect(rtf.startsWith("{\\rtf1")).toBe(true);
    expect(rtf).toContain("\\b\\fs32 Plan \\{draft\\}");
    expect(rtf).toContain("\\li720\\fi0 Grow \\u8212? fast");
    expect(rtfEscape("😀")).toBe("\\u-10179?\\u-8704?");
    expect(rtf.trim().endsWith("}")).toBe(true);
  });
});
