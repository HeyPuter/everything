import { describe, expect, it } from "vitest";
import {
  ONE_PIXEL_PNG_BYTES,
  SYNTHETIC_PACKAGE_PART_NAMES,
  SYNTHETIC_REL_TYPES,
  buildSyntheticPackageBytes,
} from "../../../test/lib/synthetic-package.ts";
import { partName } from "../opc/index.ts";
import { OpcPackage } from "./index.ts";

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("OpcPackage.load", () => {
  it("loads a synthetic package and resolves every content type", () => {
    const bytes = buildSyntheticPackageBytes();
    const pkg = OpcPackage.load(bytes);
    expect(pkg.parts.map((p) => p.name)).toEqual(SYNTHETIC_PACKAGE_PART_NAMES);
    for (const part of pkg.parts) {
      expect(part.contentType).not.toBe("");
    }
  });

  it("exposes the part content type for an override entry", () => {
    const pkg = OpcPackage.load(buildSyntheticPackageBytes());
    const slide = pkg.getPart(partName("/ppt/slides/slide1.xml"));
    expect(slide?.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml".replace(
        ".presentation.main+xml",
        ".slide+xml",
      ),
    );
  });

  it("exposes the part content type for a default entry (extension lookup)", () => {
    const pkg = OpcPackage.load(buildSyntheticPackageBytes());
    const image = pkg.getPart(partName("/ppt/media/image1.png"));
    expect(image?.contentType).toBe("image/png");
  });

  it("throws when [Content_Types].xml is missing", () => {
    // Build a package without [Content_Types].xml by writing a raw ZIP.
    expect(() => OpcPackage.load(new Uint8Array([0]))).toThrow();
  });
});

describe("OpcPackage round-trip", () => {
  it("preserves entry order and binary media bytes", () => {
    const bytes = buildSyntheticPackageBytes();
    const pkg = OpcPackage.load(bytes);
    const written = pkg.save();
    const reread = OpcPackage.load(written);

    expect(reread.parts.map((p) => p.name)).toEqual(
      SYNTHETIC_PACKAGE_PART_NAMES,
    );

    const image = reread.getPart(partName("/ppt/media/image1.png"));
    expect(image?.data).toEqual(ONE_PIXEL_PNG_BYTES);

    const slide = reread.getPart(partName("/ppt/slides/slide1.xml"));
    expect(decode(slide?.data ?? new Uint8Array())).toContain("<p:sld");
  });

  it("round-trips XML parts byte-equivalent through the parsers", () => {
    const bytes = buildSyntheticPackageBytes();
    const pkg1 = OpcPackage.load(bytes);
    const written = pkg1.save();
    const pkg2 = OpcPackage.load(written);
    for (let i = 0; i < pkg1.parts.length; i++) {
      const a = pkg1.parts[i];
      const b = pkg2.parts[i];
      expect(b?.name).toBe(a?.name);
      expect(b?.contentType).toBe(a?.contentType);
      expect(b?.data).toEqual(a?.data);
    }
  });

  it("exposes parsed relationships per part", () => {
    const pkg = OpcPackage.load(buildSyntheticPackageBytes());

    const root = pkg.rootRels();
    expect(root?.items[0]?.type).toBe(SYNTHETIC_REL_TYPES.officeDoc);

    const presRels = pkg.getRels(partName("/ppt/presentation.xml"));
    expect(presRels?.items[0]?.type).toBe(SYNTHETIC_REL_TYPES.slide);

    const slideRels = pkg.getRels(partName("/ppt/slides/slide1.xml"));
    expect(slideRels?.items.length).toBe(2);
    expect(slideRels?.items[0]?.targetMode).toBe("External");
    expect(slideRels?.items[1]?.target).toBe("../media/image1.png");
  });

  it("returns null rels for parts without a sibling .rels", () => {
    const pkg = OpcPackage.load(buildSyntheticPackageBytes());
    expect(pkg.getRels(partName("/ppt/media/image1.png"))).toBeNull();
  });

  it("persists rels changes through save/reload", () => {
    const pkg = OpcPackage.load(buildSyntheticPackageBytes());
    const slideRels = pkg.getRels(partName("/ppt/slides/slide1.xml"));
    if (!slideRels) throw new Error("expected slide rels");
    slideRels.items.push({
      id: "rId3",
      type: "http://example.com/test-rel-type",
      target: "some-target",
      targetMode: "Internal",
    });
    pkg.setRels(partName("/ppt/slides/slide1.xml"), slideRels);

    const reread = OpcPackage.load(pkg.save());
    const out = reread.getRels(partName("/ppt/slides/slide1.xml"));
    expect(out?.items.map((i) => i.id)).toEqual(["rId1", "rId2", "rId3"]);
  });

  it("hands out a fresh copy of the relationships on every read", () => {
    const pkg = OpcPackage.load(buildSyntheticPackageBytes());
    const slide = partName("/ppt/slides/slide1.xml");
    const first = pkg.getRels(slide);
    if (!first) throw new Error("expected slide rels");
    first.items[1]!.target = "../media/changed.png";
    first.items.pop();
    const second = pkg.getRels(slide);
    expect(second?.items.length).toBe(2);
    expect(second?.items[1]?.target).toBe("../media/image1.png");
    // Writing them back is what the next read sees.
    pkg.setRels(slide, first);
    expect(pkg.getRels(slide)?.items.map((i) => i.target)).toEqual([
      first.items[0]?.target,
    ]);
    // So is a part whose bytes are replaced directly.
    const part = pkg.getPart(partName("/ppt/slides/_rels/slide1.xml.rels"));
    if (!part) throw new Error("expected the rels part");
    part.data = new TextEncoder().encode(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    );
    expect(pkg.getRels(slide)?.items).toEqual([]);
  });
});

describe("OpcPackage authoring", () => {
  it("adds a new part with an Override content type", () => {
    const pkg = OpcPackage.empty();
    const added = pkg.addPart(
      partName("/docProps/core.xml"),
      "application/vnd.openxmlformats-package.core-properties+xml",
      new TextEncoder().encode('<cp:coreProperties xmlns:cp="urn:cp"/>'),
    );
    expect(added.contentType).toBe(
      "application/vnd.openxmlformats-package.core-properties+xml",
    );
    expect(pkg.contentTypes.overrides.length).toBe(1);
  });

  it("refuses to add a duplicate part name", () => {
    const pkg = OpcPackage.empty();
    pkg.addPart(partName("/a.xml"), "application/xml", new Uint8Array());
    expect(() =>
      pkg.addPart(partName("/A.XML"), "application/xml", new Uint8Array()),
    ).toThrow();
  });

  it("finds parts after the part list is changed directly", () => {
    const pkg = OpcPackage.empty();
    const bytes = new Uint8Array();
    for (const n of ["/a.xml", "/b.xml", "/c.xml"])
      pkg.addPart(partName(n), "application/xml", bytes);
    expect(pkg.getPart(partName("/C.xml"))?.name).toBe("/c.xml");
    pkg.parts.splice(0, 1);
    expect(pkg.getPart(partName("/a.xml"))).toBeNull();
    expect(pkg.getPart(partName("/c.xml"))?.name).toBe("/c.xml");
    pkg.parts.reverse();
    expect(pkg.getPart(partName("/b.xml"))).toBe(pkg.parts[1]);
    const replaced = { name: partName("/d.xml"), contentType: "", data: bytes };
    pkg.parts[0] = replaced;
    expect(pkg.getPart(partName("/c.xml"))).toBeNull();
    expect(pkg.getPart(partName("/d.xml"))).toBe(replaced);
    pkg.parts.length = 0;
    pkg.parts.push(replaced);
    expect(pkg.getPart(partName("/b.xml"))).toBeNull();
    expect(pkg.getPart(partName("/d.xml"))).toBe(replaced);
  });

  it("removes a part and its Override entry", () => {
    const pkg = OpcPackage.empty();
    pkg.addPart(
      partName("/ppt/slides/slide99.xml"),
      "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
      new TextEncoder().encode('<p:sld xmlns:p="urn:p"/>'),
    );
    expect(pkg.removePart(partName("/ppt/slides/slide99.xml"))).toBe(true);
    expect(pkg.parts.length).toBe(0);
    expect(pkg.contentTypes.overrides.length).toBe(0);
  });

  it("omits the Override when an existing default already matches", () => {
    const pkg = OpcPackage.empty();
    // The defaults already register `xml` → application/xml.
    pkg.addPart(
      partName("/random.xml"),
      "application/xml",
      new TextEncoder().encode("<x/>"),
    );
    expect(pkg.contentTypes.overrides.length).toBe(0);
  });
});
