import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, parseDeck, preview } from "../src/model.js";
import {
  createGeometryDeck,
  triangleGeometry,
  presetGeometry,
} from "./geometry-fixture.js";
const shapeOf = (pres) => P.getSlideShapes(P.getSlides(pres)[0])[0];
const svgOf = (pres) =>
  decodeURIComponent(
    preview(pres, P.getSlides(pres)[0]).split(",").slice(1).join(","),
  );
const effective = (pres) => P.getShapeGeometryEffective(pres, shapeOf(pres));

describe("picture and inherited geometry", () => {
  it.each(["local", "layout", "master"])(
    "resolves %s custom paths in instance coordinates and renders a clip",
    async (level) => {
      const pres = await parseDeck(await createGeometryDeck({ level }));
      const before = unzipSync(await P.savePresentation(pres));
      expect(effective(pres).geometry.paths[0].commands[1].pt).toEqual({
        x: P.inches(4),
        y: 0,
      });
      expect(svgOf(pres)).toContain(
        'd="M96.00,96.00 L480.00,96.00 L96.00,288.00 Z"',
      );
      expect(svgOf(pres)).toContain('clip-rule="evenodd"');
      expect(svgOf(pres)).not.toContain("data-pptx-fallback");
      expect(unzipSync(await P.savePresentation(pres))).toEqual(before);
      P.setShapeSize(shapeOf(pres), P.inches(6), P.inches(3));
      expect(effective(pres).geometry.paths[0].commands[1].pt.x).toBe(
        P.inches(6),
      );
      const restored = await parseDeck(await P.savePresentation(pres));
      expect(effective(restored)).toEqual(effective(pres));
    },
  );
  it("respects explicit geometry, including rectangles and malformed custom paths", async () => {
    const pres = await parseDeck(
      await createGeometryDeck({ directGeometry: presetGeometry("rect") }),
    );
    expect(effective(pres)).toEqual({
      kind: "preset",
      preset: "rect",
      adjustments: {},
    });
    expect(svgOf(pres)).not.toContain("<clipPath");
    const malformed = await parseDeck(
      await createGeometryDeck({
        directGeometry: triangleGeometry.replace('x="w"', 'x="undefinedGuide"'),
      }),
    );
    expect(effective(malformed)).toEqual({ kind: "custom", geometry: null });
    expect(svgOf(malformed)).toContain('data-pptx-fallback="custGeom"');
    expect(svgOf(malformed)).not.toMatch(/\b(?:NaN|Infinity)\b/);
  });
  it("matches default idx zero, keeps unrelated slots separate, and does not inherit on ordinary shapes", async () => {
    const defaultIndex = await parseDeck(
      await createGeometryDeck({
        placeholder: "<p:ph/>",
        layoutPlaceholder: '<p:ph idx="0"/>',
      }),
    );
    expect(effective(defaultIndex).kind).toBe("custom");
    const unrelated = await parseDeck(
      await createGeometryDeck({
        layoutPlaceholder: '<p:ph type="pic" idx="99"/>',
      }),
    );
    expect(effective(unrelated)).toBeNull();
    const ordinary = await parseDeck(
      await createGeometryDeck({ placeholder: "" }),
    );
    expect(effective(ordinary)).toBeNull();
  });
  it("prefers the layout geometry to the master and refreshes changed template bytes", async () => {
    const pres = await parseDeck(
      await createGeometryDeck({ masterGeometry: presetGeometry("ellipse") }),
    );
    expect(effective(pres).kind).toBe("custom");
    const pkg = P._internalPackageOf(pres),
      layout = pkg.getPart(
        P.getSlideLayoutPartName(P.getSlideLayout(P.getSlides(pres)[0])),
      );
    layout.data = strToU8(
      strFromU8(layout.data).replace(
        triangleGeometry,
        presetGeometry("ellipse"),
      ),
    );
    expect(effective(pres).preset).toBe("ellipse");
    const result = effective(pres);
    result.adjustments.adj = 999;
    expect(effective(pres).adjustments).toEqual({});
  });
  it.each(["picture", "shape"])(
    "uses the same geometry for %s picture fills, outlines and crops",
    async (shapeKind) => {
      const pres = await parseDeck(
        await createGeometryDeck({
          level: "local",
          shapeKind,
          geometry: presetGeometry("ellipse"),
          extraProperties:
            '<a:ln w="25400"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>',
        }),
      );
      if (shapeKind === "picture")
        P.setShapeImageCrop(shapeOf(pres), {
          left: 0.25,
          top: 0,
          right: 0,
          bottom: 0,
        });
      P.setShapeRotation(shapeOf(pres), 30);
      const svg = svgOf(pres);
      expect(svg).toContain(
        '<ellipse cx="288.00" cy="192.00" rx="192.00" ry="96.00"',
      );
      expect(svg).toContain('stroke="#FF0000" stroke-width="2.67"');
      expect(svg).toContain('transform="rotate(30 288.00 192.00)"');
      if (shapeKind === "picture")
        expect(svg).toContain(
          '<image x="-32.00" y="96.00" width="512.00" height="192.00"',
        );
    },
  );
  it("honors adjusted rounded corners and local picture geometry in literal readers", async () => {
    const pres = await parseDeck(
      await createGeometryDeck({
        level: "local",
        geometry: presetGeometry(
          "roundRect",
          '<a:gd name="adj" fmla="val 25000"/>',
        ),
      }),
    );
    expect(P.getShapePreset(shapeOf(pres))).toBe("roundRect");
    expect(svgOf(pres)).toContain('rx="48.00" ry="48.00"');
    const custom = await parseDeck(
      await createGeometryDeck({ level: "local" }),
    );
    expect(P.getShapeCustomGeometry(shapeOf(custom))).toEqual(
      effective(custom).geometry,
    );
  });
  it("retains empty geometry and excludes stroke-only paths from the image clip", async () => {
    const empty = await parseDeck(
      await createGeometryDeck({
        geometry: "<a:custGeom><a:pathLst/></a:custGeom>",
      }),
    );
    expect(svgOf(empty)).toMatch(/<clipPath[^>]*><\/clipPath>/);
    const strokeOnly = triangleGeometry.replace(
      "<a:path>",
      '<a:path fill="none">',
    );
    const pres = await parseDeck(
      await createGeometryDeck({
        geometry: strokeOnly,
        extraProperties:
          '<a:ln w="12700"><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:ln>',
      }),
    );
    expect(svgOf(pres)).toMatch(/<clipPath[^>]*><\/clipPath>/);
    expect(svgOf(pres)).toContain('stroke="#123456"');
    expect(svgOf(pres)).toContain(
      'd="M96.00,96.00 L480.00,96.00 L96.00,288.00 Z"',
    );
  });
  it("retains namespace-qualified curves and guide formulas through cross-deck copies", async () => {
    const curved =
      '<a:custGeom><a:avLst/><a:gdLst><a:gd name="mid" fmla="*/ w 1 2"/></a:gdLst><a:pathLst><a:path><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:cubicBezTo><a:pt x="mid" y="0"/><a:pt x="w" y="0"/><a:pt x="w" y="vc"/></a:cubicBezTo><a:quadBezTo><a:pt x="w" y="h"/><a:pt x="mid" y="h"/></a:quadBezTo><a:arcTo wR="mid" hR="vc" stAng="5400000" swAng="10800000"/><a:close/></a:path></a:pathLst></a:custGeom>';
    const files = unzipSync(await createGeometryDeck({ geometry: curved }));
    for (const name of Object.keys(files))
      if (name.endsWith(".xml"))
        files[name] = strToU8(
          strFromU8(files[name])
            .replaceAll("a:", "drawing:")
            .replaceAll("xmlns:a=", "xmlns:drawing="),
        );
    const source = await parseDeck(zipSync(files));
    const geometry = effective(source);
    expect(geometry.geometry.paths[0].commands.map((c) => c.kind)).toEqual([
      "moveTo",
      "cubicBezTo",
      "quadBezTo",
      "arcTo",
      "close",
    ]);
    expect(svgOf(source)).toContain("Q480.00,288.00 288.00,288.00");
    const target = createDeck(),
      copied = P.importSlide(
        target,
        P.getSlides(source)[0],
        P.getSlideLayouts(target)[0],
      );
    const reloaded = await parseDeck(await P.savePresentation(target));
    expect(
      P.getShapeGeometryEffective(
        reloaded,
        P.getSlideShapes(P.getSlides(reloaded).at(-1))[0],
      ),
    ).toEqual(geometry);
    expect(
      P.getShapeGeometryEffective(target, P.getSlideShapes(copied)[0]),
    ).toEqual(geometry);
  });

  it("preserves inherited geometry inside copied and imported groups", async () => {
    const source = await parseDeck(await createGeometryDeck());
    const slide = P.getSlides(source)[0],
      picture = shapeOf(source);
    const rect = P.addSlideShape(slide, {
      preset: "rect",
      x: P.inches(6),
      y: P.inches(1),
      w: P.inches(1),
      h: P.inches(1),
    });
    const geometry = effective(source);
    const group = P.groupShapes([picture, rect]);
    const other = P.addBlankSlide(source);
    const sourceLayout = P.getSlideLayoutPartName(P.getSlideLayout(slide));
    P.setSlideLayout(
      other,
      P.getSlideLayouts(source).find(
        (l) => P.getSlideLayoutPartName(l) !== sourceLayout,
      ),
    );
    const copy = P.copyShape(other, group);
    expect(
      P.getShapeGeometryEffective(source, P.getGroupChildren(copy)[0]),
    ).toEqual(geometry);
    const target = createDeck();
    const imported = P.importSlide(target, slide, P.getSlideLayouts(target)[0]);
    expect(
      P.getShapeGeometryEffective(
        target,
        P.getGroupChildren(P.getSlideShapes(imported)[0])[0],
      ),
    ).toEqual(geometry);
  });

  it("preserves inherited paths and bounds through both clipboard imports, different layouts, and export", async () => {
    const source = await parseDeck(
      await createGeometryDeck({ inheritedBounds: true }),
    );
    const before = unzipSync(await P.savePresentation(source));
    const original = effective(source);
    const clipboard = createDeck();
    const held = P.importSlide(
      clipboard,
      P.getSlides(source)[0],
      P.getSlideLayouts(clipboard)[0],
    );
    const heldShape = P.getSlideShapes(held)[0];
    expect(P.getShapeCustomGeometry(heldShape)).toEqual(original.geometry);
    expect(P.getShapeBounds(heldShape)).toEqual(
      P.getShapeBoundsResolved(source, shapeOf(source)),
    );
    const target = createDeck();
    const pasted = P.importSlide(target, held, P.getSlideLayouts(target)[0]);
    const copied = P.copyShape(
      P.getSlides(target)[0],
      P.getSlideShapes(pasted)[0],
    );
    expect(P.getShapeGeometryEffective(target, copied)).toEqual(original);
    const saved = await parseDeck(await P.savePresentation(target));
    expect(P.getShapeGeometryEffective(saved, shapeOf(saved))).toEqual(
      original,
    );
    const other = P.addBlankSlide(source);
    const sourceLayout = P.getSlideLayoutPartName(
      P.getSlideLayout(P.getSlides(source)[0]),
    );
    P.setSlideLayout(
      other,
      P.getSlideLayouts(source).find(
        (layout) => P.getSlideLayoutPartName(layout) !== sourceLayout,
      ),
    );
    const copy = P.copyShape(other, shapeOf(source));
    expect(P.getShapeCustomGeometry(copy)).toEqual(original.geometry);
    // Copying within the same layout retains inheritance rather than freezing it.
    const same = P.copyShape(P.getSlides(source)[0], shapeOf(source));
    expect(P.getShapeCustomGeometry(same)).toBeNull();
    const after = unzipSync(await P.savePresentation(source));
    for (const [name, data] of Object.entries(before))
      if (name.includes("/slideLayouts/") || name.includes("/slideMasters/"))
        expect(after[name]).toEqual(data);
  });
});

describe("picture data in the preview", () => {
  it("embeds each picture's bytes once", () => {
    const pres = createDeck("blank");
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    P.addSlideImage(P.getSlides(pres)[0], png, {
      x: 0,
      y: 0,
      w: P.inches(2),
      h: P.inches(2),
    });
    const svg = svgOf(pres);
    expect(svg.split("data:image/png;base64,")).toHaveLength(2);
  });
});
