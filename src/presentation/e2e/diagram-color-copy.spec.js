import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, createDeck, parseDeck, MIME } from "../src/model.js";
import { sourceDeck, decode } from "../tests/diagram-color-copy-fixture.js";
import { readShapeDiagram } from "../lib/pptx/src/api/fn/diagram-read.ts";

test("SmartArt colors survive actual object clipboard, exported re-open and return copy", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  const { pres } = await sourceDeck(),
    original = await P.savePresentation(pres);
  async function load(bytes, count) {
    const back = page.getByRole("button", { name: "Back to presentations" });
    if (await back.isVisible()) await back.click();
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await chooser
    ).setFiles({
      name: "Diagram color control.pptx",
      mimeType: MIME,
      buffer: Buffer.from(bytes),
    });
    // The editor, not the library it was opened from, before counting.
    await expect(page.locator("#slide-position")).toBeVisible();
    await expect(page.locator(".object-hit")).toHaveCount(count);
  }
  async function copy() {
    const hit = page.locator(".object-hit").first();
    await hit.focus();
    await hit.press("Space");
    await expect(hit).toHaveAttribute("aria-pressed", "true");
    await hit.focus();
    await page.keyboard.press("Control+c");
  }
  async function download() {
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
    return { bytes, p: await parseDeck(bytes) };
  }
  const colors = async () => {
    const uri = await page.locator(".slide-image").getAttribute("src");
    const svg = decodeURIComponent(uri.split(",").slice(1).join(","));
    return [...svg.matchAll(/(?:fill|stroke)="(#[\da-f]{6})"/gi)].map(
      (m) => m[1],
    );
  };
  await load(original, 1);
  const sourceColors = await colors();
  await copy();
  const blank = createDeck("blank"),
    targetTheme = P.getPresentationTheme(blank);
  await load(await P.savePresentation(blank), 0);
  await page.keyboard.press("Control+v");
  await expect(page.locator(".object-hit")).toHaveCount(1);
  expect(await colors()).toEqual(sourceColors);
  const forward = await download();
  const diagram = readShapeDiagram(
    P.getSlideShapes(P.getSlides(forward.p)[0])[0],
  );
  expect(decode(diagram.colors.part)).toContain('<a:srgbClr val="4179B2">');
  expect(decode(diagram.colors.part)).toContain('<a:srgbClr val="8329A5">');
  expect(decode(diagram.colors.part)).toContain('meth="cycle" hueDir="cw"');
  expect(P.getPresentationTheme(forward.p)).toEqual(targetTheme);
  expect(P.validatePresentation(forward.p)).toEqual([]);
  await load(forward.bytes, 1);
  expect(await colors()).toEqual(sourceColors);
  await copy();
  await load(original, 1);
  await page.keyboard.press("Control+v");
  await expect(page.locator(".object-hit")).toHaveCount(2);
  const returned = await download();
  expect(
    decode(
      readShapeDiagram(P.getSlideShapes(P.getSlides(returned.p)[0])[1]).colors
        .part,
    ),
  ).toBe(decode(diagram.colors.part));
  expect(P.validatePresentation(returned.p)).toEqual([]);
  expect(errors).toEqual([]);
});
