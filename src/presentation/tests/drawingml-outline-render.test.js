// How shapes' outlines, effects and fills draw what DrawingML describes,
// checked against the desktop presentation app's output for the same files.
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";

// A one-slide deck whose shape tree holds `shapes` (DrawingML markup).
const deckWith = async (shapes) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const files = unzipSync(await P.savePresentation(pres));
  const name = P.getSlidePartName(slide).slice(1);
  files[name] = strToU8(
    strFromU8(files[name]).replace("<p:grpSpPr/>", `<p:grpSpPr/>${shapes}`),
  );
  return parseDeck(zipSync(files));
};
const render = async (shapes) => {
  const pres = await deckWith(shapes);
  return renderSlideToSvg(pres, P.getSlides(pres)[0], { textLayout: "svg" });
};
const shape = (spPr, prst = "rect", xfrm = "") =>
  `<p:sp><p:nvSpPr><p:cNvPr id="9" name="S"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm${xfrm}><a:off x="914400" y="914400"/><a:ext cx="2743200" cy="1371600"/></a:xfrm><a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${spPr}</p:spPr></p:sp>`;
const black = '<a:solidFill><a:srgbClr val="000000"/></a:solidFill>';
// w = 76200 EMU = 8 px.
const dashOf = (svg) =>
  /stroke-dasharray="([^"]*)"/.exec(svg)?.[1].split(/[ ,]+/).map(Number);

describe("dashed outlines with round and square caps", () => {
  const line = (cap, dash) =>
    shape(
      `<a:ln w="76200"${cap ? ` cap="${cap}"` : ""}>${black}${dash}</a:ln>`,
    );

  it("keeps the gaps of a round dot line", async () => {
    // sysDot is one width on, one off; the caps are part of the dot.
    const svg = await render(line("rnd", '<a:prstDash val="sysDot"/>'));
    expect(dashOf(svg)).toEqual([0, 16]);
  });

  it("includes square caps in preset dashes", async () => {
    const svg = await render(line("sq", '<a:prstDash val="dash"/>'));
    expect(dashOf(svg)).toEqual([24, 32]);
  });

  it("leaves flat caps alone", async () => {
    const svg = await render(line("", '<a:prstDash val="sysDot"/>'));
    expect(dashOf(svg)).toEqual([8, 8]);
  });

  it("includes round caps in custom dashes but not square ones", async () => {
    const cust =
      '<a:custDash><a:ds d="300000" sp="100000"/><a:ds d="100000" sp="100000"/></a:custDash>';
    expect(dashOf(await render(line("rnd", cust)))).toEqual([16, 16, 0, 16]);
    expect(dashOf(await render(line("sq", cust)))).toEqual([24, 8, 8, 8]);
  });
});

describe("preset shadows", () => {
  const preset = (prst, color = '<a:srgbClr val="404040"/>') =>
    shape(
      `<a:solidFill><a:srgbClr val="FFC000"/></a:solidFill><a:effectLst><a:prstShdw prst="${prst}" dist="114300" dir="2700000">${color}</a:prstShdw></a:effectLst>`,
    );
  const effects = async (markup) => {
    const pres = await deckWith(markup);
    const slide = P.getSlides(pres)[0];
    return P.getShapeEffects(pres, P.getSlideShapes(slide).at(-1));
  };

  it("draws a drop shadow at its distance and direction", async () => {
    const svg = await render(preset("shdw2"));
    // 9 pt at 45°: 12 px along each axis' diagonal.
    const d = (114300 / 9525) * Math.SQRT1_2;
    expect(svg).toContain(
      `<feDropShadow dx="${d.toFixed(2)}" dy="${d.toFixed(2)}" stdDeviation="0.00" flood-color="#404040"`,
    );
  });

  it("lays perspective shadows back from or forward of the bottom edge", async () => {
    expect(await effects(preset("shdw3"))).toMatchObject([
      { kind: "outerShdw", scaleY: 0.5, skewXDeg: 2453606 / 60000, align: "b" },
    ]);
    expect(await effects(preset("shdw8"))).toMatchObject([
      {
        kind: "outerShdw",
        scaleY: -0.5,
        skewXDeg: -2453606 / 60000,
        align: "b",
      },
    ]);
    const svg = await render(preset("shdw3"));
    expect(svg).toContain('data-pptx-shadow="1"');
  });

  it("draws a double shadow with a lighter second copy beneath", async () => {
    const [first, second] = await effects(preset("shdw13"));
    expect(first).toMatchObject({ color: "#404040", distEmu: 114300 });
    expect(second).toMatchObject({ color: "#A5A5A5", distEmu: 228600 });
  });

  it("keeps a shadow hidden behind its shape off the page", async () => {
    expect(await effects(preset("shdw9"))).toEqual([]);
  });
});

describe("inset outlines", () => {
  const outlined = (algn, prst = "rect", extra = "") =>
    shape(
      `<a:solidFill><a:srgbClr val="9DC3E6"/></a:solidFill><a:ln w="190500" algn="${algn}">${black}${extra}</a:ln>`,
      prst,
    );
  // w = 190500 EMU = 20 px.
  const masked = (svg) =>
    /<mask id="([^"]+)"[^>]*>(.*?)<\/mask><\/defs><g mask="url\(#\1\)">(.*?)<\/g>/.exec(
      svg,
    );

  it.each(["rect", "ellipse", "roundRect", "hexagon"])(
    "draws a %s's inset line inside it",
    async (prst) => {
      const m = masked(await render(outlined("in", prst)));
      expect(m).not.toBeNull();
      // The mask is the shape's inside; the line is twice as wide on its path.
      expect(m[2]).toContain('fill="#FFFFFF"');
      expect(m[2]).toContain('stroke="none"');
      expect(m[3]).toContain('stroke-width="40.00"');
      expect(m[3]).toContain('fill="none"');
    },
  );

  it("centres a line on its path by default", async () => {
    const svg = await render(outlined("ctr"));
    expect(masked(svg)).toBeNull();
    expect(svg).toContain('stroke-width="20.00"');
  });

  it("centres open lines and lines with arrowheads", async () => {
    expect(masked(await render(outlined("in", "arc")))).toBeNull();
    expect(
      masked(
        await render(outlined("in", "rect", '<a:tailEnd type="triangle"/>')),
      ),
    ).toBeNull();
  });
});

describe("path gradients", () => {
  // A 3 x 1.5 inch shape (288 x 144 px).
  const filled = (path, prst = "rect", focus = "") =>
    shape(
      `<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:path path="${path}"><a:fillToRect ${focus || 'l="50000" t="50000" r="50000" b="50000"'}/></a:path></a:gradFill>`,
      prst,
    );

  it("draws a circle reaching the farthest corner", async () => {
    const svg = await render(filled("circle"));
    const radial = /<radialGradient [^>]*>/.exec(svg)[0];
    // Half the diagonal, as a share of the width, made round again by
    // stretching the unit square back to the shape's proportions.
    const r = Math.hypot(1.5, 0.75) / 3;
    expect(radial).toContain(`r="${r.toFixed(4)}"`);
    expect(radial).toContain("scale(1 2)");
  });

  it("measures a circle from an off-centre focus", async () => {
    const svg = await render(
      filled("circle", "rect", 'l="0" t="0" r="100000" b="100000"'),
    );
    const radial = /<radialGradient [^>]*>/.exec(svg)[0];
    expect(radial).toContain('cx="0.0000" cy="0.0000"');
    expect(radial).toContain(`r="${(Math.hypot(3, 1.5) / 3).toFixed(4)}"`);
  });

  it("shades a rectangular path in four wedges", async () => {
    const svg = await render(filled("rect"));
    expect(svg).not.toContain("<radialGradient");
    expect(svg.match(/<polygon [^>]*fill="url\(#/g)).toHaveLength(4);
    // The top wedge shades from the focus up to the top edge.
    expect(svg).toMatch(/<linearGradient [^>]*x1="0" y1="0\.5" x2="0" y2="0">/);
  });

  it("follows a rectangle's outline for a shape path", async () => {
    expect(await render(filled("shape"))).not.toContain("<radialGradient");
    expect(await render(filled("shape", "ellipse"))).toContain(
      "<radialGradient",
    );
  });
});

describe("slanted shadows", () => {
  it("slants a shadow by the box's own height, whatever its scale", async () => {
    // A perspective shadow laid down below the shape: squashed to 19% and
    // flipped, slanted -20°. Its far edge leans right by tan 20° of the
    // shape's full height, as the desktop app draws it.
    const svg = await render(
      shape(
        '<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill><a:effectLst><a:outerShdw blurRad="50800" dist="38100" dir="2700000" sx="90000" sy="-19000" kx="-1200000" algn="bl" rotWithShape="0"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst>',
      ),
    );
    const m = /data-pptx-shadow="1"><g transform="matrix\(([^)]+)\)"/.exec(svg);
    const [a, b, c, d] = m[1].split(" ").map(Number);
    expect(a).toBeCloseTo(0.9, 3);
    expect(b).toBeCloseTo(0, 3);
    expect(c).toBeCloseTo(Math.tan((-20 * Math.PI) / 180), 3);
    expect(d).toBeCloseTo(-0.19, 3);
  });
});

describe("shadows fixed to the page", () => {
  it("lays a slanted shadow out below a turned shape on the page", async () => {
    // Turned a half turn, the shape's own top is the page's bottom. A shadow
    // that does not turn with it is squashed below it on the page: in the
    // shape's own frame, above its top edge.
    const svg = await render(
      shape(
        '<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill><a:effectLst><a:outerShdw dist="0" sy="-50000" algn="b" rotWithShape="0"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst>',
        "rect",
        ' rot="10800000"',
      ),
    );
    const m = /data-pptx-shadow="1"><g transform="matrix\(([^)]+)\)"/.exec(svg);
    const [, , , d, , f] = m[1].split(" ").map(Number);
    // The box runs from y 96 to 240 px in its own frame.
    expect(d * 96 + f).toBeCloseTo(96, 1);
    expect(d * 240 + f).toBeCloseTo(24, 1);
  });

  it("lays preset shadows out on the page", async () => {
    const pres = await deckWith(
      shape(
        '<a:solidFill><a:srgbClr val="FFC000"/></a:solidFill><a:effectLst><a:prstShdw prst="shdw4" dist="114300" dir="2700000"><a:srgbClr val="404040"/></a:prstShdw></a:effectLst>',
      ),
    );
    const [effect] = P.getShapeEffects(
      pres,
      P.getSlideShapes(P.getSlides(pres)[0]).at(-1),
    );
    expect(effect.fixedToPage).toBe(true);
  });
});

describe("soft edges", () => {
  it("fade the shape in from 0.87 of the radius inside its outline", async () => {
    // Measured in the desktop app at 5, 10 and 25 pt: the fade is half way
    // 0.87 of the radius inside the outline and spreads with a deviation
    // of a third of the radius.
    const svg = await render(
      shape(
        '<a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:effectLst><a:softEdge rad="317500"/></a:effectLst>',
      ),
    );
    // 25 pt = 33.33 px.
    expect(svg).toMatch(
      /<feMorphology in="SourceAlpha" operator="erode" radius="29\.0\d"[^>]*\/><feGaussianBlur in="softCore\d+" stdDeviation="11\.0\d"/,
    );
  });
});

describe("3-D shapes", () => {
  const solid = (sp3d, camera = "isometricOffAxis1Right") =>
    shape(
      `<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill><a:scene3d><a:camera prst="${camera}"/><a:lightRig rig="threePt" dir="t"/></a:scene3d>${sp3d}`,
    );

  it("shows an extruded shape's depth in its extrusion colour", async () => {
    const svg = await render(
      solid(
        '<a:sp3d extrusionH="254000"><a:extrusionClr><a:srgbClr val="1F3864"/></a:extrusionClr></a:sp3d>',
      ),
    );
    const filter =
      /<filter id="([^"]+)"[^>]*><feFlood flood-color="#1F3864"/.exec(svg);
    expect(filter).not.toBeNull();
    // The face swept back up and to the left, behind the face.
    const sweep = new RegExp(
      `<g filter="url\\(#${filter[1]}\\)"><g transform="translate\\((-?[\\d.]+) (-?[\\d.]+)\\)">`,
    ).exec(svg);
    expect(Number(sweep[1])).toBeLessThan(0);
    expect(Number(sweep[2])).toBeLessThan(0);
  });

  it("draws a shape with no depth flat", async () => {
    const svg = await render(solid("<a:sp3d/>"));
    expect(svg).not.toContain("feFlood");
  });

  it("tilts a moderately relaxed perspective back", async () => {
    const svg = await render(
      solid("<a:sp3d/>", "perspectiveRelaxedModerately"),
    );
    const m = /matrix\(([^)]+)\)/.exec(svg)[1].split(" ").map(Number);
    expect(m[3]).toBeCloseTo(Math.cos((324 * Math.PI) / 180), 3);
  });
});
