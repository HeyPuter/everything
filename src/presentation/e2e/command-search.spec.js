// The title bar's command search: it finds the commands the ribbon offers
// now, and only those.
import { test, expect } from "@playwright/test";

async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Home" })).toBeVisible();
}
const results = (page) =>
  page.getByRole("menu", { name: "Commands" }).getByRole("menuitem");

test("command search leaves out the tabs that are not showing", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "the search is in wide windows");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  const search = page.getByRole("searchbox", { name: "Search for commands" });
  // Each letter searches again: commands that are off with nothing chosen
  // (Text Direction, Columns) are listed without reading the selection.
  await search.pressSequentially("cha");
  await expect(results(page).first()).toBeVisible();
  expect(errors).toEqual([]);
  // Picture Format and Table Design are not on the ribbon with nothing
  // chosen, and neither are their commands.
  await search.fill("crop");
  await expect(results(page)).toHaveText([/^No commands match/]);
  await search.fill("shading");
  await expect(results(page)).toHaveText([/^No commands match/]);
  await search.press("Escape");

  await page.getByRole("menuitem", { name: "Insert", exact: true }).click();
  await page.getByRole("menuitem", { name: "Table", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Insert table" })
    .getByRole("button", { name: "Insert", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: "Table Design" })).toBeVisible();
  await search.fill("shading");
  await expect(results(page).first()).toHaveText(/^Shading\s*Table Design/);
  expect(errors).toEqual([]);
});

// Commands only the menu bar has are found too, each named with its menu,
// and a name on both the ribbon and a menu is listed once.
test("command search finds the menu bar's commands", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the search is in wide windows");
  await start(page);
  const search = page.getByRole("searchbox", { name: "Search for commands" });
  // The menus are read while the page is idle after the box takes the
  // keyboard (a letter typed at once reads them then, as below).
  await search.focus();
  await page.waitForTimeout(400);
  await search.fill("print");
  await expect(results(page).filter({ hasText: "Print…" })).toHaveText([
    /^Print…\s*File/,
  ]);
  await search.fill("undo");
  await expect(results(page)).toHaveText([/^Undo\s*Edit/]);
  await expect(results(page).first()).toBeDisabled();
  await search.fill("export to video");
  await expect(results(page).first()).toBeVisible();
  await expect(results(page).filter({ hasText: /^Export to/ })).toHaveCount(1);
  await search.fill("keyboard shortcuts");
  await expect(results(page)).toHaveCount(1);
  await search.press("Enter");
  await expect(results(page).first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Keyboard shortcuts" }),
  ).toBeVisible();
});
