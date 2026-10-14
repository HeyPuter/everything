import { describe, expect, it } from "vitest";
import { P, createDeck, parseDeck } from "../src/model.js";
import { INTERNAL_PACKAGE } from "../lib/pptx/src/api/_internal-symbols.ts";
import { partName } from "../lib/pptx/src/internal/opc/index.ts";

const decode = (bytes) => new TextDecoder().decode(bytes);
const presProps = (pres) =>
  decode(pres[INTERNAL_PACKAGE].getPart(partName("/ppt/presProps.xml")).data);
const presentationXml = (pres) =>
  decode(
    pres[INTERNAL_PACKAGE].getPart(partName("/ppt/presentation.xml")).data,
  );

function deck(count = 4) {
  const pres = createDeck("blank");
  for (let i = 1; i < count; i++) P.addBlankSlide(pres);
  return pres;
}
async function roundTrip(pres) {
  return P.loadPresentation(await P.savePresentation(pres));
}

describe("slide show setup", () => {
  it("reads defaults from a deck without show properties", () => {
    expect(P.getSlideShowSetup(deck())).toEqual(P.DEFAULT_SLIDE_SHOW_SETUP);
  });

  it("writes every setting and reads it back after saving", async () => {
    const pres = deck();
    P.setSlideShowSetup(pres, {
      showType: "kiosk",
      loop: true,
      showNarration: false,
      showAnimation: false,
      useTimings: true,
      penColor: "#00ff00",
      laserColor: "#0000FF",
      showMediaControls: false,
      selection: { kind: "range", start: 2, end: 3 },
    });
    const xml = presProps(pres);
    expect(xml).toMatch(/<p:showPr[^>]*loop="1"/);
    expect(xml).toMatch(/showNarration="0"/);
    expect(xml).toMatch(/showAnimation="0"/);
    expect(xml).toMatch(/<p:kiosk\/><p:sldRg st="2" end="3"\/><p:penClr>/);
    expect(xml).toContain("laserClr");
    const again = await roundTrip(pres);
    expect(P.getSlideShowSetup(again)).toMatchObject({
      showType: "kiosk",
      loop: true,
      showNarration: false,
      showAnimation: false,
      penColor: "#00FF00",
      laserColor: "#0000FF",
      showMediaControls: false,
      selection: { kind: "range", start: 2, end: 3 },
    });
    // The strict readers the show uses agree.
    expect(P.getSlideShowSelection(again)).toEqual({
      kind: "range",
      start: 2,
      end: 3,
    });
    expect(P.getSlideShowLaserColor(again)).toEqual({
      color: "#0000FF",
      opacity: 1,
    });
    expect(P.getSlideShowTimingOptions(again)).toEqual({
      useTimings: true,
      loop: true,
    });
  });

  it("changes only what it is given and keeps the rest", () => {
    const pres = deck();
    P.setSlideShowSetup(pres, { penColor: "#FF0000", loop: true });
    P.setSlideShowSetup(pres, { showType: "browse", showScrollbar: false });
    const setup = P.getSlideShowSetup(pres);
    expect(setup).toMatchObject({
      showType: "browse",
      showScrollbar: false,
      penColor: "#FF0000",
      loop: true,
    });
    P.setSlideShowSetup(pres, { penColor: null, useTimings: false });
    expect(P.getSlideShowSetup(pres).penColor).toBeNull();
    expect(P.getSlideShowTimingOptions(pres).useTimings).toBe(false);
  });

  it("creates presProps.xml when the file has none", async () => {
    const pres = deck(1);
    const pkg = pres[INTERNAL_PACKAGE];
    const rels = pkg.getRels(partName("/ppt/presentation.xml"));
    rels.items = rels.items.filter((r) => !r.type.endsWith("/presProps"));
    pkg.setRels(partName("/ppt/presentation.xml"), rels);
    pkg.removePart(partName("/ppt/presProps.xml"));
    P.setSlideShowSetup(pres, { loop: true });
    expect(P.getSlideShowSetup(await roundTrip(pres)).loop).toBe(true);
  });
});

describe("custom shows", () => {
  it("writes, reads, renames and removes custom shows", async () => {
    const pres = deck(4);
    const slides = P.getSlides(pres);
    const written = P.setCustomShows(pres, [
      { name: "Short & sweet", slides: [slides[2], slides[0]] },
      { name: "Again", slides: [slides[1], slides[1]] },
    ]);
    expect(written.map((s) => s.id)).toEqual([0, 1]);
    expect(presentationXml(pres)).toContain('name="Short &amp; sweet"');
    let again = await roundTrip(pres);
    let shows = P.getCustomShows(again);
    const parts = (show) => show.slides.map((s) => P.getSlidePartName(s));
    const names = P.getSlides(again).map((s) => P.getSlidePartName(s));
    expect(shows.map((s) => s.name)).toEqual(["Short & sweet", "Again"]);
    expect(parts(shows[0])).toEqual([names[2], names[0]]);
    expect(parts(shows[1])).toEqual([names[1], names[1]]);
    // The show plays a custom show; the strict reader resolves it.
    P.setSlideShowSetup(again, { selection: { kind: "custom", id: 1 } });
    expect(P.getSlideShowSelection(again)).toEqual({
      kind: "custom",
      id: 1,
      slidePartNames: [names[1], names[1]],
    });
    // Removing the show that plays sends the show back to all slides.
    P.setCustomShows(again, [shows[0]]);
    expect(P.getSlideShowSetup(again).selection).toEqual({ kind: "all" });
    P.setCustomShows(again, []);
    expect(presentationXml(again)).not.toContain("custShowLst");
  });

  it("drops a deleted slide from every custom show", async () => {
    const pres = deck(3);
    const slides = P.getSlides(pres);
    P.setCustomShows(pres, [
      { name: "One", slides: [slides[0], slides[1], slides[2]] },
    ]);
    P.removeSlide(pres, slides[1]);
    const shows = P.getCustomShows(pres);
    expect(shows[0].slides.map((s) => P.getSlidePartName(s))).toEqual([
      P.getSlidePartName(slides[0]),
      P.getSlidePartName(slides[2]),
    ]);
    P.setSlideShowSetup(pres, { selection: { kind: "custom", id: 0 } });
    expect(P.getSlideShowSelection(pres).slidePartNames).toHaveLength(2);
    // The file still opens.
    expect(
      P.getCustomShows(await parseDeck(await P.savePresentation(pres))),
    ).toHaveLength(1);
  });
});
