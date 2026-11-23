// The status bar under the slide: what its controls tell a screen reader.
import { test, expect } from "@playwright/test";

async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/");
  await expect(page.locator("#slide-canvas img")).toBeVisible();
}

test("the zoom slider reads as the zoom it sets", async ({ page }) => {
  await start(page);
  const slider = page.locator(".zoom-slider");
  const level = page.getByRole("button", { name: "Zoom level" });
  await expect(level).toHaveText(/^\d+%$/);
  await expect(slider).toHaveAttribute(
    "aria-valuetext",
    await level.innerText(),
  );
  // The slider's own scale runs 0-100; the zoom it sets is what is heard.
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(level).not.toHaveText(/Fit/);
  await expect(slider).toHaveAttribute(
    "aria-valuetext",
    await level.innerText(),
  );
  if (await slider.isVisible()) {
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveAttribute(
      "aria-valuetext",
      await level.innerText(),
    );
  }
});
