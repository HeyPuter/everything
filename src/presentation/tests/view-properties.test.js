import { describe, it, expect } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P } from "../src/model.js";

const save = async (pres) => P.savePresentation(pres);
const reload = async (pres) => P.loadPresentation(await save(pres));
const viewXml = async (pres) =>
  strFromU8(unzipSync(await save(pres))["ppt/viewProps.xml"]);

describe("view properties", () => {
  it("reads defaults from a new deck", () => {
    const pres = P.createPresentation();
    expect(P.getViewProperties(pres)).toEqual({
      lastView: null,
      snapToGrid: null,
      snapToObjects: false,
      showGuides: false,
      guides: [],
      gridSpacing: null,
    });
    expect(P.getNotesPageSize(pres)).toEqual({
      width: 6858000,
      height: 9144000,
    });
  });

  it("writes guides, grid and snapping that survive a save", async () => {
    const pres = P.createPresentation();
    P.setViewProperties(pres, {
      lastView: "sldSorterView",
      snapToGrid: false,
      showGuides: true,
      guides: [
        { orient: "horz", pos: 3429000 },
        { orient: "vert", pos: 6096000 },
      ],
      gridSpacing: { cx: 76200, cy: 76200 },
    });
    const xml = await viewXml(pres);
    expect(xml).toContain('lastView="sldSorterView"');
    expect(xml).toMatch(
      /<p:slideViewPr><p:cSldViewPr snapToGrid="0" showGuides="1"><p:cViewPr varScale="1">.*<\/p:cViewPr><p:guideLst><p:guide orient="horz" pos="2160"\/><p:guide orient="vert" pos="3840"\/><\/p:guideLst><\/p:cSldViewPr><\/p:slideViewPr><p:gridSpacing cx="76200" cy="76200"\/>/,
    );
    const back = await reload(pres);
    expect(P.getViewProperties(back)).toEqual({
      lastView: "sldSorterView",
      snapToGrid: false,
      snapToObjects: false,
      showGuides: true,
      guides: [
        { orient: "horz", pos: 3429000 },
        { orient: "vert", pos: 6096000 },
      ],
      gridSpacing: { cx: 76200, cy: 76200 },
    });
    P.setViewProperties(back, { guides: [], snapToGrid: true });
    const cleared = P.getViewProperties(await reload(back));
    expect(cleared.guides).toEqual([]);
    expect(cleared.snapToGrid).toBe(true);
  });

  it("keeps the rest of an existing part and creates a missing one", async () => {
    const pres = P.createPresentation();
    const files = unzipSync(await save(pres));
    files["ppt/viewProps.xml"] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:notesTextViewPr><p:cViewPr><p:scale><a:sx n="1" d="1"/><a:sy n="1" d="1"/></p:scale><p:origin x="0" y="0"/></p:cViewPr></p:notesTextViewPr><p:gridSpacing cx="38100" cy="38100"/></p:viewPr>',
    );
    const edited = await P.loadPresentation(zipSync(files));
    expect(P.getViewProperties(edited).gridSpacing).toEqual({
      cx: 38100,
      cy: 38100,
    });
    P.setViewProperties(edited, { guides: [{ orient: "vert", pos: 914400 }] });
    const xml = await viewXml(edited);
    expect(xml).toMatch(
      /<p:normalViewPr>.*<\/p:normalViewPr><p:slideViewPr>.*<\/p:slideViewPr><p:notesTextViewPr>.*<\/p:notesTextViewPr><p:gridSpacing/,
    );

    // A deck without the part gets one, with its relationship.
    delete files["ppt/viewProps.xml"];
    const rels = strFromU8(files["ppt/_rels/presentation.xml.rels"]).replace(
      /<Relationship [^>]*viewProps[^>]*\/>/,
      "",
    );
    files["ppt/_rels/presentation.xml.rels"] = strToU8(rels);
    files["[Content_Types].xml"] = strToU8(
      strFromU8(files["[Content_Types].xml"]).replace(
        /<Override [^>]*viewProps[^>]*\/>/,
        "",
      ),
    );
    const bare = await P.loadPresentation(zipSync(files));
    expect(P.getViewProperties(bare).guides).toEqual([]);
    P.setViewProperties(bare, { snapToGrid: false });
    const out = unzipSync(await save(bare));
    expect(strFromU8(out["ppt/_rels/presentation.xml.rels"])).toContain(
      'Target="viewProps.xml"',
    );
    expect(strFromU8(out["[Content_Types].xml"])).toContain(
      "presentationml.viewProps+xml",
    );
    expect(P.getViewProperties(await reload(bare)).snapToGrid).toBe(false);
  });
});
