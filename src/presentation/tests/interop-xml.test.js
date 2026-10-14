// Markup that desktop readers insist on. Each case was found by opening a
// file this app wrote in a desktop presentation editor and getting a repair
// prompt or lost content; the tests pin the corrected XML.
import { describe, expect, it } from "vitest";
import { P, createDeck, addLayoutSlide } from "../src/model.js";

const slideXml = (slide) => P.getSlideXmlString(slide);

describe("transitions", () => {
  it("spells out the morph option even when it is the default", () => {
    const pres = createDeck("title");
    const slide = addLayoutSlide(pres, "obj");
    P.setSlideTransition(slide, { effect: "morph" });
    expect(slideXml(slide)).toContain('<p159:morph option="byObject"/>');
    expect(P.getSlideTransition(slide)).toMatchObject({ effect: "morph" });
    P.setSlideTransition(slide, { effect: "morph", morphOption: "byChar" });
    expect(slideXml(slide)).toContain('<p159:morph option="byChar"/>');
  });
});
