import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8, strToU8 } from "fflate";
import {
  P,
  createDeck,
  parseDeck,
  preview,
  textRuns,
  displayShapeText,
  slideDescription,
  setRichText,
  slideNumberRun,
  splitFieldEdges,
} from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import { slideNumberStamp } from "../src/slide-fields.js";
import { createNumberedDeck } from "./slide-number-fixture.js";
const svg = (p, s = P.getSlides(p)[0]) =>
  decodeURIComponent(preview(p, s).split(",").slice(1).join(","));
const text = (s) => s.replace(/<[^>]+>/g, "");

describe("live slide-number fields", () => {
  it.each([null, 0, 27, -3, "+0042", "broken", "1e2", 2147483648])(
    "uses the first slide number %s and current order without changing cached text",
    async (start) => {
      const p = await parseDeck(await createNumberedDeck({ start }));
      const [a, b] = P.getSlides(p);
      const base =
        start === null || ["broken", "1e2", 2147483648].includes(start)
          ? 1
          : Number(start);
      const before = unzipSync(await P.savePresentation(p));
      expect(P.getSlideNumber(p, a)).toBe(base);
      expect(P.getSlideNumber(p, b)).toBe(base + 1);
      expect(text(svg(p, a))).toContain(`Number: ${base} / literal 999`);
      expect(unzipSync(await P.savePresentation(p))).toEqual(before);
      P.setSlideHidden(a, true);
      expect(P.getSlideNumber(p, b)).toBe(base + 1);
      P.moveSlide(p, b, 0);
      expect(P.getSlideNumber(p, a)).toBe(base + 1);
      expect(text(svg(p, a))).toContain(`Number: ${base + 1} / literal 999`);
      expect(P.getShapeText(P.getSlideShapes(a)[1])).toContain("Number: 999");
      P.removeSlide(p, b);
      expect(P.getSlideNumber(p, b)).toBeNull();
      expect(P.getSlideNumber(p, a)).toBe(base);
      expect(P.getSlideNumber(p, P.getSlides(createDeck())[0])).toBeNull();
    },
  );
  it.each(["slide", "layout", "master"])(
    "evaluates %s-owned fields in the displayed slide context",
    async (owner) => {
      const p = await parseDeck(await createNumberedDeck({ owner }));
      const [a, b] = P.getSlides(p);
      for (const mode of ["svg", "foreignObject"])
        expect(text(renderSlideToSvg(p, b, { textLayout: mode }))).toContain(
          "Number: 41 / literal 999",
        );
      expect(slideNumberStamp(p, a)).toBe(40);
      expect(slideNumberStamp(p, b)).toBe(41);
      P.moveSlide(p, b, 0);
      expect(slideNumberStamp(p, b)).toBe(40);
      expect(text(svg(p, b))).toContain("Number: 40 / literal 999");
    },
  );
  it("evaluates fields in groups and table cells", async () => {
    const p = await parseDeck(await createNumberedDeck());
    const s = P.getSlides(p)[0];
    P.groupShapes(P.getSlideShapes(s));
    expect(text(svg(p, s))).toContain("Number: 40 / literal 999");
    const table = await parseDeck(await createNumberedDeck({ table: true }));
    for (const mode of ["svg", "foreignObject"])
      expect(
        text(
          renderSlideToSvg(table, P.getSlides(table)[1], { textLayout: mode }),
        ),
      ).toContain("Number: 41 / literal 999");
  });
  it("preserves native fields through text editing, copying, imports and exports", async () => {
    const p = await parseDeck(await createNumberedDeck());
    const [a, b] = P.getSlides(p);
    let shape = P.getSlideShapes(a)[1];
    const before = P.getShapeXmlString(shape);
    const runs = textRuns(p, shape);
    expect(runs[0].runs.map((x) => x.text).join("")).toBe(
      "Number: 40 / literal 999",
    );
    expect(P.getShapeXmlString(shape)).toBe(before);
    runs[0].runs[0].text = "Edited number: ";
    setRichText(shape, runs);
    expect(P.getShapeXmlString(shape)).toContain('type="slidenum"');
    const copy = P.copyShape(b, shape);
    expect(
      textRuns(p, copy)[0]
        .runs.map((x) => x.text)
        .join(""),
    ).toBe("Edited number: 41 / literal 999");
    const clip = createDeck();
    const imported = P.importSlide(clip, a, P.getSlideLayouts(clip)[0]);
    const dest = await parseDeck(
      await createNumberedDeck({ start: 7, count: 1 }),
    );
    const pasted = P.importSlide(dest, imported, P.getSlideLayouts(dest)[0]);
    expect(text(svg(dest, pasted))).toContain("Edited number: 8 / literal 999");
    const loaded = await parseDeck(await P.savePresentation(dest));
    expect(text(svg(loaded, P.getSlides(loaded)[1]))).toContain(
      "Edited number: 8 / literal 999",
    );
    expect(
      P.getShapeXmlString(P.getSlideShapes(P.getSlides(loaded)[1])[1]),
    ).toContain('type="slidenum"');
  });
  it("invalidates dependencies after byte edits and excludes unused master placeholders", async () => {
    const p = await parseDeck(await createNumberedDeck());
    const s = P.getSlides(p)[0];
    expect(slideNumberStamp(p, s)).toBe(40);
    const pkg = P._internalPackageOf(p),
      part = pkg.getPart("/ppt/presentation.xml");
    part.data = strToU8(
      strFromU8(part.data).replace('firstSlideNum="40"', 'firstSlideNum="7"'),
    );
    expect(slideNumberStamp(p, s)).toBe(7);
    const slidePart = pkg.getPart(P.getSlidePartName(s));
    slidePart.data = strToU8(
      strFromU8(slidePart.data).replace(
        'type="slidenum"',
        'type="vendor-field"',
      ),
    );
    const reloaded = await parseDeck(await P.savePresentation(p));
    expect(slideNumberStamp(reloaded, P.getSlides(reloaded)[0])).toBeNull();
    P.setShapeText(P.getSlideShapes(s)[1], "Literal replacement");
    expect(slideNumberStamp(p, s)).toBeNull();
    const plain = createDeck();
    expect(slideNumberStamp(plain, P.getSlides(plain)[0])).toBeNull();
  });
  it("recognizes namespace aliases and encoded field types without inventing template placeholders", async () => {
    const p = await parseDeck(await createNumberedDeck());
    const slide = P.getSlides(p)[0];
    const part = P._internalPackageOf(p).getPart(P.getSlidePartName(slide));
    part.data = strToU8(
      strFromU8(part.data)
        .replaceAll("a:", "draw:")
        .replace("xmlns:a=", "xmlns:draw=")
        .replace('type="slidenum"', 'type="slide&#110;um"'),
    );
    const loaded = await parseDeck(await P.savePresentation(p));
    const fresh = P.getSlides(loaded)[0];
    expect(slideNumberStamp(loaded, fresh)).toBe(40);
    expect(displayShapeText(loaded, P.getSlideShapes(fresh)[1])).toBe(
      "Number: 40 / literal 999",
    );
    expect(slideDescription(fresh, loaded)).toContain(
      "Number: 40 / literal 999",
    );
    const template = await parseDeck(
      await createNumberedDeck({ owner: "master" }),
    );
    const templateSlide = P.getSlides(template)[0],
      pkg = P._internalPackageOf(template);
    const master = pkg.getPart(P.getSlideMasterPartName(templateSlide));
    master.data = strToU8(
      strFromU8(master.data).replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, (sp) =>
        sp.includes('type="slidenum"')
          ? sp.replace(
              "<p:nvPr/>",
              '<p:nvPr><p:ph type="sldNum" idx="91"/></p:nvPr>',
            )
          : sp,
      ),
    );
    expect(slideNumberStamp(template, templateSlide)).toBeNull();
  });
  it("keeps unknown fields cached and converts a deliberately replaced number to literal text", async () => {
    const p = await parseDeck(await createNumberedDeck());
    const shape = P.getSlideShapes(P.getSlides(p)[0])[1];
    const runs = textRuns(p, shape);
    runs[0].runs[1].text = "Fixed label";
    setRichText(shape, runs);
    expect(P.getShapeXmlString(shape)).not.toContain('type="slidenum"');
    expect(displayShapeText(p, shape)).toBe(
      "Number: Fixed label / literal 999",
    );
    const source = await parseDeck(await createNumberedDeck());
    const sourceSlide = P.getSlides(source)[0];
    const part = P._internalPackageOf(source).getPart(
      P.getSlidePartName(sourceSlide),
    );
    part.data = strToU8(
      strFromU8(part.data).replace('type="slidenum"', 'type="vendor-number"'),
    );
    const unknown = await parseDeck(await P.savePresentation(source));
    expect(text(svg(unknown))).toContain("Number: 999 / literal 999");
  });

  it("inserts a slide number as a live field that follows the slide", async () => {
    const p = createDeck("blank");
    P.addBlankSlide(p);
    const second = P.getSlides(p)[1];
    const box = P.addSlideTextBox(second, {
      x: P.inches(1),
      y: P.inches(1),
      w: P.inches(4),
      h: P.inches(1),
      text: "Page ",
    });
    const paragraphs = textRuns(p, box);
    const last = paragraphs.at(-1);
    last.runs.push(slideNumberRun(last.runs.at(-1), "2"));
    setRichText(box, paragraphs);
    expect(P.getShapeXmlString(box)).toMatch(/<a:fld [^>]*type="slidenum"/);
    expect(displayShapeText(p, box)).toBe("Page 2");
    P.moveSlide(p, second, 0);
    const back = await parseDeck(await P.savePresentation(p));
    const moved = P.getSlideShapes(P.getSlides(back)[0]).at(-1);
    expect(displayShapeText(back, moved)).toBe("Page 1");
  });

  it("splits text typed at a field's edges off the field", () => {
    const field = slideNumberRun(null, "3");
    const runs = splitFieldEdges([
      { ...field, text: "Page 3!\n" },
      { text: "rest", format: {}, changes: {} },
    ]);
    expect(runs.map((r) => [r.text, !!r.fld])).toEqual([
      ["Page ", false],
      ["3", true],
      ["!\n", false],
      ["rest", false],
    ]);
    // Line breaks after the value stay with the field, and a replaced value
    // is literal text.
    expect(splitFieldEdges([{ ...field, text: "3\n" }])).toHaveLength(1);
    expect(splitFieldEdges([{ ...field, text: "7" }])[0].text).toBe("7");
    runs[0].format.bold = true;
    expect(runs[1].format.bold).toBeUndefined();
  });
});
