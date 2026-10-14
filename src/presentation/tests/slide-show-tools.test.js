// Slide show and recording helpers: ink kept from a show, narrations and
// live cameras stored on slides, timings, and narrated video timelines.
import { describe, expect, it } from "vitest";
import { P, createDeck } from "../src/model.js";
import {
  addInkShape,
  simplifyStroke,
  strokeGeometry,
  PEN_WIDTH,
} from "../src/show/ink.js";
import {
  addNarration,
  hasNarration,
  isNarration,
  narrationOf,
  removeNarrations,
  setSlideAdvance,
} from "../src/show/narration.js";
import {
  addCameraShape,
  cameraShapeKind,
  isCameraShape,
} from "../src/show/camera.js";
import { showTimeline } from "../src/export/transition-frames.js";
import { SPOKEN_LANGUAGES, spokenLanguage } from "../src/show/prefs.js";

// A 1×1 PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
const SIZE = { cx: 12192000, cy: 6858000 };
async function roundTrip(pres) {
  return P.loadPresentation(await P.savePresentation(pres));
}
function deck(count = 2) {
  const pres = createDeck("blank");
  for (let i = 1; i < count; i++) P.addBlankSlide(pres);
  return pres;
}

describe("ink from the show", () => {
  it("thins a stroke to the points that matter", () => {
    const line = Array.from({ length: 50 }, (_, i) => ({ x: i * 10, y: 0 }));
    expect(simplifyStroke(line, 1)).toEqual([line[0], line[49]]);
    const corner = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 100, y: 100 },
    ];
    expect(simplifyStroke(corner, 1)).toEqual([
      corner[0],
      corner[2],
      corner[4],
    ]);
  });

  it("boxes a stroke and draws a smooth path through it", () => {
    const g = strokeGeometry(
      {
        points: [
          { x: 1000, y: 2000 },
          { x: 5000, y: 9000 },
          { x: 9000, y: 2000 },
        ],
      },
      SIZE.cx,
    );
    expect(g).toMatchObject({ x: 1000, y: 2000, w: 8000, h: 7000 });
    expect(g.commands[0]).toEqual({ type: "moveTo", x: 0, y: 0 });
    expect(g.commands.at(-1)).toMatchObject({ type: "cubicTo", x: 8000, y: 0 });
  });

  it("keeps strokes as ink shapes that survive saving", async () => {
    const pres = deck(1);
    const slide = P.getSlides(pres)[0];
    addInkShape(
      P,
      slide,
      {
        tool: "highlighter",
        color: "#FFFF00",
        width: PEN_WIDTH * 4,
        points: [
          { x: 100000, y: 100000 },
          { x: 900000, y: 400000 },
        ],
      },
      SIZE.cx,
    );
    const again = P.getSlides(await roundTrip(pres))[0];
    const ink = P.getSlideShapes(again).find((s) =>
      P.getShapeName(s).startsWith("Ink "),
    );
    expect(ink).toBeTruthy();
    expect(P.getShapeBounds(ink)).toMatchObject({ x: 100000, y: 100000 });
    expect(P.getShapeCustomGeometry(ink).paths).toHaveLength(1);
  });
});

describe("recorded narrations", () => {
  it("stores a narration that plays by itself and is found again", async () => {
    const pres = deck(2);
    const [first] = P.getSlides(pres);
    const sound = new Uint8Array([1, 2, 3, 4, 5]);
    addNarration(
      P,
      first,
      {
        kind: "audio",
        data: sound,
        contentType: "audio/webm",
        durationMs: 4200,
        poster: PNG,
      },
      SIZE,
    );
    setSlideAdvance(P, first, 4200);
    const again = await roundTrip(pres);
    const [slide, other] = P.getSlides(again);
    expect(hasNarration(P, slide)).toBe(true);
    expect(hasNarration(P, other)).toBe(false);
    const narration = narrationOf(P, slide);
    expect(narration).toMatchObject({
      kind: "audio",
      contentType: "audio/webm",
      durationMs: 4200,
    });
    expect([...narration.data]).toEqual([1, 2, 3, 4, 5]);
    const shape = P.getSlideShapes(slide).find((s) => isNarration(P, s));
    expect(P.getShapeMedia(shape).options).toMatchObject({
      start: "automatically",
      hideWhileNotPlaying: true,
    });
    expect(P.getEffectiveSlideTransition(slide)?.advanceAfterMs).toBe(4200);
    // Another recording replaces it; clearing removes it.
    addNarration(
      P,
      slide,
      {
        kind: "video",
        data: sound,
        contentType: "video/webm",
        durationMs: 1000,
        poster: PNG,
        shape: "circle",
      },
      SIZE,
    );
    expect(
      P.getSlideShapes(slide).filter((s) => isNarration(P, s)),
    ).toHaveLength(1);
    expect(narrationOf(P, slide).kind).toBe("video");
    expect(removeNarrations(P, slide)).toBe(true);
    expect(hasNarration(P, slide)).toBe(false);
    expect(removeNarrations(P, slide)).toBe(false);
  });

  it("clears a slide's timing and keeps its transition", () => {
    const pres = deck(1);
    const slide = P.getSlides(pres)[0];
    P.setSlideTransition(slide, { effect: "fade", advanceAfterMs: 3000 });
    setSlideAdvance(P, slide, null);
    const t = P.getEffectiveSlideTransition(slide);
    expect(t.effect).toBe("fade");
    expect(t.advanceAfterMs).toBeUndefined();
  });
});

describe("live cameras", () => {
  it("places a live camera as a picture the app recognizes", async () => {
    const pres = deck(1);
    const slide = P.getSlides(pres)[0];
    addCameraShape(P, slide, {
      png: PNG,
      svg: null,
      size: SIZE,
      shape: "rect",
    });
    addCameraShape(P, slide, {
      png: PNG,
      svg: null,
      size: SIZE,
      box: { x: 10, y: 20, w: 300, h: 300 },
    });
    const again = P.getSlides(await roundTrip(pres))[0];
    const cameras = P.getSlideShapes(again).filter((s) => isCameraShape(P, s));
    expect(cameras.map((s) => P.getShapeName(s))).toEqual([
      "Live Camera 1",
      "Live Camera 2",
    ]);
    expect(cameras.map((s) => cameraShapeKind(P, s))).toEqual([
      "rect",
      "circle",
    ]);
    expect(P.getShapeBounds(cameras[1])).toMatchObject({
      x: 10,
      y: 20,
      w: 300,
    });
  });
});

describe("narrated video timelines", () => {
  it("keeps a slide up until its narration ends", () => {
    const timeline = showTimeline(
      [null, { effect: "fade", durationMs: 500, advanceAfterMs: 1000 }],
      { secondsPerSlide: 2, useTimings: true, minimumHoldMs: [0, 3500] },
    );
    expect(timeline).toEqual([
      { start: 0, transition: 0, hold: 2000 },
      { start: 2000, transition: 500, hold: 3500 },
    ]);
  });
});

describe("subtitle languages", () => {
  it("falls back to a language the list offers", () => {
    const code = spokenLanguage();
    expect(SPOKEN_LANGUAGES.some(([c]) => c === code)).toBe(true);
  });
});
