import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";
import { NS } from "../lib/pptx/src/internal/xml/index.ts";
import { alternate, fixture } from "./slide-transition-fixture.js";

const transition = (value, effect = "fade") =>
  `<p:transition xmlns:duration="${NS.p14}" spd="slow" duration:dur="${value}"><p:${effect}/></p:transition>`;
const durationChoice = (
  content,
  fallback = '<p:transition spd="slow"><p:fade/></p:transition>',
) =>
  `<mc:AlternateContent xmlns:mc="${NS.mc}" xmlns:modern="${NS.p14}"><mc:Choice Requires="modern">${content}</mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent>`;

describe("authored slide-transition duration", () => {
  it.each([
    ["1780", 1780],
    ["0", 0],
    ["000.125", 0.125],
    ["1.75s", 1750],
    ["0.5min", 30000],
    ["0.25h", 900000],
    ["1250ms", 1250],
    ["750µs", 0.75],
    ["125000ns", 0.125],
    ["2S", 2000],
    ["5000000000", 5000000000],
    [`1${"0".repeat(309)}ns`, 1e303],
    [`0.${"0".repeat(329)}2h`, Number.MIN_VALUE],
  ])("reads namespace-scoped duration %s as %s ms", async (value, ms) => {
    const f = await fixture(transition(value));
    expect(P.getSlideTransition(f.slide)).toEqual({
      effect: "fade",
      speed: "slow",
      durationMs: ms,
    });
    expect(P.getEffectiveSlideTransition(f.slide)).toEqual(
      P.getSlideTransition(f.slide),
    );
  });
  it.each([
    "",
    "-1",
    "+2",
    ".5",
    "1.",
    "2 s",
    " 2s ",
    "2seconds",
    "NaN",
    "Infinity",
    "1e3",
    "indefinite",
    "1".repeat(400),
  ])(
    "leaves invalid duration %s unspecified and source bytes untouched",
    async (value) => {
      const f = await fixture(transition(value));
      const before = unzipSync(await P.savePresentation(f.pres));
      expect(P.getSlideTransition(f.slide)).toEqual({
        effect: "fade",
        speed: "slow",
      });
      expect(unzipSync(await P.savePresentation(f.pres))).toEqual(before);
    },
  );
  it("does not treat an unqualified or foreign duration as the p14 extension", async () => {
    const f = await fixture(
      '<p:transition xmlns:p14="urn:foreign" p14:dur="3100" dur="2000"><p:fade/></p:transition>',
    );
    expect(P.getSlideTransition(f.slide)).toEqual({ effect: "fade" });
  });
  it("selects a duration-only modern choice and retains every source alternative", async () => {
    const f = await fixture(durationChoice(transition("2.75s", "push")));
    const before = unzipSync(await P.savePresentation(f.pres));
    expect(P.getSlideTransition(f.slide)).toEqual({
      effect: "push",
      speed: "slow",
      durationMs: 2750,
    });
    expect(unzipSync(await P.savePresentation(f.pres))).toEqual(before);
  });
  it.each([
    '<modern:sparkle dir="in"/>',
    "<modern:unknown/>",
    '<p:fade modern:future="1"/>',
  ])(
    "keeps fallback when a modern choice includes unsupported features: %s",
    async (child) => {
      const f = await fixture(
        durationChoice(
          `<p:transition modern:dur="4300">${child}</p:transition>`,
        ),
      );
      expect(P.getSlideTransition(f.slide)).toEqual({
        effect: "fade",
        speed: "slow",
      });
    },
  );
  it("selects the next understood choice without taking duration from an unsupported one", async () => {
    const f = await fixture(
      `<mc:AlternateContent xmlns:mc="${NS.mc}" xmlns:modern="${NS.p14}"><mc:Choice Requires="modern"><p:transition modern:dur="9900"><modern:sparkle/></p:transition></mc:Choice><mc:Choice Requires="modern">${transition("1475", "push")}</mc:Choice><mc:Fallback><p:transition><p:zoom/></p:transition></mc:Fallback></mc:AlternateContent>`,
    );
    expect(P.getSlideTransition(f.slide)).toEqual({
      effect: "push",
      speed: "slow",
      durationMs: 1475,
    });
  });
  it("resolves nested compatible alternatives without inspecting unused branches", async () => {
    const nested = `<p:transition modern:dur="1800">${alternate("<p:zoom/>", "<p:push/>")}</p:transition>`;
    const f = await fixture(durationChoice(nested));
    expect(P.getSlideTransition(f.slide)).toEqual({
      effect: "push",
      durationMs: 1800,
    });
  });
  it("selects alternatives for a consumer's effect capabilities without blending branches", async () => {
    const f = await fixture(durationChoice(transition("2700", "cover")));
    expect(P.getSlideTransition(f.slide)).toEqual({
      effect: "cover",
      speed: "slow",
      durationMs: 2700,
    });
    const options = {
      supportedEffects: new Set(["none", "fade", "push", "zoom"]),
    };
    expect(P.getSlideTransition(f.slide, options)).toEqual({
      effect: "fade",
      speed: "slow",
    });
    expect(P.getEffectiveSlideTransition(f.slide, options)).toEqual({
      effect: "fade",
      speed: "slow",
    });
    const direct = await fixture(transition("2100", "cover"));
    expect(P.getSlideTransition(direct.slide, options)).toEqual({
      effect: "cover",
      speed: "slow",
      durationMs: 2100,
    });
  });
  it("inherits the nearest transition duration as a whole", async () => {
    const f = await fixture("", {
      layout: transition("2s", "push"),
      master: transition("3s", "zoom"),
    });
    expect(P.getSlideTransition(f.slide)).toBeNull();
    expect(P.getEffectiveSlideTransition(f.slide)).toEqual({
      effect: "push",
      speed: "slow",
      durationMs: 2000,
    });
    P.setSlideTransition(f.slide, { effect: "fade" });
    expect(P.getEffectiveSlideTransition(f.slide)).toEqual({ effect: "fade" });
    P.clearSlideTransition(f.slide);
    expect(P.getEffectiveSlideTransition(f.slide).durationMs).toBe(2000);
  });
  it.each([0, 1275, 0.0000001, 1e25, Number.MIN_VALUE, Number.MAX_VALUE])(
    "writes valid duration %s and exports native metadata",
    async (durationMs) => {
      const f = await fixture("");
      P.setSlideTransition(f.slide, {
        effect: "push",
        durationMs,
        advanceAfterMs: 2300,
        advanceOnClick: false,
      });
      expect(P.getSlideTransition(f.slide)).toEqual({
        effect: "push",
        durationMs,
        advanceAfterMs: 2300,
        advanceOnClick: false,
      });
      const xml = P.getSlideXmlString(f.slide);
      expect(xml).toContain(NS.p14);
      expect(xml).not.toMatch(/dur="[^\"]*[eE][+-]/);
      const restored = await parseDeck(await P.savePresentation(f.pres));
      expect(P.getSlideTransition(P.getSlides(restored)[0])).toEqual(
        P.getSlideTransition(f.slide),
      );
    },
  );
  it.each([-1, NaN, Infinity, -Infinity])(
    "rejects invalid authored duration %s before any mutation",
    async (durationMs) => {
      const f = await fixture(transition("1500"));
      const before = P.getSlideXmlString(f.slide);
      expect(() =>
        P.setSlideTransition(f.slide, { effect: "push", durationMs }),
      ).toThrow();
      expect(P.getSlideXmlString(f.slide)).toBe(before);
    },
  );
  it("retains duration across edits, duplicate, imports both ways and export", async () => {
    const f = await fixture(durationChoice(transition("2.25s")));
    const duplicate = P.duplicateSlide(f.pres, f.slide);
    P.setSlideTransition(duplicate, {
      ...P.getSlideTransition(duplicate),
      effect: "push",
      direction: "r",
    });
    const target = createDeck("blank");
    const copied = P.importSlide(
      target,
      duplicate,
      P.getSlideLayouts(target)[0],
    );
    const returned = P.importSlide(f.pres, copied, P.getSlideLayout(f.slide));
    const restored = await parseDeck(await P.savePresentation(f.pres));
    for (const slide of [duplicate, copied, returned, ...P.getSlides(restored)])
      expect(P.getEffectiveSlideTransition(slide).durationMs).toBe(2250);
  });
});
