import { test, expect } from "@playwright/test";
import { P, createDeck, shape, text } from "../src/model.js";

// A slide whose box flies in on the first click, whose list builds a
// paragraph at a time, and whose box spins after the list.
function animatedDeck() {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const box = shape(slide, 1, 1, 2, 1.5, "#2266cc");
  const list = text(slide, "First\nSecond", 5, 1, 5, 3);
  const id = (s) => String(P.getShapeId(s));
  P.setSlideAnimations(slide, [
    {
      shapeId: id(box),
      presetClass: "entr",
      presetId: 2,
      presetSubtype: 4,
      start: "click",
      delayMs: 0,
      durationMs: 300,
    },
    {
      shapeId: id(list),
      presetClass: "entr",
      presetId: 10,
      presetSubtype: 0,
      start: "click",
      delayMs: 0,
      durationMs: 300,
      text: { by: "paragraph", level: 1 },
    },
    {
      shapeId: id(box),
      presetClass: "exit",
      presetId: 10,
      presetSubtype: 0,
      start: "after",
      delayMs: 0,
      durationMs: 300,
    },
  ]);
  P.addBlankSlide(pres);
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
    name: "Animated.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".slide-image")).toBeVisible();
}

const visibleLayers = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".presenter .anim-fx")].map(
      (fx) => getComputedStyle(fx).visibility === "visible",
    ),
  );

test("the slide show plays click steps before moving to the next slide", async ({
  page,
}) => {
  await load(page, animatedDeck());
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const counter = page.locator(".presenter-counter");
  await expect(counter).toHaveText("1 / 2");
  const stage = page.locator(".presenter .anim-stage");
  await expect(stage).toBeAttached();
  // The box and both paragraphs start hidden.
  await expect.poll(() => visibleLayers(page)).toEqual([false, false, false]);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => visibleLayers(page)).toEqual([true, false, false]);
  await page.keyboard.press("ArrowRight");
  await expect(counter).toHaveText("1 / 2");
  // The first paragraph; then the second, and after it the box leaves.
  await expect.poll(() => visibleLayers(page)).toEqual([true, true, false]);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => visibleLayers(page)).toEqual([false, true, true]);
  // Going back undoes a step at a time.
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => visibleLayers(page)).toEqual([true, true, false]);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(counter).toHaveText("2 / 2");
  await expect(stage).toHaveCount(0);
  // Back onto the animated slide: it shows its final state.
  await page.keyboard.press("ArrowLeft");
  await expect(counter).toHaveText("1 / 2");
  await expect.poll(() => visibleLayers(page)).toEqual([false, true, true]);
});

test("reduced motion still steps through effects", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await load(page, animatedDeck());
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect.poll(() => visibleLayers(page)).toEqual([false, false, false]);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => visibleLayers(page)).toEqual([true, false, false]);
});

test("clicking a trigger object plays its effects", async ({ page }) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const button = shape(slide, 1, 5, 2, 1, "#444444");
  P.renameShape(button, "Reveal button");
  const card = shape(slide, 5, 1, 3, 2, "#22aa66");
  P.setSlideAnimations(slide, [
    {
      shapeId: String(P.getShapeId(card)),
      presetClass: "entr",
      presetId: 10,
      presetSubtype: 0,
      start: "click",
      delayMs: 0,
      durationMs: 200,
      trigger: String(P.getShapeId(button)),
    },
  ]);
  await load(page, pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect.poll(() => visibleLayers(page)).toEqual([false]);
  await page
    .getByRole("button", { name: "Play the effects of Reveal button" })
    .click();
  await expect.poll(() => visibleLayers(page)).toEqual([true]);
  // The trigger plays without using up the slide's advance.
  await expect(page.locator(".presenter-counter")).toHaveText("1 / 1");
});
