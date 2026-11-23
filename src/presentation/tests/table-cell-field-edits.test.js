// A table cell whose date field shows another day than the one it saved
// keeps its bold words and equations through an edit: the edits are counted
// in the cell's saved text rather than replacing the text as a whole.
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  P,
  createDeck,
  parseDeck,
  displayTableCellText,
  storedTableCellEdits,
} from "../src/model.js";

const SLIDE = "ppt/slides/slide1.xml";
const equation = `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14"><a14:m><m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:oMath><m:r><m:t>πr²</m:t></m:r></m:oMath></m:oMathPara></a14:m></mc:Choice><mc:Fallback><a:r><a:rPr lang="en-US"/><a:t>πr²</a:t></a:r></mc:Fallback></mc:AlternateContent>`;

async function cellWithDate() {
  const blank = createDeck("blank");
  P.addSlideTable(P.getSlides(blank)[0], {
    x: 0,
    y: 0,
    w: 6000000,
    h: 1000000,
    rows: [["MARK", "b"]],
  });
  const entries = unzipSync(await P.savePresentation(blank));
  const xml = strFromU8(entries[SLIDE]).replace(
    /<a:r>(?:<a:rPr[^>]*\/>|<a:rPr[^>]*>.*?<\/a:rPr>)<a:t>MARK<\/a:t><\/a:r>/,
    `<a:r><a:rPr lang="en-US"/><a:t>Area </a:t></a:r><a:r><a:rPr lang="en-US" b="1"/><a:t>bold</a:t></a:r>${equation}<a:r><a:rPr lang="en-US"/><a:t> on </a:t></a:r><a:fld id="{11111111-2222-3333-4444-555555555555}" type="datetime1"><a:rPr lang="en-US"/><a:t>1/1/2020</a:t></a:fld><a:r><a:rPr lang="en-US"/><a:t> end</a:t></a:r>`,
  );
  entries[SLIDE] = strToU8(xml);
  const pres = await parseDeck(zipSync(entries));
  const table = P.getSlideShapes(P.getSlides(pres)[0]).find(P.isTableShape);
  return { pres, table, cell: P.getTableCell(table, 0, 0) };
}
const savedCell = async (pres) =>
  strFromU8(unzipSync(await P.savePresentation(pres))[SLIDE]).match(
    /<a:tc>.*?<\/a:tc>/,
  )[0];

describe("table cell edits around a date field", () => {
  it("keep the cell's formatting and equation", async () => {
    const { pres, cell } = await cellWithDate();
    const shown = displayTableCellText(pres, cell);
    expect(shown).not.toContain("1/1/2020");
    // Typed at the end, after the field, and at the start.
    const after = shown + "!";
    const edits = [
      { start: shown.length, end: shown.length, text: "!" },
      { start: 0, end: 0, text: "The " },
    ];
    const stored = storedTableCellEdits(pres, cell, edits, "The " + after);
    expect(stored.text).toBe("The Area bold on 1/1/2020 end!");
    P.editTableCellText(cell, stored.edits, stored.text);
    const xml = await savedCell(pres);
    expect(xml).toContain('b="1"/><a:t>bold</a:t>');
    expect(xml).toContain("<a14:m>");
    expect(xml).toContain("<a:t>1/1/2020</a:t></a:fld>");
    expect(
      xml.replace(/<\/a:t><\/a:r><a:r><a:rPr lang="en-US"\/><a:t>/g, ""),
    ).toContain("<a:t>The Area </a:t>");
  });

  it("leave an edit inside the field to a whole-text replace", async () => {
    const { pres, cell } = await cellWithDate();
    const shown = displayTableCellText(pres, cell);
    const at = shown.indexOf(" end") - 1;
    expect(
      storedTableCellEdits(
        pres,
        cell,
        [{ start: at, end: at + 1, text: "X" }],
        shown.slice(0, at) + "X" + shown.slice(at + 1),
      ),
    ).toBe(null);
  });
});
