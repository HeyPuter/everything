import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, createDeck, parseDeck, text } from "../src/model.js";
import { INTERNAL_PACKAGE } from "../lib/pptx/src/api/_internal-symbols.ts";
import { partName } from "../lib/pptx/src/internal/opc/index.ts";
import { NS } from "../lib/pptx/src/internal/xml/index.ts";

function deck(transitions, options = "") {
  const pres = createDeck("blank");
  transitions.forEach((transition, i) =>
    P.setSlideTransition(
      i ? P.addBlankSlide(pres) : P.getSlides(pres)[0],
      transition,
    ),
  );
  pres[INTERNAL_PACKAGE].getPart(partName("/ppt/presProps.xml")).data =
    new TextEncoder().encode(
      `<p:presentationPr xmlns:p="${NS.pml}"><p:showPr ${options}/></p:presentationPr>`,
    );
  return pres;
}
async function load(page, pres) {
  await page.clock.install({ time: new Date("2030-01-01T00:00:00Z") });
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
    name: "Authored advance timing.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".slide-image")).toBeVisible();
  await page.clock.pauseAt(new Date("2030-01-01T00:00:30Z"));
  await page.getByRole("button", { name: "Present", exact: true }).click();
}
const counter = (page) => page.locator(".presenter-counter");
const image = (page) =>
  page.locator(".presenter-slide:not(.presenter-leaving)");
// The transition playing over the show (see src/transitions/player.js).
const transition = (page, effect, direction = "forward") =>
  page.locator(
    `.slide-transition[data-effect="${effect}"][data-direction="${direction}"]`,
  );
const anyTransition = (page) => page.locator(".slide-transition");
// The transition runs on real time while the page's timers are simulated.
// Holding it shows that the dwell waits for the transition, however long the
// simulated time; releasing it ends the transition at once.
async function holdTransition(page) {
  await page.waitForFunction(() => {
    const clock = document
      .querySelector(".slide-transition")
      ?.getAnimations()[0];
    clock?.pause();
    return !!clock;
  });
}
const releaseTransition = (page) =>
  page.evaluate(() =>
    document.querySelector(".slide-transition")?.getAnimations()[0]?.finish(),
  );
async function exported(page) {
  await page.keyboard.press("Escape");
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

test("authored timers advance over hidden slides and end on an exit screen", async ({
  page,
}) => {
  const pres = deck([
    { effect: "none", advanceAfterMs: 300 },
    { effect: "none", advanceAfterMs: 100 },
    { effect: "none", advanceAfterMs: 450 },
  ]);
  P.setSlideHidden(P.getSlides(pres)[1], true);
  await load(page, pres);
  await page.clock.runFor(299);
  await expect(counter(page)).toHaveText("1 / 2");
  await page.clock.runFor(1);
  await expect(counter(page)).toHaveText("2 / 2");
  await page.clock.runFor(450);
  await expect(
    page.getByText("End of presentation. Click to exit.", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(image(page)).toBeVisible();
  await expect(counter(page)).toHaveText("2 / 2");
  await expect(image(page)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(counter(page)).toHaveText("1 / 2");
  await page.keyboard.press("ArrowRight");
  await expect(counter(page)).toHaveText("2 / 2");
  await page.clock.runFor(450);
  await page
    .getByText("End of presentation. Click to exit.", { exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Presentation mode" }),
  ).toHaveCount(0);
});

test("slide clicks obey advanceOnClick while explicit navigation stays available", async ({
  page,
}) => {
  await load(
    page,
    deck([
      { effect: "none", advanceOnClick: false },
      { effect: "none" },
      { effect: "none", advanceOnClick: false },
    ]),
  );
  await image(page).click();
  await expect(counter(page)).toHaveText("1 / 3");
  await page.keyboard.press("ArrowRight");
  await expect(counter(page)).toHaveText("2 / 3");
  await image(page).click();
  await expect(counter(page)).toHaveText("3 / 3");
  await image(page).click();
  await expect(counter(page)).toHaveText("3 / 3");
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByText("End of presentation. Click to exit.", { exact: true }),
  ).toBeVisible();
});

test("show-level manual timing overrides slide timers and survives download", async ({
  page,
}) => {
  await load(
    page,
    deck(
      [
        { effect: "none", advanceAfterMs: 100 },
        { effect: "none", advanceAfterMs: 200 },
      ],
      'useTimings="0" loop="1"',
    ),
  );
  await page.clock.runFor(2000);
  await expect(counter(page)).toHaveText("1 / 2");
  await image(page).click();
  await expect(counter(page)).toHaveText("2 / 2");
  await image(page).click();
  await expect(counter(page)).toHaveText("1 / 2");
  const restored = await exported(page);
  expect(P.getSlideShowTimingOptions(restored)).toEqual({
    useTimings: false,
    loop: true,
  });
  expect(
    P.getSlides(restored).map((s) => P.getSlideTransition(s).advanceAfterMs),
  ).toEqual([100, 200]);
});

test("timed loops restart at the first visible slide", async ({ page }) => {
  await load(
    page,
    deck(
      [
        { effect: "none", advanceAfterMs: 200 },
        { effect: "none", advanceAfterMs: 300 },
      ],
      'loop="1"',
    ),
  );
  await page.clock.runFor(200);
  await expect(counter(page)).toHaveText("2 / 2");
  await page.clock.runFor(300);
  await expect(counter(page)).toHaveText("1 / 2");
  await page.clock.runFor(200);
  await expect(counter(page)).toHaveText("2 / 2");
});

test("the advance clock waits for the actual incoming transition to finish", async ({
  page,
}) => {
  await load(
    page,
    deck([
      { effect: "none" },
      { effect: "fade", durationMs: 500, advanceAfterMs: 300 },
      { effect: "none" },
    ]),
  );
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await expect(transition(page, "fade")).toHaveCount(1);
  await holdTransition(page);
  await page.clock.runFor(2000);
  await expect(counter(page)).toHaveText("2 / 3");
  await releaseTransition(page);
  await expect(anyTransition(page)).toHaveCount(0);
  await page.clock.runFor(299);
  await expect(counter(page)).toHaveText("2 / 3");
  await page.clock.runFor(1);
  await expect(counter(page)).toHaveText("3 / 3");
});

test("Previous keeps the destination's click and dwell settings after the leaving effect finishes", async ({
  page,
}) => {
  await load(
    page,
    deck([
      { effect: "none", advanceOnClick: false, advanceAfterMs: 700 },
      { effect: "fade", durationMs: 500, advanceAfterMs: 80 },
      { effect: "none" },
    ]),
  );
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await page
    .getByRole("button", { name: "Previous slide", exact: true })
    .click();
  await expect(transition(page, "fade", "backward")).toHaveCount(1);
  await holdTransition(page);
  await image(page).click();
  await expect(counter(page)).toHaveText("1 / 3");
  // Dwell starts only after the reverse transition has actually settled.
  await page.clock.runFor(2000);
  await expect(counter(page)).toHaveText("1 / 3");
  await releaseTransition(page);
  await expect(anyTransition(page)).toHaveCount(0);
  await expect(counter(page)).toHaveText("1 / 3");
  await page.clock.runFor(699);
  await expect(counter(page)).toHaveText("1 / 3");
  await page.clock.runFor(1);
  await expect(counter(page)).toHaveText("2 / 3");
});

test("blank screens hold automatic advance until restored", async ({
  page,
}) => {
  await load(
    page,
    deck([{ effect: "none", advanceAfterMs: 400 }, { effect: "none" }]),
  );
  await page.clock.runFor(250);
  await page.keyboard.press("b");
  await page.clock.runFor(2000);
  await expect(counter(page)).toHaveText("1 / 2");
  await page.keyboard.press("b");
  await expect(image(page)).toBeVisible();
  // Restoring a paused native show restarts the current slide's delay.
  await page.clock.runFor(399);
  await expect(counter(page)).toHaveText("1 / 2");
  await page.clock.runFor(1);
  await expect(counter(page)).toHaveText("2 / 2");
});

test("navigation and closing invalidate pending timers and effect completions", async ({
  page,
}) => {
  await load(
    page,
    deck([
      { effect: "none", advanceAfterMs: 400 },
      { effect: "fade", durationMs: 1000, advanceAfterMs: 100 },
      { effect: "none" },
    ]),
  );
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await page.keyboard.press("End");
  await page.clock.runFor(2000);
  await expect(counter(page)).toHaveText("3 / 3");
  await page.keyboard.press("Escape");
  await page.clock.runFor(10000);
  await expect(
    page.getByRole("dialog", { name: "Presentation mode" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(counter(page)).toHaveText("1 / 3");
  await page.clock.runFor(399);
  await expect(counter(page)).toHaveText("1 / 3");
});

test("pause controls resume the full delay and manual navigation resumes a paused show", async ({
  page,
}) => {
  await load(
    page,
    deck([
      { effect: "none", advanceAfterMs: 400 },
      { effect: "none", advanceAfterMs: 600 },
      { effect: "none" },
    ]),
  );
  await page.clock.runFor(250);
  await page.keyboard.press("s");
  const resume = page.getByRole("button", {
    name: "Resume automatic advance",
    exact: true,
  });
  await expect(resume).toHaveAttribute("aria-pressed", "true");
  await page.clock.runFor(2000);
  await expect(counter(page)).toHaveText("1 / 3");
  await resume.press("Enter");
  await page.clock.runFor(399);
  await expect(counter(page)).toHaveText("1 / 3");
  await page.clock.runFor(1);
  await expect(counter(page)).toHaveText("2 / 3");
  await page.keyboard.press("s");
  await page.clock.runFor(1000);
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("button", { name: "Pause automatic advance", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.clock.runFor(400);
  await expect(counter(page)).toHaveText("2 / 3");
});

test("typing a slide number holds auto advance and elapsed-time reset does not change dwell", async ({
  page,
}) => {
  await load(
    page,
    deck([
      { effect: "none", advanceAfterMs: 400 },
      { effect: "none", advanceAfterMs: 600 },
      { effect: "none" },
    ]),
  );
  await page.clock.runFor(250);
  await page
    .getByRole("button", { name: "Time elapsed, press to start over" })
    .click();
  await page.clock.runFor(150);
  await expect(counter(page)).toHaveText("2 / 3");
  await page.keyboard.press("3");
  await page.clock.runFor(1000);
  await expect(counter(page)).toHaveText("Go to 3…");
  await page.keyboard.press("Enter");
  await expect(counter(page)).toHaveText("3 / 3");
  await page.clock.runFor(3000);
  await expect(counter(page)).toHaveText("3 / 3");
  await page.keyboard.press("Home");
  await image(page).focus();
  await page.keyboard.press("2");
  await page.clock.runFor(2000);
  await expect(counter(page)).toHaveText("1 / 3");
  await page.clock.runFor(399);
  await expect(counter(page)).toHaveText("1 / 3");
  await page.clock.runFor(1);
  await expect(counter(page)).toHaveText("2 / 3");
});

test("white blank screens retain keyboard focus and a click restores without advancing", async ({
  page,
}) => {
  await load(
    page,
    deck([{ effect: "none", advanceAfterMs: 400 }, { effect: "none" }]),
  );
  await page.keyboard.press("w");
  await expect(image(page)).toBeHidden();
  await expect(page.locator(".presenter-stage")).toBeFocused();
  await page.clock.runFor(1000);
  await page.locator(".presenter-stage").click({ position: { x: 40, y: 40 } });
  await expect(image(page)).toBeVisible();
  await expect(counter(page)).toHaveText("1 / 2");
  await page.clock.runFor(399);
  await expect(counter(page)).toHaveText("1 / 2");
  await page.clock.runFor(1);
  await expect(counter(page)).toHaveText("2 / 2");
});

test("a zero timer advances asynchronously and huge timers do not overflow", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await load(
    page,
    deck([
      { effect: "none", advanceAfterMs: 0 },
      { effect: "fade", durationMs: 5000, advanceAfterMs: 4294967295 },
    ]),
  );
  await page.clock.runFor(0);
  await expect(counter(page)).toHaveText("2 / 2");
  await expect(anyTransition(page)).toHaveCount(0);
  await page.clock.runFor(10000);
  await expect(counter(page)).toHaveText("2 / 2");
});

test("a swipe cannot also advance through its synthesized click", async ({
  page,
}) => {
  await load(
    page,
    deck([
      { effect: "none", advanceOnClick: false },
      { effect: "none" },
      { effect: "none" },
    ]),
  );
  await page.evaluate(() => {
    const target = document.querySelector(
      ".presenter-slide:not(.presenter-leaving)",
    );
    const first = new Touch({
      identifier: 1,
      target,
      clientX: 250,
      clientY: 150,
    });
    const last = new Touch({
      identifier: 1,
      target,
      clientX: 150,
      clientY: 155,
    });
    target.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        touches: [first],
        changedTouches: [first],
      }),
    );
    target.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        touches: [],
        changedTouches: [last],
      }),
    );
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(counter(page)).toHaveText("2 / 3");
  await image(page).click();
  await expect(counter(page)).toHaveText("3 / 3");
});

test("hyperlinks perform their own action without an extra slide click", async ({
  page,
}) => {
  const pres = deck([
    { effect: "none" },
    { effect: "none" },
    { effect: "none" },
  ]);
  const [first, second] = P.getSlides(pres);
  P.setShapeClickAction(text(first, "Go forward", 1, 1, 4, 1), {
    kind: "nextSlide",
  });
  P.setShapeClickAction(text(second, "External reference", 1, 1, 4, 1), {
    kind: "url",
    url: "https://example.com/reference",
  });
  await page.route("https://example.com/**", (route) =>
    route.fulfill({ body: "Reference" }),
  );
  await load(page, pres);
  await page.locator(".presenter-link").click();
  await expect(counter(page)).toHaveText("2 / 3");
  const popup = page.waitForEvent("popup");
  await page.locator("a.presenter-link").click();
  await (await popup).close();
  await expect(counter(page)).toHaveText("2 / 3");
});

test("timed presenter controls and the end screen remain accessible and fit the viewport", async ({
  page,
}) => {
  await load(
    page,
    deck([{ effect: "none", advanceAfterMs: 8000 }, { effect: "none" }]),
  );
  await expect(
    page.getByRole("button", { name: "Pause automatic advance", exact: true }),
  ).toBeVisible();
  // Axe uses browser timers itself. Hold the show's clock and let its checks
  // run against a live browser clock rather than the deterministic test clock.
  await page
    .getByRole("button", { name: "Pause automatic advance", exact: true })
    .click();
  await page.clock.resume();
  expect(
    await page.locator(".presenter-controls").evaluate((node) => {
      const box = node.getBoundingClientRect();
      return (
        box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
      );
    }),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".presenter-end")).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Present", exact: true }),
  ).toBeFocused();
});

test("loop boundaries wrap in both directions and keep transition direction", async ({
  page,
}) => {
  await load(
    page,
    deck(
      [
        { effect: "push", durationMs: 1000 },
        { effect: "push", durationMs: 1000 },
      ],
      'loop="1"',
    ),
  );
  const previous = page.getByRole("button", {
    name: "Previous slide",
    exact: true,
  });
  await expect(previous).toBeEnabled();
  const back = await previous.evaluate((button) => {
    button.click();
    const playing = document.querySelector(".slide-transition");
    return `${playing?.dataset.effect} ${playing?.dataset.direction}`;
  });
  expect(back).toBe("push backward");
  await expect(counter(page)).toHaveText("2 / 2");
  const forward = await page
    .getByRole("button", { name: "Next slide", exact: true })
    .evaluate((button) => {
      button.click();
      const playing = document.querySelector(".slide-transition");
      return `${playing?.dataset.effect} ${playing?.dataset.direction}`;
    });
  expect(forward).toBe("push forward");
  await expect(counter(page)).toHaveText("1 / 2");
});

test("a one-slide loop replays its transition on each new pass", async ({
  page,
}) => {
  await load(
    page,
    deck(
      [{ effect: "fade", durationMs: 1000, advanceAfterMs: 300 }],
      'loop="1"',
    ),
  );
  await page.clock.runFor(300);
  await expect(counter(page)).toHaveText("1 / 1");
  await expect(transition(page, "fade")).toHaveCount(1);
  await page.clock.runFor(2000);
  await expect(counter(page)).toHaveText("1 / 1");
  await expect(anyTransition(page)).toHaveCount(0);
  await page.clock.runFor(300);
  await expect(transition(page, "fade")).toHaveCount(1);
});
