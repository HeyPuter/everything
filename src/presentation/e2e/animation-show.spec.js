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

test("going back on the first slide takes back its builds and goes no further", async ({
  page,
}) => {
  await load(page, animatedDeck());
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const counter = page.locator(".presenter-counter");
  const previous = page.getByRole("button", { name: "Previous slide" });
  await expect.poll(() => visibleLayers(page)).toEqual([false, false, false]);
  await expect(previous).toBeDisabled();
  // Nothing before the first slide: its builds stay to come.
  await page.keyboard.press("ArrowLeft");
  await expect(counter).toHaveText("1 / 2");
  await expect.poll(() => visibleLayers(page)).toEqual([false, false, false]);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => visibleLayers(page)).toEqual([true, false, false]);
  // The button takes back the build just played.
  await expect(previous).toBeEnabled();
  await previous.click();
  await expect.poll(() => visibleLayers(page)).toEqual([false, false, false]);
  await expect(previous).toBeDisabled();
  await expect(counter).toHaveText("1 / 2");
});

test("Reading View's menu steps through builds and opens slides at their start", async ({
  page,
}) => {
  const pres = animatedDeck();
  P.setSlideShowSetup(pres, { showType: "browse" });
  await load(page, pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const reading = page.getByRole("dialog", { name: "Reading View" });
  const counter = reading.locator(".reading-counter");
  const choose = async (...names) => {
    await reading.getByRole("button", { name: "Reading View menu" }).click();
    for (const name of names) await page.getByRole("menuitem", name).click();
  };
  await expect(counter).toHaveText("Slide 1 of 2");
  await expect.poll(() => visibleLayers(page)).toEqual([false, false, false]);
  await choose({ name: "Next" });
  await expect.poll(() => visibleLayers(page)).toEqual([true, false, false]);
  await expect(counter).toHaveText("Slide 1 of 2");
  await choose({ name: "Previous" });
  await expect.poll(() => visibleLayers(page)).toEqual([false, false, false]);
  await reading.getByRole("button", { name: "Reading View menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Previous" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.keyboard.press("End");
  await expect(counter).toHaveText("Slide 2 of 2");
  await reading.getByRole("button", { name: "Reading View menu" }).click();
  await page.getByRole("menuitem", { name: "Go to Slide" }).click();
  await page.getByRole("menuitemcheckbox", { name: /^1\./ }).click();
  await expect(counter).toHaveText("Slide 1 of 2");
  await expect.poll(() => visibleLayers(page)).toEqual([false, false, false]);
});

test("media in the click sequence plays at its own click among the builds", async ({
  page,
}) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  // A second of silence; inserted media plays on the next click by default.
  const wav = new Uint8Array(44 + 8000);
  const view = new DataView(wav.buffer);
  const tag = (at, s) =>
    [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, 36 + 8000, true);
  tag(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  tag(36, "data");
  view.setUint32(40, 8000, true);
  wav.fill(128, 44);
  P.addSlideMedia(
    slide,
    { kind: "audio", data: wav, contentType: "audio/wav" },
    { x: 6 * 914400, y: 914400, w: 914400, h: 914400 },
  );
  // The box comes in on the click after the sound.
  const box = shape(slide, 1, 1, 2, 1.5, "#2266cc");
  P.setSlideAnimations(slide, [
    ...P.getSlideAnimations(slide),
    {
      shapeId: String(P.getShapeId(box)),
      presetClass: "entr",
      presetId: 10,
      presetSubtype: 0,
      start: "click",
      delayMs: 0,
      durationMs: 300,
    },
  ]);
  P.addBlankSlide(pres);
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    window.played = [];
    HTMLMediaElement.prototype.play = function () {
      window.played.push(this);
      return play.call(this);
    };
  });
  const sounding = () =>
    page.evaluate(() => window.played.filter((m) => !m.paused).length);
  await load(page, pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const counter = page.locator(".presenter-counter");
  await expect.poll(() => visibleLayers(page)).toEqual([false]);
  await page.keyboard.press("ArrowRight");
  await expect.poll(sounding).toBe(1);
  expect(await visibleLayers(page)).toEqual([false]);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => visibleLayers(page)).toEqual([true]);
  await expect(counter).toHaveText("1 / 2");
  await page.keyboard.press("ArrowRight");
  await expect(counter).toHaveText("2 / 2");
});

test("a timed advance plays the slide's remaining click steps first", async ({
  page,
}) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const boxes = [1, 4].map((x) => shape(slide, x, 1, 2, 1.5, "#2266cc"));
  P.setSlideAnimations(
    slide,
    boxes.map((box) => ({
      shapeId: String(P.getShapeId(box)),
      presetClass: "entr",
      presetId: 10,
      presetSubtype: 0,
      start: "click",
      delayMs: 0,
      durationMs: 1500,
    })),
  );
  P.setSlideTransition(slide, { effect: "none", advanceAfterMs: 500 });
  P.addBlankSlide(pres);
  await load(page, pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const counter = page.locator(".presenter-counter");
  await expect.poll(() => visibleLayers(page)).toEqual([true, false]);
  await expect(counter).toHaveText("1 / 2");
  await expect.poll(() => visibleLayers(page)).toEqual([true, true]);
  await expect(counter).toHaveText("1 / 2");
  await expect(counter).toHaveText("2 / 2");
});

test("a timed advance waits for effects that start with the slide", async ({
  page,
}) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const box = shape(slide, 1, 1, 2, 1.5, "#2266cc");
  P.setSlideAnimations(slide, [
    {
      shapeId: String(P.getShapeId(box)),
      presetClass: "entr",
      presetId: 10,
      presetSubtype: 0,
      start: "after",
      delayMs: 0,
      durationMs: 1500,
    },
  ]);
  // A self-running slide: on as soon as its effects are done.
  P.setSlideTransition(slide, { effect: "none", advanceAfterMs: 0 });
  P.addBlankSlide(pres);
  await load(page, pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const counter = page.locator(".presenter-counter");
  await expect.poll(() => visibleLayers(page)).toEqual([true]);
  await expect(counter).toHaveText("1 / 2");
  expect(
    await page.evaluate(() =>
      document.getAnimations().some((a) => a.playState === "running"),
    ),
  ).toBe(true);
  await expect(counter).toHaveText("2 / 2");
});

test("going to an earlier slide from See All Slides starts it over", async ({
  page,
}) => {
  await load(page, animatedDeck());
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const counter = page.locator(".presenter-counter");
  await page.keyboard.press("End");
  await expect(counter).toHaveText("2 / 2");
  await page.keyboard.press("g");
  await page
    .getByRole("region", { name: "All slides" })
    .getByRole("button", { name: /^Slide 1/ })
    .click();
  await expect(counter).toHaveText("1 / 2");
  // Unlike going back a slide, the jump shows the slide as it opens.
  await expect.poll(() => visibleLayers(page)).toEqual([false, false, false]);
});

test("presenter view counts a slide's clicks after jumping back to it", async ({
  page,
}) => {
  await load(page, animatedDeck());
  await page.keyboard.press("Alt+F5");
  const next = page.locator(".show-console-next-label");
  await expect(next).toHaveText(/^Next click: animation 1 of 3/);
  await page.keyboard.press("End");
  await expect(next).toHaveText("End of slide show");
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  await expect(next).toHaveText(/^Next click: animation 1 of 3/);
});

test("presenter view counts the last slide's clicks before the end", async ({
  page,
}) => {
  const pres = animatedDeck();
  P.removeSlide(pres, P.getSlides(pres)[1]);
  await load(page, pres);
  await page.keyboard.press("Alt+F5");
  const next = page.locator(".show-console-next-label");
  await expect(next).toHaveText(
    "Next click: animation 1 of 3 on this slide, then the end of the slide show",
  );
  await page.keyboard.press("ArrowRight");
  await expect(next).toHaveText(/^Next click: animation 2 of 3/);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(next).toHaveText("End of slide show");
});

test("with an audience window the presenter's copy follows the builds", async ({
  page,
  context,
}) => {
  await load(page, animatedDeck());
  await page.keyboard.press("Alt+F5");
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: "Audience window" }).click();
  const audience = await opened;
  const slide = audience.locator(".presenter-slide");
  await expect(slide).toHaveAttribute("src", /./);
  // The slide as it opens, its click effects not yet played.
  const opening = await slide.getAttribute("src");
  const copy = page.locator(".show-mirror img");
  await expect(copy).toHaveAttribute("src", opening);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => copy.getAttribute("src")).not.toBe(opening);
  await page.keyboard.press("ArrowLeft");
  await expect(copy).toHaveAttribute("src", opening);
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
