// Inserted objects survive a save and reload as real OOXML: vector pictures
// with a raster stand-in, video and audio with their playback options,
// action settings, embedded files and the slide footer.
import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { P } from "../src/model.js";
import {
  readCfb,
  readOlePackage,
  writeCfb,
  writeOlePackage,
} from "../lib/pptx/src/internal/opc/cfb.ts";
import { objectIconSvg } from "../src/insert/object.js";

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20z"/></svg>',
);
const box = { x: P.inches(1), y: P.inches(1), w: P.inches(2), h: P.inches(2) };

async function reload(pres) {
  const bytes = await P.savePresentation(pres);
  return { pres: await P.loadPresentation(bytes), files: unzipSync(bytes) };
}
const slideXml = (files, n = 1) => strFromU8(files[`ppt/slides/slide${n}.xml`]);

describe("vector pictures", () => {
  it("keep the SVG as the preferred source and a PNG stand-in", async () => {
    const pres = P.createPresentation();
    const slide = P.addBlankSlide(pres);
    const shape = P.addSlideVectorPicture(slide, { png: PNG, svg: SVG }, box);
    P.setShapeObjectData(shape, { type: "icon", name: "triangle" });
    const { pres: back, files } = await reload(pres);
    const xml = slideXml(files);
    expect(xml).toMatch(
      /<a:blip r:embed="rId\d+"><a:extLst><a:ext uri="\{96DAC541/,
    );
    expect(xml).toContain("asvg:svgBlip");
    const pic = P.getSlideShapes(P.getSlides(back)[0])[0];
    expect(new TextDecoder().decode(P.getShapeSvgSource(pic))).toContain(
      "M2 2h20v20z",
    );
    expect(P.getShapeObjectData(pic)).toEqual({
      type: "icon",
      name: "triangle",
    });
    // Recolouring replaces both images.
    const recolored = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#ff0000" d="M0 0h1v1z"/></svg>',
    );
    P.setShapeVectorPicture(pic, { png: PNG, svg: recolored });
    expect(new TextDecoder().decode(P.getShapeSvgSource(pic))).toContain(
      "#ff0000",
    );
  });

  it("keeps object data after a click action is added", async () => {
    const pres = P.createPresentation();
    const slide = P.addBlankSlide(pres);
    const other = P.addBlankSlide(pres);
    const shape = P.addSlideVectorPicture(slide, { png: PNG }, box);
    P.setShapeObjectData(shape, { type: "zoom", kind: "slide" });
    P.setShapeClickAction(shape, { kind: "slide", slide: other });
    const { files } = await reload(pres);
    const xml = slideXml(files);
    // The click action precedes the extension list in cNvPr.
    expect(xml.indexOf("a:hlinkClick")).toBeLessThan(xml.indexOf("a:extLst"));
  });
});

describe("media", () => {
  it("stores video as a linked and embedded media part with options", async () => {
    const pres = P.createPresentation();
    const slide = P.addBlankSlide(pres);
    const video = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 1, 2]);
    const shape = P.addSlideMedia(
      slide,
      { kind: "video", data: video, contentType: "video/mp4", poster: PNG },
      box,
      {
        trimStart: 1500,
        trimEnd: 2000,
        fadeIn: 500,
        volume: 0.5,
        loop: true,
        start: "automatically",
        fullScreen: true,
        hideWhileNotPlaying: true,
        bookmarks: [{ name: "Chorus", time: 4200 }],
        durationMs: 10000,
      },
    );
    expect(P.getShapeMediaKind(shape)).toBe("video");
    const { pres: back, files } = await reload(pres);
    const xml = slideXml(files);
    expect(xml).toMatch(/<a:videoFile r:link="rId\d+"\/>/);
    expect(xml).toContain('<p14:trim st="1500" end="2000"/>');
    expect(xml).toContain('presetClass="mediacall"');
    expect(xml).toContain('fullScrn="1"');
    expect(strFromU8(files["[Content_Types].xml"])).toContain("video/mp4");
    const rels = strFromU8(files["ppt/slides/_rels/slide1.xml.rels"]);
    expect(rels).toContain("relationships/video");
    expect(rels).toContain("2007/relationships/media");
    const pic = P.getSlideShapes(P.getSlides(back)[0])[0];
    const media = P.getShapeMedia(pic);
    expect(media.kind).toBe("video");
    expect([...media.data]).toEqual([...video]);
    expect(media.options).toMatchObject({
      trimStart: 1500,
      trimEnd: 2000,
      fadeIn: 500,
      volume: 0.5,
      loop: true,
      start: "automatically",
      fullScreen: true,
      hideWhileNotPlaying: true,
      bookmarks: [{ name: "Chorus", time: 4200 }],
    });
  });

  it("rewrites the timing when the start changes, leaving one effect", async () => {
    const pres = P.createPresentation();
    const slide = P.addBlankSlide(pres);
    const shape = P.addSlideMedia(
      slide,
      {
        kind: "audio",
        data: new Uint8Array(8),
        contentType: "audio/wav",
        poster: PNG,
      },
      box,
    );
    expect(P.getShapeMedia(shape).options.start).toBe("inClickSequence");
    P.setShapeMediaOptions(shape, {
      ...P.getShapeMedia(shape).options,
      start: "whenClicked",
      playAcrossSlides: true,
    });
    P.setShapeMediaOptions(shape, {
      ...P.getShapeMedia(shape).options,
      start: "inClickSequence",
    });
    const xml = P.getSlideXmlString(slide);
    expect(xml.match(/presetClass="mediacall"/g)).toHaveLength(1);
    expect(xml).not.toContain("interactiveSeq");
    expect(xml).toContain('numSld="999"');
    expect(P.getShapeMedia(shape).options.playAcrossSlides).toBe(true);
    const ids = [...xml.matchAll(/<p:cTn id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("action settings", () => {
  it("round-trips click and hover actions with sounds", async () => {
    const pres = P.createPresentation();
    const slide = P.addBlankSlide(pres);
    const target = P.addBlankSlide(pres);
    const shape = P.addSlideShape(slide, {
      preset: "actionButtonHome",
      ...box,
    });
    P.setShapeActionSettings(shape, {
      click: {
        jump: { kind: "slide", slide: target },
        sound: { name: "Chime", data: new Uint8Array([82, 73, 70, 70]) },
        highlight: true,
      },
      hover: { jump: { kind: "endShow" }, sound: "stop", highlight: false },
    });
    const { pres: back, files } = await reload(pres);
    const xml = slideXml(files);
    expect(xml).toContain('action="ppaction://hlinksldjump"');
    expect(xml).toContain('highlightClick="1"');
    expect(xml).toContain(
      '<a:hlinkHover r:id="" action="ppaction://hlinkshowjump?jump=endshow" endSnd="1"/>',
    );
    const s = P.getSlideShapes(P.getSlides(back)[0])[0];
    const settings = P.getShapeActionSettings(s);
    expect(settings.click.jump.kind).toBe("slide");
    expect(P.getSlidePartName(settings.click.jump.slide)).toBe(
      P.getSlidePartName(P.getSlides(back)[1]),
    );
    expect(settings.click.sound.name).toBe("Chime");
    expect(settings.click.highlight).toBe(true);
    expect(settings.hover).toMatchObject({
      jump: { kind: "endShow" },
      sound: "stop",
    });
    P.setShapeActionSettings(s, { click: null, hover: null });
    expect(P.getSlideXmlString(P.getSlides(back)[0])).not.toContain("hlink");
  });
});

describe("compound files and embedded objects", () => {
  it("writes streams a reader gets back, small and large", () => {
    const big = new Uint8Array(9000).map((_, i) => i % 251);
    const streams = readCfb(
      writeCfb([
        { name: "Small", data: new Uint8Array([1, 2, 3]) },
        { name: "Big", data: big },
        { name: "Empty", data: new Uint8Array(0) },
      ]),
    );
    const byName = Object.fromEntries(streams.map((s) => [s.name, s.data]));
    expect([...byName.Small]).toEqual([1, 2, 3]);
    expect(byName.Big).toEqual(big);
    expect(byName.Empty.length).toBe(0);
  });

  it("packages a file and reads it back from the slide", async () => {
    const data = new TextEncoder().encode("hello, résumé");
    const pkg = readOlePackage(writeOlePackage("notes résumé.txt", data));
    expect(pkg.name).toBe("notes résumé.txt");
    expect(new TextDecoder().decode(pkg.data)).toBe("hello, résumé");
    const pres = P.createPresentation();
    const slide = P.addBlankSlide(pres);
    P.addSlideEmbeddedFile(slide, { name: "data.csv", data }, PNG, box);
    const { pres: back, files } = await reload(pres);
    expect(Object.keys(files)).toContain("ppt/embeddings/oleObject1.bin");
    expect(slideXml(files)).toContain('progId="Package"');
    const frame = P.getSlideShapes(P.getSlides(back)[0])[0];
    expect(P.isOleObjectShape(frame)).toBe(true);
    const object = P.getShapeEmbeddedObject(frame);
    expect(object.file.name).toBe("data.csv");
    expect(new TextDecoder().decode(object.file.data)).toBe("hello, résumé");
    expect(P.getShapeEmbeddedObjectPreview(frame)).toEqual(PNG);
  });

  it("names a file with emoji in its icon without splitting a character", () => {
    const short = `${"😀".repeat(12)}.pdf`;
    expect(objectIconSvg(short)).toContain(`>${short}<`);
    const long = objectIconSvg(`${"😀".repeat(30)}.pdf`);
    expect(long).toContain(`>${"😀".repeat(19)}…<`);
    expect(() => encodeURIComponent(long)).not.toThrow();
    expect(objectIconSvg(`notes.${"😀".repeat(6)}`)).toContain(
      `>${"😀".repeat(5)}<`,
    );
  });
});

describe("header and footer", () => {
  it("adds, updates and removes the footer placeholders", async () => {
    const pres = P.createPresentation();
    const slide = P.addBlankSlide(pres);
    P.applySlideHeaderFooter(
      slide,
      {
        date: { mode: "auto", format: "datetime1" },
        slideNumber: true,
        footer: "Quarterly review",
      },
      1,
    );
    let hf = P.getSlideHeaderFooter(slide);
    expect(hf).toEqual({
      date: { mode: "auto", format: "datetime1" },
      slideNumber: true,
      footer: "Quarterly review",
    });
    P.applySlideHeaderFooter(slide, {
      date: { mode: "fixed", text: "1 May 2026" },
      slideNumber: false,
      footer: "Second",
    });
    const { pres: back, files } = await reload(pres);
    const xml = slideXml(files);
    expect(xml).toContain('<p:ph type="dt"');
    expect(xml).toContain('<p:ph type="ftr"');
    expect(xml).not.toContain('type="sldNum"');
    hf = P.getSlideHeaderFooter(P.getSlides(back)[0]);
    expect(hf.date).toEqual({ mode: "fixed", text: "1 May 2026" });
    expect(hf.footer).toBe("Second");
    expect(P.getSlideShapes(P.getSlides(back)[0])).toHaveLength(2);
  });

  it("keeps notes and handout settings", () => {
    const pres = P.createPresentation();
    const settings = {
      date: { mode: "fixed", text: "Today" },
      header: "Header",
      footer: null,
      pageNumber: false,
    };
    P.setNotesHeaderFooter(pres, settings);
    expect(P.getNotesHeaderFooter(pres)).toEqual(settings);
  });
});
