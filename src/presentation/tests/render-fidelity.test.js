// How slides draw what DrawingML describes: picture corrections, effects
// and group transforms, checked against the ECMA-376 behaviour.
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import { luminanceTransfer } from "../lib/pptx-preview/src/render-slide.ts";
import { geometryImage } from "./geometry-fixture.js";

const IN = (v) => Math.round(v * 914400);
const pictureDeck = (setup) => {
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
const transfer = (svg) =>
  /<feComponentTransfer color-interpolation-filters="sRGB"><feFuncR type="linear" slope="([-\d.]+)" intercept="([-\d.]+)"/.exec(
    svg,
  );

describe("picture brightness and contrast", () => {
  const apply = (b, c) => {
    const { slope, intercept } = luminanceTransfer(b, c);
    return (v) => slope * v + intercept;
  };

  it("leaves the picture alone at 0% and 0%", () => {
    expect(luminanceTransfer(0, 0)).toEqual({ slope: 1, intercept: 0 });
  });

  it("adds brightness to every colour", () => {
    expect(apply(0.4, 0)(0)).toBeCloseTo(0.4);
    expect(apply(0.4, 0)(0.5)).toBeCloseTo(0.9);
    expect(apply(-0.4, 0)(1)).toBeCloseTo(0.6);
    expect(apply(1, 0)(0)).toBeCloseTo(1);
  });

  it("spreads or gathers colours about the middle grey with contrast", () => {
    for (const c of [-0.6, -0.2, 0.2, 0.6])
      expect(apply(0, c)(0.5)).toBeCloseTo(0.5);
    expect(luminanceTransfer(0, 0.4).slope).toBeCloseTo(1 / 0.6);
    expect(luminanceTransfer(0, -0.4).slope).toBeCloseTo(0.6);
    expect(apply(0, -1)(0.1)).toBeCloseTo(0.5);
  });

  // Grey levels (of 255) the desktop app draws for a 0..255 ramp.
  it.each([
    [0.2, -0.4, 0, 92],
    [0.2, -0.4, 1, 244],
    [0.4, 0.4, 0.4, 223],
    [-0.2, -0.4, 0.5, 87],
    [-0.4, 0.4, 0.8, 118],
    [0.3, -0.7, 0.5, 177],
    [0.7, -0.3, 0, 191],
    [0.7, -0.7, 0, 206],
  ])("brightness %s, contrast %s at %s draws %s", (b, c, v, grey) => {
    expect(Math.abs(apply(b, c)(v) * 255 - grey)).toBeLessThan(4);
  });

  it("draws a contrast change without turning the picture grey", () => {
    const svg = pictureDeck((pic) => P.setShapeImageContrast(pic, 0.2));
    const [, slope, intercept] = transfer(svg);
    expect(Number(slope)).toBeCloseTo(1.25, 3);
    expect(Number(intercept)).toBeCloseTo(-0.125, 3);
  });

  it("draws brightness alone in the picture's own colours", () => {
    const svg = pictureDeck((pic) => P.setShapeImageBrightness(pic, 0.3));
    const [, slope, intercept] = transfer(svg);
    expect(slope).toBe("1");
    expect(intercept).toBe("0.3");
  });
});

const shapeDeck = (setup, options = {}) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const shape = P.addSlideShape(slide, {
    preset: "rect",
    x: IN(1),
    y: IN(1),
    w: IN(2),
    h: IN(1),
    ...options,
  });
  setup(pres, shape);
  return renderSlideToSvg(pres, slide, { textLayout: "svg" });
};
const shadow = (type, extra = {}) => ({
  shadow: {
    type,
    color: "#000000",
    opacity: 0.5,
    blurEmu: 50800,
    distEmu: 76200,
    angleDeg: 45,
    ...extra,
  },
});

describe("shadows", () => {
  it("paints an inner shadow over the shape it falls on", () => {
    const svg = shapeDeck((pres, s) =>
      P.setShapeEffectSpec(pres, s, shadow("inner")),
    );
    const merge = /<feMerge>(.*?)<\/feMerge>/.exec(svg)[1];
    const order = [...merge.matchAll(/in="([^"]+)"/g)].map((m) => m[1]);
    expect(order[0]).toBe("SourceGraphic");
    expect(order[1]).toMatch(/^innerOut/);
    // Cast at 45°, it lines the bottom and right edges, as the desktop app
    // draws it: the shape's own alpha moves up and left to leave that band.
    const [dx, dy] = /<feOffset in="innerBlur\d+" dx="([-\d.]+)" dy="([-\d.]+)"/
      .exec(svg)
      .slice(1)
      .map(Number);
    expect(dx).toBeLessThan(0);
    expect(dy).toBeLessThan(0);
  });

  it("paints an outer shadow behind the shape", () => {
    const svg = shapeDeck((pres, s) =>
      P.setShapeEffectSpec(pres, s, shadow("outer")),
    );
    const merge = /<feMerge>(.*?)<\/feMerge>/.exec(svg)[1];
    const order = [...merge.matchAll(/in="([^"]+)"/g)].map((m) => m[1]);
    expect(order.at(-1)).toBe("SourceGraphic");
  });

  const drop = (svg) =>
    /<feDropShadow dx="([-\d.]+)" dy="([-\d.]+)"/
      .exec(svg)
      .slice(1)
      .map(Number);

  it("keeps a shadow fixed to the page when the shape turns or flips", () => {
    // The pane writes rotWithShape="0": 6pt down and to the right.
    const d = 76200 / 9525 / Math.SQRT2;
    for (const [rotation, flip] of [
      [180, null],
      [90, null],
      [0, "horizontal"],
      [270, "vertical"],
    ]) {
      const svg = shapeDeck((pres, s) => {
        P.setShapeEffectSpec(pres, s, shadow("outer"));
        if (rotation) P.setShapeRotation(s, rotation);
        if (flip)
          P.setShapeFlip(s, {
            horizontal: flip === "horizontal",
            vertical: flip === "vertical",
          });
      });
      // The filter paints inside the shape's turn and flips; undo them.
      let [dx, dy] = drop(svg);
      if (flip === "horizontal") dx = -dx;
      if (flip === "vertical") dy = -dy;
      const r = (rotation * Math.PI) / 180;
      const px = dx * Math.cos(r) - dy * Math.sin(r),
        py = dx * Math.sin(r) + dy * Math.cos(r);
      expect(px).toBeCloseTo(d, 1);
      expect(py).toBeCloseTo(d, 1);
    }
  });

  it("turns a shadow that turns with the shape", async () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const s = P.addSlideShape(slide, {
      preset: "rect",
      x: IN(1),
      y: IN(1),
      w: IN(2),
      h: IN(1),
    });
    P.setShapeEffectSpec(pres, s, shadow("outer"));
    P.setShapeRotation(s, 180);
    const files = unzipSync(await P.savePresentation(pres));
    const name = P.getSlidePartName(slide).slice(1);
    files[name] = strToU8(
      strFromU8(files[name]).replace('rotWithShape="0"', 'rotWithShape="1"'),
    );
    const loaded = await parseDeck(zipSync(files));
    const svg = renderSlideToSvg(loaded, P.getSlides(loaded)[0], {
      textLayout: "svg",
    });
    // Offset in the shape's own frame, so it turns with it.
    const d = 76200 / 9525 / Math.SQRT2;
    const [dx, dy] = drop(svg);
    expect(dx).toBeCloseTo(d, 1);
    expect(dy).toBeCloseTo(d, 1);
  });

  it("draws the shadow size from the Shadow pane", () => {
    const svg = shapeDeck((pres, s) =>
      P.setShapeEffectSpec(pres, s, shadow("outer", { scale: 1.2 })),
    );
    expect(svg).not.toContain("feDropShadow");
    const m = /data-pptx-shadow="1"><g transform="matrix\(([^)]+)\)"/.exec(svg);
    const [a, b, c, d, e, f] = m[1].split(" ").map(Number);
    expect([a, b, c, d]).toEqual([1.2, 0, 0, 1.2]);
    // Grown about the box's centre (192, 144), then offset 6pt at 45°.
    const off = 76200 / 9525 / Math.SQRT2;
    expect(e).toBeCloseTo(192 - 1.2 * 192 + off, 2);
    expect(f).toBeCloseTo(144 - 1.2 * 144 + off, 2);
  });
});

describe("tiled picture fills", () => {
  const tiled = (align) => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const s = P.addSlideShape(slide, {
      preset: "rect",
      x: IN(1),
      y: IN(1),
      w: IN(2),
      h: IN(1),
    });
    P.setShapeImageFill(s, geometryImage);
    P.setShapeImageFillMode(s, {
      mode: "tile",
      offsetX: 0,
      offsetY: 0,
      scaleX: 10,
      scaleY: 10,
      align,
      mirror: "none",
    });
    const svg = renderSlideToSvg(pres, slide, { textLayout: "svg" });
    return /<pattern [^>]*x="([\d.]+)" y="([\d.]+)"/
      .exec(svg)
      .slice(1)
      .map(Number);
  };
  // A 2px picture at 1000% is a 20px tile in a 192 x 96px box at (96, 96).
  it.each([
    ["tl", 96, 96],
    ["ctr", 96 + 86, 96 + 38],
    ["r", 96 + 172, 96 + 38],
    ["b", 96 + 86, 96 + 76],
  ])("lines the tiles up from the %s point", (align, x, y) => {
    expect(tiled(align)).toEqual([x, y]);
  });
});

describe("picture colour effects", () => {
  // A picture whose <a:blip> carries the given effects.
  const blipDeck = async (effects) => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    P.addSlideImage(slide, geometryImage, {
      x: IN(1),
      y: IN(1),
      w: IN(2),
      h: IN(1),
    });
    const files = unzipSync(await P.savePresentation(pres));
    const name = P.getSlidePartName(slide).slice(1);
    files[name] = strToU8(
      strFromU8(files[name]).replace(
        /<a:blip ([^>]*?)\/>/,
        `<a:blip $1>${effects}</a:blip>`,
      ),
    );
    const loaded = await parseDeck(zipSync(files));
    return renderSlideToSvg(loaded, P.getSlides(loaded)[0], {
      textLayout: "svg",
    });
  };

  it("turns a picture black and white by its lightness", async () => {
    const svg = await blipDeck('<a:biLevel thresh="50000"/>');
    const m =
      /<feColorMatrix type="matrix" color-interpolation-filters="sRGB" values="([^"]+)"/.exec(
        svg,
      );
    const v = m[1].split(" ").map(Number);
    const out = (r, g, b) =>
      Math.max(0, Math.min(1, v[0] * r + v[1] * g + v[2] * b + v[4]));
    // Every channel gets the same answer, so the result is black or white.
    expect(v.slice(0, 5)).toEqual(v.slice(5, 10));
    expect(out(1, 1, 0)).toBe(1); // yellow is light
    expect(out(0, 0, 1)).toBe(0); // blue is dark
    expect(out(0.86, 0.12, 0.12)).toBe(0); // so is a strong red
    expect(out(0.6, 0.6, 0.6)).toBe(1);
    expect(out(0.4, 0.4, 0.4)).toBe(0);
  });

  it("makes the colour set as transparent see-through", async () => {
    const svg = await blipDeck(
      '<a:clrChange><a:clrFrom><a:srgbClr val="FF0000"/></a:clrFrom><a:clrTo><a:srgbClr val="FF0000"><a:alpha val="0"/></a:srgbClr></a:clrTo></a:clrChange>',
    );
    const tables = [
      ...svg.matchAll(/<feFunc([RGB]) type="discrete" tableValues="([^"]+)"/g),
    ].map((m) => m[2].split(" ").map(Number));
    expect(tables).toHaveLength(3);
    // Red differs from FF0000 below 254; green and blue above 1.
    expect(tables[0].indexOf(0)).toBe(254);
    expect(tables[1].lastIndexOf(0)).toBe(1);
    expect(svg).toContain('operator="in" result="ccKept"');
    expect(svg).not.toContain("feFlood");
  });
});

describe("effects with out-of-range sizes", () => {
  it("draws a huge glow, blur or shadow no larger than the settings allow", () => {
    const svg = shapeDeck((pres, s) => {
      P.setShapeEffectSpec(pres, s, {
        ...shadow("outer", { blurEmu: 9e11, distEmu: 9e11 }),
        glow: { color: "#FF0000", opacity: 1, radiusEmu: 9e11 },
      });
    });
    const num = (re) => Number(re.exec(svg)[1]);
    // 150pt glow: dilated by half of 200px.
    expect(num(/operator="dilate" radius="([\d.]+)"/)).toBe(100);
    // 100pt blur: a standard deviation of half of 133px.
    expect(num(/<feDropShadow [^>]*stdDeviation="([\d.]+)"/)).toBeCloseTo(
      66.67,
      1,
    );
    // 200pt away at 45°.
    expect(num(/<feDropShadow dx="([\d.]+)"/)).toBeCloseTo(
      266.67 / Math.SQRT2,
      1,
    );
  });
});

describe("underline styles", () => {
  const underlined = async (styles) => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const files = unzipSync(await P.savePresentation(pres));
    const name = P.getSlidePartName(slide).slice(1);
    const runs = styles
      .map(
        (u) =>
          `<a:r><a:rPr lang="en-US" sz="2400" u="${u}"/><a:t>${u} </a:t></a:r>`,
      )
      .join("");
    const sp = `<p:sp><p:nvSpPr><p:cNvPr id="9" name="T"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="none"/><a:lstStyle/><a:p>${runs}</a:p></p:txBody></p:sp>`;
    files[name] = strToU8(
      strFromU8(files[name]).replace("</p:spTree>", `${sp}</p:spTree>`),
    );
    const loaded = await parseDeck(zipSync(files));
    return renderSlideToSvg(loaded, P.getSlides(loaded)[0], {
      textLayout: "svg",
    });
  };
  const lines = (svg) =>
    [
      ...svg.matchAll(
        /<path d="M[\d.]+ [\d.]+H[\d.]+" stroke="#000000" stroke-width="([\d.]+)"( stroke-dasharray="([^"]+)")?/g,
      ),
    ].map((m) => ({ width: Number(m[1]), dashes: m[3] ?? null }));

  it("draws heavy, dotted and dashed underlines as such", async () => {
    const svg = await underlined(["sng", "heavy", "dotted", "dashLongHeavy"]);
    const drawn = lines(svg);
    expect(drawn).toHaveLength(3);
    const [heavy, dotted, dashLong] = drawn;
    expect(heavy.dashes).toBeNull();
    expect(dotted.dashes).not.toBeNull();
    expect(heavy.width).toBeCloseTo(dotted.width * 2, 2);
    expect(dashLong.width).toBeCloseTo(heavy.width, 2);
    expect(dashLong.dashes.split(" ").map(Number)[0]).toBeCloseTo(
      dashLong.width * 8,
      1,
    );
  });

  it("draws a double wavy underline as two waves", async () => {
    const svg = await underlined(["wavy", "wavyDbl"]);
    expect(svg.match(/<path d="M[\d.]+ [\d.]+ Q/g)).toHaveLength(3);
  });
});
