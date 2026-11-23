import { describe, expect, it } from "vitest";
import {
  planPicture,
  collectPictures,
} from "../src/export/compress-pictures.js";
import {
  ease,
  showTimeline,
  transitionDuration,
} from "../src/export/transition-frames.js";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  P,
  createDeck,
  dedupeSlideMedia,
  parseDeck,
  pruneUnusedMedia,
} from "../src/model.js";

const INCH = 914400;
const use = (w, h, crop = null, kind = "picture") => ({
  kind,
  w: w * INCH,
  h: h * INCH,
  crop,
});

describe("compress pictures planning", () => {
  it("scales a picture down to what its largest use needs", () => {
    const plan = planPicture(
      { uses: [use(2, 1.5), use(1, 0.75)] },
      { width: 1600, height: 1200 },
      { ppi: 96 },
    );
    expect(plan).toMatchObject({ width: 192, height: 144, trims: false });
  });
  it("never enlarges, and leaves a small enough picture alone", () => {
    expect(
      planPicture(
        { uses: [use(4, 3)] },
        { width: 200, height: 150 },
        { ppi: 220 },
      ),
    ).toBeNull();
  });
  it("deletes cropped areas when every use crops the same way", () => {
    const crop = { left: 0.25, top: 0, right: 0.25, bottom: 0.5 };
    const plan = planPicture(
      { uses: [use(1, 1, crop)] },
      { width: 1000, height: 1000 },
      { ppi: null, deleteCropped: true },
    );
    expect(plan).toMatchObject({
      trims: true,
      keep: { x: 250, y: 0, w: 500, h: 500 },
      width: 500,
      height: 500,
    });
  });
  it("keeps cropped areas a different use or a fill still shows", () => {
    const crop = { left: 0.5 };
    expect(
      planPicture(
        { uses: [use(1, 1, crop), use(1, 1)] },
        { width: 100, height: 100 },
        { ppi: null, deleteCropped: true },
      ),
    ).toBeNull();
    expect(
      planPicture(
        { uses: [use(1, 1, crop), use(13.3, 7.5, null, "other")] },
        { width: 100, height: 100 },
        { ppi: null, deleteCropped: true },
      ),
    ).toBeNull();
  });
  it("finds each picture's uses with their sizes", () => {
    const deck = createDeck("blank");
    const [s] = P.getSlides(deck);
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    const picture = P.addSlideImage(s, png, {
      x: 0,
      y: 0,
      w: 2 * INCH,
      h: INCH,
    });
    const [entry] = collectPictures(P, deck, {
      bounds: (shape) => P.getShapeBounds(shape),
      selection: new Set([`${P.getSlidePartName(s)}#${P.getShapeId(picture)}`]),
    });
    expect(entry.contentType).toBe("image/png");
    expect(entry.selected).toBe(true);
    expect(entry.uses).toEqual([
      expect.objectContaining({ kind: "picture", w: 2 * INCH, h: INCH }),
    ]);
  });
});

describe("compress pictures uses", () => {
  const png = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const croppedPicture = () => {
    const deck = createDeck("blank");
    const [s] = P.getSlides(deck);
    const picture = P.addSlideImage(s, png, {
      x: 0,
      y: 0,
      w: INCH,
      h: INCH,
    });
    P.setShapeImageCrop(picture, {
      left: 0.25,
      top: 0,
      right: 0.25,
      bottom: 0,
    });
    return deck;
  };
  const plan = (deck) => {
    const [entry] = collectPictures(P, deck, {
      bounds: (shape) => P.getShapeBounds(shape),
    });
    return {
      kinds: entry.uses.map((u) => u.kind),
      plan: planPicture(
        entry,
        { width: 2000, height: 2000 },
        { ppi: 150, deleteCropped: true },
      ),
    };
  };
  it("counts a slide background of the picture's own image", async () => {
    const deck = croppedPicture();
    const [s] = P.getSlides(deck);
    // As Format Background does: the image is stored once, the background
    // reaching it through a relationship of its own.
    P.setSlideBackgroundImage(s, png);
    pruneUnusedMedia(deck, s);
    dedupeSlideMedia(deck, s);
    expect(
      P.getMediaParts(deck).filter((m) => /^image\//.test(m.contentType)),
    ).toHaveLength(1);
    // The crop is not cut out of the image the background shows whole.
    expect(plan(deck)).toEqual({ kinds: ["picture", "other"], plan: null });
  });
  it("counts a shape filled through the picture's own relationship", async () => {
    const entries = unzipSync(await P.savePresentation(croppedPicture()));
    const name = "ppt/slides/slide1.xml";
    const xml = strFromU8(entries[name]);
    const id = /r:embed="(rId\d+)"/.exec(xml)[1];
    entries[name] = strToU8(
      xml.replace(
        "</p:spTree>",
        `<p:sp><p:nvSpPr><p:cNvPr id="90" name="Filled"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="2000000" y="0"/><a:ext cx="4000000" cy="3000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:spPr></p:sp></p:spTree>`,
      ),
    );
    const deck = await parseDeck(zipSync(entries));
    expect(plan(deck)).toEqual({ kinds: ["picture", "other"], plan: null });
  });
  it("still cuts the crop out of an image only its picture shows", () => {
    expect(plan(croppedPicture())).toMatchObject({
      kinds: ["picture"],
      plan: { trims: true },
    });
  });
});

describe("show timeline", () => {
  it("eases from 0 to 1", () => {
    expect(ease(0)).toBeCloseTo(0, 3);
    expect(ease(1)).toBeCloseTo(1, 3);
    expect(ease(0.5)).toBeGreaterThan(0.5);
  });
  it("times transitions by duration or speed and slides by timings", () => {
    expect(transitionDuration({ effect: "fade", speed: "slow" })).toBe(1000);
    expect(transitionDuration({ effect: "push", durationMs: 1250 })).toBe(1250);
    expect(transitionDuration({ effect: "none" })).toBe(0);
    const timeline = showTimeline(
      [
        { effect: "fade", advanceAfterMs: 3000 },
        { effect: "fade", speed: "med" },
        null,
      ],
      { secondsPerSlide: 2 },
    );
    expect(timeline).toEqual([
      { start: 0, transition: 0, hold: 3000 },
      { start: 3000, transition: 750, hold: 2000 },
      { start: 5750, transition: 0, hold: 2000 },
    ]);
    expect(
      showTimeline([{ effect: "cut", advanceAfterMs: 3000 }], {
        secondsPerSlide: 2,
        useTimings: false,
      })[0].hold,
    ).toBe(2000);
  });
});
