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

// Resolving or deleting a comment redraws the Comments pane; the keyboard
// stays in the pane, on what took the pressed control's place, instead of
// dropping out of the page.
test("the Comments pane keeps the keyboard when a comment is resolved or deleted", async ({
  page,
}) => {
  const MOD = process.platform === "darwin" ? "Meta" : "Control";
  await mockPuter(page);
  await story(page);
  const pane = page.locator("#review-pane");
  await page.locator(".object-hit").first().click();
  await page.keyboard.press(`${MOD}+Shift+M`);
  for (const text of ["First note", "Second note"]) {
    if (text !== "First note")
      await pane.getByRole("button", { name: "New comment" }).click();
    await pane.getByRole("textbox", { name: "New comment" }).fill(text);
    await pane.getByRole("button", { name: "Post", exact: true }).click();
    if (text === "First note") {
      await page.getByRole("textbox", { name: "Your name" }).fill("Ada");
      await page.getByRole("button", { name: "Continue" }).click();
    }
    await expect(pane.getByText(text)).toBeVisible();
  }
  const threads = pane.locator(".comment-thread");
  await expect(threads).toHaveCount(2);
  const first = threads.first();
  await first.getByRole("textbox", { name: "Reply" }).fill("A reply");
  await first.getByRole("textbox", { name: "Reply" }).press(`${MOD}+Enter`);
  await expect(first.locator(".comment-reply")).toHaveCount(1);
  const choose = async (button, item) => {
    await button.focus();
    await page.keyboard.press("Enter");
    await page.locator('[role^="menuitem"]', { hasText: item }).first().focus();
    await page.keyboard.press("Enter");
  };
  // A reply deleted: its comment has the focus.
  await choose(
    first.getByRole("button", { name: "Reply options" }),
    "Delete Reply",
  );
  await expect(first.locator(".comment-reply")).toHaveCount(0);
  await expect(threads.first()).toBeFocused();
  // Resolved: the focus is on Reopen, to take it back.
  await threads.first().getByRole("button", { name: "Resolve thread" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    threads.first().getByRole("button", { name: "Reopen thread" }),
  ).toBeFocused();
  // A comment deleted: the one after it has the focus.
  await choose(
    threads.first().getByRole("button", { name: "Comment options" }),
    "Delete Thread",
  );
  await expect(threads).toHaveCount(1);
  await expect(threads.first()).toBeFocused();
  await expect(threads.first()).toContainText("Second note");
  // A filter chosen: its button keeps the focus.
  await choose(
    pane.getByRole("button", { name: "Filter comments" }),
    "Open comments",
  );
  await expect(
    pane.getByRole("button", { name: "Filter comments" }),
  ).toBeFocused();
});

// A ribbon button's tip names the shortcut that does what the button does.
test("the Bring Forward and Send Backward tips name their own shortcuts", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "keyboard shortcuts");
  await mockPuter(page);
  await story(page);
  const order = () =>
    page
      .locator("#slide-canvas .object-hit")
      .evaluateAll((hits) => hits.map((hit) => hit.dataset.shapeId));
  const press = async (command) => {
    const tip = await page
      .locator(`[data-command="${command}"]`)
      .first()
      .getAttribute("data-tip-title");
    const keys = tip
      .match(/\((.+)\)$/)[1]
      .replace("⌘", "Meta")
      .replace("Ctrl", "Control");
    await page.keyboard.press(keys);
  };
  await page.getByRole("tab", { name: "Home", exact: true }).click();
  const before = await order();
  expect(before.length).toBeGreaterThan(2);
  await page.locator(`#slide-canvas [data-shape-id="${before[0]}"]`).click();
  await press("bring-forward");
  await expect.poll(order).toEqual([before[1], before[0], ...before.slice(2)]);
  await press("send-backward");
  await expect.poll(order).toEqual(before);
});

// The menu bar writes every shortcut one way on a Mac: keys joined by "+",
// with ⌘ and ⌥ for Command and Option.
test("menu shortcuts are written one way on a Mac", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the menu bar");
  await mockPuter(page);
  await story(page);
  expect(await page.evaluate(() => navigator.platform)).toMatch(/Mac/);
  await page.locator("#slide-canvas .object-hit").first().click();
  const shortcuts = [];
  for (const name of ["Edit", "View", "Format", "Arrange", "Tools"]) {
    await page
      .getByRole("menubar")
      .getByRole("menuitem", { name, exact: true })
      .click();
    shortcuts.push(
      ...(await page.locator('[role="menu"] .menu-shortcut').allTextContents()),
    );
    await page.keyboard.press("Escape");
  }
  expect(shortcuts).toContain("⌘+⌥+G");
  expect(shortcuts).toContain("⌘+T");
  expect(shortcuts.filter((s) => /Alt|[⌘⌥⌃⇧](?!\+)/.test(s))).toEqual([]);
});
