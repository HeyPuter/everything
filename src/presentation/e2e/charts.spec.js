// Charts: Insert Chart, the data sheet, Chart Design commands and the
// chart's Format pane, all saved as a native chart with its workbook.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
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
// A ribbon command, opening its group's drop-down where a narrow window has
// folded the group away.
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
  // An edit landing as the menu opens can redraw it away; open it again.
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
  const bytes = await readFile(await (await event).path());
  const pres = await parseDeck(bytes);
  const chart = P.getSlideShapes(P.getSlides(pres)[0]).find((s) =>
    P.isChartShape(s),
  );
  return { bytes, pres, chart, spec: chart && P.getShapeChartSpec(chart) };
}
async function insertChart(page, family, type) {
  await ribbonCommand(page, "Insert", "chart");
  const dialog = page.getByRole("dialog", { name: "Insert Chart" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: family }).click();
  await dialog.getByRole("radio", { name: type, exact: true }).click();
  await expect(dialog.locator(".chart-type-preview")).toHaveAttribute(
    "src",
    /^data:image\/svg/,
  );
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(page.locator(".chart-sheet")).toBeVisible();
}

test("a chart is inserted with its data sheet, and typed data reaches the file and its workbook", async ({
  page,
}) => {
  await start(page);
  await insertChart(page, "Column", "Stacked Column");
  const sheet = page.locator(".chart-sheet");
  const first = sheet.locator('input[data-row="1"][data-col="1"]');
  await first.fill("12");
  await first.press("Enter");
  // A new category typed past the end of the data grows the chart.
  const row = sheet.locator('input[data-row="5"][data-col="0"]');
  await row.fill("Category 5");
  await row.press("Tab");
  await sheet.locator('input[data-row="5"][data-col="1"]').fill("7");
  await sheet.locator('input[data-row="5"][data-col="1"]').press("Enter");
  await expect(page.locator("#status-save, .save-status").first()).toBeTruthy();
  await page.waitForTimeout(500);
  const { bytes, spec } = await download(page);
  expect(spec.kind).toBe("column");
  expect(spec.grouping).toBe("stacked");
  expect(spec.categories).toEqual([
    "Category 1",
    "Category 2",
    "Category 3",
    "Category 4",
    "Category 5",
  ]);
  expect(spec.series[0].values).toEqual([12, 2.6, 3.4, 4.6, 7]);
  // The embedded workbook carries the same numbers for other editors.
  const zip = unzipSync(bytes);
  const workbook = Object.keys(zip).find((n) =>
    /^ppt\/embeddings\/.*\.xlsx$/.test(n),
  );
  expect(workbook).toBeTruthy();
  const sheetXml = strFromU8(
    unzipSync(zip[workbook])["xl/worksheets/sheet1.xml"],
  );
  expect(sheetXml).toContain(">12<");
  expect(sheetXml).toContain(">7<");
});

test("rows pasted from a spreadsheet fill the data sheet", async ({ page }) => {
  await start(page);
  await insertChart(page, "Line", "Line with Markers");
  const cell = page.locator('.chart-sheet input[data-row="1"][data-col="0"]');
  await cell.focus();
  await cell.evaluate((input) => {
    const data = new DataTransfer();
    data.setData("text/plain", "Mon\t1\t2\nTue\t3\t4\nWed\t5\t6\n");
    input.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
    );
  });
  await expect(page.locator(".chart-sheet-status")).toContainText(
    "Pasted 3 rows",
  );
  await page.waitForTimeout(500);
  const { spec } = await download(page);
  expect(spec.kind).toBe("line");
  expect(spec.categories.slice(0, 3)).toEqual(["Mon", "Tue", "Wed"]);
  expect(spec.series[0].values.slice(0, 3)).toEqual([1, 3, 5]);
  expect(spec.series[1].values.slice(0, 3)).toEqual([2, 4, 6]);
});

test("Chart Design changes elements, type, layout and data orientation", async ({
  page,
}) => {
  await start(page);
  await insertChart(page, "Column", "Clustered Column");
  await page.getByRole("button", { name: "Close data sheet" }).click();
  await expect(
    page.getByRole("tab", { name: "Chart Design", exact: true }),
  ).toBeVisible();

  await ribbonCommand(page, "Chart Design", "chart-add-element");
  await page.getByRole("menuitem", { name: "Legend" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Top" }).click();
  await ribbonCommand(page, "Chart Design", "chart-add-element");
  await page.getByRole("menuitem", { name: "Data Labels" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Outside End" }).click();
  await ribbonCommand(page, "Chart Design", "chart-add-element");
  await page.getByRole("menuitem", { name: "Axis Titles" }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Primary Vertical" })
    .click();
  await ribbonCommand(page, "Chart Design", "chart-switch");
  await page.waitForTimeout(300);
  let { spec } = await download(page);
  expect(spec.legend.position).toBe("t");
  expect(spec.dataLabels.showValue).toBe(true);
  expect(spec.dataLabels.position).toBe("outEnd");
  expect(spec.valueAxisTitle).toBe("Axis Title");
  // Switching rows and columns: four series over three categories.
  expect(spec.series).toHaveLength(4);
  expect(spec.categories).toEqual(["Series 1", "Series 2", "Series 3"]);

  await ribbonCommand(page, "Chart Design", "chart-change-type");
  const dialog = page.getByRole("dialog", { name: "Change Chart Type" });
  await dialog.getByRole("tab", { name: "Bar" }).click();
  await dialog.getByRole("radio", { name: "100% Stacked Bar" }).click();
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await page.waitForTimeout(300);
  ({ spec } = await download(page));
  expect(spec.kind).toBe("bar");
  expect(spec.grouping).toBe("percentStacked");
  expect(spec.series[0].values).toEqual([4.1, 2.2, 1.8]);

  await ribbonCommand(page, "Chart Design", "chart-change-colors");
  await page.getByRole("menuitem", { name: "Shades of accent 2" }).click();
  await page.waitForTimeout(300);
  ({ spec } = await download(page));
  expect(spec.series.every((s) => /^#?[0-9A-F]{6}$/i.test(s.color))).toBe(true);
  expect(new Set(spec.series.map((s) => s.color)).size).toBe(4);
});

test("the Format pane formats the chart element chosen on the Format tab", async ({
  page,
}) => {
  await start(page);
  await insertChart(page, "Pie", "Doughnut");
  await page.getByRole("button", { name: "Close data sheet" }).click();
  await ribbonCommand(page, "Format", "chart-format-selection");
  const pane = page.locator("#inspector");
  await expect(
    pane.getByRole("heading", { name: "Format Chart Area" }),
  ).toBeVisible();
  const hole = pane.getByLabel("Hole size (%)");
  await hole.fill("70");
  await hole.press("Enter");
  await pane.getByLabel("Chart element").selectOption({ label: "Chart Title" });
  await expect(
    pane.getByRole("heading", { name: "Format Chart Title" }),
  ).toBeVisible();
  const title = pane.getByLabel("Title text", { exact: true });
  await title.fill("Market share");
  await title.press("Enter");
  await page.waitForTimeout(300);
  const { spec } = await download(page);
  expect(spec.kind).toBe("doughnut");
  expect(spec.holeSizePct).toBe(70);
  expect(spec.title).toBe("Market share");
});

test("Select Data renames a series by clicking its name and typing", async ({
  page,
}) => {
  await start(page);
  await insertChart(page, "Column", "Clustered Column");
  await page.getByRole("button", { name: "Close data sheet" }).click();
  await ribbonCommand(page, "Chart Design", "chart-select-data");
  const dialog = page.getByRole("dialog", { name: "Select Data" });
  const name = dialog.getByRole("textbox", { name: "Name of series 2" });
  await name.click();
  await expect(name).toBeFocused();
  await name.press("ControlOrMeta+a");
  await page.keyboard.type("Revenue");
  await expect(dialog.locator('li[aria-selected="true"] input')).toHaveValue(
    "Revenue",
  );
  await expect(dialog.getByRole("button", { name: "Move up" })).toBeEnabled();
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await page.waitForTimeout(300);
  const { spec } = await download(page);
  expect(spec.series.map((s) => s.name)).toEqual([
    "Series 1",
    "Revenue",
    "Series 3",
  ]);
});
