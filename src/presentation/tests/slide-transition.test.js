import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { P, parseDeck } from "../src/model.js";

import { alternate, fixture } from "./slide-transition-fixture.js";
import { INTERNAL_PACKAGE } from "../lib/pptx/src/api/_internal-symbols.ts";
import { partName } from "../lib/pptx/src/internal/opc/index.ts";
import { strFromU8, strToU8 } from "fflate";

describe("transitions in markup compatibility alternatives", () => {
  it("reads the authored fallback without changing the package", async () => {
    const f = await fixture(
      alternate('<p:transition><new:prstTrans prst="future"/></p:transition>'),
    );
    const before = unzipSync(await P.savePresentation(f.pres));
    expect(P.getSlideTransition(f.slide)).toEqual({
      effect: "fade",
      speed: "slow",
      advanceAfterMs: 7300,
    });
    expect(unzipSync(await P.savePresentation(f.pres))).toEqual(before);
  });
  it.each(["replace", "clear"])(
    "%s removes obsolete transitions in every branch on export",
    async (action) => {
      const f = await fixture(
        alternate(
          '<p:transition><new:prstTrans prst="future"/></p:transition>',
        ),
      );
      if (action === "clear") P.clearSlideTransition(f.slide);
      else
        P.setSlideTransition(f.slide, {
          effect: "push",
          direction: "u",
          speed: "fast",
        });
      const bytes = await P.savePresentation(f.pres),
        restored = await parseDeck(bytes);
      const xml = P.getSlideXmlString(P.getSlides(restored)[0]);
      expect(xml).not.toContain("future-transition");
      expect(xml.match(/<p:transition\b/g)?.length ?? 0).toBe(
        action === "clear" ? 0 : 1,
      );
      expect(P.getSlideTransition(P.getSlides(restored)[0])).toEqual(
        action === "clear"
          ? null
          : { effect: "push", direction: "u", speed: "fast" },
      );
    },
  );
  it("preserves unrelated content in compatibility branches and nested extension lists", async () => {
    const f = await fixture(
      alternate(
        "<p:transition><new:effect/></p:transition><p:timing><p:tnLst/></p:timing>",
        '<p:transition><p:fade/></p:transition><p:extLst><p:ext uri="kept"><p:transition><p:cut/></p:transition></p:ext></p:extLst>',
      ),
    );
    P.clearSlideTransition(f.slide);
    const restored = await parseDeck(await P.savePresentation(f.pres));
    const xml = P.getSlideXmlString(P.getSlides(restored)[0]);
    expect(xml).toContain("<p:timing><p:tnLst/></p:timing>");
    expect(xml).toContain(
      '<p:ext uri="kept"><p:transition><p:cut/></p:transition></p:ext>',
    );
    expect(xml).not.toContain("<new:effect");
    expect(P.getSlideTransition(P.getSlides(restored)[0])).toBeNull();
  });
  it("preserves unrelated empty alternatives", async () => {
    const empty = alternate("", "");
    const f = await fixture(empty + "<p:transition><p:fade/></p:transition>");
    const before = P.getSlideXmlString(f.slide).match(
      /<mc:AlternateContent[\s\S]*?<\/mc:AlternateContent>/,
    )[0];
    P.clearSlideTransition(f.slide);
    expect(P.getSlideXmlString(f.slide)).toContain(before);
  });
  it("reads nested alternatives and removes transitions from all of them", async () => {
    const nested = alternate("<p:transition><new:effect/></p:transition>");
    const f = await fixture(
      alternate("<p:transition><new:effect/></p:transition>", nested),
    );
    expect(P.getSlideTransition(f.slide)?.effect).toBe("fade");
    P.setSlideTransition(f.slide, { effect: "zoom", direction: "out" });
    expect(P.getSlideXmlString(f.slide)).not.toContain("AlternateContent");
    expect(P.getSlideTransition(f.slide)).toEqual({
      effect: "zoom",
      direction: "out",
    });
  });
  it("keeps replacement in the slide schema order with a wrapped color map", async () => {
    const f = await fixture(
      alternate("", "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>") +
        "<p:timing><p:tnLst/></p:timing><p:extLst/>",
    );
    P.setSlideTransition(f.slide, { effect: "fade" });
    const xml = P.getSlideXmlString(f.slide);
    expect(xml.indexOf("<p:transition")).toBeGreaterThan(
      xml.indexOf("</mc:AlternateContent>"),
    );
    expect(xml.indexOf("<p:transition")).toBeLessThan(xml.indexOf("<p:timing"));
  });
  it("rejects an invalid replacement without removing the original transition", async () => {
    const f = await fixture(
      alternate("<p:transition><new:effect/></p:transition>"),
    );
    const before = P.getSlideXmlString(f.slide);
    expect(() =>
      P.setSlideTransition(f.slide, { effect: "invented-effect" }),
    ).toThrow();
    expect(P.getSlideXmlString(f.slide)).toBe(before);
  });
  it("preserves every branch when duplicating a slide and exporting it", async () => {
    const f = await fixture(
      alternate("<p:transition><new:effect/></p:transition>"),
    );
    const copy = P.duplicateSlide(f.pres, f.slide);
    expect(P.getSlideTransition(copy)).toEqual(P.getSlideTransition(f.slide));
    const restored = await parseDeck(await P.savePresentation(f.pres));
    for (const slide of P.getSlides(restored)) {
      expect(P.getSlideXmlString(slide)).toContain("<new:effect/>");
      expect(P.getSlideTransition(slide)?.effect).toBe("fade");
    }
  });
  it.each(["fade", "push", "zoom"])(
    "keeps direct %s transitions working",
    async (effect) => {
      const f = await fixture(
        '<p:transition spd="fast" advClick="0" advTm="1900"><p:' +
          effect +
          "/></p:transition>",
      );
      expect(P.getSlideTransition(f.slide)).toEqual({
        effect,
        speed: "fast",
        advanceOnClick: false,
        advanceAfterMs: 1900,
      });
      P.clearSlideTransition(f.slide);
      expect(P.getSlideTransition(f.slide)).toBeNull();
    },
  );
  it("reads effect alternatives with namespace declarations inherited from the selected branch", async () => {
    const f = await fixture(
      `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:base="http://schemas.openxmlformats.org/presentationml/2006/main" Requires="base"><p:transition spd="med"><mc:AlternateContent><mc:Choice Requires="base"><p:push dir="r"/></mc:Choice><mc:Fallback><p:fade/></mc:Fallback></mc:AlternateContent></p:transition></mc:Choice></mc:AlternateContent>`,
    );
    expect(P.getSlideTransition(f.slide)).toEqual({
      effect: "push",
      direction: "r",
      speed: "med",
    });
  });
});

describe("transition inheritance and explicit no-effect overrides", () => {
  it.each(["garbage", "", "2.5", "-1", "4294967296", "1e3"])(
    "does not propagate malformed timing (%s) through an effect edit",
    async (time) => {
      const f = await fixture("", {
        layout: `<p:transition spd="invalid" advTm="${time}"><p:fade/></p:transition>`,
      });
      expect(P.getEffectiveSlideTransition(f.slide)).toEqual({
        effect: "fade",
      });
      P.setSlideTransition(f.slide, {
        ...P.getEffectiveSlideTransition(f.slide),
        effect: "none",
      });
      expect(P.getSlideTransition(f.slide)).toEqual({ effect: "none" });
    },
  );
  it.each(["0", "+0", " 4700 ", "4294967295"])(
    "retains valid unsigned timing (%s)",
    async (time) => {
      const f = await fixture(`<p:transition advTm="${time}"/>`);
      expect(P.getSlideTransition(f.slide)).toEqual({
        effect: "none",
        advanceAfterMs: Number(time),
      });
    },
  );
  const master =
    '<p:transition spd="slow" advClick="0" advTm="4700"><p:fade/></p:transition>';
  const layout = '<p:transition spd="fast"><p:push dir="d"/></p:transition>';
  it.each([
    [
      "",
      "",
      master,
      {
        effect: "fade",
        speed: "slow",
        advanceOnClick: false,
        advanceAfterMs: 4700,
      },
    ],
    ["", layout, master, { effect: "push", speed: "fast", direction: "d" }],
    [
      '<p:transition><p:zoom dir="out"/></p:transition>',
      layout,
      master,
      { effect: "zoom", direction: "out" },
    ],
    ["<p:transition/>", layout, master, { effect: "none" }],
    ["", "<p:transition/>", master, { effect: "none" }],
    ["", "", "", null],
  ])(
    "resolves the nearest complete element (%s, %s)",
    async (own, layout, master, expected) => {
      const f = await fixture(own, { layout, master });
      const before = unzipSync(await P.savePresentation(f.pres));
      expect(P.getEffectiveSlideTransition(f.slide)).toEqual(expected);
      if (!own) expect(P.getSlideTransition(f.slide)).toBeNull();
      expect(unzipSync(await P.savePresentation(f.pres))).toEqual(before);
      const restored = await parseDeck(await P.savePresentation(f.pres));
      expect(P.getEffectiveSlideTransition(P.getSlides(restored)[0])).toEqual(
        expected,
      );
    },
  );
  it.each(["layout", "master"])(
    "selects compatibility alternatives on the %s",
    async (level) => {
      const f = await fixture("", {
        [level]: alternate("<p:transition><new:effect/></p:transition>"),
      });
      expect(P.getEffectiveSlideTransition(f.slide)).toEqual({
        effect: "fade",
        speed: "slow",
        advanceAfterMs: 7300,
      });
    },
  );
  it("distinguishes explicit none with sound/timing metadata from removal", async () => {
    const f = await fixture(
      '<p:transition advClick="0" advTm="2300"><p:sndAc><p:endSnd/></p:sndAc><p:extLst/></p:transition>',
      { layout, master },
    );
    expect(P.getSlideTransition(f.slide)).toEqual({
      effect: "none",
      sound: { kind: "stop" },
      advanceOnClick: false,
      advanceAfterMs: 2300,
    });
    expect(P.getEffectiveSlideTransition(f.slide)).toEqual(
      P.getSlideTransition(f.slide),
    );
    P.clearSlideTransition(f.slide);
    expect(P.getSlideTransition(f.slide)).toBeNull();
    expect(P.getEffectiveSlideTransition(f.slide)).toEqual({
      effect: "push",
      speed: "fast",
      direction: "d",
    });
    P.setSlideTransition(f.slide, { effect: "none", advanceAfterMs: 1700 });
    const restored = await parseDeck(await P.savePresentation(f.pres));
    expect(P.getEffectiveSlideTransition(P.getSlides(restored)[0])).toEqual({
      effect: "none",
      advanceAfterMs: 1700,
    });
    const files = unzipSync(await P.savePresentation(f.pres));
    expect(files[f.layoutName]).toEqual(unzipSync(f.bytes)[f.layoutName]);
    expect(files[f.masterName]).toEqual(unzipSync(f.bytes)[f.masterName]);
  });
  it("reads the XML boolean spellings on inherited transitions", async () => {
    const f = await fixture("", {
      layout:
        '<p:transition advClick="false"><p:fade thruBlk="true"/></p:transition>',
    });
    expect(P.getEffectiveSlideTransition(f.slide)).toEqual({
      effect: "fade",
      thruBlack: true,
      advanceOnClick: false,
    });
  });
  it("updates after layout rebinding and master byte replacement, isolating packages", async () => {
    const f = await fixture("", { layout, master });
    const other = await fixture("", {
      master: "<p:transition><p:cut/></p:transition>",
    });
    expect(P.getEffectiveSlideTransition(f.slide)?.effect).toBe("push");
    const unused = P.getSlideLayouts(f.pres).find(
      (l) => P.getSlideLayoutPartName(l).slice(1) !== f.layoutName,
    );
    P.setSlideLayout(f.slide, unused);
    expect(P.getEffectiveSlideTransition(f.slide)?.effect).toBe("fade");
    const masterPart = f.pres[INTERNAL_PACKAGE].getPart(
      partName("/" + f.masterName),
    );
    masterPart.data = strToU8(
      strFromU8(masterPart.data).replace("<p:fade/>", '<p:wipe dir="r"/>'),
    );
    expect(P.getEffectiveSlideTransition(f.slide)?.effect).toBe("wipe");
    expect(P.getEffectiveSlideTransition(other.slide)?.effect).toBe("cut");
  });
  it("does not borrow unrelated masters when relationships or parts are missing", async () => {
    const f = await fixture("", { master });
    const pkg = f.pres[INTERNAL_PACKAGE];
    const rels = pkg.getRels(partName("/" + f.layoutName));
    rels.items = [];
    pkg.setRels(partName("/" + f.layoutName), rels);
    expect(P.getEffectiveSlideTransition(f.slide)).toBeNull();
    const slideRels = pkg.getRels(partName(P.getSlidePartName(f.slide)));
    slideRels.items[0].target = "../slideLayouts/missing.xml";
    pkg.setRels(partName(P.getSlidePartName(f.slide)), slideRels);
    expect(P.getEffectiveSlideTransition(f.slide)).toBeNull();
  });
  it("duplicates inherited transitions and copies explicit none between presentations", async () => {
    const f = await fixture("", { layout, master });
    const duplicate = P.duplicateSlide(f.pres, f.slide);
    expect(P.getSlideTransition(duplicate)).toBeNull();
    expect(P.getEffectiveSlideTransition(duplicate)).toEqual(
      P.getEffectiveSlideTransition(f.slide),
    );
    P.setSlideTransition(duplicate, { effect: "none" });
    const target = await fixture("", { layout: master });
    const copied = P.importSlide(
      target.pres,
      duplicate,
      P.getSlideLayout(target.slide),
    );
    expect(P.getEffectiveSlideTransition(copied)).toEqual({ effect: "none" });
    const back = P.importSlide(f.pres, copied, P.getSlideLayout(f.slide));
    const restored = await parseDeck(await P.savePresentation(f.pres));
    expect(
      P.getEffectiveSlideTransition(
        P.getSlides(restored).find(
          (s) => P.getSlidePartName(s) === P.getSlidePartName(back),
        ),
      ),
    ).toEqual({ effect: "none" });
  });
});
