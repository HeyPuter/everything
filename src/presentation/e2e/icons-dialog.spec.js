// The Insert Icons dialog, as a screen reader meets it.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("a search that finds no icons says so without breaking the list", async ({
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
  const bar = page.getByRole("menubar");
  if (await bar.isVisible())
    await bar.getByRole("menuitem", { name: "Insert", exact: true }).click();
  else {
    await page.getByRole("button", { name: "File options" }).click();
    await page.getByRole("menuitem", { name: "Insert", exact: true }).click();
  }
  await page.getByRole("menuitem", { name: "Icons…" }).click();
  const dialog = page.getByRole("dialog", { name: "Insert Icons" });
  const list = dialog.getByRole("listbox", { name: "Icons" });
  await expect(list.getByRole("option").first()).toBeVisible();
  await dialog.getByRole("searchbox", { name: "Search icons" }).fill("zzqx");
  await expect(dialog.getByText("No icons match your search.")).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .include("dialog[open]")
    .analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  await dialog.getByRole("searchbox", { name: "Search icons" }).fill("");
  await expect(list.getByRole("option").first()).toBeVisible();
  await expect(dialog.getByText("No icons match your search.")).toBeHidden();
});
