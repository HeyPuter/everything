import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, parseDeck, MIME } from "../src/model.js";
import { numberingDeck, numberingMarkers } from "../tests/numbering-fixture.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";

for (const table of [false, true]) {
  test(`native outline numbering survives clipboard both ways, download and reopen; table=${table}`, async ({
    page,
  }) => {
    await page.route("https://js.puter.com/v2/", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
      }),
    );
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const source = Buffer.from(
      await P.savePresentation(await numberingDeck(undefined, { table })),
    );
    await page.goto("/#/home");
    const objects = page.locator(".object-hit");
    const back = page.getByRole("button", { name: "Back to presentations" });
    async function ready(count) {
      await expect(back).toBeVisible();
      await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
      await expect(objects).toHaveCount(count);
    }
    async function load(buffer, count) {
      if (await back.isVisible()) await back.click();
      const event = page.waitForEvent("filechooser");
      await page
        .getByRole("button", { name: "Import PPTX", exact: true })
        .click();
      await (
        await event
      ).setFiles({ name: "Numbered outline.pptx", mimeType: MIME, buffer });
      // The editor, not the library it was opened from, before counting.
      await expect(page.locator("#slide-position")).toBeVisible();
      await ready(count);
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
      const result = await readFile(await (await event).path());
      await page.keyboard.press("Escape");
      return result;
    }
    async function visibleLabels() {
      return page.locator(".slide-image").evaluate(async (img) => {
        await img.decode();
        const doc = new DOMParser().parseFromString(
          await (await fetch(img.src)).text(),
          "image/svg+xml",
        );
        return [...doc.querySelectorAll("text")]
          .map((el) => el.textContent)
          .filter((text) => /^(?:\d+\.|[ab]\))$/.test(text));
      });
    }
    await load(source, 1);
    await expect.poll(visibleLabels).toEqual(numberingMarkers);
    await objects.click();
    await page.keyboard.press("Control+c");
    await back.click();
    await page
      .getByRole("button", { name: "New presentation", exact: true })
      .click();
    await ready(0);
    await page.keyboard.press("Control+v");
    await ready(1);
    await expect.poll(visibleLabels).toEqual(numberingMarkers);
    if (!table) {
      await objects.dblclick();
      const editor = page.getByRole("textbox", {
        name: "Edit text",
        exact: true,
      });
      // Collapse the initial whole-object selection before inserting text.
      // Control+Home is not a portable caret shortcut on the macOS browsers.
      await editor.evaluate((input) => {
        const selection = window.getSelection();
        const range = document.createRange();
        const first = document
          .createTreeWalker(input, NodeFilter.SHOW_TEXT)
          .nextNode();
        if (!first?.textContent.startsWith("Number body 1"))
          throw new Error("Missing first paragraph");
        range.setStart(first, 0);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await editor.pressSequentially("Edited ");
      await editor.press("Control+Enter");
      await expect.poll(visibleLabels).toEqual(numberingMarkers);
    }
    const forward = await download();
    await load(forward, 1);
    await expect.poll(visibleLabels).toEqual(numberingMarkers);
    const p = await parseDeck(forward);
    expect(P.validatePresentation(p)).toEqual([]);
    const shape = P.getSlideShapes(P.getSlides(p)[0])[0];
    const bullet = table
      ? P.getTableCellParagraphs(P.getTableCell(shape, 0, 0))[0].properties
          .bullet
      : P.getParagraphBullet(shape, 0);
    expect(bullet).toEqual({ autoNum: "arabicPeriod", startAt: 2 });
    if (!table) expect(P.getShapeText(shape)).toContain("Edited Number body 1");
    await objects.click();
    await page.keyboard.press("Control+c");
    await load(source, 1);
    await page.keyboard.press("Control+v");
    await ready(2);
    await expect
      .poll(visibleLabels)
      .toEqual([...numberingMarkers, ...numberingMarkers]);
    const returned = await download();
    await load(returned, 2);
    await expect
      .poll(visibleLabels)
      .toEqual([...numberingMarkers, ...numberingMarkers]);
    const reopened = await parseDeck(returned);
    expect(P.validatePresentation(reopened)).toEqual([]);
    const svg = renderSlideToSvg(reopened, P.getSlides(reopened)[0], {
      textLayout: "svg",
    });
    expect(svg).toContain(">4.</text>");
    expect(errors).toEqual([]);
  });
}
