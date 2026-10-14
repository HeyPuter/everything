import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, parseDeck, text } from "../src/model.js";
import { NS } from "../lib/pptx/src/internal/xml/index.ts";
import { fixture } from "../tests/slide-transition-fixture.js";
import { presetTransition } from "../tests/preset-transition-fixture.js";

// Undo and Redo: the toolbar's buttons, or their shortcuts where a phone's
// toolbar leaves them out.
async function history(page, name) {
  const button = page.getByRole("button", { name, exact: true });
  if (await button.isVisible()) return button.click();
  await page.evaluate(() => document.activeElement?.blur());
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(name === "Undo" ? `${mod}+z` : `${mod}+Shift+z`);
}
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
    name: "Authored transition durations.pptx",
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

// The transition playing over the show: its effect, direction and the
// duration its timing animation runs for (see src/transitions/player.js).
const overlay = (page) => page.locator(".slide-transition");
async function playing(page) {
  const handle = await page.waitForFunction(() => {
    const node = document.querySelector(".slide-transition");
    const clock = node?.getAnimations()[0];
    return clock
      ? {
          effect: node.dataset.effect,
          direction: node.dataset.direction,
          duration: clock.effect.getTiming().duration,
        }
      : null;
  });
  return handle.jsonValue();
}
async function settled(page) {
  await expect(overlay(page)).toHaveCount(0);
}

test("base transition speeds play their native duration, including the omitted-speed default", async ({
  page,
}) => {
  const f = await fixture("");
  const cases = [];
  for (const effect of ["fade", "push", "zoom"])
    for (const [speed, ms] of [
      [undefined, 500],
      ["fast", 500],
      ["med", 750],
      ["slow", 1000],
    ]) {
      const slide = P.addBlankSlide(f.pres);
      P.setSlideTransition(slide, { effect, speed });
      cases.push(ms);
    }
  await load(page, f.pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  for (const ms of cases) {
    await page.getByRole("button", { name: "Next slide", exact: true }).click();
    expect((await playing(page)).duration).toBe(ms);
    await settled(page);
  }
  await page.keyboard.press("Escape");
});

test("inherited custom duration survives effect editing, undo and download", async ({
  page,
}) => {
  const f = await fixture("", {
    layout: `<mc:AlternateContent xmlns:mc="${NS.mc}" xmlns:duration="${NS.p14}"><mc:Choice Requires="duration"><p:transition spd="fast" duration:dur="1.75s" advTm="7000"><p:fade/></p:transition></mc:Choice><mc:Fallback><p:transition spd="fast" advTm="7000"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>`,
  });
  P.duplicateSlide(f.pres, f.slide);
  const third = P.addBlankSlide(f.pres);
  P.setSlideTransition(third, { effect: "none" });
  await load(page, f.pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  expect((await playing(page)).duration).toBe(1750);
  // Direct navigation to None cancels the previous animation immediately.
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await settled(page);
  await page.keyboard.press("Escape");
  const control = page.getByRole("combobox", {
    name: "Transition",
    exact: true,
  });
  if (!(await control.isVisible())) {
    // The slide's own context menu opens the Format pane on its settings.
    await page
      .locator("#slide-canvas")
      .click({ button: "right", position: { x: 3, y: 3 } });
    // The menu can run past a phone's screen; the keyboard reaches it there.
    await page
      .getByRole("menuitem", { name: "Format Background…", exact: true })
      .focus();
    await page.keyboard.press("Enter");
  }
  await control.selectOption("push");
  await history(page, "Undo");
  await expect(control).toHaveValue("fade");
  await history(page, "Redo");
  await expect(control).toHaveValue("push");
  const exported = await download(page);
  expect(P.getSlideTransition(P.getSlides(exported)[0])).toMatchObject({
    effect: "push",
    durationMs: 1750,
    advanceAfterMs: 7000,
  });
  expect(
    P.getEffectiveSlideTransition(P.getSlides(exported)[1]).durationMs,
  ).toBe(1750);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  expect(await playing(page)).toMatchObject({ effect: "fade" });
  // A long duration finishes on the animation, not on a fixed timer.
  await page.waitForTimeout(1100);
  await expect(overlay(page)).toHaveCount(1);
  await settled(page);
  await page.keyboard.press("Escape");
});

test("the presenter selects its authored fallback for an unknown effect in a duration choice", async ({
  page,
}) => {
  const f = await fixture("");
  const source = await fixture(
    `<mc:AlternateContent xmlns:mc="${NS.mc}" xmlns:modern="${NS.p14}"><mc:Choice Requires="modern"><p:transition modern:dur="3700"><modern:sparkle/></p:transition></mc:Choice><mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>`,
  );
  P.importSlide(f.pres, source.slide, P.getSlideLayouts(f.pres)[0]);
  await load(page, f.pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  expect(await playing(page)).toMatchObject({ effect: "fade", duration: 1000 });
  await settled(page);
  await page.keyboard.press("Escape");
  const exported = await download(page);
  expect(P.getSlideTransition(P.getSlides(exported)[1])).toMatchObject({
    effect: "fade",
    speed: "slow",
  });
  expect(P.getSlideXmlString(P.getSlides(exported)[1])).toContain(
    'dur="3700"><modern:sparkle/>',
  );
});

test("zero duration and reduced motion remain instant without losing authored metadata", async ({
  page,
}) => {
  const f = await fixture("");
  const zero = P.addBlankSlide(f.pres);
  P.setSlideTransition(zero, { effect: "push", durationMs: 0 });
  const long = P.addBlankSlide(f.pres);
  P.setSlideTransition(long, { effect: "fade", durationMs: 3300 });
  await load(page, f.pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await expect(overlay(page)).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await expect(page.locator(".presenter-counter")).toHaveText("3 / 3");
  await expect(overlay(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  const exported = await download(page);
  expect(
    P.getSlides(exported).map((s) => P.getSlideTransition(s)?.durationMs),
  ).toEqual([undefined, 0, 3300]);
});

test("interrupted transition completion cannot clear a newer animation and motion changes cancel it", async ({
  page,
}) => {
  const f = await fixture("");
  for (const [effect, durationMs] of [
    ["fade", 1000],
    ["push", 2100],
    ["fade", 3000],
  ])
    P.setSlideTransition(P.addBlankSlide(f.pres), { effect, durationMs });
  await load(page, f.pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const next = page.getByRole("button", { name: "Next slide", exact: true });
  await next.click();
  await next.click();
  await page.waitForTimeout(1200);
  expect(await playing(page)).toMatchObject({ effect: "push" });
  await expect(overlay(page)).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await settled(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await next.click();
  expect(await playing(page)).toMatchObject({ effect: "fade" });
  await page.keyboard.press("Escape");
  await expect(page.locator(".presenter-slide")).toHaveCount(0);
});

for (const effect of ["none", "fade", "push", "zoom"])
  test(`Previous plays the leaving slide's ${effect} transition and duration`, async ({
    page,
  }) => {
    const f = await fixture("");
    P.setSlideTransition(f.slide, { effect: "fade", durationMs: 2300 });
    P.setSlideTransition(P.addBlankSlide(f.pres), {
      effect,
      durationMs: 1700,
    });
    await load(page, f.pres);
    await page.getByRole("button", { name: "Present", exact: true }).click();
    await page.getByRole("button", { name: "Next slide", exact: true }).click();
    // Interrupt the forward animation: its cancellation must not clear the
    // reverse animation, and a source None must cancel without playing Fade.
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".presenter-counter")).toHaveText("1 / 2");
    if (effect === "none") await expect(overlay(page)).toHaveCount(0);
    else {
      expect(await playing(page)).toEqual({
        effect,
        direction: "backward",
        duration: 1700,
      });
      await expect(overlay(page)).toHaveCount(1);
      await settled(page);
    }
    await page.keyboard.press("Escape");
    expect(
      P.getSlides(await download(page)).map((s) => P.getSlideTransition(s)),
    ).toEqual([
      { effect: "fade", durationMs: 2300 },
      { effect, durationMs: 1700 },
    ]);
  });

test("numbered jumps and Home play the destination transition forward even at a lower index", async ({
  page,
}) => {
  const f = await fixture("");
  P.setSlideTransition(f.slide, { effect: "push", durationMs: 1900 });
  P.setSlideTransition(P.addBlankSlide(f.pres), {
    effect: "fade",
    durationMs: 2500,
  });
  P.setSlideTransition(P.addBlankSlide(f.pres), {
    effect: "zoom",
    durationMs: 1100,
  });
  await load(page, f.pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  for (const jump of ["number", "home"]) {
    await page.keyboard.press("End");
    if (jump === "number") {
      await page.keyboard.press("1");
      await page.keyboard.press("Enter");
    } else await page.keyboard.press("Home");
    await expect(page.locator(".presenter-counter")).toHaveText("1 / 3");
    expect(await playing(page)).toEqual({
      effect: "push",
      direction: "forward",
      duration: 1900,
    });
    await settled(page);
  }
  await page.keyboard.press("Escape");
});

test("Previous plays the leaving slide's page curl backward without changing either slide", async ({
  page,
}) => {
  const f = await fixture("<p:transition><p:fade/></p:transition>");
  P.setSlideTransition(f.slide, { effect: "none" });
  const source = await fixture(presetTransition("pageCurlDouble"));
  P.importSlide(f.pres, source.slide, P.getSlideLayouts(f.pres)[0]);
  await load(page, f.pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await page
    .getByRole("button", { name: "Previous slide", exact: true })
    .click();
  expect(await playing(page)).toEqual({
    effect: "pageCurlDouble",
    direction: "backward",
    duration: 2450,
  });
  await settled(page);
  await page.keyboard.press("Escape");
  const slides = P.getSlides(await download(page));
  expect(P.getSlideTransition(slides[0])).toEqual({ effect: "none" });
  expect(P.getSlideTransition(slides[1])).toEqual(
    P.getSlideTransition(source.slide),
  );
});

test("slide hyperlinks distinguish Previous from a direct jump to the same earlier slide", async ({
  page,
}) => {
  const f = await fixture("");
  P.setSlideTransition(f.slide, { effect: "push", durationMs: 1300 });
  const second = P.addBlankSlide(f.pres);
  P.setSlideTransition(second, { effect: "fade", durationMs: 2400 });
  P.setShapeClickAction(text(second, "Previous", 1, 1, 3, 1), {
    kind: "prevSlide",
  });
  P.setShapeClickAction(text(second, "First", 1, 3, 3, 1), {
    kind: "slide",
    slide: f.slide,
  });
  await load(page, f.pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await settled(page);
  await page.locator(".presenter-link").first().click();
  expect(await playing(page)).toMatchObject({
    effect: "fade",
    direction: "backward",
  });
  await settled(page);
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await settled(page);
  await page.locator(".presenter-link").last().click();
  expect(await playing(page)).toMatchObject({
    effect: "push",
    direction: "forward",
  });
  await page.keyboard.press("Escape");
});
