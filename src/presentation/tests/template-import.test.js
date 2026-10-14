import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { P, createDeck, parseDeck, preview } from "../src/model.js";
import {
  importSlideTemplate,
  importSlideTemplates,
} from "../lib/pptx/src/api/fn/template-import.ts";
import { INTERNAL_PACKAGE } from "../lib/pptx/src/api/_internal-symbols.ts";
import {
  resolveTarget,
  relsPartNameFor,
} from "../lib/pptx/src/internal/opc/index.ts";
import { REL_TYPES } from "../lib/pptx/src/internal/presentationml/index.ts";
import {
  NS,
  parseXml,
  walkElements,
  getAttrValue,
  qname,
} from "../lib/pptx/src/internal/xml/index.ts";
import { lineFormattingFixture } from "./line-formatting-fixture.js";
import { templateFixture as fixture } from "./template-import-fixture.js";
import { createSharedFontDeck } from "./fixtures.js";
import { BUILTIN_LAYOUTS } from "../lib/pptx/src/internal/parts/builtin-layouts.ts";

// A new deck's master carries every built-in layout.
const BUILTIN = BUILTIN_LAYOUTS.length;
import {
  createGeometryDeck,
  presetGeometry,
  triangleGeometry,
} from "./geometry-fixture.js";

const enc = new TextEncoder(),
  dec = new TextDecoder();
const xml = (part) => dec.decode(part.data);
const replace = (part, from, to) => {
  part.data = enc.encode(xml(part).replace(from, to));
};
const pkg = (pres) => pres[INTERNAL_PACKAGE];
const masters = (pres) =>
  pkg(pres).parts.filter((p) => p.contentType.endsWith(".slideMaster+xml"));
const masterOfLayout = (pres, layout) => {
  const name = P.getSlideLayoutPartName(layout);
  const r = pkg(pres)
    .getRels(name)
    .items.find((r) => r.type === REL_TYPES.slideMaster);
  return pkg(pres).getPart(resolveTarget(name, r.target));
};
const nativeCopy = (target, source) =>
  P.importSlide(target, source, importSlideTemplate(target, source), {
    preserveTextFormatting: true,
    preservePaintFormatting: true,
  });
const snapshot = (pres) => unzipSync(pkg(pres).save());
const templateIds = (parts) =>
  parts.flatMap((part) => {
    const ids = [];
    walkElements(parseXml(xml(part)).root, (e) => {
      if (
        e.name.namespaceURI === NS.pml &&
        ["sldMasterId", "sldLayoutId"].includes(e.name.localName)
      )
        ids.push(Number(getAttrValue(e, qname("", "id", ""))));
    });
    return ids;
  });
function movePart(pres, oldName, newName) {
  const p = pkg(pres),
    original = p.getPart(oldName),
    ownRels = p.getRels(oldName);
  p.addPart(newName, original.contentType, original.data);
  if (ownRels)
    p.setRels(newName, {
      items: ownRels.items.map((r) => ({
        ...r,
        target:
          r.targetMode === "Internal"
            ? resolveTarget(oldName, r.target)
            : r.target,
      })),
    });
  p.removePart(oldName);
  p.removePart(relsPartNameFor(oldName));
  const redirect = (name, rels) => ({
    items: rels.items.map((r) =>
      r.targetMode === "Internal" &&
      resolveTarget(name, r.target).toLowerCase() === oldName.toLowerCase()
        ? { ...r, target: newName }
        : r,
    ),
  });
  for (const part of [...p.parts]) {
    if (part.contentType.endsWith("relationships+xml")) continue;
    const rels = p.getRels(part.name);
    if (rels) p.setRels(part.name, redirect(part.name, rels));
  }
  p.setRootRels(redirect("/", p.rootRels()));
}

describe("native source template imports", () => {
  it.each(
    ["picture", "shape"].flatMap((shapeKind) =>
      ["layout", "master"].flatMap((level) =>
        [false, true].map((inheritedBounds) => ({
          shapeKind,
          level,
          inheritedBounds,
        })),
      ),
    ),
  )(
    "retains $shapeKind geometry from $level with inherited bounds=$inheritedBounds through template edits and return transfer",
    async ({ shapeKind, level, inheritedBounds }) => {
      const source = await parseDeck(
          await createGeometryDeck({ shapeKind, level, inheritedBounds }),
        ),
        slide = P.getSlides(source)[0],
        target = createDeck("blank"),
        layout = importSlideTemplate(target, slide),
        copied = P.importSlide(target, slide, layout, {
          preserveGeometry: false,
        });
      const originalBody = pkg(source).getPart(P.getSlidePartName(slide)).data;
      expect(pkg(target).getPart(P.getSlidePartName(copied)).data).toEqual(
        originalBody,
      );
      expect(preview(target, copied)).toBe(preview(source, slide));
      const originalGeometry = P.getShapeGeometryEffective(
        target,
        P.getSlideShapes(copied)[0],
      );
      // Edit the native parent, not a materialized property on the slide.
      for (const [pres, template] of [
        [source, P.getSlideLayout(slide)],
        [target, layout],
      ]) {
        const layoutPart = pkg(pres).getPart(
          P.getSlideLayoutPartName(template),
        );
        const geometryPart =
          level === "layout" ? layoutPart : masterOfLayout(pres, template);
        replace(geometryPart, triangleGeometry, presetGeometry("ellipse"));
        replace(layoutPart, `cx="${P.inches(4)}"`, `cx="${P.inches(5)}"`);
      }
      const editedGeometry = P.getShapeGeometryEffective(
        target,
        P.getSlideShapes(copied)[0],
      );
      expect(editedGeometry).not.toEqual(originalGeometry);
      expect(editedGeometry).toMatchObject({
        kind: "preset",
        preset: "ellipse",
      });
      expect(preview(target, copied)).toBe(preview(source, slide));
      expect(
        P.getShapeBoundsResolved(target, P.getSlideShapes(copied)[0]).w,
      ).toBe(inheritedBounds ? P.inches(5) : P.inches(4));
      const restored = await parseDeck(await P.savePresentation(target)),
        saved = P.getSlides(restored).at(-1),
        returned = P.importSlide(
          source,
          saved,
          importSlideTemplate(source, saved),
          { preserveGeometry: false },
        );
      expect(pkg(source).getPart(P.getSlidePartName(returned)).data).toEqual(
        originalBody,
      );
      expect(preview(source, returned)).toBe(preview(restored, saved));
      expect(
        P.validatePresentation(restored).filter((i) => i.severity === "error"),
      ).toEqual([]);
    },
  );
  it("keeps local geometry and partially authored bounds while adopting another template", async () => {
    const source = await parseDeck(
        await createGeometryDeck({ directGeometry: presetGeometry("hexagon") }),
      ),
      slide = P.getSlides(source)[0],
      part = pkg(source).getPart(P.getSlidePartName(slide));
    replace(part, `<a:ext cx="${P.inches(4)}" cy="${P.inches(2)}"/>`, "");
    const refreshed = await parseDeck(await P.savePresentation(source)),
      original = P.getSlides(refreshed)[0],
      target = await parseDeck(
        await createGeometryDeck({
          geometry: presetGeometry("ellipse"),
          bounds: {
            x: P.inches(2),
            y: P.inches(3),
            w: P.inches(5),
            h: P.inches(1),
          },
        }),
      ),
      layout = P.getSlideLayout(P.getSlides(target)[0]),
      copied = P.importSlide(target, original, layout, {
        preserveGeometry: false,
      }),
      shape = P.getSlideShapes(copied)[0];
    expect(P.getShapeGeometryEffective(target, shape)).toMatchObject({
      preset: "hexagon",
    });
    expect(P.getShapePosition(shape)).toEqual({
      x: P.inches(1),
      y: P.inches(1),
    });
    expect(P.getShapeSize(shape)).toBeNull();
    expect(pkg(target).getPart(P.getSlidePartName(copied)).data).toEqual(
      pkg(refreshed).getPart(P.getSlidePartName(original)).data,
    );
  });
  it("does not borrow font descriptors from similarly named foreign extension elements", async () => {
    const source = await parseDeck(await createSharedFontDeck()),
      slide = P.getSlides(source)[0],
      part = pkg(source).getPart(P.getSlidePartName(slide));
    replace(
      part,
      "</a:rPr>",
      '<a:extLst><a:ext uri="urn:font-hints"><foreign:latin xmlns:foreign="urn:foreign-font" typeface="Unavailable Shared Serif" pitchFamily="34"/></a:ext></a:extLst></a:rPr>',
    );
    const restored = await parseDeck(await P.savePresentation(source)),
      original = P.getSlides(restored)[0],
      target = createDeck("blank");
    const copied = nativeCopy(target, original);
    expect(preview(target, copied)).toBe(preview(restored, original));
    expect(
      dec.decode(pkg(target).getPart(P.getSlidePartName(copied)).data),
    ).toContain('xmlns:foreign="urn:foreign-font"');
  });
  it.each(["layout", "slide"])(
    "preserves font descriptors declared only in another %s through transfer and return",
    async (location) => {
      const source = await parseDeck(
          await createSharedFontDeck({ location, encoded: true }),
        ),
        slide = P.getSlides(source)[0];
      const target = createDeck("blank"),
        before = snapshot(source),
        copied = nativeCopy(target, slide);
      expect(preview(target, copied)).toBe(preview(source, slide));
      expect(snapshot(source)).toEqual(before);
      const restored = await parseDeck(await P.savePresentation(target));
      const returned = nativeCopy(source, P.getSlides(restored).at(-1));
      expect(preview(source, returned)).toBe(preview(target, copied));
    },
  );
  it.each([0, 34])(
    "retains font matching with local pitchFamily=%s",
    async (pitch) => {
      const source = await parseDeck(await createSharedFontDeck()),
        slide = P.getSlides(source)[0];
      const part = pkg(source).getPart(P.getSlidePartName(slide));
      replace(
        part,
        'typeface="Unavailable Shared Serif"',
        `typeface="Unavailable Shared Serif" pitchFamily="${pitch}"`,
      );
      const restored = await parseDeck(await P.savePresentation(source)),
        original = P.getSlides(restored)[0],
        target = createDeck("blank");
      const copied = nativeCopy(target, original);
      expect(preview(target, copied)).toBe(preview(restored, original));
    },
  );
  it("copies only the selected layout and its master without flattening artwork", async () => {
    const f = fixture(),
      target = createDeck("blank"),
      before = snapshot(f.pres);
    const targetTheme = pkg(target)
      .getPart("/ppt/theme/theme1.xml")
      .data.slice();
    const copiedLayout = importSlideTemplate(target, f.slide);
    expect(P.getSlideLayouts(target)).toHaveLength(BUILTIN + 1);
    expect(masters(target)).toHaveLength(2);
    const copiedMaster = masterOfLayout(target, copiedLayout);
    expect(xml(copiedMaster)).toContain('name="Master decoration"');
    expect(xml(copiedMaster).match(/<p:sldLayoutId /g)).toHaveLength(1);
    expect(
      pkg(target).getPart(P.getSlideLayoutPartName(copiedLayout)).data,
    ).toEqual(f.layoutPart.data);
    expect(pkg(target).getPart("/ppt/theme/theme1.xml").data).toEqual(
      targetTheme,
    );
    const copied = P.importSlide(target, f.slide, copiedLayout);
    expect(P.getSlideShapes(copied)).toHaveLength(
      P.getSlideShapes(f.slide).length,
    );
    expect(preview(target, copied)).toBe(preview(f.pres, f.slide));
    expect(P.getSlideTransition(copied)).toEqual(P.getSlideTransition(f.slide));
    expect(snapshot(f.pres)).toEqual(before);
    const restored = await parseDeck(await P.savePresentation(target));
    expect(preview(restored, P.getSlides(restored).at(-1))).toBe(
      preview(f.pres, f.slide),
    );
    expect(
      P.validatePresentation(restored).filter((i) => i.severity === "error"),
    ).toEqual([]);
  });
  it("retains inherited text, paint, geometry and master artwork through edit and copies both ways", async () => {
    const f = await lineFormattingFixture({ local: "", shapeKind: "shape" });
    const target = createDeck("blank"),
      copied = nativeCopy(target, f.slide);
    expect(preview(target, copied)).toBe(preview(f.pres, f.slide));
    const shape = P.getSlideShapes(copied)[0];
    P.setShapeRotation(shape, 23);
    const restored = await parseDeck(await P.savePresentation(target));
    const returned = nativeCopy(f.pres, P.getSlides(restored).at(-1));
    expect(P.getShapeRotation(P.getSlideShapes(returned)[0])).toBe(23);
    expect(
      P.getShapeStrokeFormattingEffective(P.getSlideShapes(returned)[0]),
    ).toEqual(P.getShapeStrokeFormattingEffective(shape));
    expect(preview(f.pres, returned)).toBe(
      preview(restored, P.getSlides(restored).at(-1)),
    );
  });
  it("shares repeated layouts, multiple selected sibling layouts and their theme in one batch", () => {
    const f = fixture(),
      target = createDeck("blank");
    const sibling = P.addSlide(f.pres, {
      layout: P.getSlideLayouts(f.pres)[1],
    });
    const copied = importSlideTemplates(target, [f.slide, sibling, f.slide]);
    expect(P.getSlideLayoutPartName(copied[0])).toBe(
      P.getSlideLayoutPartName(copied[2]),
    );
    expect(P.getSlideLayoutPartName(copied[0])).not.toBe(
      P.getSlideLayoutPartName(copied[1]),
    );
    expect(masters(target)).toHaveLength(2);
    expect(P.getSlideLayouts(target)).toHaveLength(BUILTIN + 2);
    expect(
      pkg(target).parts.filter((p) => p.contentType.endsWith(".theme+xml")),
    ).toHaveLength(2);
  });
  it("retains layouts referenced by unknown master extensions without editing foreign schema slots", () => {
    const f = fixture(),
      target = createDeck("blank");
    const sibling = pkg(f.pres)
      .getRels(f.master.name)
      .items.find(
        (r) =>
          r.type === REL_TYPES.slideLayout &&
          resolveTarget(f.master.name, r.target) !== f.layoutPart.name,
      );
    const extension = `<p:extLst><p:ext uri="urn:retained"><foreign:feature xmlns:foreign="urn:foreign" r:id="${sibling.id}"><p:sldLayoutId id="7" r:id="${sibling.id}"/></foreign:feature></p:ext></p:extLst>`;
    replace(f.master, "</p:sldMaster>", extension + "</p:sldMaster>");
    const copied = importSlideTemplate(target, f.slide),
      master = masterOfLayout(target, copied);
    expect(P.getSlideLayouts(target)).toHaveLength(BUILTIN + 2);
    expect(xml(master)).toContain(extension);
    const rel = pkg(target)
      .getRels(master.name)
      .items.find((r) => r.id === sibling.id);
    expect(
      pkg(target).getPart(resolveTarget(master.name, rel.target)),
    ).not.toBeNull();
  });
  it("copies inherited sound, unknown dependencies, shared assets and cycles with local relationship IDs", () => {
    const f = fixture(),
      target = createDeck("blank"),
      rels = pkg(f.pres).getRels(f.master.name);
    pkg(f.pres).addPart(
      "/assets/sound.wav",
      "audio/wav",
      new Uint8Array([1, 2, 3, 4]),
    );
    pkg(f.pres).addPart(
      "/assets/custom.xml",
      "application/xml",
      enc.encode('<feature xmlns="urn:custom"/>'),
    );
    rels.items.push(
      {
        id: "sound",
        type: REL_TYPES.audio,
        target: "/assets/sound.wav",
        targetMode: "Internal",
      },
      {
        id: "custom",
        type: "urn:dependency",
        target: "/assets/custom.xml",
        targetMode: "Internal",
      },
    );
    pkg(f.pres).setRels(f.master.name, rels);
    const sibling = rels.items.find(
      (r) =>
        r.type === REL_TYPES.slideLayout &&
        resolveTarget(f.master.name, r.target) !== f.layoutPart.name,
    );
    pkg(f.pres).setRels("/assets/custom.xml", {
      items: [
        {
          id: "cycle",
          type: "urn:dependency",
          target: f.master.name,
          targetMode: "Internal",
        },
        {
          id: "sameSound",
          type: REL_TYPES.audio,
          target: "/assets/sound.wav",
          targetMode: "Internal",
        },
        {
          id: "reachableLayout",
          type: "urn:unknown-layout-reference",
          target: resolveTarget(f.master.name, sibling.target),
          targetMode: "Internal",
        },
        {
          id: "url",
          type: REL_TYPES.hyperlink,
          target: "https://example.com/template",
          targetMode: "External",
        },
      ],
    });
    replace(
      f.master,
      "</p:sldMaster>",
      '<p:transition><p:fade/><p:sndAc><p:stSnd><p:snd r:embed="sound" name="Sound"/></p:stSnd></p:sndAc></p:transition></p:sldMaster>',
    );
    const master = masterOfLayout(target, importSlideTemplate(target, f.slide));
    const copiedRels = pkg(target).getRels(master.name).items;
    const custom = copiedRels.find((r) => r.id === "custom").target;
    const customRels = pkg(target).getRels(custom).items;
    expect(customRels.find((r) => r.id === "cycle").target).toBe(master.name);
    expect(customRels.find((r) => r.id === "sameSound").target).toBe(
      copiedRels.find((r) => r.id === "sound").target,
    );
    expect(customRels.find((r) => r.id === "url").target).toBe(
      "https://example.com/template",
    );
    expect(xml(master)).toContain('r:embed="sound"');
    expect(P.getSlideLayouts(target)).toHaveLength(BUILTIN + 2);
    expect(xml(master).match(/<p:sldLayoutId /g)).toHaveLength(2);
  });
  it("allocates unique master/layout IDs and names on repeated and same-package imports", () => {
    const f = fixture();
    importSlideTemplate(f.pres, f.slide);
    importSlideTemplate(f.pres, f.slide);
    expect(masters(f.pres)).toHaveLength(3);
    const ids = templateIds([
      ...masters(f.pres),
      pkg(f.pres).getPart("/ppt/presentation.xml"),
    ]);
    expect(ids).toHaveLength(BUILTIN + 5);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      ids.every((id) => Number(id) >= 2 ** 31 && Number(id) < 2 ** 32),
    ).toBe(true);
  });
  it.each([4294967295, 4294967294])(
    "reuses free IDs at unsigned range boundary %s",
    (largest) => {
      const f = fixture(),
        target = createDeck("blank"),
        main = pkg(target).getPart("/ppt/presentation.xml");
      replace(main, 'id="2147483648"', `id="${largest}"`);
      const master = masterOfLayout(
        target,
        importSlideTemplate(target, f.slide),
      );
      expect(xml(master)).not.toContain('id="4294967296"');
      const ids = templateIds([...masters(target), main]);
      expect(ids).toHaveLength(BUILTIN + 3);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => id >= 2 ** 31 && id <= 4294967295)).toBe(true);
    },
  );
  it("handles namespace aliases, optional source IDs and compatibility branches", () => {
    const f = fixture(),
      target = createDeck("blank");
    replace(
      f.master,
      /<p:sldLayoutIdLst>([\s\S]*?)<\/p:sldLayoutIdLst>/,
      '<mc:AlternateContent xmlns:mc="' +
        NS.mc +
        '" xmlns:new="urn:new"><mc:Choice Requires="new"><p:sldLayoutIdLst>$1</p:sldLayoutIdLst></mc:Choice><mc:Fallback><p:sldLayoutIdLst>$1</p:sldLayoutIdLst></mc:Fallback></mc:AlternateContent>',
    );
    f.master.data = enc.encode(
      xml(f.master)
        .replace(/(<\/?)(p:)/g, "$1alias:")
        .replaceAll("xmlns:p=", "xmlns:alias=")
        .replace(/(<alias:sldLayoutId) id="\d+"/g, "$1"),
    );
    const copied = masterOfLayout(target, importSlideTemplate(target, f.slide));
    const ids = templateIds([copied]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(xml(copied)).toContain("mc:Choice");
    expect(xml(copied)).toContain("mc:Fallback");
  });
  it.each([
    "missing dependency",
    "missing layout",
    "missing master",
    "unregistered layout",
    "wrong root",
  ])("rejects %s without changing either package", (reason) => {
    const f = fixture(),
      target = createDeck("blank");
    if (reason === "missing dependency") {
      const rels = pkg(f.pres).getRels(f.master.name);
      rels.items.push({
        id: "missing",
        type: "urn:unknown",
        target: "/absent.bin",
        targetMode: "Internal",
      });
      pkg(f.pres).setRels(f.master.name, rels);
    }
    if (reason === "missing layout") pkg(f.pres).removePart(f.layoutPart.name);
    if (reason === "missing master") pkg(f.pres).removePart(f.master.name);
    if (reason === "unregistered layout")
      replace(
        f.master,
        /<p:sldLayoutIdLst>[\s\S]*?<\/p:sldLayoutIdLst>/,
        "<p:sldLayoutIdLst/>",
      );
    if (reason === "wrong root")
      replace(f.layoutPart, /p:sldLayout/g, "p:foreign");
    const sourceBefore = snapshot(f.pres),
      targetBefore = snapshot(target);
    expect(() => importSlideTemplate(target, f.slide)).toThrow();
    expect(snapshot(f.pres)).toEqual(sourceBefore);
    expect(snapshot(target)).toEqual(targetBefore);
  });
  it("accepts an empty batch and rejects mixed sources before mutation", () => {
    const target = createDeck("blank"),
      f = fixture(),
      other = fixture();
    const before = snapshot(target);
    expect(importSlideTemplates(target, [])).toEqual([]);
    expect(() => importSlideTemplates(target, [f.slide, other.slide])).toThrow(
      "different packages",
    );
    expect(snapshot(target)).toEqual(before);
  });
  it("resolves arbitrary template and main-presentation paths without filename assumptions", () => {
    const f = fixture(),
      target = createDeck("blank");
    movePart(f.pres, f.layoutPart.name, "/templates/layout/custom.xml");
    movePart(f.pres, f.master.name, "/templates/master/custom.xml");
    movePart(target, "/ppt/presentation.xml", "/destination/deck.xml");
    const before = snapshot(f.pres);
    const copied = importSlideTemplate(target, f.slide);
    expect(P.getSlideLayoutPartName(copied)).toBe(
      "/templates/layout/custom.xml",
    );
    const master = masterOfLayout(target, copied);
    expect(master.name).toBe("/templates/master/custom.xml");
    expect(xml(pkg(target).getPart("/destination/deck.xml"))).toContain(
      "sldMasterId",
    );
    expect(
      pkg(target)
        .getRels("/destination/deck.xml")
        .items.some(
          (r) => r.type === REL_TYPES.slideMaster && r.target === master.name,
        ),
    ).toBe(true);
    expect(snapshot(f.pres)).toEqual(before);
  });
  it("binds imported and newly authored slides to layouts outside the conventional folder", async () => {
    const f = fixture(),
      target = createDeck("blank");
    movePart(f.pres, f.layoutPart.name, "/design/layouts/cover.xml");
    movePart(f.pres, f.master.name, "/design/masters/base.xml");
    const sourceUri = preview(f.pres, f.slide),
      layout = importSlideTemplate(target, f.slide);
    const imported = P.importSlide(target, f.slide, layout),
      authored = P.addSlide(target, { layout });
    for (const slide of [imported, authored]) {
      expect(P.getSlideLayoutPartName(P.getSlideLayout(slide))).toBe(
        P.getSlideLayoutPartName(layout),
      );
      expect(decodeURIComponent(preview(target, slide))).toContain(
        'fill="#2C8A73"',
      );
    }
    expect(preview(target, imported)).toBe(sourceUri);
    const restored = await parseDeck(await P.savePresentation(target));
    expect(
      P.validatePresentation(restored).filter((i) => i.severity === "error"),
    ).toEqual([]);
  });
  it("rejects a missing destination layout before adding a slide", () => {
    const f = fixture(),
      target = createDeck("blank");
    movePart(f.pres, f.layoutPart.name, "/source/layout.xml");
    const layout = P.getSlideLayout(f.slide),
      before = snapshot(target);
    expect(() => P.importSlide(target, f.slide, layout)).toThrow(
      "not in target",
    );
    expect(snapshot(target)).toEqual(before);
  });
  it("adds a master list in schema order when the destination has none", () => {
    const f = fixture(),
      target = createDeck("blank"),
      main = pkg(target).getPart("/ppt/presentation.xml");
    replace(main, /<p:sldMasterIdLst>[\s\S]*?<\/p:sldMasterIdLst>/, "");
    importSlideTemplate(target, f.slide);
    expect(xml(main).indexOf("<p:sldMasterIdLst>")).toBeLessThan(
      xml(main).indexOf("<p:sldIdLst>"),
    );
  });
});
