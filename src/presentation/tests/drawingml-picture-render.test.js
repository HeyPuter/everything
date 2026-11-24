// How pictures draw what DrawingML describes, checked against the desktop
// presentation app's output for the same files.
import { describe, expect, it } from "vitest";
import { P, createDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import { geometryImage } from "./geometry-fixture.js";

const IN = (v) => Math.round(v * 914400);
const pictureSvg = (setup) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const pic = P.addSlideImage(slide, geometryImage, {
    x: IN(1),
    y: IN(1),
    w: IN(2),
    h: IN(1),
  });
  setup(pic);
  return renderSlideToSvg(pres, slide, { textLayout: "svg" });
};

describe("picture recolouring", () => {
  it("weighs grayscale on the sRGB values, not in linear light", () => {
    // The desktop app turns pure green (0, 160, 0) into grey 114 and pure
    // blue into 18: 0.7152 and 0.0722 of the sRGB values.
    const svg = pictureSvg((pic) =>
      P.setShapePictureRecolor(pic, { kind: "grayscale" }),
    );
    const matrix =
      /<feColorMatrix type="matrix"([^>]*)values="0\.2126 0\.7152 0\.0722 0 0/.exec(
        svg,
      );
    expect(matrix).not.toBeNull();
    expect(matrix[1]).toContain('color-interpolation-filters="sRGB"');
  });
});
