// Ink drawn during a show lands where it was drawn, at its size, on decks of
// either shape and from Presenter View; discarded ink leaves nothing.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, createDeck, parseDeck, text } from "../src/model.js";

test.setTimeout(90_000);

async function load(page, { width, height }) {
  const pres = createDeck("blank");
  P.setSlideSize(pres, { width, height });
  text(P.getSlides(pres)[0], "One", 1, 1, 4, 1);
  text(P.addBlankSlide(pres), "Two", 1, 1, 4, 1);
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  const choose = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await choose
  ).setFiles({
    name: "Ink.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".slide-image")).toBeVisible();
}
async function download(page) {
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
}
const show = (page) => page.getByRole("dialog", { name: "Presentation mode" });
// A pen stroke from a quarter to three quarters across and down the frame.
async function stroke(page, frame) {
  const box = await frame.boundingBox();
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 4);
  await page.mouse.down();
  await page.mouse.move(
    box.x + (box.width * 3) / 4,
    box.y + (box.height * 3) / 4,
    { steps: 8 },
  );
  await page.mouse.up();
}
const inkOf = (slide) =>
  P.getSlideShapes(slide).filter((s) => P.getShapeName(s).startsWith("Ink "));

for (const [name, size] of [
  ["4:3", { width: 9144000, height: 6858000 }],
  ["16:9", { width: 12192000, height: 6858000 }],
])
  for (const presenter of [false, true])
    test(`ink kept on a ${name} deck${presenter ? " from Presenter View" : ""} lands where it was drawn`, async ({
      page,
    }, info) => {
      test.skip(
        presenter && info.project.name === "mobile",
        "Presenter View in the show's window is a desktop flow",
      );
      await load(page, size);
      await page.getByRole("button", { name: "Present", exact: true }).click();
      const d = show(page);
      await expect(d.locator(".presenter-counter")).toHaveText("1 / 2");
      await page.keyboard.press("ArrowRight");
      await expect(d.locator(".presenter-counter")).toHaveText("2 / 2");
      let frame = d.locator(".presenter-frame");
      if (presenter) {
        await d
          .locator(".presenter-stage")
          .click({ button: "right", position: { x: 20, y: 20 } });
        await page
          .getByRole("menuitem", { name: "Show Presenter View" })
          .click();
        await expect(d.locator(".show-console-side")).toBeVisible();
      }
      await page.keyboard.press("Control+p");
      await stroke(page, frame);
      await expect(d.locator(".show-ink path")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(d).toBeHidden();
      const prompt = page.getByRole("dialog", { name: "Keep your ink?" });
      await prompt
        .getByRole("button", { name: "Keep Ink", exact: true })
        .click();
      await expect(prompt).toBeHidden();
      const [first, second] = P.getSlides(await download(page));
      expect(inkOf(first)).toHaveLength(0);
      const [ink] = inkOf(second);
      expect(ink).toBeTruthy();
      const b = P.getShapeBounds(ink);
      const near = (value, want) =>
        expect(Math.abs(value - want)).toBeLessThan(size.width * 0.03);
      near(b.x, size.width / 4);
      near(b.y, size.height / 4);
      near(b.x + b.w, (size.width * 3) / 4);
      near(b.y + b.h, (size.height * 3) / 4);
    });

test("discarded ink leaves nothing behind", async ({ page }) => {
  await load(page, { width: 12192000, height: 6858000 });
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const d = show(page);
  await page.keyboard.press("Control+p");
  await stroke(page, d.locator(".presenter-frame"));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const prompt = page.getByRole("dialog", { name: "Keep your ink?" });
  await prompt.getByRole("button", { name: "Discard" }).click();
  await expect(prompt).toBeHidden();
  const deck = await download(page);
  for (const s of P.getSlides(deck)) expect(inkOf(s)).toHaveLength(0);
  // Nothing to undo either: the deck is as it was.
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 2");
});
