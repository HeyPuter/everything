// Custom error-bar amounts from the Format pane (numbers or a range of the
// data sheet), and data labels and a trendline on a bubble chart.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, parseDeck } from "../src/model.js";

test.setTimeout(90_000);

async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/");
}
async function ribbonCommand(page, tab, command) {
  await page.getByRole("tab", { name: tab, exact: true }).click();
  const panel = page.locator(".ribbon-panel:not([hidden])");
  const button = panel.locator(`[data-command="${command}"]`).first();
  if (!(await button.isVisible())) {
    await panel
      .locator(`.ribbon-group:has([data-command="${command}"]) .ribbon-fold`)
      .click();
    await page
      .locator(`.ribbon-fold-panel [data-command="${command}"]`)
      .first()
      .click();
    return;
  }
  await button.click();
}
async function download(page) {
  const item = page.getByRole("menuitem", {
    name: "Download PowerPoint (.pptx)",
    exact: true,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    await page
      .getByRole("menuitem", { name: "File", exact: true })
      .or(page.getByRole("button", { name: "File options" }))
      .filter({ visible: true })
      .click();
    try {
      await item.waitFor({ state: "visible", timeout: 5000 });
      break;
    } catch {}
  }
  const event = page.waitForEvent("download");
  await item.click();
  const pres = await parseDeck(await readFile(await (await event).path()));
  const chart = P.getSlideShapes(P.getSlides(pres)[0]).find((s) =>
    P.isChartShape(s),
  );
  return P.getShapeChartSpec(chart);
}
async function insertChart(page, family, type) {
  await ribbonCommand(page, "Insert", "chart");
  const dialog = page.getByRole("dialog", { name: "Insert Chart" });
  await dialog.getByRole("tab", { name: family }).click();
  await dialog.getByRole("radio", { name: type, exact: true }).click();
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(page.locator(".chart-sheet")).toBeVisible();
  await page.getByRole("button", { name: "Close data sheet" }).click();
}
async function element(page, menu, item) {
  await ribbonCommand(page, "Chart Design", "chart-add-element");
  await page.getByRole("menuitem", { name: menu }).click();
  await page
    .getByRole("menuitem", { name: item, exact: true })
    .or(page.getByRole("menuitemcheckbox", { name: item, exact: true }))
    .or(page.getByRole("menuitemradio", { name: item, exact: true }))
    .first()
    .click();
}

test("custom error amounts come from typed numbers or the data sheet", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "The Format pane's chart options are a desktop and tablet workflow",
  );
  await start(page);
  await insertChart(page, "Column", "Clustered Column");
  await element(page, "Error Bars", "Standard Error");
  await element(page, "Error Bars", "More Error Bars Options…");
  const pane = page.locator("#inspector");
  await pane.getByLabel("Error amount").selectOption("cust");
  const plus = pane.getByLabel("Positive error values");
  await plus.fill("0.5, 1, 1.5, 2");
  await plus.press("Enter");
  const minus = pane.getByLabel("Negative error values");
  await minus.fill("C2:C5");
  await minus.press("Enter");
  await page.waitForTimeout(300);
  const spec = await download(page);
  const bars = spec.series[0].errorBars;
  expect(bars.valueType).toBe("cust");
  expect(bars.plus).toEqual([0.5, 1, 1.5, 2]);
  expect(bars.minusRef).toBe("Sheet1!$C$2:$C$5");
  expect(bars.minus).toEqual(spec.series[1].values);
  await expect(
    page.locator("#slide-canvas .slide-image, #slide-canvas img").first(),
  ).toBeVisible();
});

test("a bubble chart takes data labels and a trendline", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "The Chart Design ribbon is a desktop and tablet workflow",
  );
  await start(page);
  await insertChart(page, "X Y (Scatter)", "Bubble");
  await element(page, "Data Labels", "Center");
  await element(page, "Trendline", "Linear");
  const all = page.getByRole("menuitem", { name: "All Series", exact: true });
  if (await all.isVisible().catch(() => false)) await all.click();
  await page.waitForTimeout(300);
  const spec = await download(page);
  expect(spec.kind).toBe("bubble");
  expect(spec.dataLabels?.showValue).toBe(true);
  expect(spec.series.every((s) => s.trendline?.type === "linear")).toBe(true);
});
