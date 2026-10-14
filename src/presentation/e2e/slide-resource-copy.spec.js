import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, MIME, parseDeck } from "../src/model.js";
import {
  sharedImageFixture,
  originalImage,
  replacementImage,
} from "../tests/image-replacement-fixture.js";
import { resolveTarget } from "../lib/pptx/src/internal/opc/index.ts";

test("shared pictures remain editable through clipboard both ways, undo, redo and download", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  const f = await sharedImageFixture({ sameRelationship: false }),
    source = Buffer.from(await P.savePresentation(f.pres)),
    objects = page.locator(".object-hit"),
    back = page.getByRole("button", { name: "Back to presentations" });
  const load = async (bytes, count) => {
    if (await back.isVisible()) await back.click();
    const event = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await event
    ).setFiles({
      name: "Shared resources.pptx",
      mimeType: MIME,
      buffer: bytes,
    });
    // The editor, not the library it was opened from, before counting.
    await expect(page.locator("#slide-position")).toBeVisible();
    await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
    await expect(objects).toHaveCount(count);
  };
  const copyAll = async () => {
    await objects.last().click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+c");
  };
  const download = async () => {
    await page
      .getByRole("menuitem", { name: "File", exact: true })
      .or(page.getByRole("button", { name: "File options" }))
      .filter({ visible: true })
      .click();
    const event = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const bytes = await readFile(await (await event).path());
    await page.keyboard.press("Escape");
    return bytes;
  };
  const inspect = async (bytes, count) => {
    const pres = await parseDeck(bytes),
      slide = P.getSlides(pres)[0],
      shapes = P.getSlideShapes(slide),
      pkg = P._internalPackageOf(pres),
      owner = P.getSlidePartName(slide),
      images = pkg
        .getRels(owner)
        .items.filter((r) => r.type.endsWith("/image"));
    expect(shapes).toHaveLength(count);
    for (const shape of shapes)
      expect(P.getShapeImageBytes(shape)).toEqual(originalImage);
    expect(
      new Set(images.map((r) => resolveTarget(owner, r.target))).size,
    ).toBe(1);
    expect(
      P.validatePresentation(pres).filter((i) => i.severity === "error"),
    ).toEqual([]);
    return pres;
  };
  await load(source, 2);
  await copyAll();
  await back.click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await expect(back).toBeVisible();
  await expect(objects).toHaveCount(0);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(2);
  const forward = await download();
  await inspect(forward, 2);
  await copyAll();
  await load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(4);
  await page.keyboard.press("Control+z");
  await expect(objects).toHaveCount(2);
  await page.keyboard.press("Control+Shift+z");
  await expect(objects).toHaveCount(4);
  const returned = await download(),
    pres = await inspect(returned, 4),
    shapes = P.getSlideShapes(P.getSlides(pres)[0]);
  P.setShapeImage(shapes[2], replacementImage);
  for (const i of [0, 1, 3])
    expect(P.getShapeImageBytes(shapes[i])).toEqual(originalImage);
  await load(Buffer.from(await P.savePresentation(pres)), 4);
  const edited = await parseDeck(await download()),
    editedShapes = P.getSlideShapes(P.getSlides(edited)[0]);
  expect(P.getShapeImageBytes(editedShapes[2])).toEqual(replacementImage);
  for (const i of [0, 1, 3])
    expect(P.getShapeImageBytes(editedShapes[i])).toEqual(originalImage);
  expect(errors).toEqual([]);
});
