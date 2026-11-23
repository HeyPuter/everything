// Slide Show and Record: set up, custom shows, the in-show menu and tools,
// ink kept after the show, presenter view with an audience window,
// rehearsed timings and recorded narration.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, createDeck, parseDeck, text } from "../src/model.js";

test.setTimeout(120_000);
// A fake camera and microphone for the recording studio.
test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
  permissions: ["camera", "microphone"],
});

async function story(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false,getUser:async()=>({username:"u"}),signIn:async()=>{},signOut:async()=>{}},fs:{readdir:async()=>[],write:async()=>({})},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  await page
    .getByRole("button", { name: "The big idea A clear, considered story" })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
}
async function tab(page, name) {
  await page.getByRole("tab", { name, exact: true }).click();
}
// A ribbon command, from its group's flyout where the ribbon is narrow.
async function command(page, name, group, role = "button") {
  const direct = page
    .getByRole("tabpanel")
    .getByRole(role, { name, exact: true });
  if (!(await direct.isVisible())) {
    await page
      .getByRole("tabpanel")
      .getByRole("button", { name: group, exact: true })
      .click();
  }
  return page.getByRole(role, { name, exact: true }).first();
}
const show = (page) => page.getByRole("dialog", { name: "Presentation mode" });
async function download(page) {
  // Phones have a File options button in place of the menu bar.
  const file = page.getByRole("menuitem", { name: "File", exact: true });
  if (await file.isVisible()) await file.click();
  else await page.getByRole("button", { name: "File options" }).click();
  const event = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  return parseDeck(await readFile(await (await event).path()));
}

test("set up show, custom shows and play from start", async ({ page }) => {
  await story(page);
  await tab(page, "Slide Show");
  // A custom show of slides 4 and 2, in that order.
  await (await command(page, "Custom Show", "Start Slide Show")).click();
  await page.getByRole("menuitem", { name: "Custom Shows…" }).click();
  await page.getByRole("button", { name: "New…" }).click();
  const define = page.getByRole("dialog", { name: "Define Custom Show" });
  await define.getByRole("textbox", { name: "Slide show name" }).fill("Short");
  await define.getByRole("checkbox", { name: /^4\./ }).check();
  await define.getByRole("button", { name: "Add »" }).click();
  await define.getByRole("checkbox", { name: /^2\./ }).check();
  await define.getByRole("button", { name: "Add »" }).click();
  await define.getByRole("button", { name: "OK" }).click();
  const list = page.getByRole("listbox", { name: "Custom shows" });
  await expect(list.locator("option")).toHaveText(["Short (2 slides)"]);
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(show(page)).toBeVisible();
  await expect(show(page).locator(".presenter-counter")).toHaveText("1 / 2");
  await expect(show(page).locator(".presenter-slide")).toHaveAttribute(
    "alt",
    /From idea to impact/,
  );
  await page.keyboard.press("Escape");
  await expect(show(page)).toBeHidden();

  // Set Up Slide Show: slides 2 to 3, looping.
  await (await command(page, "Set Up Slide Show", "Set Up")).click();
  const setup = page.getByRole("dialog", { name: "Set Up Slide Show" });
  await setup.getByRole("radio", { name: "From" }).check();
  await setup.getByRole("spinbutton", { name: "From slide" }).fill("2");
  await setup.getByRole("spinbutton", { name: "To slide" }).fill("3");
  await setup
    .getByRole("checkbox", { name: "Loop continuously until Esc" })
    .check();
  await setup.getByRole("button", { name: "OK" }).click();
  await expect(setup).toBeHidden();
  await (await command(page, "Play from Start", "Start Slide Show")).click();
  await expect(show(page).locator(".presenter-counter")).toHaveText("1 / 2");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  // It loops back to the first slide of the range.
  await expect(show(page).locator(".presenter-counter")).toHaveText("1 / 2");
  await page.keyboard.press("Escape");

  // The setup and the custom show are in the file.
  const deck = await download(page);
  expect(P.getSlideShowSetup(deck)).toMatchObject({
    loop: true,
    selection: { kind: "range", start: 2, end: 3 },
  });
  const [custom] = P.getCustomShows(deck);
  const parts = P.getSlides(deck).map((s) => P.getSlidePartName(s));
  expect(custom.name).toBe("Short");
  expect(custom.slides.map((s) => P.getSlidePartName(s))).toEqual([
    parts[3],
    parts[1],
  ]);
});

test("the show's menu, tools and shortcuts; ink is kept after the show", async ({
  page,
}) => {
  await story(page);
  // Play from Start starts at the first slide even from another one.
  await page.locator(".slide-item").nth(2).click();
  await tab(page, "Slide Show");
  await (await command(page, "Play from Start", "Start Slide Show")).click();
  const d = show(page);
  await expect(d.locator(".presenter-counter")).toHaveText("1 / 5");
  await page.keyboard.press("ArrowRight");
  await expect(d.locator(".presenter-counter")).toHaveText("2 / 5");

  // The right-click menu.
  const frame = d.locator(".presenter-frame");
  const box = await frame.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
    button: "right",
  });
  const menu = page.getByRole("menu", { name: "Slide show" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Next" }).click();
  await expect(d.locator(".presenter-counter")).toHaveText("3 / 5");

  // See all slides, and go to one.
  await page.keyboard.press("g");
  const grid = d.getByRole("region", { name: "All slides" });
  await expect(grid).toBeVisible();
  await grid.getByRole("button", { name: /^Slide 2/ }).click();
  await expect(grid).toBeHidden();
  await expect(d.locator(".presenter-counter")).toHaveText("2 / 5");

  // The shortcut list.
  await page.keyboard.press("?");
  await expect(
    d.getByRole("dialog", { name: "Slide show shortcuts" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    d.getByRole("dialog", { name: "Slide show shortcuts" }),
  ).toBeHidden();
  await expect(d).toBeVisible();

  // Zoom in and out.
  await page.keyboard.press("+");
  await expect(d.locator(".presenter-stage")).toHaveClass(/show-zoomed/);
  await page.keyboard.press("-");
  await expect(d.locator(".presenter-stage")).not.toHaveClass(/show-zoomed/);

  // A black screen with the period key, back with any key.
  await page.keyboard.press(".");
  await expect(d.locator(".presenter-stage")).toHaveClass(/blank/);
  await page.keyboard.press(".");
  await expect(d.locator(".presenter-stage")).not.toHaveClass(/blank/);

  // The pen draws without moving the show on; E erases; the pen again.
  await page.keyboard.press("Control+p");
  const draw = async () => {
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 160, { steps: 6 });
    await page.mouse.up();
  };
  await draw();
  await expect(d.locator(".show-ink path")).toHaveCount(1);
  await expect(d.locator(".presenter-counter")).toHaveText("2 / 5");
  await page.keyboard.press("e");
  await expect(d.locator(".show-ink path")).toHaveCount(0);
  await draw();
  await expect(d.locator(".show-ink path")).toHaveCount(1);
  // Escape leaves the pen first, then ends the show.
  await page.keyboard.press("Escape");
  await expect(d).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(d).toBeHidden();
  const prompt = page.getByRole("dialog", {
    name: "Keep your ink?",
  });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Keep Ink", exact: true }).click();
  await expect(prompt).toBeHidden();
  const deck = await download(page);
  const ink = P.getSlideShapes(P.getSlides(deck)[1]).filter((s) =>
    P.getShapeName(s).startsWith("Ink "),
  );
  expect(ink).toHaveLength(1);
});

test("menus opened in a fullscreen show appear inside it", async ({ page }) => {
  await story(page);
  await tab(page, "Slide Show");
  await (await command(page, "Play from Start", "Start Slide Show")).click();
  const d = show(page);
  await d.getByRole("button", { name: "Toggle fullscreen" }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  const box = await d.locator(".presenter-frame").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
    button: "right",
  });
  const menu = page.getByRole("menu", { name: "Slide show" });
  await expect(menu).toBeVisible();
  expect(
    await menu.evaluate((m) => document.fullscreenElement.contains(m)),
  ).toBe(true);
  await menu.getByRole("menuitem", { name: "Next" }).click();
  await expect(d.locator(".presenter-counter")).toHaveText("2 / 5");
});

test("presenter view shows notes, the next slide and a timer, with an audience window", async ({
  page,
}) => {
  await story(page);
  await page
    .getByRole("textbox", { name: "Speaker notes", exact: true })
    .fill("Remember the story.");
  await page.locator("#slide-canvas").click({ position: { x: 5, y: 5 } });
  await tab(page, "Slide Show");
  await (await command(page, "Presenter View", "Start Slide Show")).click();
  const d = show(page);
  const side = d.getByRole("complementary", {
    name: "Presenter notes and next slide",
  });
  await expect(side).toBeVisible();
  await expect(side.locator(".show-console-notes-text")).toHaveText(
    "Remember the story.",
  );
  await expect(side.locator(".show-console-next-label")).toHaveText(/^Slide 2/);
  await expect(d.locator(".show-console-counter")).toHaveText("Slide 1 of 5");
  // One elapsed-time clock: the view's, not the control bar's as well.
  await expect(d.getByRole("timer", { name: "Time elapsed" })).toBeVisible();
  await expect(d.getByRole("button", { name: /^Time elapsed/ })).toBeHidden();
  const size = await side
    .locator(".show-console-notes-text")
    .evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
  await side
    .getByRole("button", { name: "Make the notes text larger" })
    .click();
  await expect
    .poll(() =>
      side
        .locator(".show-console-notes-text")
        .evaluate((n) => parseFloat(getComputedStyle(n).fontSize)),
    )
    .toBeGreaterThan(size);
  // The timer pauses.
  await d.getByRole("button", { name: "Pause the timer" }).click();
  await expect(
    d.getByRole("button", { name: "Resume the timer" }),
  ).toBeVisible();

  // The slide moves to a second window; the presenter keeps a copy. Phones
  // have no second screen and do not offer it.
  const swap = d.getByRole("button", { name: "Audience window" });
  if (!(await swap.isVisible())) {
    await d.getByRole("button", { name: "End Show" }).click();
    await expect(d).toBeHidden();
    return;
  }
  const [audience] = await Promise.all([
    page.context().waitForEvent("page"),
    swap.click(),
  ]);
  await expect(
    audience.locator(".presenter-frame .presenter-slide"),
  ).toBeVisible();
  await expect(d.locator(".show-mirror")).toHaveCount(1);
  await audience.keyboard.press("ArrowRight");
  await expect(d.locator(".show-console-counter")).toHaveText("Slide 2 of 5");
  await audience.keyboard.press("b");
  await expect(audience.locator(".show-audience")).toHaveClass(/blank/);
  await audience.keyboard.press("b");
  // Escape there puts the laser away before it ends the show.
  await audience.keyboard.press("l");
  await expect(audience.locator(".presenter-frame")).toHaveClass(/laser-mode/);
  await audience.keyboard.press("Escape");
  await expect(audience.locator(".presenter-frame")).not.toHaveClass(
    /laser-mode/,
  );
  await expect(d).toBeVisible();
  await expect(d.getByRole("button", { name: "One window" })).toBeVisible();
  // Closing it brings the slide back to this window.
  await audience.close();
  await expect(d.locator(".show-mirror")).toHaveCount(0);
  await expect(swap).toBeVisible();
  await expect(
    d.locator(".presenter-slide-area .presenter-frame .presenter-slide"),
  ).toBeVisible();
  await d.getByRole("button", { name: "End Show" }).click();
  await expect(d).toBeHidden();
});

test("rehearsed timings are kept on the slides", async ({ page }) => {
  await story(page);
  await tab(page, "Slide Show");
  await (await command(page, "Rehearse Timings", "Set Up")).click();
  const d = show(page);
  const bar = d.getByRole("toolbar", { name: "Rehearsal timer" });
  await expect(bar).toBeVisible();
  await page.waitForTimeout(1200);
  await bar.getByRole("button", { name: "Next" }).click();
  await expect(d.locator(".presenter-counter")).toHaveText("2 / 5");
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape");
  const prompt = page.getByRole("dialog", {
    name: "Keep the new slide timings?",
  });
  await prompt.getByRole("button", { name: "Keep Timings" }).click();
  await expect(prompt).toBeHidden();
  const deck = await download(page);
  const [first, second, third] = P.getSlides(deck);
  expect(
    P.getEffectiveSlideTransition(first).advanceAfterMs,
  ).toBeGreaterThanOrEqual(1000);
  expect(P.getEffectiveSlideTransition(second).advanceAfterMs).toBeGreaterThan(
    0,
  );
  expect(P.getEffectiveSlideTransition(third)?.advanceAfterMs).toBeUndefined();
});

test("recording narration with the camera, a live camera, and clearing it", async ({
  page,
}) => {
  await story(page);
  await tab(page, "Record");
  await (await command(page, "Live Camera", "Camera")).click();
  await (await command(page, "From Beginning", "Record")).click();
  const d = show(page);
  const bar = d.getByRole("toolbar", { name: "Recording" });
  await expect(bar).toBeVisible();
  await expect(d.locator(".show-cam-preview")).toBeVisible();
  await bar.getByRole("button", { name: "Start recording" }).click();
  await page.waitForTimeout(1200);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(800);
  await bar.getByRole("button", { name: "Stop recording" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#toast")).toHaveText(
    "Recording saved on 2 slides.",
  );

  let deck = await download(page);
  const narration = (s) =>
    P.getSlideShapes(s).find(
      (x) => P.getShapeObjectData(x)?.recording === "narration",
    );
  const [first, second] = P.getSlides(deck);
  // The recording took the live camera's place on the first slide.
  expect(P.getShapeMedia(narration(first))).toMatchObject({ kind: "video" });
  expect(
    P.getSlideShapes(first).some(
      (x) => P.getShapeObjectData(x)?.type === "camera",
    ),
  ).toBe(false);
  expect(narration(second)).toBeTruthy();
  expect(P.getEffectiveSlideTransition(first).advanceAfterMs).toBeGreaterThan(
    500,
  );

  // The narration plays in the show, and not when narrations are off.
  await tab(page, "Slide Show");
  await (await command(page, "Play from Start", "Start Slide Show")).click();
  await expect(d.locator(".presenter-media.video")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await (
    await command(page, "Play Narrations", "Set Up", "checkbox")
  ).uncheck();
  await (await command(page, "Play from Start", "Start Slide Show")).click();
  await expect(d).toBeVisible();
  await expect(d.locator(".presenter-media")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Reset to Camera puts the camera back where the recording was.
  await tab(page, "Record");
  await (await command(page, "Reset to Camera", "Edit")).click();
  await page.getByRole("menuitem", { name: "Reset All Slides" }).click();
  deck = await download(page);
  for (const s of P.getSlides(deck).slice(0, 2)) {
    expect(narration(s)).toBeFalsy();
    expect(
      P.getSlideShapes(s).some(
        (x) => P.getShapeObjectData(x)?.type === "camera",
      ),
    ).toBe(true);
  }
});

test("a recording keeps when each click came on the slide", async ({
  page,
}) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const boxes = [1, 5].map((x, i) => text(slide, `Box ${i + 1}`, x, 1, 3, 1));
  P.setSlideAnimations(
    slide,
    boxes.map((box) => ({
      shapeId: String(P.getShapeId(box)),
      presetClass: "entr",
      presetId: 10,
      presetSubtype: 0,
      start: "click",
      delayMs: 0,
      durationMs: 200,
    })),
  );
  text(P.addBlankSlide(pres), "Two", 1, 1, 8, 2);
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
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
    name: "Builds.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".slide-image")).toBeVisible();
  await tab(page, "Record");
  await (await command(page, "From Beginning", "Record")).click();
  const d = show(page);
  const bar = d.getByRole("toolbar", { name: "Recording" });
  await bar.getByRole("button", { name: "Start recording" }).click();
  await expect(
    bar.getByRole("button", { name: "Stop recording" }),
  ).toBeVisible();
  await page.waitForTimeout(700);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(900);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(500);
  await bar.getByRole("button", { name: "Stop recording" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#toast")).toHaveText(
    "Recording saved on 1 slide.",
  );
  const deck = await download(page);
  const [first] = P.getSlides(deck);
  const [one, two] = P.getSlideClickTimings(first);
  expect(one).toBeGreaterThanOrEqual(500);
  // The second click came 900 ms after the first, whose effect took 200.
  expect(two).toBeGreaterThanOrEqual(500);
  expect(P.getEffectiveSlideTransition(first).advanceAfterMs).toBeGreaterThan(
    one + two,
  );
});

test("the screen stays on during a show, and is let go when it ends", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.wake = { asked: 0, released: 0 };
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async () => {
          window.wake.asked++;
          const lock = new EventTarget();
          lock.release = async () => {
            window.wake.released++;
            lock.dispatchEvent(new Event("release"));
          };
          return lock;
        },
      },
    });
  });
  await story(page);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const d = show(page);
  await expect(d).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.wake))
    .toEqual({
      asked: 1,
      released: 0,
    });
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(d).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => window.wake))
    .toEqual({
      asked: 1,
      released: 1,
    });
});

test("ending a show before the browser hands over the camera lets it go", async ({
  page,
}) => {
  // The browser takes a while to answer for the devices.
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    const ask = media.getUserMedia.bind(media);
    window.tracks = [];
    window.asking = 0;
    media.getUserMedia = async (want) => {
      window.asking++;
      await new Promise((r) => setTimeout(r, 1500));
      const stream = await ask(want);
      window.tracks.push(...stream.getTracks());
      window.asking--;
      return stream;
    };
  });
  await story(page);
  await tab(page, "Record");
  await (await command(page, "Live Camera", "Camera")).click();
  await (await command(page, "From Beginning", "Record")).click();
  const d = show(page);
  await expect(d.getByRole("toolbar", { name: "Recording" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(d).toBeHidden();
  // Whatever the browser hands over once the show has ended (the slide's
  // live camera, and the studio's camera and microphone if it had asked
  // before the show ended) is let go.
  await expect
    .poll(
      () => page.evaluate(() => (window.asking ? -1 : window.tracks.length)),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  const states = await page.evaluate(() =>
    window.tracks.map((t) => t.readyState),
  );
  expect(states.every((state) => state === "ended")).toBe(true);
});

test("switching to a custom show asks about the ink first", async ({
  page,
}) => {
  const pres = createDeck("blank");
  for (let i = 0; i < 3; i++)
    text(
      i ? P.addBlankSlide(pres) : P.getSlides(pres)[0],
      `Slide ${i + 1}`,
      1,
      1,
      8,
      2,
    );
  const slides = P.getSlides(pres);
  P.setCustomShows(pres, [{ name: "Short", slides: [slides[2], slides[1]] }]);
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
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
    name: "Custom.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".slide-image")).toBeVisible();
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const d = show(page);
  await page.keyboard.press("Control+p");
  const box = await d.locator(".presenter-frame").boundingBox();
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 160, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Custom Show" }).click();
  await page.getByRole("menuitem", { name: "Short" }).click();
  const prompt = page.getByRole("dialog", { name: "Keep your ink?" });
  await expect(prompt).toBeVisible();
  await expect(d).toHaveCount(0);
  await prompt.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(d.locator(".presenter-counter")).toHaveText("1 / 2");
});

test("a trimmed video's control bar covers only the part that is left", async ({
  page,
}) => {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  // A three-second video, recorded from a canvas.
  const webm = await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement("canvas"), {
      width: 64,
      height: 36,
    });
    const g = canvas.getContext("2d");
    const recorder = new MediaRecorder(canvas.captureStream(30), {
      mimeType: "video/webm",
    });
    const chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.start(100);
    const t0 = performance.now();
    await new Promise((resolve) => {
      const draw = () => {
        g.fillStyle = `hsl(${(performance.now() - t0) / 10}, 80%, 50%)`;
        g.fillRect(0, 0, 64, 36);
        if (performance.now() - t0 < 3000) requestAnimationFrame(draw);
        else resolve();
      };
      draw();
    });
    recorder.stop();
    await new Promise((resolve) => (recorder.onstop = resolve));
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  });
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const video = P.addSlideMedia(
    slide,
    { kind: "video", data: Uint8Array.from(webm), contentType: "video/webm" },
    { x: 914400, y: 914400, w: 3657600, h: 2057400 },
    { start: "automatically", trimStart: 1500, trimEnd: 500 },
  );
  P.setShapeObjectData(video, { type: "media", durationMs: 3000 });
  const choose = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await choose
  ).setFiles({
    name: "Trimmed.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".slide-image")).toBeVisible();
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const d = show(page);
  const element = d.locator(".presenter-media video");
  const time = () => element.evaluate((v) => v.currentTime);
  // It plays from the trimmed start, and the bar counts from there.
  await expect.poll(time).toBeGreaterThan(1.5);
  await element.evaluate((v) => v.pause());
  await expect(d.locator(".show-media-time")).toHaveText("0:00");
  const seek = d.getByRole("slider", { name: "Seek" });
  expect(Number(await seek.inputValue())).toBeLessThan(800);
  // Its start is the trimmed start, not the start of the file.
  await seek.evaluate((input) => {
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(await time()).toBeGreaterThanOrEqual(1.49);
});

test("in a rehearsal of a looping show, Presenter View shows the end coming after the last slide", async ({
  page,
}) => {
  const pres = createDeck("blank");
  text(P.getSlides(pres)[0], "One", 1, 1, 8, 2);
  text(P.addBlankSlide(pres), "Two", 1, 1, 8, 2);
  P.setSlideShowSetup(pres, { loop: true });
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
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
    name: "Looping.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".slide-image")).toBeVisible();
  await tab(page, "Slide Show");
  await (await command(page, "Rehearse Timings", "Set Up")).click();
  const d = show(page);
  await d
    .locator(".presenter-stage")
    .click({ button: "right", position: { x: 100, y: 100 } });
  await page.getByRole("menuitem", { name: "Show Presenter View" }).click();
  await page.keyboard.press("End");
  await expect(d.locator(".show-console-counter")).toHaveText("Slide 2 of 2");
  // A rehearsal does not loop.
  await expect(d.locator(".show-console-next-label")).toHaveText(
    "End of slide show",
  );
  await page.keyboard.press("ArrowRight");
  await expect(d.locator(".show-console-counter")).toHaveText("End of show");
});
