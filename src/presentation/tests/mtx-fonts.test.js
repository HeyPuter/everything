import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  decodeMtxFont,
  readOpenTypeFont,
  FontFormatError,
} from "../lib/pptx/src/internal/fonts/index.ts";
import { reconstructMtxFontTables } from "../lib/pptx/src/internal/fonts/mtx.ts";
import { decompressMtxStreams } from "../lib/pptx/src/internal/fonts/mtx-lzcomp.ts";
import { MtxReader } from "../lib/pptx/src/internal/fonts/mtx-reader.ts";
import {
  readMtxPushes,
  writeMtxPushes,
} from "../lib/pptx/src/internal/fonts/mtx-pushes.ts";
import { reconstructMtxGlyphs } from "../lib/pptx/src/internal/fonts/mtx-glyphs.ts";
import {
  reconstructMtxCvt,
  reconstructMtxHdmx,
  reconstructMtxVdmx,
} from "../lib/pptx/src/internal/fonts/mtx-metrics.ts";
import { fontTables } from "./font-format-fixture.js";
import { mtxFont } from "./mtx-font-fixture.js";

const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const join = (...items) => Uint8Array.from(items.flatMap((item) => [...item]));
const u16 = (value) => new Uint8Array([value >>> 8, value & 255]);
const tables = (bytes) => {
  const records = new Map(),
    v = view(bytes);
  for (let i = 0; i < v.getUint16(4); i++) {
    const at = 12 + i * 16,
      tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    records.set(tag, {
      at,
      checksum: v.getUint32(at + 4),
      offset: v.getUint32(at + 8),
      data: bytes.subarray(
        v.getUint32(at + 8),
        v.getUint32(at + 8) + v.getUint32(at + 12),
      ),
    });
  }
  return records;
};
const sum = (bytes) => {
  let total = 0;
  for (let at = 0; at < bytes.length; at += 4)
    total =
      (total +
        bytes[at] * 2 ** 24 +
        (bytes[at + 1] ?? 0) * 65536 +
        (bytes[at + 2] ?? 0) * 256 +
        (bytes[at + 3] ?? 0)) >>>
      0;
  return total;
};
const decodePushes = (bytes) => {
  const input = new MtxReader(bytes, "test native PUSH"),
    values = [];
  while (input.at < bytes.length) {
    const op = input.u8(),
      word = op === 0x41 || op >= 0xb8;
    expect(op === 0x40 || op === 0x41 || (op >= 0xb0 && op <= 0xbf)).toBe(true);
    const count = op < 0xb0 ? input.u8() : (op & 7) + 1;
    for (let i = 0; i < count; i++)
      values.push(word ? input.s16() : input.u8());
  }
  return values;
};
const brutePushSize = (values) => {
  const costs = [0];
  for (let end = 1; end <= values.length; end++) {
    costs[end] = Infinity;
    let bytes = true;
    for (let count = 1; count <= Math.min(255, end); count++) {
      const value = values[end - count];
      bytes &&= value >= 0 && value <= 255;
      const header = count <= 8 ? 1 : 2;
      costs[end] = Math.min(
        costs[end],
        costs[end - count] + count * (bytes ? 1 : 2) + header,
      );
    }
  }
  return costs.at(-1);
};
const glyphs = (
  bytes,
  pushes = [],
  code = [],
  count = 1,
  limit = 64 * 1024 * 1024,
) =>
  reconstructMtxGlyphs(
    Uint8Array.from(bytes),
    Uint8Array.from(pushes),
    Uint8Array.from(code),
    count,
    limit,
  );
const simple = (flag, payload, pushCount = 0, codeSize = 0) => [
  0,
  1,
  0,
  flag,
  ...payload,
  pushCount,
  codeSize,
];
const compound = (reference, flags = 2) => [
  255,
  255,
  ...new Uint8Array(8),
  ...u16(flags),
  ...u16(reference),
  0,
  0,
];

describe("MTX native font reconstruction", () => {
  for (const name of [
    "Regular",
    "Bold",
    "Italic",
    "BoldItalic",
    "PreviewPrint",
    "Wide",
    "Plus",
    "Complex",
    "ComplexOffsets",
    "ComplexRawMetrics",
  ])
    it(`preserves ${name} tables and face metadata with valid checksums`, () => {
      const input = mtxFont(name),
        before = input.slice(),
        original = mtxFont(name, "ttf"),
        decoded = decodeMtxFont(input),
        src = tables(original),
        dst = tables(decoded);
      expect(input).toEqual(before);
      const sourceInfo = readOpenTypeFont(original),
        targetInfo = readOpenTypeFont(decoded);
      expect({ ...targetInfo, checkSumAdjustment: 0 }).toEqual({
        ...sourceInfo,
        checkSumAdjustment: 0,
      });
      expect([...dst.keys()]).toEqual([...src.keys()].sort());
      expect(sum(decoded)).toBe(0xb1b0afba);
      const originalHead = src.get("head").data.slice(),
        reconstructedHead = dst.get("head").data.slice();
      view(originalHead).setUint32(8, 0);
      view(reconstructedHead).setUint32(8, 0);
      view(originalHead).setInt16(50, 0);
      view(reconstructedHead).setInt16(50, 0);
      expect(reconstructedHead).toEqual(originalHead);
      for (const [tag, record] of dst) {
        const check = record.data.slice();
        if (tag === "head") view(check).setUint32(8, 0);
        expect(sum(check), tag).toBe(record.checksum);
        if (!["head", "maxp", "glyf", "loca"].includes(tag))
          expect(record.data, tag).toEqual(src.get(tag).data);
      }
      const head = view(dst.get("head").data),
        loca = view(dst.get("loca").data),
        maxp = view(dst.get("maxp").data),
        num = maxp.getUint16(4),
        offsets = [];
      for (let i = 0; i <= num; i++)
        offsets.push(
          head.getInt16(50) ? loca.getUint32(i * 4) : loca.getUint16(i * 2) * 2,
        );
      expect(offsets[0]).toBe(0);
      expect(offsets.at(-1)).toBe(dst.get("glyf").data.length);
      expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    });

  it("works with sliced buffers and never aliases decoded font tables", () => {
    const block = mtxFont("Complex"),
      wrapped = Buffer.alloc(block.length + 20, 123);
    wrapped.set(block, 7);
    const before = Buffer.from(wrapped),
      input = wrapped.subarray(7, 7 + block.length),
      decoded = decodeMtxFont(input);
    decoded.fill(0);
    expect(wrapped).toEqual(before);
  });

  it("upgrades short loca when reconstructed glyphs no longer fit", () => {
    const src = tables(mtxFont("Regular", "ttf")),
      head = src.get("head").data.slice(),
      maxp = src.get("maxp").data.slice();
    view(head).setInt16(50, 0);
    view(maxp).setUint16(4, 1);
    const points = 30000,
      encoded = join(
        [0, 1, 253],
        u16(points - 1),
        new Uint8Array(points * 2),
        [0, 0],
      ),
      rest = fontTables([
        ["head", head],
        ["maxp", maxp],
        ["glyf", encoded],
        ["loca", new Uint8Array()],
      ]);
    view(rest).setUint32(tables(rest).get("loca").at + 8, 0);
    const dst = tables(
      reconstructMtxFontTables(rest, new Uint8Array(), new Uint8Array()),
    );
    expect(view(dst.get("head").data).getInt16(50)).toBe(1);
    expect(dst.get("glyf").data.length).toBeGreaterThan(131070);
    expect(view(dst.get("loca").data).getUint32(4)).toBe(
      dst.get("glyf").data.length,
    );
  });

  it("limits reconstructed output in addition to the decoded CTF streams", () => {
    const streams = decompressMtxStreams(mtxFont("Complex")),
      full = reconstructMtxFontTables(...streams);
    expect(
      reconstructMtxFontTables(...streams, { maxDecodedBytes: full.length }),
    ).toEqual(full);
    expect(() =>
      reconstructMtxFontTables(...streams, {
        maxDecodedBytes: full.length - 1,
      }),
    ).toThrow(/output limit/);
  });

  for (const fault of [
    "duplicate",
    "overlap",
    "loca",
    "head",
    "maxp",
    "glyph count",
    "location format",
  ])
    it(`rejects malformed CTF ${fault}`, () => {
      const [rest, pushes, code] = decompressMtxStreams(mtxFont("Regular")),
        entries = tables(rest),
        v = view(rest);
      if (fault === "duplicate") rest.set(rest.subarray(12, 16), 28);
      if (fault === "overlap")
        v.setUint32(entries.get("name").at + 8, entries.get("glyf").offset);
      if (fault === "loca") v.setUint32(entries.get("loca").at + 8, 4);
      if (fault === "head") v.setUint32(entries.get("head").offset, 0);
      if (fault === "maxp") v.setUint32(entries.get("maxp").offset, 0);
      if (fault === "glyph count")
        v.setUint16(entries.get("maxp").offset + 4, 0);
      if (fault === "location format")
        v.setInt16(entries.get("head").offset + 50, 2);
      expect(() => reconstructMtxFontTables(rest, pushes, code)).toThrow(
        FontFormatError,
      );
    });
});

describe("MTX glyph and hint reconstruction", () => {
  const { vectors } = JSON.parse(
    readFileSync(
      new URL("./fixtures/fonts/mtx-triplets.json", import.meta.url),
      "utf8",
    ),
  );
  for (const vector of vectors)
    for (const off of [0, 128])
      it(`matches published triplet ${vector.flag}, ${off ? "off" : "on"} curve`, () => {
        const result = glyphs(simple(vector.flag | off, vector.payload)),
          v = view(result.glyf);
        expect(v.getInt16(15)).toBe(vector.dx);
        expect(v.getInt16(17)).toBe(vector.dy);
        expect(result.glyf[14]).toBe(off ? 0 : 1);
        expect([
          v.getInt16(2),
          v.getInt16(4),
          v.getInt16(6),
          v.getInt16(8),
        ]).toEqual([vector.dx, vector.dy, vector.dx, vector.dy]);
      });

  it("restores cumulative contour endpoints and coordinates across contours", () => {
    const result = glyphs([0, 2, 1, 2, 11, 1, 10, 0, 10, 20, 5, 7, 0, 0]),
      v = view(result.glyf);
    expect([v.getUint16(10), v.getUint16(12)]).toEqual([1, 3]);
    expect([
      v.getInt16(2),
      v.getInt16(4),
      v.getInt16(6),
      v.getInt16(8),
    ]).toEqual([5, 0, 10, 20]);
  });
  it("retains explicit bounds instead of recalculating them", () => {
    const result = glyphs([
        127,
        255,
        0,
        1,
        ...u16(-40),
        ...u16(-50),
        ...u16(60),
        ...u16(70),
        0,
        11,
        10,
        0,
        0,
      ]),
      v = view(result.glyf);
    expect([
      v.getInt16(2),
      v.getInt16(4),
      v.getInt16(6),
      v.getInt16(8),
    ]).toEqual([-40, -50, 60, 70]);
  });
  it("represents empty outlines with equal loca offsets", () => {
    const result = glyphs([0, 0, 0, 0], [], [], 1, 0);
    expect(result.glyf.length).toBe(0);
    expect([...result.offsets]).toEqual([0, 0]);
  });
  it("retains zero-contour hint programs and the original code tail", () => {
    const result = glyphs([0, 0, 1, 1], [7], [0x21]),
      v = view(result.glyf);
    expect(v.getUint16(10)).toBe(3);
    expect([...result.glyf.subarray(12, 15)]).toEqual([0xb0, 7, 0x21]);
    expect(result.maxInstructions).toBe(3);
  });
  it("uses counts from each glyph without sharing hop history across glyphs", () => {
    expect(() =>
      glyphs([0, 0, 2, 0, 0, 0, 3, 0], [7, 9, 251, 8], [], 2),
    ).toThrow(/history/);
  });
  it("retains component bytes and the early instruction flag's native length field", () => {
    const first = compound(0, 2 | 32 | 256),
      last = [...u16(2), ...u16(0), 0, 0],
      encoded = [0, 0, 0, 0, ...first, ...last],
      result = glyphs(encoded, [], [], 2);
    expect([...result.glyf.subarray(10, 22)]).toEqual([
      ...first.slice(10),
      ...last,
    ]);
    expect(view(result.glyf).getUint16(22)).toBe(0);
  });
  for (const [name, input, count] of [
    ["self-reference", compound(0), 1],
    ["mutual cycle", [...compound(1), ...compound(0)], 2],
    ["missing component", compound(1), 1],
    ["conflicting transforms", compound(0, 2 | 8 | 64), 1],
    ["empty later contour", [0, 2, 0, 0], 1],
    ["endpoint overflow", [0, 2, 253, 255, 255, 1], 1],
    ["nonrepresentable delta", simple(125, [255, 255, 0, 0]), 1],
  ])
    it(`rejects ${name}`, () =>
      expect(() => glyphs(input, [], [], count)).toThrow(FontFormatError));
  it("rejects unused push/code data", () => {
    expect(() => glyphs([0, 0, 0, 0], [1])).toThrow(/trailing/);
    expect(() => glyphs([0, 0, 0, 0], [], [0])).toThrow(/trailing/);
  });
  it("rejects every truncated prefix of the actual multi-glyph fixture", () => {
    const [rest, pushes, code] = decompressMtxStreams(mtxFont("Complex")),
      entries = tables(rest),
      encoded = entries.get("glyf").data,
      num = view(entries.get("maxp").data).getUint16(4);
    for (let length = 0; length < encoded.length; length++)
      expect(() =>
        reconstructMtxGlyphs(
          encoded.subarray(0, length),
          pushes,
          code,
          num,
          64 * 1024 * 1024,
        ),
      ).toThrow(FontFormatError);
  });
});

describe("MTX push data and native PUSH burst", () => {
  for (const [encoded, expected] of [
    [[252], 252],
    [[255, 255], 508],
    [[254, 255], 761],
    [[253, 255, 255], 65535],
  ])
    it(`decodes 255USHORT ${encoded.join("/")}`, () =>
      expect(new MtxReader(Uint8Array.from(encoded), "test").ushort()).toBe(
        expected,
      ));
  for (const [encoded, expected] of [
    [[249], 249],
    [[250, 249], -249],
    [[255, 255], 505],
    [[254, 255], 755],
    [[250, 254, 255], -755],
    [[253, 128, 0], -32768],
    [[253, 127, 255], 32767],
    [[250, 253], -253],
  ])
    it(`decodes 255SHORT ${encoded.join("/")}`, () =>
      expect(new MtxReader(Uint8Array.from(encoded), "test").short()).toBe(
        expected,
      ));
  it("restores Hop3 and Hop4 without recursive hop interpretation", () => {
    expect([
      ...readMtxPushes(
        new MtxReader(new Uint8Array([7, 9, 251, 252]), "test"),
        5,
      ),
    ]).toEqual([7, 9, 7, 252, 7]);
    expect([
      ...readMtxPushes(
        new MtxReader(new Uint8Array([7, 9, 252, 11, 250, 253]), "test"),
        7,
      ),
    ]).toEqual([7, 9, 7, 11, 7, -253, 7]);
  });
  for (const count of [0, 1, 8, 9, 254, 255, 256, 511, 800, 32767, 65535])
    // Up to 65535 values encoded and decoded.
    it(`preserves a ${count}-value mixed initial stack with minimal encoding`, () => {
      const values = Int16Array.from(
          { length: count },
          (_, i) => [0, 255, 256, -32768, 32767, 7][i % 6],
        ),
        output = writeMtxPushes(values);
      expect(decodePushes(output)).toEqual([...values]);
      if (count <= 800) expect(output.length).toBe(brutePushSize(values));
    }, 30_000);
  it("matches independent exhaustive PUSH packing for every short byte/word pattern", () => {
    for (let pattern = 0; pattern < 1024; pattern++) {
      const values = Int16Array.from({ length: 10 }, (_, i) =>
        (pattern >>> i) & 1 ? -100 : 200,
      );
      expect(writeMtxPushes(values).length).toBe(brutePushSize(values));
    }
  });
  it("does not reject a valid near-limit byte/word program because of excessive splitting", () => {
    const values = Int16Array.from({ length: 32000 }, (_, i) =>
        i % 2 ? -1 : 1,
      ),
      initial = writeMtxPushes(values);
    expect(initial.length).toBeLessThanOrEqual(65535);
    expect(decodePushes(initial)).toEqual([...values]);
  });
  it("rejects hop overruns and missing operands", () => {
    for (const [data, count] of [
      [[251, 0], 3],
      [[7, 8, 251, 0], 4],
      [[7, 8, 252, 0], 7],
      [[253, 0], 1],
      [[250], 1],
    ])
      expect(() =>
        readMtxPushes(new MtxReader(Uint8Array.from(data), "test"), count),
      ).toThrow(FontFormatError);
  });
});

describe("MTX control and device metrics", () => {
  it("decodes CVT deltas modulo 16 bits including noncanonical byte magnitudes", () => {
    const encoded = new Uint8Array([
        0, 7, 237, 248, 0, 255, 255, 239, 255, 247, 255, 238, 128, 0, 238, 127,
        255,
      ]),
      output = reconstructMtxCvt(encoded, 14),
      v = view(output);
    expect(Array.from({ length: 7 }, (_, i) => v.getInt16(i * 2))).toEqual([
      237, 475, 2634, 2379, 220, -32548, 219,
    ]);
  });
  it("uses both integer rounding steps for device advances", () => {
    const encoded = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 4, 1, 1, 0]),
      output = reconstructMtxHdmx(encoded, new Uint16Array([499]), 1000, 12);
    // 499/1000 is below half; 26.6 integer rounding first yields 32/64.
    expect([...output.subarray(8)]).toEqual([1, 1, 1, 0]);
  });
  it("reconstructs compressed, shared and raw device metric groups identically", () => {
    const originals = tables(mtxFont("Complex", "ttf"));
    for (const name of ["Complex", "ComplexOffsets", "ComplexRawMetrics"]) {
      const decoded = tables(decodeMtxFont(mtxFont(name)));
      expect(decoded.get("hdmx").data).toEqual(originals.get("hdmx").data);
      expect(decoded.get("VDMX").data).toEqual(originals.get("VDMX").data);
    }
  });
  it("rejects invalid record sizes, versions, offsets, truncated unary errors and expansion budgets", () => {
    expect(() => reconstructMtxCvt(new Uint8Array([0, 1, 238, 0]), 2)).toThrow(
      FontFormatError,
    );
    expect(() => reconstructMtxCvt(new Uint8Array([0, 1, 0, 9]), 2)).toThrow(
      /trailing/,
    );
    expect(() => reconstructMtxCvt(new Uint8Array([0, 2, 0, 0]), 3)).toThrow(
      /output limit/,
    );
    const [rest] = decompressMtxStreams(mtxFont("Complex")),
      entries = tables(rest);
    const hdmx = entries.get("hdmx").data.slice(),
      vdmx = entries.get("VDMX").data.slice(),
      advances = new Uint16Array(10).fill(600);
    view(hdmx).setUint32(4, 3);
    expect(() => reconstructMtxHdmx(hdmx, advances, 1000, 10000)).toThrow(
      /record size/,
    );
    view(hdmx).setUint32(4, 12);
    expect(() =>
      reconstructMtxHdmx(hdmx.subarray(0, 14), advances, 1000, 10000),
    ).toThrow(FontFormatError);
    view(vdmx).setUint16(18, 1);
    expect(() => reconstructMtxVdmx(vdmx, 10000)).toThrow(/overlaps/);
    view(vdmx).setUint16(0, 2);
    expect(() => reconstructMtxVdmx(vdmx, 10000)).toThrow(/version/);
    expect(() => reconstructMtxVdmx(entries.get("VDMX").data, 10)).toThrow(
      /output limit/,
    );
  });
});
