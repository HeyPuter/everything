import { crc32 } from "node:zlib";
import { P, createDeck } from "../src/model.js";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

// A dark template whose text uses mapped theme tokens, including decorations
// owned by the layout and master rather than the slide itself.
export async function createMappedColorDeck({
  decorations = false,
  highlight = false,
  painted = false,
} = {}) {
  const pres = createDeck();
  const slide = P.getSlides(pres)[0];
  P.setSlideBackground(slide, "#000000");
  for (const [index, label] of (decorations
    ? ["Mapped slide", "Mapped layout", "Mapped master"]
    : ["Mapped text"]
  ).entries()) {
    const shape = P.addSlideTextBox(slide, {
      x: P.inches(1),
      y: P.inches(1 + index * 2),
      w: P.inches(8),
      h: P.inches(1),
      text: label,
    });
    P.renameShape(shape, label);
    if (painted) {
      P.setShapeFill(shape, "bg1");
      P.setShapeStroke(shape, { color: "tx1", widthEmu: P.pt(2) });
    }
    P.setShapeTextFormat(shape, {
      font: "Arial",
      size: 32,
      color: "tx1",
      ...(highlight ? { highlight: "tx2" } : {}),
    });
  }
  const files = unzipSync(await P.savePresentation(pres));
  const master = P.getSlideMasterPartName(slide).slice(1);
  files[master] = strToU8(
    strFromU8(files[master])
      .replace('tx1="dk1"', 'tx1="lt1"')
      .replace('tx2="dk2"', 'tx2="lt2"')
      .replace('bg1="lt1"', painted ? 'bg1="dk1"' : 'bg1="lt1"'),
  );
  if (decorations) {
    const slidePart = P.getSlidePartName(slide).slice(1);
    let xml = strFromU8(files[slidePart]);
    const shapes = xml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g);
    const layout = P.getSlideLayoutPartName(P.getSlideLayout(slide)).slice(1);
    for (const [index, target] of [
      [1, layout],
      [2, master],
    ]) {
      const shape = shapes[index];
      xml = xml.replace(shape, "");
      files[target] = strToU8(
        strFromU8(files[target]).replace(
          "</p:spTree>",
          shape.replace(/<p:cNvPr id="\d+"/, `<p:cNvPr id="${2000 + index}"`) +
            "</p:spTree>",
        ),
      );
    }
    files[slidePart] = strToU8(xml);
  }
  return zipSync(files);
}

// Templates sometimes classify a typeface in only one layout or slide.
export async function createSharedFontDeck({
  encoded = false,
  location = "layout",
} = {}) {
  const pres = createDeck();
  const slide = P.getSlides(pres)[0];
  const shape = P.addSlideTextBox(slide, {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(8),
    h: P.inches(1),
    text: "Shared serif heading",
  });
  P.setShapeTextFormat(shape, { font: "Unavailable Shared Serif", size: 32 });
  let part = "ppt/slideLayouts/slideLayout2.xml";
  if (location === "slide") {
    const donor = P.addBlankSlide(pres);
    const hint = P.addSlideTextBox(donor, {
      x: 0,
      y: 0,
      w: P.inches(1),
      h: P.inches(1),
      text: "Font metadata",
    });
    P.setShapeTextFormat(hint, { font: "Unavailable Shared Serif" });
    P.setShapeHidden(hint, true);
    part = P.getSlidePartName(donor).slice(1);
  }
  const files = unzipSync(await P.savePresentation(pres));
  files[part] = strToU8(
    location === "slide"
      ? strFromU8(files[part]).replace(
          '<a:latin typeface="Unavailable Shared Serif"',
          '<a:latin typeface="Unavailable Shared Serif" pitchFamily="18"',
        )
      : strFromU8(files[part]).replace(
          "<a:lstStyle/>",
          '<a:lstStyle><a:defPPr><a:defRPr><a:latin typeface="Unavailable Shared Serif" pitchFamily="18"/></a:defRPr></a:defPPr></a:lstStyle>',
        ),
  );
  if (encoded)
    files[part] = strToU8(
      strFromU8(files[part]).replace(
        '<a:latin typeface="Unavailable Shared Serif"',
        '<drawing:latin xmlns:drawing="http://schemas.openxmlformats.org/drawingml/2006/main" typeface="Unavailable&#32;Shared&#32;Serif"',
      ),
    );
  return zipSync(files);
}

export function withBackslashPaths(original, mixed = false) {
  return zipSync(
    Object.fromEntries(
      Object.entries(unzipSync(original)).map(([name, bytes]) => [
        mixed ? name.replace("/", "\\") : name.replaceAll("/", "\\"),
        bytes,
      ]),
    ),
  );
}

export function withArchiveComment(original, length, signature = true) {
  const bytes = new Uint8Array(original.length + length);
  bytes.set(original);
  const view = new DataView(bytes.buffer);
  view.setUint16(original.length - 2, length, true);
  if (signature) {
    // These signature bytes are comment data, with no valid end record.
    view.setUint32(original.length, 0x06054b50, true);
    view.setUint32(bytes.length - 26, 0x06054b50, true);
  }
  return bytes;
}

export function createLargeDeck() {
  const pres = createDeck();
  const slide = P.getSlides(pres)[0];
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
    "base64",
  );
  // Four valid PNGs below the 12 MB image limit. Unknown ancillary chunks
  // increase the archive size without requiring huge decoded bitmaps.
  for (let index = 0; index < 4; index++) {
    const chunk = Buffer.alloc(11 * 1024 * 1024, index + 1);
    chunk.writeUInt32BE(chunk.length - 12, 0);
    chunk.write("raNd", 4, "ascii");
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    P.addSlideImage(
      slide,
      Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]),
      { x: 0, y: 0, w: P.inches(1), h: P.inches(1) },
    );
  }
  return pres;
}

// Synthetic equivalent of tinted template backgrounds. Keep transforms in the
// XML so tests exercise import, inheritance, export and rendering together.
export async function createTransformedBackgroundDeck({
  level = "master",
  color = '<a:schemeClr val="accent5"><a:lumMod val="20000"/><a:lumOff val="80000"/></a:schemeClr>',
} = {}) {
  const pres = P.createPresentation();
  P.addBlankSlide(pres);
  const files = unzipSync(await P.savePresentation(pres));
  const folders = {
    slide: "slides",
    layout: "slideLayouts",
    master: "slideMasters",
  };
  for (const [part, data] of Object.entries(files)) {
    if (/^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/.test(part)) {
      let xml = strFromU8(data).replace(/<p:bg[ >][\s\S]*?<\/p:bg>/g, "");
      if (part.startsWith(`ppt/${folders[level]}/`)) {
        xml = xml.replace(
          /<p:cSld(?: [^>]*)?>/,
          (tag) =>
            `${tag}<p:bg><p:bgPr><a:solidFill>${color}</a:solidFill><a:effectLst/></p:bgPr></p:bg>`,
        );
      }
      files[part] = strToU8(xml);
    } else if (/^ppt\/theme\/[^/]+\.xml$/.test(part)) {
      files[part] = strToU8(
        strFromU8(data).replace(
          /<a:accent5>[\s\S]*?<\/a:accent5>/,
          '<a:accent5><a:srgbClr val="A3648B"/></a:accent5>',
        ),
      );
    }
  }
  return zipSync(files);
}
// The archive as a ZIP64 writer lays it out: every central directory entry
// gives its sizes and offset in a ZIP64 extra field, and the end of the
// directory is recorded in a ZIP64 end record found through its locator.
// `sizes` false keeps each entry's 32-bit sizes (as writers that use ZIP64
// only for the end record do).
export function asZip64(original, { sizes = true } = {}) {
  const src = new DataView(
    original.buffer,
    original.byteOffset,
    original.byteLength,
  );
  const end = original.length - 22;
  const count = src.getUint16(end + 10, true);
  const start = src.getUint32(end + 16, true);
  const out = [original.subarray(0, start)];
  let cursor = start;
  let directory = 0;
  for (let i = 0; i < count; i++) {
    const nameLength = src.getUint16(cursor + 28, true);
    const extraLength = src.getUint16(cursor + 30, true);
    const commentLength = src.getUint16(cursor + 32, true);
    const fixed = original.slice(cursor, cursor + 46 + nameLength);
    const view = new DataView(fixed.buffer);
    const extra = new Uint8Array(sizes ? 28 : 0);
    if (sizes) {
      const x = new DataView(extra.buffer);
      x.setUint16(0, 1, true);
      x.setUint16(2, 24, true);
      x.setBigUint64(4, BigInt(view.getUint32(24, true)), true);
      x.setBigUint64(12, BigInt(view.getUint32(20, true)), true);
      x.setBigUint64(20, BigInt(view.getUint32(42, true)), true);
      view.setUint32(20, 0xffffffff, true);
      view.setUint32(24, 0xffffffff, true);
      view.setUint32(42, 0xffffffff, true);
      view.setUint16(30, extra.length + extraLength, true);
    }
    const rest = original.subarray(
      cursor + 46 + nameLength,
      cursor + 46 + nameLength + extraLength + commentLength,
    );
    out.push(fixed, extra, rest);
    directory += fixed.length + extra.length + rest.length;
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  const record = new Uint8Array(56);
  const r = new DataView(record.buffer);
  r.setUint32(0, 0x06064b50, true);
  r.setBigUint64(4, 44n, true);
  r.setUint16(12, 45, true);
  r.setUint16(14, 45, true);
  r.setBigUint64(24, BigInt(count), true);
  r.setBigUint64(32, BigInt(count), true);
  r.setBigUint64(40, BigInt(directory), true);
  r.setBigUint64(48, BigInt(start), true);
  const locator = new Uint8Array(20);
  const l = new DataView(locator.buffer);
  l.setUint32(0, 0x07064b50, true);
  l.setBigUint64(8, BigInt(start + directory), true);
  l.setUint32(16, 1, true);
  const tail = original.slice(end);
  const t = new DataView(tail.buffer);
  t.setUint16(8, 0xffff, true);
  t.setUint16(10, 0xffff, true);
  t.setUint32(12, 0xffffffff, true);
  t.setUint32(16, 0xffffffff, true);
  out.push(record, locator, tail);
  const bytes = new Uint8Array(out.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of out) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
