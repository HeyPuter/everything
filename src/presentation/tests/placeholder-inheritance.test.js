import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, parseDeck, preview } from "../src/model.js";

const ph = (type, idx) =>
  `<p:ph${type == null ? "" : ` type="${type}"`}${idx == null ? "" : ` idx="${idx}"`}/>`;
// DrawingML requires fill before font; out-of-order fill is ignored.
const list = (size, color, align) =>
  `<a:lstStyle><a:lvl1pPr algn="${align}" marL="0" indent="0"><a:buNone/><a:defRPr sz="${size * 100}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:lvl1pPr></a:lstStyle>`;
const bounds =
  '<a:xfrm><a:off x="100000" y="200000"/><a:ext cx="3000000" cy="2000000"/></a:xfrm>';
const properties = `${bounds}<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="008000"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln><a:effectLst><a:glow rad="12700"><a:srgbClr val="008000"/></a:glow></a:effectLst>`;
const slot = (id, type, idx, defaults, spPr = "", bodyPr = "") =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Slot ${id}"/><p:cNvSpPr/><p:nvPr>${ph(type, idx)}</p:nvPr></p:nvSpPr><p:spPr>${spPr}</p:spPr><p:txBody><a:bodyPr ${bodyPr}/>${defaults}<a:p/></p:txBody></p:sp>`;
async function fixture({
  type = "body",
  idx = 4,
  layoutIdx = idx,
  plain = false,
  masterDefaults = true,
  layoutProperties = "",
  layoutDefaults = "<a:lstStyle/>",
  layoutBodyPr = "",
  inline = "<a:r><a:t>Probe</a:t></a:r>",
} = {}) {
  const p = createDeck("blank"),
    s = P.getSlides(p)[0];
  P.addSlideTextBox(s, {
    x: 0,
    y: 0,
    w: P.inches(4),
    h: P.inches(2),
    text: "Seed",
  });
  const files = unzipSync(await P.savePresentation(p));
  const sn = P.getSlidePartName(s).slice(1),
    ln = P.getSlideLayoutPartName(P.getSlideLayout(s)).slice(1),
    mn = P.getSlideMasterPartName(s).slice(1);
  let shape = slot(80, type, idx, "<a:lstStyle/>").replace(
    "<a:p/>",
    `<a:p>${inline}</a:p>`,
  );
  if (plain) shape = shape.replace(ph(type, idx), "");
  files[sn] = strToU8(
    strFromU8(files[sn]).replace(/<p:sp\b[\s\S]*?<\/p:sp>/, shape),
  );
  files[ln] = strToU8(
    strFromU8(files[ln])
      .replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, "")
      .replace(
        "</p:spTree>",
        slot(
          81,
          type,
          layoutIdx,
          layoutDefaults,
          layoutProperties,
          layoutBodyPr,
        ) + "</p:spTree>",
      ),
  );
  const masterShapes = [
    slot(
      82,
      "body",
      31,
      masterDefaults ? list(24, "008000", "l") : "<a:lstStyle/>",
      properties,
      'lIns="12345" anchor="b"',
    ),
    slot(83, "title", 32, list(32, "0000FF", "ctr")),
    // Its index deliberately collides with the layout content slot.
    slot(84, "sldNum", 4, list(12, "FF0000", "r")),
    slot(85, "dt", 33, list(16, "800080", "ctr")),
    slot(86, "ftr", 34, list(18, "008080", "r")),
  ].join("");
  files[mn] = strToU8(
    strFromU8(files[mn])
      .replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, "")
      .replace("</p:spTree>", masterShapes + "</p:spTree>")
      .replace(
        /<p:bodyStyle>[\s\S]*?<\/p:bodyStyle>/,
        '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2600"/></a:lvl1pPr></p:bodyStyle>',
      ),
  );
  const pres = await parseDeck(zipSync(files)),
    slide = P.getSlides(pres)[0];
  return { pres, slide, shape: P.getSlideShapes(slide)[0] };
}
const format = (f) => P.getShapeRunFormatEffective(f.pres, f.shape, 0, 0);

describe("placeholder inheritance identities", () => {
  // Native reference controls distinguish the body/title/date/footer master
  // slots even when the layout index equals the master's slide-number index.
  it.each([
    null,
    "obj",
    "body",
    "subTitle",
    "chart",
    "tbl",
    "pic",
    "media",
    "dgm",
    "clipArt",
  ])(
    "maps %s content to the body master independently of index",
    async (type) => {
      const f = await fixture({ type });
      expect(format(f)).toMatchObject({ size: 24, color: "#008000" });
      expect(P.getParagraphPropertiesEffective(f.pres, f.shape, 0).align).toBe(
        "left",
      );
      expect(P.getShapeBodyPrEffective(f.pres, f.shape)).toMatchObject({
        anchor: "bottom",
        margins: { left: 12345 },
      });
    },
  );
  it.each([
    ["title", 32, "center", "#0000FF"],
    ["ctrTitle", 32, "center", "#0000FF"],
    ["dt", 16, "center", "#800080"],
    ["ftr", 18, "right", "#008080"],
    ["sldNum", 12, "right", "#FF0000"],
  ])("matches the %s master type", async (type, size, align, color) => {
    const f = await fixture({ type });
    expect(format(f)).toMatchObject({ size, color });
    expect(P.getParagraphPropertiesEffective(f.pres, f.shape, 0).align).toBe(
      align,
    );
  });
  it("uses schema defaults for omitted placeholder type and index", async () => {
    const f = await fixture({ type: null, idx: null, layoutIdx: 0 });
    expect(format(f)).toMatchObject({ size: 24, color: "#008000" });
    expect(P.getShapeBoundsResolved(f.pres, f.shape)).toEqual({
      x: 100000,
      y: 200000,
      w: 3000000,
      h: 2000000,
    });
  });
  it.each([
    [null, 24],
    ["obj", 24],
    ["body", 24],
    ["subTitle", 24],
    ["chart", 24],
    ["tbl", 24],
    ["pic", 24],
    ["media", 24],
    ["dgm", 24],
    ["clipArt", 24],
    ["title", 32],
    ["ctrTitle", 32],
    ["dt", 16],
    ["ftr", 18],
    ["sldNum", 12],
  ])(
    "resolves an unassigned %s index directly from the master",
    async (type, size) => {
      const f = await fixture({ type, idx: 0xffffffff, layoutIdx: 7 });
      expect(format(f).size).toBe(size);
    },
  );
  it("bypasses every layout property for an unassigned placeholder", async () => {
    const options = {
      layoutIdx: 7,
      layoutDefaults: list(9, "800080", "r"),
      layoutBodyPr: 'anchor="t" lIns="254000"',
      layoutProperties:
        '<a:xfrm><a:off x="500000" y="600000"/><a:ext cx="7000000" cy="4000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/>',
    };
    const assigned = await fixture({ ...options, idx: 7 });
    expect(format(assigned)).toMatchObject({ size: 9, color: "#800080" });
    expect(
      P.getShapeBodyPrEffective(assigned.pres, assigned.shape),
    ).toMatchObject({ anchor: "top", margins: { left: 254000 } });
    expect(P.getShapeBoundsResolved(assigned.pres, assigned.shape).x).toBe(
      500000,
    );
    expect(
      P.getShapeGeometryEffective(assigned.pres, assigned.shape).preset,
    ).toBe("rect");
    expect(P.getShapeFillEffective(assigned.pres, assigned.shape).kind).toBe(
      "none",
    );
    const unassigned = await fixture({ ...options, idx: 0xffffffff });
    expect(format(unassigned)).toMatchObject({ size: 24, color: "#008000" });
    expect(
      P.getParagraphPropertiesEffective(unassigned.pres, unassigned.shape, 0)
        .align,
    ).toBe("left");
    expect(
      P.getShapeBodyPrEffective(unassigned.pres, unassigned.shape),
    ).toMatchObject({ anchor: "bottom", margins: { left: 12345 } });
    expect(P.getShapeBoundsResolved(unassigned.pres, unassigned.shape).x).toBe(
      100000,
    );
    expect(
      P.getShapeGeometryEffective(unassigned.pres, unassigned.shape).preset,
    ).toBe("ellipse");
    expect(
      P.getShapeFillEffective(unassigned.pres, unassigned.shape),
    ).toMatchObject({ kind: "solid", color: "#008000" });
    expect(
      P.getShapeStrokeEffective(unassigned.pres, unassigned.shape),
    ).toMatchObject({ kind: "solid", color: "#0000FF" });
    expect(
      P.getShapeEffectsEffective(unassigned.pres, unassigned.shape)[0].kind,
    ).toBe("glow");
  });
  it.each([{ idx: 99, layoutIdx: 4 }, { plain: true }])(
    "does not borrow an unrelated slot for %j",
    async (options) => {
      const f = await fixture(options);
      // A placeholder its layout lacks still takes the master's text style
      // for its type (as the desktop app draws it), but no slot's own
      // properties.
      expect(format(f).size).toBe(options.plain ? undefined : 26);
      expect(P.getShapeBoundsResolved(f.pres, f.shape)).toBeNull();
      expect(P.getShapeFillEffective(f.pres, f.shape).kind).toBe("inherit");
      expect(
        P.getShapeBodyPrEffective(f.pres, f.shape).margins.left,
      ).toBeNull();
    },
  );
  it("shares the same ancestry for geometry, bounds, paint and effects", async () => {
    const f = await fixture();
    expect(P.getShapeGeometryEffective(f.pres, f.shape)).toMatchObject({
      kind: "preset",
      preset: "ellipse",
    });
    expect(P.getShapeBoundsResolved(f.pres, f.shape).x).toBe(100000);
    expect(P.getShapeFillEffective(f.pres, f.shape)).toEqual({
      kind: "solid",
      color: "#008000",
    });
    expect(P.getShapeStrokeEffective(f.pres, f.shape)).toEqual({
      kind: "solid",
      color: "#0000FF",
      widthEmu: 25400,
    });
    expect(P.getShapeEffectsEffective(f.pres, f.shape)[0].kind).toBe("glow");
    const override = await fixture({
      layoutProperties: `${bounds}<a:noFill/><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
    });
    expect(P.getShapeFillEffective(override.pres, override.shape).kind).toBe(
      "none",
    );
    expect(
      P.getShapeGeometryEffective(override.pres, override.shape).preset,
    ).toBe("rect");
  });
  it("uses body text style for explicit content types when the master slot has no defaults", async () => {
    expect(
      format(await fixture({ type: "obj", masterDefaults: false })).size,
    ).toBe(26);
  });
  it("uses the same master for fields, breaks and paragraph insertion points", async () => {
    const f = await fixture({
      inline:
        '<a:fld id="{00000000-0000-0000-0000-000000000001}" type="slidenum"><a:t>1</a:t></a:fld><a:br/><a:endParaRPr i="1"/>',
    });
    expect(P.getShapeFieldFormatEffective(f.pres, f.shape, 0, 0).size).toBe(24);
    expect(P.getShapeBreakFormatEffective(f.pres, f.shape, 0, 0).size).toBe(24);
    expect(
      P.getShapeParagraphEndFormatEffective(f.pres, f.shape, 0),
    ).toMatchObject({ size: 24, italic: true });
  });
  it.each([4, 0xffffffff])(
    "preserves source parts, edits and duplicated slides through export (idx %s)",
    async (idx) => {
      const f = await fixture({ idx, layoutIdx: 4 }),
        before = unzipSync(await P.savePresentation(f.pres));
      preview(f.pres, f.slide);
      expect(unzipSync(await P.savePresentation(f.pres))).toEqual(before);
      let pres = await parseDeck(await P.savePresentation(f.pres));
      for (let i = 0; i < 2; i++) {
        P.duplicateSlide(pres, P.getSlides(pres).at(-1));
        pres = await parseDeck(await P.savePresentation(pres));
        const shape = P.getSlideShapes(P.getSlides(pres).at(-1))[0];
        expect(format({ pres, shape })).toMatchObject({
          size: 24,
          color: "#008000",
        });
        expect(P.getParagraphPropertiesEffective(pres, shape, 0).align).toBe(
          "left",
        );
        expect(P.getShapeBoundsResolved(pres, shape).x).toBe(100000);
        P.setShapeRunFormat(shape, 0, 0, { italic: true });
        expect(format({ pres, shape })).toMatchObject({
          size: 24,
          italic: true,
        });
      }
      expect(unzipSync(await P.savePresentation(f.pres))).toEqual(before);
    },
  );
});
