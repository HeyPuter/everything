// How text draws what DrawingML describes, checked against the desktop
// presentation app's output for the same files.
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";

// A one-slide deck whose shape tree holds `shapes` (DrawingML markup).
const render = async (shapes) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const files = unzipSync(await P.savePresentation(pres));
  const name = P.getSlidePartName(slide).slice(1);
  files[name] = strToU8(
    strFromU8(files[name]).replace("<p:grpSpPr/>", `<p:grpSpPr/>${shapes}`),
  );
  const loaded = await parseDeck(zipSync(files));
  return renderSlideToSvg(loaded, P.getSlides(loaded)[0], {
    textLayout: "svg",
  });
};
const textBox = (paragraphs) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="9" name="T"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="4572000" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;

describe("underline colour", () => {
  it.each(["wavy", "wavyHeavy", "wavyDbl"])(
    "draws a %s underline in its own colour",
    async (u) => {
      const svg = await render(
        textBox(
          `<a:p><a:r><a:rPr lang="en-US" sz="2400" u="${u}"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:uFill><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:uFill></a:rPr><a:t>Wavy</a:t></a:r></a:p>`,
        ),
      );
      const waves = [
        ...svg.matchAll(/<path d="M[^"]* Q[^"]*" stroke="([^"]+)"/g),
      ];
      expect(waves.length).toBe(u === "wavyDbl" ? 2 : 1);
      for (const wave of waves) expect(wave[1]).toBe("#FF0000");
    },
  );

  it("draws a wavy underline in the text colour without one", async () => {
    const svg = await render(
      textBox(
        `<a:p><a:r><a:rPr lang="en-US" sz="2400" u="wavy"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:rPr><a:t>Wavy</a:t></a:r></a:p>`,
      ),
    );
    expect(svg).toMatch(/<path d="M[^"]* Q[^"]*" stroke="#0000FF"/);
  });
});

describe("text shadow and glow", () => {
  const run = (text, effects = "") =>
    `<a:r><a:rPr lang="en-US" sz="2400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>${effects}</a:rPr><a:t>${text}</a:t></a:r>`;
  const shadow =
    '<a:effectLst><a:outerShdw blurRad="38100" dist="38100" dir="2700000"><a:srgbClr val="FF0000"/></a:outerShdw></a:effectLst>';
  const glow =
    '<a:effectLst><a:glow rad="101600"><a:srgbClr val="FFC000"/></a:glow></a:effectLst>';
  // The text each filtered copy shows, by its filter's flood colour.
  const casts = (svg) => {
    const floods = new Map(
      [...svg.matchAll(/<filter id="([^"]+)"[^>]*>(.*?)<\/filter>/g)].map(
        (m) => [m[1], /flood-color="([^"]+)"/.exec(m[2])?.[1]],
      ),
    );
    return [...svg.matchAll(/<g filter="url\(#([^)]+)\)">(.*?)<\/g>/g)].map(
      (m) => [
        floods.get(m[1]),
        [...m[2].matchAll(/<tspan (?![^>]*visibility="hidden")[^>]*>([^<]*)/g)]
          .map((t) => t[1])
          .join("|"),
      ],
    );
  };

  it("falls from the runs that carry it alone", async () => {
    const svg = await render(
      textBox(
        `<a:p>${run("Plain ")}${run("Shadowed", shadow)}</a:p><a:p>${run("Glowing", glow)}</a:p><a:p>${run("Plain again")}</a:p>`,
      ),
    );
    expect(casts(svg)).toEqual([
      ["#FF0000", "Shadowed"],
      ["#FFC000", "Glowing"],
    ]);
    // The text itself shows once, over its effects.
    expect(
      svg.match(/<tspan (?![^>]*visibility="hidden")[^>]*>Plain again</g),
    ).toHaveLength(1);
  });
});

describe("numbering schemes", () => {
  // The labels a scheme gives items 1, 2, 10, 11, 20, 23 and 100, as the
  // desktop app writes them.
  const labels = async (scheme) => {
    const items = [1, 2, 10, 11, 20, 23, 100]
      .map(
        (n) =>
          `<a:p><a:pPr marL="0" indent="0"><a:buAutoNum type="${scheme}" startAt="${n}"/></a:pPr><a:r><a:rPr lang="en-US" sz="1000"/><a:t>x</a:t></a:r></a:p>`,
      )
      .join("");
    const svg = await render(textBox(items));
    return [...svg.matchAll(/xml:space="preserve">([^<]+)<\/text>/g)].map(
      (m) => m[1],
    );
  };

  it.each([
    ["arabicDbPeriod", "１． ２． １０． １１． ２０． ２３． １００．"],
    ["ea1ChsPlain", "一 二 十 十一 二十 二十三 一〇〇"],
    ["ea1ChtPeriod", "一. 二. 十. 十一. 二〇. 二三. 一〇〇."],
    ["ea1JpnChsDbPeriod", "一． 二． 一〇． 一一． 二〇． 二三． 一〇〇．"],
    ["ea1JpnKorPlain", "一 二 一〇 一一 二〇 二三 一〇〇"],
    ["arabic1Minus", "أ- ب- ر- ز- ف- ل- طططط-"],
    ["arabic2Minus", "أ- ب- ي- ك- ر- ث- عععع-"],
    ["hebrew2Minus", "א- ב- י- כ- ר- תא- תתתתל-"],
    ["thaiAlphaParenBoth", "(ก) (ข) (ญ) (ฎ) (ท) (บ) (ตตต)"],
    ["thaiNumPeriod", "๑. ๒. ๑๐. ๑๑. ๒๐. ๒๓. ๑๐๐."],
    ["hindiNumParenR", "१) २) १०) ११) २०) २३) १००)"],
  ])("writes %s numbers in its own script", async (scheme, expected) => {
    expect((await labels(scheme)).join(" ")).toBe(expected);
  });
});

describe("bullet spacing", () => {
  it("starts the text right where a bullet with no room after it ends", async () => {
    // Bullet and text with no indent: "•" is 10 px in the test measurer and
    // the text follows it directly, as the desktop app draws "•Text".
    const measureText = (text, f) => ({
      widthPx: [...text].length * f.sizePx * 0.5,
      ascentPx: f.sizePx * 0.8,
      descentPx: f.sizePx * 0.2,
      lineGapPx: 0,
    });
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const files = unzipSync(await P.savePresentation(pres));
    const name = P.getSlidePartName(slide).slice(1);
    files[name] = strToU8(
      strFromU8(files[name]).replace(
        "<p:grpSpPr/>",
        `<p:grpSpPr/>${textBox('<a:p><a:pPr algn="l" marL="0" indent="0"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="en-US" sz="1500"/><a:t>Text</a:t></a:r></a:p>')}`,
      ),
    );
    const loaded = await parseDeck(zipSync(files));
    const svg = renderSlideToSvg(loaded, P.getSlides(loaded)[0], {
      textLayout: "svg",
      measureText,
    });
    const bulletX = Number(/<text x="([\d.]+)"[^>]*>•<\/text>/.exec(svg)[1]);
    const textX = Number(
      /<text x="([\d.]+)"[^>]*><tspan[^>]*>Text/.exec(svg)[1],
    );
    // 15 pt is 20 px, so "•" is 10 px wide.
    expect(textX - bulletX).toBeCloseTo(10, 5);
  });
});

describe("placeholders their layout lacks", () => {
  // A slide placeholder with no position whose layout (here the blank one)
  // has no placeholder of its index.
  const unplaced = async (ph, paragraphs) => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const files = unzipSync(await P.savePresentation(pres));
    const name = P.getSlidePartName(slide).slice(1);
    files[name] = strToU8(
      strFromU8(files[name]).replace(
        "<p:grpSpPr/>",
        `<p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="9" name="P"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`,
      ),
    );
    const loaded = await parseDeck(zipSync(files));
    return renderSlideToSvg(loaded, P.getSlides(loaded)[0], {
      textLayout: "svg",
    });
  };
  const para = (text, lvl = 0) =>
    `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ""}<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p>`;

  it("draws its text from the slide's top-left corner, unwrapped", async () => {
    const long =
      "A much longer body paragraph that would wrap if the box had a width";
    const svg = await unplaced('idx="1"', para(long));
    const m = new RegExp(
      `<text x="([\\d.]+)" y="([\\d.]+)"[^>]*><tspan[^>]*>${long}<`,
    ).exec(svg);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeLessThan(40);
    expect(Number(m[2])).toBeLessThan(60);
  });

  it("takes the master's text styles for its type", async () => {
    const body = await unplaced(
      'idx="1"',
      para("Body one") + para("Body two", 1),
    );
    // The master's body style: 28 pt with a bullet, 24 pt at level two.
    expect(body).toMatch(/font-size="37\.3\d*"[^>]*>Body one</);
    expect(body).toMatch(/font-size="32"[^>]*>Body two</);
    expect(body).toMatch(/>•<\/text>/);
    // And a title the master's title style: 44 pt.
    const title = await unplaced('type="title"', para("Title"));
    expect(title).toMatch(/font-size="58\.6\d*"[^>]*>Title</);
  });
});
