import { describe, it, expect } from "vitest";
import { P, createDeck, preview } from "../src/model.js";
import { implicitFontDeck } from "./diagram-font-default-copy-fixture.js";
import { encode, decode, sourceFonts } from "./diagram-font-copy-fixture.js";
import { readShapeDiagram } from "../lib/pptx/src/api/fn/diagram-read.ts";
import { themeForSlide } from "../lib/pptx/src/api/fn/shape-theme.ts";
import {
  NS,
  parseXml,
  serializeXml,
  elem,
  attr,
  firstChildElement,
  qname,
  getAttrValue,
} from "../lib/pptx/src/internal/xml/index.ts";
const svg = (p, s) =>
  decodeURIComponent(preview(p, s).split(",").slice(1).join(","));
const snapshot = (p) =>
  P._internalPackageOf(p).parts.map((part) => [part.name, part.data.slice()]);
const child = (el, name, ns = NS.dml) =>
  el && firstChildElement(el, qname("", name, ns));
const native = (el, name, ns) =>
  el.children.filter(
    (n) =>
      n.kind === "element" &&
      n.name.namespaceURI === ns &&
      n.name.localName === name,
  );
const defaults = (diagram) =>
  native(
    child(diagram.data.root, "ptLst", NS.diagram),
    "pt",
    NS.diagram,
  ).flatMap((pt) => {
    const body = child(pt, "t", NS.diagram);
    return body
      ? native(body, "p", NS.dml).map((p) => child(child(p, "pPr"), "defRPr"))
      : [];
  });
const family = (rPr, slot = "latin") =>
  rPr && getAttrValue(child(rPr, slot), qname("", "typeface", ""));
const transfer = (p, options = { preserveTextFormatting: true }) => {
  const target = createDeck("blank");
  P.setPresentationFonts(target, {
    majorLatin: "Arial",
    minorLatin: "Times New Roman",
    majorEastAsian: "Target EA",
    minorEastAsian: "Target ea",
    majorComplexScript: "Target CS",
    minorComplexScript: "Target cs",
  });
  const slide = P.importSlide(
    target,
    P.getSlides(p)[0],
    P.getSlideLayouts(target)[0],
    options,
  );
  return {
    target,
    slide,
    frame: P.getSlideShapes(slide)[0],
    diagram: readShapeDiagram(P.getSlideShapes(slide)[0]),
  };
};

describe("implicit font defaults in native diagram transfer", () => {
  it.each([false, true])(
    "preserves per-node major/minor metadata, edits, export and return; saved=%s",
    async (cached) => {
      const { p } = await implicitFontDeck({ cached });
      const before = snapshot(p),
        source = P.getSlides(p)[0],
        rendered = svg(p, source);
      const { target, slide, frame, diagram } = transfer(p);
      expect(defaults(diagram).map((r) => family(r))).toEqual([
        "Georgia",
        "Verdana",
        "Georgia",
      ]);
      for (const slot of ["ea", "cs"])
        expect(defaults(diagram).map((r) => family(r, slot))).toEqual(
          slot === "ea"
            ? [
                sourceFonts.majorEastAsian,
                sourceFonts.minorEastAsian,
                sourceFonts.majorEastAsian,
              ]
            : [
                sourceFonts.majorComplexScript,
                sourceFonts.minorComplexScript,
                sourceFonts.majorComplexScript,
              ],
        );
      expect(svg(target, slide)).toBe(rendered);
      expect(snapshot(p)).toEqual(before);
      expect(P.getPresentationFonts(target).minorLatin).toBe("Times New Roman");
      let reopened = await P.loadPresentation(await P.savePresentation(target));
      expect(svg(reopened, P.getSlides(reopened).at(-1))).toBe(rendered);
      const returned = P.importSlide(
        p,
        P.getSlides(reopened).at(-1),
        P.getSlideLayout(source),
        { preserveTextFormatting: true },
      );
      expect(svg(p, returned)).toBe(rendered);
      P.replaceShapeDiagramText(frame, [
        { modelId: "node0", text: "New western title" },
      ]);
      expect(svg(target, slide)).toContain("&quot;Georgia&quot;");
      expect(P.getShapeDiagramTextEntries(frame)[0].text).toBe(
        "New western title",
      );
      expect(svg(target, slide)).not.toContain("data-pptx-diagram-issues");
      reopened = await P.loadPresentation(await P.savePresentation(target));
      expect(svg(reopened, P.getSlides(reopened).at(-1))).toBe(
        svg(target, slide),
      );
      expect(P.validatePresentation(reopened)).toEqual([]);
      expect(P.validatePresentation(p)).toEqual([]);
    },
    30_000,
  );

  it.each(["minor", "none"])(
    "preserves saved %s override independently of semantic fonts",
    async (savedIndex) => {
      const { p } = await implicitFontDeck({
        cached: true,
        indices: ["major", "major", "major"],
        savedIndex,
      });
      const source = svg(p, P.getSlides(p)[0]),
        { target, slide, frame, diagram } = transfer(p);
      expect(source).toContain("&quot;Verdana&quot;");
      expect(svg(target, slide)).toBe(source);
      expect(defaults(diagram).map((r) => family(r))).toEqual([
        "Georgia",
        "Georgia",
        "Georgia",
      ]);
      expect(decode(diagram.drawing.part)).toContain(
        `fontRef idx="${savedIndex}"`,
      );
      P.replaceShapeDiagramText(frame, [
        { modelId: "node0", text: "Reflowed" },
      ]);
      expect(svg(target, slide)).toContain("&quot;Georgia&quot;");
      expect(svg(target, slide)).not.toContain("&quot;Verdana&quot;");
    },
  );

  it("uses native major for empty labels and minor host defaults for absent labels", async () => {
    const { p, diagram } = await implicitFontDeck({
      indices: ["empty", "none", "major"],
    });
    diagram.quickStyle.part.data = encode(
      decode(diagram.quickStyle.part).replace(
        /<d:styleLbl name="font2">.*?<\/d:styleLbl>/,
        "",
      ),
    );
    const copied = transfer(p);
    expect(defaults(copied.diagram).map((r) => family(r))).toEqual([
      "Georgia",
      "Verdana",
      "Verdana",
    ]);
    expect(svg(copied.target, copied.slide)).toBe(svg(p, P.getSlides(p)[0]));
  });

  it("takes list and paragraph font defaults before quick style while retaining run formatting", async () => {
    const { p, diagram } = await implicitFontDeck();
    diagram.data.part.data = encode(
      decode(diagram.data.part)
        .replace(
          "<a:lstStyle/>",
          '<a:lstStyle><a:defPPr><a:defRPr><a:latin typeface="Body default"/></a:defRPr></a:defPPr><a:lvl1pPr><a:defRPr><a:ea typeface="Local EA"/></a:defRPr></a:lvl1pPr></a:lstStyle>',
        )
        .replace(
          "<a:p>",
          '<a:p><a:pPr marL="123" algn="r"><a:defRPr b="1"><a:cs typeface="Local CS"/></a:defRPr></a:pPr>',
        )
        .replace(
          '<a:rPr sz="1000">',
          '<a:rPr sz="1000"><a:latin typeface="Run face"/>',
        ),
    );
    const copied = transfer(p),
      rPr = defaults(copied.diagram)[0];
    expect([family(rPr), family(rPr, "ea"), family(rPr, "cs")]).toEqual([
      "Body default",
      "Local EA",
      "Local CS",
    ]);
    for (const token of [
      'marL="123"',
      'algn="r"',
      'b="1"',
      'sz="1000"',
      'typeface="Run face"',
    ])
      expect(decode(copied.diagram.data.part)).toContain(token);
    expect(svg(copied.target, copied.slide)).toBe(svg(p, P.getSlides(p)[0]));
  });

  it("resolves diagram list depth and descriptors without adding unrelated formatting", async () => {
    const { p, diagram } = await implicitFontDeck();
    const theme = P._internalPackageOf(p).getPart(
      themeForSlide(P.getSlides(p)[0]).partName,
    );
    theme.data = encode(
      decode(theme).replace(
        'typeface="Georgia"',
        'typeface="Georgia" pitchFamily="34" panose="020B0604020202020204" charset="1"',
      ),
    );
    diagram.layout.part.data = encode(
      decode(diagram.layout.part).replace(
        "</d:layoutDef>",
        `<d:extLst><a:ext xmlns:a="${NS.dml}" uri="list"><n:lstStyle xmlns:n="${NS.dgm1612}"><a:lvl1pPr><a:defRPr><a:latin typeface="Layout font"/></a:defRPr></a:lvl1pPr></n:lstStyle></a:ext></d:extLst></d:layoutDef>`,
      ),
    );
    const copied = transfer(p);
    expect(defaults(copied.diagram).map((r) => family(r))).toEqual([
      "Layout font",
      "Layout font",
      "Layout font",
    ]);
    expect(decode(copied.diagram.data.part)).not.toContain('sz="1800"');
    // Remove the layout override to test metadata supplied by the theme slot.
    diagram.layout.part.data = encode(
      decode(diagram.layout.part).replace(/<d:extLst>.*<\/d:extLst>/, ""),
    );
    const normal = transfer(p);
    for (const field of [
      'pitchFamily="34"',
      'panose="020B0604020202020204"',
      'charset="1"',
    ])
      expect(decode(normal.diagram.data.part)).toContain(field);
  });

  it.each(["default", "paint only", "same slide"])(
    "retains source inheritance for %s",
    async (mode) => {
      const { p, frame } = await implicitFontDeck();
      const copied =
        mode === "same slide"
          ? readShapeDiagram(
              P.copyShape(P.getSlides(p)[0], frame, {
                preserveTextFormatting: true,
              }),
            )
          : transfer(
              p,
              mode === "paint only" ? { preservePaintFormatting: true } : {},
            ).diagram;
      expect(defaults(copied)).toEqual([null, null, null]);
    },
  );

  it("rejects irreconcilable defaults for shared semantic paragraphs before graph mutation", async () => {
    const { p, frame, diagram } = await implicitFontDeck();
    diagram.layout.part.data = encode(
      decode(diagram.layout.part).replace('st="2"', 'st="1"'),
    );
    const target = P.addSlide(p, { layout: P.getSlideLayouts(p)[0] }),
      before = snapshot(p);
    expect(() =>
      P.copyShape(target, frame, { preserveTextFormatting: true }),
    ).toThrow(/conflicting diagram font defaults/);
    expect(snapshot(p)).toEqual(before);
    expect(P.getSlideShapes(target)).toEqual([]);
    diagram.data.part.data = encode(
      decode(diagram.data.part).replace(
        "<a:p>",
        '<a:p><a:pPr><a:defRPr><a:latin typeface="Explicit"/><a:ea typeface="Explicit EA"/><a:cs typeface="Explicit CS"/></a:defRPr></a:pPr>',
      ),
    );
    expect(() =>
      P.copyShape(target, frame, { preserveTextFormatting: true }),
    ).not.toThrow();
  });

  it("selects only executed layout branches when resolving text-node fonts", async () => {
    const { p, diagram } = await implicitFontDeck();
    const layout = decode(diagram.layout.part);
    const box = layout.match(
      /<d:layoutNode name="box0"[\s\S]*?<\/d:layoutNode>/,
    )[0];
    const conditional = `<d:choose><d:if func="cnt" axis="ch" op="equ" val="3">${box}</d:if><d:else>${box.replace('styleLbl="font0"', 'styleLbl="font1"')}</d:else></d:choose>`;
    diagram.layout.part.data = encode(layout.replace(box, conditional));
    const copied = transfer(p);
    expect(defaults(copied.diagram).map((r) => family(r))).toEqual([
      "Georgia",
      "Verdana",
      "Georgia",
    ]);
    expect(svg(copied.target, copied.slide)).toBe(svg(p, P.getSlides(p)[0]));
  });

  it.each(["parameters", "text body"])(
    "retains malformed semantic %s and independently preserves a usable cache",
    async (mode) => {
      const { p, diagram } = await implicitFontDeck({
        cached: true,
        savedIndex: "major",
      });
      if (mode === "parameters")
        diagram.layout.part.data = encode(
          decode(diagram.layout.part).replace(
            '<d:alg type="tx"/>',
            '<d:alg type="tx"><d:param type="stBulletLvl" val="1.5"/></d:alg>',
          ),
        );
      else
        diagram.data.part.data = encode(
          decode(diagram.data.part).replace(/<a:p>[\s\S]*?<\/a:p>/, ""),
        );
      const original = decode(diagram.data.part),
        before = snapshot(p),
        copied = transfer(p);
      expect(decode(copied.diagram.data.part)).toBe(original);
      expect(decode(copied.diagram.drawing.part)).toContain(
        'typeface="Georgia"',
      );
      expect(decode(copied.diagram.layout.part)).toBe(
        decode(diagram.layout.part),
      );
      expect(snapshot(p)).toEqual(before);
      expect(P.validatePresentation(copied.target)).toEqual([]);
    },
  );

  it("does not choose a known default over an unresolved use of shared text", async () => {
    const { p, frame, diagram } = await implicitFontDeck();
    P.setPresentationFonts(p, {
      majorLatin: "",
      majorEastAsian: "",
      minorEastAsian: "",
      majorComplexScript: "",
      minorComplexScript: "",
    });
    diagram.layout.part.data = encode(
      decode(diagram.layout.part).replace('st="2"', 'st="1"'),
    );
    const target = P.addSlide(p, { layout: P.getSlideLayouts(p)[0] }),
      before = snapshot(p);
    expect(() =>
      P.copyShape(target, frame, { preserveTextFormatting: true }),
    ).toThrow(/conflicting diagram font defaults/);
    expect(snapshot(p)).toEqual(before);
  });

  it("uses the source presentation text style when fontRef cancels quick fonts", async () => {
    const { p } = await implicitFontDeck({ indices: ["none", "none", "none"] });
    const presentation = P._internalPackageOf(p).getPart(
      "/ppt/presentation.xml",
    );
    const doc = parseXml(decode(presentation));
    const other =
      child(doc.root, "defaultTextStyle", NS.pml) ??
      elem(qname("p", "defaultTextStyle", NS.pml));
    if (!doc.root.children.includes(other)) doc.root.children.push(other);
    other.children = [
      elem(qname("a", "lvl1pPr", NS.dml), {
        children: [
          elem(qname("a", "defRPr", NS.dml), {
            children: [
              elem(qname("a", "latin", NS.dml), {
                attrs: [attr(qname("", "typeface", ""), "Presentation font")],
              }),
            ],
          }),
        ],
      }),
    ];
    presentation.data = encode(serializeXml(doc));
    const copied = transfer(p);
    expect(defaults(copied.diagram).map((r) => family(r))).toEqual([
      "Presentation font",
      "Presentation font",
      "Presentation font",
    ]);
    expect(svg(copied.target, copied.slide)).toBe(svg(p, P.getSlides(p)[0]));
  });

  it("preserves defaults when relationship part names differ only by case", async () => {
    const { p } = await implicitFontDeck({ cached: true });
    const pkg = P._internalPackageOf(p),
      owner = P.getSlidePartName(P.getSlides(p)[0]);
    const rels = pkg.getRels(owner);
    rels.items = rels.items.map((rel) =>
      rel.type.includes("/diagram")
        ? { ...rel, target: rel.target.toUpperCase() }
        : rel,
    );
    pkg.setRels(owner, rels);
    const copied = transfer(p);
    expect(defaults(copied.diagram).map((r) => family(r))).toEqual([
      "Georgia",
      "Verdana",
      "Georgia",
    ]);
    expect(svg(copied.target, copied.slide)).toBe(svg(p, P.getSlides(p)[0]));
    expect(P.validatePresentation(copied.target)).toEqual([]);
  });

  it("copies native frames inside a group without mutating the source", async () => {
    const base = await implicitFontDeck({ cached: true });
    const source = P.getSlides(base.p)[0],
      pkg = P._internalPackageOf(base.p);
    const part = pkg.getPart(P.getSlidePartName(source)),
      doc = parseXml(decode(part));
    const tree = child(child(doc.root, "cSld", NS.pml), "spTree", NS.pml);
    const frame = native(tree, "graphicFrame", NS.pml)[0];
    const group = elem(qname("p", "grpSp", NS.pml), {
      children: [
        elem(qname("p", "nvGrpSpPr", NS.pml)),
        elem(qname("p", "grpSpPr", NS.pml)),
        frame,
      ],
    });
    tree.children[tree.children.indexOf(frame)] = group;
    part.data = encode(serializeXml(doc));
    const p = await P.loadPresentation(await P.savePresentation(base.p));
    const original = P.getSlideShapes(P.getSlides(p)[0])[0];
    const target = P.addSlide(p, { layout: P.getSlideLayouts(p)[0] }),
      before = decode(
        readShapeDiagram(P.getGroupChildren(original)[0]).data.part,
      );
    const copied = P.copyShape(target, original, {
      preserveTextFormatting: true,
    });
    expect(
      defaults(readShapeDiagram(P.getGroupChildren(copied)[0])).map((r) =>
        family(r),
      ),
    ).toEqual(["Georgia", "Verdana", "Georgia"]);
    expect(
      decode(readShapeDiagram(P.getGroupChildren(original)[0]).data.part),
    ).toBe(before);
    expect(P.validatePresentation(p)).toEqual([]);
  });

  it("keeps opaque namespaces/extensions and unresolved script slots intact", async () => {
    const { p, diagram } = await implicitFontDeck();
    P.setPresentationFonts(p, {
      majorEastAsian: "",
      minorEastAsian: "",
      majorComplexScript: "",
      minorComplexScript: "",
    });
    diagram.data.part.data = encode(
      decode(diagram.data.part).replace(
        "<a:lstStyle/>",
        '<a:lstStyle/><opaque:wrapper xmlns:opaque="urn:opaque"><a:latin typeface="+mj-lt"/></opaque:wrapper>',
      ),
    );
    const copied = transfer(p);
    expect(decode(copied.diagram.data.part)).toContain('typeface="+mj-lt"');
    expect(
      defaults(copied.diagram).every(
        (r) => child(r, "ea") === null && child(r, "cs") === null,
      ),
    ).toBe(true);
    expect(P.validatePresentation(copied.target)).toEqual([]);
  });
});
