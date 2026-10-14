import { describe, it, expect } from "vitest";
import {
  loadViewSettings,
  saveViewSettings,
  viewFromFile,
} from "../src/views/view-settings.js";
import { parsePercent } from "../src/views/zoom-dialog.js";
import {
  toGrid,
  drawnSpacing,
  defaultGuides,
  formatLength,
} from "../src/views/grid-guides.js";

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

describe("view settings", () => {
  it("keeps settings per presentation and forgets the oldest", () => {
    const storage = memoryStorage();
    saveViewSettings("a", { view: "sorter" }, storage, 1);
    saveViewSettings("a", { sorterZoom: 1.5 }, storage, 2);
    saveViewSettings("b", { view: "outline" }, storage, 3);
    expect(loadViewSettings("a", storage)).toMatchObject({
      view: "sorter",
      sorterZoom: 1.5,
    });
    expect(loadViewSettings("b", storage).view).toBe("outline");
    expect(loadViewSettings("missing", storage)).toEqual({});
    for (let i = 0; i < 60; i++)
      saveViewSettings(`k${i}`, { view: "normal" }, storage, 10 + i);
    expect(loadViewSettings("a", storage)).toEqual({});
    expect(loadViewSettings("k59", storage).view).toBe("normal");
  });

  it("survives damaged storage", () => {
    const storage = memoryStorage();
    storage.setItem("presentation:views", "{not json");
    expect(loadViewSettings("a", storage)).toEqual({});
    saveViewSettings("a", { view: "sorter" }, storage);
    expect(loadViewSettings("a", storage).view).toBe("sorter");
  });

  it("maps a file's last view to an editor view", () => {
    expect(viewFromFile("sldSorterView")).toBe("sorter");
    expect(viewFromFile("outlineView")).toBe("outline");
    expect(viewFromFile("notesView")).toBe("notesPage");
    expect(viewFromFile("sldView")).toBe(null);
    expect(viewFromFile(null)).toBe(null);
  });
});

describe("zoom and grid helpers", () => {
  it("reads a percentage within the allowed range", () => {
    expect(parsePercent("150")).toBe(1.5);
    expect(parsePercent("75 %")).toBe(0.75);
    expect(parsePercent("9000")).toBe(4);
    expect(parsePercent("2", { min: 33, max: 300 })).toBe(0.33);
    expect(parsePercent("abc")).toBe(null);
    expect(parsePercent("0")).toBe(null);
  });

  it("snaps to the grid and draws lines far enough apart", () => {
    const inch = 914400;
    expect(toGrid(inch * 3.3, inch / 4)).toBe(inch * 3.25);
    expect(drawnSpacing(inch / 12, 96 / inch)).toBe(inch / 12);
    // At a small zoom, lines a twelfth of an inch apart would merge.
    expect(drawnSpacing(inch / 12, 24 / inch)).toBe(inch / 3);
    expect(defaultGuides({ cx: 12192000, cy: 6858000 })).toEqual([
      { orient: "horz", pos: 3429000 },
      { orient: "vert", pos: 6096000 },
    ]);
    expect(formatLength(inch * 2.5, false)).toBe("2.50″");
    expect(formatLength(360000 * 1.25, true)).toBe("1.25 cm");
  });
});
