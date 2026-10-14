import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, createDeck, parseDeck, shape } from "../src/model.js";
import { synthesizeSound } from "../src/transitions/sounds.js";

// Effect sounds and the "hide" after-effects, from the Effect Options dialog
// to the file and the slide show.

async function load(page, pres) {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  // Count sounds started through Web Audio.
  await page.addInitScript(() => {
    window.__soundsStarted = 0;
    const proto = globalThis.AudioBufferSourceNode?.prototype;
    if (!proto) return;
    const start = proto.start;
    proto.start = function (...args) {
      window.__soundsStarted++;
      return start.apply(this, args);
    };
  });
  await page.goto("/#/home");
  const choose = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await choose
  ).setFiles({
    name: "Sounds.pptx",
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

const fade = (shapeId, extra = {}) => ({
  shapeId: String(shapeId),
  presetClass: "entr",
  presetId: 10,
  presetSubtype: 0,
  start: "click",
  delayMs: 0,
  durationMs: 200,
  ...extra,
});

test("an effect with a sound plays it and hides on the next click", async ({
  page,
}) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const a = shape(slide, 1, 1, 2, 1.5, "#2266cc");
  const b = shape(slide, 5, 1, 2, 1.5, "#cc6622");
  const relId = P.addSlideAnimationSound(
    slide,
    synthesizeSound("pop"),
    "Pop.wav",
  );
  P.setSlideAnimations(slide, [
    fade(P.getShapeId(a), {
      sound: { relId, name: "Pop.wav" },
      after: { kind: "hideOnClick" },
    }),
    fade(P.getShapeId(b)),
  ]);
  await load(page, pres);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const visible = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".presenter .anim-fx")].map(
        (fx) => getComputedStyle(fx).visibility === "visible",
      ),
    );
  await expect.poll(visible).toEqual([false, false]);
  await page.keyboard.press("ArrowRight");
  await expect.poll(visible).toEqual([true, false]);
  await expect
    .poll(() => page.evaluate(() => window.__soundsStarted))
    .toBeGreaterThan(0);
  await page.keyboard.press("ArrowRight");
  await expect.poll(visible).toEqual([false, true]);
  // Back one step: the first shape shows again.
  await page.keyboard.press("ArrowLeft");
  await expect.poll(visible).toEqual([true, false]);
});

test("Effect Options adds a sound and an after-effect that are saved", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "The Animation Pane workflow is a desktop and tablet flow",
  );
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const a = shape(slide, 1, 1, 2, 1.5, "#2266cc");
  P.setSlideAnimations(slide, [fade(P.getShapeId(a))]);
  await load(page, pres);
  const tab = page.getByRole("tab", { name: "Animations", exact: true });
  if (!(await tab.isVisible())) test.skip(true, "The ribbon is folded away");
  await tab.click();
  const paneButton = page
    .locator(".ribbon-body")
    .getByRole("button", { name: "Animation Pane" });
  if (await paneButton.isVisible()) await paneButton.click();
  else {
    await page
      .locator(
        '#ribbon-panel-animations .ribbon-fold[title="Advanced Animation"]',
      )
      .click();
    await page
      .locator(".ribbon-fold-panel")
      .getByRole("button", { name: "Animation Pane" })
      .click();
  }
  const pane = page.getByRole("complementary", { name: "Animation Pane" });
  const row = pane.getByRole("option").first();
  await row.click();
  await row.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Sound" }).selectOption("Chime");
  await dialog
    .getByRole("combobox", { name: "After animation" })
    .selectOption("Hide on Next Mouse Click");
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(dialog).toHaveCount(0);
  const saved = P.getSlides(await download(page))[0];
  const [effect] = P.getSlideAnimations(saved);
  expect(effect.after).toEqual({ kind: "hideOnClick" });
  expect(effect.sound?.name).toBe("Chime.wav");
  const data = P.getSlideAnimationSoundData(saved, effect.sound.relId);
  expect(data?.contentType).toBe("audio/wav");
  // Reopening the dialog shows the choices.
  await row.click();
  await row.press("Enter");
  await expect(dialog.getByRole("combobox", { name: "Sound" })).toHaveValue(
    "builtin:chime",
  );
  await expect(
    dialog.getByRole("combobox", { name: "After animation" }),
  ).toHaveValue("hideOnClick");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});
