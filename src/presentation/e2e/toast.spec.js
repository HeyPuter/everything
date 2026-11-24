// Messages at the foot of the window: long enough to read, held under the
// pointer, and dismissed with their button.
import { test, expect } from "@playwright/test";

async function start(page) {
  await page.clock.install();
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Home" })).toBeVisible();
}
// Deleting the only slide is refused with a message.
async function refuse(page) {
  await page.locator(".slide-thumb").first().focus();
  await page.keyboard.press("Delete");
}
const MESSAGE = "Keep at least one slide in your presentation.";

test("a message can be held and dismissed", async ({ page }) => {
  await start(page);
  const toast = page.getByRole("status").filter({ hasText: MESSAGE });
  await refuse(page);
  await expect(toast).toBeVisible();
  await expect(page.locator("#toast")).toHaveText(MESSAGE);
  // It goes by itself after a few seconds.
  await page.clock.runFor(6000);
  await expect(page.locator("#toast")).not.toHaveClass(/visible/);

  // Its words let the pointer through to what they cover.
  await refuse(page);
  await expect(toast).toBeVisible();
  const words = await page.locator("#toast .toast-text").boundingBox();
  expect(
    await page.evaluate(
      ([x, y]) => !!document.elementFromPoint(x, y)?.closest("#toast"),
      [words.x + words.width / 2, words.y + words.height / 2],
    ),
  ).toBe(false);
  // Under the pointer its button holds it, until the pointer leaves.
  await page.locator("#toast .toast-close").hover();
  await page.clock.runFor(30000);
  await expect(toast).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(6000);
  await expect(page.locator("#toast")).not.toHaveClass(/visible/);

  // Its button dismisses it at once.
  await refuse(page);
  await expect(toast).toBeVisible();
  await page.getByRole("button", { name: "Dismiss message" }).click();
  await expect(page.locator("#toast")).not.toHaveClass(/visible/);
});

// A new message arriving while the pointer holds the last one is held too,
// and goes its own time after the pointer leaves.
test("a message that arrives under the pointer is held", async ({ page }) => {
  await start(page);
  const toast = page.locator("#toast");
  await refuse(page);
  await expect(toast).toHaveClass(/visible/);
  await page.locator("#toast .toast-close").hover();
  await page.clock.runFor(2000);
  await refuse(page);
  await page.locator("#toast .toast-close").hover();
  await page.clock.runFor(30000);
  await expect(toast).toHaveClass(/visible/);
  await page.mouse.move(0, 0);
  await page.clock.runFor(1000);
  await expect(toast).toHaveClass(/visible/);
  await page.clock.runFor(6000);
  await expect(toast).not.toHaveClass(/visible/);
});
