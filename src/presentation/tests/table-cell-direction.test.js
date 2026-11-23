import { describe, expect, it } from "vitest";
import { P, createDeck } from "../src/model.js";
import {
  getTableLayout,
  renderSlideToSvg,
} from "../lib/pptx-preview/src/index.ts";

// 12 px per character at 24 px (18 pt); 0.8 / 0.2 em ascent and descent.
const measureText = (text, f) => ({
  widthPx: ([...text].length * f.sizePx) / 2,
  ascentPx: f.sizePx * 0.8,
  descentPx: f.sizePx * 0.2,
  lineGapPx: 0,
});
const options = {
  textLayout: "svg",
  measureText,
  resolveFontFamily: () => "Arial",
};

function deck(direction) {
  const pres = createDeck("blank"),
    slide = P.getSlides(pres)[0];
  const table = P.addSlideTable(slide, {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(4),
    h: P.inches(0.8),
    rows: [
      ["Header label", "Peer"],
      ["a", "b"],
    ],
  });
  for (const row of P.getTableCells(table))
    for (const cell of row) P.setTableCellTextFormat(cell, { size: 18 });
  if (direction)
    P.setTableCellTextDirection(P.getTableCells(table)[0][0], direction);
  return { pres, slide, table };
}

describe("a table cell's text direction", () => {
  it("turns the cell's text and keeps the others level", () => {
    const { pres, slide } = deck("vert270");
    const svg = renderSlideToSvg(pres, slide, options);
    const turned = svg.match(/<g transform="rotate\(270 [^)]+\)">(.*?)<\/g>/);
    expect(turned?.[1]).toContain("Header label");
    expect(turned?.[1]).not.toContain("Peer");
  });
  it("grows the row to hold the turned text on one line", () => {
    const { pres, table } = deck("vert270");
    const level = deck(null);
    const [turnedRow] = getTableLayout(pres, table, options).rowHeights;
    const [levelRow] = getTableLayout(
      level.pres,
      level.table,
      options,
    ).rowHeights;
    // "Header label" is 144 px long; the cell's left and right insets add
    // 0.1 inch each.
    expect(turnedRow).toBeCloseTo((144 + 19.2) * 9525, -2);
    expect(turnedRow).toBeGreaterThan(levelRow);
  });
});
