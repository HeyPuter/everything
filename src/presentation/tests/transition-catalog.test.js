// The full transition set: every gallery entry and option writes standard
// markup (extension effects inside compatibility alternatives) that reads
// back as the same entry and option, survives a save and reopen, and keeps
// sound, duration and advance timing.
import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";
import {
  PLAYABLE_EFFECTS,
  TRANSITIONS,
  TRANSITION_GROUPS,
  identifyTransition,
  transitionFor,
  withDefaults,
} from "../src/transitions/catalog.js";
import { alternate, fixture } from "./slide-transition-fixture.js";
import { NS } from "../lib/pptx/src/internal/xml/index.ts";
import {
  BUILT_IN_SOUNDS,
  builtInSoundNamed,
  soundFileName,
  synthesizeSound,
} from "../src/transitions/sounds.js";

const deck = () => {
  const pres = createDeck("blank");
  return { pres, slide: P.getSlides(pres)[0] };
};
const roundTrip = async (pres) => parseDeck(await P.savePresentation(pres));

describe("transition gallery", () => {
  it("offers every transition once, in three groups", () => {
    const ids = TRANSITIONS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TRANSITION_GROUPS.map((g) => g.label)).toEqual([
      "Subtle",
      "Exciting",
      "Dynamic Content",
    ]);
    const labels = (group) =>
      TRANSITIONS.filter((t) => t.group === group).map((t) => t.label);
    expect(labels("subtle")).toEqual([
      "None",
      "Morph",
      "Fade",
      "Push",
      "Wipe",
      "Split",
      "Reveal",
      "Cut",
      "Random Bars",
      "Shape",
      "Uncover",
      "Cover",
      "Flash",
    ]);
    expect(labels("exciting")).toHaveLength(29);
    expect(labels("dynamic")).toEqual([
      "Pan",
      "Ferris Wheel",
      "Conveyor",
      "Rotate",
      "Window",
      "Orbit",
      "Fly Through",
    ]);
  });

  const cases = TRANSITIONS.filter((t) => t.id !== "none").flatMap((entry) =>
    (entry.options || [{ id: null, label: "(default)" }]).map((option) => [
      entry.id,
      option.id,
      `${entry.label} ${option.label}`,
    ]),
  );
  it.each(cases)(
    "%s / %s writes markup that reads back and survives a save",
    async (id, option) => {
      const { pres, slide } = deck();
      const t = transitionFor(id, option, {
        advanceAfterMs: 3000,
        advanceOnClick: false,
      });
      P.setSlideTransition(slide, t);
      const back = P.getSlideTransition(slide);
      expect(PLAYABLE_EFFECTS.has(back.effect)).toBe(true);
      expect(identifyTransition(back)).toEqual({
        id,
        option: option ?? null,
      });
      expect(back.advanceAfterMs).toBe(3000);
      expect(back.advanceOnClick).toBe(false);
      expect(back.durationMs).toBe(t.durationMs);
      const restored = P.getSlides(await roundTrip(pres))[0];
      expect(P.getSlideTransition(restored)).toEqual(back);
      // Every transition carries a duration, so it is wrapped in an
      // alternative whose fallback has only base markup.
      const xml = P.getSlideXmlString(restored);
      expect(xml).toContain("<mc:AlternateContent");
      const fallback = xml.match(/<mc:Fallback>([\s\S]*?)<\/mc:Fallback>/)[1];
      expect(fallback).not.toMatch(/p1[45]9?:/);
      expect(fallback).toMatch(/<p:transition\b/);
    },
  );
});

describe("extension effect markup", () => {
  it("writes 2010 effects in p14 with a fade for older readers", () => {
    const { slide } = deck();
    P.setSlideTransition(slide, {
      effect: "vortex",
      direction: "r",
      durationMs: 3000,
      speed: "slow",
    });
    const xml = P.getSlideXmlString(slide);
    expect(xml).toMatch(
      /<mc:Choice Requires="p14"><p:transition spd="slow" p14:dur="3000"><p14:vortex dir="r"\/><\/p:transition><\/mc:Choice><mc:Fallback><p:transition spd="slow"><p:fade\/><\/p:transition><\/mc:Fallback>/,
    );
  });
  it("writes morph in p159 and its option", () => {
    const { slide } = deck();
    P.setSlideTransition(slide, {
      effect: "morph",
      morphOption: "byWord",
      durationMs: 2000,
    });
    const xml = P.getSlideXmlString(slide);
    expect(xml).toContain(`xmlns:p159="${NS.p159}"`);
    expect(xml).toMatch(/Requires="p159 p14"/);
    expect(xml).toContain('<p159:morph option="byWord"/>');
    expect(P.getSlideTransition(slide)).toMatchObject({
      effect: "morph",
      morphOption: "byWord",
    });
  });
  it("writes presets, prism flags and patterns", () => {
    const { slide } = deck();
    for (const [options, markup] of [
      [
        { effect: "airplane", invertX: true },
        '<p15:prstTrans prst="airplane" invX="1"/>',
      ],
      [
        { effect: "prism", isContent: true, isInverted: true, direction: "u" },
        '<p14:prism dir="u" isContent="1" isInverted="1"/>',
      ],
      [
        { effect: "glitter", pattern: "hexagon", direction: "d" },
        '<p14:glitter dir="d" pattern="hexagon"/>',
      ],
      [
        { effect: "shred", pattern: "rectangle", direction: "out" },
        '<p14:shred dir="out" pattern="rectangle"/>',
      ],
      [{ effect: "wheelReverse", spokes: 1 }, '<p14:wheelReverse spokes="1"/>'],
      [
        { effect: "flythrough", direction: "out", hasBounce: true },
        '<p14:flythrough dir="out" hasBounce="1"/>',
      ],
      [
        { effect: "reveal", thruBlack: true, direction: "r" },
        '<p14:reveal dir="r" thruBlk="1"/>',
      ],
    ]) {
      P.setSlideTransition(slide, options);
      expect(P.getSlideXmlString(slide)).toContain(markup);
      expect(withDefaults(P.getSlideTransition(slide))).toMatchObject(
        withDefaults(options),
      );
    }
  });
  it("rejects attribute values outside an effect's domain", () => {
    const { slide } = deck();
    expect(() =>
      P.setSlideTransition(slide, { effect: "ferris", direction: "u" }),
    ).toThrow(/not valid/);
    expect(() =>
      P.setSlideTransition(slide, { effect: "glitter", pattern: "stars" }),
    ).toThrow();
    expect(() =>
      P.setSlideTransition(slide, { effect: "morph", morphOption: "byLine" }),
    ).toThrow();
  });
  it("reads effects a desktop editor wrote", async () => {
    const f = await fixture(
      `<mc:AlternateContent xmlns:mc="${NS.mc}"><mc:Choice xmlns:p14="${NS.p14}" Requires="p14"><p:transition spd="slow" p14:dur="1250"><p14:prism isContent="1"/></p:transition></mc:Choice><mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>`,
    );
    const t = P.getSlideTransition(f.slide);
    expect(t).toEqual({
      effect: "prism",
      isContent: true,
      speed: "slow",
      durationMs: 1250,
    });
    expect(identifyTransition(t)).toEqual({ id: "rotate", option: "l" });
  });
  it("keeps an unknown effect as authored and identifies it as other", async () => {
    const f = await fixture(
      alternate('<p:transition><new:prstTrans prst="future"/></p:transition>'),
    );
    // The reader falls back to the authored fade.
    expect(identifyTransition(P.getSlideTransition(f.slide)).id).toBe("fade");
    const g = await fixture(
      `<p:transition xmlns:p14="${NS.p14}"><p14:sparkle/></p:transition>`,
    );
    expect(identifyTransition(P.getSlideTransition(g.slide)).id).toBe("none");
  });
});

describe("transition timing edits", () => {
  it("changes duration and advance in place, keeping unknown alternatives", async () => {
    const f = await fixture(
      alternate(
        `<p:transition xmlns:p14="${NS.p14}" p14:dur="900"><new:effect/></p:transition>`,
      ),
    );
    P.setSlideTransitionTiming(f.slide, {
      durationMs: 2500,
      advanceAfterMs: 4000,
      advanceOnClick: false,
    });
    const xml = P.getSlideXmlString(f.slide);
    expect(xml).toContain("<new:effect/>");
    expect(xml).toMatch(/<p:transition[^>]*p14:dur="2500"[^>]*><new:effect/);
    expect(P.getSlideTransition(f.slide)).toEqual({
      effect: "fade",
      speed: "slow",
      advanceOnClick: false,
      advanceAfterMs: 4000,
    });
    // The fallback never takes the extension's duration.
    expect(xml.match(/<mc:Fallback>[\s\S]*<\/mc:Fallback>/)[0]).not.toContain(
      "p14:dur",
    );
    P.setSlideTransitionTiming(f.slide, { advanceAfterMs: null });
    expect(P.getSlideTransition(f.slide).advanceAfterMs).toBeUndefined();
    const restored = P.getSlides(await roundTrip(f.pres))[0];
    expect(P.getSlideXmlString(restored)).toContain("<new:effect/>");
  });
  it("adds a duration to a plain transition by wrapping it", () => {
    const { slide } = deck();
    P.setSlideTransition(slide, { effect: "push", direction: "u" });
    P.setSlideTransitionTiming(slide, { durationMs: 1800 });
    expect(P.getSlideTransition(slide)).toEqual({
      effect: "push",
      direction: "u",
      durationMs: 1800,
    });
    expect(P.getSlideXmlString(slide)).toContain("<mc:AlternateContent");
  });
  it("starts a slide transition from an inherited one", async () => {
    const f = await fixture("", {
      layout: '<p:transition spd="med"><p:wipe dir="d"/></p:transition>',
    });
    P.setSlideTransitionTiming(f.slide, { advanceAfterMs: 1000 });
    expect(P.getSlideTransition(f.slide)).toEqual({
      effect: "wipe",
      direction: "d",
      speed: "med",
      advanceAfterMs: 1000,
    });
  });
});

describe("transition sounds", () => {
  it("synthesizes each built-in sound as a WAV file", () => {
    for (const sound of BUILT_IN_SOUNDS) {
      const bytes = synthesizeSound(sound.id);
      expect(strFromU8(bytes.subarray(0, 4))).toBe("RIFF");
      expect(strFromU8(bytes.subarray(8, 12))).toBe("WAVE");
      expect(bytes.length).toBeGreaterThan(44 + 100);
      expect(builtInSoundNamed(soundFileName(sound))).toBe(sound);
      // Deterministic: the same sound every time.
      expect(synthesizeSound(sound.id)).toEqual(bytes);
    }
  });
  it("embeds a sound, writes p:sndAc in every branch and reads its audio", async () => {
    const { pres, slide } = deck();
    const bytes = synthesizeSound("chime");
    const relId = P.addSlideTransitionSound(slide, bytes, "Chime.wav");
    P.setSlideTransition(slide, {
      effect: "vortex",
      durationMs: 3000,
      sound: { kind: "start", relId, name: "Chime.wav", loop: true },
    });
    const xml = P.getSlideXmlString(slide);
    expect(xml.match(/<p:sndAc>/g)).toHaveLength(2);
    expect(xml).toContain(
      `<p:stSnd loop="1"><p:snd r:embed="${relId}" name="Chime.wav"/></p:stSnd>`,
    );
    const saved = await P.savePresentation(pres);
    const files = unzipSync(saved);
    expect(strFromU8(files["[Content_Types].xml"])).toContain(
      'Extension="wav" ContentType="audio/wav"',
    );
    const rels = strFromU8(files["ppt/slides/_rels/slide1.xml.rels"]);
    expect(rels).toContain(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio",
    );
    const restored = P.getSlides(await parseDeck(saved))[0];
    expect(P.getSlideTransition(restored).sound).toEqual({
      kind: "start",
      relId,
      name: "Chime.wav",
      loop: true,
    });
    const data = P.getSlideTransitionSoundData(restored);
    expect(data.bytes).toEqual(bytes);
    expect(data.loop).toBe(true);
    expect(data.contentType).toBe("audio/wav");
  });
  it("removes a sound's media when the slide stops using it", async () => {
    const { pres, slide } = deck();
    const relId = P.addSlideTransitionSound(
      slide,
      synthesizeSound("pop"),
      "Pop.wav",
    );
    P.setSlideTransition(slide, {
      effect: "fade",
      sound: { kind: "start", relId, name: "Pop.wav" },
    });
    P.setSlideTransition(slide, { effect: "fade", sound: { kind: "stop" } });
    expect(P.getSlideTransition(slide).sound).toEqual({ kind: "stop" });
    const files = unzipSync(await P.savePresentation(pres));
    expect(Object.keys(files).some((name) => name.includes("audio"))).toBe(
      false,
    );
  });
  it("shares a sound between slides and keeps it while either uses it", async () => {
    const { pres, slide } = deck();
    const other = P.addBlankSlide(pres);
    const relId = P.addSlideTransitionSound(
      slide,
      synthesizeSound("click"),
      "Click.wav",
    );
    const sound = { kind: "start", relId, name: "Click.wav" };
    P.setSlideTransition(slide, { effect: "fade", sound });
    const shared = P.shareSlideTransitionSound(slide, relId, other);
    P.setSlideTransition(other, {
      effect: "push",
      sound: { ...sound, relId: shared },
    });
    P.clearSlideTransition(slide);
    const restored = P.getSlides(await roundTrip(pres));
    expect(P.getSlideTransitionSoundData(restored[1]).bytes).toEqual(
      synthesizeSound("click"),
    );
  });
  it("keeps the sound through duplication", async () => {
    const { pres, slide } = deck();
    const relId = P.addSlideTransitionSound(
      slide,
      synthesizeSound("drum"),
      "Drum.wav",
    );
    P.setSlideTransition(slide, {
      effect: "fade",
      sound: { kind: "start", relId, name: "Drum.wav" },
    });
    const copy = P.duplicateSlide(pres, slide);
    expect(P.getSlideTransitionSoundData(copy)?.name).toBe("Drum.wav");
  });
});
