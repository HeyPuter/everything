// Keys in the app's dialogs: Enter in a box presses the main button.
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
// The menu bar, or on a phone the File options menu that holds the File
// menu's commands.
async function menuCommand(page, menu, item) {
  const bar = page.getByRole("menubar");
  if (await bar.isVisible())
    await bar.getByRole("menuitem", { name: menu, exact: true }).click();
  else await page.getByRole("button", { name: "File options" }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test("Enter in Properties saves them", async ({ page }) => {
  await start(page);
  await menuCommand(page, "File", "Properties");
  const dialog = page.getByRole("dialog", { name: "Properties" });
  const title = dialog.getByRole("textbox", { name: "Title" });
  await title.fill("Field notes");
  await title.press("Enter");
  await expect(dialog).toBeHidden();
  await menuCommand(page, "File", "Properties");
  await expect(title).toHaveValue("Field notes");
});

test("Enter in Set Up Slide Show's slide numbers chooses OK", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "a phone's File options menu has no Slide Show menu",
  );
  await start(page);
  await menuCommand(page, "Slide Show", "Set Up Slide Show…");
  const dialog = page.getByRole("dialog", { name: "Set Up Slide Show" });
  await dialog.getByRole("radio", { name: "From" }).check();
  const to = dialog.getByRole("spinbutton", { name: "To slide" });
  await to.fill("1");
  await to.press("Enter");
  await expect(dialog).toBeHidden();
});
