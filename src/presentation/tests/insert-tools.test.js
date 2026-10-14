// Pure helpers behind the Insert features: SVG path normalising (Convert to
// Shape), photo album and zoom layouts, media types, WAV encoding and the
// icon catalogue.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { normalizePath } from "../src/insert/svg-tools.js";
import { albumBoxes, containBox, zoomGrid } from "../src/insert/geometry.js";
import { mediaType } from "../src/insert/media-types.js";
import {
  encodeWav,
  formatTime,
  parseTime,
  synthesizeSound,
} from "../src/insert/audio-data.js";
import { ICON_CATEGORIES, iconWords } from "../src/insert/icon-catalog.js";

describe("SVG paths", () => {
  it("turns relative, shorthand and arc commands into absolute lines and curves", () => {
    const out = normalizePath("M2 2h4v4H2zm10 0l2 2a2 2 0 0 1 2 2q2 0 2 2t2 2");
    expect(out[0]).toEqual({ type: "moveTo", x: 2, y: 2 });
    expect(out.slice(1, 4)).toEqual([
      { type: "lineTo", x: 6, y: 2 },
      { type: "lineTo", x: 6, y: 6 },
      { type: "lineTo", x: 2, y: 6 },
    ]);
    expect(out[4]).toEqual({ type: "close" });
    // After a close, a relative move starts from the subpath's start.
    expect(out[5]).toEqual({ type: "moveTo", x: 12, y: 2 });
    expect(
      out.every((c) =>
        ["moveTo", "lineTo", "cubicTo", "close"].includes(c.type),
      ),
    ).toBe(true);
    const last = out.at(-1);
    expect(last.x).toBeCloseTo(20);
    expect(last.y).toBeCloseTo(10);
  });

  it("ends an arc exactly at its end point", () => {
    const out = normalizePath("M0 10A10 10 0 0 1 20 10");
    const end = out.at(-1);
    expect(end.type).toBe("cubicTo");
    expect(end.x).toBeCloseTo(20);
    expect(end.y).toBeCloseTo(10);
  });
});

describe("layouts", () => {
  const size = { cx: 12192000, cy: 6858000 };
  it("puts album pictures in cells inside the slide", () => {
    for (const [layout, n] of [
      ["1", 1],
      ["2", 2],
      ["4", 4],
      ["4t", 4],
      ["2t", 2],
    ]) {
      const boxes = albumBoxes(layout, n, size, true);
      expect(boxes).toHaveLength(n);
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y + b.h).toBeLessThanOrEqual(size.cy);
        expect(b.x + b.w).toBeLessThanOrEqual(size.cx);
      }
    }
    expect(albumBoxes("fit", 1, size, false)[0]).toEqual({
      x: 0,
      y: 0,
      w: size.cx,
      h: size.cy,
    });
    const fit = containBox({ x: 0, y: 0, w: 100, h: 100 }, 400, 200);
    expect(fit).toEqual({ x: 0, y: 25, w: 100, h: 50 });
  });

  it("lays zooms out in a grid of slide-shaped boxes", () => {
    const area = { x: 0, y: 0, w: 1600, h: 900 };
    const boxes = zoomGrid(5, area, 16 / 9);
    expect(boxes).toHaveLength(5);
    for (const b of boxes) {
      expect(b.w / b.h).toBeCloseTo(16 / 9, 1);
      expect(b.x + b.w).toBeLessThanOrEqual(1600);
      expect(b.y + b.h).toBeLessThanOrEqual(900);
    }
  });
});

describe("media", () => {
  it("knows video and audio by extension or type", () => {
    expect(mediaType({ name: "a.MP4", type: "" })).toMatchObject({
      kind: "video",
      contentType: "video/mp4",
    });
    expect(mediaType({ name: "a.mov", type: "" })).toMatchObject({
      kind: "video",
      contentType: "video/quicktime",
    });
    expect(mediaType({ name: "a.m4a", type: "" })).toMatchObject({
      kind: "audio",
      contentType: "audio/mp4",
    });
    expect(mediaType({ name: "noext", type: "audio/ogg" })).toMatchObject({
      kind: "audio",
    });
    expect(mediaType({ name: "a.txt", type: "text/plain" })).toBeNull();
  });

  it("encodes WAV and makes the built-in sounds", () => {
    const wav = encodeWav([new Float32Array([0, 1, -1])], 8000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
    const chime = synthesizeSound("Chime");
    expect(chime.byteLength).toBeGreaterThan(1000);
  });

  it("formats and reads times", () => {
    expect(formatTime(61500)).toBe("01:01.50");
    expect(parseTime("01:01.50")).toBe(61500);
    expect(parseTime("2.25")).toBe(2250);
    expect(parseTime("x")).toBeNull();
  });
});

describe("icon catalogue", () => {
  it("names icons the installed set has, and splits names into words", () => {
    // The names the package exports, read without loading every drawing.
    const source = readFileSync(
      new URL("../node_modules/lucide/dist/esm/lucide.mjs", import.meta.url),
      "utf8",
    );
    const names = new Set(
      [...source.matchAll(/as (\w+) \}/g)].map((m) => m[1]),
    );
    for (const [, list] of ICON_CATEGORIES) {
      const found = list.split(/\s+/).filter((n) => names.has(n));
      expect(found.length).toBeGreaterThan(10);
    }
    expect(iconWords("ArrowUpRight")).toBe("arrow up right");
    expect(iconWords("Grid3x3")).toBe("grid 3x3");
  });
});
