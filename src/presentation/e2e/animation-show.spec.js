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

// Two boxes that each fade in on a click, on a slide timed to move on.
function twoClickDeck(advanceAfterMs) {
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
      durationMs: 300,
    })),
  );
  if (advanceAfterMs !== undefined)
    P.setSlideTransition(slide, { effect: "none", advanceAfterMs });
  P.addBlankSlide(pres);
  return { pres, slide };
}

test("rehearsed click times play each step when it was clicked", async ({
  page,
}) => {
  const { pres, slide } = twoClickDeck(8000);
  P.setSlideClickTimings(slide, [600, 600]);
  await load(page, pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const counter = page.locator(".presenter-counter");
  await expect.poll(() => visibleLayers(page)).toEqual([false, false]);
  // Each box in turn, long before the slide's time is up.
  await expect
    .poll(() => visibleLayers(page), { timeout: 4000 })
    .toEqual([true, false]);
  await expect
    .poll(() => visibleLayers(page), { timeout: 4000 })
    .toEqual([true, true]);
  await expect(counter).toHaveText("1 / 2");
  // Pausing the show holds the steps too.
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => visibleLayers(page)).toEqual([true, false]);
  await page.keyboard.press("s");
  await page.waitForTimeout(1500);
  expect(await visibleLayers(page)).toEqual([true, false]);
  await page.keyboard.press("s");
  await expect
    .poll(() => visibleLayers(page), { timeout: 4000 })
    .toEqual([true, true]);
});

test("Presenter View pictures the next build when the next click is one", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Presenter View in the show's window is a desktop flow",
  );
  await load(page, twoClickDeck().pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const d = page.getByRole("dialog", { name: "Presentation mode" });
  await d
    .locator(".presenter-stage")
    .click({ button: "right", position: { x: 20, y: 20 } });
  await page.getByRole("menuitem", { name: "Show Presenter View" }).click();
  const label = d.locator(".show-console-next-label");
  const next = d.locator(".show-console-next");
  const src = () => next.getAttribute("src");
  await expect(label).toContainText("animation 1 of 2");
  await expect.poll(src).toBeTruthy();
  const first = await src();
  await page.keyboard.press("ArrowRight");
  await expect(label).toContainText("animation 2 of 2");
  await expect.poll(src).not.toBe(first);
  const second = await src();
  await page.keyboard.press("ArrowRight");
  await expect(label).toHaveText("Slide 2");
  await expect.poll(src).not.toBe(second);
  expect(await src()).not.toBe(first);
});

test("a rehearsal keeps when each click came", async ({ page }) => {
  await load(page, twoClickDeck().pres);
  await page.getByRole("tab", { name: "Slide Show", exact: true }).click();
  const direct = page
    .getByRole("tabpanel")
    .getByRole("button", { name: "Rehearse Timings", exact: true });
  if (!(await direct.isVisible()))
    await page
      .getByRole("tabpanel")
      .getByRole("button", { name: "Set Up", exact: true })
      .click();
  await page
    .getByRole("button", { name: "Rehearse Timings", exact: true })
    .first()
    .click();
  const counter = page.locator(".presenter-counter");
  await expect(counter).toHaveText("1 / 2");
  await expect.poll(() => visibleLayers(page)).toEqual([false, false]);
  await page.waitForTimeout(700);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => visibleLayers(page)).toEqual([true, false]);
  await page.waitForTimeout(700);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => visibleLayers(page)).toEqual([true, true]);
  await page.waitForTimeout(1500);
  await page.keyboard.press("ArrowRight");
  await expect(counter).toHaveText("2 / 2");
  await page.keyboard.press("Escape");
  const prompt = page.getByRole("dialog", {
    name: "Keep the new slide timings?",
  });
  await prompt.getByRole("button", { name: "Keep Timings" }).click();
  await expect(prompt).toBeHidden();
  // Played with the timings, the boxes come in as they were clicked, not
  // both at the end of the slide's time.
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(counter).toHaveText("1 / 2");
  await expect.poll(() => visibleLayers(page)).toEqual([false, false]);
  await expect
    .poll(() => visibleLayers(page), { timeout: 2500 })
    .toEqual([true, false]);
  await expect(counter).toHaveText("1 / 2");
  await expect
    .poll(() => visibleLayers(page), { timeout: 2500 })
    .toEqual([true, true]);
  await expect(counter).toHaveText("1 / 2");
  await expect(counter).toHaveText("2 / 2", { timeout: 5000 });
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
}, info) => {
  // Phones have no second screen and do not offer an audience window.
  test.skip(info.project.name === "mobile", "no audience window on a phone");
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

test("the end screen shows nothing of an animated last slide", async ({
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
      start: "click",
      delayMs: 0,
      durationMs: 200,
    },
  ]);
  await load(page, pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => visibleLayers(page)).toEqual([true]);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".presenter-end")).toBeVisible();
  // Nothing of the slide is drawn over the message.
  const drawn = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll(".presenter-frame img")].filter((img) =>
          img.checkVisibility({ visibilityProperty: true }),
        ).length,
    );
  expect(await drawn()).toBe(0);
  // Going back shows the slide as it was built.
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => visibleLayers(page)).toEqual([true]);
  await expect(page.locator(".presenter-end")).toBeHidden();
});

test("the Next and Previous buttons bring back a black or white screen's slide as they step", async ({
  page,
}) => {
  await load(page, animatedDeck());
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const stage = page.locator(".presenter-stage");
  await expect.poll(() => visibleLayers(page)).toEqual([false, false, false]);
  await page.keyboard.press("b");
  await expect(stage).toHaveClass(/\bblank\b/);
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await expect(stage).not.toHaveClass(/\bblank\b/);
  await expect.poll(() => visibleLayers(page)).toEqual([true, false, false]);
  await page.keyboard.press("w");
  await expect(stage).toHaveClass(/blank-white/);
  await page
    .getByRole("button", { name: "Previous slide", exact: true })
    .click();
  await expect(stage).not.toHaveClass(/blank-white/);
  await expect.poll(() => visibleLayers(page)).toEqual([false, false, false]);
});

test("a transition shows the slide as it opens, and as it ends going back", async ({
  page,
}) => {
  const pres = createDeck("blank");
  const second = P.addBlankSlide(pres);
  // The red box comes in on the first click; the blue one leaves after it.
  const red = shape(second, 1, 1, 3, 2, "#cc2222");
  const blue = shape(second, 8, 4, 3, 2, "#2222cc");
  const id = (s) => String(P.getShapeId(s));
  const fade = (shapeId, presetClass, start) => ({
    shapeId,
    presetClass,
    presetId: 10,
    presetSubtype: 0,
    start,
    delayMs: 0,
    durationMs: 100,
  });
  P.setSlideAnimations(second, [
    fade(id(red), "entr", "click"),
    fade(id(blue), "exit", "after"),
  ]);
  const third = P.addBlankSlide(pres);
  for (const s of [second, third])
    P.setSlideTransition(s, { effect: "fade", durationMs: 4000 });
  await load(page, pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const counter = page.locator(".presenter-counter");
  await expect(counter).toHaveText("1 / 3");
  // The colour halfway through the transition at a point of the slide
  // (fractions of its width and height).
  const midway = async (points) => {
    const overlay = page.locator(".presenter .slide-transition canvas");
    await expect(overlay).toBeAttached();
    await page.waitForTimeout(2200);
    return page.evaluate((points) => {
      const canvas = document.querySelector(
        ".presenter .slide-transition canvas",
      );
      const ctx = canvas.getContext("2d");
      return points.map(([x, y]) => {
        const [r, g, b] = ctx.getImageData(
          Math.round(x * canvas.width),
          Math.round(y * canvas.height),
          1,
          1,
        ).data;
        return r - b > 40 ? "red" : b - r > 40 ? "blue" : "plain";
      });
    }, points);
  };
  const redAt = [2.5 / 13.333, 2 / 7.5],
    blueAt = [9.5 / 13.333, 5 / 7.5];
  await page.keyboard.press("ArrowRight");
  await expect(counter).toHaveText("2 / 3");
  // The red box is still to come; the blue one is there.
  expect(await midway([redAt, blueAt])).toEqual(["plain", "blue"]);
  await expect(page.locator(".presenter .slide-transition")).toHaveCount(0, {
    timeout: 8000,
  });
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(counter).toHaveText("3 / 3");
  await expect(page.locator(".presenter .slide-transition")).toHaveCount(0, {
    timeout: 8000,
  });
  // Back to the slide as it ended: the red box in, the blue one gone.
  await page.keyboard.press("ArrowLeft");
  await expect(counter).toHaveText("2 / 3");
  expect(await midway([redAt, blueAt])).toEqual(["red", "plain"]);
});

test("a morph leaves out objects still to come on the slide", async ({
  page,
}) => {
  const pres = createDeck("blank");
  shape(P.getSlides(pres)[0], 0.5, 0.5, 2, 2, "#22aa22");
  const second = P.addBlankSlide(pres);
  shape(second, 1, 1, 2, 2, "#22aa22");
  // The red box comes in on the first click.
  const red = shape(second, 5, 3, 3, 2, "#cc2222");
  P.setSlideAnimations(second, [
    {
      shapeId: String(P.getShapeId(red)),
      presetClass: "entr",
      presetId: 10,
      presetSubtype: 0,
      start: "click",
      delayMs: 0,
      durationMs: 100,
    },
  ]);
  P.setSlideTransition(second, { effect: "morph", durationMs: 4000 });
  await load(page, pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const counter = page.locator(".presenter-counter");
  await expect(counter).toHaveText("1 / 2");
  await page.keyboard.press("ArrowRight");
  await expect(counter).toHaveText("2 / 2");
  const overlay = page.locator(".presenter .slide-transition canvas");
  await expect(overlay).toBeAttached();
  // Late in the morph, where new objects are nearly in.
  await page.waitForTimeout(3300);
  const color = await page.evaluate(() => {
    const canvas = document.querySelector(
      ".presenter .slide-transition canvas",
    );
    const [r, , b] = canvas
      .getContext("2d")
      .getImageData(
        Math.round((6.5 / 13.333) * canvas.width),
        Math.round((4 / 7.5) * canvas.height),
        1,
        1,
      ).data;
    return r - b > 40 ? "red" : "plain";
  });
  expect(color).toBe("plain");
});

test("a click during a transition ends it and plays the slide's next step", async ({
  page,
}) => {
  const pres = createDeck("blank");
  const second = P.addBlankSlide(pres);
  const effects = [
    shape(second, 5, 3, 3, 2, "#cc2222"),
    shape(second, 1, 1, 2, 1, "#2222cc"),
  ].map((box) => ({
    shapeId: String(P.getShapeId(box)),
    presetClass: "entr",
    presetId: 10,
    presetSubtype: 0,
    start: "click",
    delayMs: 0,
    durationMs: 100,
  }));
  P.setSlideAnimations(second, effects);
  P.setSlideTransition(second, { effect: "fade", durationMs: 5000 });
  await load(page, pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const counter = page.locator(".presenter-counter");
  await expect(counter).toHaveText("1 / 2");
  await page.keyboard.press("ArrowRight");
  await expect(counter).toHaveText("2 / 2");
  const overlay = page.locator(".presenter .slide-transition");
  await expect(overlay).toHaveCount(1);
  await page.keyboard.press("ArrowRight");
  // The transition ends at once and the first box comes in, to stay.
  await expect(overlay).toHaveCount(0);
  await expect.poll(() => visibleLayers(page)).toEqual([true, false]);
  await page.waitForTimeout(500);
  expect(await visibleLayers(page)).toEqual([true, false]);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => visibleLayers(page)).toEqual([true, true]);
  await expect(counter).toHaveText("2 / 2");
});

test("an effect set to auto-reverse ends as the object began", async ({
  page,
}) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const box = shape(slide, 5, 3, 3, 2, "#cc2222");
  // Grow/Shrink, played forward and back.
  P.setSlideAnimations(slide, [
    {
      shapeId: String(P.getShapeId(box)),
      presetClass: "emph",
      presetId: 6,
      presetSubtype: 0,
      start: "click",
      delayMs: 0,
      durationMs: 300,
      autoReverse: true,
    },
  ]);
  P.addBlankSlide(pres);
  await load(page, pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presenter-counter")).toHaveText("1 / 2");
  const width = () =>
    page.evaluate(() =>
      Math.max(
        ...[...document.querySelectorAll(".presenter .anim-fx *")].map(
          (node) => node.getBoundingClientRect().width,
        ),
      ),
    );
  await expect(page.locator(".presenter .anim-fx")).toHaveCount(1);
  const before = await width();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1200);
  expect(Math.abs((await width()) - before)).toBeLessThan(2);
});

test("a transition's preview on the canvas leaves out objects still to come", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "narrower layouts fold the Transitions tab's Preview into a menu; the preview plays the same way",
  );
  const pres = createDeck("blank");
  const second = P.addBlankSlide(pres);
  const red = shape(second, 5, 3, 3, 2, "#cc2222");
  P.setSlideAnimations(second, [
    {
      shapeId: String(P.getShapeId(red)),
      presetClass: "entr",
      presetId: 10,
      presetSubtype: 0,
      start: "click",
      delayMs: 0,
      durationMs: 100,
    },
  ]);
  P.setSlideTransition(second, { effect: "fade", durationMs: 4000 });
  await load(page, pres);
  await page.locator("#slide-list .slide-thumb").nth(1).click();
  await page.getByRole("tab", { name: "Transitions" }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const overlay = page.locator("#slide-canvas .slide-transition canvas");
  await expect(overlay).toBeAttached();
  // Late in the fade, where the slide is nearly in.
  await page.waitForTimeout(3000);
  const color = await page.evaluate(() => {
    const canvas = document.querySelector(
      "#slide-canvas .slide-transition canvas",
    );
    const [r, , b] = canvas
      .getContext("2d")
      .getImageData(
        Math.round((6.5 / 13.333) * canvas.width),
        Math.round((4 / 7.5) * canvas.height),
        1,
        1,
      ).data;
    return r - b > 40 ? "red" : "plain";
  });
  expect(color).toBe("plain");
});
