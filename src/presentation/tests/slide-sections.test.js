import { describe, it, expect } from "vitest";
import { P } from "../src/model.js";

// Four slides; "Later" starts at the third.
function deck() {
  const pres = P.createPresentation();
  for (const title of ["A", "B", "C", "D"])
    P.addContentSlide(pres, { title, body: "" });
  const s = P.getSlides(pres);
  P.setSlideSections(pres, [
    { name: "Default Section", slides: s.slice(0, 2) },
    { name: "Later", slides: s.slice(2) },
  ]);
  return pres;
}
const title = (s) => P.getSlideTitle(s);
const layout = (pres) =>
  P.getSlideSections(pres).map(
    (sec) => `${sec.name}[${sec.slides.map(title).join("")}]`,
  );
const at = (pres, i) => P.getSlides(pres)[i];
const roundTrip = async (pres) =>
  P.loadPresentation(await P.savePresentation(pres));

describe("slide sections follow deck edits", () => {
  it("moves a slide into the section it lands in", async () => {
    const pres = deck();
    P.moveSlide(pres, at(pres, 1), 2); // B down past C
    expect(layout(pres)).toEqual(["Default Section[A]", "Later[CBD]"]);
    P.moveSlide(pres, at(pres, 1), 0); // C up to the top
    expect(layout(pres)).toEqual(["Default Section[CA]", "Later[BD]"]);
    // Moving within a section at its boundary keeps the section.
    P.moveSlide(pres, at(pres, 3), 2); // D up within Later
    expect(layout(pres)).toEqual(["Default Section[CA]", "Later[DB]"]);
    expect(layout(await roundTrip(pres))).toEqual(layout(pres));
  });

  it("drops removed slides and places new ones after their neighbour", () => {
    const pres = deck();
    P.removeSlide(pres, at(pres, 3)); // D, the highest id
    expect(layout(pres)).toEqual(["Default Section[AB]", "Later[C]"]);
    // The freed id comes back for the next slide; it must not reappear in Later.
    const fresh = P.addContentSlide(pres, { title: "E", body: "" });
    expect(layout(pres)).toEqual(["Default Section[AB]", "Later[CE]"]);
    P.moveSlide(pres, fresh, 2); // after B, the last slide of Default Section
    expect(layout(pres)).toEqual(["Default Section[ABE]", "Later[C]"]);
    const copy = P.duplicateSlide(pres, at(pres, 0));
    P.setSlideTitle(copy, "F");
    P.moveSlide(pres, copy, 1);
    expect(layout(pres)).toEqual(["Default Section[AFBE]", "Later[C]"]);
  });

  it("leaves decks without sections alone", () => {
    const pres = P.createPresentation();
    P.addContentSlide(pres, { title: "A", body: "" });
    P.addContentSlide(pres, { title: "B", body: "" });
    P.moveSlide(pres, at(pres, 1), 0);
    P.removeSlide(pres, at(pres, 1));
    expect(P.getSlideSections(pres)).toEqual([]);
  });
});
