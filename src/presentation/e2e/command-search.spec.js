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
