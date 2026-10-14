import { test, expect } from "@playwright/test";
import { P, createDeck, text, MIME } from "../src/model.js";

async function load(page, p) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Proofing text.pptx",
    mimeType: MIME,
    buffer: Buffer.from(await P.savePresentation(p)),
  });
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  return errors;
}

// A Review command, from its group when a narrow ribbon folds it.
async function reviewCommand(page, id) {
  const button = page.locator(
    `.ribbon-panel:not([hidden]) [data-command="${id}"]`,
  );
  if (!(await button.isVisible()))
    await page
      .locator(
        `.ribbon-panel:not([hidden]) .ribbon-group:has([data-command="${id}"]) > .ribbon-fold`,
      )
      .click();
  await page.locator(`[data-command="${id}"]:visible`).click();
}
const spelling = (page) => reviewCommand(page, "spelling");

test("imported title placeholders support accessibility and unselected spelling", async ({
  page,
}) => {
  const p = createDeck("blank");
  P.removeSlide(p, P.getSlides(p)[0]);
  P.addTitleSlide(p, "Quarterly roadmap");
  const errors = await load(page, p);
  await expect(page.locator("#status-accessibility")).toHaveText(
    "Accessibility: Good to go",
  );
  // From the status bar, which leaves the check to the Review tab on a phone.
  const status = page.locator("#status-accessibility");
  if (await status.isVisible()) await status.click();
  else {
    await page.getByRole("tab", { name: "Review", exact: true }).click();
    await reviewCommand(page, "check-accessibility");
  }
  const pane = page.getByRole("complementary", { name: "Accessibility" });
  // The title counts; only the empty subtitle is worth a tip.
  await expect(pane).toContainText("Empty placeholder (1)");
  await expect(pane).not.toContainText("Missing slide title");
  await pane.getByRole("button", { name: "Close pane" }).click();
  await expect(pane).toBeHidden();
  await expect(page.locator('.object-hit[aria-pressed="true"]')).toHaveCount(0);
  // Spelling reads the title without it being selected.
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await spelling(page);
  await expect(
    page.getByRole("complementary", { name: "Spelling" }),
  ).toContainText("Spelling check complete", { timeout: 20_000 });
  expect(errors).toEqual([]);
});

test("spelling finds unselected imported body text without a placeholder", async ({
  page,
}) => {
  const p = createDeck("blank");
  text(P.getSlides(p)[0], "Some body txet", 1, 1, 5, 1, 24, "#202020");
  const errors = await load(page, p);
  await expect(page.locator('.object-hit[aria-pressed="true"]')).toHaveCount(0);
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await spelling(page);
  const pane = page.getByRole("complementary", { name: "Spelling" });
  await expect(pane.locator(".spell-word")).toHaveText("txet", {
    timeout: 20_000,
  });
  await expect(pane.locator(".spell-context")).toContainText("Some body txet");
  expect(errors).toEqual([]);
});
