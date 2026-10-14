import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, parseDeck, shape, text } from "../src/model.js";

const strip = (effects) => effects.map(({ source, ...rest }) => rest);
const xmlOf = (slide) => P.getSlideXmlString(slide);

function deck() {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const box = shape(slide, 1, 1, 2, 1, "#336699");
  const body = text(slide, "One\nTwo\nThree", 4, 1, 4, 3);
  P.setParagraphLevel(body, 1, 1);
  return { pres, slide, box, body };
}
const id = (s) => String(P.getShapeId(s));
const reload = async (pres) => {
  const restored = await parseDeck(await P.savePresentation(pres));
  return P.getSlides(restored)[0];
};

describe("slide animations", () => {
  it("writes a main sequence that reads back the same", async () => {
    const { pres, slide, box, body } = deck();
    const effects = [
      {
        shapeId: id(box),
        presetClass: "entr",
        presetId: 2,
        presetSubtype: 4,
        start: "click",
        delayMs: 0,
        durationMs: 500,
      },
      {
        shapeId: id(body),
        presetClass: "entr",
        presetId: 10,
        presetSubtype: 0,
        start: "with",
        delayMs: 250,
        durationMs: 750,
      },
      {
        shapeId: id(box),
        presetClass: "emph",
        presetId: 8,
        presetSubtype: 0,
        start: "after",
        delayMs: 0,
        durationMs: 2000,
        amount: 180,
        smoothStart: 0.5,
        smoothEnd: 0.5,
      },
      {
        shapeId: id(box),
        presetClass: "path",
        presetId: 42,
        presetSubtype: 2,
        start: "click",
        delayMs: 0,
        durationMs: 2000,
        path: "M 0 0 L 0.25 0 E",
        repeat: 2,
        autoReverse: true,
      },
      {
        shapeId: id(box),
        presetClass: "exit",
        presetId: 10,
        presetSubtype: 0,
        start: "click",
        delayMs: 0,
        durationMs: 500,
        rewind: true,
      },
    ];
    P.setSlideAnimations(slide, effects);
    const xml = xmlOf(slide);
    expect(xml).toContain('nodeType="mainSeq"');
    expect(xml.match(/nodeType="clickEffect"/g)).toHaveLength(3);
    expect(xml).toContain('nodeType="withEffect"');
    expect(xml).toContain('nodeType="afterEffect"');
    expect(xml).toContain(
      '<p:animMotion origin="layout" path="M 0 0 L 0.25 0 E"',
    );
    expect(xml).toContain('<p:animRot by="10800000">');
    // Time node ids are unique and numbered from 1.
    const ids = [...xml.matchAll(/<p:cTn id="(\d+)"/g)].map((m) => +m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.min(...ids)).toBe(1);
    // The after-previous chain starts when the first time group ends
    // (the fade: 250 ms delay + 750 ms).
    expect(xml).toMatch(/<p:cond delay="1000"\/>/);
    const read = await reload(pres);
    expect(strip(P.getSlideAnimations(read))).toEqual(effects);
  });

  it("builds text by paragraph group and reads the build back", async () => {
    const { pres, slide, body } = deck();
    const effect = {
      shapeId: id(body),
      presetClass: "entr",
      presetId: 22,
      presetSubtype: 4,
      start: "click",
      delayMs: 0,
      durationMs: 500,
      text: { by: "paragraph", level: 1 },
    };
    P.setSlideAnimations(slide, [effect]);
    const xml = xmlOf(slide);
    // "Two" is a second-level paragraph, so it goes with "One".
    expect(xml).toContain('<p:pRg st="0" end="1"/>');
    expect(xml).toContain('<p:pRg st="2" end="2"/>');
    expect(xml).toMatch(/<p:bldP spid="\d+" grpId="0" build="p"\/>/);
    const read = await reload(pres);
    expect(strip(P.getSlideAnimations(read))).toEqual([effect]);
    expect(P.getShapeBuildParagraphs(read, id(body), 2)).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 1 },
      { start: 2, end: 2 },
    ]);
  });

  it("writes all-at-once and background builds", async () => {
    const { pres, slide, body } = deck();
    const effect = {
      shapeId: id(body),
      presetClass: "entr",
      presetId: 10,
      presetSubtype: 0,
      start: "after",
      delayMs: 100,
      durationMs: 500,
      text: { by: "allAtOnce", level: 2, animateBackground: true },
    };
    P.setSlideAnimations(slide, [effect]);
    expect(xmlOf(slide)).toContain("<p:bg/>");
    const read = await reload(pres);
    expect(strip(P.getSlideAnimations(read))).toEqual([effect]);
  });

  it("puts triggered effects in an interactive sequence", async () => {
    const { pres, slide, box, body } = deck();
    const effects = [
      {
        shapeId: id(body),
        presetClass: "emph",
        presetId: 26,
        presetSubtype: 0,
        start: "click",
        delayMs: 0,
        durationMs: 500,
        trigger: id(box),
      },
    ];
    P.setSlideAnimations(slide, effects);
    const xml = xmlOf(slide);
    expect(xml).not.toContain("mainSeq");
    expect(xml).toContain('nodeType="interactiveSeq"');
    expect(xml).toContain(
      `<p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="${id(box)}"/>`,
    );
    const read = await reload(pres);
    expect(strip(P.getSlideAnimations(read))).toEqual(effects);
  });

  it("starts effects with the slide when the first one is not on click", async () => {
    const { slide, box } = deck();
    P.setSlideAnimations(slide, [
      {
        shapeId: id(box),
        presetClass: "entr",
        presetId: 10,
        presetSubtype: 0,
        start: "after",
        delayMs: 0,
        durationMs: 500,
      },
    ]);
    const xml = xmlOf(slide);
    const mainSeq =
      /<p:cTn id="(\d+)" dur="indefinite" nodeType="mainSeq"/.exec(xml)[1];
    expect(xml).toContain(
      `<p:cond evt="onBegin" delay="0"><p:tn val="${mainSeq}"/></p:cond>`,
    );
    expect(P.getSlideAnimations(slide)[0].start).toBe("after");
  });

  it("keeps markup it cannot author while other effects change", async () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const a = shape(slide, 1, 1, 1, 1, "#ff0000");
    const b = shape(slide, 3, 1, 1, 1, "#00ff00");
    const files = unzipSync(await P.savePresentation(pres));
    const name = P.getSlidePartName(slide).slice(1);
    const effect = (cTnId, spid, extra = "") =>
      `<p:par><p:cTn id="${cTnId}" presetID="99" presetClass="entr" presetSubtype="7" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="${cTnId + 1}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set><p:animEffect transition="in" filter="future(7)"><p:cBhvr><p:cTn id="${cTnId + 2}" dur="800"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:animEffect>${extra}</p:childTnLst></p:cTn></p:par>`;
    const click = (inner) =>
      `<p:par><p:cTn id="0" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="0" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${inner}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`;
    const timing = `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${click(effect(10, P.getShapeId(a)))}${click(effect(20, P.getShapeId(b)))}</p:childTnLst></p:cTn><p:prevCondLst/><p:nextCondLst/></p:seq><p:video><p:cMediaNode vol="80000"><p:cTn id="30" fill="hold" display="0"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${P.getShapeId(a)}"/></p:tgtEl></p:cMediaNode></p:video></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
    files[name] = strToU8(
      strFromU8(files[name]).replace("</p:sld>", `${timing}</p:sld>`),
    );
    const loaded = await parseDeck(zipSync(files));
    const s = P.getSlides(loaded)[0];
    const read = P.getSlideAnimations(s);
    expect(read.map((e) => [e.presetId, e.durationMs])).toEqual([
      [99, 800],
      [99, 800],
    ]);
    // Swap the order and slow the second effect down.
    P.setSlideAnimations(s, [{ ...read[1], durationMs: 1600 }, read[0]]);
    const xml = xmlOf(s);
    expect(xml.match(/filter="future\(7\)"/g)).toHaveLength(2);
    expect(xml).toContain('dur="1600"');
    expect(xml).toContain('<p:video><p:cMediaNode vol="80000">');
    expect(xml.indexOf(`spid="${P.getShapeId(b)}"`)).toBeLessThan(
      xml.indexOf(`spid="${P.getShapeId(a)}"`),
    );
  });

  it("drops the animations of removed shapes", () => {
    const { slide, box, body } = deck();
    P.setSlideAnimations(slide, [
      {
        shapeId: id(box),
        presetClass: "entr",
        presetId: 1,
        presetSubtype: 0,
        start: "click",
        delayMs: 0,
        durationMs: 0,
      },
      {
        shapeId: id(body),
        presetClass: "entr",
        presetId: 1,
        presetSubtype: 0,
        start: "click",
        delayMs: 0,
        durationMs: 0,
      },
    ]);
    const gone = id(box);
    P.removeShape(box);
    expect(P.pruneSlideAnimations(slide)).toBe(true);
    expect(xmlOf(slide)).not.toContain(`spid="${gone}"`);
    expect(P.getSlideAnimations(slide)).toHaveLength(1);
    P.setSlideAnimations(slide, []);
    expect(xmlOf(slide)).not.toContain("<p:timing");
  });

  it("places timing before the slide's extension list", () => {
    const { slide, box } = deck();
    P.setSlideAnimations(slide, [
      {
        shapeId: id(box),
        presetClass: "entr",
        presetId: 10,
        presetSubtype: 0,
        start: "click",
        delayMs: 0,
        durationMs: 500,
      },
    ]);
    const xml = xmlOf(slide);
    const timing = xml.indexOf("<p:timing>");
    expect(timing).toBeGreaterThan(xml.indexOf("</p:cSld>"));
    const ext = xml.indexOf("<p:extLst>", timing - 1);
    if (ext >= 0) expect(timing).toBeLessThan(ext);
  });
});
