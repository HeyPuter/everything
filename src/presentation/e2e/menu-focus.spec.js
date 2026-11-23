// Where the keyboard goes after a menu bar command: to the view on show.
import { test, expect } from "@playwright/test";

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

test("a menu bar command in Notes Page or Slide Sorter hands the keyboard to the view", async ({
  page,
}) => {
  await story(page);
  const bar = page.getByRole("menubar");
  test.skip(!(await bar.isVisible()), "the menu bar is in wide windows");
  const command = async (menu, item) => {
    await bar.getByRole("menuitem", { name: menu, exact: true }).click();
    // Views and Ruler are check items, so items are found by their label.
    await page
      .locator('.menu [role^="menuitem"]')
      .filter({ has: page.getByText(item, { exact: true }) })
      .click();
  };
  for (const view of ["Notes Page", "Slide Sorter"]) {
    await command("View", view);
    await command("View", "Ruler");
    // Not left on the menu bar's View, where the arrows walk the menus.
    await expect(page.locator("#view-host")).toBeFocused();
    await command("View", "Normal");
    await expect(page.locator("#main")).toBeFocused();
  }
});
