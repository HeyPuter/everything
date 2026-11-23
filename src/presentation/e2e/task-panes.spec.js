// The task panes beside the slide: Escape closes them.
import { test, expect } from "@playwright/test";

const mod = process.platform === "darwin" ? "Meta" : "Control";

test("Escape closes the Selection Pane and gives the keyboard to the slide", async ({
  page,
}) => {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Home" })).toBeVisible();
  await page.locator("#main").focus();
  await page.keyboard.press(`${mod}+Alt+KeyU`);
  const pane = page.getByRole("complementary", { name: "Selection" });
  await expect(pane).toBeVisible();
  await expect(pane).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(pane).toBeHidden();
  await expect(page.locator("#main")).toBeFocused();
});
