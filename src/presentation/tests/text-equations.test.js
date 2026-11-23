// Equations made in other apps sit in a text box's paragraphs as alternate
// content: the equation, and plain text for readers without equations. The
// editor neither shows nor writes them, and an edit to the box's words keeps
// each one where it was in the text.
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  P,
  createDeck,
  parseDeck,
  setRichText,
  textRuns,
} from "../src/model.js";

const equation = (text) =>
  `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14"><a14:m><m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:oMath><m:r><m:t>${text}</m:t></m:r></m:oMath></m:oMathPara></a14:m></mc:Choice><mc:Fallback><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></mc:Fallback></mc:AlternateContent>`;
const run = (text) => `<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r>`;
const SLIDE = "ppt/slides/slide1.xml";

async function boxWith(paragraphs) {
  const entries = unzipSync(await P.savePresentation(createDeck("blank")));
  const box = `<p:sp><p:nvSpPr><p:cNvPr id="50" name="TextBox 49"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="100000" y="100000"/><a:ext cx="4000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs
    .map((p) => `<a:p>${p}</a:p>`)
    .join("")}</p:txBody></p:sp>`;
  entries[SLIDE] = strToU8(
    strFromU8(entries[SLIDE]).replace("</p:spTree>", `${box}</p:spTree>`),
  );
  const pres = await parseDeck(zipSync(entries));
  const shape = P.getSlideShapes(P.getSlides(pres)[0]).find(
    (s) => P.getShapeId(s) === 50,
  );
  return { pres, shape };
}
// Each paragraph's runs and equations in order, from the saved file.
async function saved(pres) {
  const xml = strFromU8(unzipSync(await P.savePresentation(pres))[SLIDE]);
  const body = xml.slice(xml.indexOf('id="50"'));
  return [...body.matchAll(/<a:p>(.*?)<\/a:p>/g)].map(([, p]) =>
    [
      ...p.matchAll(
        /<mc:AlternateContent.*?<m:t>(.*?)<\/m:t>.*?<\/mc:AlternateContent>|<a:r>.*?<a:t>(.*?)<\/a:t><\/a:r>/g,
      ),
    ].map(([, math, words]) => (math != null ? `[${math}]` : words)),
  );
}

describe("equations in text boxes", () => {
  it("stay when another paragraph is edited", async () => {
    const { pres, shape } = await boxWith([
      run("Area: ") + equation("πr²") + run(" units"),
      run("Second line"),
    ]);
    const paragraphs = textRuns(pres, shape);
    paragraphs[1].runs[0].text = "Second line edited";
    setRichText(shape, paragraphs);
    expect(await saved(pres)).toEqual([
      ["Area: ", "[πr²]", " units"],
      ["Second line edited"],
    ]);
  });

  it("follow words typed before them, and stay put for words typed after", async () => {
    const { pres, shape } = await boxWith([
      run("Area: ") + equation("πr²") + run(" units"),
    ]);
    let paragraphs = textRuns(pres, shape);
    paragraphs[0].runs[0].text = "The area: ";
    paragraphs[0].runs[1].text = " square units";
    setRichText(shape, paragraphs);
    expect(await saved(pres)).toEqual([
      ["The area: ", "[πr²]", " square units"],
    ]);
    // Typed inside one run, which then holds the equation's place.
    paragraphs = textRuns(pres, shape);
    paragraphs[0].runs = [
      { ...paragraphs[0].runs[0], text: "The area: is  square units" },
    ];
    setRichText(shape, paragraphs);
    const [words] = await saved(pres);
    expect(words).toContain("[πr²]");
    expect(words.filter((w) => w !== "[πr²]").join("")).toBe(
      "The area: is  square units",
    );
  });

  it("move with their words to a new paragraph, in order", async () => {
    const { pres, shape } = await boxWith([
      run("First ") +
        equation("a") +
        equation("b") +
        run(" then ") +
        equation("c"),
    ]);
    const paragraphs = textRuns(pres, shape);
    // Enter pressed after "First": the rest goes to a paragraph of its own.
    const [first, then] = paragraphs[0].runs;
    paragraphs.splice(
      0,
      1,
      { ...paragraphs[0], runs: [{ ...first, text: "First" }] },
      { ...paragraphs[0], runs: [{ ...first, text: " " }, then] },
    );
    setRichText(shape, paragraphs);
    expect(await saved(pres)).toEqual([
      ["First"],
      [" ", "[a]", "[b]", " then ", "[c]"],
    ]);
  });

  it("stay in a paragraph whose words are all removed", async () => {
    const { pres, shape } = await boxWith([
      equation("x") + run(" is it"),
      run("More"),
    ]);
    const paragraphs = textRuns(pres, shape);
    paragraphs[0].runs = [{ ...paragraphs[0].runs[0], text: "" }];
    setRichText(shape, paragraphs);
    expect((await saved(pres)).flat()).toContain("[x]");
    // The file written opens again with the equation.
    const again = await parseDeck(await P.savePresentation(pres));
    expect(
      strFromU8(unzipSync(await P.savePresentation(again))[SLIDE]),
    ).toContain("<a14:m>");
  });
});
