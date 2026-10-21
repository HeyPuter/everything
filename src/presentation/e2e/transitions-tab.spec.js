// The Transitions tab: the grouped gallery, effect options, duration, sound,
// advance timing, Apply To All, Preview, the navigator's mark, and playback
// in the slide show, checked through the file the app downloads.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";

test.setTimeout(120_000);

async function load(page, pres) {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
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
    name: "Transitions.pptx",
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
  const bytes = await readFile(await (await result).path());
  return { pres: await parseDeck(bytes), files: unzipSync(bytes) };
}
// The transition playing over `scope`: its effect, direction and duration.
async function playing(page, scope = "") {
  const handle = await page.waitForFunction((scope) => {
    const node = document.querySelector(`${scope} .slide-transition`);
    const clock = node?.getAnimations()[0];
    return clock
      ? {
          effect: node.dataset.effect,
          direction: node.dataset.direction,
          duration: clock.effect.getTiming().duration,
        }
      : null;
  }, scope);
  return handle.jsonValue();
}
const command = (page, id) =>
  page.locator(`.ribbon-panel:not([hidden]) [data-command="${id}"]`);
function deck(count = 3) {
  const pres = createDeck("blank");
  for (let i = 1; i < count; i++) P.addBlankSlide(pres);
  return pres;
}

test("the gallery, effect options, duration, sound, timing and Apply To All are saved as standard markup", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "every Transitions group shows at desktop width; narrower layouts fold them into menus",
  );
  await load(page, deck(3));
  await page.locator("#slide-list .slide-thumb").nth(1).click();
  await page.getByRole("tab", { name: "Transitions", exact: true }).click();
  // The full gallery is grouped.
  await page.getByRole("button", { name: "More Transitions" }).click();
  const panel = page.getByRole("dialog", { name: "Transitions" });
  for (const [group, names] of [
    ["Subtle", ["None", "Morph", "Fade", "Flash"]],
    ["Exciting", ["Fall Over", "Page Curl", "Vortex", "Random"]],
    ["Dynamic Content", ["Pan", "Ferris Wheel", "Fly Through"]],
  ]) {
    const list = panel.getByRole("listbox", { name: group, exact: true });
    for (const name of names)
      await expect(
        list.getByRole("option", { name, exact: true }),
      ).toBeVisible();
  }
  await panel.getByRole("option", { name: "Vortex", exact: true }).click();
  // Choosing a transition previews it on the editing canvas.
  expect(await playing(page, "#slide-canvas")).toMatchObject({
    effect: "vortex",
    duration: 3000,
  });
  await expect(
    page
      .locator("#slide-list .slide-item")
      .nth(1)
      .locator(".slide-transition-mark"),
  ).toBeVisible();
  await expect(
    page
      .locator("#slide-list .slide-item")
      .nth(0)
      .locator(".slide-transition-mark"),
  ).toHaveCount(0);
  // Effect options.
  await command(page, "effect-options").click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "From Left", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page
    .getByRole("menuitemcheckbox", { name: "From Top", exact: true })
    .click();
  // Duration, sound and advance timing.
  const duration = page.getByRole("spinbutton", { name: "Duration" });
  await duration.fill("2.5");
  await duration.press("Enter");
  await command(page, "transition-sound").click();
  await page
    .getByRole("menuitemcheckbox", { name: "Chime", exact: true })
    .click();
  await expect(command(page, "transition-sound")).toContainText("Chime");
  await page
    .getByRole("checkbox", { name: "On Mouse Click", exact: true })
    .uncheck();
  await page.getByRole("checkbox", { name: "After", exact: true }).check();
  const after = page.getByRole("spinbutton", {
    name: "Advance after (seconds)",
  });
  await after.fill("00:04.00");
  await after.press("Enter");
  await command(page, "apply-to-all").click();

  const { pres, files } = await download(page);
  const slides = P.getSlides(pres);
  for (const slide of slides) {
    expect(P.getSlideTransition(slide)).toEqual({
      effect: "vortex",
      direction: "d",
      durationMs: 2500,
      speed: "slow",
      advanceOnClick: false,
      advanceAfterMs: 4000,
      sound: expect.objectContaining({ kind: "start", name: "Chime.wav" }),
    });
    expect(P.getSlideTransitionSoundData(slide)?.bytes.length).toBeGreaterThan(
      1000,
    );
    const xml = P.getSlideXmlString(slide);
    const choice = xml.match(
      /<mc:Choice Requires="p14">([\s\S]*?)<\/mc:Choice>/,
    )[1];
    expect(choice).toContain('<p14:vortex dir="d"/><p:sndAc>');
    for (const attribute of [
      'spd="slow"',
      'advClick="0"',
      'advTm="4000"',
      'p14:dur="2500"',
    ])
      expect(choice).toContain(attribute);
    expect(xml).toMatch(/<mc:Fallback><p:transition[^>]*><p:fade\/><p:sndAc>/);
  }
  // One media part serves every slide.
  expect(
    Object.keys(files).filter((name) => /media\/audio/.test(name)),
  ).toEqual(["ppt/media/audio1.wav"]);
  expect(strFromU8(files["[Content_Types].xml"])).toContain('Extension="wav"');
});

test("every transition in the full gallery is within the screen", async ({
  page,
}) => {
  await load(page, deck(1));
  await page.getByRole("tab", { name: "Transitions", exact: true }).click();
  await page.getByRole("button", { name: "More Transitions" }).click();
  const panel = page.getByRole("dialog", { name: "Transitions" });
  const right = await page.evaluate(() => document.documentElement.clientWidth);
  const options = await panel.getByRole("option").all();
  expect(options.length).toBeGreaterThan(40);
  for (const option of options) {
    const box = await option.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(right);
  }
});

test("a chosen transition plays in the slide show, previews on the canvas and marks the navigator", async ({
  page,
}) => {
  await load(page, deck(2));
  await page.locator("#slide-list .slide-thumb").nth(1).click();
  const tab = page.getByRole("tab", { name: "Transitions", exact: true });
  await tab.click();
  await page
    .getByRole("listbox", { name: "Transitions", exact: true })
    .getByRole("option", { name: "Push", exact: true })
    .click();
  const mark = page
    .locator("#slide-list .slide-item")
    .nth(1)
    .locator(".slide-transition-mark");
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("aria-label", /Push transition/);
  await expect(page.locator("#slide-canvas .slide-transition")).toHaveCount(0);
  // The navigator's mark plays it again.
  await mark.click();
  expect(await playing(page, "#slide-canvas")).toMatchObject({
    effect: "push",
    duration: 1000,
  });
  await expect(page.locator("#slide-canvas .slide-transition")).toHaveCount(0);
  await page.locator("#slide-list .slide-thumb").nth(0).click();
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  expect(await playing(page, ".presenter")).toEqual({
    effect: "push",
    direction: "forward",
    duration: 1000,
  });
  await expect(page.locator(".presenter .slide-transition")).toHaveCount(0);
  await page.keyboard.press("Escape");
  const { pres } = await download(page);
  expect(P.getSlideTransition(P.getSlides(pres)[1])).toMatchObject({
    effect: "push",
    direction: "u",
    durationMs: 1000,
  });
});

test("morph plays between slides with the same objects", async ({ page }) => {
  const pres = createDeck("blank");
  const first = P.getSlides(pres)[0];
  const ball = P.addSlideShape(first, {
    preset: "ellipse",
    x: 900000,
    y: 3800000,
    w: 1500000,
    h: 1500000,
    name: "Ball",
  });
  P.setShapeFill(ball, "#E0533D");
  const second = P.duplicateSlide(pres, first);
  const moved = P.getSlideShapes(second).find(
    (s) => P.getShapeName(s) === "Ball",
  );
  P.setShapePosition(moved, 8000000, 600000);
  P.setSlideTransition(second, {
    effect: "morph",
    morphOption: "byObject",
    durationMs: 1500,
  });
  await load(page, pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  expect(await playing(page, ".presenter")).toEqual({
    effect: "morph",
    direction: "forward",
    duration: 1500,
  });
  await expect(page.locator(".presenter .slide-transition")).toHaveCount(0);
  await expect(page.locator(".presenter-counter")).toHaveText("2 / 2");
});
