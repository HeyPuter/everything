import { describe, expect, it } from "vitest";
import {
  addBlankSlide,
  addSlideTable,
  createPresentation,
  editTableCellText,
  getTableCell,
  getTableCellParagraphs,
  getSlides,
  getSlideShapes,
  getTableCellSpan,
  getTableCellFill,
  getTableCellText,
  getTableCells,
  getTableColumnWidths,
  getTableRowHeights,
  inches,
  insertTableColumn,
  insertTableRow,
  isTableShape,
  loadPresentation,
  mergeTableCells,
  removeTableColumn,
  removeTableRow,
  savePresentation,
  setTableCellFill,
  setTableCellTextFormat,
  setTableRowHeight,
} from "../index.ts";
import type { SlideShapeData } from "../index.ts";
import { CELL_ELEMENT } from "../_internal-symbols.ts";
import { NS, parseXml } from "../../internal/xml/index.ts";

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

describe("rows and columns inserted like a neighbour", () => {
  // A dark header row of bold white 12 pt text over light 11 pt rows, as a
  // deck formats a table by hand.
  const styled = () => {
    const pres = createPresentation();
    const table = addSlideTable(addBlankSlide(pres), {
      x: inches(0),
      y: inches(0),
      w: inches(6),
      h: inches(1.2),
      rows: [
        ["H1", "H2", "H3"],
        ["a", "b", "c"],
        ["d", "e", "f"],
      ],
    });
    getTableCells(table).forEach((row, r) =>
      row.forEach((cell) => {
        setTableCellFill(cell, r ? "DDEBF7" : "1F4E79");
        setTableCellTextFormat(
          cell,
          r
            ? { size: 11, color: "1F4E79" }
            : { size: 12, bold: true, color: "FFFFFF" },
        );
      }),
    );
    setTableRowHeight(table, 2, inches(0.6));
    return { pres, table };
  };
  const look = (table: SlideShapeData, row: number, col: number) => {
    const cell = getTableCell(table, row, col);
    const run = getTableCellParagraphs(cell)[0]!.elements[0]!;
    const format = "format" in run ? run.format : undefined;
    return {
      fill: getTableCellFill(cell),
      size: format?.size,
      bold: !!format?.bold,
      color: format?.color,
    };
  };

  it("gives a row the look and height of the row it is inserted beside", async () => {
    const { pres, table } = styled();
    insertTableRow(table, 3, ["x"], { like: 2 });
    expect(getTableCellText(getTableCell(table, 3, 0))).toBe("x");
    for (let c = 0; c < 3; c++)
      expect(look(table, 3, c)).toEqual({
        fill: "#DDEBF7",
        size: 11,
        bold: false,
        color: "#1F4E79",
      });
    insertTableRow(table, 0, [], { like: 0 });
    expect(look(table, 0, 1)).toEqual(look(table, 1, 1));
    expect(getTableCellText(getTableCell(table, 0, 1))).toBe("");
    const back = await loadPresentation(await savePresentation(pres));
    const reread = getSlideShapes(getSlides(back)[0]!).find(isTableShape)!;
    expect(look(reread, 4, 2)).toEqual(look(table, 4, 2));
    expect(getTableRowHeights(reread)[4]).toBe(inches(0.6));
    // Text typed into a new, empty cell takes the row's look too.
    editTableCellText(
      getTableCell(table, 0, 1),
      [{ start: 0, end: 0, text: "typed" }],
      "typed",
    );
    expect(look(table, 0, 1)).toEqual(look(table, 1, 1));
  });

  it("gives a column the look of the column it is inserted beside, row by row", () => {
    const { table } = styled();
    insertTableColumn(table, 3, undefined, { like: 2 });
    expect(look(table, 0, 3)).toEqual(look(table, 0, 2));
    expect(look(table, 1, 3)).toEqual(look(table, 1, 2));
    expect(getTableCellText(getTableCell(table, 1, 3))).toBe("");
  });

  it("takes a covered cell's look from its merge, and stays plain without `like`", () => {
    const { table } = styled();
    mergeTableCells(table, { row: 1, col: 0, rowSpan: 2, colSpan: 1 });
    insertTableRow(table, 3, [], { like: 2 });
    expect(look(table, 3, 0)).toEqual(look(table, 1, 0));
    insertTableRow(table, 4);
    expect(look(table, 4, 0).fill).toBeNull();
  });
});

describe("editTableCellText", () => {
  // "Revenue: " plain and "$5M" bold, then a centered italic paragraph.
  const richCell = () => {
    const pres = createPresentation();
    const table = addSlideTable(addBlankSlide(pres), {
      x: inches(0),
      y: inches(0),
      w: inches(4),
      h: inches(1),
      rows: [["", "b"]],
    });
    const cell = getTableCell(table, 0, 0);
    const tc = cell[CELL_ELEMENT];
    const body = parseXml(
      `<a:txBody xmlns:a="${NS.dml}"><a:bodyPr/><a:lstStyle/>` +
        `<a:p><a:r><a:rPr lang="en-US"/><a:t>Revenue: </a:t></a:r>` +
        `<a:r><a:rPr lang="en-US" b="1"/><a:t>$5M</a:t></a:r></a:p>` +
        `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" i="1"/><a:t>up 10%</a:t></a:r></a:p>` +
        `</a:txBody>`,
    ).root;
    const at = tc.children.findIndex(
      (c) => c.kind === "element" && c.name.localName === "txBody",
    );
    tc.children[at] = body;
    return { pres, cell };
  };
  const shape = (cell: ReturnType<typeof getTableCell>) =>
    getTableCellParagraphs(cell).map((p) => ({
      align: p.align,
      runs: p.elements.map((e) => [
        e.kind === "br" ? "\n" : e.text,
        !!e.format?.bold,
        !!e.format?.italic,
      ]),
    }));

  it("changes only the edited text, keeping the cell's other formatting", async () => {
    const { pres, cell } = richCell();
    editTableCellText(
      cell,
      [
        { start: 19, end: 19, text: "!" },
        { start: 11, end: 11, text: "0" },
      ],
      "Revenue: $50M\nup 10%!",
    );
    expect(getTableCellText(cell)).toBe("Revenue: $50M\nup 10%!");
    const expected = [
      {
        align: null,
        runs: [
          ["Revenue: ", false, false],
          ["$5", true, false],
          ["0", true, false],
          ["M", true, false],
        ],
      },
      {
        align: "center",
        runs: [
          ["up 10%", false, true],
          ["!", false, true],
        ],
      },
    ];
    expect(shape(cell)).toEqual(expected);
    const back = await loadPresentation(await savePresentation(pres));
    const table = getSlideShapes(getSlides(back)[0]!).find(isTableShape)!;
    expect(shape(getTableCell(table, 0, 0))).toEqual(expected);
  });

  it("throws and leaves the cell alone when the edits do not end at the text", () => {
    const { cell } = richCell();
    const before = shape(cell);
    expect(() =>
      editTableCellText(cell, [{ start: 0, end: 0, text: "x" }], "nope"),
    ).toThrow();
    expect(shape(cell)).toEqual(before);
  });
});
