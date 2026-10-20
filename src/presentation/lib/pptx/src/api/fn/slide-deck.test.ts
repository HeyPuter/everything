import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  addBlankSlide,
  addSlideShape,
  addSlideTextBox,
  createPresentation,
  getShapeActionSettings,
  getShapeClickAction,
  getShapeRunClickAction,
  getSlidePartName,
  getSlideShapes,
  getSlides,
  inches,
  loadPresentation,
  removeSlide,
  savePresentation,
  setShapeActionSettings,
  setShapeClickAction,
} from "../index.ts";

const SLIDE_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";

describe("removeSlide", () => {
  it("drops the other slides' links to the removed slide", async () => {
    const pres = createPresentation();
    addBlankSlide(pres);
    addBlankSlide(pres);
    addBlankSlide(pres);
    const [s1, s2, s3] = getSlides(pres);
    const box = { x: inches(1), y: inches(1), w: inches(2), h: inches(1) };
    // A hover action to the slide that goes, a click action to one that stays.
    setShapeActionSettings(addSlideShape(s1!, { preset: "rect", ...box }), {
      click: {
        jump: { kind: "slide", slide: s3! },
        sound: null,
        highlight: false,
      },
      hover: {
        jump: { kind: "slide", slide: s2! },
        sound: null,
        highlight: false,
      },
    });
    setShapeClickAction(addSlideShape(s3!, { preset: "rect", ...box }), {
      kind: "slide",
      slide: s2!,
    });
    addSlideTextBox(s1!, { ...box, text: "Agenda" });
    // A text run linking to the slide that goes (no authoring API for these).
    const files = unzipSync(await savePresentation(pres));
    const name = getSlidePartName(s1!).slice(1);
    const rels = name.replace("slides/", "slides/_rels/") + ".rels";
    files[name] = strToU8(
      strFromU8(files[name]!).replace(
        /(<a:r><a:rPr[^>]*?)\/>/,
        '$1><a:hlinkClick r:id="rId99" action="ppaction://hlinksldjump"/></a:rPr>',
      ),
    );
    files[rels] = strToU8(
      strFromU8(files[rels]!).replace(
        "</Relationships>",
        `<Relationship Id="rId99" Type="${SLIDE_REL}" Target="${getSlidePartName(s2!).split("/").pop()}"/></Relationships>`,
      ),
    );
    const loaded = await loadPresentation(zipSync(files));
    const [a, b] = getSlides(loaded);
    const [actions, text] = getSlideShapes(a!);
    expect(getShapeRunClickAction(text!, 0, 0)?.kind).toBe("slide");

    removeSlide(loaded, b!);
    expect(getShapeActionSettings(actions!).hover).toBeNull();
    expect(getShapeRunClickAction(text!, 0, 0)).toBeNull();

    const saved = unzipSync(await savePresentation(loaded));
    const relsXml = Object.entries(saved)
      .filter(([path]) => /^ppt\/slides\/_rels\//.test(path))
      .map(([, data]) => strFromU8(data))
      .join("");
    // Only the click action to the slide that stays keeps a slide relationship.
    expect(relsXml.split(`Type="${SLIDE_REL}"`)).toHaveLength(2);
    const back = await loadPresentation(await savePresentation(loaded));
    const [first, last] = getSlides(back);
    const [shape, run] = getSlideShapes(first!);
    const kept = getShapeActionSettings(shape!).click?.jump;
    expect(kept?.kind === "slide" && getSlidePartName(kept.slide)).toBe(
      getSlidePartName(last!),
    );
    expect(getShapeActionSettings(shape!).hover).toBeNull();
    expect(getShapeRunClickAction(run!, 0, 0)).toBeNull();
    expect(getShapeClickAction(getSlideShapes(last!)[0]!)).toBeNull();
    // A slide added later, even under the removed slide's part name, is no
    // link's target.
    addBlankSlide(back);
    expect(getShapeActionSettings(shape!).hover).toBeNull();
    expect(getShapeClickAction(getSlideShapes(last!)[0]!)).toBeNull();
  });
});
