import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { P, createDeck, text } from "../src/model.js";
import {
  readEotFont,
  unmaskEotFontData,
} from "../lib/pptx/src/internal/fonts/index.ts";
import { metadataFont } from "../tests/font-format-fixture.js";

const family = "Font Format Regression";
const bytes = (style) =>
  new Uint8Array(
    readFileSync(
      new URL(`../tests/data/font-formats/${style}.ttf`, import.meta.url),
    ),
  );
function fixture(styles = ["Regular"], font = family) {
  const p = createDeck("blank"),
    slide = P.getSlides(p)[0];
  styles.forEach((style, i) =>
    P.setShapeTextFormat(text(slide, "AVAVA", 1, 0.8 + i * 1.2, 8, 1, 44), {
      font,
      bold: style.includes("Bold"),
      italic: style.includes("Italic"),
    }),
  );
  return p;
}
async function start(page) {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
}
async function open(page, p, name = "Unembedded fonts.pptx") {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(p)),
  });
  await expect(page.locator(".object-hit")).toHaveCount(
    P.getSlideShapes(P.getSlides(p)[0]).length,
  );
}
async function fileMenu(page) {
  await page
    .getByRole("menuitem", { name: "File", exact: true })
    .or(page.getByRole("button", { name: "File options" }))
    .filter({ visible: true })
    .click();
}
async function choose(page, data, name = "Chosen font.ttf") {
  await fileMenu(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Embed font", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: name.endsWith(".otf") ? "font/otf" : "font/ttf",
    buffer: Buffer.from(data),
  });
}
async function embed(page, style = "Regular", extension = "ttf") {
  await choose(page, bytes(style), `Chosen font.${extension}`);
  const modal = page.getByRole("dialog", { name: "Embed font", exact: true });
  await modal
    .getByRole("checkbox", { name: "I have permission to embed this font." })
    .check();
  await modal.getByRole("button", { name: "Embed", exact: true }).click();
  await expect(modal).toHaveCount(0);
}
async function download(page) {
  await fileMenu(page);
  const result = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  return P.loadPresentation(await readFile(await (await result).path()));
}
const svg = (page) =>
  page.locator(".slide-image").evaluate(async (img) => {
    await img.decode();
    return (await fetch(img.src)).text();
  });
const faces = (page) =>
  page.evaluate(() =>
    [...document.fonts]
      .filter((face) => face.family.includes("Presentation document font"))
      .map((face) => ({
        family: face.family,
        style: face.style,
        weight: face.weight,
      })),
  );
// Every part but the file properties, which each download stamps with the
// time it was written.
const graph = (p) =>
  P._internalPackageOf(p)
    .parts.filter((part) => part.name !== "/docProps/core.xml")
    .map((part) => [part.name, part.contentType, [...part.data]])
    .sort((a, b) => a[0].localeCompare(b[0]));
const encoded = (p) =>
  P.getEmbeddedFonts(p).map((font) => ({
    typeface: font.typeface,
    faces: Object.fromEntries(
      Object.entries(font.faces).map(([style, face]) => [
        style,
        [...face.data],
      ]),
    ),
  }));
const pixels = (page, source) =>
  page.evaluate(async (source) => {
    const image = new Image();
    image.src =
      "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source);
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    return [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          ctx.getImageData(0, 0, 1280, 720).data,
        ),
      ),
    ];
  }, source);

test("font consent is accessible, required for mouse and keyboard, and cancellation preserves the package", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  const source = fixture();
  await open(page, source);
  const before = await svg(page);
  await choose(page, bytes("Regular"), "Unrelated filename.ttf");
  const modal = page.getByRole("dialog", { name: "Embed font", exact: true });
  await expect(modal).toContainText(`${family} — Regular`);
  await expect(modal.getByRole("checkbox")).not.toBeChecked();
  await expect(
    modal.getByRole("button", { name: "Embed", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Enter");
  await expect(modal).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .include("dialog")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await svg(page)).toBe(before);
  expect(await faces(page)).toEqual([]);
  expect(graph(await download(page))).toEqual(graph(source));
  expect(errors).toEqual([]);
});

test("authoring embeds all native style slots, preserves text XML, and supports undo, redo and idempotent embedding", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  const styles = ["Regular", "Bold", "Italic", "BoldItalic"],
    source = fixture(styles);
  await open(page, source);
  const before = await svg(page),
    fallback = await pixels(page, before);
  await embed(page);
  await expect.poll(() => faces(page)).toHaveLength(1);
  const regular = await svg(page);
  expect(await pixels(page, regular)).not.toEqual(fallback);
  await embed(page, "Bold");
  await expect.poll(() => faces(page)).toHaveLength(2);
  await page.keyboard.press("Control+z");
  await expect.poll(() => faces(page)).toHaveLength(1);
  await embed(page);
  await page.keyboard.press("Control+y"); // identical face must preserve the redo branch
  await expect.poll(() => faces(page)).toHaveLength(2);
  await embed(page, "Italic");
  await embed(page, "BoldItalic");
  await expect.poll(() => faces(page)).toHaveLength(4);
  const exported = await download(page),
    fonts = P.getEmbeddedFonts(exported);
  expect(fonts.map((f) => f.typeface)).toEqual([family]);
  for (const [slot, style] of [
    ["regular", "Regular"],
    ["bold", "Bold"],
    ["italic", "Italic"],
    ["boldItalic", "BoldItalic"],
  ])
    expect(
      unmaskEotFontData(readEotFont(fonts[0].faces[slot].data).font),
    ).toEqual(bytes(style));
  const pkg = P._internalPackageOf(exported);
  for (const part of P._internalPackageOf(source).parts.filter((p) =>
    /\/(slides|slideLayouts|slideMasters|theme)\//.test(p.name),
  ))
    expect(pkg.getPart(part.name).data).toEqual(part.data);
  expect(P.validatePresentation(exported)).toEqual([]);
  expect((await faces(page)).map((f) => [f.style, f.weight]).sort()).toEqual(
    [
      ["normal", "400"],
      ["normal", "700"],
      ["italic", "400"],
      ["italic", "700"],
    ].sort(),
  );
  const embeddedPixels = await pixels(page, await svg(page));
  for (let i = 0; i < 4; i++) await page.keyboard.press("Control+z");
  await expect.poll(() => faces(page)).toHaveLength(0);
  expect(await pixels(page, await svg(page))).toEqual(fallback);
  for (let i = 0; i < 4; i++) await page.keyboard.press("Control+y");
  await expect.poll(() => faces(page)).toHaveLength(4);
  expect(await pixels(page, await svg(page))).toEqual(embeddedPixels);
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await open(page, exported, "Reimported.pptx");
  expect(await pixels(page, await svg(page))).toEqual(embeddedPixels);
  expect(encoded(await download(page))).toEqual(encoded(exported));
  expect(errors).toEqual([]);
});

for (const [style, name, extension] of [
  ["CFF", `${family} CFF`, "otf"],
  ["Plus", `+${family}`, "ttf"],
])
  test(`font authoring supports ${style} without changing the native typeface or font bytes`, async ({
    page,
  }) => {
    await start(page);
    const source = fixture(["Regular"], name);
    await open(page, source);
    await embed(page, style, extension);
    await expect.poll(() => faces(page)).toHaveLength(1);
    const exported = await download(page),
      font = P.getEmbeddedFonts(exported)[0];
    expect(font.typeface).toBe(name);
    expect(
      unmaskEotFontData(readEotFont(font.faces.regular.data).font),
    ).toEqual(bytes(style));
    expect(
      P.getShapeRunFormatEffective(
        exported,
        P.getSlideShapes(P.getSlides(exported)[0])[0],
        0,
        0,
      ).font,
    ).toBe(name);
    expect(await svg(page)).toContain(
      style === "CFF" ? "data:font/otf" : "data:font/ttf",
    );
    expect(P.validatePresentation(exported)).toEqual([]);
  });

test("malformed, unlicensed, preview-only and unused fonts cannot mutate the presentation", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  const source = fixture();
  await open(page, source);
  const before = await svg(page);
  for (const [data, message] of [
    [new Uint8Array([1, 2, 3]), /font/i],
    [
      metadataFont({ family, fsType: 2 }),
      /does not permit editable outline embedding/,
    ],
    [bytes("PreviewPrint"), /does not permit editable outline embedding/],
    [bytes("CFF"), /Use Font Format Regression CFF in the presentation/],
    [metadataFont({ family }), /font|network/i],
  ]) {
    await page.evaluate(() => {
      document.querySelector("#toast").textContent = "";
    });
    await choose(page, data);
    await expect(page.locator("#toast")).toContainText(message);
    await expect(
      page.getByRole("dialog", { name: "Embed font", exact: true }),
    ).toHaveCount(0);
    expect(await faces(page)).toEqual([]);
    expect(await svg(page)).toBe(before);
    expect(graph(await download(page))).toEqual(graph(source));
  }
  expect(errors).toEqual([]);
});

test("conflicting versions preserve the installed face, package and redo history", async ({
  page,
}) => {
  await start(page);
  await open(page, fixture());
  await embed(page);
  await expect.poll(() => faces(page)).toHaveLength(1);
  const before = await svg(page),
    saved = await download(page);
  await embed(page, "Wide");
  await expect(page.locator("#toast")).toContainText(
    /conflict|different|already/i,
  );
  expect(await svg(page)).toBe(before);
  expect(graph(await download(page))).toEqual(graph(saved));
  await page.keyboard.press("Control+z");
  await expect.poll(() => faces(page)).toHaveLength(0);
  await page.keyboard.press("Control+y");
  await expect.poll(() => faces(page)).toHaveLength(1);
  expect(await pixels(page, await svg(page))).toEqual(
    await pixels(page, before),
  );
});

test("a font picker completing after the document closes cannot affect the replacement", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const arrayBuffer = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      const bytes = await arrayBuffer.call(this);
      if (!this.name.endsWith(".ttf")) return bytes;
      return new Promise((resolve) => {
        window.releaseFontRead = () => resolve(bytes);
      });
    };
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  await open(page, fixture());
  await choose(page, bytes("Regular"));
  await expect
    .poll(() => page.evaluate(() => typeof window.releaseFontRead))
    .toBe("function");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.evaluate(async () => {
    window.releaseFontRead();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await expect(
    page.getByRole("dialog", { name: "Embed font", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".object-hit")).toHaveCount(0);
  expect(await faces(page)).toEqual([]);
  expect(P.getEmbeddedFonts(await download(page))).toEqual([]);
  expect(errors).toEqual([]);
});

test("newly authored font parts transfer through object clipboard in both directions", async ({
  page,
}) => {
  await start(page);
  await open(page, fixture());
  await embed(page);
  await expect.poll(() => faces(page)).toHaveLength(1);
  const source = await download(page),
    sourcePixels = await pixels(page, await svg(page));
  await page.locator(".object-hit").click();
  await page.keyboard.press("Control+c");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.keyboard.press("Control+v");
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await expect.poll(() => faces(page)).toHaveLength(1);
  expect(await pixels(page, await svg(page))).toEqual(sourcePixels);
  const target = await download(page);
  expect(encoded(target)).toEqual(encoded(source));
  expect(P.validatePresentation(target)).toEqual([]);
  await page.locator(".object-hit").click();
  await page.keyboard.press("Control+c");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await open(page, source, "Return.pptx");
  await page.keyboard.press("Control+v");
  await expect(page.locator(".object-hit")).toHaveCount(2);
  const returned = await download(page);
  expect(encoded(returned)).toEqual(encoded(source));
  expect(P.validatePresentation(returned)).toEqual([]);
  expect(await faces(page)).toHaveLength(1);
});

test("a font referenced only by the theme can be embedded without rewriting inheritance", async ({
  page,
}) => {
  await start(page);
  const source = fixture(["Regular"], "+mj-lt");
  P.setPresentationFonts(source, { majorLatin: family });
  await open(page, source);
  await embed(page);
  await expect.poll(() => faces(page)).toHaveLength(1);
  const exported = await download(page);
  expect(P.getEmbeddedFonts(exported)[0].typeface).toBe(family);
  const pkg = P._internalPackageOf(exported);
  for (const part of P._internalPackageOf(source).parts.filter((p) =>
    /\/(slides|slideLayouts|slideMasters|theme)\//.test(p.name),
  ))
    expect(pkg.getPart(part.name).data).toEqual(part.data);
  expect(await svg(page)).toContain("@font-face");
});

test("oversize font files are rejected before reading or asking for consent", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Blob.prototype, "size"),
      read = File.prototype.arrayBuffer;
    Object.defineProperty(File.prototype, "size", {
      get() {
        return this.name.endsWith(".ttf")
          ? 40 * 1024 * 1024 + 1
          : descriptor.get.call(this);
      },
    });
    File.prototype.arrayBuffer = function () {
      if (this.name.endsWith(".ttf")) window.fontWasRead = true;
      return read.call(this);
    };
  });
  await start(page);
  const source = fixture();
  await open(page, source);
  await choose(page, bytes("Regular"));
  await expect(page.locator("#toast")).toHaveText(
    "Please choose a font file smaller than 40 MB.",
  );
  expect(await page.evaluate(() => window.fontWasRead)).toBeUndefined();
  await expect(
    page.getByRole("dialog", { name: "Embed font", exact: true }),
  ).toHaveCount(0);
  expect(graph(await download(page))).toEqual(graph(source));
});

test("font validation completing after document replacement cannot open a stale consent dialog", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeFace = FontFace;
    window.FontFace = class extends NativeFace {
      async load() {
        const face = await super.load();
        if (this.family !== "Presentation font validation") return face;
        return new Promise((resolve) => {
          window.releaseFontValidation = () => resolve(face);
        });
      }
    };
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  await open(page, fixture());
  await choose(page, bytes("Regular"));
  await expect
    .poll(() => page.evaluate(() => typeof window.releaseFontValidation))
    .toBe("function");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.evaluate(async () => {
    window.releaseFontValidation();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await expect(
    page.getByRole("dialog", { name: "Embed font", exact: true }),
  ).toHaveCount(0);
  expect(P.getEmbeddedFonts(await download(page))).toEqual([]);
  expect(await faces(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("a newer font selection supersedes an earlier selection in the same document", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeFace = FontFace;
    window.FontFace = class extends NativeFace {
      async load() {
        const face = await super.load();
        if (
          this.family !== "Presentation font validation" ||
          window.firstValidationHeld
        )
          return face;
        window.firstValidationHeld = true;
        return new Promise((resolve) => {
          window.releaseFirstValidation = () => resolve(face);
        });
      }
    };
  });
  await start(page);
  await open(page, fixture(["Regular", "Bold"]));
  await choose(page, bytes("Regular"));
  await expect
    .poll(() => page.evaluate(() => typeof window.releaseFirstValidation))
    .toBe("function");
  await choose(page, bytes("Bold"));
  const modal = page.getByRole("dialog", { name: "Embed font", exact: true });
  await expect(modal).toContainText(`${family} — Bold`);
  await page.evaluate(async () => {
    window.releaseFirstValidation();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await expect(modal).toHaveCount(1);
  await modal.getByRole("checkbox").check();
  await modal.getByRole("button", { name: "Embed", exact: true }).click();
  await expect.poll(() => faces(page)).toHaveLength(1);
  const font = P.getEmbeddedFonts(await download(page))[0];
  expect(Object.keys(font.faces)).toEqual(["bold"]);
  expect(unmaskEotFontData(readEotFont(font.faces.bold.data).font)).toEqual(
    bytes("Bold"),
  );
});
