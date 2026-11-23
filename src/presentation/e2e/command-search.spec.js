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
  page.getByRole("listbox", { name: "Commands" }).getByRole("option");
const noMatch = (page) =>
  page
    .getByRole("listbox", { name: "Commands" })
    .getByText(/^No commands match/);

test("command search leaves out the tabs that are not showing", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "the search is in wide windows");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  const search = page.getByRole("combobox", { name: "Search for commands" });
  // Each letter searches again: commands that are off with nothing chosen
  // (Text Direction, Columns) are listed without reading the selection.
  await search.pressSequentially("cha");
  await expect(results(page).first()).toBeVisible();
  expect(errors).toEqual([]);
  // Picture Format and Table Design are not on the ribbon with nothing
  // chosen, and neither are their commands.
  await search.fill("crop");
  await expect(noMatch(page)).toBeVisible();
  await expect(results(page)).toHaveCount(0);
  await search.fill("shading");
  await expect(noMatch(page)).toBeVisible();
  await expect(results(page)).toHaveCount(0);
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
  const search = page.getByRole("combobox", { name: "Search for commands" });
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
  // The keyboard stays in the box; Down highlights the result.
  await search.press("ArrowDown");
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute(
    "aria-activedescendant",
    (await results(page).first().getAttribute("id")) ?? "",
  );
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Keyboard shortcuts" }),
  ).toBeVisible();
});

// The box is a combobox: it says whether its list is showing and which
// result is highlighted, Up and Down skip the commands that are off, Escape
// closes the list and then leaves, and the number found is announced.
test("command search is a combobox the keyboard works", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "the search is in wide windows");
  await start(page);
  const search = page.getByRole("combobox", { name: "Search for commands" });
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await expect(search).toHaveAttribute("aria-controls", "command-results");
  await search.fill("undo");
  await expect(search).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".command-search [role=status]")).toHaveText(
    /^\d+ commands?$/,
  );
  // Undo is off with nothing done: Down passes over it, here to nothing.
  await expect(results(page).first()).toHaveAttribute("aria-disabled", "true");
  await search.press("ArrowDown");
  await expect(search).not.toHaveAttribute("aria-activedescendant", /./);
  await search.fill("zoom");
  await search.press("ArrowDown");
  const active = await search.getAttribute("aria-activedescendant");
  expect(active).toBeTruthy();
  await expect(page.locator(`#${active}`)).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.locator(`#${active}`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await search.press("Escape");
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await expect(search).not.toHaveAttribute("aria-activedescendant", /./);
  await expect(search).toHaveValue("zoom");
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(search).not.toBeFocused();
  // A result chosen with the mouse runs, and the list goes.
  await search.fill("new slide");
  await page
    .getByRole("listbox", { name: "Commands" })
    .getByRole("option", { name: /^New Slide/ })
    .first()
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 2");
  await expect(search).toHaveAttribute("aria-expanded", "false");
});
