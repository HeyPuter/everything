import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";
import { textStyleFixture } from "./text-style-copy-fixture.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import { NS, parseXml } from "../lib/pptx/src/internal/xml/index.ts";

const format = (f, level = 0) =>
  P.getShapeRunFormatEffective(f.pres, f.shape, level, 0);
const imported = (pres, slide) => ({
  pres,
  slide,
  shape: P.getSlideShapes(slide).find((s) =>
    P.getShapeText(s).startsWith("Outline"),
  ),
});
const copyTo = (source, target) =>
  imported(
    target.pres,
    P.importSlide(target.pres, source.slide, P.getSlideLayout(target.slide), {
      preserveTextFormatting: true,
    }),
  );
const visit = (el) => [
  el,
  ...el.children.flatMap((c) => (c.kind === "element" ? visit(c) : [])),
];
const get = (el, name) =>
  el.attrs.find((a) => a.name.localName === name)?.value;

describe("source text styles across copy boundaries", () => {
  it.each([
    { family: "Source Serif", color: "4E7289" },
    { family: "A Different Face", color: "A27135" },
  ])(
    "preserves all nine levels, body properties and theme formatting: $family",
    async (options) => {
      const source = await textStyleFixture(options),
        target = await textStyleFixture({
          family: "Host Face",
          color: "CB0912",
          hostile: true,
        });
      const copied = copyTo(source, target);
      for (let level = 0; level < 9; level++) {
        expect(format(copied, level)).toMatchObject(format(source, level));
        expect(format(copied, level)).toMatchObject({
          bold: false,
          italic: false,
          font: options.family,
          fontEastAsian: `${options.family} East Asian`,
        });
        expect(
          P.getParagraphPropertiesEffective(copied.pres, copied.shape, level),
        ).toMatchObject(
          Object.fromEntries(
            Object.entries(
              P.getParagraphPropertiesEffective(
                source.pres,
                source.shape,
                level,
              ),
            ).filter(([, v]) => v !== null),
          ),
        );
      }
      expect(
        P.getShapeBodyPrEffective(copied.pres, copied.shape),
      ).toMatchObject({
        ...P.getShapeBodyPrEffective(source.pres, source.shape),
        wrap: "square",
        compatibleLineSpacing: true,
        includeOuterSpacing: false,
        anchorCenter: false,
      });
      expect(
        P.getShapeFieldFormatEffective(copied.pres, copied.shape, 0, 0),
      ).toMatchObject(
        P.getShapeFieldFormatEffective(source.pres, source.shape, 0, 0),
      );
      expect(
        P.getShapeBreakFormatEffective(copied.pres, copied.shape, 0, 0),
      ).toMatchObject({ size: 13, font: options.family });
      expect(
        P.getShapeParagraphEndFormatEffective(copied.pres, copied.shape, 0),
      ).toMatchObject({ size: 11, font: options.family });
    },
  );
  it("preserves presentation-wide default character and paragraph properties", async () => {
    const source = await textStyleFixture({ rich: false }),
      files = unzipSync(await P.savePresentation(source.pres));
    for (const name of Object.keys(files))
      if (
        /ppt\/(?:slideLayouts|slideMasters)\//.test(name) &&
        name.endsWith(".xml")
      )
        files[name] = strToU8(
          strFromU8(files[name])
            .replace(/<a:lstStyle>[\s\S]*?<\/a:lstStyle>/g, "<a:lstStyle/>")
            .replace(/<p:txStyles>[\s\S]*?<\/p:txStyles>/g, "<p:txStyles/>"),
        );
    files["ppt/presentation.xml"] = strToU8(
      strFromU8(files["ppt/presentation.xml"]).replace(
        /<\/p:presentation>/,
        '<p:defaultTextStyle><a:lvl1pPr algn="r"><a:buNone/><a:defRPr sz="3100" b="1"><a:solidFill><a:srgbClr val="386949"/></a:solidFill><a:latin typeface="Georgia"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle></p:presentation>',
      ),
    );
    const loaded = await parseDeck(zipSync(files)),
      original = imported(loaded, P.getSlides(loaded)[0]),
      target = await textStyleFixture({
        family: "Host Face",
        color: "FF1100",
        hostile: true,
      });
    const expected = { size: 31, font: "Georgia", color: "#386949" };
    expect(format(original)).toMatchObject(expected);
    const copied = copyTo(original, target);
    expect(format(copied)).toMatchObject(expected);
    expect(
      P.getParagraphPropertiesEffective(copied.pres, copied.shape, 0).align,
    ).toBe("right");
  });
  it.each(["major", "minor"])(
    "preserves %s font references and their transformed text color",
    async (idx) => {
      const pres = createDeck("blank"),
        slide = P.getSlides(pres)[0];
      P.setPresentationFonts(pres, {
        majorLatin: "Georgia",
        minorLatin: "Verdana",
      });
      P.addSlideTextBox(slide, {
        x: 400000,
        y: 550000,
        w: 4200000,
        h: 1600000,
        text: "Font reference",
      });
      const files = unzipSync(await P.savePresentation(pres)),
        name = P.getSlidePartName(slide).slice(1);
      files[name] = strToU8(
        strFromU8(files[name]).replace(
          "<p:txBody>",
          `<p:style><a:lnRef idx="0"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="${idx}"><a:srgbClr val="193C64"><a:alpha val="45000"/></a:srgbClr></a:fontRef></p:style><p:txBody>`,
        ),
      );
      const loaded = await parseDeck(zipSync(files)),
        source = { pres: loaded, slide: P.getSlides(loaded)[0] };
      source.shape = P.getSlideShapes(source.slide)[0];
      const expected = {
        font: idx === "major" ? "Georgia" : "Verdana",
        color: "#193C64",
        colorOpacity: 0.45,
      };
      expect(format(source)).toMatchObject(expected);
      const target = await textStyleFixture({
          family: "Host Face",
          color: "FFFF00",
          hostile: true,
        }),
        copy = P.importSlide(
          target.pres,
          source.slide,
          P.getSlideLayout(target.slide),
          { preserveTextFormatting: true },
        ),
        shape = P.getSlideShapes(copy)[0];
      expect(
        P.getShapeRunFormatEffective(target.pres, shape, 0, 0),
      ).toMatchObject(expected);
    },
  );
  it("uses the owning master's theme instead of the package's first theme", async () => {
    const source = await textStyleFixture({ rich: false }),
      pkg = P._internalPackageOf(source.pres),
      theme = pkg.parts.find(
        (p) => p.name.startsWith("/ppt/theme/") && p.name.endsWith(".xml"),
      );
    pkg.addPart(
      "/ppt/theme/z-owner.xml",
      theme.contentType,
      strToU8(
        strFromU8(theme.data)
          .replaceAll("Source Serif", "Owner Serif")
          .replaceAll("4E7289", "A73C59"),
      ),
    );
    const master = P.getSlideMasterPartName(source.slide),
      rels = pkg.getRels(master);
    rels.items.find((r) => r.type.endsWith("/theme")).target =
      "../theme/z-owner.xml";
    pkg.setRels(master, rels);
    const ownerFormat = format(source);
    expect(ownerFormat.font).toBe("Owner Serif");
    const target = await textStyleFixture({
        family: "Destination Face",
        color: "008800",
        hostile: true,
      }),
      copied = copyTo(source, target);
    expect(format(copied)).toMatchObject(ownerFormat);
    expect(P.getShapeXmlString(copied.shape)).toContain('val="A73C59"');
    expect(P.getPresentationFonts(source.pres).majorLatin).toBe("Source Serif");
  });
  it("keeps text placement when omitted source body and paragraph defaults become explicit", async () => {
    const source = await textStyleFixture({ rich: false }),
      target = { pres: createDeck("blank") };
    target.slide = P.getSlides(target.pres)[0];
    const copied = copyTo(source, target);
    const textNodes = (f) =>
      renderSlideToSvg(f.pres, f.slide, {
        textLayout: "svg",
        stableDefinitionIds: true,
        resolveFontFamily: (f) => f,
        measureText: (text, spec) => ({
          widthPx: text.length * spec.sizePx * 0.5,
          ascentPx: spec.sizePx * 0.8,
          descentPx: spec.sizePx * 0.2,
          lineGapPx: 0,
        }),
      }).match(/<text\b[\s\S]*?<\/text>/g);
    expect(textNodes(copied)).toEqual(textNodes(source));
  });
  it("survives clipboard imports, return copies, edits and PPTX reload", async () => {
    const original = await textStyleFixture(),
      other = await textStyleFixture({
        family: "Different Face",
        color: "AA0066",
        hostile: true,
      }),
      clip = { pres: createDeck("blank") };
    clip.slide = P.getSlides(clip.pres)[0];
    const before = unzipSync(await P.savePresentation(original.pres));
    const held = copyTo(original, clip),
      pasted = copyTo(held, other),
      returned = copyTo(pasted, original);
    for (const f of [held, pasted, returned])
      for (let level = 0; level < 9; level++)
        expect(format(f, level)).toMatchObject(format(original, level));
    const samePackage = P.copyShape(other.slide, pasted.shape, {
        preserveTextFormatting: true,
      }),
      same = imported(other.pres, other.slide);
    same.shape = samePackage;
    expect(format(same)).toMatchObject(format(original));
    P.setShapeTextFormat(samePackage, { size: 37, bold: true });
    const reloaded = await parseDeck(await P.savePresentation(other.pres)),
      shape = P.getSlideShapes(P.getSlides(reloaded)[0]).find(
        (s) => P.getShapeId(s) === P.getShapeId(samePackage),
      );
    expect(P.getShapeRunFormatEffective(reloaded, shape, 0, 0)).toMatchObject({
      size: 37,
      bold: true,
      font: "Source Serif",
    });
    for (const [name, bytes] of Object.entries(before))
      if (!name.includes("presentation") && !name.includes("[Content_Types]"))
        expect(
          unzipSync(await P.savePresentation(original.pres))[name],
        ).toEqual(bytes);
  });
  it("retains raw tabs, bullet choices, font descriptors, color transforms, field IDs and extension namespace scopes", async () => {
    const source = await textStyleFixture(),
      target = { pres: createDeck("blank") };
    target.slide = P.getSlides(target.pres)[0];
    const f = copyTo(source, target),
      xml = P.getShapeXmlString(f.shape),
      nodes = visit(parseXml(xml).root);
    expect(xml).toContain('pos="234567"');
    expect(xml).toContain('id="{B3E7451F-4EDC-4D1C-9362-F92615ABCD00}"');
    const fonts = nodes.filter(
      (el) =>
        el.name.localName === "latin" && get(el, "typeface") === "Source Serif",
    );
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts)
      expect(get(font, "panose")).toBe("02020503050505020204");
    expect(nodes.some((el) => el.name.localName === "schemeClr")).toBe(false);
    const color = nodes.find(
      (el) => el.name.localName === "srgbClr" && get(el, "val") === "4E7289",
    );
    expect(
      color.children
        .filter((el) => el.kind === "element")
        .map((el) => [el.name.localName, get(el, "val")]),
    ).toEqual([
      ["alpha", "65000"],
      ["tint", "15000"],
    ]);
    const payload = nodes.find(
      (el) => el.name.namespaceURI === "urn:copy:payload",
    );
    expect(payload).toBeTruthy();
    expect(payload.prefixDecls.get("descriptor")).toBe("urn:copy:font");
    expect(
      nodes.some((el) => el.name.namespaceURI === "urn:copy:master-data"),
    ).toBe(true);
    const second = nodes.filter((el) => el.name.localName === "p")[1],
      pPr = second.children.find(
        (el) => el.kind === "element" && el.name.localName === "pPr",
      );
    expect(
      pPr.children
        .filter(
          (el) =>
            el.kind === "element" &&
            ["buNone", "buBlip", "buChar", "buAutoNum"].includes(
              el.name.localName,
            ),
        )
        .map((el) => el.name.localName),
    ).toEqual(["buNone"]);
  });
  it.each([false, true])(
    "rebinds inherited rIds by their actual owner through %s group copying",
    async (group) => {
      const source = await textStyleFixture({ group }),
        target = await textStyleFixture({ family: "Host Face", hostile: true }),
        copied = copyTo(source, target);
      const saved = unzipSync(await P.savePresentation(target.pres)),
        name = P.getSlidePartName(copied.slide).slice(1),
        rels = visit(
          parseXml(strFromU8(saved[name.replace(/([^/]+)$/, "_rels/$1.rels")]))
            .root,
        ).filter((el) => el.name.localName === "Relationship");
      const xml = visit(parseXml(P.getShapeXmlString(copied.shape)).root);
      for (const node of xml.filter((el) =>
        ["hlinkClick", "hlinkMouseOver"].includes(el.name.localName),
      )) {
        const id = node.attrs.find(
          (a) => a.name.namespaceURI === NS.officeDocRels,
        ).value;
        expect(
          get(
            rels.find((rel) => get(rel, "Id") === id),
            "Target",
          ),
        ).toBe(
          `https://example.org/${node.name.localName === "hlinkClick" ? "layout" : "master"}`,
        );
      }
      const images = rels.filter((rel) => get(rel, "Type").endsWith("/image"));
      expect(images).toHaveLength(1);
      expect(saved[get(images[0], "Target").replace(/^\//, "")]).toEqual(
        source.files["ppt/media/bullet.png"],
      );
      const rootShape = group ? source.group : source.shape,
        directSlide = P.addSlide(source.pres, {
          layout: P.getSlideLayout(source.slide),
        }),
        direct = P.copyShape(directSlide, rootShape, {
          preserveTextFormatting: true,
        }),
        member = group ? P.getGroupChildren(direct)[0] : direct;
      expect(
        P.getShapeRunFormatEffective(source.pres, member, 0, 0),
      ).toMatchObject(format(source));
    },
  );
});
