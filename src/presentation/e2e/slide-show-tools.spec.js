// Slide Show and Record: set up, custom shows, the in-show menu and tools,
// ink kept after the show, presenter view with an audience window,
// rehearsed timings and recorded narration.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, parseDeck } from "../src/model.js";

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
  // Closing it brings the slide back to this window.
  await audience.close();
  await expect(d.locator(".show-mirror")).toHaveCount(0);
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
