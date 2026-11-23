import * as fflate from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  basename,
  dirname,
  emptyContentTypes,
  emptyRels,
  fromZipPath,
  lookupContentType,
  nextRelId,
  parseContentTypes,
  parseRels,
  partName,
  partNamesEqual,
  readZip,
  relsPartNameFor,
  resolveTarget,
  serializeContentTypes,
  serializeRels,
  shouldStore,
  toZipPath,
  writeZip,
} from "./index.ts";

// The real library, watched: a save that compresses nothing new calls no
// deflate.
vi.mock("fflate", async (original) => {
  const real = await original<typeof import("fflate")>();
  return { ...real, deflateSync: vi.fn(real.deflateSync) };
});
const { zipSync } = fflate;
const deflated = vi.mocked(fflate.deflateSync);

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("zip", () => {
  it("round-trips a small archive preserving entry order", () => {
    const original = [
      { name: "a.xml", data: utf8("<a/>") },
      { name: "b/c.xml", data: utf8("<c/>") },
      { name: "d.bin", data: new Uint8Array([1, 2, 3]) },
    ];
    const zip = writeZip(original);
    const out = readZip(zip);
    expect(out.entries.map((e) => e.name)).toEqual(original.map((e) => e.name));
    for (let i = 0; i < original.length; i++) {
      expect(out.entries[i]?.data).toEqual(original[i]?.data);
    }
  });

  describe("archive bytes", () => {
    afterEach(() => vi.useRealTimers());
    const entries = () => [
      { name: "[Content_Types].xml", data: utf8("<Types/>".repeat(50)) },
      {
        name: "ppt/slides/slide1.xml",
        data: utf8("<p:sld>héllo</p:sld>".repeat(40)),
      },
      {
        name: "ppt/media/image1.png",
        data: new Uint8Array(3000).map((_, i) => (i * 31) & 255),
      },
      {
        name: "ppt/embeddings/Ünïcode name.bin",
        data: new Uint8Array([9, 8, 7]),
      },
      { name: "empty.xml", data: new Uint8Array(0) },
    ];
    const reference = (list: { name: string; data: Uint8Array }[]) =>
      zipSync(
        Object.fromEntries(
          list.map((e) => [
            e.name,
            [e.data, { level: shouldStore(e.name) ? 0 : 6 }],
          ]),
        ) as never,
      );

    it("are the archive the ZIP library writes", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 10, 22, 13, 37, 42));
      const list = entries();
      expect(writeZip(list)).toEqual(reference(list));
    });

    // A part's bytes are compressed once: a later save of an unchanged part
    // reuses them, and a part given new bytes is written anew.
    it("stay right when a save reuses an unchanged part's compression", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 10, 22, 13, 37, 42));
      const list = entries();
      const first = writeZip(list);
      deflated.mockClear();
      expect(writeZip(list)).toEqual(first);
      expect(deflated).not.toHaveBeenCalled();
      list[1] = { name: list[1]!.name, data: utf8("<p:sld>changed</p:sld>") };
      deflated.mockClear();
      const next = writeZip(list);
      expect(deflated).toHaveBeenCalledTimes(1);
      expect(next).toEqual(reference(list));
      const out = readZip(writeZip(list));
      expect(decode(out.entries[1]!.data)).toBe("<p:sld>changed</p:sld>");
      // The same bytes written at another level are compressed at that level.
      expect(writeZip(list, { level: 1 })).toEqual(
        zipSync(
          Object.fromEntries(
            list.map((e) => [
              e.name,
              [e.data, { level: shouldStore(e.name) ? 0 : 1 }],
            ]),
          ) as never,
        ),
      );
    });

    // An undo reads a snapshot written here back into fresh part bytes; its
    // next save compresses only what changed since, and writes the same
    // archive a save from scratch would.
    it("reuse the compression of an archive written here when read back", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 10, 22, 13, 37, 42));
      const archive = writeZip(entries());
      const read = readZip(archive, { snapshot: true }).entries;
      deflated.mockClear();
      expect(writeZip(read)).toEqual(archive);
      expect(deflated).not.toHaveBeenCalled();
      read[1] = { name: read[1]!.name, data: utf8("<p:sld>edited</p:sld>") };
      const next = writeZip(read);
      expect(deflated).toHaveBeenCalledTimes(1);
      expect(next).toEqual(reference(read));
      // An archive from elsewhere, though byte for byte the same, or one
      // not read as an unchanged snapshot, gives nothing to reuse.
      for (const copy of [
        readZip(archive.slice(), { snapshot: true }).entries,
        readZip(archive).entries,
      ]) {
        deflated.mockClear();
        expect(writeZip(copy)).toEqual(archive);
        expect(deflated).toHaveBeenCalledTimes(
          copy.filter((e) => !shouldStore(e.name)).length,
        );
      }
    });

    // Parts the deck in memory still holds are taken as they are, not
    // unpacked into copies; the entries and their order are as unpacked.
    it("take back the bytes still in memory when read back", () => {
      const list = entries();
      const archive = writeZip(list);
      const read = readZip(archive, { snapshot: true }).entries;
      const unpacked = readZip(archive).entries;
      expect(read.map((e) => e.name)).toEqual(unpacked.map((e) => e.name));
      expect(read).toEqual(unpacked);
      read.forEach((e, i) => expect(e.data).toBe(list[i]!.data));
      unpacked.forEach((e, i) => expect(e.data).not.toBe(list[i]!.data));
    });

    // Media added without its picture leaves a part with no bytes; the save
    // goes ahead without it instead of failing.
    it("leave out a part that has no bytes", () => {
      const list = [
        ...entries(),
        { name: "ppt/media/image9.png", data: undefined as never },
      ];
      const out = readZip(writeZip(list));
      expect(out.entries.map((e) => e.name)).toEqual(
        entries().map((e) => e.name),
      );
    });
  });

  it("classifies known-compressed extensions as STORE", () => {
    expect(shouldStore("media/image1.png")).toBe(true);
    expect(shouldStore("media/image1.JPG")).toBe(true);
    expect(shouldStore("audio.mp3")).toBe(true);
    expect(shouldStore("ppt/slides/slide1.xml")).toBe(false);
    expect(shouldStore("plain.txt")).toBe(false);
    expect(shouldStore("noext")).toBe(false);
  });
});

describe("part names", () => {
  it("accepts valid names", () => {
    expect(partName("/ppt/slides/slide1.xml")).toBe("/ppt/slides/slide1.xml");
    expect(partName("/x")).toBe("/x");
  });

  it("rejects invalid names", () => {
    expect(() => partName("")).toThrow();
    expect(() => partName("no-leading-slash.xml")).toThrow();
    expect(() => partName("/trailing/")).toThrow();
    expect(() => partName("/a//b")).toThrow();
    expect(() => partName("/a/./b")).toThrow();
    expect(() => partName("/a/../b")).toThrow();
  });

  it("compares case-insensitively", () => {
    expect(
      partNamesEqual(
        partName("/Ppt/Slides/SLIDE1.xml"),
        partName("/ppt/slides/slide1.xml"),
      ),
    ).toBe(true);
    expect(partNamesEqual(partName("/a.xml"), partName("/b.xml"))).toBe(false);
  });

  it("converts to/from zip paths", () => {
    const pn = partName("/ppt/x.xml");
    expect(toZipPath(pn)).toBe("ppt/x.xml");
    expect(fromZipPath("ppt/x.xml")).toBe("/ppt/x.xml");
  });

  it("computes dirname and basename", () => {
    expect(dirname(partName("/ppt/slides/slide1.xml"))).toBe("/ppt/slides");
    expect(basename(partName("/ppt/slides/slide1.xml"))).toBe("slide1.xml");
    expect(dirname(partName("/top.xml"))).toBe("/");
  });

  it("locates the rels part name", () => {
    expect(relsPartNameFor(partName("/ppt/presentation.xml"))).toBe(
      "/ppt/_rels/presentation.xml.rels",
    );
    expect(relsPartNameFor(partName("/ppt/slides/slide1.xml"))).toBe(
      "/ppt/slides/_rels/slide1.xml.rels",
    );
  });

  it("resolves relative relationship targets against a base", () => {
    const base = partName("/ppt/slides/slide1.xml");
    expect(resolveTarget(base, "../slideLayouts/slideLayout1.xml")).toBe(
      "/ppt/slideLayouts/slideLayout1.xml",
    );
    expect(resolveTarget(base, "../media/image1.png")).toBe(
      "/ppt/media/image1.png",
    );
    expect(resolveTarget(base, "/ppt/theme/theme1.xml")).toBe(
      "/ppt/theme/theme1.xml",
    );
  });

  it("rejects targets that escape the package root", () => {
    expect(() => resolveTarget(partName("/a.xml"), "../escape.xml")).toThrow();
  });
  it.each([
    ["slides/%73lide%33.xml", "/ppt/slides/slide3.xml"],
    ["/ppt/slides/%53lide3.xml", "/ppt/slides/Slide3.xml"],
    ["slides/name%2d%5F%7e.xml", "/ppt/slides/name-_~.xml"],
    ["slides/%2e%2e/media/image1.png", "/ppt/media/image1.png"],
    ["slides/a%20b%2F%3F.xml", "/ppt/slides/a%20b%2F%3F.xml"],
    ["slides/%2573lide.xml", "/ppt/slides/%2573lide.xml"],
  ])(
    "normalizes only unreserved relationship octets in %s",
    (target, expected) => {
      expect(resolveTarget(partName("/ppt/presentation.xml"), target)).toBe(
        expected,
      );
    },
  );
  it("keeps escaped dot-segment traversal inside the package", () => {
    expect(() => resolveTarget("/", "%2e%2e/escape.xml")).toThrow(/escapes/);
  });
  it("resolves package-root relationships without treating the root as a part", () => {
    expect(resolveTarget("/", "./deck/main.xml")).toBe("/deck/main.xml");
    expect(resolveTarget("/", "/deck/main.xml")).toBe("/deck/main.xml");
    expect(() => resolveTarget("/", "../escape.xml")).toThrow();
    expect(() => partName("/")).toThrow();
  });
});

describe("Content_Types", () => {
  const sampleXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`;

  it("parses defaults and overrides", () => {
    const ct = parseContentTypes(sampleXml);
    expect(ct.defaults).toEqual([
      {
        extension: "rels",
        contentType: "application/vnd.openxmlformats-package.relationships+xml",
      },
      { extension: "xml", contentType: "application/xml" },
    ]);
    expect(ct.overrides[0]?.partName).toBe("/ppt/presentation.xml");
  });

  it("round-trips byte-equivalent", () => {
    const ct = parseContentTypes(sampleXml);
    expect(serializeContentTypes(ct)).toBe(sampleXml);
  });

  it("looks up content type via Override then Default", () => {
    const ct = parseContentTypes(sampleXml);
    expect(lookupContentType(ct, partName("/ppt/presentation.xml"))).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    );
    expect(lookupContentType(ct, partName("/_rels/.rels"))).toBe(
      "application/vnd.openxmlformats-package.relationships+xml",
    );
    expect(lookupContentType(ct, partName("/unknown/file.bin"))).toBeNull();
  });

  it("rejects non-Types root", () => {
    expect(() => parseContentTypes("<NotTypes/>")).toThrow();
  });

  it("provides an empty starter value", () => {
    const ct = emptyContentTypes();
    expect(ct.defaults.length).toBe(2);
    expect(ct.overrides.length).toBe(0);
  });
});

describe("rels", () => {
  const sampleXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>`;

  it("parses relationships including TargetMode", () => {
    const rels = parseRels(sampleXml);
    expect(rels.items.length).toBe(3);
    expect(rels.items[0]).toEqual({
      id: "rId1",
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
      target: "ppt/presentation.xml",
      targetMode: "Internal",
    });
    expect(rels.items[2]?.targetMode).toBe("External");
  });

  it("round-trips byte-equivalent", () => {
    const rels = parseRels(sampleXml);
    expect(serializeRels(rels)).toBe(sampleXml);
  });

  it("rejects malformed input", () => {
    expect(() => parseRels('<Relationships xmlns="urn:wrong"/>')).toThrow();
  });

  it("next rId picks the smallest free number after the existing max", () => {
    expect(nextRelId([])).toBe("rId1");
    expect(nextRelId(["rId1", "rId2"])).toBe("rId3");
    expect(nextRelId(["rId7", "rId2"])).toBe("rId8");
    // Non-conforming IDs are tolerated and ignored for the counter.
    expect(nextRelId(["xyz", "rId5"])).toBe("rId6");
  });

  it("exposes an empty starter value", () => {
    expect(emptyRels()).toEqual({ items: [] });
  });
});

describe("OPC end-to-end zip + content-types + rels round-trip", () => {
  it("round-trips a synthetic minimal package", () => {
    // Build a package whose only "interesting" parts are the package-root
    // rels (one relationship to a fake presentation.xml) and a
    // [Content_Types].xml describing both. This is the absolute minimum that
    // exercises the OPC layer without yet requiring PresentationML.
    const ct = emptyContentTypes();
    ct.overrides.push({
      partName: partName("/ppt/presentation.xml"),
      contentType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    });
    const rootRels = parseRels(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    );

    const entries = [
      { name: "[Content_Types].xml", data: utf8(serializeContentTypes(ct)) },
      { name: "_rels/.rels", data: utf8(serializeRels(rootRels)) },
      { name: "ppt/presentation.xml", data: utf8('<p:sld xmlns:p="urn:p"/>') },
    ];
    const bytes = writeZip(entries);

    const re = readZip(bytes);
    expect(re.entries.map((e) => e.name)).toEqual(entries.map((e) => e.name));

    const ctOut = parseContentTypes(
      decode(re.entries[0]?.data ?? new Uint8Array()),
    );
    const relsOut = parseRels(decode(re.entries[1]?.data ?? new Uint8Array()));
    expect(lookupContentType(ctOut, partName("/ppt/presentation.xml"))).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    );
    expect(relsOut.items[0]?.target).toBe("ppt/presentation.xml");
  });
});
