import { test, expect } from "@playwright/test";
import { inspector } from "./editor-commands.js";
import { readFile } from "node:fs/promises";
import { P, parseDeck, text } from "../src/model.js";
import { NS } from "../lib/pptx/src/internal/xml/index.ts";
import { fixture } from "../tests/slide-transition-fixture.js";
import { presetTransition } from "../tests/preset-transition-fixture.js";

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
  const arriving = page.locator(".presenter-slide:not(.presenter-leaving)");
  for (const ms of cases) {
    await page.getByRole("button", { name: "Next slide", exact: true }).click();
    expect(
      await arriving.evaluate(
        (node) => node.getAnimations()[0]?.effect.getTiming().duration,
      ),
    ).toBe(ms);
    expect(
      await page
        .locator(".presenter-leaving")
        .evaluate(
          (node) => node.getAnimations()[0]?.effect.getTiming().duration,
        ),
    ).toBe(ms);
    await expect(arriving).not.toHaveClass(/entering/);
    await expect(page.locator(".presenter-leaving")).toHaveCount(0);
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
  const arriving = page.locator(".presenter-slide:not(.presenter-leaving)");
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  expect(
    await arriving.evaluate(
      (node) => node.getAnimations()[0]?.effect.getTiming().duration,
    ),
  ).toBe(1750);
  // Direct navigation to None cancels the previous animation immediately.
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await expect(arriving).not.toHaveClass(/entering/);
  await expect(page.locator(".presenter-leaving")).toHaveCount(0);
  await page.keyboard.press("Escape");
  const control = page.getByRole("combobox", {
    name: "Transition",
    exact: true,
  });
  await inspector(page);
  await control.selectOption("push");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(control).toHaveValue("fade");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
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
  await expect(arriving).toHaveClass(/entering fade/);
  // A duration longer than the old cleanup timeout must finish on the animation.
  await page.waitForTimeout(1100);
  await expect(arriving).toHaveClass(/entering fade/);
  await expect(arriving).not.toHaveClass(/entering/);
  await page.keyboard.press("Escape");
});

test("the presenter selects its authored fallback for an unplayed base effect in a duration choice", async ({
  page,
}) => {
  const f = await fixture("");
  const source = await fixture(
    `<mc:AlternateContent xmlns:mc="${NS.mc}" xmlns:modern="${NS.p14}"><mc:Choice Requires="modern"><p:transition modern:dur="3700"><p:cover/></p:transition></mc:Choice><mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>`,
  );
  P.importSlide(f.pres, source.slide, P.getSlideLayouts(f.pres)[0]);
  await load(page, f.pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  const arriving = page.locator(".presenter-slide:not(.presenter-leaving)");
  await expect(arriving).toHaveClass(/entering fade/);
  expect(
    await arriving.evaluate(
      (node) => node.getAnimations()[0]?.effect.getTiming().duration,
    ),
  ).toBe(1000);
  await expect(arriving).not.toHaveClass(/entering/);
  await page.keyboard.press("Escape");
  expect(
    P.getSlideTransition(P.getSlides(await download(page))[1]),
  ).toMatchObject({ effect: "cover", durationMs: 3700 });
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
  await expect(page.locator(".presenter-slide.entering")).toHaveCount(0);
  await expect(page.locator(".presenter-leaving")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await expect(page.locator(".presenter-slide.entering")).toHaveCount(0);
  await expect(page.locator(".presenter-leaving")).toHaveCount(0);
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
  const arriving = page.locator(".presenter-slide:not(.presenter-leaving)");
  const next = page.getByRole("button", { name: "Next slide", exact: true });
  await next.click();
  await next.click();
  await page.waitForTimeout(1200);
  await expect(arriving).toHaveClass(/entering push/);
  await expect(page.locator(".presenter-leaving")).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(arriving).not.toHaveClass(/entering/);
  await expect(page.locator(".presenter-leaving")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await next.click();
  await expect(arriving).toHaveClass(/entering fade/);
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
    const arriving = page.locator(".presenter-slide:not(.presenter-leaving)");
    await page.getByRole("button", { name: "Next slide", exact: true }).click();
    // Interrupt the forward animation: its cancellation must not clear the
    // reverse animation, and a source None must cancel without playing Fade.
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".presenter-counter")).toHaveText("1 / 2");
    if (effect === "none") {
      expect(await arriving.getAttribute("class")).not.toMatch(/entering/);
      expect(await page.locator(".presenter-leaving").count()).toBe(0);
    } else {
      await expect(arriving).toHaveClass(
        new RegExp(`entering ${effect} backward`),
      );
      for (const node of [arriving, page.locator(".presenter-leaving")])
        expect(
          await node.evaluate(
            (element) =>
              element.getAnimations()[0]?.effect.getTiming().duration,
          ),
        ).toBe(1700);
      await expect(arriving).not.toHaveClass(/entering/);
      await expect(page.locator(".presenter-leaving")).toHaveCount(0);
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
  const arriving = page.locator(".presenter-slide:not(.presenter-leaving)");
  for (const jump of ["number", "home"]) {
    await page.keyboard.press("End");
    if (jump === "number") {
      await page.keyboard.press("1");
      await page.keyboard.press("Enter");
    } else await page.keyboard.press("Home");
    await expect(page.locator(".presenter-counter")).toHaveText("1 / 3");
    await expect(arriving).toHaveClass(/entering push/);
    expect(await arriving.getAttribute("class")).not.toMatch(/backward/);
    expect(
      await page.locator(".presenter-leaving").getAttribute("class"),
    ).not.toMatch(/backward/);
    expect(
      await arriving.evaluate(
        (node) => node.getAnimations()[0]?.effect.getTiming().duration,
      ),
    ).toBe(1900);
  }
  await page.keyboard.press("Escape");
});

test("Previous selects the leaving preset's authored playback fallback without changing either slide", async ({
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
  const arriving = page.locator(".presenter-slide:not(.presenter-leaving)");
  await expect(arriving).toHaveClass(/entering fade backward/);
  expect(
    await arriving.evaluate(
      (node) => node.getAnimations()[0]?.effect.getTiming().duration,
    ),
  ).toBe(750);
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
  const arriving = page.locator(".presenter-slide:not(.presenter-leaving)");
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await page.locator(".presenter-link").first().click();
  await expect(arriving).toHaveClass(/entering fade backward/);
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await page.locator(".presenter-link").last().click();
  await expect(arriving).toHaveClass(/entering push/);
  expect(await arriving.getAttribute("class")).not.toMatch(/backward/);
  await page.keyboard.press("Escape");
});
