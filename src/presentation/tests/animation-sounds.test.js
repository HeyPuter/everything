import { describe, expect, it } from "vitest";
import { P, createDeck, parseDeck, shape, text } from "../src/model.js";
import { synthesizeSound } from "../src/transitions/sounds.js";

const id = (s) => String(P.getShapeId(s));
const xmlOf = (slide) => P.getSlideXmlString(slide);
const reload = async (pres) =>
  P.getSlides(await parseDeck(await P.savePresentation(pres)))[0];
const fade = (shapeId, extra = {}) => ({
  shapeId,
  presetClass: "entr",
  presetId: 10,
  presetSubtype: 0,
  start: "click",
  delayMs: 0,
  durationMs: 500,
  ...extra,
});

describe("animation sounds and after-effects", () => {
  it("writes an effect sound as an audio node and reads it back", async () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const box = shape(slide, 1, 1, 2, 1, "#336699");
    const bytes = synthesizeSound("chime");
    const relId = P.addSlideAnimationSound(slide, bytes, "Chime.wav");
    P.setSlideAnimations(slide, [
      fade(id(box), { sound: { relId, name: "Chime.wav" } }),
    ]);
    const xml = xmlOf(slide);
    expect(xml).toMatch(
      /<p:subTnLst><p:audio><p:cMediaNode><p:cTn [^>]*display="0"/,
    );
    expect(xml).toContain(`<p:sndTgt r:embed="${relId}" name="Chime.wav"/>`);
    // childTnLst comes before subTnLst (schema order).
    expect(xml.indexOf("</p:childTnLst><p:subTnLst>")).toBeGreaterThan(0);

    const back = await reload(pres);
    const [effect] = P.getSlideAnimations(back);
    expect(effect.sound).toEqual({ relId, name: "Chime.wav" });
    const data = P.getSlideAnimationSoundData(back, relId);
    expect(data.contentType).toBe("audio/wav");
    expect(data.bytes.length).toBe(bytes.length);

    // Changing the effect keeps the sound; removing it drops the media.
    P.setSlideAnimations(back, [{ ...effect, durationMs: 900 }]);
    expect(P.getSlideAnimations(back)[0].sound?.relId).toBe(relId);
    P.setSlideAnimations(back, [{ ...effect, sound: undefined }]);
    expect(xmlOf(back)).not.toContain("sndTgt");
    expect(P.getSlideAnimationSoundData(back, relId)).toBeNull();
  });

  it("puts the sound on the first paragraph of a text build only", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const body = text(slide, "One\nTwo\nThree", 4, 1, 4, 3);
    const relId = P.addSlideAnimationSound(slide, synthesizeSound("pop"));
    P.setSlideAnimations(slide, [
      fade(id(body), {
        sound: { relId },
        text: { by: "paragraph", level: 1 },
      }),
    ]);
    expect(xmlOf(slide).match(/<p:sndTgt/g)).toHaveLength(1);
    const [effect] = P.getSlideAnimations(slide);
    expect(effect.text?.by).toBe("paragraph");
    expect(effect.sound?.relId).toBe(relId);
  });

  it("hides on the next click with an onNext condition", async () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const box = shape(slide, 1, 1, 2, 1, "#336699");
    const other = shape(slide, 4, 1, 2, 1, "#993366");
    P.setSlideAnimations(slide, [
      fade(id(box), { after: { kind: "hideOnClick" } }),
      fade(id(other), { after: { kind: "hide" } }),
    ]);
    const xml = xmlOf(slide);
    expect(xml).toMatch(
      /afterEffect="1"><p:stCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt\/>/,
    );
    const back = await reload(pres);
    expect(P.getSlideAnimations(back).map((e) => e.after)).toEqual([
      { kind: "hideOnClick" },
      { kind: "hide" },
    ]);
  });
});
