import { describe, expect, it } from "vitest";
import {
  addBlankSlide,
  addSlideTable,
  createPresentation,
  getSlides,
  getSlideShapes,
  getTableCellSpan,
  getTableCellText,
  getTableCells,
  getTableColumnWidths,
  inches,
  insertTableColumn,
  insertTableRow,
  isTableShape,
  loadPresentation,
  mergeTableCells,
  removeTableColumn,
  removeTableRow,
  savePresentation,
} from "../index.ts";
import type { SlideShapeData } from "../index.ts";

// Header merged across all three columns; "a" merged down two rows.
const fixture = () => {
  const pres = createPresentation();
  const slide = addBlankSlide(pres);
  const table = addSlideTable(slide, {
    x: inches(0),
    y: inches(0),
    w: inches(6),
    h: inches(1.2),
    rows: [
      ["Title", "", ""],
      ["a", "b", "c"],
      ["d", "e", "f"],
    ],
  });
  mergeTableCells(table, { row: 0, col: 0, rowSpan: 1, colSpan: 3 });
  mergeTableCells(table, { row: 1, col: 0, rowSpan: 2, colSpan: 1 });
  return { pres, table };
};

const dump = (table: SlideShapeData): string[] =>
  getTableCells(table).map((row) =>
    row
      .map((cell) => {
        const s = getTableCellSpan(cell);
        return (
          (getTableCellText(cell) || "·") +
          (s.gridSpan > 1 ? `[gs${s.gridSpan}]` : "") +
          (s.rowSpan > 1 ? `[rs${s.rowSpan}]` : "") +
          (s.hMerge ? "[h]" : "") +
          (s.vMerge ? "[v]" : "")
        );
      })
      .join(" | "),
  );

describe("table rows/columns and merged cells", () => {
  it("moves a merge's anchor when its column is removed", async () => {
    const { pres, table } = fixture();
    removeTableColumn(table, 0);
    expect(dump(table)).toEqual(["Title[gs2] | ·[h]", "b | c", "e | f"]);
    const back = await loadPresentation(await savePresentation(pres));
    const reread = getSlideShapes(getSlides(back)[0]!).find(isTableShape)!;
    expect(dump(reread)).toEqual(dump(table));
  });

  it("shrinks a merge when a covered column is removed", () => {
    const { table } = fixture();
    removeTableColumn(table, 2);
    expect(dump(table)[0]).toBe("Title[gs2] | ·[h]");
  });

  it("moves a merge's anchor when its row is removed", () => {
    const { table } = fixture();
    removeTableRow(table, 1);
    expect(dump(table)).toEqual(["Title[gs3] | ·[h] | ·[h]", "a | e | f"]);
  });

  it("grows a merge when a row is inserted inside it", () => {
    const { table } = fixture();
    insertTableRow(table, 2);
    expect(dump(table)).toEqual([
      "Title[gs3] | ·[h] | ·[h]",
      "a[rs3] | b | c",
      "·[v] | · | ·",
      "d[v] | e | f",
    ]);
    insertTableRow(table, 4);
    expect(dump(table)[4]).toBe("· | · | ·");
  });

  it("grows a merge when a column is inserted inside it", () => {
    const { table } = fixture();
    insertTableColumn(table, 1);
    expect(getTableColumnWidths(table)).toHaveLength(4);
    expect(dump(table)).toEqual([
      "Title[gs4] | ·[h] | ·[h] | ·[h]",
      "a[rs2] | · | b | c",
      "d[v] | · | e | f",
    ]);
    insertTableColumn(table, 0);
    expect(dump(table)[0]).toBe("· | Title[gs4] | ·[h] | ·[h] | ·[h]");
  });

  it("keeps a 2x2 block consistent", () => {
    const pres = createPresentation();
    const table = addSlideTable(addBlankSlide(pres), {
      x: inches(0),
      y: inches(0),
      w: inches(3),
      h: inches(1.2),
      rows: [
        ["X", "", "c"],
        ["", "", "f"],
        ["g", "h", "i"],
      ],
    });
    mergeTableCells(table, { row: 0, col: 0, rowSpan: 2, colSpan: 2 });
    removeTableColumn(table, 0);
    expect(dump(table)).toEqual(["X[rs2] | c", "·[v] | f", "h | i"]);
    removeTableRow(table, 0);
    expect(dump(table)).toEqual(["X | f", "h | i"]);
  });
});
