import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, MIME, parseDeck } from "../src/model.js";
import {
  graphemeCopyDeck,
  copiedClusters,
} from "../tests/grapheme-copy-fixture.js";

test("graphemes and their run formatting survive actual clipboard transfer, return and reimport", async ({
  page,
}) => {
  // Firefox versions within the existing build target lack this primitive.
  await page.addInitScript(() => {
    Object.defineProperty(Intl, "Segmenter", {
      configurable: true,
      value: undefined,
    });
  });
  const original = graphemeCopyDeck(),
    source = Buffer.from(await P.savePresentation(original));
  const count = copiedClusters.length,
    objects = page.locator(".object-hit"),
    errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  const home = async () => {
    const back = page.getByRole("button", { name: "Back to presentations" });
    if (await back.isVisible()) await back.click();
  };
  const load = async (bytes, n) => {
    await home();
    const event = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await event
    ).setFiles({
      name: "Composed characters.pptx",
      mimeType: MIME,
      buffer: bytes,
    });
    // The editor, not the library it was opened from, before counting.
    await expect(page.locator("#slide-position")).toBeVisible();
    await expect(objects).toHaveCount(n);
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
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const rendered = await image.evaluate(async (img) => {
      const doc = new DOMParser().parseFromString(
        await (await fetch(img.src)).text(),
        "image/svg+xml",
      );
      return {
        lines: [...doc.querySelectorAll("text")].map((el) => el.textContent),
        colored: [...doc.querySelectorAll('tspan[fill="#112233"]')].map(
          (el) => ({
            text: el.textContent,
            italic: el.getAttribute("font-style"),
          }),
        ),
      };
    });
    expect(rendered.lines).toEqual(
      Array.from({ length: sets }, () =>
        copiedClusters.flatMap((c) => [c, c]),
      ).flat(),
    );
    expect(rendered.colored).toEqual(
      Array.from({ length: sets * 2 }, () => ({
        text: "\u0301",
        italic: "italic",
      })),
    );
    const bytes = await download(),
      deck = await parseDeck(bytes),
      shapes = P.getSlideShapes(P.getSlides(deck)[0]);
    expect(shapes).toHaveLength(sets * count);
    for (const [i, sh] of shapes.entries()) {
      const reference = P.getSlideShapes(P.getSlides(original)[0])[i % count];
      expect(P.getShapeText(sh)).toBe(copiedClusters[i % count].repeat(2));
      for (const index of i % count === 0 ? [0, 1, 2, 3] : [0])
        expect(P.getShapeRunFormatEffective(deck, sh, 0, index)).toMatchObject(
          P.getShapeRunFormatEffective(original, reference, 0, index),
        );
    }
    expect(P.validatePresentation(deck)).toEqual([]);
    return bytes;
  };
  const copyAll = async () => {
    await objects.last().click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+c");
  };
  await load(source, count);
  await check();
  await copyAll();
  await home();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await expect(objects).toHaveCount(0);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(count);
  await check();
  await copyAll();
  await load(source, count);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(count * 2);
  const returned = await check(2);
  await load(returned, count * 2);
  await check(2);
  expect(errors).toEqual([]);
});
