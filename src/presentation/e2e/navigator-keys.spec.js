// Shortcuts pressed in the slide navigator act on slides, not on the object
// selected on the canvas.
import { test, expect } from "@playwright/test";

const mod = process.platform === "darwin" ? "Meta" : "Control";

async function story(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
}

test("Ctrl+D in the navigator duplicates the slide, and copy or cut there leave the object alone", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await story(page);
  const objects = page.locator("#slide-canvas .object-hit");
  const count = await objects.count();
  await objects.first().click();
  await expect(page.locator("#slide-canvas .object-hit.selected")).toHaveCount(
    1,
  );
  const thumb = page.locator("#slide-list .slide-item.active .slide-thumb");
  await thumb.focus();
  await page.keyboard.press(`${mod}+KeyD`);
  await expect(page.locator("#slide-position")).toHaveText(/of 6$/);
  await page.locator("#slide-list .slide-item.active .slide-thumb").focus();
  for (const key of ["KeyX", "KeyC", "KeyB"])
    await page.keyboard.press(`${mod}+${key}`);
  await expect(page.locator("#slide-position")).toHaveText(/of 6$/);
  // The duplicate shows the first slide's objects, none cut or added.
  await expect(objects).toHaveCount(count);
  await page.locator("#slide-list .slide-thumb").first().click();
  await expect(objects).toHaveCount(count);
  expect(errors).toEqual([]);
});

test("Ctrl+X in the navigator leaves the selected object, and a paste there hands the keyboard to what it put on the slide", async ({
  page,
}) => {
  await story(page);
  const objects = page.locator("#slide-canvas .object-hit");
  const count = await objects.count();
  await objects.first().click();
  await page.keyboard.press(`${mod}+KeyC`);
  const thumb = page.locator("#slide-list .slide-item.active .slide-thumb");
  await thumb.focus();
  await page.keyboard.press(`${mod}+KeyX`);
  await expect(objects).toHaveCount(count);
  await expect(page.locator("#slide-canvas .object-hit.selected")).toHaveCount(
    1,
  );
  // Paste from the navigator: the copy lands selected and takes the keyboard,
  // so a cut right after removes it again.
  await thumb.focus();
  await page.keyboard.press(`${mod}+KeyV`);
  await expect(objects).toHaveCount(count + 1);
  await expect(
    page.locator("#slide-canvas .object-hit.selected"),
  ).toBeFocused();
  await page.keyboard.press(`${mod}+KeyX`);
  await expect(objects).toHaveCount(count);
});

// Alt with an arrow moved slides in the Slide Sorter only; in the
// thumbnails pane it did nothing.
test("Alt+Up and Alt+Down in the navigator move the slide, which keeps the keyboard", async ({
  page,
}) => {
  await story(page);
  const parts = () =>
    page
      .locator("#slide-list .slide-item")
      .evaluateAll((rows) => rows.map((row) => row.dataset.slidePart));
  const before = await parts();
  await page.locator("#slide-list .slide-thumb").nth(1).click();
  await page.locator("#slide-list .slide-thumb").nth(1).focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect
    .poll(parts)
    .toEqual([before[0], before[2], before[1], before[3], before[4]]);
  await expect(page.locator("#slide-position")).toHaveText("Slide 3 of 5");
  const moved = page.locator(
    `#slide-list [data-slide-part="${before[1]}"] .slide-thumb`,
  );
  await expect(moved).toBeFocused();
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Alt+ArrowUp");
  await expect
    .poll(parts)
    .toEqual([before[1], before[0], before[2], before[3], before[4]]);
  await expect(moved).toBeFocused();
  await page.keyboard.press(`${mod}+KeyZ`);
  await expect
    .poll(parts)
    .toEqual([before[0], before[1], before[2], before[3], before[4]]);
});
