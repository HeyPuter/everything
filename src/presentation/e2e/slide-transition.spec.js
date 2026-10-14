import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, parseDeck } from "../src/model.js";
import { alternate, fixture } from "../tests/slide-transition-fixture.js";
import { presetTransition } from "../tests/preset-transition-fixture.js";

async function importDeck(page, pres) {
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
    name: "Transition alternatives.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  await expect(page.locator(".slide-image")).toBeVisible();
  if (
    !(await page
      .getByRole("combobox", { name: "Transition", exact: true })
      .isVisible())
  ) {
    // The Format Pane, from the View tab, shows the slide's settings.
    await page.getByRole("tab", { name: "View", exact: true }).click();
    await page
      .locator('.ribbon-panel:not([hidden]) [data-command="view-format-pane"]')
      .click();
  }
}

// The transition playing over the show (see src/transitions/player.js).
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
const settled = (page) =>
  expect(page.locator(".slide-transition")).toHaveCount(0);

async function downloadDeck(page) {
  await page
    .getByRole("menuitem", { name: "File", exact: true })
    .or(page.getByRole("button", { name: "File options" }))
    .filter({ visible: true })
    .click();
  const result = page.waitForEvent("download");
  await page
    .getByRole("menuitem", {
      name: "Download PowerPoint (.pptx)",
      exact: true,
    })
    .click();
  return parseDeck(await readFile(await (await result).path()));
}

for (const level of ["local", "layout"])
  test(`an imported ${level} Page Curl is recognized, plays, and survives editing, undo and download`, async ({
    page,
  }) => {
    const xml = presetTransition("pageCurlSingle", { inversion: 'invX="1"' });
    const f = await fixture(
      level === "local" ? xml : "",
      level === "layout" ? { layout: xml } : {},
    );
    P.duplicateSlide(f.pres, f.slide);
    await importDeck(page, f.pres);
    const transition = page.getByRole("combobox", {
      name: "Transition",
      exact: true,
    });
    await expect(transition).toHaveValue("pageCurl");
    const expected = {
      effect: "pageCurlSingle",
      invertX: true,
      durationMs: 2450,
      advanceAfterMs: 8100,
      advanceOnClick: false,
      speed: "slow",
    };
    for (const slide of P.getSlides(await downloadDeck(page)))
      expect(P.getEffectiveSlideTransition(slide)).toEqual(expected);
    // A deliberate Fade selection replaces Page Curl. It must not be skipped
    // just because the compatibility fallback happens to be a fade as well.
    await transition.selectOption("fade");
    await expect(transition).toHaveValue("fade");
    let downloaded = await downloadDeck(page);
    expect(P.getSlideTransition(P.getSlides(downloaded)[0])).toEqual({
      ...expected,
      effect: "fade",
      invertX: undefined,
    });
    expect(P.getEffectiveSlideTransition(P.getSlides(downloaded)[1])).toEqual(
      expected,
    );
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(transition).toHaveValue("pageCurl");
    downloaded = await downloadDeck(page);
    expect(P.getEffectiveSlideTransition(P.getSlides(downloaded)[0])).toEqual(
      expected,
    );
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(transition).toHaveValue("fade");
    // The presenter plays the curl itself, with its authored duration.
    await page.getByRole("button", { name: "Present", exact: true }).click();
    await page.getByRole("button", { name: "Next slide", exact: true }).click();
    expect(await playing(page)).toEqual({
      effect: "pageCurlSingle",
      direction: "forward",
      duration: 2450,
    });
    await page.keyboard.press("Escape");
  });

test("alternative transitions play, preserve modern content, and override None on .pptx download", async ({
  page,
}) => {
  const f = await fixture(
    alternate('<p:transition><new:prstTrans prst="future"/></p:transition>'),
  );
  P.duplicateSlide(f.pres, f.slide);
  await importDeck(page, f.pres);
  await expect(
    page.getByRole("combobox", { name: "Transition", exact: true }),
  ).toHaveValue("fade");
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  expect(await playing(page)).toMatchObject({ effect: "fade" });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Presentation mode" }),
  ).toHaveCount(0);

  let downloaded = await downloadDeck(page);
  for (const slide of P.getSlides(downloaded)) {
    expect(P.getSlideXmlString(slide)).toContain('prst="future"');
    expect(P.getSlideTransition(slide)?.effect).toBe("fade");
  }
  await page
    .getByRole("combobox", { name: "Transition", exact: true })
    .selectOption("none");
  downloaded = await downloadDeck(page);
  expect(P.getSlideTransition(P.getSlides(downloaded)[0])?.effect).toBe("none");
  expect(P.getSlideXmlString(P.getSlides(downloaded)[0])).not.toContain(
    "AlternateContent",
  );
  expect(P.getSlideXmlString(P.getSlides(downloaded)[1])).toContain(
    'prst="future"',
  );
});

test("inherited transitions play and None remains explicit after undo, redo, and download", async ({
  page,
}) => {
  const f = await fixture("", {
    layout:
      '<p:transition spd="slow" advClick="0" advTm="4300"><p:fade/></p:transition>',
    master: "<p:transition><p:push/></p:transition>",
  });
  P.duplicateSlide(f.pres, f.slide);
  await importDeck(page, f.pres);
  const transition = page.getByRole("combobox", {
    name: "Transition",
    exact: true,
  });
  await expect(transition).toHaveValue("fade");
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  expect(await playing(page)).toMatchObject({ effect: "fade" });
  await page.keyboard.press("Escape");
  await transition.selectOption("none");
  await expect(transition).toHaveValue("none");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(transition).toHaveValue("fade");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(transition).toHaveValue("none");
  const downloaded = await downloadDeck(page);
  const [first, second] = P.getSlides(downloaded);
  expect(P.getSlideTransition(first)).toEqual({
    effect: "none",
    speed: "slow",
    advanceOnClick: false,
    advanceAfterMs: 4300,
  });
  expect(P.getEffectiveSlideTransition(first)).toEqual(
    P.getSlideTransition(first),
  );
  expect(P.getSlideTransition(second)).toBeNull();
  expect(P.getEffectiveSlideTransition(second)?.effect).toBe("fade");
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  expect(await playing(page)).toMatchObject({ effect: "fade" });
  await settled(page);
  // Previous reverses the leaving slide's inherited fade even though the
  // destination has an explicit None transition.
  await page
    .getByRole("button", { name: "Previous slide", exact: true })
    .click();
  expect(await playing(page)).toMatchObject({
    effect: "fade",
    direction: "backward",
  });
  await page.keyboard.press("Escape");
});
