import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { P, parseDeck } from "../src/model.js";
import { showSelectionDeck } from "../tests/slide-show-fixture.js";

async function open(page, pres) {
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
    name: "Configured slide show.pptx",
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
async function download(page) {
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
  return new Uint8Array(await readFile(await (await result).path()));
}

test("configured slide ranges use presentation indexes before skipping hidden slides", async ({
  page,
}) => {
  const pres = showSelectionDeck('<p:sldRg st="2" end="4"/>');
  P.setSlideHidden(P.getSlides(pres)[2], true);
  await open(page, pres);
  await expect(counter(page)).toHaveText("1 / 2");
  await expect(image(page)).toHaveAttribute("alt", /Selected show slide 2/);
  await page.clock.runFor(300);
  await expect(counter(page)).toHaveText("2 / 2");
  await expect(image(page)).toHaveAttribute("alt", /Selected show slide 4/);
  await page.clock.runFor(300);
  await expect(page.locator(".presenter-end")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(image(page)).toHaveAttribute("alt", /Selected show slide 4/);
  await page.keyboard.press("Home");
  await expect(image(page)).toHaveAttribute("alt", /Selected show slide 2/);
  const saved = await download(page);
  const before = unzipSync(await P.savePresentation(pres));
  const after = unzipSync(saved);
  expect(after["ppt/presProps.xml"]).toEqual(before["ppt/presProps.xml"]);
  expect(P.getSlides(await parseDeck(saved))).toHaveLength(5);
});

test("custom shows retain authored order, repeated slides and explicit hidden references through loops and export", async ({
  page,
}) => {
  const pres = showSelectionDeck('<p:custShow id="7"/>', {
    attrs: 'loop="1"',
    customShows: [{ id: 7, sequence: [3, 1, 3] }],
  });
  P.setSlideHidden(P.getSlides(pres)[1], true);
  await open(page, pres);
  await expect(counter(page)).toHaveText("1 / 3");
  await expect(image(page)).toHaveAttribute("alt", /Selected show slide 4/);
  await page.clock.runFor(300);
  await expect(counter(page)).toHaveText("2 / 3");
  await expect(image(page)).toHaveAttribute("alt", /Selected show slide 2/);
  await expect(page.locator(".presenter-next-label")).toHaveText(
    /Slide 3: Selected show slide 4/,
  );
  await page.clock.runFor(300);
  await expect(counter(page)).toHaveText("3 / 3");
  await expect(image(page)).toHaveAttribute("alt", /Selected show slide 4/);
  await page.clock.runFor(300);
  await expect(counter(page)).toHaveText("1 / 3");
  await page.keyboard.press("ArrowLeft");
  await expect(counter(page)).toHaveText("3 / 3");
  await page.keyboard.press("Home");
  await page
    .getByRole("button", { name: "Pause automatic advance", exact: true })
    .click();
  await page.clock.resume();
  const results = await new AxeBuilder({ page })
    .include(".presenter")
    .analyze();
  expect(results.violations).toEqual([]);
  const saved = await download(page);
  const before = unzipSync(await P.savePresentation(pres));
  const after = unzipSync(saved);
  expect(after["ppt/presProps.xml"]).toEqual(before["ppt/presProps.xml"]);
  expect(after["ppt/presentation.xml"]).toEqual(before["ppt/presentation.xml"]);
  expect(P.getSlides(await parseDeck(saved))).toHaveLength(5);
});

for (const empty of [false, true])
  test(`${empty ? "empty" : "out-of-bounds"} configured selections leave the editor available`, async ({
    page,
  }) => {
    await open(
      page,
      empty
        ? showSelectionDeck('<p:custShow id="7"/>', {
            customShows: [{ id: 7, sequence: [] }],
          })
        : showSelectionDeck('<p:sldRg st="7" end="9"/>'),
    );
    await expect(
      page.getByRole("dialog", { name: "Presentation mode" }),
    ).toHaveCount(0);
    await expect(
      page.getByText("The configured slide show has no slides to present."),
    ).toBeVisible();
    await expect(page.locator(".slide-image")).toBeVisible();
  });

test("a range reaching past the last slide shows the slides it still covers", async ({
  page,
}) => {
  // As after deleting the last slides of a range set in Set Up Slide Show.
  await open(page, showSelectionDeck('<p:sldRg st="2" end="9"/>'));
  await expect(counter(page)).toHaveText("1 / 4");
  await expect(image(page)).toHaveAttribute("alt", /Selected show slide 2/);
  await page.keyboard.press("End");
  await expect(counter(page)).toHaveText("4 / 4");
  await expect(image(page)).toHaveAttribute("alt", /Selected show slide 5/);
});

test("invalid selected shows are reported without presenting a different sequence", async ({
  page,
}) => {
  const pres = showSelectionDeck('<p:custShow id="42"/>');
  await open(page, pres);
  await expect(
    page.getByRole("dialog", { name: "Presentation mode" }),
  ).toHaveCount(0);
  await expect(page.getByText(/custom slide show.*not found/i)).toBeVisible();
  await expect(page.locator(".slide-image")).toBeVisible();
});
