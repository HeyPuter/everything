import { test, expect } from "@playwright/test";

// puter.js's <puter-user-menu>: where the SDK defines it, it sits after a
// Settings button and holds the Apps launcher and the account; the app's own
// Apps and account buttons stand down, and its Sign out is the app's. The SDK
// and the element are stubbed: an open shadow root with the Sign out item, as
// the real element has, defined before `window.puter` as the SDK does.
async function mockPuter(page, { env = "web", signedIn = true } = {}) {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `(()=>{
        customElements.define('puter-user-menu', class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: 'open' }).innerHTML =
              '<button class="avatar" part="avatar">T</button>' +
              '<div class="menu"><button class="menu-item sign-out">Sign out</button></div>';
            this.shadowRoot.querySelector('.sign-out').addEventListener('click', () => {
              window.elementSignOuts = (window.elementSignOuts || 0) + 1;
            });
          }
        });
        let signedIn=${signedIn};window.sdkSignOuts=0;window.setSignedIn=(value)=>{signedIn=value};
        window.puter={env:${JSON.stringify(env)},auth:{isSignedIn:async()=>signedIn,getUser:async()=>({username:'test-user',uuid:'test-user-id'}),signIn:async()=>{signedIn=true},signOut:async()=>{signedIn=false;window.sdkSignOuts++}},fs:{readdir:async()=>[],write:async()=>({})},ui:{onLaunchedWithItems:()=>{}}};})();`,
    }),
  );
}
const userMenu = (page) => page.locator(".header-right puter-user-menu");
const settingsButton = (page) =>
  page.getByRole("button", { name: "Settings", exact: true });

test("the user menu follows a Settings button and stands in for the Apps and account buttons", async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto("/#/home");
  await expect(userMenu(page)).toHaveCount(1);
  expect(
    await userMenu(page).evaluate((menu) =>
      menu.previousElementSibling?.getAttribute("aria-label"),
    ),
  ).toBe("Settings");
  await expect(page.locator(".apps-btn")).toHaveCount(0);
  await expect(page.locator(".account-button")).toHaveCount(0);

  // Settings keeps what the account menu held besides the account.
  await settingsButton(page).click();
  const menu = page.getByRole("menu", { name: "Settings" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Appearance",
    "Keyboard shortcuts",
  ]);

  // The element follows an explicit color mode, and the OS otherwise.
  await expect(userMenu(page)).not.toHaveAttribute("theme", /./);
  await menu.getByRole("menuitem", { name: "Appearance" }).click();
  await page.getByLabel("Color mode").selectOption("dark");
  await expect(userMenu(page)).toHaveAttribute("theme", "dark");
  await page.getByLabel("Color mode").selectOption("system");
  await expect(userMenu(page)).not.toHaveAttribute("theme", /./);
});

test("the editor has it too, and its Sign out is the app's", async ({
  page,
  isMobile,
}) => {
  await mockPuter(page);
  await page.goto("/");
  await expect(userMenu(page)).toHaveCount(1);
  // Phones keep the account in File options and leave it out of the header.
  if (!isMobile) await expect(userMenu(page)).toBeVisible();
  // The full title bar has no Settings button: View and Help hold its items.
  await expect(settingsButton(page)).toHaveCount(0);
  await userMenu(page).evaluate((menu) =>
    menu.shadowRoot.querySelector(".sign-out").click(),
  );
  // Signed out by the app, which lands on the library.
  await expect(page.locator(".home")).toBeVisible();
  expect(
    await page.evaluate(() => [
      window.sdkSignOuts,
      window.elementSignOuts || 0,
    ]),
  ).toEqual([1, 0]);
});

test("the app follows a sign-in and a sign-out the element did by itself", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: false });
  await page.goto("/");
  const save = page.locator(".save-button");
  await expect(save).toHaveAttribute("aria-label", "Sign in to save");
  await page.evaluate(() => {
    window.setSignedIn(true);
    document
      .querySelector("puter-user-menu")
      .dispatchEvent(new CustomEvent("signin", { detail: { user: null } }));
  });
  await expect(save).toHaveAttribute("aria-label", "Save");
  await page.evaluate(() => {
    window.setSignedIn(false);
    document
      .querySelector("puter-user-menu")
      .dispatchEvent(new CustomEvent("signout"));
  });
  await expect(save).toHaveAttribute("aria-label", "Sign in to save");
});

test("a Puter app window keeps the app's own account button", async ({
  page,
}) => {
  await mockPuter(page, { env: "app" });
  await page.goto("/#/home");
  await expect(page.locator(".account-button")).toBeVisible();
  await expect(userMenu(page)).toHaveCount(0);
});
