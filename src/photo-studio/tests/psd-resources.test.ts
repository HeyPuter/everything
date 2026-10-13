import { describe, it, expect } from "vitest";
import {
  readPsdImageResource,
  replacePsdImageResource,
  encodeIccProfile,
  decodeIccProfile,
  readPsdImageResources,
  encodePsdImageResources,
  decodePsdImageResources,
  restorePsdImageResources,
  psdResourcesMimeType,
} from "../src/model/psd-resources";
import { Assets } from "../src/model/assets";
import { newDocument } from "../src/model/document";
import {
  serialize,
  deserialize,
  validateDocument,
} from "../src/model/serialization";
import { History } from "../src/history/history";

// Build records independently of the implementation, including names and
// nonzero padding that an opaque round trip must retain byte-for-byte.
function record(id: number, data: Uint8Array, name = "", signature = "8BIM") {
  const nameSize = name.length + 1;
  const sizeOffset = 6 + nameSize + (nameSize % 2);
  const out = new Uint8Array(sizeOffset + 4 + data.length + (data.length % 2));
  const v = new DataView(out.buffer);
  out.set(new TextEncoder().encode(signature));
  v.setUint16(4, id);
  out[6] = name.length;
  out.set(
    Uint8Array.from(name, (c) => c.charCodeAt(0)),
    7,
  );
  if (nameSize % 2) out[sizeOffset - 1] = 173;
  v.setUint32(sizeOffset, data.length);
  out.set(data, sizeOffset + 4);
  if (data.length % 2) out[out.length - 1] = 191;
  return out;
}
function withRecords(version: number, blocks: Uint8Array[]) {
  const data = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    data.set(b, at);
    at += b.length;
  }
  const base = minimalFile(version);
  const out = new Uint8Array(base.length + data.length);
  out.set(base.subarray(0, 34));
  new DataView(out.buffer).setUint32(30, data.length);
  out.set(data, 34);
  out.set(base.subarray(34), 34 + data.length);
  return out;
}

function minimalFile(version = 1) {
  const bytes = new Uint8Array(40);
  bytes.set(new TextEncoder().encode("8BPS"));
  new DataView(bytes.buffer).setUint16(4, version);
  // Empty color data and image resources; remaining bytes stand for later sections.
  bytes.set([1, 2, 3, 4, 5, 6], 34);
  return bytes;
}

describe("PSD opaque image resources", () => {
  it("preserves names, padding, private signatures, duplicates and unknown records across PSD/PSB versions", () => {
    const blocks = [
      record(1028, new Uint8Array([1, 7, 17]), "IPTC"),
      record(1060, new TextEncoder().encode("<x:xmpmeta/>"), "XMP"),
      ...["8BIM", "MeSa", "AgHg", "PHUT", "DCSR"].map((s, i) =>
        record(4000 + i, new Uint8Array([i, 251]), "private", s),
      ),
      record(4000, new Uint8Array(), "another"),
      record(61000, new Uint8Array([19]), "future"),
    ];
    for (const source of [1, 2])
      for (const destination of [1, 2]) {
        const original = withRecords(source, blocks);
        const captured = readPsdImageResources(original);
        const wrapped = new Uint8Array(captured.length + 9);
        wrapped.set(captured, 9);
        const encoded = new Uint8Array(
          encodePsdImageResources(wrapped.subarray(9)),
        );
        const decoded = decodePsdImageResources(encoded);
        expect(decoded).toEqual(captured);
        const output = new Uint8Array(
          restorePsdImageResources(minimalFile(destination), decoded),
        );
        expect(readPsdImageResources(output)).toEqual(captured);
        expect(output.subarray(-6)).toEqual(
          minimalFile(destination).subarray(-6),
        );
        expect(new DataView(output.buffer).getUint16(4)).toBe(destination);
      }
  });
  it("keeps generated resources authoritative and never resurrects removed profile/resolution or stale caches/index tables", () => {
    const original = withRecords(2, [
      ...[
        1000, 1003, 1005, 1024, 1026, 1033, 1036, 1039, 1041, 1057, 1069, 1072,
      ].map((id) => record(id, new Uint8Array([11]))),
      record(1060, new Uint8Array([13])),
      record(1037, new Uint8Array([17])),
    ]);
    const current = withRecords(1, [
      record(1005, new Uint8Array([23, 29])),
      record(1037, new Uint8Array([31, 37])),
      record(1057, new Uint8Array([41, 43])),
    ]);
    const output = new Uint8Array(
      restorePsdImageResources(current, readPsdImageResources(original)),
    );
    for (const id of [1005, 1037, 1057])
      expect(readPsdImageResource(output, id)).toEqual(
        readPsdImageResource(current, id),
      );
    for (const id of [
      1000, 1003, 1024, 1026, 1033, 1036, 1039, 1041, 1069, 1072,
    ])
      expect(readPsdImageResource(output, id)).toBeUndefined();
    expect(readPsdImageResource(output, 1060)).toEqual(new Uint8Array([13]));
    // Native preservation includes original caches and state, independently of
    // which records can safely be restored after editing the current document.
    const retained = decodePsdImageResources(
      new Uint8Array(encodePsdImageResources(readPsdImageResources(original))),
    );
    expect(retained).toEqual(readPsdImageResources(original));
  });
  it("bounds malformed resource streams and native assets before allocating record indexes", () => {
    const good = record(60000, new Uint8Array([5, 7, 11]), "long name");
    for (const length of [1, 6, 8, good.length - 1])
      expect(() => encodePsdImageResources(good.subarray(0, length))).toThrow(
        "Truncated",
      );
    const invalid = good.slice();
    invalid[0] = 0;
    expect(() => encodePsdImageResources(invalid)).toThrow("signature");
    const emptyRecord = record(61000, new Uint8Array());
    const many = new Uint8Array(emptyRecord.length * 65537);
    for (let at = 0; at < many.length; at += emptyRecord.length)
      many.set(emptyRecord, at);
    expect(() => encodePsdImageResources(many)).toThrow("index budget");
    const encoded = new Uint8Array(encodePsdImageResources(good));
    for (const input of [
      encoded.slice(0, 7),
      encoded.slice(0, -1),
      new Uint8Array(8),
    ])
      expect(() => decodePsdImageResources(input)).toThrow();
    const badNative = encoded.slice();
    new DataView(badNative.buffer).setUint32(8 + 16, 0xffffffff);
    expect(() => decodePsdImageResources(badNative)).toThrow("data");
  });
  it("stores megabyte resource payloads outside history/JSON and validates native asset references", async () => {
    const payload = Uint8Array.from(
      { length: 1024 * 1024 + 3 },
      (_, i) => i % 251,
    );
    const data = record(60000, payload, "future");
    const assets = new Assets();
    const doc = newDocument(3, 5);
    let reopened;
    try {
      doc.psdResourcesAsset = await assets.add(
        new Blob([encodePsdImageResources(data)], {
          type: psdResourcesMimeType,
        }),
      );
      const history = new History(doc);
      history.execute("Rename", (d) => {
        d.name = "Edited";
      });
      history.undo();
      history.redo();
      expect(history.document.psdResourcesAsset).toBe(doc.psdResourcesAsset);
      const saved = await serialize(history.document, assets);
      expect(
        new DataView(await saved.slice(0, 12).arrayBuffer()).getUint32(8, true),
      ).toBeLessThan(2048);
      reopened = await deserialize(saved);
      expect(
        decodePsdImageResources(
          new Uint8Array(
            await reopened.assets
              .blob(reopened.document.psdResourcesAsset!)
              .arrayBuffer(),
          ),
        ),
      ).toEqual(data);
      expect(() => assets.dimensions(doc.psdResourcesAsset!)).toThrow(
        "Missing image asset",
      );
      for (const bad of [7, "", null])
        expect(() =>
          validateDocument({ ...doc, psdResourcesAsset: bad }),
        ).toThrow("resources asset reference");
      const wrongType = await assets.addRaster({
        width: 3,
        height: 5,
        data: new Uint16Array(60),
      });
      await expect(
        deserialize(
          await serialize({ ...doc, psdResourcesAsset: wrongType }, assets),
        ),
      ).rejects.toThrow("resources asset type");
      await expect(
        assets.add(
          new Blob([new Uint8Array(8)], { type: psdResourcesMimeType }),
        ),
      ).rejects.toThrow("native PSD image resources");
    } finally {
      assets.clear();
      reopened?.assets.clear();
    }
  }, 20_000);
  it("preserves odd/even payloads, other resources and later sections in PSD and PSB", () => {
    for (const version of [1, 2]) {
      const original = minimalFile(version);
      let bytes = new Uint8Array(
        replacePsdImageResource(original, 1060, new Uint8Array([1, 2, 3])),
      );
      bytes = new Uint8Array(
        replacePsdImageResource(bytes, 1039, new Uint8Array([4, 5, 6, 7])),
      );
      bytes = new Uint8Array(
        replacePsdImageResource(bytes, 1039, new Uint8Array([8, 9, 10])),
      );
      expect(readPsdImageResource(bytes, 1039)).toEqual(
        new Uint8Array([8, 9, 10]),
      );
      expect(readPsdImageResource(bytes, 1060)).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      expect(readPsdImageResource(bytes, 1041)).toBeUndefined();
      expect(bytes.subarray(-6)).toEqual(original.subarray(-6));
      const offset = new Uint8Array(bytes.length + 5);
      offset.set(bytes, 5);
      expect(readPsdImageResource(offset.subarray(5), 1039)).toEqual(
        new Uint8Array([8, 9, 10]),
      );
    }
  });
  it("handles padded Pascal names and color-mode data without assuming fixed resource offsets", () => {
    const bytes = new Uint8Array(66);
    bytes.set(new TextEncoder().encode("8BPS"));
    const view = new DataView(bytes.buffer);
    view.setUint32(26, 3);
    bytes.set([11, 12, 13], 30);
    view.setUint32(33, 22);
    bytes.set(new TextEncoder().encode("8BIM"), 37);
    view.setUint16(41, 1039);
    bytes.set([4, 65, 66, 67, 68, 0], 43); // Four-byte name + even padding.
    view.setUint32(49, 5);
    bytes.set([14, 15, 16, 17, 18, 0], 53);
    bytes.set([31, 32, 33, 34, 35, 36, 37], 59);
    expect(readPsdImageResource(bytes, 1039)).toEqual(
      new Uint8Array([14, 15, 16, 17, 18]),
    );
    const replaced = new Uint8Array(
      replacePsdImageResource(bytes, 1039, new Uint8Array([19])),
    );
    expect(replaced.subarray(26, 33)).toEqual(bytes.subarray(26, 33));
    expect(replaced.subarray(-7)).toEqual(bytes.subarray(-7));
    expect(readPsdImageResource(replaced, 1039)).toEqual(new Uint8Array([19]));
  });
  it("rejects truncated section, name, and payload lengths instead of reading into layer data", () => {
    const bytes = new Uint8Array(
      replacePsdImageResource(minimalFile(), 1039, new Uint8Array([1, 2, 3])),
    );
    for (const truncated of [
      bytes.slice(0, 26),
      bytes.slice(0, 32),
      bytes.slice(0, 46),
    ])
      expect(() => readPsdImageResource(truncated, 1039)).toThrow("Truncated");
    const name = bytes.slice();
    name[40] = 255;
    expect(() => readPsdImageResource(name, 1039)).toThrow("name");
    const payload = bytes.slice();
    new DataView(payload.buffer).setUint32(42, 0xffffffff);
    expect(() => readPsdImageResource(payload, 1039)).toThrow("data");
  });
  it("round trips profile bytes without stack-sized argument spreads", () => {
    const bytes = Uint8Array.from(
      { length: 256 * 1024 + 1 },
      (_, i) => i % 256,
    );
    expect(decodeIccProfile(encodeIccProfile(bytes))).toEqual(bytes);
  });
});
