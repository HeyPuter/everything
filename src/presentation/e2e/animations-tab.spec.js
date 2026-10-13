import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, createDeck, parseDeck, shape, text } from "../src/model.js";

const SHOTS = process.env.ANIM_SHOTS || "";

function twoShapes() {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  shape(slide, 1, 1.5, 2.5, 1.6, "#2266cc");
  text(slide, "Alpha\nBeta\nGamma", 5.5, 1.5, 5, 3);
  return pres;
}

async function load(page, pres) {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  const choose = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await choose
  ).setFiles({
    name: "Animations.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".slide-image")).toBeVisible();
}

async function download(page) {
  await page
    .getByRole("menuitem", { name: "File", exact: true })
    .or(page.getByRole("button", { name: "File options" }))
    .filter({ visible: true })
    .click();
  const result = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  return parseDeck(await readFile(await (await result).path()));
}

const hits = (page) => page.locator("#slide-canvas .object-hit");
// A ribbon command, from its folded group's drop-down when the ribbon is
// too narrow to show the group.
async function command(page, group, find) {
  const direct = find(page.locator(".ribbon-body"));
  if (await direct.isVisible()) return direct;
  await page
    .locator(`#ribbon-panel-animations .ribbon-fold[title="${group}"]`)
    .click();
  return find(page.locator(".ribbon-fold-panel"));
}
async function openTab(page) {
  const tab = page.getByRole("tab", { name: "Animations", exact: true });
  if (!(await tab.isVisible())) test.skip(true, "The ribbon is folded away");
  await tab.click();
}
const gallery = (page) =>
  page.getByRole("listbox", { name: "Animations", exact: true });
async function pick(page, name) {
  const visible = gallery(page).getByRole("option", { name, exact: true });
  if (await visible.isVisible()) return visible.click();
  await page.getByRole("button", { name: "More Animations" }).click();
  await page
    .locator(".ribbon-gallery-panel")
    .getByRole("option", { name, exact: true })
    .click();
}

test("effects are applied, timed, reordered and saved from the Animations tab", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Long ribbon workflow; the phone test below covers the tab and pane on a phone",
  );
  await load(page, twoShapes());
  await openTab(page);
  // Nothing selected: the gallery waits for an object.
  await expect(gallery(page).getByRole("option").first()).toBeDisabled();
  await hits(page).first().click();
  await pick(page, "Fly In");
  await expect(page.locator(".anim-badge")).toHaveCount(1);
  await expect(page.locator(".anim-badge").first()).toHaveText("1");
  // Effect Options: from the left.
  await page.getByRole("button", { name: "Effect Options" }).click();
  await page.getByRole("menuitemcheckbox", { name: "From Left" }).click();
  // Duration and delay.
  const duration = await command(page, "Timing", (at) =>
    at.getByRole("spinbutton", { name: "Duration" }),
  );
  await duration.fill("1.5");
  await duration.press("Enter");
  await page.keyboard.press("Escape");
  // Add a second effect to the text, after the first.
  await hits(page).nth(1).click();
  await pick(page, "Wipe");
  const start = await command(page, "Timing", (at) =>
    at.getByRole("combobox", { name: "Start" }),
  );
  await start.fill("After Previous");
  await start.press("Enter");
  await page.keyboard.press("Escape");
  // Add an emphasis to the box as well.
  await hits(page).first().click();
  await (
    await command(page, "Advanced Animation", (at) =>
      at.getByRole("button", { name: "Add Animation" }),
    )
  ).click();
  await page.getByRole("menuitem", { name: "Spin" }).click();
  // The Animation Pane lists the three in order.
  await (
    await command(page, "Advanced Animation", (at) =>
      at.getByRole("button", { name: "Animation Pane" }),
    )
  ).click();
  const pane = page.getByRole("complementary", { name: "Animation Pane" });
  await expect(pane).toBeVisible();
  const rows = pane.getByRole("option");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute("aria-label", /^1\. Fly In/);
  await expect(rows.nth(1)).toHaveAttribute(
    "aria-label",
    /Wipe.*After Previous/,
  );
  await expect(rows.nth(2)).toHaveAttribute("aria-label", /^2\. Spin/);
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/editor-${info.project.name}.png` });
  // Move the Spin earlier with the keyboard.
  await rows.nth(2).click();
  await rows.nth(2).press("Alt+ArrowUp");
  await expect(rows.nth(1)).toHaveAttribute("aria-label", /Spin/);
  // Preview plays on the canvas and ends on its own.
  await pane
    .getByRole("button", { name: /^(Play All|Play From|Stop)$/ })
    .click();
  if ((await page.locator("#slide-canvas .anim-preview").count()) === 0)
    await pane.getByRole("button", { name: /^(Play All|Play From)$/ }).click();
  await expect(page.locator("#slide-canvas .anim-preview")).toBeVisible();
  await expect(page.locator("#slide-canvas .anim-preview")).toHaveCount(0, {
    timeout: 10000,
  });
  const saved = await download(page);
  const effects = P.getSlideAnimations(P.getSlides(saved)[0]);
  expect(effects.map((e) => [e.presetClass, e.presetId, e.start])).toEqual([
    ["entr", 2, "click"],
    ["emph", 8, "click"],
    ["entr", 22, "after"],
  ]);
  expect(effects[0].presetSubtype).toBe(8);
  expect(effects[0].durationMs).toBe(1500);
});

test("text builds by paragraph and the effect options dialog changes timing", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Long ribbon workflow; the phone test below covers the tab and pane on a phone",
  );
  await load(page, twoShapes());
  await openTab(page);
  await hits(page).nth(1).click();
  await pick(page, "Fade");
  await page.getByRole("button", { name: "Effect Options" }).click();
  await page.getByRole("menuitemcheckbox", { name: "By Paragraph" }).click();
  await expect(page.locator(".anim-badge span")).toHaveText(["1", "2", "3"]);
  await (
    await command(page, "Advanced Animation", (at) =>
      at.getByRole("button", { name: "Animation Pane" }),
    )
  ).click();
  const pane = page.getByRole("complementary", { name: "Animation Pane" });
  const row = pane.getByRole("option").first();
  await row.click();
  await row.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Timing" }).click();
  await dialog.getByRole("combobox", { name: "Repeat" }).selectOption("2");
  await dialog.getByRole("spinbutton", { name: "Delay (seconds)" }).fill("0.5");
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(row).toHaveAttribute("aria-label", /delay 0\.50 s/);
  const saved = await download(page);
  const [effect] = P.getSlideAnimations(P.getSlides(saved)[0]);
  expect(effect).toMatchObject({
    presetClass: "entr",
    presetId: 10,
    delayMs: 500,
    repeat: 2,
    text: { by: "paragraph", level: 1 },
  });
});

test("the Animations tab is reachable and usable on a phone", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile", "Phone layout only");
  await load(page, twoShapes());
  const tab = page.getByRole("tab", { name: "Animations", exact: true });
  await tab.scrollIntoViewIfNeeded();
  await tab.click();
  await hits(page).first().click();
  await gallery(page)
    .getByRole("option", { name: "Fade", exact: true })
    .click();
  await (
    await command(page, "Advanced Animation", (at) =>
      at.getByRole("button", { name: "Animation Pane" }),
    )
  ).click();
  const pane = page.getByRole("complementary", { name: "Animation Pane" });
  await expect(pane).toBeVisible();
  await expect(pane.getByRole("option")).toHaveCount(1);
  // The pane fits the phone's screen.
  const box = await pane.boundingBox();
  const width = page.viewportSize().width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
});
