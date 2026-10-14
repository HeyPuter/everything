import { describe, it, expect } from "vitest";
import { P, createDeck, preview } from "../src/model.js";
import {
  diagramMatrixDeck,
  encode,
  decode,
  child,
  xml,
  refs,
} from "./diagram-matrix-copy-fixture.js";
import { createDiagramMatrixCopy } from "../lib/pptx/src/api/fn/diagram-matrix-copy.ts";
import { readShapeDiagram } from "../lib/pptx/src/api/fn/diagram-read.ts";
import { importSlideTemplates } from "../lib/pptx/src/api/fn/template-import.ts";
import { themeForShape } from "../lib/pptx/src/api/fn/shape-theme.ts";
import { copyPartGraph } from "../lib/pptx/src/internal/parts/copy-graph.ts";
import { REL_TYPES } from "../lib/pptx/src/internal/presentationml/index.ts";
import {
  NS,
  parseXml,
  serializeXml,
  serializeFragment,
  walkElements,
  getAttrValue,
  qname,
} from "../lib/pptx/src/internal/xml/index.ts";
const value = (e, n) => getAttrValue(e, qname("", n, ""));
const normalized = (s) => {
  const ids = new Map();
  return s.replace(/pkdef-[\da-z]+/g, (id) => {
    if (!ids.has(id)) ids.set(id, `def-${ids.size}`);
    return ids.get(id);
  });
};
const svg = (p, slide = P.getSlides(p)[0]) =>
  normalized(
    decodeURIComponent(preview(p, slide).split(",").slice(1).join(",")),
  );
const snapshot = (p) =>
  P._internalPackageOf(p).parts.map((part) => [part.name, part.data.slice()]);
const matrix = (theme) =>
  child(child(theme.root, "themeElements"), "fmtScheme");
const listEntries = (theme, n) =>
  child(matrix(theme), n).children.filter((c) => c.kind === "element");
const setup = (p, target, preserve = true) =>
  createDiagramMatrixCopy(
    {
      sourceSlide: P.getSlides(p)[0],
      targetThemeOwner: P.getSlidePartName(P.getSlides(target)[0]),
      preservePaintFormatting: preserve,
    },
    P._internalPackageOf(target),
  );
const styleDoc = (content) =>
  parseXml(
    `<d:styleDef xmlns:d="${NS.diagram}" xmlns:a="${NS.dml}" xmlns:o="urn:opaque"><d:styleLbl name="node1"><d:style>${content}</d:style></d:styleLbl></d:styleDef>`,
  );
const commit = (op, p, target) =>
  op.commit(
    copyPartGraph(P._internalPackageOf(p), P._internalPackageOf(target), [
      ...op.roots,
    ]),
  );

describe("native diagram style-matrix transfer", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "preserves saved=%s image=%s through export, reflow and return",
    async (cached, image) => {
      const { p, frame } = await diagramMatrixDeck({ cached, image }),
        before = snapshot(p),
        expected = svg(p),
        target = createDeck("blank"),
        targetTheme = P.getPresentationTheme(target),
        imported = P.importSlide(
          target,
          P.getSlides(p)[0],
          P.getSlideLayouts(target)[0],
          { preserveTextFormatting: true, preservePaintFormatting: true },
        );
      expect(expected).toContain('stroke-width="9.45"');
      expect(expected).toContain(image ? "data:image/png" : "<linearGradient");
      expect(svg(target, imported)).toBe(expected);
      expect(snapshot(p)).toEqual(before);
      expect(P.getPresentationTheme(target)).toEqual(targetTheme);
      const copied = P.getSlideShapes(imported)[0],
        diagram = readShapeDiagram(copied);
      expect(decode(diagram.quickStyle.part)).not.toContain('lnRef idx="2"');
      const reopened = await P.loadPresentation(
          await P.savePresentation(target),
        ),
        reopenedSlide = P.getSlides(reopened).at(-1);
      expect(svg(reopened, reopenedSlide)).toBe(expected);
      expect(P.validatePresentation(reopened)).toEqual([]);
      const back = P.importSlide(
        p,
        reopenedSlide,
        P.getSlideLayout(P.getSlides(p)[0]),
        { preserveTextFormatting: true, preservePaintFormatting: true },
      );
      expect(svg(p, back)).toBe(expected);
      expect(P.validatePresentation(p)).toEqual([]);
      expect(P.getShapeDiagramTextEntries(P.getSlideShapes(back)[0])).toEqual(
        P.getShapeDiagramTextEntries(frame),
      );
      if (!cached) {
        P.replaceShapeDiagramText(copied, [
          { modelId: "node0", text: "Updated" },
        ]);
        expect(svg(target, imported)).toContain("Updated");
        expect(svg(target, imported)).toContain('stroke-width="9.45"');
        expect(svg(target, imported)).not.toContain("data-pptx-diagram-issues");
        const edited = await P.loadPresentation(
          await P.savePresentation(target),
        );
        expect(svg(edited, P.getSlides(edited).at(-1))).toBe(
          svg(target, imported),
        );
      }
    },
    30_000,
  );

  it.each(["fillStyleLst", "lnStyleLst", "effectStyleLst", "bgFillStyleLst"])(
    "appends %s while retaining old entries and the selected native index channel",
    async (name) => {
      const { p } = await diagramMatrixDeck(),
        target = createDeck("blank"),
        old = themeForShape(P.getSlideShapes(P.getSlides(p)[0])[0]);
      const targetFrame = P.getSlides(target)[0],
        themeName = P._internalPackageOf(target).parts.find((part) =>
          part.contentType.endsWith(".theme+xml"),
        ).name;
      const before = parseXml(
          decode(P._internalPackageOf(target).getPart(themeName)),
        ).root,
        originals = child(
          child(child(before, "themeElements"), "fmtScheme"),
          name,
        )
          .children.filter((c) => c.kind === "element")
          .map((e) => serializeFragment(e));
      const op = setup(p, target),
        reference =
          name === "lnStyleLst"
            ? "lnRef"
            : name === "effectStyleLst"
              ? "effectRef"
              : "fillRef",
        index = name === "bgFillStyleLst" ? 1002 : 2,
        doc = styleDoc(`<a:${reference} idx="${index}"/>`);
      expect(op.preserve(doc.root)).toBe(true);
      const remapped = value(
        child(child(doc.root, "styleLbl", NS.diagram), "style", NS.diagram)
          .children[0],
        "idx",
      );
      expect(remapped).toBe(name === "bgFillStyleLst" ? "1004" : "4");
      commit(op, p, target);
      const theme = parseXml(
          decode(P._internalPackageOf(target).getPart(themeName)),
        ).root,
        entries = child(
          child(child(theme, "themeElements"), "fmtScheme"),
          name,
        ).children.filter((c) => c.kind === "element");
      expect(entries.slice(0, 3).map((e) => serializeFragment(e))).toEqual(
        originals,
      );
      expect(entries).toHaveLength(4);
      expect(serializeFragment(entries[3])).not.toContain('val="accent2"');
      expect(listEntries(old, name)).toHaveLength(3);
    },
  );

  it("keeps foreign list children opaque without shifting native style indices", async () => {
    const { p } = await diagramMatrixDeck(),
      target = createDeck("blank"),
      targetPart = P._internalPackageOf(target).parts.find((part) =>
        part.contentType.endsWith(".theme+xml"),
      ),
      sourcePart = P._internalPackageOf(p).getPart(
        themeForShape(P.getSlideShapes(P.getSlides(p)[0])[0]).partName,
      );
    for (const part of [targetPart, sourcePart])
      part.data = encode(
        decode(part).replace(
          "<a:lnStyleLst>",
          '<a:lnStyleLst><x:ln xmlns:x="urn:foreign" w="999999"/><a:extLst><a:ext uri="urn:opaque"><a:ln w="888888"/></a:ext></a:extLst>',
        ),
      );
    const imported = P.importSlide(
      target,
      P.getSlides(p)[0],
      P.getSlideLayouts(target)[0],
      { preservePaintFormatting: true },
    );
    expect(svg(target, imported)).toBe(svg(p));
    expect(svg(target, imported)).toContain('stroke-width="9.45"');
    expect(decode(targetPart)).toContain('w="999999"');
    expect(
      decode(readShapeDiagram(P.getSlideShapes(imported)[0]).quickStyle.part),
    ).toContain('lnRef idx="4"');
  });

  it.each(
    [false, true].flatMap((cached) =>
      [" +2 ", "0002", "\n2\t"].map((index) => [cached, index]),
    ),
  )(
    "preserves XML unsigned-integer spelling saved=%s index=%j",
    async (cached, index) => {
      const { p, diagram } = await diagramMatrixDeck({ cached });
      for (const part of [
        diagram.quickStyle.part,
        diagram.drawing?.part,
      ].filter(Boolean))
        part.data = encode(
          decode(part).replaceAll('idx="2"', `idx="${index}"`),
        );
      const expected = svg(p),
        target = createDeck("blank");
      expect(expected).toContain('stroke-width="9.45"');
      const copied = P.importSlide(
        target,
        P.getSlides(p)[0],
        P.getSlideLayouts(target)[0],
        { preservePaintFormatting: true },
      );
      expect(svg(target, copied)).toBe(expected);
      expect(P.validatePresentation(target)).toEqual([]);
    },
  );

  it("deduplicates equivalent entries and image resources across repeated transfers", async () => {
    const { p } = await diagramMatrixDeck({ image: true }),
      target = createDeck("blank");
    for (let i = 0; i < 6; i++)
      P.importSlide(target, P.getSlides(p)[0], P.getSlideLayouts(target)[0], {
        preservePaintFormatting: true,
      });
    const theme = themeForShape(
        P.getSlideShapes(P.getSlides(target).at(-1))[0],
      ),
      pkg = P._internalPackageOf(target);
    for (const name of ["fillStyleLst", "lnStyleLst", "effectStyleLst"])
      expect(listEntries(theme, name)).toHaveLength(4);
    expect(
      pkg
        .getRels(theme.partName)
        .items.filter((r) => r.type === REL_TYPES.image),
    ).toHaveLength(1);
    const ref = child(listEntries(theme, "fillStyleLst")[3], "blip"),
      id = getAttrValue(ref, qname("r", "embed", NS.officeDocRels));
    const rel = pkg.getRels(theme.partName).items.find((r) => r.id === id);
    expect(pkg.getPart(rel.target).data).toEqual(
      P._internalPackageOf(p).getPart("/assets/theme-pixel.png").data,
    );
    expect(P.validatePresentation(target)).toEqual([]);
  });

  it.each([0, 1000, "-1", "bad", 4294967296, 999])(
    "leaves unavailable/sentinel fill index %s intact",
    async (index) => {
      const { p } = await diagramMatrixDeck(),
        target = createDeck("blank"),
        op = setup(p, target),
        doc = styleDoc(`<a:fillRef idx="${index}"/>`),
        before = serializeXml(doc),
        targetBefore = snapshot(target);
      expect(op.preserve(doc.root)).toBe(false);
      commit(op, p, target);
      expect(serializeXml(doc)).toBe(before);
      expect(snapshot(target)).toEqual(targetBefore);
    },
  );

  it("retains opaque wrappers and extensions rather than interpreting lookalike refs", async () => {
    const { p } = await diagramMatrixDeck(),
      target = createDeck("blank"),
      op = setup(p, target),
      doc = styleDoc(
        '<o:wrapper><a:lnRef idx="2"/></o:wrapper><a:extLst><a:ext uri="opaque"><a:lnRef idx="2"/></a:ext></a:extLst>',
      ),
      before = serializeXml(doc);
    expect(op.preserve(doc.root)).toBe(false);
    commit(op, p, target);
    expect(serializeXml(doc)).toBe(before);
  });

  it.each(["default", "text only", "same slide"])(
    "keeps theme adaptation for %s transfer",
    async (mode) => {
      const { p, frame } = await diagramMatrixDeck(),
        target = createDeck("blank"),
        copied =
          mode === "same slide"
            ? P.copyShape(P.getSlides(p)[0], frame, {
                preservePaintFormatting: true,
              })
            : P.getSlideShapes(
                P.importSlide(
                  target,
                  P.getSlides(p)[0],
                  P.getSlideLayouts(target)[0],
                  mode === "text only" ? { preserveTextFormatting: true } : {},
                ),
              )[0];
      expect(decode(readShapeDiagram(copied).quickStyle.part)).toContain(
        'lnRef idx="2"',
      );
      expect(setup(p, target, false)).toBeNull();
    },
  );

  it("rejects missing theme dependencies before graph or theme mutation", async () => {
    const { p, theme } = await diagramMatrixDeck({ image: true }),
      target = createDeck("blank"),
      pkg = P._internalPackageOf(p);
    pkg.removePart("/assets/theme-pixel.png");
    const before = snapshot(target),
      op = setup(p, target),
      doc = styleDoc('<a:fillRef idx="2"/>');
    expect(() => op.preserve(doc.root)).toThrow(
      "missing diagram theme dependency",
    );
    expect(snapshot(target)).toEqual(before);
  });

  it("retains palette placeholder transforms and freezes independent source effect colors", async () => {
    const { p } = await diagramMatrixDeck(),
      target = createDeck("blank"),
      op = setup(p, target),
      doc = styleDoc(refs());
    op.preserve(doc.root);
    commit(op, p, target);
    const theme = themeForShape(
      P.getSlideShapes(
        P.importSlide(target, P.getSlides(p)[0], P.getSlideLayouts(target)[0], {
          preservePaintFormatting: true,
        }),
      )[0],
    );
    const fill = serializeFragment(listEntries(theme, "fillStyleLst")[3]),
      effect = serializeFragment(listEntries(theme, "effectStyleLst")[3]);
    expect(fill).toContain('<a:schemeClr val="phClr"><a:tint val="23000"/>');
    expect(fill).toContain('<a:srgbClr val="23895A"><a:alpha val="63000"/>');
    expect(effect).toContain('<a:srgbClr val="D26428"><a:alpha val="32000"/>');
  });
  it("keeps existing destination diagrams and their valid references unchanged", async () => {
    const { p } = await diagramMatrixDeck(),
      target = createDeck("blank"),
      old = P.importSlide(
        target,
        P.getSlides(p)[0],
        P.getSlideLayouts(target)[0],
      ),
      before = svg(target, old);
    P.importSlide(target, P.getSlides(p)[0], P.getSlideLayouts(target)[0], {
      preservePaintFormatting: true,
    });
    expect(svg(target, old)).toBe(before);
    expect(
      decode(readShapeDiagram(P.getSlideShapes(old)[0]).quickStyle.part),
    ).toContain('lnRef idx="2"');
  });

  it("uses the source owning matrix on same-package copies across multiple masters", async () => {
    const { p, frame, theme } = await diagramMatrixDeck(),
      sourceTheme = theme.data.slice(),
      blank = createDeck("blank"),
      layout = importSlideTemplates(p, [P.getSlides(blank)[0]])[0],
      target = P.addSlide(p, { layout });
    P.copyShape(target, frame, {
      preservePaintFormatting: true,
      preserveTextFormatting: true,
    });
    const diagramMarkup = (slide) =>
      parseXml(svg(p, slide))
        .root.children.filter(
          (c) => c.kind === "element" && value(c, "data-pptx-diagram") !== null,
        )
        .map(serializeFragment)
        .join("");
    expect(diagramMarkup(target)).toContain("semantic-layout");
    expect(diagramMarkup(target)).toBe(diagramMarkup(P.getSlides(p)[0]));
    expect(P._internalPackageOf(p).getPart(theme.partName).data).toEqual(
      sourceTheme,
    );
    const reopened = await P.loadPresentation(await P.savePresentation(p));
    expect(svg(reopened, P.getSlides(reopened).at(-1))).toBe(svg(p, target));
  });

  it("preserves background-fill references through native-layout export and return", async () => {
    const { p } = await diagramMatrixDeck({ fill: 1002 }),
      target = createDeck("blank"),
      expected = svg(p),
      slide = P.importSlide(
        target,
        P.getSlides(p)[0],
        P.getSlideLayouts(target)[0],
        { preservePaintFormatting: true, preserveTextFormatting: true },
      );
    expect(svg(target, slide)).toBe(expected);
    expect(
      decode(readShapeDiagram(P.getSlideShapes(slide)[0]).quickStyle.part),
    ).toContain('fillRef idx="1004"');
    const reopened = await P.loadPresentation(await P.savePresentation(target)),
      back = P.importSlide(
        p,
        P.getSlides(reopened).at(-1),
        P.getSlideLayout(P.getSlides(p)[0]),
        { preservePaintFormatting: true, preserveTextFormatting: true },
      );
    expect(svg(p, back)).toBe(expected);
  });

  it("does not allocate a relationship ID already referenced by opaque destination XML", async () => {
    const { p } = await diagramMatrixDeck({ image: true }),
      target = createDeck("blank"),
      pkg = P._internalPackageOf(target),
      part = pkg.parts.find((p) => p.contentType.endsWith(".theme+xml")),
      doc = parseXml(decode(part));
    doc.root.children.push(
      parseXml(
        '<o:extension xmlns:o="urn:opaque" xmlns:r="' +
          NS.officeDocRels +
          '" r:embed="rId1"/>',
      ).root,
    );
    part.data = encode(serializeXml(doc));
    const op = setup(p, target),
      source = styleDoc('<a:fillRef idx="2"/>');
    op.preserve(source.root);
    commit(op, p, target);
    expect(pkg.getRels(part.name).items[0].id).not.toBe("rId1");
    expect(decode(part)).toContain('r:embed="rId1"');
  });

  it.each(["4", " +4 "])(
    "rejects an append that would change existing dangling diagram reference %s",
    async (index) => {
      const { p } = await diagramMatrixDeck(),
        target = createDeck("blank"),
        slide = P.importSlide(
          target,
          P.getSlides(p)[0],
          P.getSlideLayouts(target)[0],
        ),
        quick = readShapeDiagram(P.getSlideShapes(slide)[0]).quickStyle.part;
      quick.data = encode(
        decode(quick).replaceAll('lnRef idx="2"', `lnRef idx="${index}"`),
      );
      const before = snapshot(target),
        op = setup(p, target),
        doc = styleDoc('<a:lnRef idx="2"/>');
      expect(() => op.preserve(doc.root)).toThrow(
        "existing dangling reference",
      );
      expect(snapshot(target)).toEqual(before);
    },
  );

  it("diagnoses the ordinary-fill index boundary without producing a background reference", async () => {
    const { p } = await diagramMatrixDeck(),
      target = createDeck("blank"),
      pkg = P._internalPackageOf(target),
      part = pkg.parts.find((p) => p.contentType.endsWith(".theme+xml")),
      doc = parseXml(decode(part)),
      list = child(
        child(child(doc.root, "themeElements"), "fmtScheme"),
        "fillStyleLst",
      );
    while (list.children.filter((c) => c.kind === "element").length < 999)
      list.children.push(xml("<a:noFill/>")[0]);
    part.data = encode(serializeXml(doc));
    const before = snapshot(target),
      op = setup(p, target),
      source = styleDoc('<a:fillRef idx="2"/>');
    expect(() => op.preserve(source.root)).toThrow(
      "no representable free index",
    );
    expect(snapshot(target)).toEqual(before);
  });
  it.each(["bindings", "whitespace"])(
    "keeps distinct opaque %s when deduplicating styles",
    async (mode) => {
      const { p } = await diagramMatrixDeck(),
        target = createDeck("blank");
      const put = (deck, source) => {
        const pkg = P._internalPackageOf(deck),
          part = pkg.parts.find((p) => p.contentType.endsWith(".theme+xml")),
          doc = parseXml(decode(part)),
          list = child(
            child(child(doc.root, "themeElements"), "fmtScheme"),
            "lnStyleLst",
          ),
          entries = list.children.filter((c) => c.kind === "element"),
          binding =
            mode === "bindings"
              ? source
                ? "urn:source-binding"
                : "urn:target-binding"
              : "urn:same-binding",
          spaces = mode === "whitespace" && source ? "  " : " ";
        list.children[list.children.indexOf(entries[1])] = parseXml(
          `<a:ln xmlns:a="${NS.dml}" xmlns:o="urn:opaque" xmlns:q="${binding}" w="7777"><a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill><a:extLst><a:ext uri="owned"><o:metadata select="q:Widget"><a:t>${spaces}</a:t></o:metadata></a:ext></a:extLst></a:ln>`,
        ).root;
        part.data = encode(serializeXml(doc));
        return part;
      };
      put(p, true);
      const part = put(target, false),
        op = setup(p, target),
        doc = styleDoc('<a:lnRef idx="2"/>');
      expect(op.preserve(doc.root)).toBe(true);
      commit(op, p, target);
      const entries = child(
        child(child(parseXml(decode(part)).root, "themeElements"), "fmtScheme"),
        "lnStyleLst",
      ).children.filter((c) => c.kind === "element");
      expect(entries).toHaveLength(4);
      expect(serializeFragment(entries[3])).toContain(
        mode === "bindings" ? 'xmlns:q="urn:source-binding"' : "<a:t>  </a:t>",
      );
    },
  );

  it("copies deeply nested opaque style metadata without recursive escaping or flattening", async () => {
    const { p, theme } = await diagramMatrixDeck(),
      target = createDeck("blank"),
      pkg = P._internalPackageOf(p),
      part = pkg.getPart(theme.partName),
      doc = parseXml(decode(part)),
      list = child(
        child(child(doc.root, "themeElements"), "fmtScheme"),
        "lnStyleLst",
      ),
      line = list.children.filter((c) => c.kind === "element")[1],
      depth = 2048;
    line.children.push(
      parseXml(
        `<a:extLst xmlns:a="${NS.dml}" xmlns:o="urn:opaque"><a:ext uri="deep">${"<o:node>".repeat(depth)}retained${"</o:node>".repeat(depth)}</a:ext></a:extLst>`,
      ).root,
    );
    part.data = encode(serializeXml(doc));
    const op = setup(p, target),
      copied = styleDoc('<a:lnRef idx="2"/>');
    expect(op.preserve(copied.root)).toBe(true);
    commit(op, p, target);
    const targetPart = P._internalPackageOf(target).parts.find((p) =>
        p.contentType.endsWith(".theme+xml"),
      ),
      text = decode(targetPart);
    expect(text.match(/<o:node>/g)).toHaveLength(depth);
    expect(text).toContain("retained");
  });

  it("keeps external image relationships external without fetching or creating image parts", async () => {
    const { p, theme } = await diagramMatrixDeck({ image: true }),
      pkg = P._internalPackageOf(p),
      part = pkg.getPart(theme.partName),
      rels = pkg.getRels(theme.partName),
      rel = rels.items.find((r) => r.id === "source-pixel");
    rel.targetMode = "External";
    rel.target = "https://example.org/diagram-background.png";
    pkg.setRels(theme.partName, rels);
    part.data = encode(decode(part).replaceAll("r:embed=", "r:link="));
    const target = createDeck("blank"),
      op = setup(p, target),
      doc = styleDoc('<a:fillRef idx="2"/>');
    expect(op.preserve(doc.root)).toBe(true);
    expect(op.roots.size).toBe(0);
    commit(op, p, target);
    const targetPkg = P._internalPackageOf(target),
      targetPart = targetPkg.parts.find((p) =>
        p.contentType.endsWith(".theme+xml"),
      );
    expect(targetPkg.getRels(targetPart.name).items).toEqual([
      { ...rel, id: "rId1" },
    ]);
    expect(
      targetPkg.parts.filter((p) => p.contentType.startsWith("image/")),
    ).toHaveLength(0);
  });
});
