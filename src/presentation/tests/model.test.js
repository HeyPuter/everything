import { describe, it, expect } from "vitest";
import * as P from "../lib/pptx/src/index.ts";
import { createLargeDeck, withArchiveComment } from "./fixtures.js";
import { strToU8, unzipSync, zipSync } from "fflate";
import {
  P,
  createDeck,
  addDesignedSlide,
  History,
  parseDeck,
  restoreDeck,
  preview,
  cleanName,
  validateZip,
  THEMES,
  slideDescription,
  slideTitle,
  visibleSlideShapes,
  shape,
  text,
  shapeLabel,
  shapeIcon,
  slideBounds,
  setSlideBounds,
  slideRotation,
  ownRotation,
  pruneUnusedMedia,
  dedupeSlideMedia,
  relativePartName,
  resolvePartName,
  textRuns,
  setRichText,
  setParagraphIndentLevel,
  LEVEL_INDENTS,
  listOf,
  SOFT_BREAK,
} from "../src/model.js";
describe(".pptx interoperability", () => {
  it("omits hidden artwork and group descendants without changing the saved deck", async () => {
    const pres = createDeck();
    const s = P.getSlides(pres)[0];
    const addText = (value) =>
      P.addSlideTextBox(s, {
        x: P.inches(1),
        y: P.inches(1),
        w: P.inches(7),
        h: P.inches(1),
        text: value,
      });
    addText("Visible audience message");
    const hidden = addText("HiddenTextMarker");
    P.setShapeHidden(hidden, true);
    const child = addText("HiddenGroupMarker");
    const sibling = addText("HiddenSiblingMarker");
    const group = P.groupShapes([child, sibling]);
    P.setShapeHidden(group, true);
    const rectangle = shape(s, 1, 1, 2, 2, "#123abc");
    P.setShapeHidden(rectangle, true);
    const before = P.getSlideXmlString(s);
    const svg = decodeURIComponent(preview(pres, s));
    expect(svg).toContain("Visible audience message");
    expect(svg).not.toMatch(
      /HiddenTextMarker|HiddenGroupMarker|HiddenSiblingMarker|#123abc/,
    );
    expect(slideDescription(s)).toBe("Visible audience message");
    expect(visibleSlideShapes(s)).toHaveLength(1);
    expect(P.getSlideXmlString(s)).toBe(before);
    const loaded = await parseDeck(await P.savePresentation(pres));
    const restored = P.getSlides(loaded)[0];
    expect(P.getSlideText(restored)).toContain("HiddenTextMarker");
    expect(P.getSlideText(restored)).toContain("HiddenGroupMarker");
    expect(slideDescription(restored)).toBe("Visible audience message");
    P.setShapeHidden(
      P.getSlideShapes(restored).find((s) => P.getShapeKind(s) === "group"),
      false,
    );
    expect(slideDescription(restored)).toContain("HiddenGroupMarker");
    expect(decodeURIComponent(preview(loaded, restored))).toContain(
      "HiddenGroupMarker",
    );
    const titled = P.addTitleSlide(loaded, "Visible title");
    expect(slideTitle(titled)).toBe("Visible title");
    P.setShapeHidden(
      P.findSlidePlaceholder(titled, "title") ||
        P.findSlidePlaceholder(titled, "ctrTitle"),
      true,
    );
    expect(slideTitle(titled)).toBe(null);
  });
  it.each(Object.keys(THEMES))(
    "round-trips the %s template with formatting and notes",
    async (theme) => {
      const pres = createDeck("story", theme);
      const slides = P.getSlides(pres);
      P.setSlideNotes(slides[1], "A private speaker note.\nSecond line.");
      const before = P.getSlideText(slides[0]);
      const bytes = await P.savePresentation(pres);
      expect(bytes[0]).toBe(0x50);
      expect(bytes[1]).toBe(0x4b);
      const loaded = await parseDeck(bytes);
      expect(P.getSlides(loaded)).toHaveLength(5);
      expect(P.getSlideText(P.getSlides(loaded)[0])).toBe(before);
      expect(P.getSlideNotes(P.getSlides(loaded)[1])).toContain(
        "A private speaker note.",
      );
      expect(
        P.getSlideBackground(P.getSlides(loaded)[0]).color.toLowerCase(),
      ).toBe(THEMES[theme].bg);
      expect(
        P.validatePresentation(loaded).filter((i) => i.severity === "error"),
      ).toEqual([]);
    },
  );
  it("preserves imported charts through text edits and export", async () => {
    const pres = createDeck("story");
    const s = P.getSlides(pres)[1];
    P.addSlideChart(s, {
      x: P.inches(1),
      y: P.inches(1),
      w: P.inches(4),
      h: P.inches(3),
      spec: {
        kind: "column",
        categories: ["A", "B"],
        series: [{ name: "Revenue", values: [10, 20] }],
      },
    });
    const imported = await parseDeck(await P.savePresentation(pres));
    P.setShapeText(
      P.getSlideShapes(P.getSlides(imported)[0])[1],
      "Changed title",
    );
    const loaded = await parseDeck(await P.savePresentation(imported));
    expect(P.getSlideCharts(P.getSlides(loaded)[1])).toHaveLength(1);
    expect(P.getSlideText(P.getSlides(loaded)[0])).toContain("Changed title");
    expect(
      P.validatePresentation(loaded).filter((i) => i.severity === "error"),
    ).toEqual([]);
  });
  it("duplicates, reorders, and deletes slides without dangling relationships", async () => {
    const pres = createDeck("story");
    const copy = P.duplicateSlide(pres, P.getSlides(pres)[0]);
    P.moveSlide(pres, copy, 1);
    P.removeSlide(pres, P.getSlides(pres)[3]);
    const loaded = await parseDeck(await P.savePresentation(pres));
    expect(P.getSlides(loaded)).toHaveLength(5);
    expect(P.getSlideText(P.getSlides(loaded)[0])).toBe(
      P.getSlideText(P.getSlides(loaded)[1]),
    );
    expect(
      P.validatePresentation(loaded).filter((i) => i.severity === "error"),
    ).toEqual([]);
  });
  it("resolves the inherited format of an empty placeholder", async () => {
    // An untouched subtitle placeholder is saved in .pptx files as a
    // paragraph without runs, so the format comes from the layout and master.
    const pres = P.createPresentation();
    const slide = P.addTitleSlide(pres, "Hello", "");
    const subtitle = P.getSlideShapes(slide)[1];
    expect(P.getShapeRunCount(subtitle, 0)).toBe(0);
    expect(P.getShapeRunFormatEffective(pres, subtitle, 0, 0)).toMatchObject({
      font: "Calibri",
      size: 24,
    });
    expect(shapeIcon(subtitle)).toBe("Type");
    const loaded = await parseDeck(await P.savePresentation(pres));
    const reloaded = P.getSlideShapes(P.getSlides(loaded)[0])[1];
    expect(P.getShapeRunFormatEffective(loaded, reloaded, 0, 0)).toMatchObject({
      size: 24,
    });
    expect(() => P.getShapeRunFormatEffective(loaded, reloaded, 0, 1)).toThrow(
      RangeError,
    );
  });
  it("escapes untrusted text in image previews", () => {
    const p = createDeck();
    const s = P.getSlides(p)[0];
    P.addSlideTextBox(s, {
      x: 0,
      y: 0,
      w: P.inches(8),
      h: P.inches(1),
      text: '<script>alert("unsafe")</script>',
    });
    const svg = decodeURIComponent(preview(p, s).split(",")[1]);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });
});
describe("undo history", () => {
  it("folds amended snapshots into the latest undo step", async () => {
    const pres = createDeck("story");
    const panel = () =>
      P.getShapeFillColor(P.getSlideShapes(P.getSlides(pres)[0])[3]);
    const fillOf = (deck) =>
      P.getShapeFillColor(P.getSlideShapes(P.getSlides(deck)[0])[3]);
    const h = new History();
    await h.reset(pres, "studio");
    const original = panel();
    P.setShapeFill(P.getSlideShapes(P.getSlides(pres)[0])[3], "#111111");
    await h.capture(pres);
    P.setShapeFill(P.getSlideShapes(P.getSlides(pres)[0])[3], "#222222");
    await h.amend(pres);
    P.setShapeFill(P.getSlideShapes(P.getSlides(pres)[0])[3], "#333333");
    await h.amend(pres, "clay");
    expect(h.past).toHaveLength(1);
    expect(h.state).toBe("clay");
    expect(fillOf(await h.undo())).toBe(original);
    expect(h.state).toBe("studio");
    expect(fillOf(await h.redo()).toLowerCase()).toBe("#333333");
    expect(h.state).toBe("clay");
    // Without an earlier snapshot an amendment is an ordinary capture.
    const fresh = new History();
    await fresh.reset(pres, "clay");
    P.setShapeFill(P.getSlideShapes(P.getSlides(pres)[0])[3], "#444444");
    await fresh.amend(pres);
    expect(fresh.past).toHaveLength(1);
    expect(fillOf(await fresh.undo()).toLowerCase()).toBe("#333333");
  });
  it("restores locally generated history larger than the import limit", async () => {
    const pres = createLargeDeck();
    const slide = P.getSlides(pres)[0];
    const history = new History();
    await history.reset(pres, "studio");
    const originalNotes = P.getSlideNotes(slide);
    expect(history.bytes.byteLength).toBeGreaterThan(40 * 1024 * 1024);
    await expect(parseDeck(history.bytes)).rejects.toThrow("40 MB");
    P.setSlideNotes(slide, "New notes");
    await history.capture(pres, "clay");
    const undone = await history.undo();
    expect(P.getSlideNotes(P.getSlides(undone)[0])).toBe(originalNotes);
    expect(P.getSlideShapes(P.getSlides(undone)[0])).toHaveLength(4);
    expect(history.state).toBe("studio");
    const redone = await history.redo();
    expect(P.getSlideNotes(P.getSlides(redone)[0])).toBe("New notes");
    expect(history.state).toBe("clay");
  }, 15000);
  it("restores text and discards a redo branch after new edits", async () => {
    const pres = createDeck("story");
    const h = new History(3);
    await h.reset(pres, "studio");
    const s = P.getSlideShapes(P.getSlides(pres)[0])[1];
    const original = P.getShapeText(s);
    P.setShapeText(s, "Edit one");
    await h.capture(pres, "clay");
    P.setShapeText(s, "Edit two");
    await h.capture(pres, "midnight");
    let restored = await h.undo();
    expect(h.state).toBe("clay");
    expect(P.getSlideText(P.getSlides(restored)[0])).toContain("Edit one");
    restored = await h.undo();
    expect(h.state).toBe("studio");
    expect(P.getSlideText(P.getSlides(restored)[0])).toContain(original);
    restored = await h.redo();
    expect(h.state).toBe("clay");
    expect(P.getSlideText(P.getSlides(restored)[0])).toContain("Edit one");
    P.setShapeText(
      P.getSlideShapes(P.getSlides(restored)[0])[1],
      "A new branch",
    );
    await h.capture(restored);
    expect(h.state).toBe("clay");
    expect(await h.redo()).toBeNull();
  });
});
describe("file validation", () => {
  it("reports damaged recovery bytes with an actionable error", async () => {
    await expect(restoreDeck(new Uint8Array())).rejects.toThrow(
      "This PPTX file is damaged",
    );
  });
  it("explains when an archive is not a presentation package", async () => {
    const relationships =
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const document = zipSync({
      "[Content_Types].xml": strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "_rels/.rels": strToU8(relationships),
      "word/document.xml": strToU8(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
      ),
    });
    await expect(parseDeck(document)).rejects.toThrow(
      "could not be opened as a PowerPoint presentation",
    );
    await expect(
      parseDeck(zipSync({ "notes.txt": strToU8("Not a presentation") })),
    ).rejects.toThrow("could not be opened as a PowerPoint presentation");
    await expect(
      parseDeck(zipSync({ "[Content_Types].xml": strToU8("<<<") })),
    ).rejects.toThrow("could not be opened as a PowerPoint presentation");
  });
  it("opens decks that carry [trash] leftovers and drops them on save", async () => {
    const pres = createDeck("story");
    const entries = unzipSync(await P.savePresentation(pres));
    // Some writers keep deleted parts under [trash] with no content type.
    entries["[trash]/0000.dat"] = new Uint8Array(2868).fill(7);
    const loaded = await parseDeck(zipSync(entries));
    expect(P.getSlides(loaded).map(P.getSlideText)).toEqual(
      P.getSlides(pres).map(P.getSlideText),
    );
    expect(
      Object.keys(unzipSync(await P.savePresentation(loaded))).some((name) =>
        /trash/i.test(name),
      ),
    ).toBe(false);
    // Any other part without a content type is still a damaged package.
    delete entries["[trash]/0000.dat"];
    entries["extra/0000.dat"] = new Uint8Array(8);
    await expect(parseDeck(zipSync(entries))).rejects.toThrow(
      "could not be opened as a PowerPoint presentation",
    );
  });
  it("preserves large deflated parts whose declared sizes are correct", async () => {
    const pres = createDeck();
    const notes = "A".repeat(1024 * 1024);
    P.setSlideNotes(P.getSlides(pres)[0], notes);
    const loaded = await parseDeck(await P.savePresentation(pres));
    expect(P.getSlideNotes(P.getSlides(loaded)[0])).toBe(notes);
  });
  it.each([0, 1, 2048, "oversized"])(
    "rejects deflated entries with a false decompressed size of %s",
    async (size) => {
      const pres = createDeck();
      P.setSlideNotes(P.getSlides(pres)[0], "A".repeat(1024 * 1024));
      const bytes = await P.savePresentation(pres);
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      let cursor = view.getUint32(bytes.length - 22 + 16, true);
      let changed = false;
      for (let i = 0; i < view.getUint16(bytes.length - 22 + 10, true); i++) {
        const length = view.getUint16(cursor + 28, true);
        const name = new TextDecoder().decode(
          bytes.subarray(cursor + 46, cursor + 46 + length),
        );
        if (name === "ppt/notesSlides/notesSlide1.xml") {
          expect(view.getUint16(cursor + 10, true)).toBe(8);
          const declared = view.getUint32(cursor + 24, true);
          view.setUint32(
            cursor + 24,
            size === "oversized" ? declared + 1 : size,
            true,
          );
          changed = true;
        }
        cursor +=
          46 +
          length +
          view.getUint16(cursor + 30, true) +
          view.getUint16(cursor + 32, true);
      }
      expect(changed).toBe(true);
      await expect(parseDeck(bytes)).rejects.toThrow(
        "This PPTX file is damaged",
      );
    },
  );
  it.each([32, 65535])(
    "imports archive comments containing end signatures (%s bytes)",
    async (length) => {
      const original = createDeck("story");
      const bytes = withArchiveComment(
        await P.savePresentation(original),
        length,
      );
      expect(() => validateZip(bytes)).not.toThrow();
      const loaded = await parseDeck(bytes);
      expect(P.getSlides(loaded).map(P.getSlideText)).toEqual(
        P.getSlides(original).map(P.getSlideText),
      );
    },
  );
  it.each([0, 1, 65535])(
    "imports ordinary archive comments (%s bytes)",
    async (length) => {
      const bytes = withArchiveComment(
        await P.savePresentation(createDeck("story")),
        length,
        false,
      );
      expect(P.getSlides(await parseDeck(bytes))).toHaveLength(5);
    },
  );
  it.each([-1, 1])(
    "rejects an archive comment with a length mismatch of %s",
    async (delta) => {
      const original = await P.savePresentation(createDeck());
      const bytes = withArchiveComment(original, 32, false);
      new DataView(bytes.buffer).setUint16(
        original.length - 2,
        32 + delta,
        true,
      );
      await expect(parseDeck(bytes)).rejects.toThrow("valid PPTX");
    },
  );
  it("rejects invalid archives", async () => {
    await expect(parseDeck(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      "valid PPTX",
    );
  });
  it("rejects oversized decompressed archives before decompression", async () => {
    const bytes = await P.savePresentation(createDeck("story"));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < bytes.length - 46; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 250 * 1024 * 1024, true);
        break;
      }
    }
    expect(() => validateZip(bytes)).toThrow("200 MB");
    await expect(parseDeck(withArchiveComment(bytes, 32))).rejects.toThrow(
      "200 MB",
    );
  });
  it("rejects entry counts that disagree with the decompressor", async () => {
    const bytes = await P.savePresentation(createDeck());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(bytes.length - 22 + 10, 0, true);
    // The parser reads the per-disk count at +8, not the total at +10.
    expect(P.getSlides(await P.loadPresentation(bytes))).toHaveLength(1);
    expect(() => validateZip(bytes)).toThrow();
  });
  it("rejects a ZIP64 locator instead of validating the legacy directory", async () => {
    const original = await P.savePresentation(createDeck());
    const end = original.length - 22;
    const bytes = new Uint8Array(original.length + 20);
    bytes.set(original.subarray(0, end));
    bytes.set(original.subarray(end), end + 20);
    new DataView(bytes.buffer).setUint32(end, 0x07064b50, true);
    expect(() => validateZip(bytes)).toThrow();
  });
  it("rejects directory records extending past their declared boundary", async () => {
    const bytes = await P.savePresentation(createDeck());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(bytes.length - 22 + 12, 1, true);
    expect(() => validateZip(bytes)).toThrow();
  });
  it("rejects stored entries whose declared expanded size understates their data", async () => {
    const pres = createDeck();
    const png = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    P.addSlideImage(P.getSlides(pres)[0], png, {
      x: 0,
      y: 0,
      w: P.inches(1),
      h: P.inches(1),
    });
    const bytes = await P.savePresentation(pres);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let cursor = view.getUint32(bytes.length - 22 + 16, true);
    let changed = false;
    while (view.getUint32(cursor, true) === 0x02014b50) {
      if (
        view.getUint16(cursor + 10, true) === 0 &&
        view.getUint32(cursor + 20, true) > 0
      ) {
        view.setUint32(cursor + 24, 0, true);
        changed = true;
        break;
      }
      cursor +=
        46 +
        view.getUint16(cursor + 28, true) +
        view.getUint16(cursor + 30, true) +
        view.getUint16(cursor + 32, true);
    }
    expect(changed).toBe(true);
    const loaded = await P.loadPresentation(bytes);
    expect(
      P.getShapeImageBytes(P.getSlideShapes(P.getSlides(loaded)[0])[0]),
    ).toEqual(png);
    expect(() => validateZip(bytes)).toThrow();
  });
  it("normalizes file names without allowing path traversal", () => {
    expect(cleanName("../a\\b\u0000.pptx")).toBe(".. a b");
    expect(cleanName("")).toBe("Untitled presentation");
    expect(cleanName("x".repeat(250))).toHaveLength(180);
  });
  it("can sanitize an existing title without removing another extension", () => {
    expect(cleanName("Plan.pptx.pptx")).toBe("Plan.pptx");
    expect(cleanName("Plan.pptx", { stripExtension: false })).toBe("Plan.pptx");
    expect(
      cleanName("../Plan\\draft\u0000.pptx", { stripExtension: false }),
    ).toBe(".. Plan draft .pptx");
    expect(cleanName("", { stripExtension: false })).toBe(
      "Untitled presentation",
    );
  });
  it("preserves storage-assigned suffixes when reading existing file names", () => {
    const name = "x".repeat(180) + " (1)";
    expect(cleanName(name + ".pptx", { maxLength: Infinity })).toBe(name);
    expect(cleanName(name + ".pptx")).toBe("x".repeat(180));
  });
  it.each(["😀", "𝄞"])("truncates names without splitting %s", (character) => {
    const fitting = "x".repeat(178) + character;
    expect(cleanName(fitting + ".pptx")).toBe(fitting);
    const truncated = cleanName("x".repeat(179) + character + ".pptx");
    expect(truncated).toBe("x".repeat(179));
    expect(() => encodeURIComponent(truncated)).not.toThrow();
  });
  it.each([
    [179, " rest"],
    [179, "\u00a0rest"],
    [179, "/rest"],
    [178, " 😀"],
  ])("trims whitespace exposed by truncation (%i, %s)", (length, suffix) => {
    const prefix = "x".repeat(length);
    const name = cleanName(prefix + suffix + ".pptx");
    expect(name).toBe(prefix);
    expect(cleanName(name)).toBe(name);
  });
});

describe("object labels", () => {
  it("names geometry readably and keeps text and image labels", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const rect = shape(slide, 1, 1, 2, 1, "#ff0000");
    const circle = shape(slide, 1, 1, 2, 2, "#00ff00", "ellipse");
    const box = text(slide, "Hello there", 1, 1, 2, 1);
    const image = P.addSlideImage(
      slide,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
        "base64",
      ),
      { x: 0, y: 0, w: P.inches(1), h: P.inches(1) },
    );
    expect(P.getShapeName(rect)).toBe(`Rectangle ${P.getShapeId(rect)}`);
    expect(shapeLabel(rect)).toBe(`Rectangle ${P.getShapeId(rect)}`);
    expect(shapeLabel(circle)).toBe(`Circle ${P.getShapeId(circle)}`);
    expect(shapeLabel(box)).toBe("Hello there");
    expect(shapeLabel(image)).toBe("Image");
    P.setShapeDescription(image, "Team photo");
    expect(shapeLabel(image)).toBe("Image: Team photo");
    // Generated names from decks saved by earlier versions. Handles created
    // before later insertions keep stale snapshots, so look them up again.
    const fresh = (obj) => P.findShapeById(slide, P.getShapeId(obj));
    P.renameShape(fresh(rect), "rect 42");
    P.renameShape(fresh(circle), "ellipse 7");
    expect(shapeLabel(fresh(rect))).toBe("Rectangle 42");
    expect(shapeLabel(fresh(circle))).toBe("Circle 7");
    P.renameShape(fresh(rect), "Callout 3");
    expect(shapeLabel(fresh(rect))).toBe("Callout 3");
    expect(shapeIcon(rect)).toBe("Square");
    expect(shapeIcon(circle)).toBe("Circle");
    expect(shapeIcon(box)).toBe("Type");
    expect(shapeIcon(image)).toBe("Image");
  });
});
it("gives a copied group's children ids of their own", async () => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const group = P.groupShapes(
    [
      shape(slide, 1, 1, 2, 1, "#ff0000"),
      P.groupShapes([
        shape(slide, 4, 1, 2, 1, "#00ff00", "ellipse"),
        text(slide, "Nested", 4, 2.5, 2, 1),
      ]),
    ],
    { name: "Pair" },
  );
  const copy = P.copyShape(slide, group);
  const ids = P.getSlideShapes(slide).map(P.getShapeId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(P.getShapeKind(copy)).toBe("group");
  expect(P.getGroupChildren(copy)).toHaveLength(2);
  expect(P.validatePresentation(pres)).toEqual([]);
  // The copy edits independently of the original.
  const nested = P.getGroupChildren(P.getGroupChildren(copy)[1]);
  P.setShapeText(nested[1], "Changed");
  expect(P.getShapeText(P.findShapeById(slide, P.getShapeId(nested[1])))).toBe(
    "Changed",
  );
  expect(P.findShapeByText(slide, "Nested")).not.toBeNull();
  const saved = await parseDeck(await P.savePresentation(pres));
  expect(P.validatePresentation(saved)).toEqual([]);
});
describe("deleted media", () => {
  it("drops the image parts deleted pictures and slides leave behind while keeping shared ones", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
      "base64",
    );
    const box = { x: 0, y: 0, w: P.inches(1), h: P.inches(1) };
    const media = async () =>
      Object.keys(unzipSync(await P.savePresentation(pres)))
        .filter((entry) => entry.startsWith("ppt/media/"))
        .sort();
    const pres = createDeck("blank");
    const [first] = P.getSlides(pres);
    const second = P.addBlankSlide(pres);
    const third = P.addBlankSlide(pres);
    const alone = P.addSlideImage(first, png, box);
    const shared = P.addSlideImage(first, png, box);
    P.copyShape(second, shared);
    P.addSlideImage(third, png, box);
    expect(await media()).toEqual([
      "ppt/media/image1.png",
      "ppt/media/image2.png",
      "ppt/media/image3.png",
    ]);
    const fresh = (slide, obj) => P.findShapeById(slide, P.getShapeId(obj));
    // Removing a picture alone does not shrink the file.
    P.removeShape(fresh(first, alone));
    expect(await media()).toHaveLength(3);
    expect(pruneUnusedMedia(pres, first)).toEqual(["/ppt/media/image1.png"]);
    // An image another slide still shows stays.
    P.removeShape(fresh(first, shared));
    expect(pruneUnusedMedia(pres, first)).toEqual([]);
    expect(await media()).toEqual([
      "ppt/media/image2.png",
      "ppt/media/image3.png",
    ]);
    P.removeSlide(pres, third);
    expect(pruneUnusedMedia(pres)).toEqual(["/ppt/media/image3.png"]);
    expect(await media()).toEqual(["ppt/media/image2.png"]);
    const saved = await parseDeck(await P.savePresentation(pres));
    expect(P.validatePresentation(saved)).toEqual([]);
    const picture = P.getSlideShapes(P.getSlides(saved)[1])[0];
    expect(P.getShapeKind(picture)).toBe("picture");
    expect(P.getShapeImageBytes(picture)).toEqual(new Uint8Array(png));
    expect(decodeURIComponent(preview(saved, P.getSlides(saved)[1]))).toContain(
      "data:image/png;base64,",
    );
  });
});
describe("grouped shapes", () => {
  // Effective rectangles from a render, following the renderer's own
  // translate/scale groups.
  function renderedRects(svg) {
    const stack = [{ tx: 0, ty: 0, sx: 1, sy: 1 }];
    const rects = [];
    for (const [tag] of svg.matchAll(/<g\b[^>]*>|<\/g>|<rect\b[^>]*\/?>/g)) {
      if (tag === "</g>") stack.pop();
      else if (tag.startsWith("<g")) {
        const parent = stack.at(-1);
        const t = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(tag);
        const sc = /scale\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(tag);
        const [tx, ty] = t ? [Number(t[1]), Number(t[2])] : [0, 0];
        const [sx, sy] = sc ? [Number(sc[1]), Number(sc[2])] : [1, 1];
        stack.push({
          tx: parent.tx + tx * parent.sx,
          ty: parent.ty + ty * parent.sy,
          sx: parent.sx * sx,
          sy: parent.sy * sy,
        });
      } else {
        const attr = (name) =>
          Number(new RegExp(`\\b${name}="([-\\d.]+)"`).exec(tag)?.[1]);
        const t = stack.at(-1);
        rects.push({
          fill: /fill="([^"]+)"/.exec(tag)?.[1],
          x: t.tx + attr("x") * t.sx,
          y: t.ty + attr("y") * t.sy,
          w: attr("width") * t.sx,
          h: attr("height") * t.sy,
        });
      }
    }
    return rects;
  }
  it("projects grouped bounds onto the slide the way the renderer does", async () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const plain = shape(slide, 8, 5, 2, 1, "#00ff00");
    const a = shape(slide, 1, 1, 2, 1, "#ff0000");
    const b = shape(slide, 3.5, 1, 2, 1, "#0000ff");
    const inner = P.groupShapes([b, text(slide, "Nested", 3.5, 2.5, 2, 1)]);
    const outer = P.groupShapes([a, inner], { name: "Pair" });
    // A resized group is stored as a scale over its children's
    // coordinates: the children keep their numbers, the group's outer box
    // changes. Scale the outer group twice and the nested one by half again.
    const ob = P.getShapeBounds(outer);
    P.setShapeBounds(outer, {
      x: P.inches(2),
      y: P.inches(2),
      w: ob.w * 2,
      h: ob.h * 2,
    });
    const ib = P.getShapeBounds(inner);
    P.setShapeBounds(inner, { ...ib, w: ib.w * 1.5, h: ib.h * 1.5 });
    const fresh = (obj) => P.findShapeById(slide, P.getShapeId(obj));
    const expectBounds = (obj, [x, y, w, h]) => {
      const bounds = slideBounds(pres, fresh(obj));
      for (const [key, inches] of Object.entries({ x, y, w, h }))
        expect(bounds[key], key).toBeCloseTo(P.inches(inches), -1);
    };
    expectBounds(plain, [8, 5, 2, 1]);
    expectBounds(outer, [2, 2, 9, 5]);
    expectBounds(a, [2, 2, 4, 2]);
    expectBounds(inner, [7, 2, 6, 7.5]);
    expectBounds(b, [7, 2, 6, 3]);
    // The renderer agrees on where the rectangles land.
    const svg = decodeURIComponent(
      preview(pres, slide).replace(/^data:image\/svg\+xml;charset=utf-8,/, ""),
    );
    const pxPerEmu =
      Number(/viewBox="0 0 ([\d.]+)/.exec(svg)[1]) / P.getSlideSize(pres).width;
    for (const [obj, fill] of [
      [plain, "#00FF00"],
      [a, "#FF0000"],
      [b, "#0000FF"],
    ]) {
      const drawn = renderedRects(svg).find((rect) => rect.fill === fill);
      const bounds = slideBounds(pres, fresh(obj));
      for (const key of ["x", "y", "w", "h"])
        expect(drawn[key], `${fill} ${key}`).toBeCloseTo(
          bounds[key] * pxPerEmu,
          0,
        );
    }
    // Writing slide coordinates lands the shape where it was asked to go
    // and leaves the group's own frame alone.
    setSlideBounds(pres, fresh(b), {
      x: P.inches(7.5),
      y: P.inches(2.25),
      w: P.inches(3),
      h: P.inches(1.5),
    });
    expectBounds(b, [7.5, 2.25, 3, 1.5]);
    expect(P.getShapeBounds(fresh(b))).toEqual({
      x: P.inches(3.5) + P.inches(0.5) / 3,
      y: P.inches(1) + P.inches(0.25) / 3,
      w: P.inches(1),
      h: P.inches(0.5),
    });
    expect(P.getGroupTransform(fresh(outer))).toEqual(
      P.getGroupTransform(outer),
    );
    setSlideBounds(pres, fresh(plain), {
      x: P.inches(8.5),
      y: P.inches(5),
      w: P.inches(2),
      h: P.inches(1),
    });
    expect(P.getShapeBounds(fresh(plain))).toEqual({
      x: P.inches(8.5),
      y: P.inches(5),
      w: P.inches(2),
      h: P.inches(1),
    });
    const saved = await parseDeck(await P.savePresentation(pres));
    expect(P.validatePresentation(saved)).toEqual([]);
  });
});
it("adapts added template slides to an imported 4:3 canvas", () => {
  const pres = P.createPresentation({ size: "4:3" });
  const slide = addDesignedSlide(pres, "columns");
  const size = P.getSlideSize(pres);
  for (const obj of P.getSlideShapes(slide)) {
    const b = P.getShapeBounds(obj);
    expect(b.x + b.w).toBeLessThanOrEqual(size.width);
    expect(b.y + b.h).toBeLessThanOrEqual(size.height);
  }
});

it.each(Object.keys(THEMES))(
  "keeps every section-slide label readable in %s",
  async (theme) => {
    const luminance = (color) =>
      color
        .replace("#", "")
        .match(/../g)
        .map((c) => parseInt(c, 16) / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const pres = await parseDeck(
      await P.savePresentation(createDeck("story", theme)),
    );
    const section = P.getSlides(pres).at(-1);
    const background = luminance(P.getSlideBackground(section).color);
    for (const obj of P.getSlideShapes(section)) {
      const foreground = luminance(P.getShapeRunFormat(obj, 0, 0).color);
      const contrast =
        (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05);
      expect(contrast, P.getShapeText(obj)).toBeGreaterThanOrEqual(4.5);
    }
  },
);

describe("pasted media", () => {
  it("points a slide's relationships at one copy of identical picture bytes", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
      "base64",
    );
    const other = Buffer.concat([png, Buffer.from([1])]);
    const pres = createDeck();
    const slide = P.getSlides(pres)[0];
    const box = { x: 0, y: 0, w: P.inches(1), h: P.inches(1) };
    const picture = P.addSlideImage(slide, png, box);
    P.addSlideImage(slide, other, box);
    // A paste imports the copied slide from another package, which brings
    // the picture along as a new media part each time.
    const held = P.createPresentation();
    const source = P.importSlide(held, slide, P.getSlideLayouts(held)[0]);
    for (let i = 0; i < 2; i++) {
      const temp = P.importSlide(pres, source, P.getSlideLayout(slide));
      P.copyShape(slide, P.findShapeById(temp, P.getShapeId(picture)));
      P.removeSlide(pres, temp);
      P.compactPackage(pres);
    }
    expect(P.getMediaParts(pres)).toHaveLength(4);
    expect(dedupeSlideMedia(pres, slide)).toBe(2);
    expect(P.getMediaParts(pres)).toHaveLength(2);
    const loaded = await parseDeck(await P.savePresentation(pres));
    const pictures = P.getSlideShapes(P.getSlides(loaded)[0]).filter(
      (shape) => P.getShapeKind(shape) === "picture",
    );
    expect(pictures).toHaveLength(4);
    expect(
      pictures.map((shape) =>
        Buffer.from(P.getShapeImageBytes(shape)).equals(png) ? "a" : "b",
      ),
    ).toEqual(["a", "b", "a", "a"]);
    expect(dedupeSlideMedia(loaded, P.getSlides(loaded)[0])).toBe(0);
  });
  it("writes relative part targets the way the package does", () => {
    expect(
      relativePartName("/ppt/slides/slide1.xml", "/ppt/media/image1.png"),
    ).toBe("../media/image1.png");
    expect(
      resolvePartName("/ppt/slides/slide1.xml", "../media/image1.png"),
    ).toBe("/ppt/media/image1.png");
    expect(
      relativePartName("/ppt/slides/slide1.xml", "/ppt/slides/slide2.xml"),
    ).toBe("slide2.xml");
  });
});

describe("formatted runs", () => {
  it("reads runs with their formats and writes mixed runs back", async () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const box = text(slide, "Hello world\nSecond", 1, 1, 5, 1, 20, "#202420");
    const before = textRuns(pres, box);
    expect(before.map((p) => p.runs.map((r) => r.text))).toEqual([
      ["Hello world"],
      ["Second"],
    ]);
    expect(before[0].runs[0].format).toMatchObject({ size: 20, font: "Arial" });
    expect(before[0].runs[0].rpr?.name.localName).toBe("rPr");
    // Split the first paragraph into three runs, the middle one bold and red,
    // and give the second paragraph an italic word.
    const [a] = before[0].runs;
    const copy = (run, text, changes = {}) => ({
      ...run,
      text,
      format: { ...run.format, ...changes },
      changes,
    });
    setRichText(box, [
      {
        runs: [
          copy(a, "Hello "),
          copy(a, "big", { bold: true, color: "#CC0000" }),
          copy(a, " world"),
        ],
      },
      { runs: [copy(before[1].runs[0], "Second", { italic: true })] },
      { runs: [] },
    ]);
    expect(P.getShapeText(box)).toBe("Hello big world\nSecond\n");
    expect(P.getShapeParagraphCount(box)).toBe(3);
    const runs = P.getShapeParagraphElements(box, 0);
    expect(runs.map((r) => r.text)).toEqual(["Hello ", "big", " world"]);
    expect(runs[1].format).toMatchObject({ bold: true, color: "#CC0000" });
    expect(runs[0].format.bold).toBeFalsy();
    expect(runs[2].format.color).toBe("#202420");
    expect(P.getShapeParagraphElements(box, 1)[0].format.italic).toBe(true);
    // The runs survive a save and load, and read back split as written.
    const loaded = await parseDeck(await P.savePresentation(pres));
    const shape = P.getSlideShapes(P.getSlides(loaded)[0])[0];
    const after = textRuns(loaded, shape);
    expect(after[0].runs.map((r) => r.text)).toEqual([
      "Hello ",
      "big",
      " world",
    ]);
    expect(after[0].runs[1].format).toMatchObject({ bold: true });
    // The rendered slide shows the bold red run.
    const svg = decodeURIComponent(
      preview(loaded, P.getSlides(loaded)[0]).split(",")[1],
    );
    expect(svg).toMatch(/CC0000/i);
    expect(svg).toMatch(
      /font-weight="bold"|font-weight:bold|font-weight="700"/,
    );
  });
  it("keeps a line break inside a paragraph as a newline and preserves untouched run properties", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const box = text(slide, "One", 1, 1, 5, 1, 20);
    P.setShapeRunFormat(box, 0, 0, { underline: true });
    const [paragraph] = textRuns(pres, box);
    expect(paragraph.runs[0].format.underline).toBeTruthy();
    // Writing the run back unchanged keeps its underline through the cloned
    // properties, without any change recorded.
    setRichText(box, [{ runs: [{ ...paragraph.runs[0], text: "One more" }] }]);
    expect(P.getShapeText(box)).toBe("One more");
    expect(P.getShapeRunFormat(box, 0, 0).underline).toBeTruthy();
    expect(P.getShapeRunCount(box, 0)).toBe(1);
  });
});

describe("paragraph levels", () => {
  it("steps list paragraphs in by the level indents and keeps levels through a rewrite", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const box = text(slide, "One\nTwo\nThree", 1, 1, 6, 3, 20);
    P.setShapeBullets(box, "bullet");
    setParagraphIndentLevel(box, 1, 1, true);
    setParagraphIndentLevel(box, 2, 2, true);
    expect([0, 1, 2].map((i) => P.getParagraphLevel(box, i))).toEqual([
      0, 1, 2,
    ]);
    expect(P.getParagraphIndent(box, 1)).toMatchObject({
      leftEmu: LEVEL_INDENTS[1],
      firstLineEmu: -LEVEL_INDENTS[0],
    });
    // The rendered bullets step to the right with their level.
    const svg = decodeURIComponent(preview(pres, slide).split(",")[1]);
    const xs = [
      ...svg.matchAll(/<text[^>]*x="([\d.]+)"[^>]*>[•◦▪]<\/text>/g),
    ].map((m) => parseFloat(m[1]));
    expect(xs.length).toBe(3);
    expect(xs[1]).toBeGreaterThan(xs[0]);
    expect(xs[2]).toBeGreaterThan(xs[1]);
    // A plain rewrite of the text drops the levels; the rich rewrite puts
    // them back, and a changed level brings its margin along.
    P.setShapeText(box, "One\nTwo\nThree");
    expect(P.getParagraphLevel(box, 1)).toBe(0);
    const paragraphs = textRuns(pres, box).map((paragraph, i) => ({
      ...paragraph,
      runs: paragraph.runs.map((run) => ({ ...run })),
      level: [0, 1, 3][i],
      levelChanged: i === 2,
    }));
    setRichText(box, paragraphs);
    expect([0, 1, 2].map((i) => P.getParagraphLevel(box, i))).toEqual([
      0, 1, 3,
    ]);
    expect(P.getParagraphIndent(box, 2).leftEmu).toBe(LEVEL_INDENTS[3]);
    // A paragraph without bullets indents without a hanging first line.
    P.setShapeBullets(box, "none");
    setParagraphIndentLevel(box, 0, 1, false);
    expect(P.getParagraphIndent(box, 0)).toMatchObject({
      leftEmu: LEVEL_INDENTS[1] - LEVEL_INDENTS[0],
      firstLineEmu: null,
    });
  });
});

describe("paragraph properties through edits", () => {
  it("keeps each paragraph's own alignment and bullets when the text is rewritten", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const box = text(slide, "Heading\nPoint one\nPoint two", 1, 1, 6, 3, 20);
    P.setParagraphAlignment(box, 0, "center");
    P.setParagraphBullet(box, 1, "bullet");
    P.setParagraphBullet(box, 2, "bullet");
    // The plain rewrite spreads the first paragraph's properties over all.
    const paragraphs = textRuns(pres, box);
    expect(paragraphs[0].ppr).toBeTruthy();
    P.setShapeText(box, "Heading\nPoint one\nPoint two");
    expect(P.getParagraphAlignment(box, 1)).toBe("ctr");
    expect(P.getParagraphBullet(box, 1)).toBeFalsy();
    // The rich rewrite restores them, paragraph by paragraph, with the edit.
    paragraphs[1].runs[0].text = "Point one, revised";
    setRichText(box, paragraphs);
    expect(P.getShapeText(box)).toBe("Heading\nPoint one, revised\nPoint two");
    expect(P.getParagraphAlignment(box, 0)).toBe("ctr");
    expect(P.getParagraphAlignment(box, 1)).toBeFalsy();
    expect(P.getParagraphBullet(box, 1)).toBeTruthy();
    expect(P.getParagraphBullet(box, 0)).toBeFalsy();
  });
});

describe("paragraph alignment and lists from the editor", () => {
  it("aligns and lists single paragraphs, with the margins that go with a list", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const box = text(slide, "Title\nPoint\nNote", 1, 1, 6, 3, 20);
    const paragraphs = textRuns(pres, box);
    expect(paragraphs.map((p) => p.align)).toEqual(["left", "left", "left"]);
    expect(paragraphs.map((p) => p.list)).toEqual(["none", "none", "none"]);
    paragraphs[0].align = "center";
    paragraphs[0].alignChanged = true;
    paragraphs[1].list = "bullet";
    paragraphs[1].listChanged = true;
    setRichText(box, paragraphs);
    expect(P.getParagraphAlignment(box, 0)).toBe("ctr");
    expect(P.getParagraphAlignment(box, 1)).toBeFalsy();
    expect(listOf(P.getParagraphBullet(box, 1))).toBe("bullet");
    expect(listOf(P.getParagraphBullet(box, 2))).toBe("none");
    expect(P.getParagraphIndent(box, 1)).toMatchObject({
      leftEmu: LEVEL_INDENTS[0],
      firstLineEmu: -LEVEL_INDENTS[0],
    });
    expect(P.getParagraphIndent(box, 2).leftEmu).toBeNull();
    // Reading back reports the new state, and turning the list off again
    // drops the hanging indent.
    const again = textRuns(pres, box);
    expect(again.map((p) => p.list)).toEqual(["none", "bullet", "none"]);
    expect(again[0].align).toBe("center");
    again[1].list = "none";
    again[1].listChanged = true;
    setRichText(box, again);
    expect(listOf(P.getParagraphBullet(box, 1))).toBe("none");
    expect(P.getParagraphIndent(box, 1).leftEmu).toBeNull();
  });
});

describe("picture brightness", () => {
  it("renders as a filter and survives a save", async () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const png = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
      0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84,
      120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 99, 85, 19, 187, 0, 0, 0, 0,
      73, 69, 78, 68, 174, 66, 96, 130,
    ]);
    const picture = P.addSlideImage(slide, png, {
      x: P.inches(1),
      y: P.inches(1),
      w: P.inches(2),
      h: P.inches(2),
    });
    P.setShapeImageBrightness(picture, 0.3);
    const svg = decodeURIComponent(preview(pres, slide).split(",")[1]);
    expect(svg).toContain('intercept="0.3"');
    const loaded = await parseDeck(await P.savePresentation(pres));
    const shape = P.getSlideShapes(P.getSlides(loaded)[0])[0];
    expect(P.getShapeImageBrightness(shape)).toBe(0.3);
    P.setShapeImageBrightness(picture, null);
    expect(P.getShapeImageBrightness(picture)).toBeNull();
    expect(
      decodeURIComponent(preview(pres, slide).split(",")[1]),
    ).not.toContain("feComponentTransfer");
  });
});

describe("paragraph spacing from the editor", () => {
  it("sets line spacing and the space around single paragraphs", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const box = text(slide, "One\nTwo\nThree", 1, 1, 6, 3, 20);
    const paragraphs = textRuns(pres, box);
    expect(paragraphs[1]).toMatchObject({
      lineSpacing: 1,
      spaceBefore: 0,
      spaceAfter: 0,
    });
    paragraphs[1].lineSpacing = 1.5;
    paragraphs[1].lineSpacingChanged = true;
    paragraphs[2].spaceBefore = 12;
    paragraphs[2].spaceAfter = 6;
    paragraphs[2].spacingChanged = true;
    setRichText(box, paragraphs);
    // The library takes a multiple of single spacing, so 1.5 is 150% and
    // the file holds spcPct 150000; 150 would be 15000%.
    expect(P.getParagraphLineSpacing(box, 1)).toMatchObject({
      kind: "pct",
      value: 1.5,
    });
    expect(P.getShapeXmlString(box)).toContain('<a:spcPct val="150000"/>');
    expect(P.getParagraphLineSpacing(box, 0)).toBeFalsy();
    expect(P.getParagraphSpacing(box, 2)).toEqual({
      beforePts: 12,
      afterPts: 6,
    });
    expect(P.getParagraphSpacing(box, 1).beforePts).toBeNull();
    const again = textRuns(pres, box);
    expect(again[1].lineSpacing).toBe(1.5);
    expect(again[2]).toMatchObject({ spaceBefore: 12, spaceAfter: 6 });
    // A rewrite without changes keeps both, and clearing takes them away.
    setRichText(box, again);
    expect(P.getParagraphSpacing(box, 2).afterPts).toBe(6);
    again[2].spaceBefore = 0;
    again[2].spaceAfter = 0;
    again[2].spacingChanged = true;
    setRichText(box, again);
    expect(P.getParagraphSpacing(box, 2)).toEqual({
      beforePts: null,
      afterPts: null,
    });
  });
});

describe("preview and template edge cases", () => {
  // encodeURIComponent throws on a lone surrogate, which the parser accepts.
  it("renders a preview of text holding a lone surrogate", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    text(slide, "lone \uD83D here", 1, 1, 6, 1, 20);
    expect(preview(pres, slide)).toMatch(/^data:image\/svg\+xml/);
  });
  // The footer number used to be the slide count, so a slide inserted after
  // slide 2 of five read "06".
  it("numbers a designed slide's footer by its position", () => {
    const pres = createDeck("story");
    const slide = addDesignedSlide(pres, "content", "studio", { number: 3 });
    expect(P.getSlideShapes(slide).map(P.getShapeText)).toContain("03");
    const counted = addDesignedSlide(pres, "content", "studio");
    expect(P.getSlideShapes(counted).map(P.getShapeText)).toContain("07");
  });
});

describe("soft breaks and fields through an edit", () => {
  const SHAPE_ELEMENT = Symbol.for("@office-kit/pptx.shape.element");
  const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const element = (localName, attrs = [], children = []) => ({
    kind: "element",
    name: { prefix: "a", localName, namespaceURI: NS_A },
    attrs,
    prefixDecls: new Map(),
    children,
  });
  const attribute = (localName, value) => ({
    name: { prefix: "", localName, namespaceURI: "" },
    value,
  });
  // A deck as native files store one: paragraph two holds a Shift+Enter
  // break and paragraph three ends in a slide-number field.
  async function deckWithBreakAndField() {
    let pres = createDeck("blank");
    let shape = text(
      P.getSlides(pres)[0],
      "Heading\nPoint one\nPoint two ",
      1,
      1,
      6,
      3,
      24,
      "#000000",
    );
    const body = shape[SHAPE_ELEMENT].children.find(
      (c) => c.name?.localName === "txBody",
    );
    const paragraphs = body.children.filter((c) => c.name?.localName === "p");
    const run = paragraphs[1].children.find((c) => c.name?.localName === "r");
    const withText = (node, value) => {
      const copy = structuredClone(node);
      copy.children.find((c) => c.name?.localName === "t").children = [
        { kind: "text", data: value },
      ];
      return copy;
    };
    paragraphs[1].children.push(element("br"), withText(run, "continued"));
    paragraphs[2].children.push(
      element(
        "fld",
        [
          attribute("id", "{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}"),
          attribute("type", "slidenum"),
        ],
        [
          {
            kind: "element",
            name: { prefix: "a", localName: "t", namespaceURI: NS_A },
            attrs: [],
            prefixDecls: new Map(),
            children: [{ kind: "text", data: "1" }],
          },
        ],
      ),
    );
    P.setParagraphAlignment(shape, 0, "center");
    P.setParagraphBullet(shape, 1, "bullet");
    pres = await parseDeck(await P.savePresentation(pres));
    shape = P.getSlideShapes(P.getSlides(pres)[0])[0];
    return { pres, shape };
  }
  it("keeps a soft break and a field through a rewrite without changes", async () => {
    const { pres, shape } = await deckWithBreakAndField();
    expect(P.getShapeText(shape)).toBe(
      "Heading\nPoint one\ncontinued\nPoint two 1",
    );
    const runs = textRuns(pres, shape);
    expect(runs.map((p) => p.runs.map((r) => r.text))).toEqual([
      ["Heading"],
      [`Point one${SOFT_BREAK}`, "continued"],
      ["Point two ", "1"],
    ]);
    setRichText(shape, runs);
    expect(P.getShapeParagraphCount(shape)).toBe(3);
    expect(P.getShapeText(shape)).toBe(
      "Heading\nPoint one\ncontinued\nPoint two 1",
    );
    const xml = P.getShapeXmlString(shape);
    expect(xml).toContain("<a:br/>");
    expect(xml).toMatch(/<a:fld [^>]*type="slidenum"/);
    expect(xml).not.toContain(SOFT_BREAK);
    expect(P.getParagraphAlignment(shape, 0)).toBe("ctr");
    expect(P.getParagraphBullet(shape, 1)).toBe("bullet");
    expect(P.getParagraphBullet(shape, 2)).toBeFalsy();
  });
  it("writes an edited run around its soft break and turns an edited field into text", async () => {
    const { pres, shape } = await deckWithBreakAndField();
    const runs = textRuns(pres, shape);
    runs[1].runs[0].text = `Point ONE${SOFT_BREAK}`;
    runs[1].runs[0].changes = { bold: true };
    runs[2].runs[1].text = "one";
    setRichText(shape, runs);
    expect(P.getShapeText(shape)).toBe(
      "Heading\nPoint ONE\ncontinued\nPoint two one",
    );
    expect(P.getShapeRunFormat(shape, 1, 0)).toMatchObject({ bold: true });
    const xml = P.getShapeXmlString(shape);
    expect(xml).toContain("<a:br/>");
    expect(xml).not.toContain("<a:fld");
  });
  // Paragraph properties went back into the tree after the library's last
  // commit, so a plain text edit dropped a paragraph's bullet from the saved
  // file while the canvas, reading the tree, still showed it.
  it("keeps a paragraph's bullet in the saved file after a text edit", async () => {
    let pres = createDeck("blank");
    const box = text(P.getSlides(pres)[0], "First\nNext", 1, 1, 8, 2, 28);
    P.setParagraphBullet(box, 1, "bullet");
    P.setParagraphAlignment(box, 0, "center");
    pres = await parseDeck(await P.savePresentation(pres));
    const shape = P.getSlideShapes(P.getSlides(pres)[0])[0];
    const runs = textRuns(pres, shape);
    runs[0].runs[0].text = "First more";
    setRichText(shape, runs);
    const saved = P.getSlideShapes(
      P.getSlides(await parseDeck(await P.savePresentation(pres)))[0],
    )[0];
    expect(P.getShapeText(saved)).toBe("First more\nNext");
    expect(P.getParagraphBullet(saved, 1)).toBe("bullet");
    expect(P.getParagraphAlignment(saved, 0)).toBe("ctr");
  });
  it("splits a run holding soft breaks into lines", async () => {
    const pres = createDeck("blank");
    const box = text(P.getSlides(pres)[0], "One", 1, 1, 6, 3, 24, "#000000");
    const runs = textRuns(pres, box);
    runs[0].runs[0].text = `One${SOFT_BREAK}Two${SOFT_BREAK}Three`;
    setRichText(box, runs);
    expect(P.getShapeParagraphCount(box)).toBe(1);
    expect(P.getShapeText(box)).toBe("One\nTwo\nThree");
    expect(P.getShapeRunCount(box, 0)).toBe(3);
    expect(P.getShapeParagraphElements(box, 0).map((e) => e.kind)).toEqual([
      "r",
      "br",
      "r",
      "br",
      "r",
    ]);
  });
});

describe("preset shapes render their preset geometry", () => {
  const pathOf = (preset) => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    shape(slide, 1, 1, 2, 2, "#2F6B4F", preset);
    const svg = decodeURIComponent(preview(pres, slide).split(",")[1]);
    return (
      /<path d="([^"]+)"/.exec(svg)?.[1] ??
      /<polygon points="([^"]+)"/.exec(svg)?.[1]
    );
  };
  // At 96 pixels per inch the box spans x 96..288 and y 96..288.
  it("draws a heart with round lobes rising above its notch", () => {
    const d = pathOf("heart");
    const numbers = d.match(/-?[\d.]+/g).map(Number);
    // The path starts at the notch, a quarter of the way down the box.
    expect(numbers.slice(0, 2)).toEqual([192, 144]);
    // Both lobes curve through control points above the top edge.
    expect(numbers.filter((n, i) => i % 2 === 1 && n < 96)).toHaveLength(2);
    // The point is at the bottom center.
    expect(d).toMatch(/192(?:\.00)?,288(?:\.00)?/);
  });
  it("draws a cloud from eleven arcs and nothing straight", () => {
    const d = pathOf("cloud");
    expect(d.match(/A/g)).toHaveLength(11);
    expect(d).not.toMatch(/L/);
    // The outline stays within the box.
    for (const [, xy] of d.matchAll(/ (-?[\d.]+,-?[\d.]+)(?= |$)/g)) {
      const [px, py] = xy.split(",").map(Number);
      expect(px).toBeGreaterThanOrEqual(95);
      expect(px).toBeLessThanOrEqual(289);
      expect(py).toBeGreaterThanOrEqual(95);
      expect(py).toBeLessThanOrEqual(289);
    }
  });
  it("draws the hexagon and octagon with flat tops", () => {
    for (const preset of ["hexagon", "octagon"]) {
      const points = pathOf(preset)
        .trim()
        .split(/\s+/)
        .filter((pair) => pair !== "Z")
        .map((pair) => pair.replace(/^[ML]/, "").split(",").map(Number));
      expect(points.filter(([, py]) => Math.abs(py - 96) < 0.5)).toHaveLength(
        2,
      );
      expect(points.filter(([, py]) => Math.abs(py - 288) < 0.5)).toHaveLength(
        2,
      );
    }
  });
});

describe("preset shapes fill their box", () => {
  const drawn = (preset) => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    shape(slide, 1, 1, 2, 2, "#2F6B4F", preset);
    const svg = decodeURIComponent(preview(pres, slide).split(",")[1]);
    return (
      /<path d="([^"]+)"/.exec(svg)?.[1] ??
      /<polygon points="([^"]+)"/.exec(svg)?.[1]
    );
  };
  const points = (preset) =>
    drawn(preset)
      .trim()
      .split(/\s+/)
      .filter((pair) => pair !== "Z")
      .map((pair) => pair.replace(/^[ML]/, "").split(",").map(Number));
  // The box spans x 96..288 and y 96..288 at 96 pixels per inch.
  it("stands the pentagon and the star on the bottom edge, as wide as the box", () => {
    for (const preset of ["pentagon", "star5"]) {
      const list = points(preset);
      expect(list.some(([px, py]) => px === 192 && py === 96)).toBe(true);
      expect(list.filter(([, py]) => py === 288)).toHaveLength(2);
      expect(list.some(([px]) => px === 96)).toBe(true);
      expect(list.some(([px]) => px === 288)).toBe(true);
    }
  });
  it("fills the speech bubble's box with its body and hangs the tail below", () => {
    const d = drawn("wedgeRectCallout");
    const list = [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    expect(list).toContainEqual([96, 96]);
    expect(list).toContainEqual([288, 96]);
    expect(list).toContainEqual([288, 288]);
    // The tail leaves the bottom edge and ends below it, left of center.
    expect(d).toMatch(
      /L(\d+(\.\d+)?),(\d+(\.\d+)?) L(\d+(\.\d+)?),(\d+(\.\d+)?) L/,
    );
    const tip = list.find(([, py]) => py > 288);
    expect(tip).toBeDefined();
    expect(tip[0]).toBeLessThan(192);
  });
});
describe("group rotation", () => {
  it("finds the turn of its own a grouped shape needs to show an angle", () => {
    const pres = createDeck();
    const slide = P.getSlides(pres)[0];
    const a = shape(slide, 1, 1, 2, 1, "#000000");
    const b = shape(slide, 1, 3, 2, 1, "#000000");
    const inner = P.groupShapes([a, b]);
    P.setShapeRotation(inner, 30);
    P.setShapeFlip(inner, { horizontal: true, vertical: false });
    const c = shape(slide, 5, 5, 1, 1, "#000000");
    const outer = P.groupShapes([inner, c]);
    P.setShapeRotation(outer, 45);
    // A mirrored group turns its children the other way, so the shown angle
    // is not the sum of the turns; the inverse still lands on it.
    expect(slideRotation(a)).toBe(75);
    for (const angle of [0, 10, 95.5, 200, 359]) {
      P.setShapeRotation(a, ownRotation(a, angle));
      expect(slideRotation(a)).toBeCloseTo(angle, 5);
    }
    // A shape outside any group turns as it is asked to.
    expect(ownRotation(c, 120)).toBe(120 - 45);
    const free = shape(slide, 7, 1, 1, 1, "#000000");
    expect(ownRotation(free, 270)).toBe(270);
    expect(ownRotation(free, -90)).toBe(270);
  });
});
