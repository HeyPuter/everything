import test from "node:test";
import assert from "node:assert/strict";
import { crc32 as zlibCrc32, inflateSync } from "node:zlib";
import { JSDOM } from "jsdom";
import { PDFDocument, PDFRawStream, PDFName } from "pdf-lib";
import { Image } from "@napi-rs/canvas";
import { createCanvas } from "./canvas.js";
import { board, item, validateBoard } from "../src/model.js";
import { updateConnectors, framesItems } from "../src/scene.js";
import { drawObject } from "../src/render.js";
import { fromTemplate } from "../src/templates.js";
import {
  exportRegions,
  exportPDF,
  pdfPlan,
  pageLabel,
  tileRegion,
} from "../src/export.js";
import { exportSVG } from "../src/export-svg.js";

test("SVG content retains object and phrase languages after a cached layout changes language", () => {
  const b = board();
  const i = item("text", 0, 0, {
    text: "Hello bonjour",
    lang: "en",
    textRuns: [{ start: 6, end: 13, style: { lang: "fr" } }],
  });
  b.items = [i];
  const ctx = createCanvas(400, 300).getContext("2d");
  const read = () =>
    new JSDOM(exportSVG(b, exportRegions(b), { ctx }), {
      contentType: "image/svg+xml",
    }).window.document;
  const text = (doc, lang) =>
    [...doc.querySelectorAll("text")]
      .filter((node) => node.getAttribute("xml:lang") === lang)
      .map((node) => node.textContent)
      .join("")
      .trim();
  assert.equal(text(read(), "fr"), "bonjour");
  i.lang = "es";
  const doc = read();
  assert.equal(text(doc, "es"), "Hello");
  assert.equal(text(doc, "fr"), "bonjour");
});
test("SVG documents are in the interface language, like PDFs", () => {
  const b = board("Atelier");
  b.items = [item("note", 0, 0, { text: "Idées à prioriser" })];
  const root = (options) =>
    new JSDOM(exportSVG(b, exportRegions(b), { ctx: measure, ...options }), {
      contentType: "image/svg+xml",
    }).window.document.documentElement;
  assert.equal(root({ lang: "fr" }).getAttribute("xml:lang"), "fr-CA");
  assert.equal(root({ lang: "en" }).getAttribute("xml:lang"), "en-CA");
});
import { drawOrder, PathBuilder, breathe } from "../src/export-layout.js";
import {
  toCSV,
  exportCSV,
  exportXLSX,
  spreadsheetModel,
} from "../src/export-sheet.js";
import { exportPPTX } from "../src/export-pptx.js";
import { createZip, crc32 } from "../src/zip.js";

// drawObject decodes images through window.Image in the browser.
globalThis.window ??= { Image };
const { DOMParser } = new JSDOM("").window;
const measure = createCanvas(10, 10).getContext("2d");
const decoder = new TextDecoder();

const art = createCanvas(80, 40),
  paint = art.getContext("2d");
paint.fillStyle = "#c43b3b";
paint.fillRect(0, 0, 40, 40);
paint.fillStyle = "#365dc4";
paint.fillRect(40, 0, 40, 40);
const png = art.toDataURL("image/png");

function fixture() {
  const b = board('Plan <&> "quotes"');
  b.tags = [{ id: "t1", name: "Urgent", color: "#c43b3b" }];
  const frame = item("frame", 0, 0, {
    w: 900,
    h: 620,
    text: "Plan & <Build>",
    order: 1,
  });
  const note = item("note", 30, 70, {
    text: "Bold words and a list",
    textRuns: [
      { start: 0, end: 4, style: { bold: true, highlight: "#fff0a0" } },
      {
        start: 5,
        end: 10,
        style: { italic: true, underline: true, textColor: "#923355" },
      },
    ],
    tagIds: ["t1"],
    parentId: frame.id,
    task: {
      assignee: "Ada",
      start: "2026-10-01",
      due: "2026-10-15",
      status: "In progress",
      phase: "Design",
    },
  });
  const list = item("text", 260, 70, {
    w: 240,
    text: "First\nSecond\nNested",
    textBlocks: [
      { start: 0, list: "bullet", indent: 0 },
      { start: 6, list: "number", indent: 0 },
      { start: 13, list: "bullet", indent: 1 },
    ],
    autoHeight: true,
    parentId: frame.id,
  });
  const diamond = item("rect", 540, 70, {
    shape: "diamond",
    w: 160,
    h: 120,
    text: "Decide?",
    color: "#dce5f7",
    parentId: frame.id,
  });
  const cylinder = item("rect", 720, 70, {
    shape: "cylinder",
    w: 140,
    h: 120,
    text: "Data",
    color: "#d9e9d2",
    rotation: 20,
    parentId: frame.id,
  });
  const ellipse = item("ellipse", 540, 260, {
    w: 150,
    h: 90,
    text: "Oval",
    color: "#eadcf0",
    strike: true,
    parentId: frame.id,
  });
  const table = item("table", 30, 300, {
    w: 300,
    h: 140,
    cells: [
      ["Task", "Owner"],
      ['Write, "spec"', "=SUM(A1)"],
      ["42", "2026-11-02"],
    ],
    parentId: frame.id,
  });
  const link = item("link", 360, 300, {
    url: "https://example.com/path",
    text: "Example link",
    w: 150,
    h: 115,
    rotation: -10,
    parentId: frame.id,
  });
  const image = item("image", 720, 300, {
    src: png,
    w: 120,
    h: 120,
    crop: { x: 0.25, y: 0, w: 0.5, h: 1, mask: "ellipse", sourceAspect: 2 },
    rotation: 15,
    parentId: frame.id,
  });
  const pen = item("pen", 600, 450, {
    w: 120,
    h: 60,
    points: [
      [0, 0],
      [40, 50],
      [120, 60],
    ],
    parentId: frame.id,
  });
  const dashed = item("arrow", 0, 0, {
    startId: note.id,
    endId: diamond.id,
    text: "next",
    lineType: "elbow",
    lineStyle: "dashed",
    startCap: "circle",
    parentId: frame.id,
  });
  const dotted = item("arrow", 0, 0, {
    startId: diamond.id,
    endId: ellipse.id,
    lineType: "curved",
    lineStyle: "dotted",
    lineWidth: 4,
    parentId: frame.id,
  });
  b.items = [
    frame,
    note,
    list,
    diamond,
    cylinder,
    ellipse,
    table,
    link,
    image,
    pen,
    dashed,
    dotted,
  ];
  updateConnectors(b.items);
  return b;
}

async function rasterizer(b, rect, { scale, maxSize, transparent }) {
  rasterizer.calls.push({ rect, transparent, scale, maxSize, items: b.items });
  const s = Math.min(scale, maxSize / Math.max(rect.w, rect.h)),
    canvas = createCanvas(
      Math.max(1, Math.ceil(rect.w * s)),
      Math.max(1, Math.ceil(rect.h * s)),
    ),
    ctx = canvas.getContext("2d");
  if (!transparent) {
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.scale(s, s);
  ctx.translate(-rect.x, -rect.y);
  // As rasterRegion does: a transparent raster placed over a vector page
  // carries no shadow.
  drawOrder(b.items).forEach((i) =>
    drawObject(ctx, i, "#30342f", () => {}, false, undefined, !transparent),
  );
  return canvas;
}
rasterizer.calls = [];

const parseXML = (text, type = "application/xml") => {
  const doc = new DOMParser().parseFromString(text, type);
  assert.equal(doc.querySelector("parsererror"), null, text.slice(0, 200));
  return doc;
};

// Minimal ZIP reader: walks the central directory, checks each local header
// against it, and verifies every CRC independently with zlib.
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  assert.ok(end >= 0, "end of central directory");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  assert.equal(view.getUint32(end + 12, true), end - at, "directory size");
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    assert.equal(view.getUint32(at, true), 0x02014b50, "central header");
    const method = view.getUint16(at + 10, true),
      crc = view.getUint32(at + 16, true),
      size = view.getUint32(at + 20, true),
      nameLength = view.getUint16(at + 28, true),
      extra = view.getUint16(at + 30, true),
      comment = view.getUint16(at + 32, true),
      offset = view.getUint32(at + 42, true),
      name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    assert.equal(method, 0);
    assert.equal(view.getUint32(offset, true), 0x04034b50, "local header");
    assert.equal(view.getUint32(offset + 14, true), crc);
    const start =
      offset +
      30 +
      view.getUint16(offset + 26, true) +
      view.getUint16(offset + 28, true);
    const data = bytes.subarray(start, start + size);
    assert.equal(zlibCrc32(data), crc, `CRC of ${name}`);
    assert.equal(crc32(data), crc);
    assert.ok(!entries.has(name), `duplicate ${name}`);
    entries.set(name, data);
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}
const blobBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());

// Every XML part is well formed and every internal relationship resolves.
function checkPackage(entries) {
  const text = (name) => decoder.decode(entries.get(name));
  const types = parseXML(text("[Content_Types].xml"));
  for (const o of types.querySelectorAll("Override"))
    assert.ok(
      entries.has(o.getAttribute("PartName").slice(1)),
      o.getAttribute("PartName"),
    );
  for (const [name] of entries) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    const doc = parseXML(text(name));
    if (!name.endsWith(".rels")) continue;
    const base = name.replace(/_rels\/[^/]*\.rels$/, "");
    for (const r of doc.querySelectorAll("Relationship")) {
      // A web link's target is an address, not a part of the package.
      if (r.getAttribute("TargetMode") === "External") {
        assert.match(r.getAttribute("Target"), /^https?:\/\//);
        continue;
      }
      const target = new URL(
        r.getAttribute("Target"),
        `http://x/${base}`,
      ).pathname.slice(1);
      assert.ok(entries.has(target), `${name} -> ${target}`);
    }
  }
  return text;
}

test("zip writer produces standard CRC32 values and readable archives", () => {
  const sample = new TextEncoder().encode("123456789");
  assert.equal(crc32(sample), 0xcbf43926);
  const zip = createZip([
    { name: "a.txt", data: "hello" },
    { name: "dossier/é.txt", data: new Uint8Array([1, 2, 3]) },
  ]);
  const entries = readZip(zip);
  assert.deepEqual([...entries.keys()], ["a.txt", "dossier/é.txt"]);
  assert.equal(decoder.decode(entries.get("a.txt")), "hello");
  assert.deepEqual(
    createZip([{ name: "a", data: "b" }]),
    createZip([{ name: "a", data: "b" }]),
  );
});

test("SVG export is well formed, escapes text, and keeps vector geometry", () => {
  const b = fixture();
  b.items[1].text += "\u0001";
  b.items[1].textRuns = b.items[1].textRuns;
  const svg = exportSVG(b, exportRegions(b), { ctx: measure });
  assert.equal(svg, exportSVG(b, exportRegions(b), { ctx: measure }));
  const doc = parseXML(svg, "image/svg+xml");
  const root = doc.documentElement;
  assert.equal(root.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(root.querySelector("title").textContent, b.title);
  const texts = [...root.querySelectorAll("text")].map((t) => t.textContent);
  assert.ok(texts.includes("Plan & <Build>"));
  assert.ok(texts.includes("Bold"));
  assert.ok(texts.includes("Urgent"), "tag label");
  assert.ok(texts.includes("example.com"), "link card host");
  assert.ok(texts.includes('Write, "spec"'), "table cell");
  assert.ok(!svg.includes("\u0001"));
  assert.match(svg, /font-weight="600"[^>]*>Bold</);
  assert.match(svg, /font-style="italic"[^>]*>words</);
  assert.match(svg, /fill="#fff0a0"/, "highlight");
  // Rotation pivots on the object center, as on the canvas.
  assert.match(svg, /translate\(720 70\) rotate\(20 70 60\)/);
  // The oval crop clips the full image, positioned by the crop.
  const image = root.querySelector("image");
  assert.equal(
    image.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
    png,
  );
  assert.equal(svg.split(png).length, 2, "Each image is stored once");
  assert.equal(image.getAttribute("x"), "-60");
  assert.equal(image.getAttribute("width"), "240");
  const clip = root.querySelector(
    `clipPath#${image.parentNode.getAttribute("clip-path").slice(5, -1)}`,
  );
  assert.equal(clip.firstElementChild.tagName, "ellipse");
  // Connectors keep dash styles, curves, caps, and labels.
  assert.match(svg, /stroke-dasharray="10 7.5"/);
  assert.match(
    svg,
    /d="M[^"]*C[^"]*"[^>]*stroke-width="4"[^>]*stroke-dasharray="0.1 10"/,
  );
  assert.ok(root.querySelectorAll("circle").length >= 1, "circle cap");
  assert.ok(texts.includes("next"), "connector label");
  // Custom shapes reuse shapes.js geometry.
  const diamond = new PathBuilder();
  diamond.moveTo(80, 0);
  assert.ok(svg.includes(`d="${diamond.d}L160 60L80 120L0 60Z"`));
});

test("SVG export stacks several frames and matches wrapped canvas lines", () => {
  const b = fromTemplate("kanban", "fr");
  const regions = exportRegions(b, { scope: "frames" });
  const doc = parseXML(
    exportSVG(b, regions, { ctx: measure }),
    "image/svg+xml",
  );
  assert.equal(doc.querySelectorAll("svg > g > svg").length, regions.length);
  const note = b.items.find((i) => i.type === "note");
  const svg = exportSVG(b, exportRegions(b), { ctx: measure });
  const words = note.text.split(" ");
  assert.ok(
    svg.includes(`>${words[0]} `),
    "first wrapped line starts the text",
  );
});

test("spreadsheet exports name an embed as a kind of object in both languages", async () => {
  const { setLanguage, objectKind } = await import("../src/i18n.js");
  const b = board("Embeds");
  const embed = item("embed", 0, 0, {
    w: 480,
    h: 300,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    provider: "youtube",
    text: "Team video",
    color: "#ffffff",
  });
  b.items = [embed];
  const type = () => spreadsheetModel(b, exportRegions(b))[0].rows[1][0];
  assert.equal(type(), "Embedded content");
  const previous = globalThis.document;
  globalThis.document = new JSDOM("").window.document;
  setLanguage("fr");
  try {
    assert.equal(type(), objectKind(embed));
    assert.notEqual(type(), "Intégrer");
  } finally {
    setLanguage("en");
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test("CSV quoting follows RFC 4180 with a BOM and neutralizes formulas", () => {
  const csv = toCSV([
    ["a", 'say "hi"', "x,y", "two\nlines", " padded", 12, "=1+1", "-2", ""],
    ["-12.5", "-2+3", "+1 555 0100", "-", "- item", "@x", "-0x1"],
  ]);
  assert.equal(
    csv,
    '\ufeffa,"say ""hi""","x,y","two\nlines"," padded",12,\'=1+1,-2,\r\n' +
      "-12.5,'-2+3,'+1 555 0100,'-,'- item,'@x,'-0x1\r\n",
  );
  // Semicolons separate cells in some locales' Excel, so they are quoted.
  assert.equal(toCSV([["Plan;=1+1"]]), '\ufeff"Plan;=1+1"\r\n');
  const b = fixture();
  const text = toCSV(spreadsheetModel(b, exportRegions(b))[0].rows);
  const [header] = text.slice(1).split("\r\n");
  assert.equal(
    header,
    "Type,Text,Frame,Tags,Color,X,Y,Width,Height,URL,Assignee,Start,Due,Status,phase,ID",
  );
  assert.match(
    text,
    /Sticky note,Bold words and a list\u0001?,Plan & <Build>,Urgent,/,
  );
  assert.match(text, /,Ada,2026-10-01,2026-10-15,In progress,Design,/);
});

test("spreadsheet exports list described pictures and refuse an area with nothing to list", async () => {
  const b = board("Pictures");
  const drawing = item("pen", 0, 0, {
      w: 100,
      h: 50,
      points: [
        [0, 0],
        [100, 50],
      ],
    }),
    photo = item("image", 200, 0, {
      w: 100,
      h: 80,
      src: "data:image/png;base64,iVBORw0KGgo=",
    });
  b.items = [drawing, photo];
  // Nothing to list: no empty file with only a header row.
  assert.throws(() => exportCSV(b, exportRegions(b)), /Nothing to export/);
  assert.throws(() => exportXLSX(b, exportRegions(b)), /Nothing to export/);
  // Descriptions are text, as on PDF pages.
  photo.alt = "Team photo, =1+1";
  drawing.alt = "Red and blue arrows";
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    await blobBytes(exportCSV(b, exportRegions(b))),
  );
  assert.match(text, /\r\nDrawing,Red and blue arrows,/);
  assert.match(text, /\r\nImage,"Team photo, =1\+1",/);
  assert.ok(exportXLSX(b, exportRegions(b)).size > 0);
});

test("a locked object inside a frame is exported, listed and counted with it", () => {
  const b = board("Locked");
  const frame = item("frame", 0, 0, { w: 600, h: 400, text: "Slide A" }),
    loose = item("note", 100, 100, { text: "Locked heading", locked: true }),
    member = item("note", 300, 100, { text: "Member", parentId: frame.id });
  b.items = [frame, loose, member];
  // Locked objects never take a parentId; they lie in the frame by place.
  assert.equal(loose.parentId, undefined);
  const [region] = exportRegions(b, { scope: "frames" });
  assert.deepEqual(
    region.items.map((i) => i.id),
    [frame.id, loose.id, member.id],
  );
  assert.equal(framesItems(b.items, [frame.id]).get(frame.id).size - 1, 2);
  const rows = spreadsheetModel(b, exportRegions(b))[0].rows,
    locked = rows.find((row) => row[1] === "Locked heading");
  assert.equal(locked[2], "Slide A");
});

test("CSV exports a single table and rejects tables outside the scope", async () => {
  const b = fixture(),
    table = b.items.find((i) => i.type === "table");
  const blob = exportCSV(b, exportRegions(b), `table:${table.id}`);
  assert.equal(blob.type, "text/csv;charset=utf-8");
  assert.equal(
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(await blobBytes(blob)),
    '\ufeffTask,Owner\r\n"Write, ""spec""",\'=SUM(A1)\r\n42,2026-11-02\r\n',
  );
  const other = exportRegions(b, {
    scope: "selection",
    selection: new Set([b.items[1].id]),
  });
  assert.throws(() => exportCSV(b, other, `table:${table.id}`), /outside/);
});

test("XLSX export is a valid workbook with typed cells and task columns", async () => {
  const b = fixture();
  const entries = readZip(await blobBytes(exportXLSX(b, exportRegions(b))));
  const text = checkPackage(entries);
  const workbook = parseXML(text("xl/workbook.xml"));
  assert.deepEqual(
    [...workbook.querySelectorAll("sheet")].map((s) => s.getAttribute("name")),
    ["Objects", "Table 1", "Frames"],
  );
  const strings = [
    ...parseXML(text("xl/sharedStrings.xml")).querySelectorAll("si"),
  ].map((s) => s.textContent);
  const sheet = parseXML(text("xl/worksheets/sheet1.xml"));
  const value = (ref) => {
    const c = sheet.querySelector(`c[r="${ref}"]`);
    return c.getAttribute("t") === "s"
      ? strings[+c.textContent]
      : c.textContent;
  };
  assert.equal(value("K1"), "Assignee");
  assert.equal(value("B2"), "Bold words and a list");
  assert.equal(sheet.querySelector('c[r="B2"]').getAttribute("s"), null);
  assert.equal(sheet.querySelector('c[r="A1"]').getAttribute("s"), "1");
  assert.equal(value("F2"), "30");
  const start = sheet.querySelector('c[r="L2"]');
  assert.equal(start.getAttribute("s"), "2");
  assert.equal(+start.textContent, Date.UTC(2026, 9, 1) / 86400000 + 25569);
  assert.ok(sheet.querySelector("pane[state=frozen]"));
  assert.equal(sheet.querySelector("autoFilter").getAttribute("ref"), "A1:P9");
  const table = parseXML(text("xl/worksheets/sheet2.xml"));
  assert.equal(table.querySelector('c[r="A3"]').textContent, "42");
  assert.equal(table.querySelector('c[r="A3"]').getAttribute("t"), null);
  assert.equal(table.querySelector('c[r="B3"]').getAttribute("s"), "2");
  assert.equal(
    strings[+table.querySelector('c[r="B2"]').textContent],
    "=SUM(A1)",
  );
  assert.ok(text("xl/styles.xml").includes('formatCode="yyyy-mm-dd"'));
});

test("XLSX retains decimal text that numeric cells would round or underflow", async () => {
  const exact = [
    "0.1234567890123456789",
    "-123456789012345.6",
    `0.${"0".repeat(307)}1`,
    `-0.${"0".repeat(399)}1`,
  ];
  const numeric = [
    "42",
    "-12.5",
    "0.123456789012345",
    "100000000000000.00",
    "0.0000",
  ];
  const b = board("Exact decimals");
  b.items = [
    item("table", 0, 0, {
      cells: [["Value"], ...[...exact, ...numeric].map((v) => [v])],
    }),
  ];
  const entries = readZip(await blobBytes(exportXLSX(b, exportRegions(b))));
  const text = checkPackage(entries);
  const strings = [
    ...parseXML(text("xl/sharedStrings.xml")).querySelectorAll("si"),
  ].map((s) => s.textContent);
  const sheet = parseXML(text("xl/worksheets/sheet2.xml"));
  exact.forEach((value, n) => {
    const cell = sheet.querySelector(`c[r="A${n + 2}"]`);
    assert.equal(cell.getAttribute("t"), "s", value);
    assert.equal(strings[+cell.textContent], value);
  });
  numeric.forEach((value, n) => {
    const cell = sheet.querySelector(`c[r="A${n + exact.length + 2}"]`);
    assert.equal(cell.getAttribute("t"), null, value);
    assert.equal(+cell.textContent, Number(value));
  });
});

test("PPTX export has one 16:9 slide per frame with titles, images, and notes", async () => {
  const b = fromTemplate("journey", "fr");
  const regions = exportRegions(b, { scope: "frames" });
  rasterizer.calls = [];
  const blob = await exportPPTX(b, regions, { lang: "fr", rasterizer });
  assert.equal(
    blob.type,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  const entries = readZip(await blobBytes(blob));
  const text = checkPackage(entries);
  // PresentationML uses prefixed elements; match them by local name.
  const all = (node, name) => [...node.getElementsByTagNameNS("*", name)];
  const withPlaceholder = (doc, type) =>
    all(doc, "sp").find((sp) =>
      all(sp, "ph").some((ph) => ph.getAttribute("type") === type),
    );
  const presentation = parseXML(text("ppt/presentation.xml"));
  assert.equal(all(presentation, "sldId").length, regions.length);
  const [size] = all(presentation, "sldSz");
  assert.equal(size.getAttribute("cx") / size.getAttribute("cy"), 16 / 9);
  assert.equal(rasterizer.calls.length, regions.length);
  regions.forEach((region, n) => {
    const slide = parseXML(text(`ppt/slides/slide${n + 1}.xml`));
    assert.equal(withPlaceholder(slide, "title").textContent, region.name);
    assert.equal(all(slide, "blip").length, 1);
    const image = entries.get(`ppt/media/image${n + 1}.png`);
    assert.deepEqual([...image.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    const notes = parseXML(text(`ppt/notesSlides/notesSlide${n + 1}.xml`));
    // Speaker notes carry the frame's own text content.
    const body = withPlaceholder(notes, "body").textContent;
    const frameText = region.items.find((i) => i.type !== "frame" && i.text);
    assert.ok(body.length > 0);
    if (frameText) assert.ok(body.includes(frameText.text.split("\n")[0]));
  });
  const selection = exportRegions(b, {
    scope: "selection",
    selection: new Set([b.items[0].id]),
  });
  const one = readZip(
    await blobBytes(await exportPPTX(b, selection, { rasterizer })),
  );
  assert.ok(
    one.has("ppt/slides/slide1.xml") && !one.has("ppt/slides/slide2.xml"),
  );
});

test("PPTX export fills each slide with a frame drawn in its shape", async () => {
  const all = (node, name) => [...node.getElementsByTagNameNS("*", name)];
  const open = async (b) => {
    rasterizer.calls = [];
    const regions = exportRegions(b, { scope: "frames" });
    const entries = readZip(
      await blobBytes(await exportPPTX(b, regions, { rasterizer })),
    );
    const text = checkPackage(entries);
    const [size] = all(parseXML(text("ppt/presentation.xml")), "sldSz");
    const slide = parseXML(text("ppt/slides/slide1.xml"));
    const box = (sp) => {
      const [off] = all(sp, "off"),
        [ext] = all(sp, "ext");
      return [off, ext].flatMap((e) => [
        +e.getAttribute(e === off ? "x" : "cx"),
        +e.getAttribute(e === off ? "y" : "cy"),
      ]);
    };
    const title = all(slide, "sp").find((sp) =>
      all(sp, "ph").some((ph) => ph.getAttribute("type") === "title"),
    );
    return {
      size: [+size.getAttribute("cx"), +size.getAttribute("cy")],
      picture: box(all(slide, "pic")[0]),
      title,
      titleTop: box(title)[1],
      format: text("docProps/app.xml"),
      regions,
    };
  };
  // The presentation template's 16:9 slides fill 16:9 slides; the frame's
  // title stays in the outline, just above the slide, and its outline and
  // name are left out of the picture.
  const deck = fromTemplate("presentation-deck", "en");
  let out = await open(deck);
  assert.deepEqual(out.size, [12192000, 6858000]);
  assert.deepEqual(out.picture, [0, 0, 12192000, 6858000]);
  assert.ok(out.titleTop < 0, "The title is off the slide");
  assert.equal(out.title.textContent, out.regions[0].name);
  assert.ok(
    !rasterizer.calls[0].items.some((i) => i.id === out.regions[0].frameId),
  );
  // Frames that are all 4:3 slides make a 4:3 deck.
  const square = board("Four by three");
  square.items = [
    item("frame", 0, 0, { w: 1024, h: 768, text: "One", order: 0 }),
    item("frame", 1100, 0, { w: 1024, h: 768, text: "Two", order: 1 }),
    item("note", 100, 100, { text: "Point" }),
  ];
  out = await open(square);
  assert.deepEqual(out.size, [9144000, 6858000]);
  assert.deepEqual(out.picture, [0, 0, 9144000, 6858000]);
  assert.match(out.format, /On-screen Show \(4:3\)/);
  // Frames of other shapes keep the title on the slide over their picture.
  out = await open(fromTemplate("journey", "en"));
  assert.deepEqual(out.size, [12192000, 6858000]);
  assert.ok(out.titleTop > 0);
  assert.ok(out.picture[1] > out.titleTop);
});

test("PPTX export of a large board adds readable detail slides after an overview", async () => {
  const b = board("Wall");
  for (const [x, y, text] of [
    [0, 0, "North west"],
    [6000, 0, "North east"],
    [0, 3000, "South west"],
    [6000, 3000, "South east"],
  ])
    b.items.push(item("note", x, y, { text }));
  const all = (node, name) => [...node.getElementsByTagNameNS("*", name)];
  const open = async (regions) => {
    rasterizer.calls = [];
    const entries = readZip(
      await blobBytes(await exportPPTX(b, regions, { rasterizer })),
    );
    return checkPackage(entries);
  };
  const text = await open(exportRegions(b)),
    count = all(parseXML(text("ppt/presentation.xml")), "sldId").length;
  // An overview, then one slide for each corner: the parts between hold
  // nothing.
  assert.equal(count, 5);
  assert.equal(rasterizer.calls.length, 5);
  const overview = parseXML(text("ppt/slides/slide1.xml")),
    links = all(overview, "hlinkClick"),
    rels = parseXML(text("ppt/slides/_rels/slide1.xml.rels"));
  assert.equal(links.length, 4);
  links.forEach((link, n) => {
    const target = [...rels.querySelectorAll("Relationship")].find(
      (r) => r.getAttribute("Id") === link.getAttribute("r:id"),
    );
    assert.equal(target.getAttribute("Target"), `slide${n + 2}.xml`);
  });
  for (const [n, corner] of [
    "North west",
    "North east",
    "South west",
    "South east",
  ].entries()) {
    const slide = parseXML(text(`ppt/slides/slide${n + 2}.xml`)),
      notes = text(`ppt/notesSlides/notesSlide${n + 2}.xml`);
    assert.match(all(slide, "sp")[0].textContent, /^Wall, row \d+ column \d+$/);
    assert.ok(notes.includes(corner), corner);
    assert.equal(notes.match(/North|South/g).length, 1, notes);
    // A detail slide shows its part at about the readable PDF size.
    const call = rasterizer.calls[n + 1];
    assert.ok(call.rect.w < 1300 && call.rect.h < 700, JSON.stringify(call));
  }
  // A frame stays one slide however large it is.
  b.items.push(item("frame", -100, -100, { w: 7000, h: 3400, text: "All" }));
  const frames = await open(exportRegions(b, { scope: "frames" }));
  assert.equal(
    all(parseXML(frames("ppt/presentation.xml")), "sldId").length,
    1,
  );
});

test("PDF page plans handle page sizes, orientation, scale, and tiling", () => {
  const region = (w, h) => ({
    name: "R",
    rect: { x: 0, y: 0, w, h },
    items: [],
  });
  // Defaults reproduce the original A4 landscape detail tiles.
  const legacy = pdfPlan([region(2500, 900)]);
  assert.equal(
    legacy.length,
    1 + tileRegion({ x: 0, y: 0, w: 2500, h: 900 }).length,
  );
  assert.deepEqual(legacy[1].size, [842, 595]);
  assert.equal(legacy[0].kind, "overview");
  // 100% prints one board pixel as 0.75 pt: Letter portrait with normal
  // margins holds 556 x 704 pt, i.e. 741.33 x 938.67 board pixels per page.
  const plan = pdfPlan([region(2000, 1000)], {
    pageSize: "letter",
    orientation: "portrait",
    scale: 100,
  });
  assert.equal(plan.length, 1 + 3 * 2);
  assert.deepEqual(plan[1].size, [612, 792]);
  assert.equal(plan[1].scale, 0.75);
  assert.equal(plan[1].rect.w.toFixed(2), "741.33");
  assert.equal(plan[4].row, 2);
  assert.equal(plan[4].col, 1);
  assert.deepEqual(plan[4].neighbors, {
    up: 2,
    down: null,
    left: null,
    right: 6,
  });
  const area = plan.slice(1).reduce((sum, p) => sum + p.rect.w * p.rect.h, 0);
  assert.equal(Math.round(area), 2000 * 1000);
  assert.equal(pageLabel(plan[4]), "Page 5 of 7, row 2 column 1");
  assert.equal(pageLabel(plan[4], "fr"), "Page 5 sur 7, ligne 2, colonne 1");
  assert.match(pageLabel(plan[0]), /^Page 1 of 7\. Overview/);
  // Larger scales split into more pages; fit keeps one page per region.
  assert.ok(
    pdfPlan([region(2000, 1000)], { pageSize: "letter", scale: 200 }).length >
      plan.length,
  );
  const fit = pdfPlan([region(5000, 800), region(300, 900)], {
    pageSize: "a3",
    orientation: "auto",
    scale: "fit",
  });
  assert.equal(fit.length, 2);
  assert.deepEqual(fit[0].size, [1191, 842]);
  assert.deepEqual(fit[1].size, [842, 1191]);
  // Fit to content sizes each page to its region.
  const content = pdfPlan([region(1200, 600)], {
    pageSize: "fit",
    scale: 50,
    margin: "wide",
  });
  assert.deepEqual(content[0].size, [1200 * 0.375 + 96, 600 * 0.375 + 126]);
  assert.throws(
    () => pdfPlan([region(1e5, 1e5)], { pageSize: "letter", scale: 200 }),
    /too large/,
  );
});

test("PDF page links to neighbouring pages sit in the margin, clear of the board", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const b = board("Tiles");
  b.items = [item("note", 0, 0, { w: 3000, h: 2400, text: "" })];
  for (const margin of ["narrow", "normal"]) {
    const options = { pageSize: "letter", scale: 100, margin },
      plan = pdfPlan(exportRegions(b), options);
    const doc = await pdfjs.getDocument({
      data: await blobBytes(
        await exportPDF(b, exportRegions(b), "en", rasterizer, options),
      ),
      disableFontFace: true,
      verbosity: 0,
    }).promise;
    // Row 2, column 2 has pages on every side.
    const entry = plan.find((p) => p.row === 2 && p.col === 2),
      { x, y } = entry.placement,
      [w, h] = [entry.rect.w * entry.scale, entry.rect.h * entry.scale];
    const page = await doc.getPage(entry.index),
      chips = (await page.getTextContent()).items.filter((t) =>
        /^Page \d+$/.test(t.str),
      );
    assert.equal(Object.values(entry.neighbors).filter(Boolean).length, 4);
    assert.deepEqual(
      chips.map((t) => t.str).sort(),
      Object.values(entry.neighbors)
        .map((n) => `Page ${n}`)
        .sort(),
    );
    for (const t of chips) {
      const [a, , , , ex, ey] = t.transform,
        turned = Math.abs(a) < 1e-6,
        // The text's far corner from its origin, upward when turned.
        [fx, fy] = turned ? [ex - 7, ey + t.width] : [ex + t.width, ey + 7];
      const inside = (px, py) =>
        px > x + 0.5 && px < x + w - 0.5 && py > y - h + 0.5 && py < y - 0.5;
      assert.ok(
        !inside(ex, ey) &&
          !inside(fx, fy) &&
          !inside((ex + fx) / 2, (ey + fy) / 2),
        `${margin}: ${t.str} at ${ex},${ey} is over the board`,
      );
      assert.ok(ex >= 0 && fx <= entry.size[0] && fy <= entry.size[1]);
    }
  }
});

// Inflated content streams, for checking the drawn text and operators.
function contentText(pdf) {
  let out = "";
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const filter = object.dict.get(PDFName.of("Filter"));
    try {
      out += decoder.decode(
        filter?.toString() === "/FlateDecode"
          ? inflateSync(object.contents)
          : object.contents,
      );
    } catch {
      /* Binary image streams are not text. */
    }
  }
  return out;
}
const hex = (text) =>
  [...text]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
// Images painted on pages (XObject "Do" operators), not their alpha masks.
const imageCount = (pdf) => contentText(pdf).match(/ Do\n/g)?.length || 0;
const fontNames = (pdf) =>
  [...pdf.context.enumerateIndirectObjects()]
    .map(([, o]) => o.get?.(PDFName.of("BaseFont"))?.toString())
    .filter(Boolean);

test("PDF export applies page options, boundary markers, and page labels", async () => {
  const b = fixture();
  const blob = await exportPDF(b, exportRegions(b), "en", rasterizer, {
    pageSize: "letter",
    orientation: "portrait",
    scale: 100,
    margin: "narrow",
  });
  const pdf = await PDFDocument.load(await blobBytes(blob));
  assert.equal(pdf.getPageCount(), 3);
  assert.ok(
    pdf.getPages().every((p) => p.getWidth() === 612 && p.getHeight() === 792),
  );
  const content = contentText(pdf);
  assert.ok(content.includes(hex("Page 2 of 3, row 1 column 1")));
  assert.ok(content.includes(hex("Page 3")), "neighbor label");
  assert.ok(content.includes(hex(b.title)), "board title in the footer");
  assert.equal(imageCount(pdf), 3, "raster pages embed one image each");
});

test("PDF headers and footers show names the standard font cannot draw", async () => {
  const pages = async (title, name, createCanvas) => {
    const b = fixture();
    b.title = title;
    b.items[0].text = name;
    const blob = await exportPDF(
      b,
      exportRegions(b, { scope: "frames" }),
      "en",
      rasterizer,
      { scale: "fit", createCanvas },
    );
    return PDFDocument.load(await blobBytes(blob));
  };
  const latin = await pages("Launch board", "Launch plan", createCanvas);
  const count = latin.getPageCount();
  assert.ok(contentText(latin).includes(hex("Launch plan")));
  // The frame name in the header and the board title in each footer become
  // pictures of the text instead of blank space.
  const cyrillic = await pages("Доска проекта", "План запуска", createCanvas);
  assert.equal(cyrillic.getPageCount(), count);
  assert.equal(imageCount(cyrillic), imageCount(latin) + count + 1);
  assert.ok(contentText(cyrillic).includes(hex("Page 1 of " + count)));
  // Without a canvas, the export still completes.
  const fallback = await pages("Доска проекта", "План запуска", () => null);
  assert.equal(imageCount(fallback), imageCount(latin));
});

test("vector PDF draws shapes and text natively and rasterizes only what it must", async () => {
  const b = fixture();
  b.items.push(
    item("note", 40, 470, { text: "Snow ☃", parentId: b.items[0].id }),
  );
  rasterizer.calls = [];
  const blob = await exportPDF(b, exportRegions(b), "fr", rasterizer, {
    mode: "vector",
    pageSize: "legal",
    orientation: "landscape",
    scale: "fit",
    measure,
  });
  const pdf = await PDFDocument.load(await blobBytes(blob));
  assert.equal(pdf.getPageCount(), 1);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 1008, height: 612 });
  assert.match(pdf.catalog.get(PDFName.of("Lang")).toString(), /fr-CA/);
  const fonts = fontNames(pdf);
  assert.ok(fonts.includes("/Helvetica-Bold"), fonts.join());
  assert.ok(fonts.includes("/Helvetica-Oblique"));
  const content = contentText(pdf);
  for (const text of [
    "Plan & <Build>",
    "Decide",
    "Urgent",
    "example.com",
    "next",
  ])
    assert.ok(content.includes(hex(text)), text);
  assert.match(content, / Tz\n/, "wide standard-font text is condensed");
  // The embedded image plus one fallback raster for the unsupported glyph.
  assert.equal(rasterizer.calls.length, 1);
  assert.equal(rasterizer.calls[0].transparent, true);
  assert.equal(imageCount(pdf), 2);
  assert.ok(content.includes(hex("Page 1 sur 1")));
});

test("PDF text and image descriptions can be found and read in image and vector pages", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const b = board("Reading");
  const note = item("note", 0, 0, { text: "Decision: approve budget" });
  b.items = [
    note,
    item("image", 250, 0, { w: 200, h: 150, src: png, alt: "Org chart" }),
    item("note", 0, 250, { text: "Snow ☃" }),
  ];
  for (const mode of ["raster", "vector"]) {
    const options = { mode, pageSize: "letter", measure },
      bytes = await blobBytes(
        await exportPDF(b, exportRegions(b), "en", rasterizer, options),
      ),
      // The reader takes the bytes it is given.
      doc = await pdfjs.getDocument({
        data: bytes.slice(),
        disableFontFace: true,
        verbosity: 0,
      }).promise,
      items = (await (await doc.getPage(1)).getTextContent()).items,
      text = items.map((t) => t.str).join(" ");
    for (const words of ["Decision", "approve budget", "Org chart", "Snow"])
      assert.ok(text.includes(words), `${mode}: ${words} in ${text}`);
    // The text lies over the note it belongs to, and is not painted.
    const [page] = pdfPlan(exportRegions(b), options),
      [x, y] = items
        .find((t) => t.str.startsWith("Decision"))
        .transform.slice(4),
      left = page.placement.x + (note.x - page.rect.x) * page.scale,
      top = page.placement.y - (note.y - page.rect.y) * page.scale;
    assert.ok(
      x > left && x < left + note.w * page.scale,
      `${mode}: ${x} beside ${left}`,
    );
    assert.ok(y < top && y > top - note.h * page.scale, `${mode}: ${y}`);
    assert.match(contentText(await PDFDocument.load(bytes)), /^3 Tr$/m);
  }
});

test("vector PDF exports text with Windows line endings", async () => {
  const b = fixture();
  b.items.push(
    item("note", 40, 470, { text: "line one\r\nline two" }),
    item("rect", 300, 470, { text: "Shape\r\ntext" }),
    item("frame", 600, 470, { w: 300, h: 200, text: "CR\r\nLF" }),
  );
  const blob = await exportPDF(b, exportRegions(b), "en", rasterizer, {
    mode: "vector",
    measure,
  });
  const content = contentText(await PDFDocument.load(await blobBytes(blob)));
  assert.ok(content.includes(hex("line one")));
  assert.ok(content.includes(hex("line two")));
});

test("vector PDF draws a tab as the board does, without squeezing its line", async () => {
  // Browsers measure and draw a tab in canvas text as a space.
  const browser = new Proxy(measure, {
    get: (target, key) =>
      key === "measureText"
        ? (text) => target.measureText(String(text).replaceAll("\t", " "))
        : typeof target[key] === "function"
          ? target[key].bind(target)
          : target[key],
    set: (target, key, value) => ((target[key] = value), true),
  });
  const b = board("Tabs");
  b.items = [
    item("text", 0, 0, { w: 600, text: "Name\tOwner\tDue" }),
    item("text", 0, 100, { w: 600, text: "Name Owner Due" }),
  ];
  const blob = await exportPDF(b, exportRegions(b), "en", rasterizer, {
    mode: "vector",
    measure: browser,
  });
  const content = contentText(await PDFDocument.load(await blobBytes(blob)));
  const lines = [...content.matchAll(/([\d.]+) Tz[^]*?<([0-9A-F]+)> Tj/g)]
    .map((m) => [m[1], Buffer.from(m[2], "hex").toString("latin1")])
    .filter(([, text]) => text === "Name Owner Due");
  assert.equal(lines.length, 2, content);
  assert.equal(lines[0][0], lines[1][0]);
});

test("text over a dark highlight takes the board's light ink in SVG and vector PDF", async () => {
  const b = board("Highlight");
  b.items = [
    item("text", 0, 0, {
      w: 300,
      text: "Dark highlight",
      highlight: "#1a237e",
    }),
    item("text", 0, 100, {
      w: 400,
      text: "Plain Mark Link",
      textRuns: [
        { start: 6, end: 10, style: { highlight: "#1a237e" } },
        {
          start: 11,
          end: 15,
          style: { highlight: "#1a237e", link: "https://example.com/" },
        },
      ],
    }),
  ];
  // The colour each word is drawn in on the board.
  const ctx = createCanvas(500, 300).getContext("2d"),
    board_ = new Map(),
    fillText = ctx.fillText.bind(ctx);
  ctx.fillText = (text, x, y) => {
    board_.set(text.trim(), ctx.fillStyle);
    fillText(text, x, y);
  };
  b.items.forEach((i) => drawObject(ctx, i, "#30342f", () => {}));
  assert.equal(board_.get("Dark highlight"), "#f4f7fb");
  assert.equal(board_.get("Mark"), "#f4f7fb");
  assert.equal(board_.get("Link"), "#8ab4f8");
  const svg = new DOMParser().parseFromString(
    exportSVG(b, exportRegions(b), { ctx: measure }),
    "image/svg+xml",
  );
  for (const node of svg.querySelectorAll("text")) {
    const text = node.textContent.trim();
    if (board_.has(text))
      assert.equal(node.getAttribute("fill"), board_.get(text), text);
  }
  const pdf = await PDFDocument.load(
    await blobBytes(
      await exportPDF(b, exportRegions(b), "en", null, {
        mode: "vector",
        measure,
      }),
    ),
  );
  const content = contentText(pdf),
    rg = (color) =>
      [1, 3, 5]
        .map((n) => Number.parseInt(color.slice(n, n + 2), 16) / 255)
        .join(" ") + " rg";
  for (const text of ["Dark highlight", "Mark", "Link"]) {
    const at = content.indexOf(`<${hex(text)}`),
      before = content.slice(0, at);
    assert.ok(at > 0, text);
    assert.equal(
      before.slice(
        before.lastIndexOf("\n", before.lastIndexOf(" rg")) + 1,
        before.lastIndexOf(" rg") + 3,
      ),
      rg(board_.get(text)),
      text,
    );
  }
});

test("vector PDF tiles large boards with an overview page", async () => {
  const b = fromTemplate("journey", "en");
  const blob = await exportPDF(b, exportRegions(b), "en", rasterizer, {
    mode: "vector",
    pageSize: "a4",
    orientation: "portrait",
    scale: 75,
    measure,
  });
  const pdf = await PDFDocument.load(await blobBytes(blob));
  const plan = pdfPlan(exportRegions(b), {
    pageSize: "a4",
    orientation: "portrait",
    scale: 75,
  });
  assert.equal(pdf.getPageCount(), plan.length);
  assert.ok(plan.length > 2);
  assert.equal(imageCount(pdf), 0);
  assert.ok(contentText(pdf).includes(hex("Discover")));
});

test("vector exports draw library shape details as the board does", async () => {
  const b = board("Shapes");
  b.items = ["gateway-exclusive", "wf-phone", "multi-document"].map(
    (shape, n) =>
      item("rect", n * 240, 0, { w: 200, h: 150, shape, color: "#fff4b8" }),
  );
  const svg = exportSVG(b, exportRegions(b), { ctx: measure });
  // The gateway's cross, the phone's bezel (an even-odd fill), and the back
  // sheets of stacked documents are drawn, with details clipped to the shape.
  assert.ok((svg.match(/<path /g) || []).length > 8);
  assert.match(svg, /fill-rule="evenodd"/);
  assert.match(svg, /<clipPath id="clip-\d+"><path d=/);
  assert.equal(
    new JSDOM(svg, {
      contentType: "image/svg+xml",
    }).window.document.querySelector("parsererror"),
    null,
  );
  rasterizer.calls = [];
  const blob = await exportPDF(b, exportRegions(b), "en", rasterizer, {
    mode: "vector",
    pageSize: "fit",
    measure,
  });
  const pdf = await PDFDocument.load(await blobBytes(blob));
  assert.equal(imageCount(pdf), 0, "shapes stay vector");
  const text = contentText(pdf);
  assert.match(text, /\bf\*/, "the bezel keeps its even-odd fill");
});

test("XLSX keeps date-looking object text and frame titles as text", async () => {
  const b = board("Dated names");
  const frame = item("frame", 0, 0, { w: 400, h: 300, text: "2026-10-15" });
  b.items = [
    frame,
    item("note", 10, 10, {
      text: "2026-10-15 10:30",
      parentId: frame.id,
      due: "2026-11-01",
    }),
  ];
  const entries = readZip(await blobBytes(exportXLSX(b, exportRegions(b))));
  const text = checkPackage(entries);
  const objects = parseXML(text("xl/worksheets/sheet1.xml")),
    frames = parseXML(text("xl/worksheets/sheet2.xml"));
  const cell = (sheet, ref) => sheet.querySelector(`c[r="${ref}"]`);
  // The Text and Frame columns stay text, as typed; Due is a date.
  assert.equal(cell(objects, "B2").getAttribute("t"), "s", "Text");
  assert.equal(cell(objects, "C2").getAttribute("t"), "s", "Frame");
  assert.equal(cell(objects, "K2").getAttribute("t"), null, "Due");
  assert.equal(
    +cell(objects, "K2").textContent,
    Date.UTC(2026, 10, 1) / 86400000 + 25569,
  );
  assert.equal(cell(frames, "B2").getAttribute("t"), "s", "Frame title");
});

test("XLSX keeps impossible dates as text instead of rolling them over", async () => {
  const b = board("Dates");
  b.items = [
    item("table", 0, 0, {
      w: 400,
      h: 120,
      cells: [
        ["When"],
        ["2024-02-29 23:59"],
        ["2024-13-01"],
        ["2024-00-15"],
        ["2024-02-10 10:75"],
        ["2023-02-29"],
        // Excel cannot show these as dates.
        ["1776-07-04"],
        ["1900-02-28"],
        ["1900-03-01"],
      ],
    }),
  ];
  const entries = readZip(await blobBytes(exportXLSX(b, exportRegions(b))));
  const text = checkPackage(entries);
  const sheet = parseXML(text("xl/worksheets/sheet2.xml"));
  const cell = (ref) => sheet.querySelector(`c[r="${ref}"]`);
  assert.equal(cell("A2").getAttribute("t"), null, "a real date is a number");
  assert.ok(
    Math.abs(
      +cell("A2").textContent -
        (Date.UTC(2024, 1, 29, 23, 59) / 86400000 + 25569),
    ) < 1e-6,
  );
  for (const ref of ["A3", "A4", "A5", "A6", "A7", "A8"])
    assert.equal(cell(ref).getAttribute("t"), "s", ref);
  assert.equal(cell("A9").textContent, "61", "1900-03-01 is Excel day 61");
});

test("a frame title with line breaks becomes separate lines on its slide", async () => {
  const b = board("Breaks");
  const frame = item("frame", 0, 0, {
    w: 800,
    h: 450,
    text: "First line\nSecond line",
  });
  b.items = [
    frame,
    item("note", 40, 80, { text: "Inside", parentId: frame.id }),
  ];
  const regions = exportRegions(b, { scope: "frames" });
  const entries = readZip(
    await blobBytes(await exportPPTX(b, regions, { rasterizer })),
  );
  const text = checkPackage(entries);
  const slide = parseXML(text("ppt/slides/slide1.xml"));
  const title = [...slide.getElementsByTagNameNS("*", "sp")].find((sp) =>
    [...sp.getElementsByTagNameNS("*", "ph")].some(
      (ph) => ph.getAttribute("type") === "title",
    ),
  );
  assert.equal(title.getElementsByTagNameNS("*", "br").length, 1);
  assert.deepEqual(
    [...title.getElementsByTagNameNS("*", "t")].map((t) => t.textContent),
    ["First line", "Second line"],
  );
});

test("image and drawing descriptions reach SVG and PowerPoint exports", async () => {
  const { regionNotes } = await import("../src/export-pptx.js");
  const b = board("Described");
  b.items = [
    item("image", 0, 0, { w: 40, h: 20, src: png, alt: "Org chart & roles" }),
    item("image", 100, 0, { w: 40, h: 20, src: png }),
    item("pen", 50, 0, {
      w: 40,
      h: 20,
      points: [
        [0, 0],
        [40, 20],
      ],
      alt: "Sales rise & continue",
    }),
    item("pen", 150, 0, {
      w: 40,
      h: 20,
      points: [
        [0, 0],
        [40, 20],
      ],
    }),
    item("note", 0, 100, { text: "Caption" }),
  ];
  const svg = exportSVG(b, exportRegions(b), { ctx: measure });
  const doc = parseXML(svg);
  // The root is not an image, whose contents would be hidden.
  assert.doesNotMatch(doc.documentElement.getAttribute("role"), /\bimg\b/);
  const described = doc.querySelectorAll('g[role="img"]');
  assert.equal(described.length, 2);
  assert.equal(described[0].getAttribute("aria-label"), "Org chart & roles");
  assert.equal(
    described[0].querySelector("title").textContent,
    "Org chart & roles",
  );
  assert.equal(
    described[1].getAttribute("aria-label"),
    "Sales rise & continue",
  );
  assert.equal(
    described[1].querySelector("title").textContent,
    "Sales rise & continue",
  );
  assert.deepEqual(regionNotes(exportRegions(b)[0]), [
    "Org chart & roles",
    "Sales rise & continue",
    "Caption",
  ]);
});

test("PDF footers shorten the board title on narrow pages", async () => {
  const b = board(
    "Customer Experience Service Modernization - Discovery Workshop",
  );
  b.items = [item("frame", 0, 0, { w: 260, h: 400, text: "Intake" })];
  const pdf = await PDFDocument.load(
    await blobBytes(
      await exportPDF(
        b,
        exportRegions(b, { scope: "frames" }),
        "en",
        rasterizer,
        {
          pageSize: "fit",
          mode: "vector",
          measure,
        },
      ),
    ),
  );
  const [width] = [pdf.getPage(0).getSize().width];
  assert.ok(width < 400);
  const content = contentText(pdf);
  assert.ok(
    !content.includes(hex(b.title.slice(0, 60))),
    "full title left out",
  );
  assert.ok(content.includes(hex("Customer")), "shortened title drawn");
});

test("PDF headers shorten a long frame name on narrow pages", async () => {
  const b = board("Journey");
  const name = "Customer journey map: onboarding and first week experience";
  b.items = [item("frame", 0, 0, { w: 300, h: 200, text: name })];
  const pdf = await PDFDocument.load(
    await blobBytes(
      await exportPDF(
        b,
        exportRegions(b, { scope: "frames" }),
        "en",
        rasterizer,
        { pageSize: "fit", mode: "vector", measure },
      ),
    ),
  );
  assert.ok(pdf.getPage(0).getSize().width < 400);
  const content = contentText(pdf);
  assert.ok(!content.includes(hex(name)), "full name left out");
  assert.ok(content.includes(hex("Customer journey")), "shortened name drawn");
});

test("photos with an EXIF orientation export upright in SVG and vector PDF", async () => {
  const { imageSize, jpegOrientation } = await import("../src/model.js");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  window.requestAnimationFrame ??= (f) => setTimeout(f, 0);
  window.cancelAnimationFrame ??= clearTimeout;
  // Stored 400x300 with a red top-left quarter, then turned by EXIF.
  const stored = createCanvas(400, 300),
    g = stored.getContext("2d");
  g.fillStyle = "#0000ff";
  g.fillRect(0, 0, 400, 300);
  g.fillStyle = "#ff0000";
  g.fillRect(0, 0, 200, 150);
  const jpg = Buffer.from(
    stored.toDataURL("image/jpeg").split(",")[1],
    "base64",
  );
  const photo = (o) => {
    const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0];
    const payload = Buffer.from([
      ...Buffer.from("Exif\0\0", "latin1"),
      ...tiff,
      ...[0, 0, o, 0, 0, 0, 0, 0, 0, 0],
    ]);
    const size = payload.length + 2;
    return `data:image/jpeg;base64,${Buffer.concat([
      jpg.subarray(0, 2),
      Buffer.from([0xff, 0xe1, size >> 8, size & 255]),
      payload,
      jpg.subarray(2),
    ]).toString("base64")}`;
  };
  // Where the red quarter shows once the orientation is applied.
  const shown = {
    1: "top-left",
    2: "top-right",
    3: "bottom-right",
    4: "bottom-left",
    5: "top-left",
    6: "top-right",
    7: "bottom-right",
    8: "bottom-left",
  };
  for (let o = 1; o <= 8; o++) {
    const src = photo(o);
    const [w, h] = o >= 5 ? [300, 400] : [400, 300];
    assert.deepEqual(imageSize(src), { width: w, height: h, orientation: o });
    const b = board("Photo");
    b.items = [item("image", 0, 0, { src, w, h })];
    // The SVG draws a copy whose orientation reads "as stored".
    const svg = exportSVG(b, exportRegions(b), { ctx: measure });
    assert.equal(svg.split("data:image/jpeg").length, 2, "Stored once");
    if (o > 1) {
      assert.match(svg, /transform="matrix\(/);
      const copy = /href="data:image\/jpeg;base64,([^"]+)"/.exec(svg)[1];
      assert.equal(jpegOrientation(Buffer.from(copy, "base64")).value, 1);
    }
    // The vector PDF, rendered, shows the red quarter where the board does.
    const blob = await exportPDF(b, exportRegions(b), "en", rasterizer, {
      mode: "vector",
      pageSize: "fit",
      scale: "fit",
      measure,
    });
    const loading = pdfjs.getDocument({
      data: await blobBytes(blob),
      disableFontFace: true,
      verbosity: 0,
    });
    const doc = await loading.promise;
    const page = await doc.getPage(1),
      viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      ),
      ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = Infinity,
      top = Infinity,
      right = -1,
      bottom = -1;
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++) {
        const k = (y * canvas.width + x) * 4;
        if (pixels[k] > 180 || pixels[k + 2] > 180)
          if (pixels[k + 1] < 90) {
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
      }
    const red = (fx, fy) => {
      const x = Math.round(left + (right - left) * fx),
        y = Math.round(top + (bottom - top) * fy),
        k = (y * canvas.width + x) * 4;
      return pixels[k] > 180 && pixels[k + 2] < 90;
    };
    const found = [
      ["top-left", 0.25, 0.25],
      ["top-right", 0.75, 0.25],
      ["bottom-left", 0.25, 0.75],
      ["bottom-right", 0.75, 0.75],
    ]
      .filter(([, fx, fy]) => red(fx, fy))
      .map(([name]) => name);
    assert.deepEqual(found, [shown[o]], `orientation ${o}`);
    assert.ok(
      Math.abs((right - left) / (bottom - top) - w / h) < 0.05,
      `orientation ${o} keeps the shown proportions`,
    );
    await loading.destroy();
  }
  // Shown smaller than stored, the SVG transform still fills the box.
  const b = board("Photo");
  b.items = [item("image", 0, 0, { src: photo(6), w: 70, h: 280 / 3 })];
  const svg = exportSVG(b, exportRegions(b), { ctx: measure });
  const [, scale, , , x] = /transform="matrix\(([^)]+)\)"/
    .exec(svg)[1]
    .split(" ")
    .map(Number);
  assert.ok(Math.abs(scale * 300 - 70) < 0.01, "matrix keeps its scale");
  assert.equal(x, 70);
});

test("a pen stroke without points does not stop a vector PDF export", async () => {
  const b = board("Pens");
  b.items = [
    item("pen", 0, 0, { w: 10, h: 10, points: [] }),
    item("note", 40, 0, { text: "Still here" }),
  ];
  const blob = await exportPDF(b, exportRegions(b), "en", rasterizer, {
    mode: "vector",
    pageSize: "fit",
    scale: "fit",
    measure,
  });
  const pdf = await PDFDocument.load(await blobBytes(blob));
  assert.ok(contentText(pdf).includes(hex("Still here")));
});

test("tags show in exports only where the board draws them", async () => {
  const b = board("Tags");
  b.tags = [{ id: "t1", name: "Urgent", color: "#c43b3b" }];
  const task = {
    assignee: null,
    start: null,
    due: "2026-10-15",
    status: "todo",
  };
  b.items = [
    item("rect", 40, 40, {
      text: "Card",
      w: 200,
      h: 160,
      tagIds: ["t1"],
      task,
    }),
    item("note", 300, 40, { text: "Note", w: 200, h: 200, tagIds: ["t1"] }),
  ];
  const svg = exportSVG(b, exportRegions(b), { ctx: measure });
  assert.equal(svg.split(">Urgent<").length - 1, 1, "Only the note's chip");
  const shape = { ...b, items: [b.items[0]] };
  const blob = await exportPDF(shape, exportRegions(shape), "en", rasterizer, {
    mode: "vector",
    pageSize: "fit",
    scale: "fit",
    measure,
  });
  const pdf = await PDFDocument.load(await blobBytes(blob));
  assert.ok(!contentText(pdf).includes(hex("Urgent")));
  assert.ok(contentText(pdf).includes(hex("Card")));
});

test("objects rasterized in a vector PDF carry their edge colours into transparent pixels", async () => {
  const b = board("Halo");
  b.items = [
    item("note", 0, 0, { text: "Snow ☃", color: "#f7d46b", w: 200, h: 200 }),
  ];
  const pdf = await PDFDocument.load(
    await blobBytes(
      await exportPDF(b, exportRegions(b), "en", rasterizer, {
        mode: "vector",
      }),
    ),
  );
  const images = [...pdf.context.enumerateIndirectObjects()]
    .map(([, o]) => o)
    .filter(
      (o) =>
        o instanceof PDFRawStream &&
        o.dict.get(PDFName.of("Subtype"))?.toString() === "/Image" &&
        o.dict.get(PDFName.of("SMask")),
    );
  assert.equal(images.length, 1);
  const image = images[0],
    width = image.dict.get(PDFName.of("Width")).asNumber(),
    rgb = inflateSync(image.contents),
    alpha = inflateSync(
      pdf.context.lookup(image.dict.get(PDFName.of("SMask"))).contents,
    );
  // Every transparent pixel beside the note has the note's colour, not
  // black, so viewers that scale the mask separately draw no grey edge.
  let checked = 0;
  for (let n = 1; n < alpha.length; n++) {
    if (alpha[n] !== 0 || alpha[n - 1] !== 255 || n % width === 0) continue;
    const [r, g, bl] = rgb.subarray(n * 3, n * 3 + 3);
    assert.ok(r > 200 && g > 180 && bl > 80, `pixel ${n}: ${[r, g, bl]}`);
    checked++;
  }
  assert.ok(checked > 10);
});

test("SVG export crops a photo whose metadata fills the start of the file", () => {
  const canvas = createCanvas(80, 40);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#3366cc";
  ctx.fillRect(0, 0, 80, 40);
  const jpeg = new Uint8Array(canvas.toBuffer("image/jpeg"));
  // Five 64 KB colour profile segments before the image's size.
  const segment = new Uint8Array(65535 + 2);
  segment.set([0xff, 0xe2, 0xff, 0xff]);
  const parts = [jpeg.slice(0, 2), ...Array(5).fill(segment), jpeg.slice(2)];
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) bytes.set(part, (at += part.length) - part.length);
  const src = `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
  const b = board("Photo");
  b.items = [
    item("image", 0, 0, {
      src,
      w: 120,
      h: 120,
      crop: { x: 0.5, y: 0, w: 0.5, h: 1, mask: "ellipse" },
    }),
  ];
  const svg = exportSVG(b, exportRegions(b), { ctx: measure });
  assert.match(svg, /<ellipse /, "The oval mask is kept");
  assert.doesNotMatch(svg, /preserveAspectRatio="xMidYMid meet"/);
});

test("SVG export stores an image placed many times once", () => {
  const canvas = createCanvas(80, 40);
  canvas.getContext("2d").fillRect(0, 0, 40, 40);
  const src = canvas.toDataURL("image/png");
  const b = board("Logos");
  b.items = Array.from({ length: 20 }, (_, n) =>
    item("image", n * 100, 0, { src, w: 80, h: 40, rotation: n }),
  );
  const svg = exportSVG(b, exportRegions(b), { ctx: measure });
  assert.equal(svg.split(src).length, 2);
  assert.match(
    svg,
    /<defs><image id="image-1" width="1" height="1" preserveAspectRatio="none" xlink:href="data:image\/png;base64,/,
  );
  // Each copy scales the one image to its own place.
  const uses = [
    ...svg.matchAll(
      /<use xlink:href="#image-1" transform="matrix\(([^)]+)\)"\/>/g,
    ),
  ];
  assert.equal(uses.length, 20);
  assert.deepEqual(uses[3][1].split(" ").map(Number), [80, 0, 0, 40, 0, 0]);
  // An image used once is written in place, as before.
  const one = board("Logo");
  one.items = [item("image", 0, 0, { src, w: 80, h: 40 })];
  const single = exportSVG(one, exportRegions(one), { ctx: measure });
  assert.doesNotMatch(single, /<use |<defs>/);
  assert.match(single, /<image x="0" y="0" width="80" height="40"/);
});

test("vector PDF keeps table and card text in Caveat as wide as on the board", async () => {
  const b = board("Handwriting");
  b.items = [
    item("table", 0, 0, {
      w: 400,
      h: 80,
      fontFamily: "caveat",
      cells: [["Quarterly revenue forecast for the region", "Owner"]],
    }),
    item("link", 0, 120, {
      w: 240,
      h: 110,
      fontFamily: "caveat",
      url: "https://example.com/a-rather-long-path",
      text: "Quarterly revenue forecast",
    }),
  ];
  const blob = await exportPDF(b, exportRegions(b), "en", rasterizer, {
    mode: "vector",
    measure,
  });
  const content = contentText(await PDFDocument.load(await blobBytes(blob)));
  const squeezes = [...content.matchAll(/([\d.]+) Tz\n/g)].map((m) => +m[1]);
  // Helvetica, the standard font drawn for Caveat, is wider, so each line
  // is condensed to its width on the board.
  assert.ok(squeezes.filter((s) => s < 95).length >= 3, squeezes.join());
});

test("vector PDF leaves out soft hyphens, as the board does", async () => {
  const b = board("Hyphens");
  b.items = [item("note", 0, 0, { text: "co­op" })];
  const blob = await exportPDF(b, exportRegions(b), "en", rasterizer, {
    mode: "vector",
    measure,
  });
  const content = contentText(await PDFDocument.load(await blobBytes(blob)));
  assert.ok(content.includes(hex("coop")));
  assert.ok(!content.includes(hex("co\u00adop")), "No soft hyphen is drawn");
});

test("vector PDF keeps large objects it rasterizes sharp", async () => {
  const b = board("Emoji");
  b.items = [
    item("frame", 0, 0, { w: 4000, h: 3000, text: "Ideas 💡" }),
    item("note", 4200, 0, { text: "Snow ☃" }),
  ];
  const regions = exportRegions(b),
    plan = pdfPlan(regions, {});
  rasterizer.calls = [];
  await exportPDF(b, regions, "en", rasterizer, { mode: "vector", measure });
  const inside = (c, page) =>
    c.rect.x >= page.rect.x - 1e-6 &&
    c.rect.y >= page.rect.y - 1e-6 &&
    c.rect.x + c.rect.w <= page.rect.x + page.rect.w + 1e-6 &&
    c.rect.y + c.rect.h <= page.rect.y + page.rect.h + 1e-6;
  const frameParts = rasterizer.calls.filter((c) =>
    c.items.some((i) => i.type === "frame"),
  );
  // The frame is drawn for each page that shows it, the overview and the
  // detail page under its title, there only as far as that page reaches.
  assert.equal(frameParts.length, 2);
  assert.ok(frameParts.some((c) => c.rect.w <= 1040 && c.rect.h <= 680));
  for (const c of rasterizer.calls) {
    const page = plan.find((p) => inside(c, p));
    assert.ok(page, "Each picture lies on a page");
    // At least 200 pixels per inch as printed, within the canvas limit.
    const pixels = Math.min(c.scale, c.maxSize / Math.max(c.rect.w, c.rect.h));
    assert.ok(
      (pixels / page.scale) * 72 >= 199,
      `${(pixels / page.scale) * 72} ppi`,
    );
  }
});

test("SVG text keeps its measured width when the viewer lacks the font", () => {
  const b = board("Fonts");
  b.items = [
    item("note", 0, 0, {
      w: 190,
      h: 160,
      text: "launch plan with the team",
      fontFamily: "caveat",
    }),
  ];
  const svg = exportSVG(b, exportRegions(b), { ctx: measure });
  const doc = new JSDOM(svg, { contentType: "image/svg+xml" }).window.document;
  const runs = [...doc.querySelectorAll("text")].filter((t) =>
    /launch|team/.test(t.textContent),
  );
  assert.ok(runs.length);
  for (const run of runs) {
    assert.equal(run.getAttribute("lengthAdjust"), "spacingAndGlyphs");
    const width = Number(run.getAttribute("textLength"));
    // The run ends inside the note, however wide the viewer's font is.
    assert.ok(width > 0);
    assert.ok(Number(run.getAttribute("x")) + width <= 190, run.textContent);
  }
});

test("vector PDF keeps accents written as combining marks as selectable text", async () => {
  const b = board("Accents");
  b.items = [
    item("note", 0, 0, {
      text: "Équipe café".normalize("NFD"),
      autoFontSize: false,
    }),
  ];
  rasterizer.calls = [];
  const blob = await exportPDF(b, exportRegions(b), "fr", rasterizer, {
    mode: "vector",
    measure,
  });
  assert.equal(rasterizer.calls.length, 0);
  const content = contentText(await PDFDocument.load(await blobBytes(blob)));
  assert.ok(content.includes(hex("Équipe café")));
});

test("spreadsheet and section exports stay fast on boards full of frames", () => {
  const b = board("Big");
  const frames = Array.from({ length: 2500 }, (_, n) =>
    item("frame", (n % 50) * 1000, Math.floor(n / 50) * 1000, {
      w: 900,
      h: 900,
      text: `F${n}`,
      order: n,
    }),
  );
  b.items = [
    ...frames,
    ...Array.from({ length: 2500 }, (_, n) =>
      item("note", (n % 50) * 1000 + 10, Math.floor(n / 50) * 1000 + 10, {
        parentId: frames[n].id,
        text: `n${n}`,
      }),
    ),
  ];
  const started = performance.now();
  const sheets = spreadsheetModel(b, exportRegions(b));
  const sections = exportRegions(b, { scope: "frames" });
  assert.ok(performance.now() - started < 1000);
  const frameRows = sheets.find((s) => s.key === "frames").rows;
  assert.equal(frameRows.length, 2501);
  assert.ok(frameRows.slice(1).every((r) => r[2] === 1));
  assert.equal(sections.length, 2500);
  assert.deepEqual(
    sections[7].items.map((i) => i.id),
    [frames[7].id, b.items[2507].id],
  );
});

test("a thick connection line drawn as an image in a vector PDF keeps its round end", async () => {
  const b = board("Arrows");
  const a = item("arrow", 300, 50, {
    w: 120,
    h: 300,
    lineWidth: 12,
    text: "✓",
    startCap: "circle",
  });
  b.items = [a];
  rasterizer.calls = [];
  await exportPDF(b, exportRegions(b), "en", rasterizer, {
    mode: "vector",
    measure,
  });
  assert.equal(rasterizer.calls.length, 1);
  const area = rasterizer.calls[0].rect;
  // The start cap is a circle of radius 14 around the line's start.
  assert.ok(area.x <= a.x - 15 && area.y <= a.y - 15, JSON.stringify(area));
});

test("region, selection and frame exports keep the far node of a mind map line", () => {
  const b = board("Lines");
  const mind = (id, x, parent) =>
    item("note", x, 40, {
      id,
      w: 100,
      h: 60,
      mindMap: { parent, direction: "right", auto: true, line: "straight" },
    });
  const frame = item("frame", -20, -20, { id: "f", w: 400, h: 200 });
  b.items = [
    frame,
    { ...mind("root", 0, null), parentId: "f" },
    mind("leaf", 1000, "root"),
    mind("other", 1000, null),
  ];
  const ids = (regions) => regions[0].items.map((i) => i.id).sort();
  // The line from root (ending x 100) to leaf (x 1000) crosses the region.
  assert.deepEqual(
    ids(
      exportRegions(b, {
        scope: "selection",
        region: { x: 400, y: 0, w: 200, h: 200 },
      }),
    ),
    ["leaf", "root"],
  );
  assert.deepEqual(
    ids(exportRegions(b, { scope: "selection", selection: new Set(["root"]) })),
    ["leaf", "root"],
  );
  assert.deepEqual(ids(exportRegions(b, { scope: "frames" })), [
    "f",
    "leaf",
    "root",
  ]);
  // A region the line never reaches gets no extra node.
  assert.deepEqual(
    ids(
      exportRegions(b, {
        scope: "selection",
        region: { x: 400, y: 500, w: 200, h: 200 },
      }),
    ),
    [],
  );
});

test("each tiled PDF page renders only the objects that reach it", async () => {
  const b = board("Tiles");
  const mind = (id, x, parent) =>
    item("note", x, 40, {
      id,
      mindMap: { parent, direction: "right", auto: true, line: "straight" },
    });
  // A mind map line spans the middle pages, far from both of its nodes.
  b.items = [
    mind("root", 0, null),
    mind("leaf", 4000, "root"),
    ...Array.from({ length: 40 }, (_, n) =>
      item("note", n * 110, 600, { text: `n${n}` }),
    ),
  ];
  const pages = [];
  const record = async (board, rect, options) => {
    pages.push({ rect, ids: board.items.map((i) => i.id) });
    return rasterizer(board, rect, options);
  };
  await exportPDF(b, exportRegions(b), "en", record, { scale: 100 });
  const details = pages.slice(1);
  assert.ok(details.length > 4);
  for (const { rect, ids } of details) {
    assert.ok(ids.length < b.items.length, "far objects are left out");
    // Every note that overlaps the page is drawn on it.
    for (const i of b.items.slice(2))
      if (
        i.x < rect.x + rect.w &&
        i.x + i.w > rect.x &&
        i.y < rect.y + rect.h &&
        i.y + i.h > rect.y
      )
        assert.ok(ids.includes(i.id));
    // The line runs from x 190 to 4000 at y 120.
    if (rect.y < 120 && rect.x < 4000 && rect.x + rect.w > 190)
      assert.ok(ids.includes("root") && ids.includes("leaf"));
  }
});

const pptxRuns = (doc) =>
  [...doc.getElementsByTagNameNS("*", "r")].map((run) => ({
    text: run.getElementsByTagNameNS("*", "t")[0].textContent,
    lang: run.getElementsByTagNameNS("*", "rPr")[0].getAttribute("lang"),
  }));
const pptxParagraphs = (doc) =>
  [...doc.getElementsByTagNameNS("*", "p")].map(pptxRuns);

test("PPTX titles and notes preserve authored object, passage and table cell languages", async () => {
  const b = board("Bilingual board");
  const frame = item("frame", 0, 0, {
    w: 900,
    h: 620,
    text: "Hello bonjour",
    lang: "en-CA",
    textRuns: [{ start: 6, end: 13, style: { lang: "FR-ca" } }],
  });
  const note = item("note", 20, 70, {
    text: "Bonjour hello\nMerci",
    lang: "fr-CA",
    textRuns: [{ start: 8, end: 13, style: { lang: "en-GB", bold: true } }],
    parentId: frame.id,
  });
  const table = item("table", 20, 300, {
    cells: [
      ["Bonjour", "hello"],
      ["", "Salut 😀"],
    ],
    lang: "de",
    cellLanguages: {
      "0,0": { lang: "fr" },
      "0,1": { lang: "en-GB" },
      "1,1": {
        lang: "fr-CA",
        textRuns: [{ start: 6, end: 8, style: { lang: "es" } }],
      },
    },
    parentId: frame.id,
  });
  const image = item("image", 400, 70, {
    src: png,
    alt: "Schéma & <rôles>",
    lang: "fr-CA",
    parentId: frame.id,
  });
  const file = item("file", 400, 300, {
    fileName: "rapport.pdf",
    data: "data:application/octet-stream;base64,",
    lang: "fr",
    parentId: frame.id,
  });
  b.items = [frame, note, table, image, file];
  validateBoard(b);
  const original = structuredClone(b);
  for (const lang of ["en", "fr"]) {
    const entries = readZip(
      await blobBytes(
        await exportPPTX(b, exportRegions(b, { scope: "frames" }), {
          lang,
          rasterizer,
        }),
      ),
    );
    const text = checkPackage(entries);
    assert.deepEqual(pptxRuns(parseXML(text("ppt/slides/slide1.xml"))), [
      { text: "Hello ", lang: "en-CA" },
      { text: "bonjour", lang: "fr-CA" },
    ]);
    assert.deepEqual(
      pptxParagraphs(parseXML(text("ppt/notesSlides/notesSlide1.xml"))),
      [
        [
          { text: "Bonjour ", lang: "fr-CA" },
          { text: "hello", lang: "en-GB" },
        ],
        [{ text: "Merci", lang: "fr-CA" }],
        [{ text: "Schéma & <rôles>", lang: "fr-CA" }],
        [
          { text: "Bonjour", lang: "fr" },
          { text: " | ", lang: "de" },
          { text: "hello", lang: "en-GB" },
        ],
        [
          { text: "| ", lang: "de" },
          { text: "Salut ", lang: "fr-CA" },
          { text: "😀", lang: "es" },
        ],
        [{ text: "rapport.pdf", lang: "fr" }],
      ],
    );
    assert.deepEqual(b, original, "export does not mutate authored metadata");
  }
});

test("PPTX note language ranges follow CRLF, tabs, trimming and export limits", async () => {
  const b = board("Whitespace");
  const text = "  Début\tHello\r\n\tbonjour  \rFin\r\n\r\n";
  const start = text.indexOf("Hello");
  b.items = [
    item("note", 0, 0, {
      text,
      lang: "fr",
      textRuns: [
        { start, end: text.indexOf("bonjour") + 7, style: { lang: "en-GB" } },
      ],
    }),
  ];
  validateBoard(b);
  const region = exportRegions(b)[0];
  const { regionNotes } = await import("../src/export-pptx.js");
  assert.deepEqual(regionNotes(region), ["Début | Hello", "| bonjour", "Fin"]);
  let entries = readZip(
    await blobBytes(await exportPPTX(b, [region], { rasterizer })),
  );
  let xmlText = checkPackage(entries);
  assert.deepEqual(
    pptxParagraphs(parseXML(xmlText("ppt/notesSlides/notesSlide1.xml"))),
    [
      [
        { text: "Début | ", lang: "fr" },
        { text: "Hello", lang: "en-GB" },
      ],
      [{ text: "| bonjour", lang: "en-GB" }],
      [{ text: "Fin", lang: "fr" }],
    ],
  );
  const long = "a".repeat(1999) + "bonjour";
  b.items = [
    item("note", 0, 0, {
      text:
        long +
        "\n" +
        Array.from({ length: 501 }, (_, n) => `line ${n}`).join("\n"),
      lang: "fr",
      textRuns: [{ start: 1999, end: 2006, style: { lang: "en" } }],
    }),
  ];
  validateBoard(b);
  entries = readZip(
    await blobBytes(await exportPPTX(b, exportRegions(b), { rasterizer })),
  );
  xmlText = checkPackage(entries);
  const paragraphs = pptxParagraphs(
    parseXML(xmlText("ppt/notesSlides/notesSlide1.xml")),
  );
  assert.equal(paragraphs.length, 500);
  assert.deepEqual(paragraphs[0], [
    { text: "a".repeat(1999), lang: "fr" },
    { text: "b", lang: "en" },
  ]);
  assert.equal(paragraphs.at(-1)[0].text, "line 498");
});

test("PPTX untagged content and generated titles retain the interface language fallback", async () => {
  const b = board("Plain board");
  b.items = [
    item("note", 0, 0, {
      text: "Legacy text",
      textRuns: [{ start: 0, end: 6, style: { bold: true } }],
    }),
  ];
  for (const lang of ["en", "fr"]) {
    for (const regions of [
      exportRegions(b),
      exportRegions(b, {
        scope: "selection",
        selection: new Set([b.items[0].id]),
      }),
    ]) {
      const entries = readZip(
        await blobBytes(await exportPPTX(b, regions, { lang, rasterizer })),
      );
      const text = checkPackage(entries),
        expected = lang === "fr" ? "fr-CA" : "en-CA";
      assert.deepEqual(pptxRuns(parseXML(text("ppt/slides/slide1.xml"))), [
        { text: regions[0].name, lang: expected },
      ]);
      assert.deepEqual(
        pptxRuns(parseXML(text("ppt/notesSlides/notesSlide1.xml"))),
        [{ text: "Legacy text", lang: expected }],
      );
    }
  }
});

test("a fit-to-content PDF of a very large board is drawn as several pictures, not one blurry one", async () => {
  const b = board("Large");
  b.items = [item("note", 0, 0, { w: 16000, h: 10000, text: "" })];
  const calls = [];
  const tiny = async (board, rect, options) => {
    calls.push({ rect, ...options });
    return createCanvas(2, 2);
  };
  const options = { pageSize: "fit" };
  const [page] = pdfPlan(exportRegions(b), options);
  const doc = await PDFDocument.load(
    await blobBytes(await exportPDF(b, exportRegions(b), "en", tiny, options)),
  );
  assert.equal(doc.getPageCount(), 1);
  assert.ok(calls.length > 1, "several pictures");
  const rect = page.rect;
  // Together they cover the page's region exactly, each within the canvas
  // limit, at a density well above what one 4,096-pixel picture allows.
  const area = calls.reduce((sum, c) => sum + c.rect.w * c.rect.h, 0);
  assert.ok(Math.abs(area - rect.w * rect.h) < 1e-6 * rect.w * rect.h);
  for (const c of calls) {
    assert.ok(Math.max(c.rect.w, c.rect.h) * c.scale <= 4096 + 1e-6);
    assert.ok(c.scale > (4096 / Math.max(rect.w, rect.h)) * 2);
  }
  // Within the 64-megapixel budget image exports keep.
  assert.ok(area * calls[0].scale ** 2 <= 64e6 * 1.0001);
  // A board that one picture serves well stays one picture.
  calls.length = 0;
  b.items = [item("note", 0, 0, { w: 1200, h: 800, text: "" })];
  await exportPDF(b, exportRegions(b), "en", tiny, options);
  assert.equal(calls.length, 1);
});

test("image PDF pages hold no more pixels than print needs", async () => {
  const b = board("Spread out");
  // A few notes far apart: fitted on one page, or split into readable
  // detail, the area is reduced far below one point per board pixel.
  b.items = [0, 1, 2, 3].map((n) =>
    item("note", n * 20000, (n % 2) * 10000, { text: `Note ${n}` }),
  );
  const calls = [];
  const tiny = async (board, rect, options) => {
    calls.push({ rect, ...options });
    return createCanvas(2, 2);
  };
  for (const scale of ["fit", "auto"]) {
    calls.length = 0;
    const options = { pageSize: "a4", scale },
      plan = pdfPlan(exportRegions(b), options);
    await exportPDF(b, exportRegions(b), "en", tiny, options);
    const pictures = calls.filter((c) => !c.transparent);
    // Pixels drawn, against the printed area of every page at 400 pixels
    // per inch (72 points to the inch).
    const drawn = pictures.reduce((sum, c) => {
        const s = Math.min(c.scale, c.maxSize / Math.max(c.rect.w, c.rect.h));
        return sum + c.rect.w * s * (c.rect.h * s);
      }, 0),
      printed = plan.reduce(
        (sum, page) =>
          sum +
          ((page.rect.w * page.scale * page.rect.h * page.scale) / 72 ** 2) *
            400 ** 2,
        0,
      );
    assert.ok(drawn <= printed * 1.01, `${scale}: ${drawn} > ${printed}`);
  }
});

test("UML, BPMN and ERD connector ends validate and export as drawn", () => {
  const b = board("Ends");
  b.items = [
    {
      ...item("arrow", 0, 0, { w: 200, h: 0, color: "#253247" }),
      startCap: "diamond-open",
      endCap: "triangle",
    },
    {
      ...item("arrow", 0, 100, { w: 200, h: 0, color: "#253247" }),
      startCap: "bar",
      endCap: "crowfoot",
    },
  ];
  validateBoard(b);
  const svg = exportSVG(b, exportRegions(b), {
    ctx: createCanvas(1, 1).getContext("2d"),
  });
  // The open diamond is white inside and outlined; the triangle is filled
  // with the line's color.
  assert.match(svg, /<path d="[^"]+" fill="#ffffff" stroke="#253247"/);
  assert.match(svg, /<path d="[^"]+Z?[^"]*" fill="#253247" stroke="#253247"/);
  // A crow's foot is three strokes from one point.
  const feet = [...svg.matchAll(/<path d="M[^"]+" fill="none" stroke=/g)];
  assert.ok(feet.length >= 4, "bar and three crow's foot strokes");
  assert.throws(
    () =>
      validateBoard({
        ...b,
        items: [{ ...b.items[0], endCap: "bogus" }],
      }),
    /line style/,
  );
});

test("SVG and vector PDF tables keep the table's weight, slant and alignment", async () => {
  const b = board("Formatted table");
  const table = item("table", 0, 0, {
    w: 400,
    h: 100,
    bold: true,
    italic: true,
    textAlign: "center",
    cells: [["Plan", "Owner"]],
  });
  b.items = [table];
  const runs = (svg) =>
    [
      ...new JSDOM(svg, {
        contentType: "image/svg+xml",
      }).window.document.querySelectorAll("text"),
    ].filter((t) => ["Plan", "Owner"].includes(t.textContent));
  let texts = runs(exportSVG(b, exportRegions(b), { ctx: measure }));
  assert.equal(texts.length, 2);
  for (const [n, text] of texts.entries()) {
    assert.equal(text.getAttribute("font-weight"), "600");
    assert.equal(text.getAttribute("font-style"), "italic");
    // Each word sits in the middle of its 200-pixel-wide cell.
    const middle =
      Number(text.getAttribute("x")) +
      Number(text.getAttribute("textLength")) / 2;
    assert.ok(Math.abs(middle - (n * 200 + 100)) < 0.5, `${middle}`);
  }
  table.textAlign = "right";
  texts = runs(exportSVG(b, exportRegions(b), { ctx: measure }));
  for (const [n, text] of texts.entries()) {
    const end =
      Number(text.getAttribute("x")) + Number(text.getAttribute("textLength"));
    assert.ok(Math.abs(end - (n * 200 + 191)) < 0.5, `${end}`);
  }
  const blob = await exportPDF(b, exportRegions(b), "en", rasterizer, {
    mode: "vector",
    measure,
  });
  const pdf = await PDFDocument.load(await blobBytes(blob));
  assert.ok(fontNames(pdf).includes("/Helvetica-BoldOblique"));
  assert.ok(contentText(pdf).includes(hex("Owner")));
});

test("the board draws a table's cells in its weight and slant, lined up as it is aligned", () => {
  const ctx = createCanvas(500, 200).getContext("2d");
  const drawn = [];
  const fillText = ctx.fillText.bind(ctx);
  ctx.fillText = (text, x, y) => {
    drawn.push({ text, x, font: ctx.font, align: ctx.textAlign });
    fillText(text, x, y);
  };
  const table = item("table", 0, 0, {
    w: 400,
    h: 100,
    fontSize: 20,
    bold: true,
    italic: true,
    textAlign: "right",
    cells: [["Plan", "Owner"]],
  });
  drawObject(ctx, table, "#30342f", () => {});
  assert.deepEqual(
    drawn.map(({ text, x, align }) => [text, x, align]),
    [
      ["Plan", 191, "right"],
      ["Owner", 391, "right"],
    ],
  );
  assert.ok(drawn.every(({ font }) => /italic 600 20px/.test(font)));
  // Drawing a table leaves the next object's alignment as it was.
  assert.equal(ctx.textAlign, "start");
  drawn.length = 0;
  drawObject(ctx, { ...table, textAlign: "center" }, "#30342f", () => {});
  assert.deepEqual(
    drawn.map(({ x, align }) => [x, align]),
    [
      [100, "center"],
      [300, "center"],
    ],
  );
});

test("SVG and vector PDF draw a shape's set border inside its outline, as the board does", async () => {
  const b = board("Borders");
  b.items = [
    item("rect", 0, 0, { w: 200, h: 120, color: "#ffffff" }),
    item("rect", 240, 0, {
      w: 200,
      h: 120,
      color: "#ffffff",
      lineWidth: 4,
      lineStyle: "dashed",
    }),
    item("ellipse", 480, 0, {
      w: 200,
      h: 120,
      color: "#ffffff",
      lineWidth: 6,
      lineStyle: "dotted",
    }),
    item("rect", 720, 0, {
      w: 200,
      h: 120,
      color: "#ffffff",
      shape: "diamond",
      lineWidth: 2,
      lineStyle: "dashed",
    }),
    item("rect", 960, 0, {
      w: 200,
      h: 120,
      color: "#ffffff",
      shape: "document",
      lineWidth: 3,
      lineStyle: "dashed",
    }),
  ];
  const svg = exportSVG(b, exportRegions(b), { ctx: measure });
  const doc = new JSDOM(svg, { contentType: "image/svg+xml" }).window.document;
  assert.equal(doc.querySelector("parsererror"), null);
  const stroked = [...doc.querySelectorAll("path[stroke-width]")].map((p) =>
    ["stroke-width", "stroke-dasharray", "stroke-linecap"]
      .map((name) => p.getAttribute(name))
      .join(" "),
  );
  // The usual border is unchanged: one pixel, solid.
  assert.ok(stroked.includes("1  "), stroked.join(" | "));
  assert.ok(stroked.includes("4 16 12 round"), "dashed rectangle");
  assert.ok(stroked.includes("6 0.1 15 round"), "dotted ellipse");
  assert.ok(stroked.includes("2 8 6 round"), "dashed diamond");
  assert.ok(stroked.includes("3 12 9 round"), "dashed library shape");
  // A thicker border is drawn inside the outline, its corners concentric.
  assert.match(svg, /<path d="M10 1\.5H190A8\.5 8\.5 0 0 1 198\.5 10V110/);
  assert.match(svg, /<g transform="translate\(0\.5 0\.5\)"><path d=/);
  const blob = await exportPDF(b, exportRegions(b), "en", rasterizer, {
    mode: "vector",
    pageSize: "fit",
    measure,
  });
  const pdf = await PDFDocument.load(await blobBytes(blob));
  assert.equal(imageCount(pdf), 0, "borders stay vector");
  const content = contentText(pdf);
  for (const dash of ["[16 12] 0 d", "[0.1 15] 0 d", "[8 6] 0 d", "[12 9] 0 d"])
    assert.ok(content.includes(dash), dash);
});

test("download names keep a title's dots and words and never split a character", async () => {
  const { fileName } = await import("../src/file-name.js");
  assert.equal(
    fileName('Q3 Plan v1.2 / Café & "Co" <test>', "Whiteboard"),
    "Q3 Plan v1.2 Café & Co test",
  );
  assert.equal(fileName("版本 1.0 — 計画", "Whiteboard"), "版本 1.0 計画");
  assert.equal(fileName("...hidden.", "Whiteboard"), "hidden");
  assert.equal(fileName("Réunion d’équipe", "Whiteboard"), "Réunion d’équipe");
  assert.equal(fileName("???", "Whiteboard"), "Whiteboard");
  assert.equal(fileName("", "Frame"), "Frame");
  const long = fileName("a" + "\u{20000}".repeat(120), "Whiteboard");
  assert.equal(Array.from(long).length, 100);
  assert.ok(!long.includes("\ufffd") && long.isWellFormed());
  assert.equal(fileName("a\u0000b\tc:d*e|f", "x"), "a b c d e f");
});

test("long exports report each slide and give the page its turn", async () => {
  const b = fromTemplate("journey", "en"),
    regions = exportRegions(b, { scope: "frames" }),
    steps = [];
  await exportPPTX(b, regions, {
    rasterizer,
    progress: (n, total) => steps.push(`${n}/${total}`),
  });
  assert.ok(steps.length > 1);
  assert.deepEqual(
    steps,
    steps.map((_, n) => `${n + 1}/${steps.length}`),
  );
  // A task queued before a turn runs before the export goes on.
  let ran = false;
  setTimeout(() => (ran = true), 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  ran = false;
  setTimeout(() => (ran = true), 0);
  await breathe();
  assert.ok(ran);
});

// A board with each kind of web link: a turned link card, an embed card,
// and a linked word in a note.
function linkedBoard() {
  const b = board("Links");
  b.items = [
    {
      ...item("link", 0, 0, {
        w: 320,
        h: 115,
        url: "https://example.com/a?b=1&c=(2",
        text: "Example",
      }),
      rotation: 30,
    },
    item("embed", 400, 0, {
      w: 480,
      h: 300,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      provider: "youtube",
      text: "Video",
    }),
    item("note", 0, 400, {
      w: 300,
      h: 200,
      text: "Read the spec today",
      textRuns: [
        { start: 9, end: 13, style: { link: "https://example.com/spec" } },
      ],
    }),
  ];
  validateBoard(b);
  return b;
}

test("PDF pages keep web links clickable", async () => {
  const b = linkedBoard();
  for (const mode of ["raster", "vector"]) {
    const doc = await PDFDocument.load(
      await blobBytes(
        await exportPDF(b, exportRegions(b), "en", rasterizer, {
          mode,
          scale: "fit",
        }),
      ),
    );
    const [page] = doc.getPages(),
      { width, height } = page.getSize();
    const links = page.node
      .Annots()
      .asArray()
      .map((ref) => doc.context.lookup(ref))
      .filter((a) => a.get(PDFName.of("Subtype"))?.toString() === "/Link")
      .map((a) => ({
        url:
          a.get(PDFName.of("A")).get(PDFName.of("URI")).decodeText?.() ??
          Buffer.from(
            a.get(PDFName.of("A")).get(PDFName.of("URI")).asString(),
            "hex",
          ).toString("latin1"),
        rect: a
          .get(PDFName.of("Rect"))
          .asArray()
          .map((n) => n.asNumber()),
        quad: !!a.get(PDFName.of("QuadPoints")),
      }));
    assert.deepEqual(
      links.map((l) => l.url).sort(),
      [
        "https://example.com/a?b=1&c=(2",
        "https://example.com/spec",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      ],
      mode,
    );
    for (const { rect } of links) {
      assert.ok(rect[0] >= 0 && rect[2] <= width && rect[0] < rect[2]);
      assert.ok(rect[1] >= 0 && rect[3] <= height && rect[1] < rect[3]);
    }
    // Only the turned card is a quadrilateral; the word is narrower than
    // its note's card.
    assert.deepEqual(
      links.map((l) => l.quad),
      links.map((l) => l.url.includes("(2")),
    );
    const word = links.find((l) => l.url.endsWith("/spec")).rect,
      card = links.find((l) => l.url.includes("(2")).rect;
    assert.ok(word[2] - word[0] < (card[2] - card[0]) / 2);
  }
  // A region cutting the turned card keeps its link to the region, with no
  // quadrilateral reaching past it, which viewers would ignore.
  const cut = await PDFDocument.load(
    await blobBytes(
      await exportPDF(
        b,
        exportRegions(b, {
          scope: "selection",
          region: { x: 100, y: -100, w: 900, h: 800 },
        }),
        "en",
        rasterizer,
        { scale: "fit" },
      ),
    ),
  );
  const turned = cut
    .getPages()[0]
    .node.Annots()
    .asArray()
    .map((ref) => cut.context.lookup(ref))
    .find(
      (a) =>
        a.get(PDFName.of("A"))?.get(PDFName.of("URI")) &&
        Buffer.from(
          a.get(PDFName.of("A")).get(PDFName.of("URI")).asString(),
          "hex",
        )
          .toString("latin1")
          .includes("(2"),
    );
  assert.ok(turned, "The cut card keeps its link");
  assert.equal(turned.get(PDFName.of("QuadPoints")), undefined);
});

test("PDF overviews, page labels and bookmarks go to their pages", async () => {
  const pageLinks = (doc) => {
    const pages = doc.getPages(),
      number = new Map(pages.map((p, n) => [p.ref.toString(), n + 1]));
    return pages.map((page) =>
      (page.node.Annots()?.asArray() || [])
        .map((ref) => doc.context.lookup(ref))
        .filter((a) => a.get(PDFName.of("Dest")))
        .map((a) => number.get(a.get(PDFName.of("Dest")).get(0).toString())),
    );
  };
  // One large area: an overview, then a page per part reached.
  const wide = board("Wide");
  wide.items = Array.from({ length: 6 }, (_, n) =>
    item("note", n * 1100, 0, { text: `Part ${n}` }),
  );
  const plan = pdfPlan(exportRegions(wide), {});
  assert.equal(plan[0].kind, "overview");
  let doc = await PDFDocument.load(
    await blobBytes(
      await exportPDF(wide, exportRegions(wide), "en", rasterizer, {}),
    ),
  );
  const links = pageLinks(doc);
  // Each part on the overview goes to its page.
  assert.deepEqual(
    links[0].sort((p, q) => p - q),
    plan.slice(1).map((p) => p.index),
  );
  // Each part's page names its neighbours, and goes to them.
  for (const page of plan.slice(1))
    assert.deepEqual(
      links[page.index - 1].sort((p, q) => p - q),
      Object.values(page.neighbors)
        .filter(Boolean)
        .sort((p, q) => p - q),
    );
  // A single area has no bookmarks.
  assert.equal(doc.catalog.get(PDFName.of("Outlines")), undefined);
  // A web link on the overview lies over a part's link to its page, and
  // comes after it, as viewers take the last link under a click.
  wide.items.push(
    item("link", 0, 300, {
      w: 320,
      h: 115,
      url: "https://example.com/",
      text: "Example",
    }),
  );
  doc = await PDFDocument.load(
    await blobBytes(
      await exportPDF(wide, exportRegions(wide), "en", rasterizer, {}),
    ),
  );
  const kinds = doc
    .getPages()[0]
    .node.Annots()
    .asArray()
    .map((ref) =>
      doc.context.lookup(ref).get(PDFName.of("Dest")) ? "page" : "web",
    );
  assert.ok(kinds.includes("web"));
  assert.equal(kinds.indexOf("web"), kinds.lastIndexOf("page") + 1);
  // Without page boundaries and labels, nothing is drawn to click.
  doc = await PDFDocument.load(
    await blobBytes(
      await exportPDF(wide, exportRegions(wide), "en", rasterizer, {
        markers: false,
      }),
    ),
  );
  assert.deepEqual(pageLinks(doc).flat(), []);

  // Several frames are bookmarked by name at their first pages.
  const frames = board("Frames");
  frames.items = ["Ideas", "Plan", "Équipe"].map((text, n) =>
    item("frame", n * 900, 0, { w: 800, h: 600, text }),
  );
  doc = await PDFDocument.load(
    await blobBytes(
      await exportPDF(
        frames,
        exportRegions(frames, { scope: "frames" }),
        "en",
        rasterizer,
        { scale: "fit" },
      ),
    ),
  );
  const outline = doc.context.lookup(doc.catalog.get(PDFName.of("Outlines")));
  assert.equal(outline.get(PDFName.of("Count")).asNumber(), 3);
  const titles = [],
    targets = [],
    number = new Map(doc.getPages().map((p, n) => [p.ref.toString(), n + 1]));
  for (
    let entry = doc.context.lookup(outline.get(PDFName.of("First")));
    entry;
    entry = entry.get(PDFName.of("Next"))
      ? doc.context.lookup(entry.get(PDFName.of("Next")))
      : null
  ) {
    titles.push(entry.get(PDFName.of("Title")).decodeText());
    targets.push(number.get(entry.get(PDFName.of("Dest")).get(0).toString()));
  }
  assert.deepEqual(titles, ["Ideas", "Plan", "Équipe"]);
  assert.deepEqual(targets, [1, 2, 3]);
  assert.equal(
    doc.catalog.get(PDFName.of("PageMode")).toString(),
    "/UseOutlines",
  );
});

test("SVG exports keep web links clickable", () => {
  const b = linkedBoard(),
    svg = exportSVG(b, exportRegions(b)),
    doc = new JSDOM(svg, { contentType: "image/svg+xml" }).window.document;
  assert.equal(doc.querySelector("parsererror"), null);
  const links = [...doc.getElementsByTagName("a")].map((a) => ({
    href: a.getAttribute("href"),
    legacy: a.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
    title: a.querySelector("title").textContent,
    turned: a.querySelector("rect").hasAttribute("transform"),
  }));
  assert.deepEqual(links, [
    {
      href: "https://example.com/a?b=1&c=(2",
      legacy: "https://example.com/a?b=1&c=(2",
      title: "Example",
      turned: true,
    },
    {
      href: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      legacy: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Video",
      turned: false,
    },
    {
      href: "https://example.com/spec",
      legacy: "https://example.com/spec",
      title: "spec",
      turned: false,
    },
  ]);
  // Several frames keep each frame's links.
  const framed = board("Framed");
  const frame = item("frame", -50, -50, { w: 1000, h: 700, text: "All" });
  framed.items = [
    frame,
    ...linkedBoard().items.map((i) => ({ ...i, parentId: frame.id })),
    item("frame", 1200, 0, { w: 400, h: 300, text: "None" }),
  ];
  const many = exportSVG(framed, exportRegions(framed, { scope: "frames" }));
  assert.equal(many.match(/<a /g).length, 3);
});

test("PowerPoint slides keep web links clickable", async () => {
  const b = linkedBoard();
  const entries = readZip(
    await blobBytes(await exportPPTX(b, exportRegions(b), { rasterizer })),
  );
  const text = checkPackage(entries);
  const all = (node, name) => [...node.getElementsByTagNameNS("*", name)];
  const slide = parseXML(text("ppt/slides/slide1.xml")),
    relations = parseXML(text("ppt/slides/_rels/slide1.xml.rels"));
  const targets = new Map(
    all(relations, "Relationship").map((r) => [
      r.getAttribute("Id"),
      r.getAttribute("TargetMode") === "External" && r.getAttribute("Target"),
    ]),
  );
  const [picture] = all(slide, "pic"),
    [pictureBox] = all(picture, "off"),
    [pictureSize] = all(picture, "ext");
  const area = {
    x: +pictureBox.getAttribute("x"),
    y: +pictureBox.getAttribute("y"),
    w: +pictureSize.getAttribute("cx"),
    h: +pictureSize.getAttribute("cy"),
  };
  const links = all(slide, "hlinkClick").map((link) => {
    const shape = link.parentNode.parentNode.parentNode,
      [off] = all(shape, "off"),
      [ext] = all(shape, "ext"),
      [box] = all(shape, "xfrm");
    return {
      url: targets.get(link.getAttribute("r:id")),
      name: link.parentNode.getAttribute("descr"),
      x: +off.getAttribute("x"),
      y: +off.getAttribute("y"),
      w: +ext.getAttribute("cx"),
      h: +ext.getAttribute("cy"),
      rot: box.getAttribute("rot"),
      // Clear, yet taking clicks across the shape.
      clear: all(shape, "alpha")[0]?.getAttribute("val"),
    };
  });
  assert.deepEqual(
    links.map(({ url, name, rot, clear }) => ({ url, name, rot, clear })),
    [
      {
        url: "https://example.com/a?b=1&c=(2",
        name: "Example",
        rot: String(30 * 60000),
        clear: "0",
      },
      {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        name: "Video",
        rot: null,
        clear: "0",
      },
      {
        url: "https://example.com/spec",
        name: "spec",
        rot: null,
        clear: "0",
      },
    ],
  );
  // Unturned links lie on the board's picture.
  for (const l of links.filter((l) => !l.rot)) {
    assert.ok(l.x >= area.x - 1 && l.x + l.w <= area.x + area.w + 1);
    assert.ok(l.y >= area.y - 1 && l.y + l.h <= area.y + area.h + 1);
  }
  // Shape ids stay unique on the slide.
  const ids = all(slide, "cNvPr").map((c) => c.getAttribute("id"));
  assert.equal(new Set(ids).size, ids.length);
});

test("spreadsheet exports list the addresses of linked words", async () => {
  const b = linkedBoard();
  b.items[2].textRuns.push({
    start: 0,
    end: 4,
    style: { link: "https://example.com/read" },
  });
  const rows = spreadsheetModel(b, exportRegions(b))[0].rows,
    url = rows[0].indexOf("URL");
  const byText = new Map(rows.slice(1).map((row) => [row[1], row[url]]));
  assert.equal(byText.get("Example"), "https://example.com/a?b=1&c=(2");
  assert.equal(
    byText.get("Read the spec today"),
    "https://example.com/read\nhttps://example.com/spec",
  );
  // CSV quotes the line break inside the cell.
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    await blobBytes(exportCSV(b, exportRegions(b))),
  );
  assert.match(
    text,
    /,"https:\/\/example\.com\/read\nhttps:\/\/example\.com\/spec",/,
  );
});

test("long slide picture descriptions end at a word and say they go on", async () => {
  const b = board("Many notes");
  const frame = item("frame", 0, 0, { w: 1600, h: 900, text: "Wall" });
  b.items = [
    frame,
    ...Array.from({ length: 150 }, (_, n) =>
      item("note", 20 + (n % 15) * 100, 60 + Math.floor(n / 15) * 80, {
        w: 90,
        h: 70,
        text: `Note ${n} 😀`,
        parentId: frame.id,
      }),
    ),
  ];
  const entries = readZip(
    await blobBytes(
      await exportPPTX(b, exportRegions(b, { scope: "frames" }), {
        rasterizer,
      }),
    ),
  );
  const slide = parseXML(checkPackage(entries)("ppt/slides/slide1.xml")),
    descr = [...slide.getElementsByTagNameNS("*", "cNvPr")]
      .find((c) => c.parentNode.parentNode.localName === "pic")
      .getAttribute("descr");
  assert.ok(descr.length <= 1000, descr.length);
  assert.ok(descr.endsWith("…"));
  assert.ok(descr.isWellFormed());
  // The last word before the ellipsis is whole.
  assert.match(descr, /(😀|Note|\d+)…$/);
  assert.doesNotMatch(descr, /Not…$|No…$/);
});

test("PDF text in any script can be found, copied and read aloud", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const b = board("Scripts");
  const frame = item("frame", 0, 0, {
    w: 900,
    h: 600,
    text: "日本語のフレーム",
  });
  b.items = [
    frame,
    item("note", 60, 80, {
      text: "Привет мир и ελληνικά, café 👩‍💻",
      parentId: frame.id,
    }),
    item("note", 360, 80, { text: "Plain note", parentId: frame.id }),
    // More different characters than one of the text fonts holds.
    item("text", 0, 700, {
      w: 2000,
      text: Array.from({ length: 300 }, (_, n) =>
        String.fromCodePoint(0x4e00 + n),
      ).join(""),
    }),
  ];
  for (const mode of ["raster", "vector"]) {
    const doc = await pdfjs.getDocument({
      data: await blobBytes(
        await exportPDF(b, exportRegions(b), "en", rasterizer, {
          mode,
          scale: "fit",
          measure,
        }),
      ),
      disableFontFace: true,
      verbosity: 0,
    }).promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items
      .map((t) => t.str)
      .join("");
    for (const part of [
      "日本語のフレーム",
      "Привет",
      "ελληνικά",
      "café",
      "👩‍💻",
      "Plain note",
      String.fromCodePoint(0x4e00),
      String.fromCodePoint(0x4e00 + 299),
    ])
      assert.ok(text.includes(part), `${mode}: ${part}`);
    assert.doesNotMatch(text, /\ufffd/);
  }
});

test("SVG exports carry the font files their text uses", async () => {
  const b = board("Fonts");
  b.items = [
    item("note", 0, 0, { text: "Handwritten", fontFamily: "caveat" }),
    item("text", 0, 250, {
      w: 400,
      text: "Bold words",
      textRuns: [{ start: 0, end: 4, style: { bold: true } }],
    }),
  ];
  const fonts = new Map(
    [
      "Caveat|400|normal",
      "Caveat|600|normal",
      "DM Sans|400|normal",
      "DM Sans|600|normal",
      "DM Sans|400|italic",
      "EB Garamond|400|normal",
    ].map((key) => [key, `data:font/woff2;base64,${btoa(key)}`]),
  );
  const svg = exportSVG(b, exportRegions(b), { fonts });
  const faces = [
    ...svg.matchAll(
      /@font-face\{font-family:"([^"]+)";font-weight:(\d+);font-style:(\w+);src:url\(data:font\/woff2;base64,([^)]+)\)/g,
    ),
  ].map((m) => `${m[1]}|${m[2]}|${m[3]}`);
  // Only what is used, each once.
  assert.deepEqual(faces, [
    "Caveat|400|normal",
    "DM Sans|400|normal",
    "DM Sans|600|normal",
  ]);
  const doc = new JSDOM(svg, { contentType: "image/svg+xml" }).window.document;
  assert.equal(doc.querySelector("parsererror"), null);
  // Italic Caveat has no file of its own: the upright face goes, for the
  // viewer to slant as the canvas does; a weight without a file takes the
  // nearest.
  b.items = [
    item("note", 0, 0, {
      text: "Slanted",
      fontFamily: "caveat",
      textRuns: [{ start: 0, end: 7, style: { italic: true } }],
    }),
  ];
  const slanted = exportSVG(b, exportRegions(b), {
    fonts: new Map([
      ["Caveat|400|normal", "data:font/woff2;base64,AA=="],
      ["Caveat|600|normal", "data:font/woff2;base64,AQ=="],
      ["DM Sans|400|normal", "data:font/woff2;base64,Ag=="],
    ]),
  });
  assert.match(slanted, /font-style="italic"/);
  assert.deepEqual(
    [
      ...slanted.matchAll(
        /font-family:"([^"]+)";font-weight:(\d+);font-style:(\w+)/g,
      ),
    ].map((m) => m.slice(1).join("|")),
    ["Caveat|400|normal"],
  );
  // Without fonts to embed, the file only names them, as before.
  assert.doesNotMatch(exportSVG(b, exportRegions(b)), /@font-face|<style>/);
});

test("the font files for an SVG come from the page's own font faces", async () => {
  const { fontFiles } = await import("../src/svg-fonts.js");
  const dom = new JSDOM(
    `<style>
      @font-face { font-family: "Caveat"; font-weight: 400; font-style: normal; src: url(/fonts/caveat-400.woff2) format("woff2"), url(/fonts/caveat-400.woff) format("woff"); }
      @font-face { font-family: "DM Sans"; font-weight: 600; font-style: italic; src: url("/fonts/dm-600-italic.woff2") format("woff2"); }
      @font-face { font-family: "Other"; src: url(/fonts/other.woff2); }
    </style>`,
    { url: "https://whiteboard.test/board" },
  );
  const asked = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(url);
    if (url.includes("dm-600")) return { ok: false };
    return {
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
  };
  try {
    const files = await fontFiles(["Caveat", "DM Sans"], dom.window.document);
    assert.deepEqual(asked.sort(), [
      "https://whiteboard.test/fonts/caveat-400.woff2",
      "https://whiteboard.test/fonts/dm-600-italic.woff2",
    ]);
    // A file that could not be read is left out.
    assert.deepEqual(
      [...files],
      [["Caveat|400|normal", "data:font/woff2;base64,AQID"]],
    );
  } finally {
    globalThis.fetch = fetchBefore;
  }
});
