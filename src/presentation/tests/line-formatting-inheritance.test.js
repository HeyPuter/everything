import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync } from "fflate";
import { P, createDeck, parseDeck, preview } from "../src/model.js";
import {
  lineFormattingFixture,
  lineProperties,
  lineStyleRef,
} from "./line-formatting-fixture.js";

const svg = (f) =>
  decodeURIComponent(preview(f.pres, f.slide).split(",").slice(1).join(","));
const format = (f) => P.getShapeStrokeFormattingEffective(f.shape);
const custom =
  '<a:custDash><a:ds d="250000" sp="75000"/><a:ds d="50000" sp="125000"/></a:custDash>';

describe("effective DrawingML line formatting", () => {
  it.each([
    ["", 8],
    [' lim="bad"', 8],
    [' lim="0"', 0],
    [' lim="75%"', 0.75],
    [' lim="350000"', 3.5],
  ])(
    "uses the native miter limit for %s without borrowing an ancestor's limit",
    async (attrs, limit) => {
      const f = await lineFormattingFixture({
        local: lineProperties(`<a:miter${attrs}/>`),
        layout: lineProperties('<a:miter lim="900000"/>'),
      });
      expect(format(f).join).toEqual({ kind: "miter", limit });
      expect(svg(f)).toContain(`stroke-miterlimit="${Math.max(1, limit)}"`);
    },
  );
  it.each(["picture", "shape"])(
    "renders inherited dash, cap and join on %s without changing source XML",
    async (shapeKind) => {
      const f = await lineFormattingFixture({ shapeKind });
      const before = unzipSync(await P.savePresentation(f.pres));
      expect(P.getShapeStrokeDash(f.shape)).toBeNull();
      expect(P.getShapeStrokeCap(f.shape)).toBeNull();
      expect(P.getShapeStrokeJoin(f.shape)).toBeNull();
      // A dash's round caps are part of its length.
      expect(svg(f)).toContain('stroke-dasharray="18.00 24.00"');
      expect(svg(f)).toContain('stroke-linecap="round"');
      expect(svg(f)).toContain('stroke-linejoin="round"');
      expect(format(f)).toMatchObject({
        cap: "rnd",
        dash: { kind: "preset", value: "dash" },
        join: { kind: "round" },
      });
      expect(unzipSync(await P.savePresentation(f.pres))).toEqual(before);
    },
  );
  it("inherits properties independently and honors explicit solid, flat and bevel", async () => {
    const f = await lineFormattingFixture({
      local: lineProperties('<a:prstDash val="solid"/>', 'cap="flat"'),
      layout: lineProperties("<a:bevel/>"),
      master: lineProperties('<a:prstDash val="dot"/><a:round/>', 'cap="sq"'),
    });
    expect(format(f)).toMatchObject({
      cap: "flat",
      dash: { kind: "preset", value: "solid" },
      join: { kind: "bevel" },
    });
    expect(svg(f)).not.toContain("stroke-dasharray=");
    expect(svg(f)).toContain('stroke-linecap="butt"');
    expect(svg(f)).toContain('stroke-linejoin="bevel"');
  });
  it("uses the master when the layout leaves a property unspecified", async () => {
    const f = await lineFormattingFixture({
      layout: lineProperties(),
      master: lineProperties(
        '<a:prstDash val="lgDashDot"/><a:miter lim="350000"/>',
        'cap="sq"',
      ),
    });
    expect(format(f)).toMatchObject({
      cap: "sq",
      dash: { kind: "preset", value: "lgDashDot" },
      join: { kind: "miter", limit: 3.5 },
    });
    expect(svg(f)).toContain('stroke-miterlimit="3.5"');
  });
  it("consults each layer's line style before a more distant placeholder", async () => {
    const f = await lineFormattingFixture({
      local: lineProperties("<a:bevel/>"),
      localStyle: lineStyleRef(2),
      themeLines:
        lineProperties('<a:prstDash val="dot"/>', 'cap="flat"') +
        lineProperties('<a:prstDash val="sysDash"/><a:round/>', 'cap="sq"'),
    });
    expect(format(f)).toMatchObject({
      cap: "sq",
      dash: { kind: "preset", value: "sysDash" },
      join: { kind: "bevel" },
    });
    // A preset dash's square caps are part of its length.
    expect(svg(f)).toContain('stroke-dasharray="12.00 12.00"');
  });
  it("uses a layout's style reference with independently inherited master properties", async () => {
    const f = await lineFormattingFixture({
      layout: lineProperties("<a:bevel/>"),
      layoutStyle: lineStyleRef(1),
      master: lineProperties("<a:round/>", 'cap="rnd"'),
      themeLines: lineProperties('<a:prstDash val="lgDash"/>'),
    });
    expect(format(f)).toMatchObject({
      cap: "rnd",
      dash: { kind: "preset", value: "lgDash" },
      join: { kind: "bevel" },
    });
  });
  it.each([0, -1, "2x", "1.5", "0x1", "9007199254740993", 99])(
    "ignores unavailable or malformed style index %s",
    async (idx) => {
      const f = await lineFormattingFixture({ localStyle: lineStyleRef(idx) });
      expect(format(f).dash).toEqual({ kind: "preset", value: "dash" });
      expect(svg(f)).not.toMatch(/NaN|Infinity/);
    },
  );
  it("renders custom dash stops relative to the effective width", async () => {
    const f = await lineFormattingFixture({
      layout: lineProperties(custom, 'cap="flat"'),
    });
    expect(format(f).dash).toEqual({
      kind: "custom",
      stops: [
        { dash: 2.5, space: 0.75 },
        { dash: 0.5, space: 1.25 },
      ],
    });
    expect(svg(f)).toContain('stroke-dasharray="15.00 4.50 3.00 7.50"');
    P.setShapeStroke(f.shape, { widthEmu: 114300 });
    expect(svg(f)).toContain('stroke-dasharray="30.00 9.00 6.00 15.00"');
  });
  it("accepts strict percentage dash values and explicit zero lengths", async () => {
    const f = await lineFormattingFixture({
      local: lineProperties(
        '<a:custDash><a:ds d="0%" sp="125.5%"/></a:custDash>',
      ),
    });
    expect(format(f).dash).toEqual({
      kind: "custom",
      stops: [{ dash: 0, space: 1.255 }],
    });
    // Round caps take one width from the gap.
    expect(svg(f)).toContain('stroke-dasharray="0.00 13.53"');
  });
  it.each(["", '<a:ds d="0" sp="0"/>'])(
    "an explicit custom pattern (%s) blocks an inherited preset",
    async (stops) => {
      const f = await lineFormattingFixture({
        local: lineProperties(`<a:custDash>${stops}</a:custDash>`),
      });
      expect(format(f).dash.kind).toBe("custom");
      expect(svg(f)).not.toContain("stroke-dasharray=");
    },
  );
  it.each([
    'd="bad" sp="100000"',
    'd="-1" sp="100000"',
    'd="1e5" sp="100000"',
    'd="1.5" sp="100000"',
    'd="0x10" sp="100000"',
    'd="100000"',
  ])(
    "treats malformed custom stops (%s) as unspecified without partially rendering them",
    async (attrs) => {
      const f = await lineFormattingFixture({
        local: lineProperties(
          `<a:custDash><a:ds d="100000" sp="100000"/><a:ds ${attrs}/></a:custDash>`,
          'cap="invalid"',
        ),
      });
      expect(format(f)).toMatchObject({
        cap: "rnd",
        dash: { kind: "preset", value: "dash" },
      });
      expect(svg(f)).not.toMatch(/NaN|Infinity/);
    },
  );
  it("replacing a custom dash writes exactly one schema dash choice and retains joins/ends/extensions", async () => {
    const f = await lineFormattingFixture({
      local: lineProperties(
        `${custom}<a:bevel/><a:headEnd type="triangle"/><a:extLst/>`,
      ),
    });
    P.setShapeStrokeDash(f.shape, "solid");
    const xml = P.getShapeXmlString(f.shape);
    expect(xml).not.toContain("custDash");
    expect(xml.match(/<a:prstDash/g)).toHaveLength(1);
    expect(xml).toMatch(
      /prstDash[^>]*val="solid"[\s\S]*<a:bevel[\s\S]*<a:headEnd[\s\S]*<a:extLst/,
    );
    expect(svg(f)).not.toContain("stroke-dasharray=");
    const reopened = await parseDeck(await P.savePresentation(f.pres));
    expect(
      P.getShapeStrokeFormattingEffective(
        P.getSlideShapes(P.getSlides(reopened)[0])[0],
      ).dash,
    ).toEqual({ kind: "preset", value: "solid" });
  });
  it("inherits compound and arrow choices, including explicit single/none overrides", async () => {
    const f = await lineFormattingFixture({
      local: lineProperties('<a:headEnd type="none"/>', 'cmpd="sng"'),
      layout: lineProperties(
        '<a:headEnd type="triangle"/><a:tailEnd type="oval" w="lg" len="sm"/>',
        'cmpd="dbl"',
      ),
    });
    expect(format(f)).toMatchObject({
      compound: "sng",
      head: { type: "none" },
      tail: { type: "oval", width: "lg", length: "sm" },
    });
    expect(svg(f)).not.toContain("marker-start=");
    expect(svg(f)).toContain("marker-end=");
  });
  it("observes owning-theme replacement and does not share formatting across packages", async () => {
    const a = await lineFormattingFixture({
      localStyle: lineStyleRef(1),
      themeLines: lineProperties('<a:prstDash val="dot"/>'),
    });
    const b = await lineFormattingFixture({
      localStyle: lineStyleRef(1),
      themeLines: lineProperties('<a:prstDash val="lgDash"/>'),
    });
    expect(format(a).dash.value).toBe("dot");
    expect(format(b).dash.value).toBe("lgDash");
    const part = P._internalPackageOf(a.pres).getPart("/" + a.themeName);
    part.data = strToU8(
      strFromU8(part.data).replace('val="dot"', 'val="dashDot"'),
    );
    expect(format(a).dash.value).toBe("dashDot");
    expect(format(b).dash.value).toBe("lgDash");
  });
  it("retains source formatting through clipboard imports in both directions, edit and export", async () => {
    const source = await lineFormattingFixture({
      layout: lineProperties(custom + "<a:bevel/>", 'cap="sq"'),
    });
    const destination = createDeck("blank"),
      layout = P.getSlideLayout(P.getSlides(destination)[0]);
    const copy = P.importSlide(destination, source.slide, layout, {
      preservePaintFormatting: true,
    });
    const returned = P.importSlide(
      source.pres,
      copy,
      P.getSlideLayout(source.slide),
      { preservePaintFormatting: true },
    );
    for (const [pres, slide] of [
      [destination, copy],
      [source.pres, returned],
    ]) {
      const shape = P.getSlideShapes(slide)[0];
      expect(P.getShapeStrokeFormattingEffective(shape)).toEqual(
        format(source),
      );
      expect(svg({ pres, slide })).toContain(
        'stroke-dasharray="15.00 4.50 3.00 7.50"',
      );
      P.setShapeRotation(shape, 17);
      const reopened = await parseDeck(await P.savePresentation(pres)),
        last = P.getSlides(reopened).at(-1);
      expect(P.getShapeRotation(P.getSlideShapes(last)[0])).toBe(17);
      expect(
        P.getShapeStrokeFormattingEffective(P.getSlideShapes(last)[0]),
      ).toEqual(format(source));
    }
  });
  it("keeps malformed local properties consistent when copying into a different template", async () => {
    const source = await lineFormattingFixture({
      local: lineProperties(
        '<a:prstDash val="unknown"/><a:headEnd type="unknown"/>',
        'cap="bad" cmpd="bad"',
      ),
      layout: lineProperties(
        '<a:prstDash val="dash"/><a:headEnd type="triangle" w="lg"/>',
        'cap="sq" cmpd="sng"',
      ),
    });
    const target = createDeck("blank");
    const imported = P.importSlide(
      target,
      source.slide,
      P.getSlideLayout(P.getSlides(target)[0]),
      { preservePaintFormatting: true },
    );
    expect(
      P.getShapeStrokeFormattingEffective(P.getSlideShapes(imported)[0]),
    ).toEqual(format(source));
  });
});
