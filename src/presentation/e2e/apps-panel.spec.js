import { test, expect } from "@playwright/test";

// Puter's SDK, signed out unless asked; the embed is a stub page.
async function mockPuter(page, { signedIn = false, env = "web" } = {}) {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `(()=>{let signedIn=${signedIn};window.puter={env:${JSON.stringify(env)},auth:{isSignedIn:async()=>signedIn,getUser:async()=>({username:'test-user',uuid:'test-user-id'}),signIn:async()=>{signedIn=true},signOut:async()=>{signedIn=false}},fs:{readdir:async()=>[],write:async()=>({})},ui:{onLaunchedWithItems:()=>{}}};})();`,
    }),
  );
  await page.route("https://puter.com/embed/apps", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Apps</title><p>Your apps</p>",
    }),
  );
}
const appsButton = (page) =>
  page.getByRole("button", { name: "Apps", exact: true });
const appsPanel = (page) => page.getByRole("dialog", { name: "Apps" });

test("the Apps button opens Puter's apps under it, left of the account button", async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto("/#/home");
  const button = appsButton(page);
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("aria-haspopup", "dialog");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  // Immediately left of the account button.
  expect(
    await button.evaluate((b) =>
      b.nextElementSibling?.classList.contains("account-button"),
    ),
  ).toBe(true);

  await button.click();
  const panel = appsPanel(page);
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const frame = panel.locator("iframe");
  await expect(frame).toHaveAttribute("src", "https://puter.com/embed/apps");
  await expect(frame).toHaveAttribute("title", "Your Puter apps");
  await expect(frame).toHaveAttribute(
    "referrerpolicy",
    "strict-origin-when-cross-origin",
  );
  await expect(frame).toHaveAttribute(
    "allow",
    "clipboard-read; clipboard-write",
  );
  const newTab = panel.getByRole("link", {
    name: "Open Puter apps in a new tab",
  });
  await expect(newTab).toHaveAttribute("href", "https://puter.com/#apps");
  await expect(newTab).toHaveAttribute("target", "_blank");
  await expect(newTab).toHaveAttribute("rel", "noopener noreferrer");
  // The spinner goes once the frame has loaded.
  await expect(panel.locator(".apps-panel-body")).not.toHaveClass(/is-loading/);

  // Under the button, the caret on its centre.
  const geometry = await page.evaluate(() => {
    const b = document.querySelector(".apps-btn").getBoundingClientRect();
    const p = document.querySelector(".apps-panel");
    const box = p.getBoundingClientRect();
    return {
      below: box.top - b.bottom,
      caret:
        box.left +
        parseFloat(p.style.getPropertyValue("--apps-caret-x")) -
        (b.left + b.width / 2),
      insideViewport: box.right <= innerWidth && box.left >= 0,
    };
  });
  expect(geometry.below).toBeGreaterThanOrEqual(8);
  expect(Math.abs(geometry.caret)).toBeLessThan(1);
  expect(geometry.insideViewport).toBe(true);

  // Escape closes it and gives the focus back to the button.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "false");

  // Reopening keeps the same embed; a press elsewhere closes it.
  await button.click();
  await expect(panel).toBeVisible();
  expect(await page.locator(".apps-panel").count()).toBe(1);
  await page.locator(".home-header .brand").click();
  await expect(panel).toBeHidden();

  // ✕ closes it too.
  await button.click();
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toBeHidden();
  await expect(button).toBeFocused();
});

test("the account menu and the Apps panel never show together", async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto("/#/home");
  const account = page.getByRole("button", { name: "Account and settings" });
  await account.click();
  await expect(page.getByRole("menu", { name: "Account" })).toBeVisible();
  await appsButton(page).click();
  await expect(appsPanel(page)).toBeVisible();
  await expect(page.getByRole("menu", { name: "Account" })).toBeHidden();
  // Opened from the keyboard, the account menu closes the panel.
  await account.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu", { name: "Account" })).toBeVisible();
  await expect(appsPanel(page)).toBeHidden();
});

test("the embed follows the app's light or dark choice", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await mockPuter(page);
  await page.goto("/#/home");
  await appsButton(page).click();
  const frame = appsPanel(page).locator("iframe");
  await expect(frame).toHaveCSS("color-scheme", "light");
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await expect(frame).toHaveCSS("color-scheme", "dark");
  await page.evaluate(
    () => (document.documentElement.dataset.theme = "system"),
  );
  await expect(frame).toHaveCSS("color-scheme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(frame).toHaveCSS("color-scheme", "dark");
});

test("signing in reloads the embed for the new account", async ({ page }) => {
  await mockPuter(page);
  await page.goto("/#/home");
  await appsButton(page).click();
  await expect(appsPanel(page)).toBeVisible();
  await page.evaluate(() => {
    document.querySelector(".apps-panel").dataset.first = "yes";
  });
  await page.getByRole("button", { name: "Account and settings" }).click();
  await page.getByRole("menuitem", { name: /Sign in with Puter/ }).click();
  await expect(page.locator(".account-button")).toContainText("test-user");
  await appsButton(page).click();
  await expect(appsPanel(page)).toBeVisible();
  await expect(page.locator(".apps-panel")).toHaveCount(1);
  await expect(page.locator(".apps-panel")).not.toHaveAttribute(
    "data-first",
    "yes",
  );
});

test("the editor offers the Apps button left of the account button", async ({
  page,
  isMobile,
}) => {
  await mockPuter(page);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Present", exact: true }),
  ).toBeVisible();
  const button = page.locator(".editor-header .apps-btn");
  expect(
    await button.evaluate((b) =>
      b.nextElementSibling?.classList.contains("account-button"),
    ),
  ).toBe(true);
  // Phones keep the account menu in File options and leave this out too.
  if (isMobile) {
    await expect(button).toBeHidden();
    return;
  }
  await button.click();
  await expect(appsPanel(page)).toBeVisible();
  // Leaving for the library takes the button away, and the panel with it.
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await expect(appsPanel(page)).toBeHidden();
});

test("inside a Puter app window the desktop's own launcher is used", async ({
  page,
}) => {
  await mockPuter(page, { env: "app" });
  await page.goto("/#/home");
  await expect(
    page.getByRole("button", { name: "Account and settings" }),
  ).toBeVisible();
  await expect(page.locator(".apps-btn")).toHaveCount(0);
});
