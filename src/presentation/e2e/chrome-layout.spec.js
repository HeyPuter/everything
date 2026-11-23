// The editor's frame at the window sizes people use: the title bar, the
// dialogs and the panels around the slide.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function mockPuter(page, { userMenu = false } = {}) {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `(()=>{${
        userMenu
          ? `customElements.define('puter-user-menu', class extends HTMLElement {
              constructor() {
                super();
                this.attachShadow({ mode: 'open' }).innerHTML =
                  '<button part="apps-button" style="width:32px;height:32px">A</button>' +
                  '<button part="sign-in">Sign in</button>';
              }
            });`
          : ""
      }window.puter={env:"web",auth:{isSignedIn:async()=>false},fs:{readdir:async()=>[]},ui:{onLaunchedWithItems:()=>{}}};})();`,
    }),
  );
}
async function story(page) {
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
}
const box = (locator) =>
  locator.evaluate((node) => {
    const { left, right } = node.getBoundingClientRect();
    return { left, right };
  });

// Laptop widths keep the menus beside the name: the name has to stay
// readable there, not slide under the search box beside it, and the save
// status shows its icon rather than a letter or two of its words.
for (const userMenu of [false, true])
  test(`the presentation's name stays clear of the title bar's actions at laptop widths${
    userMenu ? " (with the Puter user menu)" : ""
  }`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "laptop widths");
    await mockPuter(page, { userMenu });
    await story(page);
    const title = page.locator(".editor .document-title");
    const status = page.locator("#save-status");
    for (const width of [1440, 1366, 1280, 1261]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.getByRole("menubar")).toBeVisible();
      const name = await box(title);
      const actions = await box(page.locator(".editor .topbar-actions"));
      const menus = await box(page.getByRole("menubar"));
      const words = await box(status);
      expect(name.left, `${width}px`).toBeGreaterThanOrEqual(menus.right);
      expect(words.right, `${width}px`).toBeLessThanOrEqual(actions.left);
      // Wide enough for "The big…" at the least.
      expect(name.right - name.left, `${width}px`).toBeGreaterThanOrEqual(60);
      const shown = await status.evaluate((node) => {
        const span = node.querySelector("span");
        return span.getBoundingClientRect().width > 1
          ? span.scrollWidth <= span.clientWidth
          : true;
      });
      expect(shown, `${width}px: status cut short`).toBe(true);
      await expect(status).toHaveText("Saved on this device");
    }
  });

// Slide Sorter and Notes Page take the place of the slide and its panes,
// and of their main landmark, which a screen reader jumps to.
test("Slide Sorter and Notes Page are the page's main landmark", async ({
  page,
}) => {
  await mockPuter(page);
  await story(page);
  for (const label of ["Slide Sorter", "Notes Page", "Normal"]) {
    const bar = page
      .getByRole("menubar")
      .getByRole("menuitem", { name: "View", exact: true });
    if (await bar.isVisible()) await bar.click();
    else {
      await page.getByRole("button", { name: "File options" }).click();
      await page.getByRole("menuitem", { name: "View", exact: true }).click();
    }
    await page
      .getByRole("menuitemcheckbox", { name: new RegExp(`^${label}`) })
      .click();
    await expect(page.getByRole("main")).toHaveCount(1);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations, label).toEqual([]);
  }
});
