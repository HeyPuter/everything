import { test, expect } from "@playwright/test";
import { P, createDeck } from "../src/model.js";

// An edit to one slide redraws that slide's thumbnail and leaves every other
// row of the thumbnails pane as it was: on a large deck, rewriting every row
// made the browser restyle and lay them all out again on each edit.
function deck() {
  const pres = createDeck("blank");
  const E = 12700;
  for (let i = 0; i < 6; i++) {
    const s = i ? P.addBlankSlide(pres) : P.getSlides(pres)[0];
    P.addSlideTextBox(s, {
      x: 60 * E,
      y: 60 * E,
      w: 300 * E,
      h: 80 * E,
      text: `Slide ${i + 1} text`,
    });
  }
  return pres;
}

const errors = new WeakMap();
test.beforeEach(({ page }) => {
  const seen = [];
  errors.set(page, seen);
  page.on("pageerror", (error) => seen.push(error.message));
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));

test("an edit and its undo touch only the edited slide's thumbnail", async ({
  page,
}) => {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
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
    name: "Navigator.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(deck())),
  });
  const rows = page.locator("#slide-list > .slide-item");
  await expect(rows).toHaveCount(6);
  const images = page.locator("#slide-list > .slide-item .slide-thumb img");
  // Every thumbnail has its render before the edit.
  await expect
    .poll(() =>
      images.evaluateAll((list) => list.every((img) => img.src.length > 100)),
    )
    .toBe(true);
  await rows.nth(1).locator(".slide-thumb").click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 6");
  await page.locator(".object-hit").first().click();
  await expect(page.locator(".object-hit.selected")).toHaveCount(1);
  const before = await images.evaluateAll((list) => list.map((i) => i.src));
  const parts = await rows.evaluateAll((list) =>
    list.map((r) => r.dataset.slidePart),
  );
  // Rows written to, by slide part, from here on.
  await page.evaluate(() => {
    window.__touched = new Set();
    new MutationObserver((records) => {
      for (const r of records) {
        const node = r.target.nodeType === 1 ? r.target : r.target.parentNode;
        const row = node?.closest?.(".slide-item");
        if (row) window.__touched.add(row.dataset.slidePart);
      }
    }).observe(document.querySelector("#slide-list"), {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  const touched = () => page.evaluate(() => [...window.__touched]);
  const sources = () => images.evaluateAll((list) => list.map((i) => i.src));

  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await sources())[1]).not.toBe(before[1]);
  const moved = (await sources())[1];
  expect((await sources()).filter((src, i) => src !== before[i])).toEqual([
    moved,
  ]);
  expect(await touched()).toEqual([parts[1]]);

  await page.evaluate(() => window.__touched.clear());
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await sources())[1]).toBe(before[1]);
  expect(await sources()).toEqual(before);
  expect(await touched()).toEqual([parts[1]]);
  await expect(rows.nth(1)).toHaveClass(/active/);
  await expect(rows.nth(1).locator(".slide-number")).toHaveText("2");
  await expect(rows.nth(5).locator(".slide-thumb")).toHaveAttribute(
    "aria-label",
    "Slide 6: Slide 6 text",
  );
});

// Undoing a new or duplicated slide left the view on whichever slide moved
// up into its place, not the slide it was made from.
test("undoing a duplicated slide goes back to the slide it was made from", async ({
  page,
}) => {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
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
    name: "Navigator.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(deck())),
  });
  const rows = page.locator("#slide-list > .slide-item");
  await expect(rows).toHaveCount(6);
  const position = page.locator("#slide-position");
  await rows.nth(1).locator(".slide-thumb").click();
  await expect(position).toHaveText("Slide 2 of 6");
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+Shift+D`);
  await expect(position).toHaveText("Slide 3 of 7");
  await page.keyboard.press(`${mod}+Z`);
  await expect(rows).toHaveCount(6);
  await expect(position).toHaveText("Slide 2 of 6");
});
