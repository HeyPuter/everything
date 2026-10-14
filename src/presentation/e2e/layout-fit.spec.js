// The page never grows wider than the screen: on a phone a wider page zooms
// out to fit, which shrinks every control and shifts the dialogs. The
// editor's bars, its panes and the library all have to fit as they are.
import { test, expect } from "@playwright/test";

test.setTimeout(90_000);

async function stub(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
}
// Nothing scrolls sideways, and the layout viewport is the screen's width (a
// phone widens it to show content that does not fit).
async function expectFits(page, where) {
  const width = page.viewportSize().width;
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          inner: innerWidth,
        })),
      { message: `${where} fits ${width}px` },
    )
    .toEqual({ scroll: width, inner: width });
}
// Every control in the title bar and the status bar is on screen, and none
// covers another.
async function expectBarsFit(page) {
  const problems = await page.evaluate(() => {
    const out = [];
    for (const bar of document.querySelectorAll(
      ".editor-header, .status-bar",
    )) {
      const items = [
        ...bar.querySelectorAll("button, .save-status, #slide-position"),
      ].filter((e) => e.getBoundingClientRect().width > 0);
      for (const [i, a] of items.entries()) {
        const r = a.getBoundingClientRect();
        if (r.left < -0.5 || r.right > innerWidth + 0.5)
          out.push(`${a.id || a.className} is off screen`);
        for (const b of items.slice(i + 1)) {
          if (a.contains(b) || b.contains(a)) continue;
          const s = b.getBoundingClientRect();
          if (
            r.left < s.right - 1 &&
            s.left < r.right - 1 &&
            r.top < s.bottom - 1 &&
            s.top < r.bottom - 1
          )
            out.push(`${a.id || a.className} covers ${b.id || b.className}`);
        }
      }
    }
    return out;
  });
  expect(problems).toEqual([]);
}
// A ribbon command, from the group a narrow ribbon folds it into if need be.
async function command(page, tab, id) {
  await page.getByRole("tab", { name: tab, exact: true }).click();
  const target = page
    .locator(`.ribbon-panel:not([hidden]) [data-command="${id}"]`)
    .first();
  if (await target.isVisible()) return target.click();
  await page
    .locator(
      `.ribbon-panel:not([hidden]) .ribbon-group:has([data-command="${id}"]) > .ribbon-fold`,
    )
    .click();
  await page
    .locator(`.ribbon-fold-panel [data-command="${id}"]`)
    .first()
    .click();
}

test("the editor fits the screen with each of its panes open", async ({
  page,
}) => {
  await stub(page);
  await page.goto("/");
  await expect(page.locator(".editor")).toBeVisible();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  await expectFits(page, "the editor");
  await expectBarsFit(page);

  for (const [tab, id, pane] of [
    ["View", "view-format-pane", "#inspector"],
    ["View", "view-assistant", ".ai-panel"],
    ["Review", "show-comments", "#review-pane"],
    ["Review", "check-accessibility", "#review-pane"],
    ["Animations", "animation-pane", ".animation-pane"],
  ]) {
    await command(page, tab, id);
    await expect(page.locator(pane).first()).toBeVisible();
    await expectFits(page, `the editor with ${id}`);
    await expectBarsFit(page);
    // A fresh editor for the next pane.
    await page.reload();
    await expect(page.locator(".editor")).toBeVisible();
  }
});

test("the library fits the screen", async ({ page }) => {
  await stub(page);
  await page.goto("/#/home");
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
  await expectFits(page, "the library");
});
