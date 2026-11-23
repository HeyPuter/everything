// Slide show and recording helpers: narrations and
// live cameras stored on slides, timings, and narrated video timelines.
import { afterEach, describe, expect, it, vi } from "vitest";
import { P, createDeck } from "../src/model.js";
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
  createCameraSource,
  deviceProblem,
  isCameraShape,
  placeCameras,
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

describe("the show's camera", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("lets the camera go when the show stopped while the browser asked", async () => {
    let answer;
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: () => new Promise((resolve) => (answer = resolve)),
      },
    });
    const track = { stop: vi.fn() };
    const source = createCameraSource();
    const asked = source.camera();
    source.stop();
    answer({ getTracks: () => [track] });
    expect(await asked).toBe(null);
    expect(track.stop).toHaveBeenCalled();
    expect(source.stream).toBe(null);
  });

  it("does not ask for a camera the browser does not list", async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia,
        enumerateDevices: async () => [{ kind: "audioinput" }],
      },
    });
    const source = createCameraSource();
    expect(await source.camera()).toBe(null);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(deviceProblem(source.failure)).toBe("No camera was found.");
  });

  it("says once per slide why a live camera is not showing", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async () => {
          throw Object.assign(new Error("denied"), {
            name: "NotAllowedError",
          });
        },
      },
    });
    const pres = deck(1);
    const slide = P.getSlides(pres)[0];
    for (let i = 0; i < 2; i++)
      addCameraShape(P, slide, { png: PNG, svg: null, size: SIZE });
    // Just enough of a page for the camera boxes.
    const node = () => ({
      style: {},
      classList: { add() {} },
      isConnected: true,
      append() {},
      setAttribute() {},
      remove() {},
    });
    const layer = { ownerDocument: { createElement: node }, append() {} };
    const told = [];
    placeCameras({
      P,
      slide,
      layer,
      size: { width: SIZE.cx, height: SIZE.cy },
      source: createCameraSource(),
      bounds: () => ({ x: 0, y: 0, w: 10, h: 10 }),
      onFailure: (message) => told.push(message),
    });
    await vi.waitFor(() => expect(told.length).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(told).toEqual([
      "The camera is blocked. Allow it in the browser's site settings.",
    ]);
  });

  it("names the devices a recording could not use", () => {
    const blocked = { name: "NotAllowedError" };
    expect(deviceProblem(blocked, { video: true, audio: true })).toBe(
      "The camera and microphone are blocked. Allow them in the browser's site settings.",
    );
    expect(
      deviceProblem({ name: "NotFoundError" }, { video: true, audio: true }),
    ).toBe("No camera or microphone was found.");
    expect(
      deviceProblem(
        { name: "NotReadableError" },
        { video: false, audio: true },
      ),
    ).toBe("The microphone is in use by another app or could not start.");
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
