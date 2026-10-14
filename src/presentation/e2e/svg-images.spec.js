import { test, expect } from "@playwright/test";
import { inspector } from "./editor-commands.js";
import { readFile } from "node:fs/promises";
import { P, parseDeck, MIME } from "../src/model.js";
import { svgImageFixture, vectorImage } from "../tests/svg-image-fixture.js";
import { replacementImage } from "../tests/image-replacement-fixture.js";

const start = async (page) => {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
};
const download = async (page) => {
  await page
    .getByRole("menuitem", { name: "File", exact: true })
    .or(page.getByRole("button", { name: "File options" }))
    .filter({ visible: true })
    .click();
  const event = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  return parseDeck(await readFile(await (await event).path()));
};
const picture = (pres) => P.getSlideShapes(P.getSlides(pres)[0])[0];
const pixels = (image) =>
  image.evaluate(async (image) => {
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, 1280, 720);
    return {
      background: [...ctx.getImageData(30, 30, 1, 1).data],
      face: [...ctx.getImageData(144, 120, 1, 1).data],
    };
  });
for (const fallback of [false, true])
  test(`SVG pictures with raster fallback=${fallback} render, copy and replace through app downloads`, async ({
    page,
  }) => {
    await start(page);
    const f = await svgImageFixture({ fallback }),
      chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await chooser
    ).setFiles({
      name: "Vector pictures.pptx",
      mimeType: MIME,
      buffer: Buffer.from(await P.savePresentation(f.pres)),
    });
    const objects = page.locator(".object-hit"),
      image = page.locator(".slide-image");
    await expect(objects).toHaveCount(1);
    const imported = await pixels(image);
    for (let c = 0; c < 3; c++)
      expect(
        Math.abs(
          imported.face[c] -
            ([36, 104, 188][c] * 0.8 + imported.background[c] * 0.2),
        ),
      ).toBeLessThanOrEqual(2);
    expect(P.getShapeImageBytes(picture(await download(page)))).toEqual(
      vectorImage,
    );
    await objects.click();
    await page.keyboard.press("Control+c");
    await page.getByRole("button", { name: "Back to presentations" }).click();
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    await page.keyboard.press("Control+v");
    await expect(objects).toHaveCount(1);
    const copied = await pixels(image);
    for (let c = 0; c < 3; c++)
      expect(
        Math.abs(
          copied.face[c] -
            ([36, 104, 188][c] * 0.8 + copied.background[c] * 0.2),
        ),
      ).toBeLessThanOrEqual(2);
    const saved = await download(page);
    expect(P.getShapeImageBytes(picture(saved))).toEqual(vectorImage);
    expect(P.getShapeImageOpacity(picture(saved))).toBe(0.8);
    await objects.click();
    const panel = page.getByRole("complementary", { name: "Format panel" });
    await inspector(page);
    const replacement = page.waitForEvent("filechooser");
    await panel
      .getByRole("button", { name: "Replace image", exact: true })
      .click();
    await (
      await replacement
    ).setFiles({
      name: "Replacement.png",
      mimeType: "image/png",
      buffer: Buffer.from(replacementImage),
    });
    await expect(objects).toHaveAccessibleName(
      "Image: Replacement.png. Select to edit",
    );
    const replaced = await download(page),
      s = picture(replaced);
    expect(P.getShapeImageBytes(s)).toEqual(replacementImage);
    expect(P.getShapeXmlString(s)).not.toContain("svgBlip");
    expect(P.getShapeImageOpacity(s)).toBe(0.8);
    expect(
      P.validatePresentation(replaced).filter((i) => i.severity === "error"),
    ).toEqual([]);
  });

test("SVG-only artwork, fills, backgrounds and bullets decode as vector images in browser rendering", async ({
  page,
}) => {
  await start(page);
  for (const context of [
    "shape fill",
    "slide background",
    "layout artwork",
    "master artwork",
    "layout background",
    "master background",
    "bullet",
  ]) {
    const f = await svgImageFixture({ context });
    const data = await page.evaluate(
      async (bytes) => {
        const { P, parseDeck, preview } = await import("/src/model.js");
        const p = await parseDeck(Uint8Array.from(bytes)),
          uri = preview(p, P.getSlides(p)[0]);
        const image = new Image();
        image.src = uri;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        const rgba = ctx.getImageData(0, 0, 1280, 720).data;
        let blue = 0;
        for (let i = 0; i < rgba.length; i += 4)
          if (rgba[i + 2] > rgba[i] + 40 && rgba[i + 2] > rgba[i + 1] + 20)
            blue++;
        return { uri, blue };
      },
      Array.from(await P.savePresentation(f.pres)),
    );
    expect(data.uri, context).toContain("data%3Aimage%2Fsvg%2Bxml%3Bbase64%2C");
    expect(data.blue, context).toBeGreaterThan(5);
  }
});
