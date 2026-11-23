import { describe, expect, it } from "vitest";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import { parseXml } from "../lib/pptx/src/internal/xml/index.ts";
import { bulletFontCases, bulletFontFixture } from "./bullet-font-fixture.js";
import { textStyleFixture } from "./text-style-copy-fixture.js";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import native from "./data/bullet-font-native.json";

const visit = (el) => [
  el,
  ...el.children.flatMap((c) => (c.kind === "element" ? visit(c) : [])),
];
const text = (el) =>
  el.children
    .map((c) =>
      c.kind === "element" ? text(c) : c.kind === "text" ? c.data : "",
    )
    .join("");
const attribute = (el, name) =>
  el.attrs.find((a) => a.name.localName === name)?.value;

it.each(["svg", "foreignObject"])(
  "uses native bullet fonts on the %s rendering path",
  async (mode) => {
    const pres = await bulletFontFixture();
    for (const [i, slide] of P.getSlides(pres).entries()) {
      const svg = renderSlideToSvg(pres, slide, {
        textLayout: mode,
        resolveFontFamily: (family) => family,
      });
      const bullets = visit(parseXml(svg).root).filter(
        (el) =>
          el.name.localName === (mode === "svg" ? "text" : "span") &&
          ["1.", "•"].includes(text(el)),
      );
      expect(bullets).toHaveLength(6);
      for (let n = 0; n < 6; n++) {
        const c = bulletFontCases[i * 6 + n];
        const family =
          c.kind === "character" && c.properties.includes("buFont ")
            ? "Courier New"
            : c.font;
        const measured = native.cases[i * 6 + n];
        expect(measured).toMatchObject({ bodyFont: c.font, label: c.label });
        expect(measured.nativeBulletFont.replace(/\s|PSMT$/g, "")).toBe(
          family.replace(/\s/g, ""),
        );
        expect(
          attribute(bullets[n], mode === "svg" ? "font-family" : "style"),
        ).toContain(family);
      }
    }
  },
);

it("resolves independent bullet style choices and follow-text resets through list styles", async () => {
  const inherited =
    '<a:lvl1pPr><a:buClr><a:srgbClr val="124578"><a:alpha val="60000"/></a:srgbClr></a:buClr><a:buSzPct val="75000"/><a:buFont typeface="+mj-lt"/></a:lvl1pPr>';
  const pres = await bulletFontFixture([
    {
      font: "Verdana",
      label: "Inherited",
      kind: "character",
      properties: "",
      listStyle: inherited,
    },
    {
      font: "Georgia",
      label: "Reset",
      kind: "character",
      properties: "<a:buClrTx/><a:buSzTx/><a:buFontTx/>",
      listStyle: inherited,
    },
    {
      font: "Georgia",
      label: "Fixed",
      kind: "character",
      properties: '<a:buSzPts val="1700"/>',
      listStyle: inherited,
    },
  ]);
  P.setPresentationFonts(pres, {
    majorLatin: "Courier New",
    minorLatin: "Verdana",
  });
  const [a, b, c] = P.getSlideShapes(P.getSlides(pres)[0]);
  expect(P.getParagraphBulletStyle(pres, a, 0).font).toBe(null);
  expect(P.getParagraphBulletStyleEffective(pres, a, 0)).toEqual({
    color: "#124578",
    colorOpacity: 0.6,
    sizePct: 0.75,
    sizePts: null,
    font: "Courier New",
  });
  expect(P.getParagraphBulletStyleEffective(pres, b, 0)).toEqual({
    color: null,
    sizePct: null,
    sizePts: null,
    font: null,
  });
  expect(P.getParagraphBulletStyleEffective(pres, c, 0)).toEqual({
    color: "#124578",
    colorOpacity: 0.6,
    sizePct: null,
    sizePts: 17,
    font: "Courier New",
  });
  const before = await P.savePresentation(pres);
  renderSlideToSvg(pres, P.getSlides(pres)[0], { textLayout: "svg" });
  expect(await P.savePresentation(pres)).toEqual(before);
});

it("retains bullet font behavior through source-format imports and save/reload", async () => {
  const source = await bulletFontFixture(),
    target = createDeck("blank");
  for (const slide of P.getSlides(source)) {
    const copied = P.importSlide(target, slide, P.getSlideLayouts(target)[0], {
      preserveTextFormatting: true,
    });
    const sourceBullets = visit(
      parseXml(renderSlideToSvg(source, slide, { textLayout: "svg" })).root,
    )
      .filter(
        (el) => el.name.localName === "text" && ["1.", "•"].includes(text(el)),
      )
      .map((el) => attribute(el, "font-family"));
    const restored = await parseDeck(await P.savePresentation(target));
    const result = P.getSlides(restored).at(-1);
    expect(
      visit(
        parseXml(renderSlideToSvg(restored, result, { textLayout: "svg" }))
          .root,
      )
        .filter(
          (el) =>
            el.name.localName === "text" && ["1.", "•"].includes(text(el)),
        )
        .map((el) => attribute(el, "font-family")),
    ).toEqual(sourceBullets);
    expect(P.getSlideShapes(copied)).toHaveLength(6);
  }
});

it("resolves all nine inherited placeholder levels and preserves local follow-text choices", async () => {
  const fixture = await textStyleFixture({ family: "Georgia", rich: false });
  const files = fixture.files;
  const layout = P.getSlideLayoutPartName(
    P.getSlideLayout(fixture.slide),
  ).slice(1);
  files[layout] = strToU8(
    strFromU8(files[layout]).replace(
      /<a:buNone\/>/g,
      '<a:buFont typeface="Courier New"/><a:buChar char="•"/>',
    ),
  );
  const source = await parseDeck(zipSync(files)),
    slide = P.getSlides(source)[0],
    shape = P.getSlideShapes(slide)[0];
  for (let i = 0; i < 9; i++)
    expect(P.getParagraphBulletStyleEffective(source, shape, i).font).toBe(
      "Courier New",
    );
  const part = P.getSlidePartName(slide).slice(1);
  files[part] = strToU8(
    strFromU8(files[part]).replace(
      '<a:pPr lvl="4">',
      '<a:pPr lvl="4"><a:buFontTx/>',
    ),
  );
  const reset = await parseDeck(zipSync(files)),
    resetShape = P.getSlideShapes(P.getSlides(reset)[0])[0];
  expect(P.getParagraphBulletStyleEffective(reset, resetShape, 4).font).toBe(
    null,
  );
  expect(P.getParagraphBulletStyleEffective(reset, resetShape, 5).font).toBe(
    "Courier New",
  );
});

describe("symbol-font bullets", () => {
  async function bulleted(chars) {
    const pres = createDeck("blank"),
      slide = P.getSlides(pres)[0];
    const box = P.addSlideTextBox(slide, {
      x: P.inches(1),
      y: P.inches(1),
      w: P.inches(6),
      h: P.inches(3),
      text: chars.map((_, i) => `Item ${i}`).join("\n"),
    });
    P.setShapeTextFormat(box, { font: "Georgia" });
    const files = unzipSync(await P.savePresentation(pres));
    const name = P.getSlidePartName(slide).slice(1);
    let index = 0;
    files[name] = strToU8(
      strFromU8(files[name]).replace(/<a:p>(?:<a:pPr\/>)?/g, () => {
        const [font, char] = chars[index++] ?? [];
        return font
          ? `<a:p><a:pPr marL="342900" indent="-342900"><a:buFont typeface="${font}"/><a:buChar char="${char}"/></a:pPr>`
          : "<a:p>";
      }),
    );
    return parseDeck(zipSync(files));
  }
  const bullets = (pres, hasFont) =>
    [
      ...renderSlideToSvg(pres, P.getSlides(pres)[0], {
        textLayout: "svg",
        ...(hasFont ? { hasFont } : {}),
        resolveFontFamily: (family) => family ?? "Calibri",
      }).matchAll(
        /<text x="[^"]+" y="[^"]+" font-family="([^"]+)"[^>]*>([^<]*)<\/text>/g,
      ),
    ].map((m) => [m[1], m[2]]);
  const chars = [
    ["Wingdings", "§"],
    ["Wingdings", ""],
    ["Symbol", "·"],
    ["Arial", "–"],
  ];
  it("draws a missing symbol typeface's bullet as the character it shows", async () => {
    const pres = await bulleted(chars);
    expect(bullets(pres, (family) => family === "Arial")).toEqual([
      ["Georgia", "▪"],
      ["Georgia", "➢"],
      ["Georgia", "•"],
      ["Arial", "–"],
    ]);
  });
  it("keeps the authored character where the typeface is installed", async () => {
    const pres = await bulleted(chars);
    const authored = [
      ["Wingdings", "§"],
      ["Wingdings", ""],
      ["Symbol", "·"],
      ["Arial", "–"],
    ];
    expect(bullets(pres, () => true)).toEqual(authored);
    expect(bullets(pres)).toEqual(authored);
  });
});
