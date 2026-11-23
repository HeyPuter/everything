import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";

// A 4 x 2 pixel PNG.
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAAASFvFNAAAAEUlEQVR4nGP4z8DAwMDAwAAADvwB/7L1V8gAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);

async function picture(srcRect) {
  const pres = createDeck("blank"),
    slide = P.getSlides(pres)[0];
  // 384 x 192 px at (96, 96).
  P.addSlideImage(slide, png, {
    x: 914400,
    y: 914400,
    w: 3657600,
    h: 1828800,
  });
  const files = unzipSync(await P.savePresentation(pres));
  const name = P.getSlidePartName(slide).slice(1);
  files[name] = strToU8(
    strFromU8(files[name])
      .replace(/<a:srcRect[^>]*\/>/, "")
      .replace(/(<a:blip\b[^>]*?(?:\/>|>[\s\S]*?<\/a:blip>))/, `$1${srcRect}`),
  );
  const loaded = await parseDeck(zipSync(files));
  const svg = renderSlideToSvg(loaded, P.getSlides(loaded)[0], {
    textLayout: "svg",
  });
  const image = svg.match(
    /<image x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/,
  );
  return image.slice(1).map(Number);
}

describe("picture source rectangles", () => {
  it("pads a picture whose source rectangle reaches past the image", async () => {
    // l = r = -25%: the source is 1.5 image widths, so the picture fills
    // two thirds of the frame's width, centered.
    expect(await picture('<a:srcRect l="-25000" r="-25000"/>')).toEqual([
      160, 96, 256, 192,
    ]);
    expect(await picture('<a:srcRect t="-50000"/>')).toEqual([
      96, 160, 384, 128,
    ]);
  });
  it("still crops with positive sides, and pads and crops together", async () => {
    expect(await picture('<a:srcRect l="25000" r="25000"/>')).toEqual([
      -96, 96, 768, 192,
    ]);
    expect(await picture('<a:srcRect l="-25000" t="10000"/>')).toEqual([
      172.8, 74.67, 307.2, 213.33,
    ]);
  });
});
