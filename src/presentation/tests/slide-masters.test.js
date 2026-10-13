import { describe, it, expect } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { P, createDeck, preview, templateStamp } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import { BUILTIN_LAYOUTS } from "../lib/pptx/src/internal/parts/builtin-layouts.ts";

const GALLERY = [
  ["title", "Title Slide"],
  ["obj", "Title and Content"],
  ["secHead", "Section Header"],
  ["twoObj", "Two Content"],
  ["twoTxTwoObj", "Comparison"],
  ["titleOnly", "Title Only"],
  ["blank", "Blank"],
  ["objTx", "Content with Caption"],
  ["picTx", "Picture with Caption"],
  ["vertTx", "Title and Vertical Text"],
  ["vertTitleAndTx", "Vertical Title and Text"],
];
const errors = (pres) =>
  P.validatePresentation(pres).filter((i) => i.severity === "error");
const reload = async (pres) =>
  P.loadPresentation(await P.savePresentation(pres));
const layoutOf = (pres, type) =>
  P.getSlideMasters(pres)[0].layouts.find((l) => l.type === type);
const slideOn = (pres, type) =>
  P.addSlide(pres, {
    layout: P.findSlideLayoutByPartName(pres, layoutOf(pres, type).partName),
  });
const phTypes = (slide) =>
  P.getSlideShapes(slide).map((s) => P.getShapePlaceholderType(s));
const files = async (pres) => unzipSync(await P.savePresentation(pres));

describe("built-in layouts", () => {
  it("gives a new presentation every built-in layout, in gallery order", () => {
    const pres = P.createPresentation();
    const [master] = P.getSlideMasters(pres);
    expect(master.layouts.map((l) => [l.type, l.name])).toEqual(GALLERY);
    expect(BUILTIN_LAYOUTS).toHaveLength(GALLERY.length);
    expect(errors(pres)).toEqual([]);
    // Every layout carries the footer row (date, footer, slide number).
    for (const layout of master.layouts) {
      const types = P.getSlideLayoutPlaceholders(
        P.findSlideLayoutByPartName(pres, layout.partName),
      ).map((p) => p.type);
      expect(types).toEqual(expect.arrayContaining(["dt", "ftr", "sldNum"]));
    }
  });
  it.each(["16:9", "4:3"])("fits every placeholder on a %s slide", (size) => {
    const pres = P.createPresentation({ size });
    const { width, height } = P.getSlideSize(pres);
    for (const name of [
      P.getSlideMasters(pres)[0].partName,
      ...P.getSlideMasters(pres)[0].layouts.map((l) => l.partName),
    ]) {
      const view = P.getTemplateSlide(pres, name);
      for (const shape of P.getSlideShapes(view)) {
        const b = P.getShapeBoundsResolved(pres, shape);
        expect(b, `${name} ${P.getShapeName(shape)}`).not.toBeNull();
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(width);
        expect(b.y + b.h).toBeLessThanOrEqual(height);
      }
    }
  });
  it("puts content placeholders, not the footer row, on a new slide", () => {
    const pres = P.createPresentation();
    expect(phTypes(slideOn(pres, "title"))).toEqual(["ctrTitle", "subTitle"]);
    expect(phTypes(slideOn(pres, "twoTxTwoObj"))).toEqual([
      "title",
      "body",
      null,
      "body",
      null,
    ]);
    expect(phTypes(slideOn(pres, "picTx"))).toEqual(["title", "pic", "body"]);
    expect(phTypes(slideOn(pres, "blank"))).toEqual([]);
  });
  it("opens a new presentation on the Title Slide layout", () => {
    const pres = createDeck("title");
    const [slide] = P.getSlides(pres);
    expect(P.getSlideLayoutType(P.getSlideLayout(slide))).toBe("title");
    expect(P.getSlideShapes(slide).every(P.isPlaceholderEmpty)).toBe(true);
  });
  it("names the default theme in its own words", async () => {
    const xml = strFromU8(
      (await files(P.createPresentation()))["ppt/theme/theme1.xml"],
    );
    expect(xml).toContain('name="Default Theme"');
  });
});

describe("placeholder prompts", () => {
  it("prompts by kind and honours a layout's own prompt", () => {
    const pres = P.createPresentation();
    const [title, subtitle] = P.getSlideShapes(slideOn(pres, "title"));
    expect(P.getPlaceholderPrompt(title)).toBe("Click to add title");
    expect(P.getPlaceholderPrompt(subtitle)).toBe("Click to add subtitle");
    const [, body] = P.getSlideShapes(slideOn(pres, "obj"));
    expect(P.getPlaceholderPrompt(body)).toBe("Click to add text");
    expect(P.getPlaceholderContentKind(body)).toBe("content");
    const picture = P.getSlideShapes(slideOn(pres, "picTx"))[1];
    expect(P.getPlaceholderContentKind(picture)).toBe("picture");
    P.setShapeText(title, "Typed");
    expect(P.isPlaceholderEmpty(title)).toBe(false);
    expect(P.getPlaceholderPrompt(title)).toBeNull();
    // A layout placeholder with a custom prompt supplies its own text.
    const layout = layoutOf(pres, "obj").partName;
    const pkg = P._internalPackageOf(pres);
    const part = pkg.getPart(layout);
    part.data = new TextEncoder().encode(
      new TextDecoder()
        .decode(part.data)
        .replace('<p:ph idx="1"/>', '<p:ph idx="1" hasCustomPrompt="1"/>'),
    );
    const [, custom] = P.getSlideShapes(slideOn(pres, "obj"));
    expect(P.getPlaceholderPrompt(custom)).toBe(
      "Master text style\nSecond level\nThird level\nFourth level\nFifth level",
    );
  });
  it("draws prompts only when asked, and never saves them", async () => {
    const pres = createDeck("title");
    const [slide] = P.getSlides(pres);
    expect(renderSlideToSvg(pres, slide, {})).not.toContain("Click to add");
    const prompted = renderSlideToSvg(pres, slide, {
      placeholderPrompts: true,
    });
    expect(prompted).toContain("Click to add title");
    expect(prompted).toContain("Click to add subtitle");
    expect(preview(pres, slide)).not.toContain("Click%20to%20add");
    const saved = await files(pres);
    for (const [name, bytes] of Object.entries(saved))
      if (name.startsWith("ppt/slides/"))
        expect(strFromU8(bytes)).not.toContain("Click to add");
    const back = await reload(pres);
    expect(P.getSlideText(P.getSlides(back)[0])).toBe("");
  });
});

describe("changing and resetting a slide's layout", () => {
  it("moves content into the matching placeholders of another layout", async () => {
    const pres = P.createPresentation();
    const slide = slideOn(pres, "obj");
    const [title, body] = P.getSlideShapes(slide);
    P.setShapeText(title, "Plan");
    P.setShapeText(body, "First\nSecond");
    P.applySlideLayout(pres, slide, layoutOf(pres, "twoObj").partName);
    expect(P.getSlideLayoutType(P.getSlideLayout(slide))).toBe("twoObj");
    const shapes = P.getSlideShapes(slide);
    expect(shapes.map(P.getShapeText)).toEqual(["Plan", "First\nSecond", ""]);
    expect(phTypes(slide)).toEqual(["title", null, null]);
    // Content follows the new layout's half-width placeholder.
    const half = P.getShapeBoundsResolved(pres, shapes[1]);
    expect(half.w).toBeLessThan(P.getSlideSize(pres).width / 2);
    // Onto a Title Only layout the body keeps its place and its text; an
    // empty placeholder with nowhere to go is removed.
    P.applySlideLayout(pres, slide, layoutOf(pres, "titleOnly").partName);
    expect(P.getSlideShapes(slide).map(P.getShapeText)).toEqual([
      "Plan",
      "First\nSecond",
    ]);
    expect(P.getShapeBounds(P.getSlideShapes(slide)[1])).toEqual(half);
    expect(errors(pres)).toEqual([]);
    const back = await reload(pres);
    expect(P.getSlideText(P.getSlides(back)[0])).toBe("Plan\nFirst\nSecond");
  });
  it("maps a title slide's subtitle into a content placeholder", () => {
    const pres = P.createPresentation();
    const slide = slideOn(pres, "title");
    const [title, subtitle] = P.getSlideShapes(slide);
    P.setShapeText(title, "Hello");
    P.setShapeText(subtitle, "World");
    P.applySlideLayout(pres, slide, layoutOf(pres, "obj").partName);
    expect(phTypes(slide)).toEqual(["title", null]);
    expect(P.getSlideShapes(slide).map(P.getShapeText)).toEqual([
      "Hello",
      "World",
    ]);
  });
  it("moves a picture in a placeholder into a picture placeholder", () => {
    const pres = P.createPresentation();
    const slide = slideOn(pres, "obj");
    const holder = P.getSlideShapes(slide)[1];
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHxkzIAsAFq8P8bnn0F8AAAAASUVORK5CYII=",
      ),
      (c) => c.charCodeAt(0),
    );
    const picture = P.addSlideImage(slide, png, {
      x: 0,
      y: 0,
      w: P.inches(2),
      h: P.inches(1),
    });
    P.adoptPlaceholderSlot(picture, holder);
    P.removeShape(P.getSlideShapes(slide)[1]);
    expect(P.isShapePlaceholder(P.getSlideShapes(slide)[1])).toBe(true);
    P.applySlideLayout(pres, slide, layoutOf(pres, "picTx").partName);
    const moved = P.getSlideShapes(slide).find(
      (s) => P.getShapeKind(s) === "picture",
    );
    expect(P.getShapePlaceholderType(moved)).toBe("pic");
    const b = P.getShapeBounds(moved);
    expect(b.w / b.h).toBeCloseTo(2, 1);
    // The caption layout's text placeholders arrive empty.
    expect(phTypes(slide)).toEqual(["title", "pic", "body"]);
  });
  it("resets placeholders to the layout and brings back deleted ones", () => {
    const pres = P.createPresentation();
    const slide = slideOn(pres, "obj");
    const [title, body] = P.getSlideShapes(slide);
    P.setShapeText(title, "Title");
    P.setShapeTextFormat(title, { bold: true, size: 12 });
    P.setShapeBounds(title, { x: 0, y: 0, w: P.inches(2), h: P.inches(1) });
    P.removeShape(body);
    P.resetSlideToLayout(pres, slide);
    const [again, restored] = P.getSlideShapes(slide);
    expect(P.getShapeText(again)).toBe("Title");
    expect(P.getShapeBounds(again)).toBeNull();
    expect(P.getShapeRunFormat(again, 0, 0).bold).toBeFalsy();
    expect(P.getShapePlaceholderType(restored)).toBeNull();
    expect(P.isPlaceholderEmpty(restored)).toBe(true);
    expect(errors(pres)).toEqual([]);
  });
});

describe("editing masters and layouts", () => {
  it("edits a layout through its view and every slide on it follows", async () => {
    const pres = P.createPresentation();
    const slide = slideOn(pres, "obj");
    const name = layoutOf(pres, "obj").partName;
    const stamp = templateStamp(pres, slide);
    const view = P.getTemplateSlide(pres, name);
    expect(P.getTemplateKind(view)).toBe("layout");
    expect(P.getTemplateSlide(pres, name)).toBe(view);
    const title = P.getSlideShapes(view)[0];
    P.setShapeBounds(title, {
      x: P.inches(1),
      y: P.inches(1),
      w: P.inches(5),
      h: P.inches(1),
    });
    // The view stays the part's view across its own edits.
    expect(P.getTemplateSlide(pres, name)).toBe(view);
    expect(templateStamp(pres, slide)).not.toBe(stamp);
    const slideTitle = P.getSlideShapes(slide)[0];
    expect(P.getShapeBoundsResolved(pres, slideTitle).x).toBe(P.inches(1));
    P.addSlideTextBox(view, {
      x: 0,
      y: 0,
      w: P.inches(2),
      h: P.inches(1),
      text: "Layout artwork",
    });
    expect(renderSlideToSvg(pres, slide, {})).toContain("Layout artwork");
    const back = await reload(pres);
    expect(
      P.getShapeBoundsResolved(back, P.getSlideShapes(P.getSlides(back)[0])[0])
        .x,
    ).toBe(P.inches(1));
  });
  it("carries a master placeholder's formatting into the style slides inherit", async () => {
    const pres = P.createPresentation();
    const slide = slideOn(pres, "obj");
    const master = P.getSlideMasters(pres)[0].partName;
    const view = P.getTemplateSlide(pres, master);
    expect(P.getTemplateKind(view)).toBe("master");
    const title = P.getSlideShapes(view).find(
      (s) => P.getShapePlaceholderType(s) === "title",
    );
    P.setShapeTextFormat(title, { bold: true, color: "#C00000", size: 40 });
    expect(P.syncPlaceholderListStyles(view)).toBe(true);
    expect(P.syncPlaceholderListStyles(view)).toBe(false);
    const target = P.getSlideShapes(slide)[0];
    P.setShapeText(target, "Inherited");
    expect(P.getShapeRunFormatEffective(pres, target, 0, 0)).toMatchObject({
      bold: true,
      color: "#C00000",
      size: 40,
    });
    const back = await reload(pres);
    const reloaded = P.getSlideShapes(P.getSlides(back)[0])[0];
    expect(P.getShapeRunFormatEffective(back, reloaded, 0, 0)).toMatchObject({
      bold: true,
      size: 40,
    });
    expect(errors(back)).toEqual([]);
  });
  it("draws a layout over its master's background and artwork", () => {
    const pres = P.createPresentation();
    const master = P.getTemplateSlide(
      pres,
      P.getSlideMasters(pres)[0].partName,
    );
    P.setSlideBackground(master, "#123456");
    P.addSlideTextBox(master, {
      x: 0,
      y: 0,
      w: P.inches(2),
      h: P.inches(1),
      text: "Master artwork",
    });
    const name = layoutOf(pres, "obj").partName;
    const svg = renderSlideToSvg(pres, P.getTemplateSlide(pres, name), {});
    expect(svg).toContain("#123456");
    expect(svg).toContain("Master artwork");
    P.setTemplateShowsMasterShapes(P.getTemplateSlide(pres, name), false);
    const hidden = renderSlideToSvg(pres, P.getTemplateSlide(pres, name), {});
    expect(hidden).not.toContain("Master artwork");
    expect(hidden).toContain("#123456");
  });
});

describe("layout and master structure", () => {
  it("inserts, duplicates, renames, preserves, moves and deletes layouts", async () => {
    const pres = P.createPresentation();
    const [master] = P.getSlideMasters(pres);
    const first = master.layouts[0].partName;
    const added = P.addSlideLayout(pres, master.partName, {
      name: "Custom Layout",
      after: first,
    });
    let layouts = P.getSlideMasters(pres)[0].layouts;
    expect(layouts[1]).toMatchObject({
      partName: added,
      name: "Custom Layout",
    });
    expect(layouts[1].type).toBeNull();
    const copy = P.duplicateSlideLayout(pres, added);
    layouts = P.getSlideMasters(pres)[0].layouts;
    expect(layouts[2]).toMatchObject({
      partName: copy,
      name: "Custom Layout copy",
    });
    P.renameTemplate(pres, copy, "Agenda");
    P.setTemplatePreserved(pres, copy, false);
    P.moveSlideLayout(pres, copy, 0);
    layouts = P.getSlideMasters(pres)[0].layouts;
    expect(layouts[0]).toMatchObject({ name: "Agenda", preserve: false });
    // A layout a slide uses stays.
    P.addSlide(pres, { layout: P.findSlideLayoutByPartName(pres, copy) });
    expect(() => P.deleteSlideLayout(pres, copy)).toThrow(/used by slides/);
    P.deleteSlideLayout(pres, added);
    expect(
      P.getSlideMasters(pres)[0].layouts.map((l) => l.partName),
    ).not.toContain(added);
    expect(P._internalPackageOf(pres).getPart(added)).toBeNull();
    expect(errors(pres)).toEqual([]);
    const back = await reload(pres);
    expect(P.getSlideMasters(back)[0].layouts[0].name).toBe("Agenda");
    expect(errors(back)).toEqual([]);
  });
  it("inserts, duplicates and deletes slide masters with unique ids", async () => {
    const pres = P.createPresentation();
    const [first] = P.getSlideMasters(pres);
    const second = P.addSlideMaster(pres, { after: first.partName });
    const copy = P.duplicateSlideMaster(pres, first.partName);
    let masters = P.getSlideMasters(pres);
    expect(masters.map((m) => m.partName)).toEqual([
      first.partName,
      copy,
      second,
    ]);
    expect(masters[1].name).toBe("Default Theme copy");
    for (const m of masters) expect(m.layouts).toHaveLength(GALLERY.length);
    // Every master and layout id is distinct.
    const xml = await files(pres);
    const ids = Object.entries(xml)
      .filter(([n]) =>
        /slideMasters\/slideMaster\d+\.xml$|presentation\.xml$/.test(n),
      )
      .flatMap(([, b]) =>
        [...strFromU8(b).matchAll(/<p:sld(?:Master|Layout)Id id="(\d+)"/g)].map(
          (m) => m[1],
        ),
      );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3 + 3 * GALLERY.length);
    // A slide on the new master renders and survives a round trip.
    const layout = P.getSlideMasters(pres)[2].layouts[1].partName;
    P.addSlide(pres, { layout: P.findSlideLayoutByPartName(pres, layout) });
    expect(() => P.deleteSlideMaster(pres, second)).toThrow(/used by slides/);
    P.deleteSlideMaster(pres, copy);
    masters = P.getSlideMasters(pres);
    expect(masters.map((m) => m.partName)).toEqual([first.partName, second]);
    expect(errors(pres)).toEqual([]);
    const back = await reload(pres);
    expect(P.getSlideMasters(back)).toHaveLength(2);
    expect(errors(back)).toEqual([]);
  });
  it("keeps the last master and a master's last layout", () => {
    const pres = P.createPresentation();
    const [master] = P.getSlideMasters(pres);
    expect(() => P.deleteSlideMaster(pres, master.partName)).toThrow(
      /at least one slide master/,
    );
    for (const layout of master.layouts.slice(1))
      P.deleteSlideLayout(pres, layout.partName);
    expect(() => P.deleteSlideLayout(pres, master.layouts[0].partName)).toThrow(
      /at least one layout/,
    );
  });
});

describe("placeholders on layouts and masters", () => {
  it("inserts each kind of placeholder with its own index", async () => {
    const pres = P.createPresentation();
    const name = layoutOf(pres, "titleOnly").partName;
    const view = P.getTemplateSlide(pres, name);
    const box = { x: 0, y: P.inches(2), w: P.inches(4), h: P.inches(3) };
    const kinds = {
      content: null,
      contentVertical: null,
      text: "body",
      textVertical: "body",
      picture: "pic",
      chart: "chart",
      table: "tbl",
      smartArt: "dgm",
      media: "media",
    };
    const idxs = new Set();
    for (const [kind, type] of Object.entries(kinds)) {
      const shape = P.insertTemplatePlaceholder(view, kind, box);
      expect(P.getShapePlaceholderType(shape)).toBe(type);
      idxs.add(P.getShapePlaceholderIdx(shape));
    }
    expect(idxs.size).toBe(Object.keys(kinds).length);
    expect(Math.min(...idxs)).toBeGreaterThan(12);
    // A slide on the layout gets the new placeholders, waiting for content.
    const slide = P.addSlide(pres, {
      layout: P.findSlideLayoutByPartName(pres, name),
    });
    expect(P.getSlideShapes(slide)).toHaveLength(1 + Object.keys(kinds).length);
    expect(P.getPlaceholderPrompt(P.getSlideShapes(slide)[5])).toBe(
      "Click to add a picture",
    );
    expect(errors(await reload(pres))).toEqual([]);
  });
  it("switches a layout's title and footers on and off", () => {
    const pres = P.createPresentation();
    const view = P.getTemplateSlide(pres, layoutOf(pres, "obj").partName);
    for (const slot of ["title", "date", "footer", "slideNumber"])
      expect(P.hasTemplatePlaceholder(view, slot)).toBe(true);
    P.setTemplatePlaceholder(pres, view, "title", false);
    P.setTemplatePlaceholder(pres, view, "footer", false);
    expect(P.hasTemplatePlaceholder(view, "title")).toBe(false);
    expect(P.hasTemplatePlaceholder(view, "footer")).toBe(false);
    P.setTemplatePlaceholder(pres, view, "title", true);
    P.setTemplatePlaceholder(pres, view, "footer", true);
    const title = P.getSlideShapes(view)[0];
    expect(P.getShapePlaceholderType(title)).toBe("title");
    // A restored placeholder follows the master's position.
    expect(P.getShapeBounds(title)).toBeNull();
    const footer = P.getSlideShapes(view).find(
      (s) => P.getShapePlaceholderType(s) === "ftr",
    );
    expect(P.getShapePlaceholderIdx(footer)).toBe(11);
    expect(errors(pres)).toEqual([]);
  });
  it("switches a master's own placeholders", () => {
    const pres = P.createPresentation();
    const view = P.getTemplateSlide(pres, P.getSlideMasters(pres)[0].partName);
    P.setTemplatePlaceholder(pres, view, "body", false);
    expect(P.hasTemplatePlaceholder(view, "body")).toBe(false);
    P.setTemplatePlaceholder(pres, view, "body", true);
    const body = P.getSlideShapes(view).at(-1);
    expect(P.getShapePlaceholderType(body)).toBe("body");
    expect(P.getShapeBounds(body).w).toBeGreaterThan(P.inches(10));
  });
});

describe("notes and handout masters", () => {
  it("creates both masters with their placeholders and page orientation", async () => {
    const pres = createDeck("title");
    P.setSlideNotes(P.getSlides(pres)[0], "Speaker notes");
    const notes = P.ensureNotesMaster(pres);
    const handout = P.ensureHandoutMaster(pres);
    expect(P.ensureNotesMaster(pres)).toBe(notes);
    const notesView = P.getTemplateSlide(pres, notes);
    expect(P.getTemplateKind(notesView)).toBe("notesMaster");
    for (const slot of [
      "header",
      "date",
      "slideImage",
      "body",
      "footer",
      "slideNumber",
    ])
      expect(P.hasTemplatePlaceholder(notesView, slot)).toBe(true);
    const handoutView = P.getTemplateSlide(pres, handout);
    expect(P.hasTemplatePlaceholder(handoutView, "slideImage")).toBe(false);
    P.setTemplatePlaceholder(pres, handoutView, "header", false);
    expect(P.hasTemplatePlaceholder(handoutView, "header")).toBe(false);
    expect(P.getNotesPageSize(pres)).toEqual({ cx: 6858000, cy: 9144000 });
    P.setNotesPageOrientation(pres, "landscape");
    expect(P.getNotesPageSize(pres)).toEqual({ cx: 9144000, cy: 6858000 });
    expect(P.getTemplatePageSize(pres, notesView)).toEqual({
      cx: 9144000,
      cy: 6858000,
    });
    // The notes page draws on its own page size.
    expect(renderSlideToSvg(pres, notesView, {})).toContain(
      'viewBox="0 0 960.00 720.00"',
    );
    const xml = await files(pres);
    const presentation = strFromU8(xml["ppt/presentation.xml"]);
    expect(presentation.indexOf("notesMasterIdLst")).toBeGreaterThan(
      presentation.indexOf("sldMasterIdLst"),
    );
    expect(presentation.indexOf("handoutMasterIdLst")).toBeLessThan(
      presentation.indexOf("sldSz"),
    );
    const back = await reload(pres);
    expect(P.getNotesMasterPartName(back)).toBe(notes);
    expect(P.getHandoutMasterPartName(back)).toBe(handout);
    expect(P.getSlideNotes(P.getSlides(back)[0])).toBe("Speaker notes");
    expect(errors(back)).toEqual([]);
  });
});
