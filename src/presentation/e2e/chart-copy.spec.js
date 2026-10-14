import {
  chartRadarGridDeck,
  radarGridColors,
  radarGridLine,
} from "../tests/chart-radar-grid-fixture.js";
import { chartFixedNumberPair } from "../tests/chart-fixed-number-fixture.js";
import { chartOptionalNumberDeck } from "../tests/chart-optional-number-fixture.js";
import {
  chartPercentFormatPair,
  chartPercentFormatDeck,
  percentLabelColor,
  valueLabelColor,
} from "../tests/chart-percent-format-fixture.js";
import {
  chartRadarDataLabelPair,
  radarDataLabelColor,
  radarAlternateLabelColor,
} from "../tests/chart-radar-data-label-fixture.js";
import {
  chartSeriesFillDeck,
  withoutChartColorScheme,
} from "../tests/chart-series-fill-fixture.js";
import { chartZeroFillInversionDeck } from "../tests/chart-zero-fill-inversion-fixture.js";
import { chartPointInversionDefaultDeck } from "../tests/chart-point-inversion-default-fixture.js";
import { chartNoFillDeck } from "../tests/chart-no-fill-fixture.js";
import { chartSeriesOpacityDeck } from "../tests/chart-series-opacity-fixture.js";
import {
  chartRadarAxisDeck,
  radarAxisCases,
  radarAxisColor,
} from "../tests/chart-radar-axis-fixture.js";
import {
  chartRadarLabelDeck,
  radarCategories,
  radarLabelColor,
} from "../tests/chart-radar-label-fixture.js";
import {
  chartInversionDeck,
  nativeInvertedColor,
} from "../tests/chart-inversion-fixture.js";
import {
  chartSeriesClippingDeck,
  chartXYClippingDeck,
} from "../tests/chart-series-clipping-fixture.js";
import { chartPercentageStacksDeck } from "../tests/chart-percentage-stacks-fixture.js";
import {
  chartAreaPaintDeck,
  chartLineTheme,
  areaGradient,
  areaPattern,
  areaImage,
} from "../tests/chart-area-paint-fixture.js";
import {
  chartPlotGuidesDeck,
  chartPlotGuideState,
} from "../tests/chart-plot-guides-fixture.js";
import {
  chartCacheAvailabilityDeck,
  chartDoughnutExtentsDeck,
  setNativeChartCache,
} from "../tests/chart-cache-availability-fixture.js";
import { chartRenderingView } from "../lib/pptx/src/api/fn/charts.ts";
import {
  chartPlotContext,
  primaryChartAxis,
} from "../lib/pptx/src/internal/chartml/axis-context.ts";
import {
  resolveTarget,
  relsPartNameFor,
} from "../lib/pptx/src/internal/opc/index.ts";
import {
  parseXml,
  serializeXml,
  walkElements,
  firstChildElement,
  getAttrValue,
  qname,
  NS,
  textContent,
} from "../lib/pptx/src/internal/xml/index.ts";
import { NativeChartWorkbook } from "../lib/pptx/src/internal/chartml/native-workbook.ts";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { P, MIME } from "../src/model.js";
import { chartXmlWhitespaceDeck } from "../tests/xml-whitespace-fixture.js";
import {
  chartCopyDeck,
  chartColorDeck,
  chartFontDeck,
  chartDataDeck,
  chartCacheDeck,
  chartAxisPaintDeck,
  chartCategoryTickDeck,
  chartCategoryOrderDeck,
  chartCategorySpacingDeck,
  chartStrokeWidthDeck,
  chartSeriesOutlineDeck,
  chartLegendPaintDeck,
  chartNumberFormatDeck,
  chartWorkbookBindingDeck,
  chartStyleDeck,
  chartTextDeck,
  chartOpaquePaintDeck,
  chartExtensionDeck,
  chartMaximumLabelsDeck,
  chartNativeDataDeck,
  chartAxisReferenceDeck,
  chartValueOrderDeck,
  chartExplicitBooleanDeck,
  chartLegendOrderDeck,
  chartLegendLayoutDeck,
  chartLineMarkersDeck,
  chartStackedBlanksDeck,
  chartLineGapsDeck,
  chartMarkerPaintDeck,
  chartRoot,
  chartGraph,
  workbook,
} from "../tests/chart-copy-fixture.js";
const workbookAttribute = (e, n) => getAttrValue(e, qname("", n, ""));
function workbookStyles(zip) {
  const rels = parseXml(strFromU8(zip["_rels/.rels"])).root,
    office = rels.children.find(
      (n) =>
        n.kind === "element" &&
        workbookAttribute(n, "Type")?.endsWith("/officeDocument"),
    ),
    owner = resolveTarget("/", workbookAttribute(office, "Target")),
    bindings = parseXml(strFromU8(zip[relsPartNameFor(owner).slice(1)])).root,
    style = bindings.children.find(
      (n) =>
        n.kind === "element" &&
        workbookAttribute(n, "Type")?.endsWith("/styles"),
    );
  expect(style).toBeDefined();
  return parseXml(
    strFromU8(
      zip[resolveTarget(owner, workbookAttribute(style, "Target")).slice(1)],
    ),
  ).root;
}
function assertWorkbookCellFormat(zip, address, value, format) {
  const sheet = parseXml(strFromU8(zip["xl/worksheets/sheet1.xml"])).root,
    styles = workbookStyles(zip);
  let cell;
  walkElements(sheet, (e) => {
    if (e.name.localName === "c" && workbookAttribute(e, "r") === address)
      cell = e;
  });
  expect(cell).toBeDefined();
  expect(
    firstChildElement(cell, qname("", "v", sheet.name.namespaceURI)).children[0]
      .data,
  ).toBe(String(value));
  const xfs = firstChildElement(
      styles,
      qname("", "cellXfs", styles.name.namespaceURI),
    ).children.filter((n) => n.kind === "element" && n.name.localName === "xf"),
    xf = xfs[Number(workbookAttribute(cell, "s") ?? 0)],
    formats = firstChildElement(
      styles,
      qname("", "numFmts", styles.name.namespaceURI),
    ),
    record = formats.children.find(
      (n) =>
        n.kind === "element" &&
        workbookAttribute(n, "numFmtId") === workbookAttribute(xf, "numFmtId"),
    );
  expect(workbookAttribute(record, "formatCode")).toBe(format);
}
async function setup(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  const back = page.getByRole("button", { name: "Back to presentations" }),
    objects = page.locator(".object-hit");
  return {
    errors,
    objects,
    async load(buffer, count) {
      if (await back.isVisible()) await back.click();
      const event = page.waitForEvent("filechooser");
      await page
        .getByRole("button", { name: "Import PPTX", exact: true })
        .click();
      await (
        await event
      ).setFiles({
        name: "Native attached connectors.pptx",
        mimeType: MIME,
        buffer,
      });
      // The editor, not the library it was opened from, before counting.
      await expect(page.locator("#slide-position")).toBeVisible();
      await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
      await expect(objects).toHaveCount(count);
    },
    async blank() {
      await back.click();
      await page
        .getByRole("button", { name: "New presentation", exact: true })
        .click();
      await expect(back).toBeVisible();
      await expect(objects).toHaveCount(0);
    },
    async copyAll() {
      await objects.last().click();
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Control+c");
    },
    async download() {
      await page
        .getByRole("menuitem", { name: "File", exact: true })
        .or(page.getByRole("button", { name: "File options" }))
        .filter({ visible: true })
        .click();
      const event = page.waitForEvent("download");
      await page
        .getByRole("menuitem", {
          name: "Download PowerPoint (.pptx)",
          exact: true,
        })
        .click();
      const bytes = await readFile(await (await event).path());
      await page.keyboard.press("Escape");
      return bytes;
    },
  };
}

async function inspect(bytes, { sets = 1, grouped = false } = {}) {
  const p = await P.loadPresentation(bytes),
    slide = P.getSlides(p)[0],
    charts = P.getSlideCharts(slide);
  expect(charts).toHaveLength(sets * 2);
  expect(P.getSlideShapes(slide)).toHaveLength(sets * (grouped ? 3 : 2));
  expect(new Set(charts.map((c) => chartRoot(c.shape))).size).toBe(
    charts.length,
  );
  expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
    charts.length,
  );
  for (let i = 0; i < charts.length; i++) {
    expect(charts[i].spec.kind).toBe(i % 2 ? "line" : "bar");
    expect(charts[i].spec.categories).toEqual(["North", "South", "West"]);
    expect(charts[i].spec.series[0].values).toEqual([4 + (i % 2), 9, -2]);
    const style = chartGraph(p, chartRoot(charts[i].shape)).find(
      (x) => x.contentType === "application/vnd.ms-office.chartstyle+xml",
    );
    expect(new TextDecoder().decode(style.data)).toContain(`opaque-${i % 2}`);
  }
  expect(P.validatePresentation(p)).toEqual([]);
  return p;
}

test("physical chart XML line endings retain logical labels through clipboard both ways and copied data edits", async ({
  page,
}) => {
  const f = await chartXmlWhitespaceDeck(),
    source = Buffer.from(f.bytes),
    ui = await setup(page);
  const check = async (count, values = [2, 4]) => {
    const bytes = await ui.download(),
      p = await P.loadPresentation(bytes),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts).toHaveLength(count);
    for (const c of charts) {
      expect(c.spec.series.map((s) => s.name)).toEqual(f.names);
      expect(c.spec.categories).toEqual(f.categories);
    }
    expect(charts.at(-1).spec.series[0].values).toEqual(values);
    expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
      count,
    );
    // Exercise the actual browser parser too, independently of Node import.
    expect(
      await page.evaluate(
        async (data) => {
          const { P } = await import("/src/model.js");
          const p = await P.loadPresentation(new Uint8Array(data));
          return P.getSlideCharts(P.getSlides(p)[0]).map((c) =>
            c.spec.series.map((s) => s.name),
          );
        },
        [...bytes],
      ),
    ).toEqual(Array.from({ length: count }, () => f.names));
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 1);
  await check(1);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check(1);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const p = await check(2),
    charts = P.getSlideCharts(P.getSlides(p)[0]),
    originalBook = workbook(p, charts[0].shape).data.slice();
  P.setChartSpec(charts[1], {
    ...charts[1].spec,
    series: charts[1].spec.series.map((s, i) =>
      i ? s : { ...s, values: [6, 1] },
    ),
  });
  await ui.load(Buffer.from(await P.savePresentation(p)), 2);
  const returned = await check(2, [6, 1]),
    result = P.getSlideCharts(P.getSlides(returned)[0]);
  expect(result[0].spec.series[0].values).toEqual([2, 4]);
  expect(workbook(returned, result[0].shape).data).toEqual(originalBook);
  expect(workbook(returned, result[1].shape).data).not.toEqual(originalBook);
  expect(ui.errors).toEqual([]);
});

test("explicit false chart options survive clipboard both ways and independent copied edits", async ({
  page,
}) => {
  const f = chartExplicitBooleanDeck(),
    source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const check = async (count) => {
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts).toHaveLength(count);
    for (const chart of charts) {
      expect(chart.spec.roundedCorners).toBe(false);
      expect(chart.spec.categoryAxisNoMultiLevelLabel).toBe(false);
      expect(chart.spec.series[0].invertIfNegative).toBe(false);
      expect(chart.spec.series[0].values).toEqual([-3, 7]);
    }
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 1);
  await check(1);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check(1);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const returned = await check(2),
    charts = P.getSlideCharts(P.getSlides(returned)[0]),
    original = charts[0].spec,
    book = workbook(returned, charts[0].shape).data.slice();
  P.setChartSpec(charts[1], {
    ...charts[1].spec,
    roundedCorners: true,
    categoryAxisNoMultiLevelLabel: true,
    series: [
      { ...charts[1].spec.series[0], invertIfNegative: true, values: [-9, 15] },
    ],
  });
  expect(P.getShapeChartSpec(charts[0].shape)).toEqual(original);
  expect(workbook(returned, charts[0].shape).data).toEqual(book);
  await ui.load(Buffer.from(await P.savePresentation(returned)), 2);
  const final = await P.loadPresentation(await ui.download()),
    edited = P.getSlideCharts(P.getSlides(final)[0]);
  expect(
    edited.map((c) => [
      c.spec.roundedCorners,
      c.spec.categoryAxisNoMultiLevelLabel,
      c.spec.series[0].invertIfNegative,
    ]),
  ).toEqual([
    [false, false, false],
    [true, true, true],
  ]);
  expect(edited.map((c) => c.spec.series[0].values)).toEqual([
    [-3, 7],
    [-9, 15],
  ]);
  expect(P.validatePresentation(final)).toEqual([]);
  expect(ui.errors).toEqual([]);
});
for (const kind of ["bar", "line"])
  test(`${kind} native legend ordering and entry visibility survive clipboard both ways and returned-copy edits`, async ({
    page,
  }) => {
    const f = chartLegendOrderDeck({
        kind,
        ...(kind === "line" ? { grouping: "stacked", lineMarkers: true } : {}),
        legend: { position: kind === "line" ? "r" : "b", hiddenIndices: [0] },
      }),
      source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page);
    const renderedNames = async () => {
      const image = page.locator("#slide-canvas .slide-image");
      await image.evaluate((img) => img.decode());
      const names = [];
      walkElements(
        parseXml(
          decodeURIComponent(
            (await image.getAttribute("src")).split(",").slice(1).join(","),
          ),
        ).root,
        (e) => {
          if (e.name.localName !== "text") return;
          const text = e.children
            .filter((n) => n.kind === "text")
            .map((n) => n.data)
            .join("");
          if (["Alpha", "Beta", "Gamma"].includes(text)) names.push(text);
        },
      );
      return names;
    };
    const check = async (count) => {
      expect(await renderedNames()).toEqual(
        Array.from({ length: count }, () => ["Beta", "Alpha"]).flat(),
      );
      const p = await P.loadPresentation(await ui.download()),
        charts = P.getSlideCharts(P.getSlides(p)[0]);
      expect(charts).toHaveLength(count);
      for (const c of charts) {
        expect(c.spec.legend.hiddenIndices).toEqual([0]);
        expect(c.spec.series.map((s) => s.name)).toEqual([
          "Alpha",
          "Beta",
          "Gamma",
        ]);
      }
      expect(P.validatePresentation(p)).toEqual([]);
      return p;
    };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const returned = await check(2),
      charts = P.getSlideCharts(P.getSlides(returned)[0]),
      original = charts[0].spec,
      book = workbook(returned, charts[0].shape).data.slice();
    P.setChartSpec(charts[1], {
      ...charts[1].spec,
      categoryAxisOrientation: "maxMin",
      legend: { ...charts[1].spec.legend, position: "b" },
      series: charts[1].spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 2),
      })),
    });
    expect(P.getShapeChartSpec(charts[0].shape)).toEqual(original);
    expect(workbook(returned, charts[0].shape).data).toEqual(book);
    await ui.load(Buffer.from(await P.savePresentation(returned)), 2);
    expect(await renderedNames()).toEqual(["Beta", "Alpha", "Beta", "Gamma"]);
    const final = await P.loadPresentation(await ui.download());
    expect(P.validatePresentation(final)).toEqual([]);
    expect(ui.errors).toEqual([]);
  });
for (const kind of ["line", "scatter", "radar"])
  test(`${kind} independent marker paint survives actual clipboard both ways and native download`, async ({
    page,
  }) => {
    const f = chartMarkerPaintDeck(kind),
      source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page),
      original = P.getShapeChartSpec(f.shape);
    const check = async (count) => {
      const image = page.locator("#slide-canvas .slide-image");
      await image.evaluate((img) => img.decode());
      const svg = decodeURIComponent(
        (await image.getAttribute("src")).split(",").slice(1).join(","),
      );
      let painted = 0,
        hollow = 0;
      const keyLines = [],
        circleMarkers = [];
      walkElements(parseXml(svg).root, (e) => {
        const a = workbookAttribute;
        if (
          e.name.localName === "line" &&
          ["#E85239", "#2F8541", "#376CA8"].includes(a(e, "stroke")) &&
          a(e, "y1") === a(e, "y2")
        )
          keyLines.push(e);
        if (e.name.localName === "circle" && a(e, "stroke") === "#EA7423")
          circleMarkers.push(e);
        if (
          ["circle", "rect", "polygon"].includes(e.name.localName) &&
          ["#EA7423", "#349185", "#CC3344"].includes(
            workbookAttribute(e, "stroke"),
          )
        ) {
          painted++;
          if (workbookAttribute(e, "fill") === "none") hollow++;
        }
      });
      expect(painted).toBe(12 * count);
      expect(hollow).toBe(4 * count);
      expect(keyLines).toHaveLength(3 * count);
      for (const line of keyLines) {
        const a = workbookAttribute;
        expect(+a(line, "x2") - +a(line, "x1")).toBeCloseTo(25.6, 2);
        if (a(line, "stroke") === "#E85239")
          expect(
            circleMarkers.some(
              (circle) =>
                Math.abs(+a(circle, "cy") - +a(line, "y1")) < 0.02 &&
                Math.abs(
                  +a(circle, "cx") - (+a(line, "x1") + +a(line, "x2")) / 2,
                ) < 0.02,
            ),
          ).toBe(true);
      }
      const p = await P.loadPresentation(await ui.download()),
        charts = P.getSlideCharts(P.getSlides(p)[0]);
      expect(charts).toHaveLength(count);
      for (const c of charts) expect(c.spec).toEqual(original);
      expect(P.validatePresentation(p)).toEqual([]);
      return p;
    };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const returned = await check(2);
    if (kind === "line") {
      const charts = P.getSlideCharts(P.getSlides(returned)[0]),
        book = workbook(returned, charts[0].shape).data.slice();
      P.setChartSpec(charts[1], {
        ...charts[1].spec,
        series: charts[1].spec.series.map((s) => ({
          ...s,
          markerFill: null,
          markerStrokeColor: "#238A6D",
          markerStrokeWidthEmu: 50800,
          markerSizePt: 18,
          values: s.values.map((v) => v + 2),
        })),
      });
      expect(P.getShapeChartSpec(charts[0].shape)).toEqual(original);
      expect(workbook(returned, charts[0].shape).data).toEqual(book);
      await ui.load(Buffer.from(await P.savePresentation(returned)), 2);
      const final = await P.loadPresentation(await ui.download()),
        edited = P.getSlideCharts(P.getSlides(final)[0]);
      expect(edited[0].spec).toEqual(original);
      for (const series of edited[1].spec.series)
        expect(series).toMatchObject({
          markerFill: null,
          markerStrokeColor: "#238A6D",
          markerStrokeWidthEmu: 50800,
          markerSizePt: 18,
        });
      expect(P.validatePresentation(final)).toEqual([]);
    }
    expect(ui.errors).toEqual([]);
  });

test("smooth line gaps and native error-display settings survive clipboard both ways and independent copied edits", async ({
  page,
}) => {
  const f = chartLineGapsDeck({ naIndices: [3], dispNaAsBlank: false }),
    source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const check = async (expectedRuns) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const paths = [];
    walkElements(
      parseXml(
        decodeURIComponent(
          (await image.getAttribute("src")).split(",").slice(1).join(","),
        ),
      ).root,
      (e) => {
        if (
          e.name.localName === "path" &&
          workbookAttribute(e, "stroke") === "#376CA8" &&
          workbookAttribute(e, "fill") === "none"
        )
          paths.push(workbookAttribute(e, "d"));
      },
    );
    expect(paths.map((d) => (d.match(/M/g) ?? []).length)).toEqual(
      expectedRuns,
    );
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts).toHaveLength(expectedRuns.length);
    for (const [i, chart] of charts.entries()) {
      expect(chart.spec.dispBlanksAs).toBe("gap");
      expect(chart.spec.series[0].values[3]).toBeNull();
      const root = parseXml(
          new TextDecoder().decode(
            P._internalPackageOf(p).getPart(chartRoot(chart.shape)).data,
          ),
        ).root,
        flags = [],
        errors = [];
      walkElements(root, (e) => {
        if (
          e.name.namespaceURI ===
            "http://schemas.microsoft.com/office/drawing/2017/03/chart" &&
          e.name.localName === "dispNaAsBlank"
        )
          flags.push(workbookAttribute(e, "val"));
        if (
          e.name.namespaceURI === NS.chart &&
          e.name.localName === "v" &&
          e.children.some((n) => n.kind === "text" && n.data === "#N/A")
        )
          errors.push(e);
      });
      expect(flags).toEqual([expectedRuns[i] === 2 ? "1" : "0"]);
      expect(errors).toHaveLength(1);
      expect(
        strFromU8(
          unzipSync(workbook(p, chart.shape).data)["xl/worksheets/sheet1.xml"],
        ),
      ).toContain("<v>#N/A</v>");
    }
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 1);
  await check([1]);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check([1]);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const returned = await check([1, 1]),
    charts = P.getSlideCharts(P.getSlides(returned)[0]),
    before = charts[0].spec,
    book = workbook(returned, charts[0].shape).data.slice();
  P.setChartSpec(charts[1], {
    ...charts[1].spec,
    series: charts[1].spec.series.map((s) => ({
      ...s,
      values: s.values.map((v) => (v === null ? null : v + 1)),
    })),
  });
  const part = P._internalPackageOf(returned).getPart(
      chartRoot(charts[1].shape),
    ),
    doc = parseXml(new TextDecoder().decode(part.data));
  walkElements(doc.root, (e) => {
    if (
      e.name.namespaceURI ===
        "http://schemas.microsoft.com/office/drawing/2017/03/chart" &&
      e.name.localName === "dispNaAsBlank"
    )
      e.attrs[0].value = "1";
  });
  part.data = new TextEncoder().encode(serializeXml(doc));
  expect(P.getShapeChartSpec(charts[0].shape)).toEqual(before);
  expect(workbook(returned, charts[0].shape).data).toEqual(book);
  await ui.load(Buffer.from(await P.savePresentation(returned)), 2);
  const final = await check([1, 2]),
    edited = P.getSlideCharts(P.getSlides(final)[0]);
  expect(edited[1].spec.series[0].values).toEqual([3, 5, 4, null, 4, 2, 6]);
  expect(new Set(edited.map((c) => workbook(final, c.shape).name)).size).toBe(
    2,
  );
  expect(ui.errors).toEqual([]);
});

test("balanced horizontal legends survive clipboard both ways and independent font, width and data edits", async ({
  page,
}) => {
  const names = Array.from(
      { length: 7 },
      (_, i) => `Entry ${String(i + 1).padStart(2, "0")}`,
    ),
    f = chartLegendLayoutDeck({
      kind: "column",
      position: "b",
      sizePt: 18,
      series: names.map((name, i) => ({
        name,
        values: [2, 4, 3, 5],
        color: "#E85239",
        ...(i === 0 ? { lineColor: "#B63874", lineWidthEmu: 914400 } : {}),
      })),
    }),
    source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const rows = async () =>
    page.locator("#slide-canvas .slide-image").evaluate(async (img, names) => {
      await img.decode();
      const svg = new DOMParser().parseFromString(
          decodeURIComponent(img.src.split(",").slice(1).join(",")),
          "image/svg+xml",
        ),
        labels = [...svg.querySelectorAll("text")].filter((e) =>
          names.includes(e.textContent),
        ),
        groups = new Map();
      for (const label of labels) {
        const y = label.getAttribute("y");
        groups.set(y, (groups.get(y) ?? 0) + 1);
      }
      return {
        counts: [...groups.values()],
        keys: [...svg.querySelectorAll('rect[stroke="#B63874"]')]
          .filter((e) => e.getAttribute("width") === e.getAttribute("height"))
          .map((e) => +e.getAttribute("stroke-width")),
        plots: [...svg.querySelectorAll('rect[stroke="#B63874"]')]
          .filter((e) => e.getAttribute("width") !== e.getAttribute("height"))
          .map((e) => +e.getAttribute("stroke-width")),
      };
    }, names);
  const check = async (counts, keyWidths = [32 / 3]) => {
    const paint = await rows();
    expect(paint.counts).toEqual(counts);
    expect(paint.keys).toHaveLength(keyWidths.length);
    for (const [i, width] of keyWidths.entries())
      expect(paint.keys[i]).toBeCloseTo(width, 10);
    expect(paint.plots).toHaveLength(keyWidths.length * 4);
    for (const width of paint.plots) expect(width).toBe(96);
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    for (const chart of charts) {
      expect(chart.spec.series.map((s) => s.name)).toEqual(names);
      expect(chart.spec.series[0].lineWidthEmu).toBe(914400);
    }
    expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
      charts.length,
    );
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 1);
  await check([4, 3]);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check([4, 3]);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const p = await check([8, 6], [32 / 3, 32 / 3]),
    charts = P.getSlideCharts(P.getSlides(p)[0]),
    originalBook = workbook(p, charts[0].shape).data.slice(),
    copy = charts[1];
  P.setShapeSize(copy.shape, P.inches(9), P.inches(4));
  P.setChartSpec(copy, {
    ...copy.spec,
    legend: {
      ...copy.spec.legend,
      position: "t",
      textStyle: { font: "Arial", sizePt: 32 },
    },
    series: copy.spec.series.map((s) => ({
      ...s,
      values: s.values.map((v) => v + 1),
    })),
  });
  await ui.load(Buffer.from(await P.savePresentation(p)), 2);
  const q = await check([4, 3, 3, 3, 1], [32 / 3, 20]),
    result = P.getSlideCharts(P.getSlides(q)[0]);
  expect(result.map((c) => c.spec.legend.position)).toEqual(["b", "t"]);
  expect(result.map((c) => c.spec.series[0].values)).toEqual([
    [2, 4, 3, 5],
    [3, 5, 4, 6],
  ]);
  expect(workbook(q, result[0].shape).data).toEqual(originalBook);
  expect(ui.errors).toEqual([]);
});

test("large side legends reserve their painted bounds through clipboard both ways and independent edits", async ({
  page,
}) => {
  const f = chartLegendLayoutDeck(),
    source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const check = async (positions) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const nodes = [];
    walkElements(
      parseXml(
        decodeURIComponent(
          (await image.getAttribute("src")).split(",").slice(1).join(","),
        ),
      ).root,
      (e) => nodes.push(e),
    );
    const a = workbookAttribute,
      boxes = (color) =>
        nodes
          .filter((e) => e.name.localName === "rect" && a(e, "fill") === color)
          .map((e) => ({
            x: +a(e, "x"),
            y: +a(e, "y"),
            w: +a(e, "width"),
            h: +a(e, "height"),
          })),
      plots = boxes("#ECF5E9"),
      legends = boxes("#FFF0D1"),
      labels = nodes.filter(
        (e) =>
          e.name.localName === "text" &&
          e.children.some(
            (c) =>
              c.kind === "text" && ["Alpha", "Beta", "Gamma"].includes(c.data),
          ),
      );
    expect(plots).toHaveLength(positions.length);
    expect(legends).toHaveLength(positions.length);
    const keys = ["#E85239", "#2F8541", "#376CA8"]
      .flatMap(boxes)
      .filter((b) => b.w === b.h);
    expect(keys).toHaveLength(positions.length * 3);
    for (const [i, position] of positions.entries()) {
      const expected = position === "l" ? 12.07 : 21.45;
      for (let color = 0; color < 3; color++)
        expect(
          Math.abs(keys[color * positions.length + i].w - expected),
        ).toBeLessThan(0.1);
    }
    for (const [i, position] of positions.entries()) {
      if (position === "r")
        expect(plots[i].x + plots[i].w).toBeLessThan(legends[i].x);
      else expect(legends[i].x + legends[i].w).toBeLessThan(plots[i].x);
      const ys = labels
        .slice(i * 3, i * 3 + 3)
        .map((e) => +a(e, "y"))
        .sort((x, y) => x - y);
      const sizes = labels
        .slice(i * 3, i * 3 + 3)
        .map((e) => +a(e, "font-size"));
      for (let k = 1; k < ys.length; k++)
        expect(ys[k] - ys[k - 1]).toBeGreaterThan(Math.max(...sizes));
    }
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts.map((c) => c.spec.legend.position)).toEqual(positions);
    expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
      charts.length,
    );
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 1);
  await check(["r"]);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check(["r"]);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const returned = await check(["r", "r"]),
    charts = P.getSlideCharts(P.getSlides(returned)[0]),
    before = charts[0].spec,
    book = workbook(returned, charts[0].shape).data.slice();
  P.setChartSpec(charts[1], {
    ...charts[1].spec,
    legend: {
      ...charts[1].spec.legend,
      position: "l",
      textStyle: { font: "Arial", sizePt: 18 },
    },
    series: charts[1].spec.series.map((s) => ({
      ...s,
      values: s.values.map((v) => v + 1),
    })),
  });
  expect(P.getShapeChartSpec(charts[0].shape)).toEqual(before);
  expect(workbook(returned, charts[0].shape).data).toEqual(book);
  await ui.load(Buffer.from(await P.savePresentation(returned)), 2);
  const final = await check(["r", "l"]),
    edited = P.getSlideCharts(P.getSlides(final)[0]);
  expect(edited[1].spec.legend.textStyle.sizePt).toBe(18);
  expect(edited[1].spec.series[0].values).toEqual([3, 5, 4, 6]);
  expect(ui.errors).toEqual([]);
});

test("oversized legends retain complete text and keys inside their painted bounds", async ({
  page,
}) => {
  const ui = await setup(page);
  const cases = [
    {
      position: "r",
      names: [
        "Revenue from established business customers",
        "Annual 👩‍👩‍👧‍👦 and café totals ".repeat(4),
        "地域別の年間売上と詳細な内訳".repeat(3),
      ],
    },
    {
      position: "b",
      names: Array.from({ length: 20 }, (_, i) => `Series ${i + 1}`),
    },
    {
      position: "l",
      names: Array.from({ length: 40 }, (_, i) => `Series ${i + 1}`),
      small: true,
    },
    {
      position: "b",
      names: Array.from({ length: 40 }, (_, i) => `Series ${i + 1}`),
      small: true,
    },
  ];
  for (const c of cases) {
    const f = chartLegendLayoutDeck({
      legend: {
        position: c.position,
        fill: "#FFF0D1",
        textStyle: { font: "Arial", sizePt: 18, color: "#A37511" },
      },
      series: c.names.map((name, i) => ({
        name,
        values: [2, 4, 3, 5],
        color: ["#E85239", "#2F8541", "#376CA8"][i % 3],
      })),
    });
    if (c.small) P.setShapeSize(f.shape, P.inches(4), P.inches(2.5));
    await ui.load(Buffer.from(await P.savePresentation(f.p)), 1);
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const geometry = await image.evaluate((img) => {
      const svg = new DOMParser().parseFromString(
        decodeURIComponent(img.src.split(",").slice(1).join(",")),
        "image/svg+xml",
      ).documentElement;
      const host = document.createElement("div");
      host.style.cssText =
        "position:fixed;left:0;top:0;width:1280px;height:720px;visibility:hidden";
      host.append(svg);
      document.body.append(host);
      const box = (e) => {
        const r = e.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          right: r.right,
          bottom: r.bottom,
          w: r.width,
          h: r.height,
        };
      };
      try {
        return {
          legend: box(svg.querySelector('rect[fill="#FFF0D1"]')),
          plot: box(svg.querySelector('rect[fill="#ECF5E9"]')),
          keys: [...svg.querySelectorAll("rect")].filter(
            (e) =>
              ["#E85239", "#2F8541", "#376CA8"].includes(
                e.getAttribute("fill"),
              ) && e.getAttribute("width") === e.getAttribute("height"),
          ).length,
          labels: [...svg.querySelectorAll('text[fill="#A37511"]')].map(
            (e) => ({ text: e.textContent, ...box(e) }),
          ),
        };
      } finally {
        host.remove();
      }
    });
    if (c.position === "b" && !c.small)
      expect(
        new Set(geometry.labels.map((l) => Math.round(l.y))).size,
      ).toBeGreaterThan(1);
    expect(geometry.keys).toBe(c.names.length);
    expect(geometry.plot.w).toBeGreaterThan(0);
    expect(geometry.plot.h).toBeGreaterThan(0);
    const full = geometry.labels
      .map((l) => l.text)
      .join("")
      .replace(/\s/g, "");
    for (const name of c.names) expect(full).toContain(name.replace(/\s/g, ""));
    for (const label of geometry.labels) {
      expect(label.x).toBeGreaterThanOrEqual(geometry.legend.x - 3);
      expect(
        label.right,
        JSON.stringify({
          position: c.position,
          small: c.small,
          label,
          legend: geometry.legend,
        }),
      ).toBeLessThanOrEqual(geometry.legend.right + 3);
      expect(label.y).toBeGreaterThanOrEqual(geometry.legend.y - 3);
      expect(label.bottom).toBeLessThanOrEqual(geometry.legend.bottom + 3);
    }
    const p = await P.loadPresentation(await ui.download()),
      chart = P.getSlideCharts(P.getSlides(p)[0])[0];
    expect(chart.spec.series.map((s) => s.name)).toEqual(c.names);
    expect(P.validatePresentation(p)).toEqual([]);
  }
  expect(ui.errors).toEqual([]);
});

test("area gaps close independent polygons through clipboard both ways, copied edits and reimport", async ({
  page,
}) => {
  const f = chartLineGapsDeck({ kind: "area", smooth: false, naIndices: [3] }),
    source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const check = async (modes) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const paths = [];
    walkElements(
      parseXml(
        decodeURIComponent(
          (await image.getAttribute("src")).split(",").slice(1).join(","),
        ),
      ).root,
      (e) => {
        if (
          e.name.localName === "path" &&
          workbookAttribute(e, "fill") === "#376CA8"
        )
          paths.push(workbookAttribute(e, "d"));
      },
    );
    expect(paths).toHaveLength(modes.length);
    for (const [i, path] of paths.entries()) {
      expect((path.match(/M/g) ?? []).length).toBe(modes[i] === "gap" ? 2 : 1);
      expect((path.match(/Z/g) ?? []).length).toBe(modes[i] === "gap" ? 2 : 1);
      const polygons = path.match(/M[^M]*Z/g);
      for (const polygon of polygons) {
        const points = [...polygon.matchAll(/[ML]([-\d.]+),([-\d.]+)/g)].map(
          (m) => [Number(m[1]), Number(m[2])],
        );
        expect(points.at(-1)[0]).toBe(points[0][0]);
        expect(points[points.length / 2][0]).toBe(
          points[points.length / 2 - 1][0],
        );
      }
    }
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts.map((c) => c.spec.dispBlanksAs)).toEqual(modes);
    expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
      charts.length,
    );
    for (const chart of charts) {
      expect(chart.spec.kind).toBe("area");
      expect(chart.spec.series[0].values[3]).toBeNull();
      expect(
        strFromU8(P._internalPackageOf(p).getPart(chartRoot(chart.shape)).data),
      ).toContain("#N/A");
      expect(
        strFromU8(
          unzipSync(workbook(p, chart.shape).data)["xl/worksheets/sheet1.xml"],
        ),
      ).toContain("#N/A");
    }
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 1);
  await check(["gap"]);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check(["gap"]);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const returned = await check(["gap", "gap"]),
    charts = P.getSlideCharts(P.getSlides(returned)[0]),
    original = charts[0].spec,
    book = workbook(returned, charts[0].shape).data.slice();
  P.setChartSpec(charts[1], {
    ...charts[1].spec,
    dispBlanksAs: "span",
    series: charts[1].spec.series.map((s) => ({
      ...s,
      values: s.values.map((v) => (v === null ? null : v + 1)),
    })),
  });
  expect(P.getShapeChartSpec(charts[0].shape)).toEqual(original);
  expect(workbook(returned, charts[0].shape).data).toEqual(book);
  await ui.load(Buffer.from(await P.savePresentation(returned)), 2);
  const final = await check(["gap", "span"]),
    edited = P.getSlideCharts(P.getSlides(final)[0]);
  expect(edited[1].spec.series[0].values).toEqual([3, 5, 4, null, 4, 2, 6]);
  expect(ui.errors).toEqual([]);
});

test("stacked blank points retain raw modes and empty cells through clipboard both ways and copied edits", async ({
  page,
}) => {
  const f = chartStackedBlanksDeck(),
    source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const check = async (count, modes = Array(count).fill("gap")) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    let marks = 0;
    walkElements(
      parseXml(
        decodeURIComponent(
          (await image.getAttribute("src")).split(",").slice(1).join(","),
        ),
      ).root,
      (e) => {
        if (
          e.name.localName === "circle" &&
          ["#E85239", "#2F8541", "#376CA8"].includes(
            workbookAttribute(e, "fill"),
          )
        )
          marks++;
      },
    );
    expect(marks).toBe(count * 9);
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts.map((c) => c.spec.dispBlanksAs)).toEqual(modes);
    for (const c of charts) {
      expect(c.spec.series.every((s) => s.values[1] === null)).toBe(true);
      const sheet = strFromU8(
        unzipSync(workbook(p, c.shape).data)["xl/worksheets/sheet1.xml"],
      );
      for (const address of ["B3", "C3", "D3"])
        expect(sheet).not.toMatch(
          new RegExp(`<c[^>]*r="${address}"[^>]*>\\s*<v>`),
        );
    }
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 1);
  await check(1);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check(1);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const returned = await check(2),
    charts = P.getSlideCharts(P.getSlides(returned)[0]),
    original = charts[0].spec,
    book = workbook(returned, charts[0].shape).data.slice();
  P.setChartSpec(charts[1], {
    ...charts[1].spec,
    dispBlanksAs: "span",
    grouping: "percentStacked",
    valueAxis: { min: 0, max: 1 },
    series: charts[1].spec.series.map((s) => ({
      ...s,
      values: s.values.map((v) => (v === null ? null : v + 1)),
    })),
  });
  expect(P.getShapeChartSpec(charts[0].shape)).toEqual(original);
  expect(workbook(returned, charts[0].shape).data).toEqual(book);
  await ui.load(Buffer.from(await P.savePresentation(returned)), 2);
  const final = await check(2, ["gap", "span"]),
    edited = P.getSlideCharts(P.getSlides(final)[0]);
  expect(edited.map((c) => c.spec.grouping)).toEqual([
    "stacked",
    "percentStacked",
  ]);
  expect(new Set(edited.map((c) => workbook(final, c.shape).name)).size).toBe(
    2,
  );
  expect(ui.errors).toEqual([]);
});

test("stacked line point markers survive clipboard both ways, native download and independent copied edits", async ({
  page,
}) => {
  const f = chartLineMarkersDeck(),
    source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const countMarkers = async () => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const svg = decodeURIComponent(
      (await image.getAttribute("src")).split(",").slice(1).join(","),
    );
    let count = 0;
    walkElements(parseXml(svg).root, (e) => {
      if (
        ["circle", "rect", "polygon"].includes(e.name.localName) &&
        ["#E85239", "#2F8541", "#376CA8"].includes(workbookAttribute(e, "fill"))
      )
        count++;
    });
    return count;
  };
  const check = async (count) => {
    expect(await countMarkers()).toBe(count * 9);
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts).toHaveLength(count);
    for (const c of charts) {
      expect(c.spec.grouping).toBe("stacked");
      expect(c.spec.lineMarkers).toBe(true);
      expect(c.spec.series.map((s) => s.markerSymbol)).toEqual([
        "circle",
        "circle",
        "circle",
      ]);
    }
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 1);
  await check(1);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check(1);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const returned = await check(2),
    charts = P.getSlideCharts(P.getSlides(returned)[0]),
    original = charts[0].spec,
    book = workbook(returned, charts[0].shape).data.slice();
  P.setChartSpec(charts[1], {
    ...charts[1].spec,
    grouping: "percentStacked",
    lineMarkers: false,
    categoryAxisOrientation: "maxMin",
    valueAxis: { min: 0, max: 1 },
    series: charts[1].spec.series.map((s, i) => ({
      ...s,
      markerSymbol: i === 1 ? "none" : i === 2 ? undefined : "circle",
      values: s.values.map((v) => v + 2),
    })),
  });
  expect(P.getShapeChartSpec(charts[0].shape)).toEqual(original);
  expect(workbook(returned, charts[0].shape).data).toEqual(book);
  await ui.load(Buffer.from(await P.savePresentation(returned)), 2);
  expect(await countMarkers()).toBe(15);
  const final = await P.loadPresentation(await ui.download()),
    edited = P.getSlideCharts(P.getSlides(final)[0]);
  expect(edited.map((c) => c.spec.grouping)).toEqual([
    "stacked",
    "percentStacked",
  ]);
  expect(edited[1].spec.series[1].markerSymbol).toBe("none");
  expect(edited[1].spec.series[2].markerSymbol).toBeUndefined();
  expect(edited[1].spec.lineMarkers).toBe(false);
  expect(P.validatePresentation(final)).toEqual([]);
  expect(ui.errors).toEqual([]);
});
for (const grouped of [false, true])
  test(`native chart ${grouped ? "groups" : "selections"} keep workbook and styles through clipboard both ways`, async ({
    page,
  }) => {
    const { p } = chartCopyDeck({ grouped }),
      source = Buffer.from(await P.savePresentation(p)),
      n = grouped ? 3 : 2,
      ui = await setup(page);
    await ui.load(source, n);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(n);
    const forward = await ui.download();
    await inspect(forward, { grouped });
    await ui.copyAll();
    await ui.load(source, n);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(n * 2);
    await page.keyboard.press("Control+z");
    await expect(ui.objects).toHaveCount(n);
    await page.keyboard.press("Control+Shift+z");
    await expect(ui.objects).toHaveCount(n * 2);
    const returned = await ui.download();
    await inspect(returned, { grouped, sets: 2 });
    await ui.load(returned, n * 2);
    await inspect(await ui.download(), { grouped, sets: 2 });
    expect(ui.errors).toEqual([]);
  });
test("native chart cut and duplicate preserve independent editable data", async ({
  page,
}) => {
  const { p } = chartCopyDeck(),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  await ui.load(source, 2);
  await ui.objects.first().click();
  await page.keyboard.press("Control+x");
  await expect(ui.objects).toHaveCount(1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  let restored = await P.loadPresentation(await ui.download());
  expect(
    P.getSlideCharts(P.getSlides(restored)[0]).map((c) => c.spec.kind),
  ).toEqual(["line", "bar"]);
  await ui.load(source, 2);
  await ui.objects.first().click();
  await page.keyboard.press("Control+d");
  await expect(ui.objects).toHaveCount(3);
  const loaded = await P.loadPresentation(await ui.download()),
    charts = P.getSlideCharts(P.getSlides(loaded)[0]);
  expect(charts).toHaveLength(3);
  expect(new Set(charts.map((c) => chartRoot(c.shape))).size).toBe(3);
  expect(new Set(charts.map((c) => workbook(loaded, c.shape).name)).size).toBe(
    3,
  );
  const original = charts[0].spec;
  P.setChartSpec(charts[2], {
    ...original,
    series: [{ name: "Edited copy", values: [32, 8, 7] }],
  });
  expect(P.getShapeChartSpec(charts[0].shape)).toEqual(original);
  expect(ui.errors).toEqual([]);
});

test("native value-axis references survive secondary-first XML through clipboard both ways and reimport", async ({
  page,
}) => {
  const { p } = chartAxisReferenceDeck(),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const svg = parseXml(
        decodeURIComponent(
          (await image.getAttribute("src")).split(",").slice(1).join(","),
        ),
      ),
      labels = [];
    walkElements(svg.root, (e) => {
      if (e.name.localName === "text")
        labels.push(
          e.children
            .filter((c) => c.kind === "text")
            .map((c) => c.data)
            .join(""),
        );
    });
    expect(labels.filter((s) => s === "-5.0")).toHaveLength(2 * sets);
    expect(labels.filter((s) => s === "25.0")).toHaveLength(2 * sets);
    const bytes = await ui.download(),
      result = await P.loadPresentation(bytes),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(sets * 2);
    for (const [i, { spec, shape }] of charts.entries()) {
      expect(spec.valueAxis).toEqual({
        min: -5,
        max: 25,
        majorUnit: 5,
        numberFormat: "0.0",
        numberFormatSourceLinked: false,
      });
      expect(spec.valueAxisLineColor).toBe("#9142B6");
      expect(spec.series[0].secondaryAxis).toBe(i % 2 ? undefined : true);
      expect(spec.series[1].secondaryAxis).toBe(true);
      const root = chartRoot(shape),
        graph = chartGraph(result, root);
      expect(
        graph.some(
          (part) =>
            part.contentType === "application/vnd.ms-office.chartstyle+xml",
        ),
      ).toBe(true);
      expect(workbook(result, shape).data.length).toBeGreaterThan(0);
      const native = parseXml(
          new TextDecoder().decode(
            P._internalPackageOf(result).getPart(root).data,
          ),
        ),
        axes = [];
      walkElements(native.root, (e) => {
        if (
          e.name.namespaceURI.endsWith("/chart") &&
          e.name.localName === "valAx"
        )
          axes.push(e);
      });
      expect(axes).toHaveLength(2);
      const primaryScaling = axes[1].children.find(
        (e) => e.kind === "element" && e.name.localName === "scaling",
      );
      expect(
        primaryScaling.children.some(
          (e) =>
            e.kind === "element" &&
            e.name.localName === "max" &&
            e.attrs.some((a) => a.name.localName === "val" && a.value === "25"),
        ),
      ).toBe(true);
    }
    expect(P.validatePresentation(result)).toEqual([]);
    return bytes;
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("native value directions and crossings retain readable geometry through clipboard both ways and reimport", async ({
  page,
}) => {
  const { p } = chartValueOrderDeck(),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const svgText = decodeURIComponent(
      (await image.getAttribute("src")).split(",").slice(1).join(","),
    );
    const layout = await page.evaluate(async (svg) => {
      const holder = document.createElement("div");
      holder.style.cssText = "position:absolute;left:-10000px;top:0";
      holder.innerHTML = svg;
      document.body.append(holder);
      try {
        const root = holder.querySelector("svg"),
          // This owned horizontal chart ends at x=480. The other chart's
          // two vertical scales carry the same text color independently.
          texts = [...root.querySelectorAll('text[fill="#9152BD"]')].filter(
            (t) => Number(t.getAttribute("x")) < 480,
          ),
          cats = [...root.querySelectorAll('text[fill="#A3472B"]')],
          blue = [...root.querySelectorAll('rect[fill="#2672A6"]')],
          secondary = [...root.querySelectorAll('path[stroke="#E58325"]')];
        // Firefox's SVG text getBBox includes unpainted glyph-box padding.
        // Isolate these labels and measure every painted alpha pixel instead;
        // retain the same strict eight-pixel chart margin in all engines.
        const isolated = root.cloneNode(false);
        for (const node of root.children)
          if (["defs", "style"].includes(node.localName))
            isolated.append(node.cloneNode(true));
        for (const label of cats) isolated.append(label.cloneNode(true));
        const mask = new Image();
        mask.src =
          "data:image/svg+xml;charset=utf-8," +
          encodeURIComponent(new XMLSerializer().serializeToString(isolated));
        await mask.decode();
        const canvas = document.createElement("canvas");
        canvas.width = mask.naturalWidth;
        canvas.height = mask.naturalHeight;
        const context = canvas.getContext("2d");
        context.drawImage(mask, 0, 0);
        const pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        let catsRasterRight = -1;
        for (let y = 0; y < canvas.height; y++)
          for (let x = 0; x < 480; x++)
            if (pixels[(y * canvas.width + x) * 4 + 3])
              catsRasterRight = Math.max(catsRasterRight, x);
        return {
          catsRasterRight,
          zero: texts
            .filter((t) => t.textContent === "0")
            .map((t) => ({
              x: Number(t.getAttribute("x")),
              y: Number(t.getAttribute("y")),
            })),
          ten: texts
            .filter((t) => t.textContent === "10")
            .map((t) => ({
              x: Number(t.getAttribute("x")),
              y: Number(t.getAttribute("y")),
            })),
          cats: cats.map((t) => ({
            anchor: t.getAttribute("text-anchor"),
            x: Number(t.getAttribute("x")),
          })),
          blue: blue.map((r) => ({
            x: Number(r.getAttribute("x")),
            width: Number(r.getAttribute("width")),
          })),
          secondary: secondary.map((path) =>
            [...path.getAttribute("d").matchAll(/[-+]?\d+(?:\.\d+)?/g)].map(
              (m) => Number(m[0]),
            ),
          ),
        };
      } finally {
        holder.remove();
      }
    }, svgText);
    expect(layout.cats).toHaveLength(3 * sets);
    expect(layout.blue).toHaveLength(6 * sets);
    expect(layout.secondary).toHaveLength(sets);
    expect(layout.zero).toHaveLength(sets);
    expect(layout.ten).toHaveLength(sets);
    expect(layout.catsRasterRight).toBeGreaterThan(layout.zero[0].x);
    expect(layout.catsRasterRight).toBeLessThan(480 - 8);
    for (let i = 0; i < sets; i++) {
      const zero = layout.zero[i],
        ten = layout.ten[i],
        bars = layout.blue.slice(i * 6, i * 6 + 3);
      expect(zero.x).toBeGreaterThan(ten.x);
      for (const bar of bars) expect(bar.x + bar.width).toBeCloseTo(zero.x, 1);
      for (const label of layout.cats.slice(i * 3, i * 3 + 3)) {
        expect(label.anchor).toBe("start");
        expect(label.x).toBeGreaterThan(zero.x);
      }
      const points = layout.secondary[i];
      expect(points[1]).toBeLessThan(points.at(-1));
    }
    const bytes = await ui.download(),
      reopened = await P.loadPresentation(bytes),
      charts = P.getSlideCharts(P.getSlides(reopened)[0]);
    expect(charts).toHaveLength(sets * 2);
    for (const [i, chart] of charts.entries()) {
      expect(chart.spec.valueAxisOrientation).toBe(i % 2 ? "minMax" : "maxMin");
      if (i % 2)
        expect(chart.spec.secondaryValueAxisOrientation).toBe("maxMin");
      expect(chart.spec.valueAxisCrosses).toEqual(
        i % 2 ? { at: 3 } : "autoZero",
      );
      expect(workbook(reopened, chart.shape).data.length).toBeGreaterThan(0);
      expect(
        chartGraph(reopened, chartRoot(chart.shape)).some(
          (part) =>
            part.contentType === "application/vnd.ms-office.chartstyle+xml",
        ),
      ).toBe(true);
    }
    expect(P.validatePresentation(reopened)).toEqual([]);
    return bytes;
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("independent chart series outlines survive clipboard both ways, data edits and reimport", async ({
  page,
}) => {
  const { p, slide } = chartSeriesOutlineDeck(),
    originals = P.getSlideCharts(slide),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const attribute = (e, name) =>
    e.attrs.find((a) => a.name.localName === name)?.value;
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const elements = [];
    walkElements(
      parseXml(
        decodeURIComponent(
          (await image.getAttribute("src")).split(",").slice(1).join(","),
        ),
      ).root,
      (e) => elements.push(e),
    );
    const bars = elements.filter(
      (e) =>
        e.name.localName === "rect" &&
        attribute(e, "fill") === "#23916F" &&
        attribute(e, "width") !== attribute(e, "height"),
    );
    expect(bars).toHaveLength(sets * 6);
    for (const [paint, width] of [
      ["none", 0],
      ["#B63874", 4],
    ]) {
      const selected = bars.filter((e) => attribute(e, "stroke") === paint);
      expect(selected).toHaveLength(sets * 3);
      for (const e of selected)
        expect(Number(attribute(e, "stroke-width"))).toBe(width);
    }
    expect(
      elements.filter(
        (e) =>
          e.name.localName === "circle" && attribute(e, "fill") === "#548BD2",
      ),
    ).toHaveLength(sets * 4);
    const paths = elements.filter(
      (e) =>
        e.name.localName === "path" &&
        attribute(e, "fill") === "none" &&
        attribute(e, "stroke") === "none",
    );
    expect(paths).toHaveLength(sets);
    const bytes = await ui.download(),
      result = await P.loadPresentation(bytes),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(sets * 2);
    expect(new Set(charts.map((c) => chartRoot(c.shape))).size).toBe(
      charts.length,
    );
    expect(
      new Set(charts.map((c) => workbook(result, c.shape).name)).size,
    ).toBe(charts.length);
    for (const [i, chart] of charts.entries()) {
      expect(chart.spec).toEqual(originals[i % 2].spec);
      expect(workbook(result, chart.shape).data).toEqual(
        workbook(p, originals[i % 2].shape).data,
      );
      expect(
        chartGraph(result, chartRoot(chart.shape)).some(
          (part) =>
            part.contentType === "application/vnd.ms-office.chartstyle+xml",
        ),
      ).toBe(true);
    }
    if (sets === 2) {
      P.setChartSpec(charts[3], {
        ...charts[3].spec,
        series: charts[3].spec.series.map((s) => ({
          ...s,
          values: s.values.map((v) => v + 1),
        })),
      });
      expect(P.getShapeChartSpec(charts[1].shape)).toEqual(originals[1].spec);
      expect(
        P.getShapeChartSpec(charts[3].shape).series.map((s) => [
          s.color,
          s.lineColor,
          s.lineWidthEmu,
        ]),
      ).toEqual(
        originals[1].spec.series.map((s) => [
          s.color,
          s.lineColor,
          s.lineWidthEmu,
        ]),
      );
    }
    expect(P.validatePresentation(result)).toEqual([]);
    return bytes;
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("native legend container paints survive clipboard both ways, data edits and reimport", async ({
  page,
}) => {
  const { p, slide } = chartLegendPaintDeck(),
    originals = P.getSlideCharts(slide),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const attribute = (e, name) =>
    e.attrs.find((a) => a.name.localName === name)?.value;
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const elements = [];
    walkElements(
      parseXml(
        decodeURIComponent(
          (await image.getAttribute("src")).split(",").slice(1).join(","),
        ),
      ).root,
      (e) => elements.push(e),
    );
    const boxes = elements.filter(
      (e) =>
        e.name.localName === "rect" &&
        ["#5438A8", "#1A8E74"].includes(attribute(e, "stroke")),
    );
    expect(boxes).toHaveLength(sets * 2);
    for (const [paint, color, width] of [
      ["#ECD8B0", "#5438A8", 4],
      ["none", "#1A8E74", 1 / 9525],
    ]) {
      const selected = boxes.filter((e) => attribute(e, "stroke") === color);
      expect(selected).toHaveLength(sets);
      for (const box of selected) {
        expect(attribute(box, "fill")).toBe(paint);
        expect(Number(attribute(box, "stroke-width"))).toBe(width);
        expect(Number(attribute(box, "width"))).toBeGreaterThan(9);
        expect(Number(attribute(box, "height"))).toBeGreaterThan(9);
      }
    }
    expect(
      elements.filter(
        (e) =>
          e.name.localName === "text" && attribute(e, "fill") === "#112233",
      ),
    ).toHaveLength(sets * 2);
    const bytes = await ui.download(),
      result = await P.loadPresentation(bytes),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(sets * 2);
    expect(new Set(charts.map((c) => chartRoot(c.shape))).size).toBe(
      charts.length,
    );
    expect(
      new Set(charts.map((c) => workbook(result, c.shape).name)).size,
    ).toBe(charts.length);
    for (const [i, chart] of charts.entries()) {
      expect(chart.spec).toEqual(originals[i % 2].spec);
      expect(workbook(result, chart.shape).data).toEqual(
        workbook(p, originals[i % 2].shape).data,
      );
      expect(
        chartGraph(result, chartRoot(chart.shape)).some(
          (part) =>
            part.contentType === "application/vnd.ms-office.chartstyle+xml",
        ),
      ).toBe(true);
    }
    if (sets === 2) {
      P.setChartSpec(charts[3], {
        ...charts[3].spec,
        series: charts[3].spec.series.map((s) => ({
          ...s,
          values: s.values.map((v) => v + 1),
        })),
      });
      expect(P.getShapeChartSpec(charts[1].shape)).toEqual(originals[1].spec);
      expect(P.getShapeChartSpec(charts[3].shape).legend).toEqual(
        originals[1].spec.legend,
      );
      const reopened = await P.loadPresentation(
        await P.savePresentation(result),
      );
      expect(P.getSlideCharts(P.getSlides(reopened)[0])[3].spec.legend).toEqual(
        originals[1].spec.legend,
      );
    }
    expect(P.validatePresentation(result)).toEqual([]);
    return bytes;
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("native chart stroke widths survive clipboard both ways, export and independent editing", async ({
  page,
}) => {
  const { p, slide } = chartStrokeWidthDeck(),
    originals = P.getSlideCharts(slide),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const attribute = (e, name) =>
    e.attrs.find((a) => a.name.localName === name)?.value;
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const elements = [];
    walkElements(
      parseXml(
        decodeURIComponent(
          (await image.getAttribute("src")).split(",").slice(1).join(","),
        ),
      ).root,
      (e) => elements.push(e),
    );
    for (const [color, widths] of [
      ["#A84271", [0, 2]],
      ["#3166B8", [1 / 9525, 3]],
      ["#28A773", [1, 4]],
      ["#D99622", [0, 8]],
      ["#7543AA", [1 / 9525, 9]],
      ["#C36929", [11]],
    ]) {
      const strokes = elements.filter((e) => attribute(e, "stroke") === color);
      expect(strokes.length).toBeGreaterThan(0);
      const actual = new Set(
        strokes.map((e) => Number(attribute(e, "stroke-width"))),
      );
      expect([...actual].sort((a, b) => a - b)).toEqual(widths);
    }
    const bytes = await ui.download(),
      result = await P.loadPresentation(bytes),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(sets * 2);
    expect(new Set(charts.map((c) => chartRoot(c.shape))).size).toBe(
      charts.length,
    );
    expect(
      new Set(charts.map((c) => workbook(result, c.shape).name)).size,
    ).toBe(charts.length);
    for (const [i, chart] of charts.entries()) {
      expect(chart.spec).toEqual(originals[i % 2].spec);
      expect(workbook(result, chart.shape).data).toEqual(
        workbook(p, originals[i % 2].shape).data,
      );
      expect(
        chartGraph(result, chartRoot(chart.shape)).some(
          (part) =>
            part.contentType === "application/vnd.ms-office.chartstyle+xml",
        ),
      ).toBe(true);
    }
    if (sets === 2) {
      P.setChartSpec(charts[3], {
        ...charts[3].spec,
        valueAxisLineWidthEmu: 9525,
        series: charts[3].spec.series.map((s) => ({
          ...s,
          values: s.values.map((v) => v + 1),
        })),
      });
      expect(P.getShapeChartSpec(charts[1].shape)).toEqual(originals[1].spec);
      const edited = P.getShapeChartSpec(charts[3].shape);
      expect(edited.valueAxisLineWidthEmu).toBe(9525);
      expect(edited.secondaryValueAxisLineWidthEmu).toBe(
        originals[1].spec.secondaryValueAxisLineWidthEmu,
      );
      expect(edited.series[0].values).toEqual(
        originals[1].spec.series[0].values.map((v) => v + 1),
      );
    }
    expect(P.validatePresentation(result)).toEqual([]);
    return bytes;
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("native category spacing aligns charts through clipboard both ways, export and reimport", async ({
  page,
}) => {
  const { p, slide } = chartCategorySpacingDeck(),
    originals = P.getSlideCharts(slide),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const attr = (e, name) =>
    e.attrs.find((a) => a.name.localName === name)?.value;
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const elements = [];
    walkElements(
      parseXml(
        decodeURIComponent(
          (await image.getAttribute("src")).split(",").slice(1).join(","),
        ),
      ).root,
      (e) => elements.push(e),
    );
    for (const [axis, line] of [
      ["#713AC8", "#346BA8"],
      ["#238F61", "#28A883"],
    ]) {
      const spines = elements.filter(
        (e) =>
          e.name.localName === "line" &&
          attr(e, "stroke") === axis &&
          attr(e, "y1") === attr(e, "y2"),
      );
      const paths = elements.filter(
        (e) =>
          e.name.localName === "path" &&
          attr(e, "stroke") === line &&
          attr(e, "fill") === "none",
      );
      expect(spines).toHaveLength(sets);
      expect(paths).toHaveLength(sets);
      for (const [i, path] of paths.entries()) {
        const points = Array.from(
          attr(path, "d").matchAll(/[ML]\s*([-\d.]+)[ ,]+([-\d.]+)/g),
          (m) => Number(m[1]),
        );
        expect(points).toHaveLength(3);
        expect(points[0]).toBeCloseTo(Number(attr(spines[i], "x1")), 1);
        expect(points.at(-1)).toBeCloseTo(Number(attr(spines[i], "x2")), 1);
      }
      const ticks = elements.filter(
        (e) =>
          e.name.localName === "line" &&
          attr(e, "stroke") === axis &&
          attr(e, "x1") === attr(e, "x2"),
      );
      expect(ticks).toHaveLength(sets * (axis === "#713AC8" ? 3 : 4));
    }
    const bytes = await ui.download(),
      result = await P.loadPresentation(bytes),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(sets * 2);
    expect(new Set(charts.map((c) => chartRoot(c.shape))).size).toBe(
      charts.length,
    );
    expect(
      new Set(charts.map((c) => workbook(result, c.shape).name)).size,
    ).toBe(charts.length);
    for (const [i, chart] of charts.entries()) {
      expect(chart.spec).toEqual(originals[i % 2].spec);
      expect(workbook(result, chart.shape).data).toEqual(
        workbook(p, originals[i % 2].shape).data,
      );
      expect(
        chartGraph(result, chartRoot(chart.shape)).some(
          (part) =>
            part.contentType === "application/vnd.ms-office.chartstyle+xml",
        ),
      ).toBe(true);
    }
    if (sets === 2) {
      P.setChartSpec(charts[3], {
        ...charts[3].spec,
        secondaryValueAxisCrossBetween: "between",
      });
      expect(
        P.getShapeChartSpec(charts[1].shape).secondaryValueAxisCrossBetween,
      ).toBe("midCat");
    }
    expect(P.validatePresentation(result)).toEqual([]);
    return bytes;
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("chart values beyond category labels survive clipboard, export and reimport", async ({
  page,
}) => {
  const { p } = chartDataDeck(),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const svg = decodeURIComponent(
      (await image.getAttribute("src")).split(",").slice(1).join(","),
    );
    expect(svg).toContain("Named category");
    expect(svg).not.toContain("chart — no data");
    const result = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(sets * 2);
    const linePaths = [];
    walkElements(parseXml(svg).root, (e) => {
      if (
        e.name.localName === "path" &&
        e.attrs.some(
          (a) =>
            a.name.localName === "stroke" &&
            a.value === charts[1].spec.series[0].color,
        )
      )
        linePaths.push(e);
    });
    expect(linePaths).toHaveLength(sets);
    for (const path of linePaths)
      expect(
        path.attrs.find((a) => a.name.localName === "d").value.match(/[ML]/g),
      ).toHaveLength(4);
    for (const [i, chart] of charts.entries()) {
      expect(chart.spec.categories).toEqual(i % 2 ? ["Named category"] : []);
      expect(chart.spec.series[0].values).toEqual([4 + (i % 2), 9, -2, 17]);
      const sheet = strFromU8(
        unzipSync(workbook(result, chart.shape).data)[
          "xl/worksheets/sheet1.xml"
        ],
      );
      expect(sheet).toContain('<c r="B5"><v>17</v></c>');
    }
    expect(
      new Set(charts.map((c) => workbook(result, c.shape).name)).size,
    ).toBe(charts.length);
    expect(P.validatePresentation(result)).toEqual([]);
    return Buffer.from(await P.savePresentation(result));
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("native chart blank cache slots survive clipboard both ways and reimport", async ({
  page,
}) => {
  const { p } = chartCacheDeck(),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const svg = decodeURIComponent(
      (await image.getAttribute("src")).split(",").slice(1).join(","),
    );
    expect(svg).toContain("Named category");
    const result = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(sets * 2);
    for (const [i, chart] of charts.entries()) {
      expect(chart.spec.series[0].values).toEqual([
        4 + (i % 2),
        null,
        -2,
        null,
        null,
      ]);
      const sheet = strFromU8(
        unzipSync(workbook(result, chart.shape).data)[
          "xl/worksheets/sheet1.xml"
        ],
      );
      expect(sheet).toContain('<row r="6">');
      const doc = parseXml(sheet);
      for (const address of ["B3", "B5", "B6"]) {
        let cell;
        walkElements(doc.root, (e) => {
          if (e.name.localName === "c" && workbookAttribute(e, "r") === address)
            cell = e;
        });
        // Empty cells may retain native formatting; they must contain no value or formula.
        if (cell)
          for (const name of ["v", "is", "f"])
            expect(
              firstChildElement(
                cell,
                qname("", name, doc.root.name.namespaceURI),
              ),
            ).toBeNull();
      }
    }
    expect(P.validatePresentation(result)).toEqual([]);
    return Buffer.from(await P.savePresentation(result));
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("native scheme paints retain chart overrides and transforms through clipboard both ways", async ({
  page,
}) => {
  const { p } = chartColorDeck(),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    const svg = async () =>
      decodeURIComponent(
        (await image.getAttribute("src")).split(",").slice(1).join(","),
      );
    await expect.poll(svg).toContain("North");
    expect(await svg()).toContain("#00FFFF");
    expect(await svg()).toContain("#FF00FF");
    const result = await P.loadPresentation(await ui.download());
    expect(
      P.getSlideCharts(P.getSlides(result)[0]).map(
        (c) => c.spec.series[0].color,
      ),
    ).toEqual(
      Array.from({ length: sets }, () => ["#00FFFF", "#FF00FF"]).flat(),
    );
    expect(P.validatePresentation(result)).toEqual([]);
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("native transparent chart areas survive clipboard both ways and reimport", async ({
  page,
}) => {
  const { p, slide } = chartCopyDeck({ transparent: true });
  P.setSlideBackground(slide, "#19304D");
  const source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    await expect(image).toBeVisible();
    const svg = decodeURIComponent(
      (await image.getAttribute("src")).split(",").slice(1).join(","),
    );
    let transparent = 0;
    walkElements(parseXml(svg).root, (e) => {
      if (
        e.name.localName === "rect" &&
        e.attrs.some(
          (a) => a.name.localName === "fill" && a.value === "none",
        ) &&
        e.attrs.some((a) => a.name.localName === "stroke" && a.value === "none")
      )
        transparent++;
    });
    expect(transparent).toBe(sets * 2);
    const result = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(sets * 2);
    for (const { spec } of charts)
      expect([
        spec.chartAreaFill,
        spec.chartAreaStrokeColor,
        spec.plotAreaFill,
        spec.plotAreaStrokeColor,
      ]).toEqual([null, null, null, null]);
    expect(P.validatePresentation(result)).toEqual([]);
    return Buffer.from(await P.savePresentation(result));
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("automatic chart-axis orientation retains full labels through clipboard and reimport", async ({
  page,
}) => {
  const { p, slide } = chartCopyDeck();
  const categories = [
    "An extended northern category",
    "An extended southern category",
    "An extended western category",
  ];
  for (const chart of P.getSlideCharts(slide))
    P.setChartSpec(chart, {
      ...chart.spec,
      categories,
      categoryAxisLabelRotationDeg: null,
      valueAxisLabelRotationDeg: null,
    });
  const source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    await expect(image).toBeVisible();
    const svg = decodeURIComponent(
      (await image.getAttribute("src")).split(",").slice(1).join(","),
    );
    for (const text of categories) expect(svg).toContain(text);
    expect(svg).not.toContain("rotate(-1000");
    const result = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(sets * 2);
    for (const { spec } of charts) {
      expect(spec.categories).toEqual(categories);
      expect(spec.categoryAxisLabelRotationDeg).toBeNull();
      expect(spec.valueAxisLabelRotationDeg).toBeNull();
    }
    expect(P.validatePresentation(result)).toEqual([]);
    return Buffer.from(await P.savePresentation(result));
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

for (const kind of ["bar", "column", "line"])
  test(`complete ${kind} category text survives authored angles, clipboard both ways and independent edits`, async ({
    page,
  }, testInfo) => {
    const categories = [
        "Quarterly revenue by market",
        "International operating income after tax",
        'ABCDEFGHIJKLé👩‍👩‍👧‍👦 R&D <net> "quoted" totals',
      ],
      values = [2, 4, 3],
      f = chartLegendLayoutDeck({
        kind,
        categories,
        legend: undefined,
        categoryAxisLabelRotationDeg: 0,
        categoryAxisLabelStyle: {
          font: "Arial",
          sizePt: 12,
          color: "#604020",
        },
        valueAxisHidden: true,
        series: [{ name: "Units", values, color: "#E85239" }],
      });
    P.setShapePosition(f.shape, P.pt(45), P.pt(37.5));
    P.setShapeSize(f.shape, P.pt(855), P.pt(450));
    const chartBody = (bytes) => {
        const doc = parseXml(new TextDecoder().decode(bytes));
        // Native transfer may add a chart-local copy of the source color map.
        // The label content and every other chart declaration stay exact.
        doc.root.children = doc.root.children.filter(
          (e) =>
            e.kind !== "element" ||
            e.name.namespaceURI !== NS.chart ||
            e.name.localName !== "clrMapOvr",
        );
        return serializeXml(doc);
      },
      source = Buffer.from(await P.savePresentation(f.p)),
      originalXml = chartBody(
        P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data,
      ),
      originalBook = workbook(f.p, f.shape).data.slice(),
      ui = await setup(page),
      original = { categories, angle: 0, values },
      check = async (states) => {
        const labels = await page
          .locator("#slide-canvas .slide-image")
          .evaluate(async (img) => {
            await img.decode();
            const svg = new DOMParser().parseFromString(
              decodeURIComponent(img.src.split(",").slice(1).join(",")),
              "image/svg+xml",
            );
            return [...svg.querySelectorAll('text[fill="#604020"]')].map(
              (e) => ({
                text: e.textContent,
                rotation: e.hasAttribute("transform")
                  ? Number(
                      /rotate\(([-.\d]+)/.exec(e.getAttribute("transform"))[1],
                    )
                  : 0,
              }),
            );
          });
        expect(labels).toEqual(
          states.flatMap((s) =>
            s.categories.map((text) => ({ text, rotation: s.angle })),
          ),
        );
        const bytes = await ui.download(),
          p = await P.loadPresentation(bytes),
          charts = P.getSlideCharts(P.getSlides(p)[0]);
        expect(charts).toHaveLength(states.length);
        for (const [i, chart] of charts.entries()) {
          expect(chart.spec.categories).toEqual(states[i].categories);
          expect(chart.spec.categoryAxisLabelRotationDeg).toBe(states[i].angle);
          expect(chart.spec.series[0].values).toEqual(states[i].values);
        }
        expect(
          chartBody(
            P._internalPackageOf(p).getPart(chartRoot(charts[0].shape)).data,
          ),
        ).toEqual(originalXml);
        expect(workbook(p, charts[0].shape).data).toEqual(originalBook);
        expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
          states.length,
        );
        expect(P.validatePresentation(p)).toEqual([]);
        return { p, charts, bytes };
      };
    await ui.load(source, 1);
    await check([original]);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check([original]);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const { p, charts } = await check([original, original]),
      beforeEdit = P._internalPackageOf(p)
        .getPart(chartRoot(charts[0].shape))
        .data.slice(),
      edited = {
        categories: categories.map((s) => `${s} revised`),
        angle: 45,
        values: values.map((n) => n + 1),
      };
    P.setChartSpec(charts[1], {
      ...charts[1].spec,
      categories: edited.categories,
      categoryAxisLabelRotationDeg: edited.angle,
      series: charts[1].spec.series.map((s) => ({
        ...s,
        values: edited.values,
      })),
    });
    await ui.load(Buffer.from(await P.savePresentation(p)), 2);
    const final = await check([original, edited]);
    expect(
      P._internalPackageOf(final.p).getPart(chartRoot(final.charts[0].shape))
        .data,
    ).toEqual(beforeEdit);
    await testInfo.attach(`edited-complete-${kind}-category-text.pptx`, {
      body: final.bytes,
      contentType: MIME,
    });
    expect(ui.errors).toEqual([]);
  });

for (const high of [false, true])
  test(`complete bar category rows fit the ${high ? "right" : "left"} edge through clipboard and independent edits`, async ({
    page,
  }, testInfo) => {
    const categories = [
        "Quarterly revenue by market",
        "International operating income after tax",
        'ABCDEFGHIJKLé👩‍👩‍👧‍👦 R&D <net> "quoted" totals',
      ],
      f = chartLegendLayoutDeck({
        kind: "bar",
        categories,
        legend: undefined,
        categoryAxisLabelRotationDeg: 0,
        categoryAxisTickLabelPos: high ? "high" : "low",
        categoryAxisCrosses: high ? "max" : "min",
        categoryAxisLabelStyle: {
          font: high ? "Georgia" : "Arial",
          sizePt: high ? 14 : 12,
          color: "#604020",
        },
        valueAxisHidden: true,
        series: [{ name: "Units", values: [2, 4, 3], color: "#E85239" }],
      }),
      ui = await setup(page);
    P.setShapePosition(f.shape, P.pt(45), P.pt(37.5));
    P.setShapeSize(f.shape, P.pt(855), P.pt(450));
    const bytes = Buffer.from(await P.savePresentation(f.p));
    const check = async (count, edited = false) => {
      const labels = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img) => {
          await img.decode();
          const svg = new DOMParser().parseFromString(
            decodeURIComponent(img.src.split(",").slice(1).join(",")),
            "image/svg+xml",
          ).documentElement;
          svg.style.cssText =
            "position:fixed;left:0;top:0;opacity:0;pointer-events:none";
          document.body.append(svg);
          try {
            await document.fonts.ready;
            return [...svg.querySelectorAll('text[fill="#604020"]')].map(
              (e) => {
                const box = e.getBBox(),
                  matrix = svg.getCTM().inverse().multiply(e.getCTM()),
                  points = [box.x, box.x + box.width].flatMap((x) =>
                    [box.y, box.y + box.height].map((y) =>
                      new DOMPoint(x, y).matrixTransform(matrix),
                    ),
                  );
                return {
                  text: e.textContent,
                  left: Math.min(...points.map((p) => p.x)),
                  right: Math.max(...points.map((p) => p.x)),
                };
              },
            );
          } finally {
            svg.remove();
          }
        });
      expect(labels.map((l) => l.text)).toEqual(
        Array.from({ length: count }, (_, i) =>
          categories.map((s) => (edited && i === 1 ? `${s} revised` : s)),
        ).flat(),
      );
      for (const label of labels) {
        expect(label.left).toBeGreaterThanOrEqual(60);
        expect(label.right).toBeLessThanOrEqual(1200);
      }
      const download = await ui.download(),
        p = await P.loadPresentation(download),
        charts = P.getSlideCharts(P.getSlides(p)[0]);
      expect(charts).toHaveLength(count);
      for (const [i, c] of charts.entries()) {
        expect(c.spec.categories).toEqual(
          categories.map((s) => (edited && i === 1 ? `${s} revised` : s)),
        );
        expect(c.spec.categoryAxisLabelRotationDeg).toBe(0);
        expect(c.spec.categoryAxisTickLabelPos).toBe(high ? "high" : "low");
        expect(c.spec.series[0].values).toEqual(
          edited && i === 1 ? [3, 5, 4] : [2, 4, 3],
        );
      }
      expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
        count,
      );
      expect(P.validatePresentation(p)).toEqual([]);
      return { p, charts, download };
    };
    await ui.load(bytes, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(bytes, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const { p, charts } = await check(2),
      original = P._internalPackageOf(p)
        .getPart(chartRoot(charts[0].shape))
        .data.slice(),
      book = workbook(p, charts[0].shape).data.slice();
    P.setChartSpec(charts[1], {
      ...charts[1].spec,
      categories: categories.map((s) => `${s} revised`),
      categoryAxisLabelStyle: {
        ...charts[1].spec.categoryAxisLabelStyle,
        font: high ? "Times New Roman" : "Courier New",
        sizePt: high ? 16 : 14,
      },
      series: charts[1].spec.series.map((s) => ({ ...s, values: [3, 5, 4] })),
    });
    await ui.load(Buffer.from(await P.savePresentation(p)), 2);
    await check(2, true);
    await ui.load(await ui.download(), 2);
    const result = await check(2, true);
    expect(
      P._internalPackageOf(result.p).getPart(chartRoot(result.charts[0].shape))
        .data,
    ).toEqual(original);
    expect(workbook(result.p, result.charts[0].shape).data).toEqual(book);
    await testInfo.attach(
      `edited-complete-bar-${high ? "right" : "left"}-rows.pptx`,
      { body: result.download, contentType: MIME },
    );
    expect(ui.errors).toEqual([]);
  });

for (const radarStyle of ["standard", "marker", "filled"])
  for (const scenario of ["grids", "marks"])
    test(`${radarStyle} native radar ${scenario} survive clipboard both ways and download`, async ({
      page,
    }, testInfo) => {
      const grids = scenario === "grids",
        n = grids ? 5 : 7,
        f = chartRadarGridDeck({
          radarStyle,
          n,
          axes: grids
            ? {
                value: {
                  major: radarGridLine(radarGridColors.major),
                  minor: radarGridLine(radarGridColors.minor, 9525),
                },
                category: { hidden: true },
              }
            : {
                value: { majorTickMark: "cross", minorTickMark: "cross" },
                category: { tickMarkSkip: 2 },
              },
        }),
        ui = await setup(page),
        source = Buffer.from(await P.savePresentation(f.p)),
        originalSpec = P.getShapeChartSpec(f.shape),
        originalBook = workbook(f.p, f.shape).data.slice(),
        axes = chartRenderingView(f.shape).axisLines;
      const expectedSpec = originalSpec,
        expectedBook = originalBook;
      const check = async (count) => {
        const r = await page.locator("#slide-canvas .slide-image").evaluate(
          async (img, { colors, filled }) => {
            await img.decode();
            const svg = new DOMParser().parseFromString(
                decodeURIComponent(img.src.split(",").slice(1).join(",")),
                "image/svg+xml",
              ),
              nodes = [...svg.querySelectorAll("*")],
              paths = (color) =>
                nodes.filter(
                  (e) =>
                    e.tagName === "line" &&
                    e.getAttribute("stroke") === color &&
                    +e.getAttribute("stroke-width") > 0,
                ),
              value = paths(colors.value),
              length = (e) =>
                Math.hypot(
                  +e.getAttribute("x2") - e.getAttribute("x1"),
                  +e.getAttribute("y2") - e.getAttribute("y1"),
                );
            const groups = [...svg.querySelectorAll("g")].filter((g) =>
              [...g.children].some(
                (e) =>
                  e.tagName === "polygon" &&
                  [e.getAttribute("fill"), e.getAttribute("stroke")].includes(
                    "#AA9988",
                  ),
              ),
            );
            return {
              major: paths(colors.major).length,
              minor: paths(colors.minor).length,
              category: paths(colors.category).length,
              spines: value.filter((e) => length(e) > 20).length,
              marks: value.filter((e) => length(e) < 20).length,
              labels: nodes.filter(
                (e) =>
                  e.tagName === "text" && e.getAttribute("fill") === "#604020",
              ).length,
              layers: groups.map((g) => {
                const children = [...g.children],
                  data = children.findIndex(
                    (e) =>
                      e.tagName === "polygon" &&
                      [
                        e.getAttribute("fill"),
                        e.getAttribute("stroke"),
                      ].includes("#AA9988"),
                  );
                return children.every(
                  (e, i) =>
                    e.tagName !== "line" ||
                    (e.getAttribute("stroke") === colors.value
                      ? i > data === filled
                      : i < data),
                );
              }),
              finite: !/NaN|Infinity/.test(
                new XMLSerializer().serializeToString(svg),
              ),
            };
          },
          { colors: radarGridColors, filled: radarStyle === "filled" },
        );
        expect(r).toEqual({
          major: grids ? 20 * count : 0,
          minor: grids ? 60 * count : 0,
          category: 0,
          spines: (grids ? 5 : 4) * count,
          marks: grids ? 0 : 280 * count,
          labels: grids ? 0 : 7 * count,
          layers: Array(count).fill(true),
          finite: true,
        });
        const bytes = await ui.download(),
          p = await P.loadPresentation(bytes),
          charts = P.getSlideCharts(P.getSlides(p)[0]);
        expect(charts).toHaveLength(count);
        for (const c of charts) {
          expect(c.spec).toEqual(expectedSpec);
          expect(workbook(p, c.shape).data).toEqual(expectedBook);
          expect(chartRenderingView(c.shape).axisLines).toEqual(axes);
        }
        expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
          count,
        );
        expect(P.validatePresentation(p)).toEqual([]);
        return bytes;
      };
      await ui.load(source, 1);
      await check(1);
      await ui.copyAll();
      await ui.blank();
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(1);
      await check(1);
      await ui.copyAll();
      await ui.load(source, 1);
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(2);
      await check(2);
      await ui.load(await ui.download(), 2);
      const final = await check(2);
      await testInfo.attach(`native-radar-${radarStyle}-${scenario}.pptx`, {
        body: final,
        contentType: MIME,
      });
      expect(ui.errors).toEqual([]);
    });

for (const kind of ["radar", "column", "line", "pie", "doughnut"])
  test(`percentage and value formats remain independent through clipboard both ways (${kind})`, async ({
    page,
  }, testInfo) => {
    const f = chartPercentFormatPair(kind),
      source = Buffer.from(await P.savePresentation(f.p)),
      originals = P.getSlideCharts(f.slide).map((c) => ({
        spec: c.spec,
        book: workbook(f.p, c.shape).data.slice(),
      })),
      circular = kind === "pie" || kind === "doughnut",
      percent = ["2.2500 src", "4.5000 src", "6.7500 src", "8.0000 src"].map(
        (v, i) =>
          circular ? `${v} | ${["10.5%", "20.9%", "31.4%", "37.2%"][i]}` : v,
      ),
      values = ["2.25 units", "4.50 units", "6.75 units", "8.00 units"],
      ui = await setup(page);
    const check = async (sets = 1) => {
      const image = page.locator("#slide-canvas .slide-image");
      await image.evaluate((img) => img.decode());
      const svg = decodeURIComponent(
          (await image.getAttribute("src")).split(",").slice(1).join(","),
        ),
        nodes = [];
      walkElements(parseXml(svg).root, (e) => nodes.push(e));
      const texts = (color) =>
        nodes
          .filter(
            (e) =>
              e.name.localName === "text" &&
              getAttrValue(e, qname("", "fill", "")) === color,
          )
          .map((e) =>
            e.children
              .filter((c) => c.kind === "text")
              .map((c) => c.data)
              .join(""),
          );
      expect(texts(percentLabelColor)).toEqual(
        Array.from({ length: sets }, () => percent).flat(),
      );
      expect(texts(valueLabelColor)).toEqual(
        Array.from({ length: sets }, () => values).flat(),
      );
      const bytes = await ui.download(),
        result = await P.loadPresentation(bytes),
        charts = P.getSlideCharts(P.getSlides(result)[0]);
      expect(charts).toHaveLength(2 * sets);
      expect(new Set(charts.map((c) => chartRoot(c.shape))).size).toBe(
        2 * sets,
      );
      expect(
        new Set(charts.map((c) => workbook(result, c.shape).name)).size,
      ).toBe(2 * sets);
      for (const [i, chart] of charts.entries()) {
        expect(chart.spec).toEqual(originals[i % 2].spec);
        expect(workbook(result, chart.shape).data).toEqual(
          originals[i % 2].book,
        );
      }
      expect(P.validatePresentation(result)).toEqual([]);
      return Buffer.from(bytes);
    };
    await ui.load(source, 2);
    await check();
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    await check();
    await ui.copyAll();
    await ui.load(source, 2);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(4);
    const returned = await check(2);
    await ui.load(returned, 4);
    const final = await check(2);
    await testInfo.attach(`chart-percent-format-${kind}.pptx`, {
      body: final,
      contentType: MIME,
    });
    expect(ui.errors).toEqual([]);
  });

for (const kind of ["pie", "doughnut"])
  test(`whole percentages retain allocation through clipboard both ways (${kind})`, async ({
    page,
  }, testInfo) => {
    const f = chartPercentFormatDeck({
        kind,
        format: null,
        linked: null,
        source: "General",
        showValue: false,
        categories: ["A", "B", "C", "D"],
        series:
          kind === "pie"
            ? [{ name: "Signal", values: [1, 1, 1, null] }]
            : [
                { name: "Inner", values: [1, 1, 1, null] },
                { name: "Outer", values: [1, 1, 1, 3] },
              ],
      }),
      source = Buffer.from(await P.savePresentation(f.p)),
      spec = P.getShapeChartSpec(f.shape),
      book = workbook(f.p, f.shape).data.slice(),
      expected =
        kind === "pie"
          ? ["34%", "33%", "33%"]
          : ["34%", "33%", "33%", "16%", "17%", "17%", "50%"],
      ui = await setup(page);
    const check = async (count = 1) => {
      const image = page.locator("#slide-canvas .slide-image");
      await image.evaluate((img) => img.decode());
      const svg = decodeURIComponent(
          (await image.getAttribute("src")).split(",").slice(1).join(","),
        ),
        texts = [];
      walkElements(parseXml(svg).root, (e) => {
        if (
          e.name.localName === "text" &&
          getAttrValue(e, qname("", "fill", "")) === percentLabelColor
        )
          texts.push(
            e.children
              .filter((c) => c.kind === "text")
              .map((c) => c.data)
              .join(""),
          );
      });
      expect(texts).toEqual(
        Array.from({ length: count }, () => expected).flat(),
      );
      const bytes = await ui.download(),
        p = await P.loadPresentation(bytes),
        charts = P.getSlideCharts(P.getSlides(p)[0]);
      expect(charts).toHaveLength(count);
      expect(new Set(charts.map((c) => chartRoot(c.shape))).size).toBe(count);
      expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
        count,
      );
      for (const c of charts) {
        expect(c.spec).toEqual(spec);
        expect(workbook(p, c.shape).data).toEqual(book);
      }
      expect(P.validatePresentation(p)).toEqual([]);
      return Buffer.from(bytes);
    };
    await ui.load(source, 1);
    await check();
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check();
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const returned = await check(2);
    await ui.load(returned, 2);
    const final = await check(2);
    await testInfo.attach(`chart-percent-allocation-${kind}.pptx`, {
      body: final,
      contentType: MIME,
    });
    expect(ui.errors).toEqual([]);
  });

for (const kind of ["column", "radar", "doughnut"])
  test(`optional number digits retain decimal rounding through clipboard both ways (${kind})`, async ({
    page,
  }, testInfo) => {
    const f =
        kind === "doughnut"
          ? chartPercentFormatDeck({
              kind,
              format: "0.#%",
              showValue: false,
              categories: ["A", "B", "C", "D"],
              series: [
                { name: "Inner", values: [0, 1, 2, 3] },
                { name: "Outer", values: [2.25, 4.5, 6.75, 8] },
              ],
            })
          : chartOptionalNumberDeck({ kind, scope: "series" }),
      source = Buffer.from(await P.savePresentation(f.p)),
      spec = P.getShapeChartSpec(f.shape),
      book = workbook(f.p, f.shape).data.slice(),
      expected =
        kind === "doughnut"
          ? [
              "0.%",
              "16.7%",
              "33.3%",
              "50.%",
              "10.5%",
              "20.9%",
              "31.4%",
              "37.2%",
            ]
          : ["-12.34", "0.0", "0.0", "0.3", "1.0", "1.2", "1.23", "10.0"],
      axis =
        kind === "doughnut"
          ? []
          : ["-15.0", "-10.0", "-5.0", "0.0", "5.0", "10.0", "15.0"],
      ui = await setup(page);
    const check = async (count = 1) => {
      const image = page.locator("#slide-canvas .slide-image");
      await image.evaluate((img) => img.decode());
      const svg = decodeURIComponent(
          (await image.getAttribute("src")).split(",").slice(1).join(","),
        ),
        texts = [],
        axes = [];
      walkElements(parseXml(svg).root, (e) => {
        if (e.name.localName === "text") {
          const color = getAttrValue(e, qname("", "fill", "")),
            target =
              color === percentLabelColor
                ? texts
                : color === "#2468AC"
                  ? axes
                  : null;
          if (target)
            target.push(
              e.children
                .filter((c) => c.kind === "text")
                .map((c) => c.data)
                .join(""),
            );
        }
      });
      expect(texts).toEqual(
        Array.from({ length: count }, () => expected).flat(),
      );
      expect(axes).toEqual(Array.from({ length: count }, () => axis).flat());
      const bytes = await ui.download(),
        p = await P.loadPresentation(bytes),
        charts = P.getSlideCharts(P.getSlides(p)[0]);
      expect(charts).toHaveLength(count);
      expect(new Set(charts.map((c) => chartRoot(c.shape))).size).toBe(count);
      expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
        count,
      );
      for (const c of charts) {
        expect(c.spec).toEqual(spec);
        expect(workbook(p, c.shape).data).toEqual(book);
      }
      expect(P.validatePresentation(p)).toEqual([]);
      return Buffer.from(bytes);
    };
    await ui.load(source, 1);
    await check();
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check();
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const returned = await check(2);
    await ui.load(returned, 2);
    const final = await check(2);
    await testInfo.attach(`chart-optional-number-${kind}.pptx`, {
      body: final,
      contentType: MIME,
    });
    expect(ui.errors).toEqual([]);
  });

for (const [radarStyle, scenario] of [
  ["standard", "automatic fractional origin"],
  ["marker", "automatic fractional origin"],
  ["filled", "automatic fractional origin"],
  ["standard", "automatic scaled origin"],
  ["marker", "automatic scaled origin"],
  ["filled", "automatic scaled origin"],
  ["marker", "quarter percent"],
  ["filled", "negative currency"],
  ["standard", "fractional minimum"],
  ["marker", "source linked"],
  ["filled", "display thousands"],
  ["standard", "hidden labels"],
])
  test(`${radarStyle} radar value-axis ticks retain ${scenario} through clipboard both ways and download`, async ({
    page,
  }, testInfo) => {
    const c = radarAxisCases.find((c) => c.name === scenario),
      f = chartRadarAxisDeck(c, radarStyle),
      ui = await setup(page);
    P.setShapePosition(f.shape, P.pt(45), P.pt(37.5));
    P.setShapeSize(f.shape, P.pt(855), P.pt(450));
    const bytes = Buffer.from(await P.savePresentation(f.p)),
      spec = P.getShapeChartSpec(f.shape),
      book = workbook(f.p, f.shape).data.slice();
    const check = async (count) => {
      const paint = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img, color) => {
          await img.decode();
          const svg = new DOMParser().parseFromString(
            decodeURIComponent(img.src.split(",").slice(1).join(",")),
            "image/svg+xml",
          );
          const groups = [...svg.querySelectorAll("g")].filter((g) =>
            [...g.children].some(
              (e) =>
                e.tagName === "polygon" &&
                [e.getAttribute("fill"), e.getAttribute("stroke")].includes(
                  "#E85239",
                ),
            ),
          );
          const layering = groups.map((g) => {
            const nodes = [...g.children],
              last = nodes.findLastIndex(
                (e) =>
                  e.tagName === "polygon" &&
                  [e.getAttribute("fill"), e.getAttribute("stroke")].includes(
                    "#E85239",
                  ),
              );
            const labels = nodes.flatMap((e, i) =>
              e.tagName === "text" &&
              [color, "#604020"].includes(e.getAttribute("fill"))
                ? [i]
                : [],
            );
            return labels.length >= 4 && labels.every((i) => i > last);
          });
          return {
            layering,
            labels: [...svg.querySelectorAll(`text[fill="${color}"]`)].map(
              (e) => e.textContent,
            ),
            rings: [...svg.querySelectorAll('line[stroke="#E5E7EB"]')]
              .filter((_, i) => i % 4 === 0)
              .map((e) =>
                ["x1", "y1", "x2", "y2"]
                  .map((n) => e.getAttribute(n))
                  .join(","),
              ),
          };
        }, radarAxisColor);
      expect(paint.labels).toEqual(
        Array.from({ length: count }, () => c.labels).flat(),
      );
      expect(paint.rings).toHaveLength(count * (c.ticks.length - 1));
      expect(paint.layering).toEqual(Array(count).fill(true));
      for (const points of paint.rings)
        expect(points).not.toMatch(/NaN|Infinity/);
      const downloaded = await ui.download(),
        p = await P.loadPresentation(downloaded),
        charts = P.getSlideCharts(P.getSlides(p)[0]);
      expect(charts).toHaveLength(count);
      for (const chart of charts) {
        expect(chart.spec).toEqual(spec);
        expect(workbook(p, chart.shape).data).toEqual(book);
      }
      expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
        count,
      );
      expect(P.validatePresentation(p)).toEqual([]);
      return downloaded;
    };
    await ui.load(bytes, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(bytes, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    await check(2);
    await ui.load(await ui.download(), 2);
    const final = await check(2);
    await testInfo.attach(`radar-axis-${scenario.replaceAll(" ", "-")}.pptx`, {
      body: final,
      contentType: MIME,
    });
    expect(ui.errors).toEqual([]);
  });

for (const radarStyle of ["standard", "marker", "filled"])
  for (const [font, sizePt] of [
    ["Arial", 12],
    ["Georgia", 14],
  ])
    test(`${radarStyle} radar complete category text in ${font} survives clipboard both ways and download`, async ({
      page,
    }, testInfo) => {
      const f = chartRadarLabelDeck({
          radarStyle,
          categoryAxisLabelStyle: { font, sizePt, color: radarLabelColor },
          valueAxisLabelStyle: { font, sizePt: 10, color: "#9CA3AF" },
        }),
        ui = await setup(page);
      P.setShapePosition(f.shape, P.pt(45), P.pt(37.5));
      P.setShapeSize(f.shape, P.pt(855), P.pt(450));
      const bytes = Buffer.from(await P.savePresentation(f.p)),
        original = P.getShapeChartSpec(f.shape),
        book = workbook(f.p, f.shape).data.slice();
      const check = async (count) => {
        const labels = await page
          .locator("#slide-canvas .slide-image")
          .evaluate(async (img) => {
            await img.decode();
            const svg = new DOMParser().parseFromString(
              decodeURIComponent(img.src.split(",").slice(1).join(",")),
              "image/svg+xml",
            ).documentElement;
            svg.style.cssText =
              "position:fixed;left:0;top:0;opacity:0;pointer-events:none";
            document.body.append(svg);
            try {
              await document.fonts.ready;
              return [...svg.querySelectorAll('text[fill="#604020"]')].map(
                (e) => {
                  const box = e.getBBox(),
                    matrix = svg.getCTM().inverse().multiply(e.getCTM()),
                    points = [box.x, box.x + box.width].flatMap((x) =>
                      [box.y, box.y + box.height].map((y) =>
                        new DOMPoint(x, y).matrixTransform(matrix),
                      ),
                    );
                  return {
                    text: e.textContent,
                    left: Math.min(...points.map((p) => p.x)),
                    right: Math.max(...points.map((p) => p.x)),
                    top: Math.min(...points.map((p) => p.y)),
                    bottom: Math.max(...points.map((p) => p.y)),
                  };
                },
              );
            } finally {
              svg.remove();
            }
          });
        expect(labels.map((l) => l.text)).toEqual(
          Array.from({ length: count }, () => radarCategories).flat(),
        );
        for (const label of labels) {
          expect(label.left).toBeGreaterThanOrEqual(60);
          expect(label.right).toBeLessThanOrEqual(1200);
          expect(label.top).toBeGreaterThanOrEqual(50);
          expect(label.bottom).toBeLessThanOrEqual(650);
        }
        const download = await ui.download(),
          p = await P.loadPresentation(download),
          charts = P.getSlideCharts(P.getSlides(p)[0]);
        expect(charts).toHaveLength(count);
        for (const c of charts) {
          expect(c.spec).toEqual(original);
          expect(workbook(p, c.shape).data).toEqual(book);
        }
        expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
          count,
        );
        expect(P.validatePresentation(p)).toEqual([]);
        return download;
      };
      await ui.load(bytes, 1);
      await check(1);
      await ui.copyAll();
      await ui.blank();
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(1);
      await check(1);
      await ui.copyAll();
      await ui.load(bytes, 1);
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(2);
      await check(2);
      await ui.load(await ui.download(), 2);
      const final = await check(2);
      await testInfo.attach(`complete-radar-${radarStyle}-${font}.pptx`, {
        body: final,
        contentType: MIME,
      });
      expect(ui.errors).toEqual([]);
    });

test("fractional chart font sizes match measured sizes through clipboard and independent edits", async ({
  page,
}, testInfo) => {
  const f = chartLegendLayoutDeck({ kind: "column" }),
    c = P.getSlideCharts(f.slide)[0],
    roles = [
      "titleStyle",
      "categoryAxisTitleStyle",
      "valueAxisTitleStyle",
      "categoryAxisLabelStyle",
      "valueAxisLabelStyle",
      "legend",
      "dataLabels",
    ],
    sizes = [6.05, 11.97, 14, 23.75, 32, 9.04, 13.01],
    colors = [
      "#173A5C",
      "#285B7D",
      "#397C9E",
      "#4A9DBF",
      "#5B2E40",
      "#6C4F61",
      "#7D6082",
    ],
    styleSpec = (sizes) =>
      Object.fromEntries(
        roles.map((role, i) => {
          const textStyle = {
            font: "Arial",
            sizePt: sizes[i],
            color: colors[i],
          };
          return [
            role,
            role === "legend"
              ? { position: "b", textStyle }
              : role === "dataLabels"
                ? { showValue: true, textStyle }
                : textStyle,
          ];
        }),
      );
  P.setChartSpec(c, {
    ...c.spec,
    title: "Fractional sizes",
    categoryAxisTitle: "Category",
    valueAxisTitle: "Value",
    ...styleSpec(sizes),
  });
  const source = Buffer.from(await P.savePresentation(f.p)),
    originalBook = workbook(f.p, c.shape).data.slice(),
    ui = await setup(page),
    check = async (states) => {
      const labels = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img) => {
          await img.decode();
          const svg = new DOMParser().parseFromString(
            decodeURIComponent(img.src.split(",").slice(1).join(",")),
            "image/svg+xml",
          );
          return [...svg.querySelectorAll("text")].map((e) => ({
            fill: e.getAttribute("fill"),
            size: +e.getAttribute("font-size"),
          }));
        });
      for (const [i, color] of colors.entries()) {
        const actual = labels
            .filter((e) => e.fill === color)
            .map((e) => e.size),
          expected = states.map((state) => state[i] * (4 / 3));
        expect(actual.length).toBeGreaterThan(0);
        expect([...new Set(actual)].sort((a, b) => a - b)).toEqual(
          [...new Set(expected)].sort((a, b) => a - b),
        );
      }
      const bytes = await ui.download(),
        p = await P.loadPresentation(bytes),
        charts = P.getSlideCharts(P.getSlides(p)[0]);
      expect(charts).toHaveLength(states.length);
      for (const [i, chart] of charts.entries()) {
        for (const [j, role] of roles.entries())
          expect(
            (role === "legend" || role === "dataLabels"
              ? chart.spec[role].textStyle
              : chart.spec[role]
            ).sizePt,
          ).toBe(states[i][j]);
      }
      expect(workbook(p, charts[0].shape).data).toEqual(originalBook);
      expect(P.validatePresentation(p)).toEqual([]);
      return { p, charts, bytes };
    };
  await ui.load(source, 1);
  await check([sizes]);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check([sizes]);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const { p, charts } = await check([sizes, sizes]),
    edited = sizes.map((n) => Math.round((n + 0.01) * 100) / 100);
  P.setChartSpec(charts[1], {
    ...charts[1].spec,
    ...styleSpec(edited),
    series: charts[1].spec.series.map((s) => ({
      ...s,
      values: s.values.map((v) => v + 1),
    })),
  });
  await ui.load(Buffer.from(await P.savePresentation(p)), 2);
  const final = await check([sizes, edited]);
  expect(final.charts[0].spec.series.map((s) => s.values)).toEqual(
    c.spec.series.map((s) => s.values),
  );
  expect(final.charts[1].spec.series.map((s) => s.values)).toEqual(
    c.spec.series.map((s) => s.values.map((v) => v + 1)),
  );
  await testInfo.attach("edited-fractional-chart-fonts.pptx", {
    body: final.bytes,
    contentType: MIME,
  });
  expect(ui.errors).toEqual([]);
});

test("native chart fonts and packaged title faces survive clipboard both ways", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeFace = window.FontFace;
    window.FontFace = class extends NativeFace {
      constructor(family, source, options) {
        super(family, source, options);
        this.localProbe =
          typeof source === "string" && source.startsWith("local(");
      }
      load() {
        return this.localProbe
          ? Promise.reject(new Error("Use owned packaged font faces"))
          : super.load();
      }
    };
  });
  const { p } = chartFontDeck(),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    const svg = async () => {
      await image.evaluate((img) => img.decode());
      return decodeURIComponent(
        (await image.getAttribute("src")).split(",").slice(1).join(","),
      );
    };
    await expect.poll(svg).toContain("@font-face");
    const rendered = await svg(),
      texts = [];
    walkElements(parseXml(rendered).root, (e) => {
      if (e.name.localName === "text") texts.push(e);
    });
    const value = (e) =>
      e.children
        .filter((c) => c.kind === "text")
        .map((c) => c.data)
        .join("");
    const attr = (e, n) => e.attrs.find((a) => a.name.localName === n)?.value;
    for (const title of texts.filter((e) =>
      value(e).startsWith("Chart typography"),
    )) {
      expect(attr(title, "font-family")).toContain('"Raleway"');
      expect(attr(title, "font-weight")).toBe("700");
      expect(attr(title, "font-style")).toBe("italic");
    }
    expect(
      texts.filter((e) => value(e).startsWith("Chart typography")),
    ).toHaveLength(sets * 2);
    expect(
      texts
        .filter((e) => value(e) === "North")
        .map((e) => attr(e, "font-family")),
    ).toEqual(
      Array.from({ length: sets }, () => [
        '"Courier New", "Courier New", monospace',
        '"Georgia", Georgia, "Times New Roman", serif',
      ]).flat(),
    );
    expect(rendered.match(/@font-face/g)).toHaveLength(2);
    expect(rendered).toContain(
      'font-family:"Raleway";font-style:italic;font-weight:700',
    );
    const result = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(sets * 2);
    for (const chart of charts) {
      expect(chart.spec.textStyle.font).toBe("+mn-lt");
      expect(chart.spec.titleStyle.font).toBe("Raleway");
    }
    expect(P.validatePresentation(result)).toEqual([]);
    return Buffer.from(await P.savePresentation(result));
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("native axis and gridline noFill survives clipboard both ways and reimport", async ({
  page,
}) => {
  const { p } = chartAxisPaintDeck(),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const svg = decodeURIComponent(
        (await image.getAttribute("src")).split(",").slice(1).join(","),
      ),
      lines = [];
    walkElements(parseXml(svg).root, (e) => {
      if (e.name.localName === "line") lines.push(e);
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(
      lines.every((e) =>
        e.attrs.some(
          (a) => a.name.localName === "stroke" && a.value === "none",
        ),
      ),
    ).toBe(true);
    expect(svg).toContain("North");
    const result = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(sets * 2);
    for (const { spec } of charts)
      expect([
        spec.categoryAxisLineColor,
        spec.valueAxisLineColor,
        spec.categoryAxisMajorGridlineColor,
        spec.categoryAxisMinorGridlineColor,
        spec.valueAxisMajorGridlineColor,
        spec.valueAxisMinorGridlineColor,
      ]).toEqual([null, null, null, null, null, null]);
    expect(P.validatePresentation(result)).toEqual([]);
    return Buffer.from(await P.savePresentation(result));
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("native category tick modes and independent strides survive clipboard both ways and reimport", async ({
  page,
}) => {
  const { p } = chartCategoryTickDeck(),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const svg = decodeURIComponent(
        (await image.getAttribute("src")).split(",").slice(1).join(","),
      ),
      elements = [];
    walkElements(parseXml(svg).root, (e) => elements.push(e));
    const attr = (e, name) =>
      e.attrs.find((a) => a.name.localName === name)?.value;
    const text = (e) =>
      e.children
        .filter((c) => c.kind === "text")
        .map((c) => c.data)
        .join("");
    expect(
      elements.filter(
        (e) => e.name.localName === "text" && text(e) === "North",
      ),
    ).toHaveLength(sets);
    expect(
      elements.filter(
        (e) => e.name.localName === "text" && text(e) === "South",
      ),
    ).toHaveLength(0);
    expect(
      elements.filter((e) => e.name.localName === "text" && text(e) === "West"),
    ).toHaveLength(0);
    for (const [color, bar] of [
      ["#713AC8", true],
      ["#238F61", false],
    ]) {
      const lines = elements.filter(
        (e) => e.name.localName === "line" && attr(e, "stroke") === color,
      );
      const ticks = lines.filter((e) =>
          bar
            ? attr(e, "y1") === attr(e, "y2")
            : attr(e, "x1") === attr(e, "x2"),
        ),
        spines = lines.filter((e) => !ticks.includes(e));
      expect(ticks).toHaveLength(sets * 2);
      expect(spines).toHaveLength(sets);
      const base = Number(attr(spines[0], bar ? "x1" : "y1"));
      for (const tick of ticks) {
        const ends = [
          Number(attr(tick, bar ? "x1" : "y1")),
          Number(attr(tick, bar ? "x2" : "y2")),
        ];
        expect(Math.min(...ends)).toBeLessThan(base);
        if (bar) expect(Math.max(...ends)).toBeGreaterThan(base);
        else expect(Math.max(...ends)).toBe(base);
      }
    }
    const result = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(sets * 2);
    for (const [i, { spec }] of charts.entries())
      expect([
        spec.categoryAxisMajorTickMark,
        spec.categoryAxisMinorTickMark,
        spec.categoryAxisTickMarkSkip,
        spec.categoryAxisTickLabelSkip,
        spec.categoryAxisTickLabelPos,
      ]).toEqual([
        i % 2 ? "in" : "cross",
        "none",
        2,
        3,
        i % 2 ? "nextTo" : "none",
      ]);
    expect(P.validatePresentation(result)).toEqual([]);
    return Buffer.from(await P.savePresentation(result));
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("native category plotting orders remain independent through clipboard both ways and reimport", async ({
  page,
}) => {
  const { p } = chartCategoryOrderDeck(),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const svg = decodeURIComponent(
        (await image.getAttribute("src")).split(",").slice(1).join(","),
      ),
      elements = [];
    walkElements(parseXml(svg).root, (e) => elements.push(e));
    const attr = (e, n) => e.attrs.find((a) => a.name.localName === n)?.value;
    const text = (e) =>
      e.children
        .filter((c) => c.kind === "text")
        .map((c) => c.data)
        .join("");
    for (const [color, bar] of [
      ["#713AC8", true],
      ["#238F61", false],
    ]) {
      const labels = elements.filter(
          (e) => e.name.localName === "text" && attr(e, "fill") === color,
        ),
        north = labels.filter((e) => text(e) === "North"),
        west = labels.filter((e) => text(e) === "West");
      expect(north).toHaveLength(sets);
      expect(west).toHaveLength(sets);
      for (const n of north) {
        const coordinate = bar ? "y" : "x";
        if (bar)
          expect(Number(attr(n, coordinate))).toBeLessThan(
            Number(attr(west[0], coordinate)),
          );
        else
          expect(Number(attr(n, coordinate))).toBeGreaterThan(
            Number(attr(west[0], coordinate)),
          );
      }
    }
    const lines = elements.filter(
      (e) => e.name.localName === "path" && attr(e, "stroke") === "#28A883",
    );
    expect(lines).toHaveLength(sets);
    for (const line of lines) {
      const points = [
        ...attr(line, "d").matchAll(/[ML]([-\d.]+),([-\d.]+)/g),
      ].map((m) => Number(m[1]));
      expect(points).toHaveLength(3);
      expect(points[0]).toBeLessThan(points.at(-1));
    }
    const result = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(sets * 2);
    for (const [i, { spec }] of charts.entries()) {
      expect(spec.categoryAxisOrientation).toBe("maxMin");
      expect(spec.secondaryCategoryAxisOrientation).toBe(
        i % 2 ? "minMax" : undefined,
      );
      expect(spec.categories).toEqual(["North", "South", "West"]);
    }
    expect(P.validatePresentation(result)).toEqual([]);
    return Buffer.from(await P.savePresentation(result));
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

for (const numericLegend of [false, true])
  test(`native linked and fixed number formats retain caches, styled workbook cells and clipboard both ways (numeric legend ${numericLegend})`, async ({
    page,
  }) => {
    const { p } = chartNumberFormatDeck(),
      ui = await setup(page);
    if (numericLegend)
      for (const [i, chart] of P.getSlideCharts(P.getSlides(p)[0]).entries())
        P.setChartSpec(chart, {
          ...chart.spec,
          kind: i ? "doughnut" : "pie",
          legend: { position: "r" },
        });
    const source = Buffer.from(await P.savePresentation(p));
    const check = async (sets = 1) => {
      const image = page.locator("#slide-canvas .slide-image");
      await image.evaluate((img) => img.decode());
      const svg = decodeURIComponent(
          (await image.getAttribute("src")).split(",").slice(1).join(","),
        ),
        text = [];
      walkElements(parseXml(svg).root, (e) => {
        if (e.name.localName === "text")
          text.push(
            e.children
              .filter((c) => c.kind === "text")
              .map((c) => c.data)
              .join(""),
          );
      });
      expect(text).toContain("20.0%");
      expect(text).toContain("0.20");
      expect(text).toContain("12.5%");
      if (!numericLegend) expect(text).toContain("0.13");
      else {
        expect(text).toContain("25.0%");
        expect(text).toContain("50.0%");
      }
      const result = await P.loadPresentation(await ui.download()),
        charts = P.getSlideCharts(P.getSlides(result)[0]);
      expect(charts).toHaveLength(2 * sets);
      const roots = charts.map((c) => chartRoot(c.shape)),
        books = charts.map((c) => workbook(result, c.shape));
      expect(new Set(roots).size).toBe(2 * sets);
      expect(new Set(books.map((b) => b.name)).size).toBe(2 * sets);
      for (const [i, chart] of charts.entries()) {
        const s = chart.spec;
        expect(s.categoryNumberFormat).toBe("0.0%");
        expect(s.series[0].numberFormat).toBe("0.0%");
        if (!numericLegend) {
          expect(s.valueAxis.numberFormat).toBe("0.00");
          expect(s.valueAxis.numberFormatSourceLinked).toBe(!(i % 2));
          expect(s.categoryAxisNumberFormatSourceLinked).toBe(!(i % 2));
        } else expect(s.kind).toBe(i % 2 ? "doughnut" : "pie");
        expect(s.series[0].dataLabels.numberFormatSourceLinked).toBe(!(i % 2));
        const zip = unzipSync(books[i].data);
        assertWorkbookCellFormat(zip, "B2", 0.2, "0.0%");
      }
      const original = books[0].data.slice();
      P.setChartSpec(charts.at(-1), {
        ...charts.at(-1).spec,
        series: [
          {
            ...charts.at(-1).spec.series[0],
            values: [0.7, 0.3, 0.1],
            numberFormat: "0.00%",
          },
        ],
      });
      expect(books[0].data).toEqual(original);
      assertWorkbookCellFormat(
        unzipSync(workbook(result, charts.at(-1).shape).data),
        "B2",
        0.7,
        "0.00%",
      );
      expect(P.validatePresentation(result)).toEqual([]);
      return Buffer.from(await ui.download());
    };
    await ui.load(source, 2);
    await check();
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    await check();
    await ui.copyAll();
    await ui.load(source, 2);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(4);
    const returned = await check(2);
    await ui.load(returned, 4);
    await check(2);
    expect(ui.errors).toEqual([]);
  });

test("native workbook bindings remain correct through edits, clipboard both ways and reimport despite decoy packages", async ({
  page,
}) => {
  const { p } = chartWorkbookBindingDeck(),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const check = async (sets = 1) => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const result = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(result)[0]),
      pkg = P._internalPackageOf(result);
    expect(charts).toHaveLength(sets * 2);
    expect(
      new Set(charts.map((c) => workbook(result, c.shape).name)).size,
    ).toBe(sets * 2);
    for (const [i, c] of charts.entries()) {
      const root = chartRoot(c.shape),
        external = firstChildElement(
          parseXml(new TextDecoder().decode(pkg.getPart(root).data)).root,
          qname("c", "externalData", NS.chart),
        ),
        id = getAttrValue(external, qname("r", "id", NS.officeDocRels));
      expect(id).toBe(i % 2 ? "WorkbookSource" : "rId7");
      const update = firstChildElement(
        external,
        qname("c", "autoUpdate", NS.chart),
      );
      expect(update ? getAttrValue(update, qname("", "val", "")) : null).toBe(
        i % 2 ? null : "1",
      );
      const book = workbook(result, c.shape),
        rels = pkg.getRels(root),
        decoyRel = rels.items.find((r) => r.id === "unusedData"),
        decoy = pkg.getPart(resolveTarget(root, decoyRel.target)),
        decoyBytes = decoy.data.slice(),
        styleRel = rels.items.find((r) => r.id === "rId1"),
        style = pkg.getPart(resolveTarget(root, styleRel.target)),
        styleBytes = style.data.slice(),
        relBytes = pkg.getRels(root);
      expect(book.contentType).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      P.setChartSpec(c, {
        ...c.spec,
        categories: ["Owned", "Fresh", "Data"],
        series: [
          { ...c.spec.series[0], name: "Edited source", values: [31, 47, -13] },
        ],
      });
      expect(
        strFromU8(
          unzipSync(workbook(result, c.shape).data)["xl/worksheets/sheet1.xml"],
        ),
      ).toContain("<v>47</v>");
      const newExternal = firstChildElement(
        parseXml(new TextDecoder().decode(pkg.getPart(root).data)).root,
        qname("c", "externalData", NS.chart),
      );
      expect(
        getAttrValue(newExternal, qname("r", "id", NS.officeDocRels)),
      ).toBe(id);
      expect(decoy.data).toEqual(decoyBytes);
      expect(style.data).toEqual(styleBytes);
      expect(pkg.getRels(root)).toEqual(relBytes);
    }
    expect(P.validatePresentation(result)).toEqual([]);
    const edited = await P.loadPresentation(await P.savePresentation(result));
    for (const c of P.getSlideCharts(P.getSlides(edited)[0]))
      expect(
        strFromU8(
          unzipSync(workbook(edited, c.shape).data)["xl/worksheets/sheet1.xml"],
        ),
      ).toContain("Edited source");
    return Buffer.from(await ui.download());
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("finite chart data and gaps survive clipboard both ways, and rejected edits leave downloaded native graphs intact", async ({
  page,
}) => {
  const { p, slide } = chartWorkbookBindingDeck(),
    values = [0, null, -0.125, 2.5],
    originals = P.getSlideCharts(slide);
  for (const chart of originals)
    P.setChartSpec(chart, {
      ...chart.spec,
      categories: ["Named"],
      series: [{ ...chart.spec.series[0], values }],
    });
  const source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const check = async (sets = 1) => {
    const bytes = await ui.download(),
      result = await P.loadPresentation(bytes),
      charts = P.getSlideCharts(P.getSlides(result)[0]),
      pkg = P._internalPackageOf(result);
    expect(charts).toHaveLength(sets * 2);
    expect(
      new Set(charts.map((c) => workbook(result, c.shape).name)).size,
    ).toBe(charts.length);
    const before = pkg.parts.map((x) => [
        x.name,
        x.contentType,
        x.data.slice(),
      ]),
      types = structuredClone(pkg.contentTypes);
    for (const [i, chart] of charts.entries()) {
      expect(chart.spec.series[0].values).toEqual(values);
      expect(chart.spec.kind).toBe(originals[i % 2].spec.kind);
      expect(workbook(result, chart.shape).data).toEqual(
        workbook(p, originals[i % 2].shape).data,
      );
      for (const value of [NaN, Infinity, -Infinity]) {
        expect(() =>
          P.setChartSpec(chart, {
            ...chart.spec,
            series: [{ ...chart.spec.series[0], values: [1, null, value] }],
          }),
        ).toThrow("series[0].values[2]: expected a finite number");
        expect(pkg.parts.map((x) => [x.name, x.contentType, x.data])).toEqual(
          before,
        );
        expect(pkg.contentTypes).toEqual(types);
      }
    }
    const q = await P.loadPresentation(await P.savePresentation(result));
    expect(
      P.getSlideCharts(P.getSlides(q)[0]).map((c) => c.spec.series[0].values),
    ).toEqual(charts.map(() => values));
    expect(P.validatePresentation(q)).toEqual([]);
    return bytes;
  };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("native c14 (office2010 variant) and legacy chart styles remain editable through clipboard both ways and reimport", async ({
  page,
}) => {
  const { p, slide } = chartStyleDeck(),
    originals = P.getSlideCharts(slide),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const identity = (s) => [s.chartStyle, s.chartStyleVariant],
    style = (p, shape) =>
      parseXml(
        new TextDecoder().decode(
          P._internalPackageOf(p).getPart(chartRoot(shape)).data,
        ),
      ).root.children.find(
        (e) =>
          e.kind === "element" &&
          ((e.name.namespaceURI === NS.mc &&
            e.name.localName === "AlternateContent") ||
            (e.name.namespaceURI === NS.chart && e.name.localName === "style")),
      ),
    canonical = (e) => [
      e.name.namespaceURI,
      e.name.localName,
      e.attrs.map((a) => [a.name.namespaceURI, a.name.localName, a.value]),
      e.children.map((c) =>
        c.kind === "element" ? canonical(c) : [c.kind, c.data],
      ),
    ];
  const originalStyles = originals.map((c) => canonical(style(p, c.shape))),
    check = async (sets = 1) => {
      const bytes = await ui.download(),
        result = await P.loadPresentation(bytes),
        charts = P.getSlideCharts(P.getSlides(result)[0]);
      expect(charts).toHaveLength(sets * 2);
      expect(
        new Set(charts.map((c) => workbook(result, c.shape).name)).size,
      ).toBe(charts.length);
      for (const [i, c] of charts.entries()) {
        expect(identity(c.spec)).toEqual(
          i % 2 ? [37, undefined] : [19, "office2010"],
        );
        expect(canonical(style(result, c.shape))).toEqual(
          originalStyles[i % 2],
        );
        const sourceBook = workbook(result, charts[0].shape).data.slice();
        P.setChartSpec(c, {
          ...c.spec,
          series: [{ ...c.spec.series[0], values: [17, 23, 31] }],
        });
        expect(canonical(style(result, c.shape))).toEqual(
          originalStyles[i % 2],
        );
        if (i)
          expect(workbook(result, charts[0].shape).data).toEqual(sourceBook);
        const changed = P.getSlideCharts(P.getSlides(result)[0])[i];
        P.setChartSpec(changed, {
          ...changed.spec,
          chartStyle: i % 2 ? 7 : 43,
        });
        expect(identity(P.getShapeChartSpec(c.shape))).toEqual(
          i % 2 ? [7, undefined] : [43, "office2010"],
        );
      }
      const reopened = await P.loadPresentation(
        await P.savePresentation(result),
      );
      expect(
        P.getSlideCharts(P.getSlides(reopened)[0]).map((c) => identity(c.spec)),
      ).toEqual(
        charts.map((_, i) => (i % 2 ? [7, undefined] : [43, "office2010"])),
      );
      expect(P.validatePresentation(reopened)).toEqual([]);
      return bytes;
    };
  await ui.load(source, 2);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check();
  await ui.copyAll();
  await ui.load(source, 2);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  const returned = await check(2);
  await ui.load(returned, 4);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("native chart text bodies retain theme and paragraph properties through clipboard both ways and edits", async ({
  page,
}) => {
  const { p, slide } = chartTextDeck("column", true),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const canonical = (e) => [
      e.name.namespaceURI,
      e.name.localName,
      e.attrs
        .map((a) => [a.name.namespaceURI, a.name.localName, a.value])
        .sort(),
      e.children.map((n) =>
        n.kind === "element" ? canonical(n) : [n.kind, n.data],
      ),
    ],
    texts = (p, shape) => {
      const result = [];
      walkElements(
        parseXml(
          new TextDecoder().decode(
            P._internalPackageOf(p).getPart(chartRoot(shape)).data,
          ),
        ).root,
        (e) => {
          if (e.name.namespaceURI === NS.chart && e.name.localName === "txPr")
            result.push(canonical(e));
        },
      );
      return result;
    },
    original = texts(p, P.getSlideCharts(slide)[0].shape);
  const check = async (count = 1) => {
    const bytes = await ui.download(),
      result = await P.loadPresentation(bytes),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(count);
    expect(
      new Set(charts.map((c) => workbook(result, c.shape).name)).size,
    ).toBe(count);
    for (const [i, chart] of charts.entries()) {
      const otherWorkbooks = charts.map((c) =>
        workbook(result, c.shape).data.slice(),
      );
      expect(texts(result, chart.shape)).toEqual(original);
      P.setChartSpec(chart, {
        ...chart.spec,
        series: chart.spec.series.map((s) => ({ ...s, values: [17, 23, 31] })),
      });
      expect(texts(result, chart.shape)).toEqual(original);
      const edited = P.getShapeChartSpec(chart.shape);
      P.setChartSpec(chart, {
        ...edited,
        categoryAxisLabelStyle: {
          ...edited.categoryAxisLabelStyle,
          italic: true,
        },
        categoryAxisLabelRotationDeg: 42.5,
      });
      expect(
        P.getShapeChartSpec(chart.shape).categoryAxisLabelStyle.italic,
      ).toBe(true);
      for (const [j, other] of charts.entries())
        if (j !== i)
          expect(workbook(result, other.shape).data).toEqual(otherWorkbooks[j]);
      const root = parseXml(
        new TextDecoder().decode(
          P._internalPackageOf(result).getPart(chartRoot(chart.shape)).data,
        ),
      ).root;
      let nativeBody = 0,
        scriptFont = 0,
        opaque = 0;
      walkElements(root, (e) => {
        if (
          e.name.namespaceURI === NS.dml &&
          e.name.localName === "bodyPr" &&
          getAttrValue(e, qname("", "wrap", "")) === "none"
        )
          nativeBody++;
        if (
          e.name.namespaceURI === NS.dml &&
          e.name.localName === "cs" &&
          getAttrValue(e, qname("", "typeface", "")) === "Arial"
        )
          scriptFont++;
        if (
          e.name.namespaceURI === "urn:owned:chart-text" &&
          e.name.localName === "payload"
        )
          opaque++;
      });
      expect(nativeBody).toBe(original.length);
      expect(scriptFont).toBe(original.length);
      expect(opaque).toBe(original.length);
    }
    const reopened = await P.loadPresentation(await P.savePresentation(result));
    expect(P.validatePresentation(reopened)).toEqual([]);
    for (const c of P.getSlideCharts(P.getSlides(reopened)[0])) {
      expect(c.spec.categoryAxisLabelStyle.italic).toBe(true);
      expect(c.spec.categoryAxisLabelRotationDeg).toBe(42.5);
    }
    return bytes;
  };
  await ui.load(source, 1);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check();
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const returned = await check(2);
  await ui.load(returned, 2);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("native chart paint and picture relationships survive clipboard both ways, data edits and reimport", async ({
  page,
}) => {
  const { p, slide } = chartOpaquePaintDeck("column", true),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const canonical = (e) => [
    e.name.namespaceURI,
    e.name.localName,
    e.attrs.map((a) => [a.name.namespaceURI, a.name.localName, a.value]).sort(),
    e.children.map((n) =>
      n.kind === "element" ? canonical(n) : [n.kind, n.data],
    ),
  ];
  const paints = (p, shape, omitChartArea = false) => {
    const out = [],
      root = parseXml(
        new TextDecoder().decode(
          P._internalPackageOf(p).getPart(chartRoot(shape)).data,
        ),
      ).root,
      chartArea = firstChildElement(root, qname("c", "spPr", NS.chart));
    walkElements(root, (e) => {
      if (
        e.name.namespaceURI === NS.chart &&
        e.name.localName === "spPr" &&
        (!omitChartArea || e !== chartArea)
      )
        out.push(canonical(e));
    });
    return out;
  };
  const originalChart = P.getSlideCharts(slide)[0],
    original = paints(p, originalChart.shape),
    originalImage = chartGraph(p, chartRoot(originalChart.shape)).find(
      (part) => part.contentType === "image/png",
    ).data;
  const check = async (count = 1) => {
    const bytes = await ui.download(),
      result = await P.loadPresentation(bytes),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(count);
    expect(
      new Set(charts.map((c) => workbook(result, c.shape).name)).size,
    ).toBe(count);
    for (const [i, chart] of charts.entries()) {
      const others = charts.map((c) => workbook(result, c.shape).data.slice());
      expect(paints(result, chart.shape)).toEqual(original);
      P.setChartSpec(chart, {
        ...chart.spec,
        series: chart.spec.series.map((s) => ({ ...s, values: [17, 23, 31] })),
      });
      expect(paints(result, chart.shape)).toEqual(original);
      expect(
        chartGraph(result, chartRoot(chart.shape)).find(
          (part) => part.contentType === "image/png",
        ).data,
      ).toEqual(originalImage);
      for (const [j, other] of charts.entries())
        if (j !== i)
          expect(workbook(result, other.shape).data).toEqual(others[j]);
      const edited = P.getShapeChartSpec(chart.shape);
      P.setChartSpec(chart, { ...edited, chartAreaFill: "#235B69" });
      expect(P.getShapeChartSpec(chart.shape).chartAreaFill).toBe("#235B69");
      // Only the requested chart-area fill changes; native lines/effects and
      // point/marker/axis/legend/plot paints remain independent of it.
      expect(paints(result, chart.shape, true)).toEqual(
        paints(p, originalChart.shape, true),
      );
    }
    const reopened = await P.loadPresentation(await P.savePresentation(result));
    expect(P.validatePresentation(reopened)).toEqual([]);
    for (const chart of P.getSlideCharts(P.getSlides(reopened)[0])) {
      expect(chart.spec.chartAreaFill).toBe("#235B69");
      expect(paints(reopened, chart.shape, true)).toEqual(
        paints(p, originalChart.shape, true),
      );
      expect(
        chartGraph(reopened, chartRoot(chart.shape)).find(
          (part) => part.contentType === "image/png",
        ).data,
      ).toEqual(originalImage);
    }
    return bytes;
  };
  await ui.load(source, 1);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check();
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const returned = await check(2);
  await ui.load(returned, 2);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("native chart and series extensions retain their namespace bindings and dependencies through clipboard both ways and data edits", async ({
  page,
}) => {
  const { p, slide } = chartExtensionDeck("column", true),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const canonical = (e) => [
    e.name.namespaceURI,
    e.name.localName,
    e.attrs.map((a) => [a.name.namespaceURI, a.name.localName, a.value]).sort(),
    e.children.map((n) =>
      n.kind === "element" ? canonical(n) : [n.kind, n.data],
    ),
  ];
  const extensions = (p, shape) => {
    const out = [];
    walkElements(
      parseXml(
        new TextDecoder().decode(
          P._internalPackageOf(p).getPart(chartRoot(shape)).data,
        ),
      ).root,
      (e) => {
        if (e.name.namespaceURI === NS.chart && e.name.localName === "extLst")
          out.push(canonical(e));
      },
    );
    return out;
  };
  const originalChart = P.getSlideCharts(slide)[0],
    original = extensions(p, originalChart.shape),
    image = chartGraph(p, chartRoot(originalChart.shape)).find(
      (part) => part.contentType === "image/png",
    ).data;
  const check = async (count = 1) => {
    const bytes = await ui.download(),
      result = await P.loadPresentation(bytes),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(count);
    expect(
      new Set(charts.map((c) => workbook(result, c.shape).name)).size,
    ).toBe(count);
    for (const [i, chart] of charts.entries()) {
      const books = charts.map((c) => workbook(result, c.shape).data.slice());
      expect(extensions(result, chart.shape)).toEqual(original);
      P.setChartSpec(chart, {
        ...chart.spec,
        series: chart.spec.series.map((s, j) => ({
          ...s,
          name: `Edited ${j + 1}`,
          values: [17, null, 31],
        })),
      });
      expect(extensions(result, chart.shape)).toEqual(original);
      expect(
        chartGraph(result, chartRoot(chart.shape)).find(
          (part) => part.contentType === "image/png",
        ).data,
      ).toEqual(image);
      for (const [j, other] of charts.entries())
        if (j !== i)
          expect(workbook(result, other.shape).data).toEqual(books[j]);
    }
    const reopened = await P.loadPresentation(await P.savePresentation(result));
    expect(P.validatePresentation(reopened)).toEqual([]);
    for (const chart of P.getSlideCharts(P.getSlides(reopened)[0])) {
      expect(extensions(reopened, chart.shape)).toEqual(original);
      expect(chart.spec.series.map((s) => s.name)).toEqual([
        "Edited 1",
        "Edited 2",
      ]);
      expect(chart.spec.series.map((s) => s.values)).toEqual([
        [17, null, 31],
        [17, null, 31],
      ]);
    }
    return bytes;
  };
  await ui.load(source, 1);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check();
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const returned = await check(2);
  await ui.load(returned, 2);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("native maximum-label settings survive clipboard both ways and copied data edits without changing the original", async ({
  page,
}) => {
  const { p } = chartMaximumLabelsDeck("column", true),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const renderedLabels = async () => {
    const image = page.locator("#slide-canvas .slide-image");
    await image.evaluate((img) => img.decode());
    const out = [];
    walkElements(
      parseXml(
        decodeURIComponent(
          (await image.getAttribute("src")).split(",").slice(1).join(","),
        ),
      ).root,
      (e) => {
        if (
          e.name.localName === "text" &&
          getAttrValue(e, qname("", "fill", "")) === "#123ABC"
        )
          out.push(
            e.children
              .filter((n) => n.kind === "text")
              .map((n) => n.data)
              .join(""),
          );
      },
    );
    return out;
  };
  const check = async (sets = 1) => {
    expect((await renderedLabels()).sort()).toEqual(
      Array.from({ length: sets }, () => ["2", "7", "40", "50", "60"])
        .flat()
        .sort(),
    );
    const bytes = await ui.download(),
      result = await P.loadPresentation(bytes),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(sets);
    for (const chart of charts)
      expect(chart.spec.showDataLabelsOverMaximum).toBe(false);
    expect(P.validatePresentation(result)).toEqual([]);
    return result;
  };
  await ui.load(source, 1);
  await check();
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check();
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const returned = await check(2),
    charts = P.getSlideCharts(P.getSlides(returned)[0]),
    original = charts[0].spec,
    book = workbook(returned, charts[0].shape).data.slice(),
    copy = charts[1];
  P.setChartSpec(copy, {
    ...copy.spec,
    showDataLabelsOverMaximum: true,
    series: copy.spec.series.map((series, i) =>
      i === 0 ? { ...series, values: [3, 7, 12] } : series,
    ),
  });
  expect(P.getShapeChartSpec(charts[0].shape)).toEqual(original);
  expect(workbook(returned, charts[0].shape).data).toEqual(book);
  await ui.load(Buffer.from(await P.savePresentation(returned)), 2);
  expect((await renderedLabels()).sort()).toEqual(
    ["2", "7", "40", "50", "60", "3", "7", "12", "40", "50", "60"].sort(),
  );
  const edited = await P.loadPresentation(await ui.download()),
    finalCharts = P.getSlideCharts(P.getSlides(edited)[0]);
  expect(
    finalCharts.map((chart) => chart.spec.showDataLabelsOverMaximum),
  ).toEqual([false, true]);
  expect(finalCharts[0].spec.series[0].values).toEqual([2, 7, 11]);
  expect(finalCharts[1].spec.series[0].values).toEqual([3, 7, 12]);
  expect(P.validatePresentation(edited)).toEqual([]);
  expect(ui.errors).toEqual([]);
});

test("native workbook tables and source ranges survive appearance edits and clipboard both ways", async ({
  page,
}) => {
  const { p, shape } = chartNativeDataDeck(),
    bytes = workbook(p, shape).data.slice(),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const check = async (count) => {
    const result = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(result)[0]);
    expect(charts).toHaveLength(count);
    expect(
      new Set(charts.map((c) => workbook(result, c.shape).name)).size,
    ).toBe(count);
    for (const chart of charts) {
      expect(workbook(result, chart.shape).data).toEqual(bytes);
      const xml = new TextDecoder().decode(
        P._internalPackageOf(result).getPart(chartRoot(chart.shape)).data,
      );
      expect(xml).toContain("Region''s data");
      expect(xml).toContain("$E$8:$E$10");
      expect(xml).toContain("choice:keep");
    }
    expect(P.validatePresentation(result)).toEqual([]);
    return result;
  };
  await ui.load(source, 1);
  await check(1);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check(1);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const returned = await check(2),
    charts = P.getSlideCharts(P.getSlides(returned)[0]),
    copy = charts[1];
  P.setChartSpec(copy, {
    ...copy.spec,
    legend: { ...copy.spec.legend, textStyle: { bold: true, fontSizePt: 18 } },
  });
  for (const chart of charts)
    expect(workbook(returned, chart.shape).data).toEqual(bytes);
  await ui.load(Buffer.from(await P.savePresentation(returned)), 2);
  const edited = await check(2),
    editedCharts = P.getSlideCharts(P.getSlides(edited)[0]);
  expect(editedCharts[0].spec.legend.textStyle?.bold).not.toBe(true);
  expect(editedCharts[1].spec.legend.textStyle.bold).toBe(true);
  const image = page.locator("#slide-canvas .slide-image");
  await image.evaluate((img) => img.decode());
  const svg = decodeURIComponent(
    (await image.getAttribute("src")).split(",").slice(1).join(","),
  );
  expect(svg).toContain('font-weight="700"');
  P.setChartSpec(editedCharts[1], {
    ...editedCharts[1].spec,
    series: editedCharts[1].spec.series.map((s, i) =>
      i ? s : { ...s, values: [13, null, 21] },
    ),
  });
  expect(workbook(edited, editedCharts[0].shape).data).toEqual(bytes);
  expect(workbook(edited, editedCharts[1].shape).data).not.toEqual(bytes);
  await ui.load(Buffer.from(await P.savePresentation(edited)), 2);
  const final = await P.loadPresentation(await ui.download());
  expect(
    P.getSlideCharts(P.getSlides(final)[0])[1].spec.series[0].values,
  ).toEqual([13, null, 21]);
  expect(P.validatePresentation(final)).toEqual([]);
  expect(ui.errors).toEqual([]);
});

test("edited native workbook data and tables survive clipboard both ways with independent later edits", async ({
  page,
}) => {
  const f = chartNativeDataDeck(),
    chart = P.getSlideCharts(f.slide)[0];
  P.setChartSpec(chart, {
    ...chart.spec,
    series: chart.spec.series.map((s, i) =>
      i ? s : { ...s, values: [23, null, 8] },
    ),
  });
  const source = Buffer.from(await P.savePresentation(f.p)),
    bytes = workbook(f.p, f.shape).data.slice(),
    original = unzipSync(bytes),
    ui = await setup(page);
  const check = async (count) => {
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts).toHaveLength(count);
    for (const c of charts) {
      expect(workbook(p, c.shape).data).toEqual(bytes);
      expect(c.spec.series[0].values).toEqual([23, null, 8]);
    }
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 1);
  await check(1);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check(1);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const p = await check(2),
    charts = P.getSlideCharts(P.getSlides(p)[0]),
    copy = charts[1];
  P.setChartSpec(copy, {
    ...copy.spec,
    date1904: true,
    categories: [...copy.spec.categories, "Eastern"],
    series: copy.spec.series.map((s, i) => ({
      ...s,
      name: i ? s.name : "Net sales",
      values: [...s.values, 47],
      ...(i ? {} : { numberFormat: "0.0%" }),
    })),
  });
  expect(workbook(p, charts[0].shape).data).toEqual(bytes);
  const zip = unzipSync(workbook(p, copy.shape).data);
  expect(Object.keys(zip)).toEqual(Object.keys(original));
  for (const name of [
    "xl/theme/theme1.xml",
    "docProps/core.xml",
    "docProps/app.xml",
    "docProps/custom.xml",
  ])
    expect(zip[name]).toEqual(original[name]);
  expect(strFromU8(zip["xl/tables/table1.xml"])).toContain('ref="D7:F11"');
  expect(strFromU8(zip["xl/tables/table1.xml"])).toContain('name="Net sales"');
  expect(strFromU8(zip["xl/styles.xml"])).toContain('formatCode="0.0%"');
  expect(strFromU8(zip["xl/workbook.xml"])).toContain('date1904="1"');
  expect(strFromU8(zip["xl/worksheets/sheet1.xml"])).toContain("<v>47</v>");
  await ui.load(Buffer.from(await P.savePresentation(p)), 2);
  const result = await P.loadPresentation(await ui.download()),
    final = P.getSlideCharts(P.getSlides(result)[0]);
  expect(workbook(result, final[0].shape).data).toEqual(bytes);
  expect(workbook(result, final[1].shape).data).toEqual(
    workbook(p, copy.shape).data,
  );
  expect(final[1].spec.series[0].values).toEqual([23, null, 8, 47]);
  expect(final[1].spec.series[0].numberFormat).toBe("0.0%");
  expect(final[1].spec.categories).toEqual([
    "North",
    "South",
    "West",
    "Eastern",
  ]);
  expect(final[1].spec.date1904).toBe(true);
  expect(P.validatePresentation(result)).toEqual([]);
  expect(ui.errors).toEqual([]);
});

test("multiline horizontal legend entries stay top aligned through clipboard both ways and independent edits", async ({
  page,
}) => {
  const names = ["Line1\nLine2\nLine3\nLine4", "Beta"],
    f = chartLegendLayoutDeck({
      kind: "column",
      sizePt: 18,
      position: "b",
      series: names.map((name) => ({
        name,
        values: [2, 4, 3, 5],
        color: "#E85239",
      })),
    }),
    source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const check = async (positions, hasTail = false) => {
    const paint = await page
      .locator("#slide-canvas .slide-image")
      .evaluate(async (img) => {
        await img.decode();
        const svg = new DOMParser().parseFromString(
            decodeURIComponent(img.src.split(",").slice(1).join(",")),
            "image/svg+xml",
          ),
          labels = [...svg.querySelectorAll("text")],
          select = (text) =>
            labels
              .filter((e) => e.textContent === text)
              .map((e) => ({
                y: +e.getAttribute("y"),
                size: +e.getAttribute("font-size"),
              }));
        return {
          first: select("Line1"),
          short: select("Beta"),
          last: select("Line4"),
          tail: select("Tail"),
        };
      });
    expect(paint.first).toHaveLength(positions.length);
    expect(paint.short).toEqual(paint.first);
    expect(paint.tail).toHaveLength(hasTail ? 1 : 0);
    for (let i = 0; i < positions.length; i++)
      expect(paint.last[i].y).toBeGreaterThan(paint.first[i].y);
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts.map((c) => c.spec.legend.position)).toEqual(positions);
    for (const [i, c] of charts.entries())
      expect(c.spec.series.map((s) => s.name)).toEqual([
        names[0],
        hasTail && i === 1 ? "Beta\nTail" : "Beta",
      ]);
    expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
      charts.length,
    );
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 1);
  await check(["b"]);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check(["b"]);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const p = await check(["b", "b"]),
    charts = P.getSlideCharts(P.getSlides(p)[0]),
    originalBook = workbook(p, charts[0].shape).data.slice(),
    c = charts[1];
  P.setChartSpec(c, {
    ...c.spec,
    legend: {
      ...c.spec.legend,
      position: "t",
      textStyle: { font: "Verdana", sizePt: 32 },
    },
    series: c.spec.series.map((s, i) => ({
      ...s,
      name: i ? "Beta\nTail" : s.name,
      values: s.values.map((v) => v + 1),
    })),
  });
  await ui.load(Buffer.from(await P.savePresentation(p)), 2);
  const q = await check(["b", "t"], true),
    result = P.getSlideCharts(P.getSlides(q)[0]);
  expect(result.map((c) => c.spec.series[0].values)).toEqual([
    [2, 4, 3, 5],
    [3, 5, 4, 6],
  ]);
  expect(workbook(q, result[0].shape).data).toEqual(originalBook);
  expect(ui.errors).toEqual([]);
});

test("native label-position constraints reject atomically after clipboard both ways while valid copied edits stay independent", async ({
  page,
}) => {
  const labels = { showValue: true, textStyle: { color: "#123ABC" } },
    f = chartLegendLayoutDeck({
      kind: "column",
      position: "b",
      sizePt: 11,
      categories: ["One", "Two", "Three"],
      series: [
        {
          name: "Columns",
          values: [1, 3, 5],
          color: "#E85239",
          dataLabels: { ...labels, position: "inBase" },
        },
        {
          name: "Line",
          values: [2, 3, 5],
          color: "#2F8541",
          chartKind: "line",
          secondaryAxis: true,
          dataLabels: { ...labels, position: "t" },
        },
        {
          name: "Area",
          values: [3, 3, 5],
          color: "#376CA8",
          chartKind: "area",
          dataLabels: labels,
        },
      ],
    }),
    source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const check = async (count, edited = false) => {
    const bytes = await ui.download(),
      p = await P.loadPresentation(bytes),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts).toHaveLength(count);
    for (const [i, c] of charts.entries()) {
      const byName = Object.fromEntries(c.spec.series.map((s) => [s.name, s]));
      expect(byName.Columns.dataLabels.position).toBe(
        edited && i === 1 ? "inEnd" : "inBase",
      );
      expect(byName.Line.dataLabels.position).toBe(
        edited && i === 1 ? "r" : "t",
      );
      expect(byName.Area.dataLabels.position).toBeUndefined();
    }
    expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
      count,
    );
    expect(P.validatePresentation(p)).toEqual([]);
    // Exercise the same validation in the actual browser bundle. Invalid copied
    // edits include data changes; every package part must survive unchanged.
    const rejected = await page.evaluate(
      async (bytes) => {
        const { P, parseDeck } = await import("/src/model.js"),
          p = await parseDeck(new Uint8Array(bytes)),
          c = P.getSlideCharts(P.getSlides(p)[0]).at(-1),
          snapshot = () =>
            JSON.stringify(
              P._internalPackageOf(p).parts.map((part) => [
                part.name,
                part.contentType,
                [...part.data],
              ]),
            ),
          before = snapshot(),
          results = [];
        for (const field of ["group", "line", "column"]) {
          const spec = {
            ...c.spec,
            ...(field === "group"
              ? { dataLabels: { showValue: true, position: "ctr" } }
              : {}),
            series: c.spec.series.map((s) => ({
              ...s,
              values: s.values.map((v) => v + 100),
              ...(s.name ===
              (field === "line" ? "Line" : field === "column" ? "Columns" : "")
                ? {
                    dataLabels: {
                      ...s.dataLabels,
                      position: field === "line" ? "outEnd" : "t",
                    },
                  }
                : {}),
            })),
          };
          let error;
          try {
            P.setChartSpec(c, spec);
          } catch (e) {
            error = e.message;
          }
          results.push({ error, unchanged: before === snapshot() });
        }
        return results;
      },
      [...bytes],
    );
    expect(rejected).toHaveLength(3);
    for (const result of rejected) {
      expect(result.error).toMatch(/dataLabels\.position/);
      expect(result.unchanged).toBe(true);
    }
    return p;
  };
  await ui.load(source, 1);
  await check(1);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check(1);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const p = await check(2),
    charts = P.getSlideCharts(P.getSlides(p)[0]),
    book = workbook(p, charts[0].shape).data.slice(),
    c = charts[1];
  P.setChartSpec(c, {
    ...c.spec,
    series: c.spec.series.map((s) => ({
      ...s,
      values: s.values.map((v) => v + 0.25),
      ...(s.name === "Line"
        ? { dataLabels: { ...s.dataLabels, position: "r" } }
        : s.name === "Columns"
          ? { dataLabels: { ...s.dataLabels, position: "inEnd" } }
          : {}),
    })),
  });
  await ui.load(Buffer.from(await P.savePresentation(p)), 2);
  const q = await check(2, true),
    result = P.getSlideCharts(P.getSlides(q)[0]);
  expect(workbook(q, result[0].shape).data).toEqual(book);
  expect(result[0].spec.series.find((s) => s.name === "Line").values).toEqual([
    2, 3, 5,
  ]);
  expect(result[1].spec.series.find((s) => s.name === "Line").values).toEqual([
    2.25, 3.25, 5.25,
  ]);
  expect(ui.errors).toEqual([]);
});

test("automatic area centers and line Right labels survive clipboard both ways and independent kind edits", async ({
  page,
}) => {
  const labelColors = ["#123ABC", "#7B1269"],
    seriesColors = ["#E85239", "#2F8541"],
    f = chartLegendLayoutDeck({
      kind: "area",
      grouping: "stacked",
      legend: undefined,
      categories: ["First", "Second", "Third"],
      valueAxis: { min: 0, max: 12 },
      dataLabels: { showValue: true, textStyle: { color: labelColors[0] } },
      series: [
        [2, 4, 3],
        [1, 2, 5],
      ].map((values, i) => ({
        name: `Band ${i + 1}`,
        values,
        color: seriesColors[i],
        ...(i
          ? {
              dataLabels: {
                showValue: true,
                textStyle: { color: labelColors[i] },
              },
            }
          : {}),
      })),
    }),
    source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const check = async (count, edited = false) => {
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts).toHaveLength(count);
    const paint = await page
      .locator("#slide-canvas .slide-image")
      .evaluate(async (img) => {
        await img.decode();
        const svg = new DOMParser().parseFromString(
            decodeURIComponent(img.src.split(",").slice(1).join(",")),
            "image/svg+xml",
          ),
          labels = (color) =>
            [...svg.querySelectorAll(`text[fill="${color}"]`)].map((e) => ({
              x: +e.getAttribute("x"),
              y: +e.getAttribute("y"),
              anchor: e.getAttribute("text-anchor"),
            }));
        return {
          plots: [...svg.querySelectorAll('rect[fill="#ECF5E9"]')].map((e) => ({
            y: +e.getAttribute("y"),
            height: +e.getAttribute("height"),
          })),
          labels: [labels("#123ABC"), labels("#7B1269")],
          markers: ["#E85239", "#2F8541"].map((color) =>
            [...svg.querySelectorAll(`circle[fill="${color}"]`)].map((e) => ({
              x: +e.getAttribute("cx"),
              y: +e.getAttribute("cy"),
            })),
          ),
        };
      });
    expect(paint.plots).toHaveLength(count);
    for (const [i, c] of charts.entries()) {
      expect(c.spec.kind).toBe(edited && i === 1 ? "line" : "area");
      expect(c.spec.dataLabels.position).toBeUndefined();
      expect(
        new TextDecoder().decode(
          P._internalPackageOf(p).getPart(chartRoot(c.shape)).data,
        ),
      ).not.toContain("dLblPos");
      for (const [s, series] of c.spec.series.entries()) {
        expect(series.dataLabels?.position).toBeUndefined();
        const labels = paint.labels[s].slice(i * 3, i * 3 + 3);
        expect(labels).toHaveLength(3);
        for (const [point, label] of labels.entries()) {
          if (c.spec.kind === "line") {
            const marker = paint.markers[s][point];
            expect(label.anchor).toBe("start");
            expect(label.x).toBeGreaterThan(marker.x);
            expect(label.y - marker.y).toBeCloseTo(3, 1);
          } else {
            const base = c.spec.series
                .slice(0, s)
                .reduce((sum, series) => sum + series.values[point], 0),
              center = base + series.values[point] / 2;
            expect(label.anchor).toBe("middle");
            expect(label.y).toBeCloseTo(
              paint.plots[i].y + (1 - center / 12) * paint.plots[i].height + 3,
              1,
            );
          }
        }
      }
    }
    expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
      count,
    );
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 1);
  await check(1);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check(1);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const p = await check(2),
    charts = P.getSlideCharts(P.getSlides(p)[0]),
    book = workbook(p, charts[0].shape).data.slice(),
    c = charts[1];
  P.setChartSpec(c, {
    ...c.spec,
    kind: "line",
    valueAxisOrientation: "maxMin",
    series: c.spec.series.map((s, i) => ({
      ...s,
      values: s.values.map((v) => v + 0.25),
      markerSymbol: "circle",
      markerFill: seriesColors[i],
    })),
  });
  await ui.load(Buffer.from(await P.savePresentation(p)), 2);
  const q = await check(2, true),
    result = P.getSlideCharts(P.getSlides(q)[0]);
  expect(result.map((c) => c.spec.series[0].values)).toEqual([
    [2, 4, 3],
    [2.25, 4.25, 3.25],
  ]);
  expect(workbook(q, result[0].shape).data).toEqual(book);
  expect(ui.errors).toEqual([]);
});

test("linear chart tick domains survive clipboard both ways and independent scale edits", async ({
  page,
}) => {
  const f = chartLegendLayoutDeck({
    kind: "bar",
    legend: undefined,
    categories: ["A", "B", "C", "D"],
    series: [{ name: "Units", values: [2, 4, 3, 5] }],
    valueAxis: { min: 1.25, max: 5.5, majorUnit: 0.5, numberFormat: "0.00" },
    valueAxisLabelStyle: { font: "Arial", sizePt: 9, color: "#17589B" },
    valueAxisMajorGridlines: true,
    valueAxisMajorGridlineColor: "#9152BD",
    categoryAxisTickLabelPos: "none",
    categoryAxisLineColor: null,
    valueAxisTickLabelPos: "low",
    categoryAxisLabelRotationDeg: 0,
    valueAxisLabelRotationDeg: 0,
  });
  const source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const check = async (count, edited = false) => {
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts).toHaveLength(count);
    const rendered = await page
      .locator("#slide-canvas .slide-image")
      .evaluate(async (img) => {
        await img.decode();
        const svg = new DOMParser().parseFromString(
          decodeURIComponent(img.src.split(",").slice(1).join(",")),
          "image/svg+xml",
        );
        return {
          labels: [...svg.querySelectorAll('text[fill="#17589B"]')].map((e) =>
            Number(e.textContent.replaceAll(",", "")),
          ),
          grids: [...svg.querySelectorAll('line[stroke="#9152BD"]')].map(
            (e) => +e.getAttribute("x1"),
          ),
          plots: [...svg.querySelectorAll('rect[fill="#ECF5E9"]')].map((e) => ({
            x: +e.getAttribute("x"),
            width: +e.getAttribute("width"),
          })),
        };
      });
    let offset = 0;
    charts.forEach((chart, i) => {
      const changed = edited && i === 1;
      const values = changed
        ? rendered.labels.slice(offset)
        : [1.25, 1.75, 2.25, 2.75, 3.25, 3.75, 4.25, 4.75, 5.25];
      const min = changed ? 0 : 1.25,
        max = changed ? 1e7 : 5.5;
      if (changed) {
        // Automatic density is a layout choice. Verify a bounded, complete
        // linear domain without freezing the current fallback's unit.
        expect(values.length).toBeGreaterThan(1);
        expect(values.length).toBeLessThan(15);
        expect(values[0]).toBe(min);
        expect(values.at(-1)).toBe(max);
        const unit = values[1] - values[0];
        expect(unit).toBeGreaterThan(0);
        values.forEach((value, j) =>
          expect((value - min) / unit).toBeCloseTo(j, 8),
        );
      }
      expect(chart.spec.valueAxis).toEqual({
        min,
        max,
        numberFormat: "0.00",
        numberFormatSourceLinked: false,
        ...(changed ? {} : { majorUnit: 0.5 }),
      });
      expect(chart.spec.series[0].values).toEqual(
        changed ? [2.5, 4.5, 3.5, 5.5] : [2, 4, 3, 5],
      );
      expect(rendered.labels.slice(offset, offset + values.length)).toEqual(
        values,
      );
      values.forEach((value, j) => {
        const plot = rendered.plots[i],
          fraction = (value - min) / (max - min);
        expect((rendered.grids[offset + j] - plot.x) / plot.width).toBeCloseTo(
          changed ? 1 - fraction : fraction,
          4,
        );
      });
      offset += values.length;
    });
    expect(rendered.labels).toHaveLength(offset);
    expect(rendered.grids).toHaveLength(offset);
    expect(
      new Set(charts.map((chart) => workbook(p, chart.shape).name)).size,
    ).toBe(count);
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 1);
  await check(1);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check(1);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const p = await check(2),
    charts = P.getSlideCharts(P.getSlides(p)[0]);
  const original = P._internalPackageOf(p)
      .getPart(chartRoot(charts[0].shape))
      .data.slice(),
    book = workbook(p, charts[0].shape).data.slice();
  P.setChartSpec(charts[1], {
    ...charts[1].spec,
    valueAxis: { min: 0, max: 1e7, numberFormat: "0.00" },
    valueAxisOrientation: "maxMin",
    series: charts[1].spec.series.map((s) => ({
      ...s,
      values: s.values.map((v) => v + 0.5),
    })),
  });
  await ui.load(Buffer.from(await P.savePresentation(p)), 2);
  const q = await check(2, true),
    untouched = P.getSlideCharts(P.getSlides(q)[0])[0];
  expect(
    P._internalPackageOf(q).getPart(chartRoot(untouched.shape)).data,
  ).toEqual(original);
  expect(workbook(q, untouched.shape).data).toEqual(book);
  expect(ui.errors).toEqual([]);
});

test("authored chart units resolve automatic bounds through clipboard both ways and data edits", async ({
  page,
}) => {
  const f = chartLegendLayoutDeck({
      kind: "bar",
      legend: undefined,
      categories: ["A", "B", "C", "D"],
      series: [
        {
          name: "Units",
          values: [82, 90, 86, 82],
          color: "#E85239",
          invertIfNegative: false,
        },
      ],
      valueAxis: { majorUnit: 2, numberFormat: "0.00" },
      valueAxisLabelStyle: { font: "Arial", sizePt: 9, color: "#17589B" },
      valueAxisMajorGridlines: true,
      valueAxisMajorGridlineColor: "#9152BD",
      categoryAxisTickLabelPos: "none",
      categoryAxisLineColor: null,
      valueAxisTickLabelPos: "low",
      categoryAxisLabelRotationDeg: 0,
      valueAxisLabelRotationDeg: 0,
    }),
    source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const check = async (count, edited = false) => {
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts).toHaveLength(count);
    const rendered = await page
      .locator("#slide-canvas .slide-image")
      .evaluate(async (img) => {
        await img.decode();
        const svg = new DOMParser().parseFromString(
            decodeURIComponent(img.src.split(",").slice(1).join(",")),
            "image/svg+xml",
          ),
          rectangles = (color) =>
            [...svg.querySelectorAll(`rect[fill="${color}"]`)].map((e) => ({
              x: +e.getAttribute("x"),
              width: +e.getAttribute("width"),
            }));
        return {
          labels: [...svg.querySelectorAll('text[fill="#17589B"]')].map((e) =>
            Number(e.textContent.replaceAll(",", "")),
          ),
          grids: [...svg.querySelectorAll('line[stroke="#9152BD"]')].map(
            (e) => +e.getAttribute("x1"),
          ),
          plots: rectangles("#ECF5E9"),
          bars: rectangles("#E85239"),
        };
      });
    let offset = 0;
    charts.forEach((chart, i) => {
      const changed = edited && i === 1,
        min = changed ? -91.2 : 78,
        max = changed ? -76.8 : 92,
        unit = changed ? 1.6 : 2,
        values = changed ? [-90, -82, -86, -90] : [82, 90, 86, 82],
        ticks = Array.from({ length: changed ? 10 : 8 }, (_, j) =>
          Number((min + j * unit).toFixed(2)),
        ),
        plot = rendered.plots[i];
      expect(chart.spec.valueAxis).toEqual({
        majorUnit: unit,
        numberFormat: "0.00",
        numberFormatSourceLinked: false,
      });
      expect(chart.spec.series[0].values).toEqual(values);
      expect(rendered.labels.slice(offset, offset + ticks.length)).toEqual(
        ticks,
      );
      ticks.forEach((value, j) => {
        const fraction = (value - min) / (max - min);
        expect((rendered.grids[offset + j] - plot.x) / plot.width).toBeCloseTo(
          changed ? 1 - fraction : fraction,
          4,
        );
      });
      values.forEach((value, j) => {
        const bar = rendered.bars[i * 4 + j],
          fraction = (changed ? max - value : value - min) / (max - min);
        expect(bar.x).toBeCloseTo(plot.x, 2);
        expect(bar.width / plot.width).toBeCloseTo(fraction, 4);
      });
      offset += ticks.length;
    });
    expect(rendered.labels).toHaveLength(offset);
    expect(rendered.grids).toHaveLength(offset);
    expect(rendered.bars).toHaveLength(count * 4);
    expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
      count,
    );
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 1);
  await check(1);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check(1);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const p = await check(2),
    charts = P.getSlideCharts(P.getSlides(p)[0]),
    raw = P._internalPackageOf(p)
      .getPart(chartRoot(charts[0].shape))
      .data.slice(),
    book = workbook(p, charts[0].shape).data.slice();
  P.setChartSpec(charts[1], {
    ...charts[1].spec,
    valueAxis: { ...charts[1].spec.valueAxis, majorUnit: 1.6 },
    valueAxisOrientation: "maxMin",
    series: [{ ...charts[1].spec.series[0], values: [-90, -82, -86, -90] }],
  });
  await ui.load(Buffer.from(await P.savePresentation(p)), 2);
  const q = await check(2, true),
    original = P.getSlideCharts(P.getSlides(q)[0])[0].shape;
  expect(P._internalPackageOf(q).getPart(chartRoot(original)).data).toEqual(
    raw,
  );
  expect(workbook(q, original).data).toEqual(book);
  expect(ui.errors).toEqual([]);
});

// Native local-PDF advance gaps for installed faces. These are independent
// regression oracles; unrotated rows retain intrinsic font space even when a
// label row is remote from its spine or both spines share the same edge.
for (const [font, sizePt, gapPt] of [
  ["Arial", 32, 27.534564447999998],
  ["Times New Roman", 24, 20.415800000000004],
  ["Verdana", 18, 16.966159999999988],
])
  test(`independent chart crossings and label modes retain both same-edge axis systems through clipboard both ways and edits (${font} ${sizePt}pt)`, async ({
    page,
  }) => {
    const settings = {
        categoryAxisTickLabelPos: "nextTo",
        valueAxisTickLabelPos: "low",
        secondaryCategoryAxisTickLabelPos: "none",
        secondaryValueAxisTickLabelPos: "high",
        categoryAxisCrosses: { at: 3 },
        valueAxisCrosses: "max",
        secondaryCategoryAxisCrosses: { at: 25 },
        secondaryValueAxisCrosses: "max",
      },
      fields = Object.keys(settings),
      f = chartLegendLayoutDeck({
        kind: "column",
        legend: undefined,
        categories: ["One", "Two", "Three"],
        valueAxis: { min: 0, max: 10, majorUnit: 2 },
        textStyle: { font, sizePt, color: "#17589B" },
        valueAxisLabelStyle: { font, sizePt, color: "#17589B" },
        valueAxisLineColor: "#3156A7",
        secondaryValueAxisLineColor: "#3156A7",
        categoryAxisLabelStyle: { font, sizePt, color: "#AC2351" },
        ...settings,
        series: [
          { name: "Primary", values: [2, 4, 3], color: "#E85239" },
          {
            name: "Secondary",
            values: [20, 50, 30],
            color: "#2F8541",
            chartKind: "line",
            secondaryAxis: true,
          },
        ],
      }),
      part = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)),
      doc = parseXml(new TextDecoder().decode(part.data));
    // Native output writes both axPos values as right for these crossings.
    // They remain independent systems despite occupying the same physical edge.
    walkElements(doc.root, (e) => {
      if (e.name.namespaceURI === NS.chart && e.name.localName === "valAx")
        firstChildElement(e, qname("c", "axPos", NS.chart)).attrs[0].value =
          "r";
    });
    part.data = new TextEncoder().encode(serializeXml(doc));
    const source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page),
      check = async (count, edited = false) => {
        const p = await P.loadPresentation(await ui.download()),
          charts = P.getSlideCharts(P.getSlides(p)[0]);
        expect(charts).toHaveLength(count);
        const paint = await page
          .locator("#slide-canvas .slide-image")
          .evaluate(async (img) => {
            await img.decode();
            const svg = new DOMParser().parseFromString(
              decodeURIComponent(img.src.split(",").slice(1).join(",")),
              "image/svg+xml",
            );
            const rectangles = (selector) =>
              [...svg.querySelectorAll(selector)].map((e) => ({
                x: +e.getAttribute("x"),
                width: +e.getAttribute("width"),
                y: +e.getAttribute("y"),
                height: +e.getAttribute("height"),
                fill: e.getAttribute("fill"),
                stroke: e.getAttribute("stroke"),
                strokeWidth: +e.getAttribute("stroke-width"),
              }));
            const labels = [
              ...svg.querySelectorAll('text[fill="#17589B"]'),
            ].map((e) => ({
              value: Number(e.textContent),
              x: +e.getAttribute("x"),
              y: +e.getAttribute("y"),
              anchor: e.getAttribute("text-anchor"),
            }));
            return {
              plots: rectangles('rect[fill="#ECF5E9"]'),
              bars: rectangles(
                'rect[fill="#E85239"], rect[fill="#FFFFFF"][stroke="#000000"]',
              ),
              labels,
              valueAxisLines: [
                ...svg.querySelectorAll('line[stroke="#3156A7"]'),
              ].map((e) => ({
                x1: +e.getAttribute("x1"),
                x2: +e.getAttribute("x2"),
                y1: +e.getAttribute("y1"),
                y2: +e.getAttribute("y2"),
              })),
            };
          });
        expect(paint.plots).toHaveLength(count);
        let barOffset = 0,
          labelOffset = 0;
        for (const [i, chart] of charts.entries()) {
          const expected =
            edited && i === 1
              ? {
                  ...settings,
                  valueAxisTickLabelPos: "none",
                  secondaryValueAxisTickLabelPos: "nextTo",
                  categoryAxisCrosses: { at: 4.5 },
                  secondaryValueAxisCrosses: { at: 2 },
                }
              : settings;
          expect(
            Object.fromEntries(fields.map((key) => [key, chart.spec[key]])),
          ).toEqual(expected);
          const primaryLabels =
              expected.valueAxisTickLabelPos === "none"
                ? []
                : [0, 2, 4, 6, 8, 10],
            secondaryLabels = [0, 10, 20, 30, 40, 50, 60],
            labels = paint.labels.slice(
              labelOffset,
              labelOffset + primaryLabels.length + secondaryLabels.length,
            ),
            labelPlot = paint.plots[i];
          expect(labels.map((e) => e.value)).toEqual([
            ...primaryLabels,
            ...secondaryLabels,
          ]);
          for (const [j, label] of labels.entries()) {
            const primary = j < primaryLabels.length,
              fraction = primary ? 0 : edited && i === 1 ? 1 / 3 : 1,
              side = primary ? -1 : edited && i === 1 ? -1 : 1;
            const anchor = labelPlot.x + fraction * labelPlot.width;
            // Keep the original independent mark-presence check. The native
            // unrotated label gap is intrinsic to the font, rather than an
            // extra four pixels beyond each visible mark tip.
            const marks = paint.valueAxisLines.filter(
              (line) =>
                line.y1 === line.y2 &&
                Math.abs(line.y1 - label.y) < 0.02 &&
                Math.min(line.x1, line.x2) <= anchor + 0.02 &&
                Math.max(line.x1, line.x2) >= anchor - 0.02,
            );
            if (!primary) expect(marks.length).toBeGreaterThan(0);
            expect(label.x).toBeCloseTo(anchor + (side * gapPt * 4) / 3, 1);
            expect(label.anchor).toBe(side < 0 ? "end" : "start");
          }
          labelOffset += labels.length;
          const baseline = expected.categoryAxisCrosses.at,
            values = chart.spec.series.find((s) => !s.secondaryAxis).values,
            plot = paint.plots[i],
            at = (value) => plot.y + (1 - value / 10) * plot.height,
            visible = values.filter((value) => value !== baseline),
            bars = paint.bars.slice(barOffset, barOffset + visible.length);
          expect(bars).toHaveLength(visible.length);
          for (const [point, value] of visible.entries()) {
            // Native default inversion follows the authored crossing, while
            // bar extents continue to use the same unclamped values.
            expect(bars[point].fill).toBe(
              value < baseline ? "#FFFFFF" : "#E85239",
            );
            if (value < baseline) {
              expect(bars[point].stroke).toBe("#000000");
              expect(bars[point].strokeWidth).toBe(1);
            }
            expect(bars[point].y).toBeCloseTo(
              Math.min(at(value), at(baseline)),
              1,
            );
            expect(bars[point].height).toBeCloseTo(
              Math.abs(at(value) - at(baseline)),
              1,
            );
          }
          barOffset += visible.length;
          expect(chart.spec.series.map((s) => !!s.secondaryAxis)).toEqual([
            false,
            true,
          ]);
          expect(chart.spec.series.map((s) => s.values)).toEqual(
            edited && i === 1
              ? [
                  [2.25, 4.25, 3.25],
                  [20.25, 50.25, 30.25],
                ]
              : [
                  [2, 4, 3],
                  [20, 50, 30],
                ],
          );
          const nodes = [],
            root = parseXml(
              new TextDecoder().decode(
                P._internalPackageOf(p).getPart(chartRoot(chart.shape)).data,
              ),
            ).root;
          walkElements(root, (e) => {
            if (
              e.name.namespaceURI === NS.chart &&
              ["catAx", "valAx"].includes(e.name.localName)
            )
              nodes.push(e);
          });
          expect(nodes).toHaveLength(4);
          const context = chartPlotContext(root),
            axes = [
              primaryChartAxis(context, ["catAx", "dateAx", "serAx"]),
              primaryChartAxis(context, ["valAx"]),
              context.axes.axisForGroups(["catAx", "dateAx", "serAx"], true),
              context.axes.axisForGroups(["valAx"], true),
            ];
          expect(
            axes.map((node) =>
              getAttrValue(
                firstChildElement(node, qname("c", "tickLblPos", NS.chart)),
                qname("", "val", ""),
              ),
            ),
          ).toEqual([
            expected.categoryAxisTickLabelPos,
            expected.valueAxisTickLabelPos,
            expected.secondaryCategoryAxisTickLabelPos,
            expected.secondaryValueAxisTickLabelPos,
          ]);
          expect(
            nodes.map(
              (e) =>
                e.children.filter(
                  (n) =>
                    n.kind === "element" &&
                    ["crosses", "crossesAt"].includes(n.name.localName),
                ).length,
            ),
          ).toEqual([1, 1, 1, 1]);
        }
        expect(paint.bars).toHaveLength(barOffset);
        expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
          count,
        );
        expect(P.validatePresentation(p)).toEqual([]);
        return p;
      };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const p = await check(2),
      charts = P.getSlideCharts(P.getSlides(p)[0]),
      originalXml = P._internalPackageOf(p)
        .getPart(chartRoot(charts[0].shape))
        .data.slice(),
      originalBook = workbook(p, charts[0].shape).data.slice();
    P.setChartSpec(charts[1], {
      ...charts[1].spec,
      valueAxisTickLabelPos: "none",
      secondaryValueAxisTickLabelPos: "nextTo",
      categoryAxisCrosses: { at: 4.5 },
      secondaryValueAxisCrosses: { at: 2 },
      series: charts[1].spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 0.25),
      })),
    });
    await ui.load(Buffer.from(await P.savePresentation(p)), 2);
    const q = await check(2, true),
      original = P.getSlideCharts(P.getSlides(q)[0])[0];
    expect(
      P._internalPackageOf(q).getPart(chartRoot(original.shape)).data,
    ).toEqual(originalXml);
    expect(workbook(q, original.shape).data).toEqual(originalBook);
    expect(ui.errors).toEqual([]);
  });

test("numeric chart crossings keep mark directions independent through clipboard both ways and copied edits", async ({
  page,
}) => {
  const systems = [
      ["column", "category"],
      ["column", "value"],
      ["bar", "category"],
      ["bar", "value"],
    ],
    colors = ["#A3472B", "#9152BD", "#31725A", "#2358A1"],
    f = chartLegendLayoutDeck({ legend: undefined });
  P.removeSlide(f.p, f.slide);
  const slide = P.addSlide(f.p, { layout: P.getSlideLayouts(f.p)[0] });
  for (const [i, [kind, target]] of systems.entries()) {
    P.addSlideChart(slide, {
      x: P.inches(0.5 + (i % 2) * 6),
      y: P.inches(0.5 + Math.floor(i / 2) * 3),
      w: P.inches(5.5),
      h: P.inches(2.7),
      spec: {
        kind,
        categories: ["First", "Second", "Third", "Fourth"],
        series: [{ name: "Units", values: [2, 4, 3, 5], color: "#E85239" }],
        valueAxis: { min: 0, max: 10, majorUnit: 2 },
        categoryAxisOrientation: target === "value" ? "maxMin" : "minMax",
        valueAxisOrientation: target === "category" ? "maxMin" : "minMax",
        categoryAxisCrosses: target === "category" ? { at: 3 } : "autoZero",
        valueAxisCrosses: target === "value" ? { at: 2 } : "autoZero",
        categoryAxisMajorTickMark: "none",
        valueAxisMajorTickMark: "none",
        categoryAxisMinorTickMark: "none",
        valueAxisMinorTickMark: "none",
        categoryAxisTickLabelPos: "none",
        valueAxisTickLabelPos: "none",
        categoryAxisLabelStyle: { font: "Arial", sizePt: 14 },
        valueAxisLabelStyle: { font: "Arial", sizePt: 14 },
        [`${target}AxisLineColor`]: colors[i],
        [`${target}AxisTickLabelPos`]: "nextTo",
        [`${target}AxisMajorTickMark`]: "out",
      },
    });
  }
  const source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const check = async (sets, edited = false) => {
    const image = page.locator("#slide-canvas .slide-image");
    const paint = await image.evaluate(async (img, colors) => {
      await img.decode();
      const root = new DOMParser().parseFromString(
        decodeURIComponent(img.src.split(",").slice(1).join(",")),
        "image/svg+xml",
      );
      return colors.map((color) =>
        [...root.querySelectorAll(`line[stroke="${color}"]`)].map((e) =>
          Object.fromEntries(
            ["x1", "x2", "y1", "y2"].map((k) => [k, +e.getAttribute(k)]),
          ),
        ),
      );
    }, colors);
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts).toHaveLength(sets * systems.length);
    for (const [i, [kind, target]] of systems.entries()) {
      const horizontal = (kind !== "bar") === (target === "category"),
        normal = horizontal ? "y" : "x",
        along = horizontal ? "x" : "y",
        size = paint[i].length / sets;
      expect(Number.isInteger(size)).toBe(true);
      for (let set = 0; set < sets; set++) {
        const lines = paint[i].slice(set * size, (set + 1) * size),
          spine = lines.find((e) => e[along + "1"] !== e[along + "2"]),
          ticks = lines.filter((e) => e !== spine),
          changed = edited && set === 1;
        expect(spine).toBeDefined();
        expect(ticks.length).toBeGreaterThan(1);
        const side = (horizontal ? 1 : -1) * (changed ? -1 : 1),
          origin = spine[normal + "1"];
        for (const tick of ticks) {
          const ends = [
            tick[normal + "1"] - origin,
            tick[normal + "2"] - origin,
          ]
            .map((v) => v * side)
            .sort((a, b) => a - b);
          expect(ends[0]).toBeCloseTo(0, 1);
          expect(ends[1]).toBeGreaterThan(1);
        }
        const c = charts[set * systems.length + i];
        expect(c.spec[`${target}AxisMajorTickMark`]).toBe(
          changed ? "in" : "out",
        );
        expect(
          c.spec[
            target === "category"
              ? "valueAxisOrientation"
              : "categoryAxisOrientation"
          ],
        ).toBe("maxMin");
        expect(c.spec.series[0].values).toEqual(
          changed ? [2.25, 4.25, 3.25, 5.25] : [2, 4, 3, 5],
        );
        const book = unzipSync(workbook(p, c.shape).data);
        expect(strFromU8(book["xl/worksheets/sheet1.xml"])).toContain(
          changed ? "<v>2.25</v>" : "<v>2</v>",
        );
      }
    }
    expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
      charts.length,
    );
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 4);
  await check(1);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  await check(1);
  await ui.copyAll();
  await ui.load(source, 4);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(8);
  const p = await check(2),
    charts = P.getSlideCharts(P.getSlides(p)[0]),
    original = charts
      .slice(0, 4)
      .map((c) =>
        P._internalPackageOf(p).getPart(chartRoot(c.shape)).data.slice(),
      );
  for (const [i, c] of charts.slice(4).entries())
    P.setChartSpec(c, {
      ...c.spec,
      [`${systems[i][1]}AxisMajorTickMark`]: "in",
      series: c.spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 0.25),
      })),
    });
  for (const [i, c] of charts.slice(0, 4).entries())
    expect(P._internalPackageOf(p).getPart(chartRoot(c.shape)).data).toEqual(
      original[i],
    );
  await ui.load(Buffer.from(await P.savePresentation(p)), 8);
  await check(2, true);
  const returned = await ui.download();
  await ui.load(returned, 8);
  await check(2, true);
  expect(ui.errors).toEqual([]);
});

test("chart paint layers survive clipboard both ways and independent data edits", async ({
  page,
}) => {
  const kinds = ["column", "bar", "line", "area"],
    C = "#A3472B",
    V = "#9152BD",
    G = "#167E9B",
    D = "#2051BB",
    O = "#23916F",
    fills = ["#E85239", "#2F8541"],
    f = chartLegendLayoutDeck({ legend: undefined });
  P.removeSlide(f.p, f.slide);
  const slide = P.addSlide(f.p, { layout: P.getSlideLayouts(f.p)[0] });
  for (const [i, kind] of kinds.entries())
    P.addSlideChart(slide, {
      x: P.inches(0.5 + (i % 2) * 6),
      y: P.inches(0.5 + Math.floor(i / 2) * 3),
      w: P.inches(5.5),
      h: P.inches(2.7),
      spec: {
        kind,
        categories: ["First", "Second", "Third", "Fourth"],
        series: [
          {
            name: "Alpha",
            values: [2, 6, 3, 5],
            color: fills[0],
            markerSymbol: "none",
          },
          {
            name: "Beta",
            values: [5, 3, 6, 2],
            color: fills[1],
            markerSymbol: "none",
          },
        ],
        valueAxis: { min: 0, max: 10, majorUnit: 2 },
        categoryAxisCrosses: { at: 4 },
        valueAxisCrosses: { at: 2.5 },
        categoryAxisOrientation: "maxMin",
        valueAxisOrientation: "maxMin",
        categoryAxisLineColor: C,
        valueAxisLineColor: V,
        categoryAxisMajorTickMark: "cross",
        valueAxisMajorTickMark: "cross",
        categoryAxisLabelStyle: { font: "Arial", sizePt: 14, color: C },
        valueAxisLabelStyle: { font: "Arial", sizePt: 14, color: V },
        valueAxisMajorGridlines: true,
        valueAxisMajorGridlineColor: G,
        plotAreaFill: "#ECF5E9",
        plotAreaStrokeColor: O,
        plotAreaStrokeWidthEmu: 38100,
        dataLabels: {
          showValue: true,
          ...(kind === "area" ? {} : { position: "ctr" }),
          textStyle: { font: "Arial", sizePt: 18, color: D },
        },
      },
    });
  const source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const check = async (sets, edited = false) => {
    const order = await page.locator("#slide-canvas .slide-image").evaluate(
      async (img, { C, V, G, D, O, fills }) => {
        await img.decode();
        const root = new DOMParser().parseFromString(
          decodeURIComponent(img.src.split(",").slice(1).join(",")),
          "image/svg+xml",
        );
        return [...root.querySelectorAll(`rect[stroke="${O}"]`)].map((rect) => {
          const elements = [...rect.parentElement.querySelectorAll("*")],
            pick = (predicate) =>
              elements.flatMap((e, i) => (predicate(e) ? [i] : []));
          return {
            background: pick(
              (e) =>
                e.localName === "rect" && e.getAttribute("fill") === "#ECF5E9",
            ),
            outline: pick((e) => e === rect),
            outlineFill: rect.getAttribute("fill"),
            outlineWidth: +rect.getAttribute("stroke-width"),
            grids: pick((e) => e.getAttribute("stroke") === G),
            axes: pick(
              (e) =>
                e.localName === "line" &&
                [C, V].includes(e.getAttribute("stroke")),
            ),
            body: pick(
              (e) =>
                e.localName !== "text" &&
                (fills.includes(e.getAttribute("fill")) ||
                  fills.includes(e.getAttribute("stroke"))),
            ),
            data: pick(
              (e) => e.localName === "text" && e.getAttribute("fill") === D,
            ),
            labels: pick(
              (e) =>
                e.localName === "text" &&
                [C, V].includes(e.getAttribute("fill")),
            ),
          };
        });
      },
      { C, V, G, D, O, fills },
    );
    expect(order).toHaveLength(sets * kinds.length);
    const before = (a, b) => {
      expect(a.length).toBeGreaterThan(0);
      expect(b.length).toBeGreaterThan(0);
      expect(Math.max(...a)).toBeLessThan(Math.min(...b));
    };
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts).toHaveLength(order.length);
    for (const [i, r] of order.entries()) {
      const kind = kinds[i % kinds.length],
        changed = edited && i >= kinds.length;
      expect(r.background).toHaveLength(changed ? 0 : 1);
      if (!changed) before(r.background, r.grids);
      before(r.grids, r.outline);
      before(r.outline, r.body);
      expect(r.outlineFill).toBe("none");
      expect(r.outlineWidth).toBe(changed ? 1 : 4);
      before(r.grids, [...r.body, ...r.axes]);
      before(
        kind === "line" ? r.axes : r.body,
        kind === "line" ? r.body : r.axes,
      );
      before([...r.body, ...r.axes], r.data);
      before(r.data, r.labels);
      expect(charts[i].spec.kind).toBe(kind);
      expect(charts[i].spec.plotAreaFill).toBe(changed ? null : "#ECF5E9");
      expect(charts[i].spec.plotAreaStrokeWidthEmu).toBe(
        changed ? 9525 : 38100,
      );
      expect(charts[i].spec.categoryAxisLabelRotationDeg ?? null).toBe(
        changed ? -30 : null,
      );
      expect(charts[i].spec.series[0].values).toEqual(
        changed ? [2.25, 6.25, 3.25, 5.25] : [2, 6, 3, 5],
      );
      expect(
        strFromU8(
          unzipSync(workbook(p, charts[i].shape).data)[
            "xl/worksheets/sheet1.xml"
          ],
        ),
      ).toContain(changed ? "<v>2.25</v>" : "<v>2</v>");
    }
    expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
      charts.length,
    );
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 4);
  await check(1);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(4);
  await check(1);
  await ui.copyAll();
  await ui.load(source, 4);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(8);
  const p = await check(2),
    charts = P.getSlideCharts(P.getSlides(p)[0]),
    originals = charts.slice(0, 4).map((c) => ({
      xml: P._internalPackageOf(p).getPart(chartRoot(c.shape)).data.slice(),
      book: workbook(p, c.shape).data.slice(),
    }));
  for (const c of charts.slice(4))
    P.setChartSpec(c, {
      ...c.spec,
      categoryAxisLabelRotationDeg: -30,
      plotAreaFill: null,
      plotAreaStrokeWidthEmu: 9525,
      series: c.spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 0.25),
      })),
    });
  for (const [i, c] of charts.slice(0, 4).entries()) {
    expect(P._internalPackageOf(p).getPart(chartRoot(c.shape)).data).toEqual(
      originals[i].xml,
    );
    expect(workbook(p, c.shape).data).toEqual(originals[i].book);
  }
  await ui.load(Buffer.from(await P.savePresentation(p)), 8);
  await check(2, true);
  await ui.load(await ui.download(), 8);
  await check(2, true);
  expect(ui.errors).toEqual([]);
});

for (const kind of ["column", "bar"])
  test(`${kind} blank and error points retain native extents through clipboard both ways and copied edits`, async ({
    page,
  }) => {
    const D = "#2051BB",
      O = "#23916F",
      colors = ["#E85239", "#2F8541"],
      values = [2, null, 0, 5, null],
      f = chartLineGapsDeck({
        kind,
        grouping: "clustered",
        dispBlanksAs: "gap",
        dispNaAsBlank: false,
        values,
        naIndices: [1],
        series: [
          { name: "Errors", values, color: colors[0], invertIfNegative: false },
        ],
        categoryAxisCrosses: { at: 3 },
        valueAxis: { min: 0, max: 8 },
        plotAreaFill: "#ECF5E9",
        plotAreaStrokeColor: O,
        dataLabels: {
          showValue: true,
          position: "ctr",
          textStyle: { color: D },
        },
      }),
      origin = P.getSlideCharts(f.slide)[0];
    P.setChartSpec(origin, {
      ...origin.spec,
      series: [
        ...origin.spec.series,
        {
          name: "Short",
          values: [1, null],
          color: colors[1],
          invertIfNegative: false,
        },
      ],
    });
    const source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page);
    const check = async (sets, edited = false) => {
      const rendered = await page
          .locator("#slide-canvas .slide-image")
          .evaluate(
            async (img, { D, O, colors }) => {
              await img.decode();
              const root = new DOMParser().parseFromString(
                decodeURIComponent(img.src.split(",").slice(1).join(",")),
                "image/svg+xml",
              );
              return [...root.querySelectorAll(`rect[stroke="${O}"]`)].map(
                (outline) => {
                  const nodes = [
                    ...outline.parentElement.querySelectorAll("*"),
                  ];
                  return {
                    bars: colors.map((c) =>
                      nodes
                        .filter(
                          (e) =>
                            e.localName === "rect" &&
                            e.getAttribute("fill") === c,
                        )
                        .map((e) => [
                          +e.getAttribute("width"),
                          +e.getAttribute("height"),
                        ]),
                    ),
                    labels: nodes
                      .filter(
                        (e) =>
                          e.localName === "text" &&
                          e.getAttribute("fill") === D,
                      )
                      .map((e) => e.textContent),
                  };
                },
              );
            },
            { D, O, colors },
          ),
        p = await P.loadPresentation(await ui.download()),
        charts = P.getSlideCharts(P.getSlides(p)[0]);
      expect(rendered).toHaveLength(sets);
      expect(charts).toHaveLength(sets);
      for (const [i, c] of charts.entries()) {
        const changed = edited && i === 1;
        expect(c.spec.kind).toBe(kind);
        expect(c.spec.grouping).toBe(changed ? "percentStacked" : "clustered");
        expect(c.spec.dispBlanksAs).toBe(changed ? "zero" : "gap");
        expect(c.spec.series.map((s) => s.values)).toEqual(
          changed
            ? [
                [2.25, null, 0.25, 5.25, null],
                [1.25, null],
              ]
            : [values, [1, null]],
        );
        expect(rendered[i].bars.map((b) => b.length)).toEqual([3, 1]);
        expect(rendered[i].bars.flat().every(([w, h]) => w > 0 && h > 0)).toBe(
          true,
        );
        expect([...rendered[i].labels].sort()).toEqual(
          (changed
            ? ["2.25", "#N/A", "0.25", "5.25", "0", "1.25", "0"]
            : ["2", "#N/A", "0", "5", "1"]
          ).sort(),
        );
        const raw = strFromU8(
            P._internalPackageOf(p).getPart(chartRoot(c.shape)).data,
          ),
          sheet = strFromU8(
            unzipSync(workbook(p, c.shape).data)["xl/worksheets/sheet1.xml"],
          );
        expect(raw).toContain("#N/A");
        let shortReference;
        walkElements(parseXml(raw).root, (e) => {
          if (e.name.namespaceURI !== NS.chart || e.name.localName !== "numRef")
            return;
          const child = (n, name) =>
              firstChildElement(n, qname("", name, NS.chart)),
            cache = child(e, "numCache");
          if (
            cache &&
            workbookAttribute(child(cache, "ptCount"), "val") === "2"
          )
            shortReference = textContent(child(e, "f"));
        });
        expect(shortReference).toMatch(/!\$([A-Z]+)\$2:\$\1\$3$/);
        const book = new NativeChartWorkbook(workbook(p, c.shape).data),
          range = book.sourceRange(shortReference),
          cell = book.cell(range.sheet, range.start);
        expect(
          textContent(firstChildElement(cell, qname("", "v", NS.sml))),
        ).toBe(changed ? "1.25" : "1");
        expect(sheet).toContain("#N/A");
        expect(sheet).toContain(changed ? "<v>2.25</v>" : "<v>2</v>");
      }
      expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
        sets,
      );
      expect(P.validatePresentation(p)).toEqual([]);
      return p;
    };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const p = await check(2),
      charts = P.getSlideCharts(P.getSlides(p)[0]),
      raw = P._internalPackageOf(p)
        .getPart(chartRoot(charts[0].shape))
        .data.slice(),
      book = workbook(p, charts[0].shape).data.slice(),
      copy = charts[1];
    P.setChartSpec(copy, {
      ...copy.spec,
      grouping: "percentStacked",
      dispBlanksAs: "zero",
      categoryAxisCrosses: { at: 0.3 },
      valueAxis: { min: 0, max: 1 },
      series: copy.spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => (v === null ? null : v + 0.25)),
      })),
    });
    await ui.load(Buffer.from(await P.savePresentation(p)), 2);
    const q = await check(2, true),
      original = P.getSlideCharts(P.getSlides(q)[0])[0];
    expect(
      P._internalPackageOf(q).getPart(chartRoot(original.shape)).data,
    ).toEqual(raw);
    expect(workbook(q, original.shape).data).toEqual(book);
  });

for (const kind of ["column", "bar"])
  test(`${kind} absent and zero-point caches remain distinct through clipboard both ways and independent edits`, async ({
    page,
  }) => {
    const f = chartCacheAvailabilityDeck({
      kind,
      legend: { position: "r", textStyle: { sizePt: 14 } },
    });
    setNativeChartCache(f, { indices: [2], cache: "literalZero" });
    const source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page),
      names = ["Alpha", "Beta", "Gamma"];
    const check = async (sets, edited = false) => {
      const rendered = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img) => {
          await img.decode();
          const root = new DOMParser().parseFromString(
            decodeURIComponent(img.src.split(",").slice(1).join(",")),
            "image/svg+xml",
          );
          return [...root.querySelectorAll('rect[stroke="#23916F"]')].map(
            (outline) => {
              const nodes = [...outline.parentElement.querySelectorAll("*")];
              return {
                names: nodes
                  .filter(
                    (e) =>
                      e.localName === "text" &&
                      ["Alpha", "Beta", "Gamma"].includes(e.textContent),
                  )
                  .map((e) => e.textContent),
                bars: nodes
                  .filter(
                    (e) =>
                      e.localName === "rect" &&
                      e.getAttribute("fill") === "#E85239" &&
                      +e.getAttribute("x") >=
                        +outline.getAttribute("x") - 0.05 &&
                      +e.getAttribute("y") >=
                        +outline.getAttribute("y") - 0.05 &&
                      +e.getAttribute("x") + +e.getAttribute("width") <=
                        +outline.getAttribute("x") +
                          +outline.getAttribute("width") +
                          0.05 &&
                      +e.getAttribute("y") + +e.getAttribute("height") <=
                        +outline.getAttribute("y") +
                          +outline.getAttribute("height") +
                          0.05,
                  )
                  .map((e) => [
                    +e.getAttribute("width"),
                    +e.getAttribute("height"),
                  ]),
                plot: [
                  +outline.getAttribute("width"),
                  +outline.getAttribute("height"),
                ],
                errors: nodes.filter(
                  (e) =>
                    e.localName === "text" &&
                    /no data|unsupported/.test(e.textContent),
                ).length,
              };
            },
          );
        });
      expect(rendered).toHaveLength(sets);
      const p = await P.loadPresentation(await ui.download()),
        charts = P.getSlideCharts(P.getSlides(p)[0]);
      expect(charts).toHaveLength(sets);
      for (const [i, c] of charts.entries()) {
        const changed = edited && i === 1;
        const order = changed ? names : ["Alpha", "Gamma"];
        expect(rendered[i].names).toEqual(
          kind === "bar" ? [...order].reverse() : order,
        );
        expect(rendered[i].bars).toHaveLength(4);
        const dimension = kind === "column" ? 0 : 1;
        for (const bar of rendered[i].bars)
          expect(bar[dimension]).toBeCloseTo(
            rendered[i].plot[dimension] / 4 / ((changed ? 3 : 2) + 1.5),
            1,
          );
        expect(rendered[i].errors).toBe(0);
        expect(c.spec.series.map((s) => s.values)).toEqual([
          [2, 4, 3, 5],
          changed ? [7, 3] : [],
          [],
        ]);
        expect(
          chartRenderingView(c.shape).seriesDisplays.map(
            (d) => !!d.missingValueCache,
          ),
        ).toEqual([false, !changed, false]);
      }
      expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
        sets,
      );
      expect(P.validatePresentation(p)).toEqual([]);
      return p;
    };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const p = await check(2),
      charts = P.getSlideCharts(P.getSlides(p)[0]),
      raw = P._internalPackageOf(p)
        .getPart(chartRoot(charts[0].shape))
        .data.slice(),
      book = workbook(p, charts[0].shape).data.slice();
    P.setChartSpec(charts[1], { ...charts[1].spec, title: "Appearance only" });
    expect(
      chartRenderingView(charts[1].shape).seriesDisplays[1].missingValueCache,
    ).toBe(true);
    expect(workbook(p, charts[1].shape).data).toEqual(book);
    P.setChartSpec(charts[1], {
      ...charts[1].spec,
      series: charts[1].spec.series.map((s, i) =>
        i === 1 ? { ...s, values: [7, 3] } : s,
      ),
    });
    expect(
      P._internalPackageOf(p).getPart(chartRoot(charts[0].shape)).data,
    ).toEqual(raw);
    expect(workbook(p, charts[0].shape).data).toEqual(book);
    await ui.load(Buffer.from(await P.savePresentation(p)), 2);
    await check(2, true);
    await ui.load(await ui.download(), 2);
    await check(2, true);
    expect(ui.errors).toEqual([]);
  });

test("multi-ring doughnut numeric legend extents survive clipboard both ways and reimport", async ({
  page,
}) => {
  const f = chartDoughnutExtentsDeck([[2], [3, 4, 5, 6, 7]]),
    source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const check = async (count) => {
    const labels = await page
      .locator("#slide-canvas .slide-image")
      .evaluate(async (img) => {
        await img.decode();
        const root = new DOMParser().parseFromString(
          decodeURIComponent(img.src.split(",").slice(1).join(",")),
          "image/svg+xml",
        );
        return [...root.querySelectorAll("text")]
          .map((e) => e.textContent)
          .filter((t) => ["A", "B", "C", ""].includes(t));
      });
    expect(labels).toEqual(
      Array.from({ length: count }, () => ["A", "B", "C", "", ""]).flat(),
    );
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts).toHaveLength(count);
    for (const c of charts) {
      expect(c.spec.kind).toBe("doughnut");
      expect(c.spec.series.map((s) => s.values)).toEqual([
        [2],
        [3, 4, 5, 6, 7],
      ]);
    }
    expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
      count,
    );
    expect(P.validatePresentation(p)).toEqual([]);
  };
  await ui.load(source, 1);
  await check(1);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check(1);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  await check(2);
  await ui.load(await ui.download(), 2);
  await check(2);
  expect(ui.errors).toEqual([]);
});

test("editable multi-ring doughnut geometry survives clipboard both ways and independent ring edits", async ({
  page,
}) => {
  const colors = ["#E85239", "#2F8541", "#376CA8", "#B6327E"],
    values = [
      [2, -3],
      [4, 1],
      [6, 4],
    ],
    f = chartLegendLayoutDeck({
      kind: "doughnut",
      holeSizePct: 30,
      firstSliceAngleDeg: 87,
      legend: undefined,
      series: values.map((v, i) => ({
        name: `Ring ${i + 1}`,
        values: v,
        color: colors[i],
        dataLabels: {
          showValue: true,
          showCategory: false,
          showSeriesName: false,
          showPercent: false,
          textStyle: { color: "#101010" },
        },
      })),
    }),
    source = Buffer.from(await P.savePresentation(f.p)),
    ui = await setup(page);
  const check = async (count, edited = false) => {
    const rendered = await page
      .locator("#slide-canvas .slide-image")
      .evaluate(async (img) => {
        await img.decode();
        const root = new DOMParser().parseFromString(
          decodeURIComponent(img.src.split(",").slice(1).join(",")),
          "image/svg+xml",
        );
        return [...root.querySelectorAll('rect[stroke="#23916F"]')].map(
          (outline) => {
            const nodes = [...outline.parentElement.querySelectorAll("*")];
            return {
              paths: nodes
                .filter(
                  (e) =>
                    e.localName === "path" &&
                    /A[\d.]/.test(e.getAttribute("d") ?? ""),
                )
                .map((e) => ({
                  color: e.getAttribute("fill"),
                  radii: [
                    ...e.getAttribute("d").matchAll(/A([\d.]+),([\d.]+)/g),
                  ].map((m) => +m[1]),
                })),
              labels: nodes
                .filter(
                  (e) =>
                    e.localName === "text" &&
                    e.getAttribute("fill") === "#101010",
                )
                .map((e) => e.textContent),
            };
          },
        );
      });
    const p = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(p)[0]);
    expect(charts).toHaveLength(count);
    expect(rendered).toHaveLength(count);
    for (const [i, c] of charts.entries()) {
      const expected =
          edited && i === 1 ? [values[0], values[1], [9, 1], [8, 2]] : values,
        n = expected.length,
        paths = rendered[i].paths.filter((path) => colors.includes(path.color)),
        outer = Math.max(...paths.flatMap((path) => path.radii));
      expect(c.spec.kind).toBe("doughnut");
      expect(c.spec.series.map((s) => s.values)).toEqual(expected);
      expect(c.spec.holeSizePct).toBe(30);
      expect(c.spec.firstSliceAngleDeg).toBe(87);
      expect(paths).toHaveLength(n * 2);
      for (let ring = 0; ring < n; ring++) {
        const slices = paths.filter((path) => path.color === colors[ring]);
        expect(slices).toHaveLength(2);
        for (const slice of slices) {
          expect(slice.radii).toHaveLength(2);
          expect(slice.radii[0] / outer).toBeCloseTo(
            0.3 + (0.7 * (ring + 1)) / n,
            4,
          );
          expect(slice.radii[1] / outer).toBeCloseTo(0.3 + (0.7 * ring) / n, 4);
        }
      }
      expect(rendered[i].labels.sort()).toEqual(
        expected.flat().map(String).sort(),
      );
      const book = new NativeChartWorkbook(workbook(p, c.shape).data),
        references = [];
      walkElements(
        parseXml(
          strFromU8(P._internalPackageOf(p).getPart(chartRoot(c.shape)).data),
        ).root,
        (node) => {
          if (
            node.name.namespaceURI !== NS.chart ||
            node.name.localName !== "val"
          )
            return;
          const reference = firstChildElement(
            node,
            qname("", "numRef", NS.chart),
          );
          references.push(
            textContent(firstChildElement(reference, qname("", "f", NS.chart))),
          );
        },
      );
      expect(references).toHaveLength(n);
      for (const [ring, row] of expected.entries()) {
        const range = book.sourceRange(references[ring]),
          cell = book.cell(range.sheet, range.start);
        expect(
          textContent(firstChildElement(cell, qname("", "v", NS.sml))),
        ).toBe(String(row[0]));
      }
    }
    expect(new Set(charts.map((c) => workbook(p, c.shape).name)).size).toBe(
      count,
    );
    expect(P.validatePresentation(p)).toEqual([]);
    return p;
  };
  await ui.load(source, 1);
  await check(1);
  await ui.copyAll();
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  await check(1);
  await ui.copyAll();
  await ui.load(source, 1);
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(2);
  const p = await check(2),
    charts = P.getSlideCharts(P.getSlides(p)[0]),
    raw = P._internalPackageOf(p)
      .getPart(chartRoot(charts[0].shape))
      .data.slice(),
    originalBook = workbook(p, charts[0].shape).data.slice();
  P.setChartSpec(charts[1], {
    ...charts[1].spec,
    series: [
      ...charts[1].spec.series.map((s, i) =>
        i === 2 ? { ...s, values: [9, 1] } : s,
      ),
      {
        ...charts[1].spec.series[0],
        name: "Added ring",
        color: colors[3],
        values: [8, 2],
      },
    ],
  });
  await ui.load(Buffer.from(await P.savePresentation(p)), 2);
  await check(2, true);
  await ui.load(await ui.download(), 2);
  const q = await check(2, true),
    original = P.getSlideCharts(P.getSlides(q)[0])[0];
  expect(
    P._internalPackageOf(q).getPart(chartRoot(original.shape)).data,
  ).toEqual(raw);
  expect(workbook(q, original.shape).data).toEqual(originalBook);
  expect(ui.errors).toEqual([]);
});

for (const [mode, options] of [
  ["transparent", { style: 2 }],
  ["dark", { style: 41 }],
  ["gradient", { style: 33, themeFill: areaGradient }],
  ["pattern", { style: 41, themeFill: areaPattern }],
  ["image", { style: 41, themeFill: areaImage }],
])
  test(`native ${mode} chart-area paint survives clipboard both ways, data edit and reimport`, async ({
    page,
  }) => {
    const f = chartAreaPaintDeck(options),
      expected = chartRenderingView(f.shape).areaPaint,
      source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page);
    const normalized = (paint) =>
      JSON.parse(
        JSON.stringify(paint, (key, value) =>
          key === "partName"
            ? undefined
            : key === "bytes"
              ? Array.from(value)
              : value,
        ),
      );
    const check = async (count) => {
      const areas = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img) => {
          await img.decode();
          const doc = new DOMParser().parseFromString(
            decodeURIComponent(img.src.split(",").slice(1).join(",")),
            "image/svg+xml",
          );
          return [...doc.querySelectorAll("rect")]
            .filter(
              (e) =>
                !e.closest("defs") &&
                +e.getAttribute("width") === 672 &&
                +e.getAttribute("height") === 384,
            )
            .map((e) => ({
              fill: e.getAttribute("fill"),
              opacity: +e.getAttribute("fill-opacity"),
            }));
        });
      expect(areas).toHaveLength(count);
      for (const area of areas) {
        if (mode === "transparent" || mode === "image")
          expect(area.fill).toBe("none");
        else if (mode === "dark") expect(area.fill).toBe("#000000");
        else expect(area.fill).toMatch(/^url\(#/);
      }
      const p = await P.loadPresentation(await ui.download()),
        charts = P.getSlideCharts(P.getSlides(p)[0]);
      expect(charts).toHaveLength(count);
      for (const c of charts) {
        expect(normalized(chartRenderingView(c.shape).areaPaint)).toEqual(
          normalized(expected),
        );
        expect(c.spec.chartAreaFill).toBeUndefined();
      }
      expect(P.validatePresentation(p)).toEqual([]);
      return p;
    };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const p = await check(2),
      slide = P.getSlides(p)[0],
      charts = P.getSlideCharts(slide);
    P.setChartSpec(charts[1], {
      ...charts[1].spec,
      series: charts[1].spec.series.map((s) => ({ ...s, values: [8, 1] })),
    });
    await ui.load(Buffer.from(await P.savePresentation(p)), 2);
    const edited = await check(2),
      data = P.getSlideCharts(P.getSlides(edited)[0]);
    expect(data[0].spec.series[0].values).toEqual([2, 4]);
    expect(data[1].spec.series[0].values).toEqual([8, 1]);
    expect(ui.errors).toEqual([]);
  });

for (const [mode, options] of [
  ["transparent", { style: 2 }],
  ["dark", { style: 41 }],
  [
    "alpha",
    {
      style: 2,
      plotFill:
        '<a:solidFill><a:srgbClr val="316A98"><a:alpha val="40000"/></a:srgbClr></a:solidFill>',
    },
  ],
  ["gradient", { style: 33, themeFill: areaGradient }],
  ["pattern", { style: 41, themeFill: areaPattern }],
  ["image", { style: 41, themeFill: areaImage }],
])
  test(`native ${mode} plot-area paint survives clipboard both ways, data edit and reimport`, async ({
    page,
  }) => {
    const f = chartAreaPaintDeck(options),
      expected = chartRenderingView(f.shape).plotAreaPaint,
      source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page);
    const normalized = (paint) =>
      JSON.parse(
        JSON.stringify(paint, (key, value) =>
          key === "partName"
            ? undefined
            : key === "bytes"
              ? Array.from(value)
              : value,
        ),
      );
    const check = async (count) => {
      const areas = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img) => {
          await img.decode();
          const doc = new DOMParser().parseFromString(
            decodeURIComponent(img.src.split(",").slice(1).join(",")),
            "image/svg+xml",
          );
          return [...doc.querySelectorAll("rect")]
            .filter(
              (e) =>
                !e.closest("defs") &&
                +e.getAttribute("width") < 672 &&
                +e.getAttribute("width") > 0 &&
                e.getAttribute("stroke") === "none",
            )
            .map((e) => ({
              fill: e.getAttribute("fill"),
              opacity: +e.getAttribute("fill-opacity"),
            }));
        });
      expect(areas).toHaveLength(mode === "transparent" ? 0 : count);
      for (const area of areas) {
        if (mode === "transparent" || mode === "image")
          expect(area.fill).toBe("none");
        else if (mode === "dark") expect(area.fill).toBe("#3F3F3F");
        else if (mode === "alpha") {
          expect(area.fill).toBe("#316A98");
          expect(area.opacity).toBe(0.4);
        } else expect(area.fill).toMatch(/^url\(#/);
      }
      const p = await P.loadPresentation(await ui.download()),
        charts = P.getSlideCharts(P.getSlides(p)[0]);
      expect(charts).toHaveLength(count);
      for (const c of charts) {
        expect(normalized(chartRenderingView(c.shape).plotAreaPaint)).toEqual(
          normalized(expected),
        );
        if (mode === "alpha") expect(c.spec.plotAreaFill).toBe("#316A98");
        else expect(c.spec.plotAreaFill).toBeUndefined();
      }
      expect(P.validatePresentation(p)).toEqual([]);
      return p;
    };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const p = await check(2),
      slide = P.getSlides(p)[0],
      charts = P.getSlideCharts(slide);
    P.setChartSpec(charts[1], {
      ...charts[1].spec,
      series: charts[1].spec.series.map((s) => ({ ...s, values: [8, 1] })),
    });
    await ui.load(Buffer.from(await P.savePresentation(p)), 2);
    const edited = await check(2),
      data = P.getSlideCharts(P.getSlides(edited)[0]);
    expect(data[0].spec.series[0].values).toEqual([2, 4]);
    expect(data[1].spec.series[0].values).toEqual([8, 1]);
    expect(ui.errors).toEqual([]);
  });

for (const [mode, area, options] of [
  ["automatic", "chart", { style: 33 }],
  ["theme", "chart", { style: 33, themeLine: chartLineTheme }],
  [
    "alpha",
    "chart",
    {
      style: 2,
      line: '<a:ln><a:solidFill><a:srgbClr val="1B7CA3"><a:alpha val="40000"/></a:srgbClr></a:solidFill></a:ln>',
    },
  ],
  [
    "zero",
    "plot",
    {
      style: 33,
      plotLine:
        '<a:ln w="0"><a:solidFill><a:srgbClr val="1B7CA3"/></a:solidFill></a:ln>',
    },
  ],
  [
    "gradient",
    "chart",
    {
      style: 33,
      line: `<a:ln w="31750">${areaGradient.replaceAll("phClr", "accent2")}</a:ln>`,
    },
  ],
  [
    "pattern",
    "plot",
    {
      style: 41,
      plotLine: `<a:ln w="57150">${areaPattern.replaceAll("phClr", "accent2")}</a:ln>`,
    },
  ],
  [
    "custom",
    "plot",
    {
      style: 2,
      plotLine:
        '<a:ln w="38100" cap="flat"><a:solidFill><a:srgbClr val="1B7CA3"/></a:solidFill><a:custDash><a:ds d="250000" sp="150000"/></a:custDash><a:bevel/></a:ln>',
    },
  ],
])
  test(`native ${mode} ${area} outline survives clipboard both ways, data edit and reimport`, async ({
    page,
  }) => {
    const f = chartAreaPaintDeck(options),
      key = area === "chart" ? "areaLine" : "plotAreaLine",
      expected = chartRenderingView(f.shape)[key],
      source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page);
    const check = async (count) => {
      const strokes = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img, area) => {
          await img.decode();
          const doc = new DOMParser().parseFromString(
            decodeURIComponent(img.src.split(",").slice(1).join(",")),
            "image/svg+xml",
          );
          return [...doc.querySelectorAll("rect")]
            .filter(
              (e) =>
                !e.closest("defs") &&
                (area === "chart"
                  ? +e.getAttribute("width") === 672
                  : +e.getAttribute("width") < 672 &&
                    e.getAttribute("fill") === "none" &&
                    e.getAttribute("stroke") !== "none"),
            )
            .map((e) =>
              Object.fromEntries(
                [
                  "stroke",
                  "stroke-width",
                  "stroke-opacity",
                  "stroke-dasharray",
                  "stroke-linecap",
                  "stroke-linejoin",
                ].map((n) => [n, e.getAttribute(n)]),
              ),
            );
        }, area);
      expect(strokes).toHaveLength(count);
      for (const stroke of strokes) {
        expect(+stroke["stroke-width"]).toBe(expected.widthEmu / 9525);
        if (expected.paint.kind === "solid") {
          expect(stroke.stroke).toBe(expected.paint.color);
          expect(
            stroke["stroke-opacity"] === null ? 1 : +stroke["stroke-opacity"],
          ).toBe(expected.paint.opacity);
        } else expect(stroke.stroke).toMatch(/^url\(#/);
        if (mode === "theme") {
          expect(stroke["stroke-dasharray"]).toBe("0 12");
          expect(stroke["stroke-linecap"]).toBe("round");
        }
        if (mode === "custom") {
          expect(stroke["stroke-dasharray"]).toBe("10 6");
          expect(stroke["stroke-linejoin"]).toBe("bevel");
        }
      }
      const p = await P.loadPresentation(await ui.download()),
        charts = P.getSlideCharts(P.getSlides(p)[0]);
      expect(charts).toHaveLength(count);
      for (const c of charts)
        expect(chartRenderingView(c.shape)[key]).toEqual(expected);
      expect(P.validatePresentation(p)).toEqual([]);
      return p;
    };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const p = await check(2),
      charts = P.getSlideCharts(P.getSlides(p)[0]),
      original = P._internalPackageOf(p)
        .getPart(chartRoot(charts[0].shape))
        .data.slice(),
      originalBook = workbook(p, charts[0].shape).data.slice();
    P.setChartSpec(charts[1], {
      ...charts[1].spec,
      series: charts[1].spec.series.map((s) => ({ ...s, values: [8, 1] })),
    });
    await ui.load(Buffer.from(await P.savePresentation(p)), 2);
    await check(2);
    await ui.load(await ui.download(), 2);
    const q = await check(2),
      data = P.getSlideCharts(P.getSlides(q)[0]);
    expect(data[0].spec.series[0].values).toEqual([2, 4]);
    expect(data[1].spec.series[0].values).toEqual([8, 1]);
    expect(
      P._internalPackageOf(q).getPart(chartRoot(data[0].shape)).data,
    ).toEqual(original);
    expect(workbook(q, data[0].shape).data).toEqual(originalBook);
    expect(ui.errors).toEqual([]);
  });

for (const [target, mode] of [
  ["category", "theme"],
  ["value", "custom"],
  ["major", "color"],
  ["category", "gradient"],
  ["value", "pattern"],
  ["major", "gradient"],
])
  test(`native ${target} ${mode} axis styling survives clipboard both ways and independent data edits`, async ({
    page,
  }) => {
    const { chartAxisLineDeck, axisLineModes, chartLineTheme } =
      await import("../tests/chart-axis-line-fixture.js");
    const f = chartAxisLineDeck({
        style: 33,
        variant: "office2010",
        ...(mode === "theme" ? { themeLine: chartLineTheme } : {}),
        ...(target === "major"
          ? { grids: { value: axisLineModes[mode] } }
          : { lines: { [target]: axisLineModes[mode] } }),
        valueAxisMajorGridlines: target === "major",
      }),
      expected = chartRenderingView(f.shape).axisLines,
      source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page);
    const check = async (count) => {
      const rendered = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img) => {
          await img.decode();
          const doc = new DOMParser().parseFromString(
            decodeURIComponent(img.src.split(",").slice(1).join(",")),
            "image/svg+xml",
          );
          return {
            lines: [...doc.querySelectorAll("line")].map((e) =>
              Object.fromEntries(
                [
                  "stroke",
                  "stroke-width",
                  "stroke-opacity",
                  "stroke-dasharray",
                  "stroke-linecap",
                ].map((n) => [n, e.getAttribute(n)]),
              ),
            ),
            gradients: [...doc.querySelectorAll("linearGradient")].map((e) => ({
              units: e.getAttribute("gradientUnits"),
              transform: e.getAttribute("gradientTransform"),
            })),
          };
        });
      const style =
          target === "major"
            ? expected.value.majorGridline
            : expected[target].line,
        paths = rendered.lines.filter((e) =>
          style.paint.kind === "solid"
            ? e.stroke === style.paint.color
            : e.stroke?.startsWith("url(#"),
        );
      expect(paths.length).toBeGreaterThan(0);
      expect(
        paths.every((e) => +e["stroke-width"] === style.widthEmu / 9525),
      ).toBe(true);
      if (mode === "theme") {
        expect(
          paths.every(
            (e) =>
              e["stroke-dasharray"] === "0 12" &&
              e["stroke-linecap"] === "round" &&
              +e["stroke-opacity"] === 0.6,
          ),
        ).toBe(true);
      }
      if (mode === "custom")
        expect(
          paths.every(
            (e) =>
              e["stroke-dasharray"] === "10 6" &&
              e["stroke-linecap"] === "square",
          ),
        ).toBe(true);
      if (mode === "gradient") {
        expect(rendered.gradients.length).toBeGreaterThan(0);
        expect(
          rendered.gradients.every(
            (e) =>
              e.units === "userSpaceOnUse" &&
              !/scale\([^)]*\b0\.00\b/.test(e.transform),
          ),
        ).toBe(true);
      }
      const p = await P.loadPresentation(await ui.download()),
        charts = P.getSlideCharts(P.getSlides(p)[0]);
      expect(charts).toHaveLength(count);
      for (const c of charts)
        expect(chartRenderingView(c.shape).axisLines).toEqual(expected);
      expect(P.validatePresentation(p)).toEqual([]);
      return p;
    };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const p = await check(2),
      charts = P.getSlideCharts(P.getSlides(p)[0]),
      original = P._internalPackageOf(p)
        .getPart(chartRoot(charts[0].shape))
        .data.slice(),
      book = workbook(p, charts[0].shape).data.slice();
    P.setChartSpec(charts[1], {
      ...charts[1].spec,
      series: charts[1].spec.series.map((s) => ({ ...s, values: [7, 5] })),
    });
    await ui.load(Buffer.from(await P.savePresentation(p)), 2);
    await check(2);
    await ui.load(await ui.download(), 2);
    const q = await check(2),
      data = P.getSlideCharts(P.getSlides(q)[0]);
    expect(data[0].spec.series[0].values).toEqual([2, 4]);
    expect(data[1].spec.series[0].values).toEqual([7, 5]);
    expect(
      P._internalPackageOf(q).getPart(chartRoot(data[0].shape)).data,
    ).toEqual(original);
    expect(workbook(q, data[0].shape).data).toEqual(book);
    expect(ui.errors).toEqual([]);
  });

for (const secondary of [false, true])
  test(`native ${secondary ? "secondary" : "primary"} minor grids and marks survive clipboard both ways and independent edits`, async ({
    page,
  }) => {
    const { chartAxisGridDeck } =
      await import("../tests/chart-axis-grid-fixture.js");
    const f = chartAxisGridDeck({
      kind: "column",
      legend: undefined,
      plotAreaFill: "#ECF5E9",
      categories: ["A", "B", "C", "D"],
      valueAxis: { min: 0, max: 5, majorUnit: 1, minorUnit: 0.2 },
      valueAxisMajorGridlines: !secondary,
      valueAxisMinorGridlines: !secondary,
      valueAxisMajorGridlineColor: "#D02040",
      valueAxisMinorGridlineColor: "#2080C0",
      valueAxisMajorTickMark: "out",
      valueAxisMinorTickMark: "out",
      categoryAxisMajorGridlines: true,
      categoryAxisMinorGridlines: true,
      categoryAxisMajorGridlineColor: "#20A040",
      categoryAxisMinorGridlineColor: "#A040C0",
      categoryAxisTickMarkSkip: 3,
      categoryAxisMajorTickMark: "out",
      categoryAxisMinorTickMark: "out",
      series: [
        { name: "Primary", values: [1, 4, 2, 3], color: "#E85239" },
        ...(secondary
          ? [
              {
                name: "Secondary",
                secondaryAxis: true,
                chartKind: "line",
                values: [10, 40, 20, 30],
                color: "#376CA8",
              },
            ]
          : []),
      ],
      axes: secondary
        ? {
            secondaryValue: {
              min: 5,
              max: 45,
              majorUnit: 10,
              minorUnit: 2,
              hidden: false,
              major:
                '<a:ln><a:solidFill><a:srgbClr val="D02040"/></a:solidFill></a:ln>',
              minor:
                '<a:ln><a:solidFill><a:srgbClr val="2080C0"/></a:solidFill></a:ln>',
              majorTickMark: "out",
              minorTickMark: "out",
            },
            secondaryCategory: { hidden: false },
          }
        : {},
    });
    const expected = chartRenderingView(f.shape).axisLines,
      source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page);
    const check = async (count) => {
      const grids = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img) => {
          await img.decode();
          const doc = new DOMParser().parseFromString(
            decodeURIComponent(img.src.split(",").slice(1).join(",")),
            "image/svg+xml",
          );
          return ["#D02040", "#2080C0", "#20A040", "#A040C0"].map(
            (color) => doc.querySelectorAll(`line[stroke="${color}"]`).length,
          );
        });
      expect(grids).toEqual(
        (secondary ? [4, 16, 1, 1] : [5, 20, 1, 1]).map((n) => n * count),
      );
      const p = await P.loadPresentation(await ui.download()),
        charts = P.getSlideCharts(P.getSlides(p)[0]);
      expect(charts).toHaveLength(count);
      charts.forEach((c) =>
        expect(chartRenderingView(c.shape).axisLines).toEqual(expected),
      );
      expect(P.validatePresentation(p)).toEqual([]);
      return p;
    };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const p = await check(2),
      charts = P.getSlideCharts(P.getSlides(p)[0]),
      original = P._internalPackageOf(p)
        .getPart(chartRoot(charts[0].shape))
        .data.slice(),
      book = workbook(p, charts[0].shape).data.slice();
    P.setChartSpec(charts[1], {
      ...charts[1].spec,
      series: charts[1].spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 0.25),
      })),
    });
    await ui.load(Buffer.from(await P.savePresentation(p)), 2);
    await check(2);
    await ui.load(await ui.download(), 2);
    const q = await check(2),
      result = P.getSlideCharts(P.getSlides(q)[0]);
    expect(result[1].spec.series[0].values).toEqual([1.25, 4.25, 2.25, 3.25]);
    expect(
      P._internalPackageOf(q).getPart(chartRoot(result[0].shape)).data,
    ).toEqual(original);
    expect(workbook(q, result[0].shape).data).toEqual(book);
    expect(ui.errors).toEqual([]);
  });

for (const mode of ["omit", "empty"])
  for (const secondary of [false, true])
    test(`native ${mode} ${secondary ? "secondary minor" : "primary major"} tick defaults survive clipboard both ways and independent edits`, async ({
      page,
    }) => {
      const { chartTickDefaultDeck, tickAxisColors } =
        await import("../tests/chart-tick-default-fixture.js");
      const role = secondary ? "secondaryValue" : "category",
        which = secondary ? "minor" : "major";
      const f = chartTickDefaultDeck({ role, which, mode }),
        expected = chartRenderingView(f.shape).axisLines,
        source = Buffer.from(await P.savePresentation(f.p)),
        ui = await setup(page);
      const check = async (count) => {
        const marks = await page.locator("#slide-canvas .slide-image").evaluate(
          async (img, { color, horizontal }) => {
            await img.decode();
            const doc = new DOMParser().parseFromString(
              decodeURIComponent(img.src.split(",").slice(1).join(",")),
              "image/svg+xml",
            );
            const lines = [
              ...doc.querySelectorAll(`line[stroke="${color}"]`),
            ].map((e) =>
              ["x1", "y1", "x2", "y2"].map((n) => +e.getAttribute(n)),
            );
            const spines = lines.filter(
              ([x1, y1, x2, y2]) =>
                Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) >= 20,
            );
            const ticks = lines.filter((e) => !spines.includes(e));
            const normal = horizontal ? 1 : 0;
            return {
              spines: spines.length,
              ticks: ticks.length,
              crossing: ticks.every((t) =>
                spines.some(
                  (s) =>
                    (t[normal] < s[normal] && t[normal + 2] > s[normal]) ||
                    (t[normal + 2] < s[normal] && t[normal] > s[normal]),
                ),
              ),
            };
          },
          { color: tickAxisColors[role], horizontal: !secondary },
        );
        expect(marks).toEqual({
          spines: count,
          ticks: (secondary ? 21 : 5) * count,
          crossing: true,
        });
        const p = await P.loadPresentation(await ui.download()),
          charts = P.getSlideCharts(P.getSlides(p)[0]);
        expect(charts).toHaveLength(count);
        charts.forEach((c) =>
          expect(chartRenderingView(c.shape).axisLines).toEqual(expected),
        );
        expect(P.validatePresentation(p)).toEqual([]);
        return p;
      };
      await ui.load(source, 1);
      await check(1);
      await ui.copyAll();
      await ui.blank();
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(1);
      await check(1);
      await ui.copyAll();
      await ui.load(source, 1);
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(2);
      const p = await check(2),
        charts = P.getSlideCharts(P.getSlides(p)[0]),
        original = P._internalPackageOf(p)
          .getPart(chartRoot(charts[0].shape))
          .data.slice(),
        book = workbook(p, charts[0].shape).data.slice();
      P.setChartSpec(charts[1], {
        ...charts[1].spec,
        series: charts[1].spec.series.map((s) => ({
          ...s,
          values: s.values.map((v) => v + 0.25),
        })),
      });
      await ui.load(Buffer.from(await P.savePresentation(p)), 2);
      await check(2);
      await ui.load(await ui.download(), 2);
      const q = await check(2),
        result = P.getSlideCharts(P.getSlides(q)[0]);
      expect(result[1].spec.series[0].values).toEqual([1.25, 4.25, 2.25, 3.25]);
      expect(
        P._internalPackageOf(q).getPart(chartRoot(result[0].shape)).data,
      ).toEqual(original);
      expect(workbook(q, result[0].shape).data).toEqual(book);
      expect(ui.errors).toEqual([]);
    });

for (const kind of ["column", "bar"])
  for (const value of [undefined, null, "0", "1000"])
    test(`native ${kind} secondary label distance ${String(value)} survives clipboard both ways and independent data edits`, async ({
      page,
    }) => {
      const { chartCategoryLabelDistanceDeck, secondaryCategoryLabelDistance } =
        await import("../tests/chart-category-label-distance-fixture.js");
      const f = chartCategoryLabelDistanceDeck(kind, value),
        expected = value === undefined ? null : { value },
        source = Buffer.from(await P.savePresentation(f.p)),
        ui = await setup(page);
      const check = async (count) => {
        const p = await P.loadPresentation(await ui.download()),
          charts = P.getSlideCharts(P.getSlides(p)[0]);
        expect(charts).toHaveLength(count);
        charts.forEach((c) =>
          expect(secondaryCategoryLabelDistance(p, c.shape)).toEqual(expected),
        );
        expect(P.validatePresentation(p)).toEqual([]);
        return p;
      };
      await ui.load(source, 1);
      await check(1);
      await ui.copyAll();
      await ui.blank();
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(1);
      await check(1);
      await ui.copyAll();
      await ui.load(source, 1);
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(2);
      const p = await check(2),
        charts = P.getSlideCharts(P.getSlides(p)[0]),
        original = P._internalPackageOf(p)
          .getPart(chartRoot(charts[0].shape))
          .data.slice(),
        book = workbook(p, charts[0].shape).data.slice();
      P.setChartSpec(charts[1], {
        ...charts[1].spec,
        categoryAxisLabelOffset: 175,
        series: charts[1].spec.series.map((s) => ({
          ...s,
          values: s.values.map((v) => v + 0.25),
        })),
      });
      await ui.load(Buffer.from(await P.savePresentation(p)), 2);
      await check(2);
      await ui.load(await ui.download(), 2);
      const q = await check(2),
        result = P.getSlideCharts(P.getSlides(q)[0]);
      expect(result.map((c) => c.spec.categoryAxisLabelOffset)).toEqual([
        75, 175,
      ]);
      expect(result[1].spec.series[0].values).toEqual([1.25, 2.25, 3.25]);
      expect(
        P._internalPackageOf(q).getPart(chartRoot(result[0].shape)).data,
      ).toEqual(original);
      expect(workbook(q, result[0].shape).data).toEqual(book);
      expect(ui.errors).toEqual([]);
    });

for (const kind of ["column", "bar"])
  for (const highCategory of [false, true])
    for (const highValue of [false, true])
      test(`native ${kind} axis edges ${highCategory}/${highValue} survive clipboard both ways and independent data edits`, async ({
        page,
      }) => {
        const { chartAxisPositionDeck, chartAxisPositions } =
          await import("../tests/chart-axis-position-fixture.js");
        const f = chartAxisPositionDeck(kind, highCategory, highValue),
          expected = chartAxisPositions(f.p, f.shape),
          source = Buffer.from(await P.savePresentation(f.p)),
          ui = await setup(page);
        const check = async (count) => {
          const p = await P.loadPresentation(await ui.download()),
            charts = P.getSlideCharts(P.getSlides(p)[0]);
          expect(charts).toHaveLength(count);
          for (const c of charts) {
            expect(chartAxisPositions(p, c.shape)).toEqual(expected);
            expect(c.spec.series.map((s) => !!s.secondaryAxis)).toEqual([
              false,
              true,
            ]);
          }
          expect(P.validatePresentation(p)).toEqual([]);
          return p;
        };
        await ui.load(source, 1);
        await check(1);
        await ui.copyAll();
        await ui.blank();
        await page.keyboard.press("Control+v");
        await expect(ui.objects).toHaveCount(1);
        await check(1);
        await ui.copyAll();
        await ui.load(source, 1);
        await page.keyboard.press("Control+v");
        await expect(ui.objects).toHaveCount(2);
        const p = await check(2),
          charts = P.getSlideCharts(P.getSlides(p)[0]),
          original = P._internalPackageOf(p)
            .getPart(chartRoot(charts[0].shape))
            .data.slice(),
          book = workbook(p, charts[0].shape).data.slice();
        P.setChartSpec(charts[1], {
          ...charts[1].spec,
          series: charts[1].spec.series.map((s, i) => ({
            ...s,
            values: s.values.map((v) => v + (i + 1) * 0.25),
          })),
        });
        await ui.load(Buffer.from(await P.savePresentation(p)), 2);
        await check(2);
        await ui.load(await ui.download(), 2);
        const q = await check(2),
          result = P.getSlideCharts(P.getSlides(q)[0]);
        expect(result[1].spec.series.map((s) => s.values)).toEqual([
          [1.25, 2.25, 3.25],
          [10.5, 20.5, 30.5],
        ]);
        expect(
          P._internalPackageOf(q).getPart(chartRoot(result[0].shape)).data,
        ).toEqual(original);
        expect(workbook(q, result[0].shape).data).toEqual(book);
        expect(ui.errors).toEqual([]);
      });

for (const kind of ["column", "bar"])
  test(`native ${kind} independent returned rails survive clipboard, font edits and reload`, async ({
    page,
  }) => {
    const { chartAxisRailDeck, railColors } =
      await import("../tests/chart-axis-rail-fixture.js");
    const f = chartAxisRailDeck(kind),
      source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page);
    const check = async (count) => {
      const rails = await page.locator("#slide-canvas .slide-image").evaluate(
        async (img, { colors, bar }) => {
          await img.decode();
          const doc = new DOMParser().parseFromString(
            decodeURIComponent(img.src.split(",").slice(1).join(",")),
            "image/svg+xml",
          );
          const normal = bar ? 0 : 1;
          return Object.fromEntries(
            Object.entries(colors).map(([role, color]) => {
              const lines = [
                ...doc.querySelectorAll(`line[stroke="${color}"]`),
              ].map((e) =>
                ["x1", "y1", "x2", "y2"].map((n) => +e.getAttribute(n)),
              );
              const spines = lines.filter(
                (l) => Math.hypot(l[2] - l[0], l[3] - l[1]) > 20,
              );
              const ticks = lines.filter((l) => !spines.includes(l));
              return [
                role,
                {
                  spines: spines.map((l) => l[normal]),
                  ticks: ticks.map((l) =>
                    bar
                      ? Math.min(l[normal], l[normal + 2])
                      : Math.max(l[normal], l[normal + 2]),
                  ),
                  labels: doc.querySelectorAll(`text[fill="${color}"]`).length,
                },
              ];
            }),
          );
        },
        { colors: railColors, bar: kind === "bar" },
      );
      const a = rails.category,
        b = rails.secondaryCategory,
        side = kind === "bar" ? -1 : 1;
      for (const r of [a, b]) {
        expect(r.spines).toHaveLength(count);
        expect(r.ticks).toHaveLength(5 * count);
        expect(r.labels).toBe(4 * count);
      }
      expect(Math.max(...b.spines) - Math.min(...a.spines)).toBeCloseTo(0, 1);
      expect(
        Math.min(...a.ticks.map((n) => n * side)) -
          Math.max(...a.spines.map((n) => n * side)),
      ).toBeGreaterThan(10);
      expect(
        Math.min(...b.ticks.map((n) => n * side)) -
          Math.max(...a.ticks.map((n) => n * side)),
      ).toBeGreaterThan(1);
      const p = await P.loadPresentation(await ui.download());
      expect(P.getSlideCharts(P.getSlides(p)[0])).toHaveLength(count);
      expect(P.validatePresentation(p)).toEqual([]);
      return p;
    };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const p = await check(2),
      charts = P.getSlideCharts(P.getSlides(p)[0]),
      original = P._internalPackageOf(p)
        .getPart(chartRoot(charts[0].shape))
        .data.slice(),
      book = workbook(p, charts[0].shape).data.slice();
    P.setChartSpec(charts[1], {
      ...charts[1].spec,
      categoryAxisLabelStyle: {
        ...charts[1].spec.categoryAxisLabelStyle,
        sizePt: 18,
      },
      series: charts[1].spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 0.5),
      })),
    });
    await ui.load(Buffer.from(await P.savePresentation(p)), 2);
    await check(2);
    await ui.load(await ui.download(), 2);
    const q = await check(2),
      result = P.getSlideCharts(P.getSlides(q)[0]);
    expect(result[1].spec.categoryAxisLabelStyle.sizePt).toBe(18);
    expect(result[1].spec.series[0].values).toEqual([20.5, 30.5, 40.5, 25.5]);
    expect(
      P._internalPackageOf(q).getPart(chartRoot(result[0].shape)).data,
    ).toEqual(original);
    expect(workbook(q, result[0].shape).data).toEqual(book);
    expect(ui.errors).toEqual([]);
  });

for (const kind of ["column", "bar"])
  test(`native ${kind} independent category caches survive clipboard, data edits and reload`, async ({
    page,
  }) => {
    const { categoryAxisDataDeck, categoryAxisColors } =
      await import("../tests/chart-category-axis-data-fixture.js");
    const f = categoryAxisDataDeck({ kind, secondaryCount: 6 }),
      source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page);
    const check = async (count) => {
      const labels = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img, colors) => {
          await img.decode();
          const doc = new DOMParser().parseFromString(
            decodeURIComponent(img.src.split(",").slice(1).join(",")),
            "image/svg+xml",
          );
          return Object.fromEntries(
            Object.entries(colors).map(([role, color]) => [
              role,
              [...doc.querySelectorAll(`text[fill="${color}"]`)]
                .map((e) => e.textContent)
                .filter(Boolean)
                .sort(),
            ]),
          );
        }, categoryAxisColors);
      for (const [role, prefix, size] of [
        ["primary", "P", 4],
        ["secondary", "S", 6],
      ]) {
        const expected = Array.from({ length: count }, () =>
          Array.from(
            { length: size },
            (_, i) => `${prefix}-${String.fromCharCode(65 + i)}`,
          ),
        )
          .flat()
          .sort();
        expect(labels[role]).toEqual(expected);
      }
      const p = await P.loadPresentation(await ui.download());
      expect(P.getSlideCharts(P.getSlides(p)[0])).toHaveLength(count);
      expect(P.validatePresentation(p)).toEqual([]);
      return p;
    };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const p = await check(2),
      charts = P.getSlideCharts(P.getSlides(p)[0]),
      original = P._internalPackageOf(p)
        .getPart(chartRoot(charts[0].shape))
        .data.slice(),
      book = workbook(p, charts[0].shape).data.slice();
    P.setChartSpec(charts[1], {
      ...charts[1].spec,
      categoryAxisLabelStyle: {
        ...charts[1].spec.categoryAxisLabelStyle,
        sizePt: 16,
      },
      series: charts[1].spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => (v === null ? null : v + 0.5)),
      })),
    });
    await ui.load(Buffer.from(await P.savePresentation(p)), 2);
    await check(2);
    await ui.load(await ui.download(), 2);
    const q = await check(2),
      result = P.getSlideCharts(P.getSlides(q)[0]);
    expect(result[1].spec.categoryAxisLabelStyle.sizePt).toBe(16);
    expect(result[1].spec.series.find((s) => s.secondaryAxis).values).toEqual([
      15.5, 20.5, 25.5, 30.5, 15.5, 20.5,
    ]);
    expect(
      P._internalPackageOf(q).getPart(chartRoot(result[0].shape)).data,
    ).toEqual(original);
    expect(workbook(q, result[0].shape).data).toEqual(book);
    expect(ui.errors).toEqual([]);
  });

for (const kind of ["column", "bar", "area"])
  test(`deleted secondary ${kind} borrows the primary plot crossing through clipboard and copy edits`, async ({
    page,
  }) => {
    const { chartFillBaselineDeck, baselineColors } =
        await import("../tests/chart-fill-baseline-fixture.js"),
      f = chartFillBaselineDeck({ kind }),
      source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page);
    const check = async (count) => {
      const geometry = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(
          async (img, { kind, colors }) => {
            await img.decode();
            const doc = new DOMParser().parseFromString(
                decodeURIComponent(img.src.split(",").slice(1).join(",")),
                "image/svg+xml",
              ),
              plot = doc.querySelector(`rect[fill="${colors.plot}"]`),
              start = Number(plot.getAttribute(kind === "bar" ? "x" : "y")),
              size = Number(
                plot.getAttribute(kind === "bar" ? "width" : "height"),
              ),
              bases = [];
            if (kind === "area") {
              for (const path of doc.querySelectorAll(
                `path[fill="${colors.target}"]`,
              )) {
                const pts = [
                  ...path.getAttribute("d").matchAll(/[-+]?\d+(?:\.\d+)?/g),
                ].map((m) => Number(m[0]));
                for (let i = 7; i < pts.length; i += 2)
                  bases.push((pts[i] - start) / size);
              }
            } else {
              for (const bar of doc.querySelectorAll(
                `rect[fill="${colors.target}"]`,
              )) {
                const edge = Number(
                    bar.getAttribute(kind === "bar" ? "x" : "y"),
                  ),
                  end =
                    edge +
                    Number(
                      bar.getAttribute(kind === "bar" ? "width" : "height"),
                    ),
                  base =
                    Math.abs(edge - start - size / 2) <
                    Math.abs(end - start - size / 2)
                      ? edge
                      : end;
                bases.push((base - start) / size);
              }
            }
            return bases;
          },
          { kind, colors: baselineColors },
        );
      expect(geometry).toHaveLength(count * 3);
      for (const base of geometry) expect(base).toBeCloseTo(0.5, 3);
      const p = await P.loadPresentation(await ui.download());
      expect(P.getSlideCharts(P.getSlides(p)[0])).toHaveLength(count);
      expect(P.validatePresentation(p)).toEqual([]);
      return p;
    };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const p = await check(2),
      charts = P.getSlideCharts(P.getSlides(p)[0]),
      raw = P._internalPackageOf(p)
        .getPart(chartRoot(charts[0].shape))
        .data.slice(),
      book = workbook(p, charts[0].shape).data.slice();
    P.setChartSpec(charts[1], {
      ...charts[1].spec,
      textStyle: { font: "Arial", sizePt: 14 },
      series: charts[1].spec.series.map((s) =>
        s.secondaryAxis ? { ...s, values: [18, 27, 39] } : s,
      ),
    });
    await ui.load(Buffer.from(await P.savePresentation(p)), 2);
    await check(2);
    await ui.load(await ui.download(), 2);
    const q = await check(2),
      result = P.getSlideCharts(P.getSlides(q)[0]);
    expect(result[1].spec.categoryAxisCrosses).toEqual({ at: 5 });
    expect(result[1].spec.secondaryCategoryAxisCrosses).toEqual({ at: 35 });
    expect(result[1].spec.textStyle.sizePt).toBe(14);
    expect(result[1].spec.series.find((s) => s.secondaryAxis).values).toEqual([
      18, 27, 39,
    ]);
    expect(
      P._internalPackageOf(q).getPart(chartRoot(result[0].shape)).data,
    ).toEqual(raw);
    expect(workbook(q, result[0].shape).data).toEqual(book);
    expect(ui.errors).toEqual([]);
  });

for (const { kind, tiled } of ["line", "area"].flatMap((kind) =>
  [false, true].map((tiled) => ({ kind, tiled })),
))
  test(`native ${tiled ? "tiled " : ""}${kind} plot guides survive clipboard both ways and copied chart edits`, async ({
    page,
  }) => {
    const f = chartPlotGuidesDeck({
        groups: [
          { kind: "column" },
          {
            kind,
            secondary: true,
            dropLines: tiled ? "gradientTile" : "gradient",
            hiLowLines: kind === "line" ? "custom" : false,
          },
          {
            kind,
            secondary: true,
            dropLines: "pattern",
            grouping: "stacked",
          },
        ],
      }),
      decorations = (p, shape) =>
        chartPlotGuideState(p, shape).map(
          ({ members, order, ...state }) => state,
        ),
      expected = decorations(f.p, f.shape),
      source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page),
      check = async (count) => {
        const strokes = await page
          .locator("#slide-canvas .slide-image")
          .evaluate(async (img) => {
            await img.decode();
            const doc = new DOMParser().parseFromString(
              decodeURIComponent(img.src.split(",").slice(1).join(",")),
              "image/svg+xml",
            );
            return [
              ...doc.querySelectorAll(
                'line[stroke^="url("], line[stroke="#1B7CA3"]',
              ),
            ].map((e) => {
              const server = doc.getElementById(
                  e.getAttribute("stroke").slice(5, -1),
                ),
                nested = server?.querySelector('rect[fill^="url("]'),
                candidate = server?.localName.endsWith("Gradient")
                  ? server
                  : nested &&
                    doc.getElementById(
                      nested.getAttribute("fill").slice(5, -1),
                    ),
                gradient = candidate?.localName.endsWith("Gradient")
                  ? candidate
                  : null;
              return {
                gradientId: gradient ? server.id : null,
                spread: gradient?.getAttribute("spreadMethod"),
                ...Object.fromEntries(
                  [
                    "stroke",
                    "stroke-width",
                    "stroke-opacity",
                    "stroke-dasharray",
                    "stroke-linecap",
                    "x1",
                    "y1",
                    "x2",
                    "y2",
                  ].map((n) => [n, e.getAttribute(n)]),
                ),
              };
            });
          });
        expect(strokes).toHaveLength(count * (kind === "line" ? 12 : 8));
        expect(strokes.filter((stroke) => stroke.gradientId)).toHaveLength(
          count * 4,
        );
        expect(
          new Set(
            strokes
              .filter((stroke) => stroke.gradientId)
              .map((stroke) => stroke.gradientId),
          ).size,
        ).toBe(count * 4);
        for (const stroke of strokes) {
          if (stroke.gradientId)
            expect(stroke.spread).toBe(tiled ? "repeat" : null);
          for (const key of ["x1", "y1", "x2", "y2"])
            expect(Number.isFinite(Number(stroke[key]))).toBe(true);
          if (stroke.stroke === "#1B7CA3") {
            expect(stroke["stroke-width"]).toBe("4");
            expect(stroke["stroke-opacity"]).toBe("0.4");
            expect(stroke["stroke-dasharray"]).toBe("10 6");
            expect(stroke["stroke-linecap"]).toBe("square");
          } else expect(stroke["stroke-width"]).toBe("8");
        }

        const p = await P.loadPresentation(await ui.download()),
          charts = P.getSlideCharts(P.getSlides(p)[0]);
        expect(charts).toHaveLength(count);
        for (const chart of charts)
          expect(decorations(p, chart.shape)).toEqual(expected);
        expect(P.validatePresentation(p)).toEqual([]);
        return p;
      };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const p = await check(2),
      charts = P.getSlideCharts(P.getSlides(p)[0]),
      original = P._internalPackageOf(p)
        .getPart(chartRoot(charts[0].shape))
        .data.slice(),
      book = workbook(p, charts[0].shape).data.slice();
    P.setChartSpec(charts[1], {
      ...charts[1].spec,
      textStyle: { font: "Arial", sizePt: 16 },
      series: charts[1].spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 1),
      })),
    });
    await ui.load(Buffer.from(await P.savePresentation(p)), 2);
    await check(2);
    await ui.load(await ui.download(), 2);
    const q = await check(2),
      result = P.getSlideCharts(P.getSlides(q)[0]);
    expect(result[1].spec.textStyle.sizePt).toBe(16);
    expect(result[1].spec.series[2].values).toEqual([9, -5, 15, 39]);
    expect(
      P._internalPackageOf(q).getPart(chartRoot(result[0].shape)).data,
    ).toEqual(original);
    expect(workbook(q, result[0].shape).data).toEqual(book);
    expect(ui.errors).toEqual([]);
  });

for (const kind of ["bar", "column"])
  for (const high of [false, true])
    test(`native ${kind} ${high ? "right" : "left"} font-derived axis gaps survive clipboard, independent edits and reload`, async ({
      page,
    }) => {
      const { chartAxisLabelGapDeck, labelGapColors } =
        await import("../tests/chart-axis-label-gap-fixture.js");
      const f = chartAxisLabelGapDeck({
          kind,
          high,
          secondary: true,
          font: "Arial",
          sizePt: 12,
          secondaryFont: "Verdana",
          secondarySizePt: 18,
          distance: 200,
          secondaryDistance: 0,
          mark: high ? "cross" : "none",
        }),
        source = Buffer.from(await P.savePresentation(f.p)),
        ui = await setup(page);
      const check = async (count, edited = false) => {
        const roles = await page
          .locator("#slide-canvas .slide-image")
          .evaluate(async (img, colors) => {
            await img.decode();
            const doc = new DOMParser().parseFromString(
              decodeURIComponent(img.src.split(",").slice(1).join(",")),
              "image/svg+xml",
            );
            return colors.map((color) => ({
              spines: [...doc.querySelectorAll(`line[stroke="${color}"]`)]
                .filter(
                  (e) =>
                    Math.abs(+e.getAttribute("y2") - +e.getAttribute("y1")) >
                    20,
                )
                .map((e) => +e.getAttribute("x1")),
              labels: [...doc.querySelectorAll(`text[fill="${color}"]`)].map(
                (e) => ({
                  x: +e.getAttribute("x"),
                  size: +e.getAttribute("font-size"),
                  anchor: e.getAttribute("text-anchor"),
                }),
              ),
            }));
          }, labelGapColors);
        for (const [i, role] of roles.entries()) {
          expect(role.spines).toHaveLength(count);
          expect(role.labels).toHaveLength(4 * count);
          for (const label of role.labels) {
            // Independent native point gaps; the fixtures use these installed
            // faces. Both independent font changes and category distance apply.
            const times = !i && edited && label.size > 20;
            const gapPt = i
              ? 16.9662
              : times
                ? 20.418566250367853
                : 10.328645000472505;
            const distancePt =
              kind === "bar"
                ? i
                  ? -5.468994140625
                  : times
                    ? 6.64453125
                    : 3.3515625
                : 0;
            const expected = ((gapPt + distancePt) * 4) / 3;
            expect(label.anchor).toBe(high ? "start" : "end");
            expect(
              Math.min(
                ...role.spines.map((x) =>
                  Math.abs((label.x - x) * (high ? 1 : -1) - expected),
                ),
              ),
            ).toBeLessThan(0.04);
          }
        }
      };
      await ui.load(source, 1);
      await check(1);
      await ui.copyAll();
      await ui.blank();
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(1);
      await check(1);
      const q = await P.loadPresentation(await ui.download()),
        chart = P.getSlideCharts(P.getSlides(q)[0])[0];
      const styleKey =
        kind === "bar" ? "categoryAxisLabelStyle" : "valueAxisLabelStyle";
      P.setChartSpec(chart, {
        ...chart.spec,
        [styleKey]: {
          ...chart.spec[styleKey],
          font: "Times New Roman",
          sizePt: 24,
        },
        series: chart.spec.series.map((s) => ({
          ...s,
          values: s.values.map((v) => v + 0.5),
        })),
      });
      await ui.load(Buffer.from(await P.savePresentation(q)), 1);
      await check(1, true);
      await ui.load(await ui.download(), 1);
      await check(1, true);
      await ui.copyAll();
      await ui.load(source, 1);
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(2);
      await check(2, true);
      const returned = await P.loadPresentation(await ui.download()),
        charts = P.getSlideCharts(P.getSlides(returned)[0]);
      expect(charts).toHaveLength(2);
      expect(charts[0].spec.series[0].values).toEqual([2, 4, 3, 5]);
      expect(charts[1].spec.series[0].values).toEqual([2.5, 4.5, 3.5, 5.5]);
      expect(charts[1].spec[styleKey]).toMatchObject({
        font: "Times New Roman",
        sizePt: 24,
      });
      expect(
        P._internalPackageOf(returned).getPart(chartRoot(charts[0].shape)).data,
      ).toEqual(f.part.data);
      expect(workbook(returned, charts[0].shape).data).toEqual(
        workbook(f.p, f.shape).data,
      );
      expect(P.validatePresentation(returned)).toEqual([]);
      expect(ui.errors).toEqual([]);
    });

for (const kind of ["bar", "column", "line", "area"])
  test(`native ${kind} minimum plot insets survive clipboard, font and data edits`, async ({
    page,
  }) => {
    const f = chartLegendLayoutDeck({
        kind,
        legend: undefined,
        chartAreaFill: "#F4F0E8",
        chartAreaStrokeColor: null,
        categoryAxisTickLabelPos: "none",
        valueAxisTickLabelPos: "none",
        categoryAxisMajorTickMark: "none",
        categoryAxisMinorTickMark: "none",
        valueAxisMajorTickMark: "none",
        valueAxisMinorTickMark: "none",
      }),
      source = Buffer.from(await P.savePresentation(f.p)),
      originalPart = P._internalPackageOf(f.p)
        .getPart(chartRoot(f.shape))
        .data.slice(),
      originalBook = workbook(f.p, f.shape).data.slice(),
      ui = await setup(page);
    const check = async (count) => {
      const insets = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img) => {
          await img.decode();
          const doc = new DOMParser().parseFromString(
              decodeURIComponent(img.src.split(",").slice(1).join(",")),
              "image/svg+xml",
            ),
            boxes = (color) =>
              [...doc.querySelectorAll(`rect[fill="${color}"]`)].map((e) =>
                Object.fromEntries(
                  ["x", "y", "width", "height"].map((k) => [
                    k,
                    +e.getAttribute(k),
                  ]),
                ),
              ),
            charts = boxes("#F4F0E8"),
            plots = boxes("#ECF5E9");
          return plots.map((p, i) => {
            const c = charts[i];
            return [
              p.x - c.x,
              p.y - c.y,
              c.x + c.width - p.x - p.width,
              c.y + c.height - p.y - p.height,
            ];
          });
        });
      expect(insets).toHaveLength(count);
      for (const box of insets)
        for (const inset of box)
          expect(Math.abs(inset * 0.75 - 11)).toBeLessThan(0.01);
    };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    const q = await P.loadPresentation(await ui.download()),
      chart = P.getSlideCharts(P.getSlides(q)[0])[0];
    P.setChartSpec(chart, {
      ...chart.spec,
      textStyle: { font: "Times New Roman", sizePt: 24 },
      series: chart.spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 1),
      })),
    });
    await ui.load(Buffer.from(await P.savePresentation(q)), 1);
    await check(1);
    await ui.load(await ui.download(), 1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    await check(2);
    const returned = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(returned)[0]);
    expect(charts[1].spec.textStyle).toMatchObject({
      font: "Times New Roman",
      sizePt: 24,
    });
    expect(charts[1].spec.series[0].values).toEqual([3, 5, 4, 6]);
    expect(
      P._internalPackageOf(returned).getPart(chartRoot(charts[0].shape)).data,
    ).toEqual(originalPart);
    expect(workbook(returned, charts[0].shape).data).toEqual(originalBook);
    expect(P.validatePresentation(returned)).toEqual([]);
    expect(ui.errors).toEqual([]);
  });

for (const kind of ["bar", "column", "line", "area"])
  test(`native ${kind} horizontal font rows survive clipboard, axis-font and data edits`, async ({
    page,
  }) => {
    const high = kind === "column" || kind === "area",
      bar = kind === "bar";
    const f = chartLegendLayoutDeck({
        kind,
        legend: undefined,
        title: undefined,
        chartAreaFill: "#F4F0E8",
        chartAreaStrokeColor: null,
        plotAreaFill: "#ECF5E9",
        categoryAxisHidden: bar,
        valueAxisHidden: !bar,
        categoryAxisCrosses: high ? "max" : "min",
        valueAxisCrosses: high ? "max" : "min",
        categoryAxisTickLabelPos: high ? "high" : "low",
        valueAxisTickLabelPos: high ? "high" : "low",
        categoryAxisLabelRotationDeg: 0,
        valueAxisLabelRotationDeg: 0,
        categoryAxisLabelStyle: { font: "Arial", sizePt: 12 },
        valueAxisLabelStyle: { font: "Arial", sizePt: 12 },
        categoryAxisMajorTickMark: "none",
        valueAxisMajorTickMark: "none",
        categoryAxisMinorTickMark: "none",
        valueAxisMinorTickMark: "none",
      }),
      source = Buffer.from(await P.savePresentation(f.p)),
      originalPart = P._internalPackageOf(f.p)
        .getPart(chartRoot(f.shape))
        .data.slice(),
      originalBook = workbook(f.p, f.shape).data.slice(),
      ui = await setup(page);
    const check = async (expected) => {
      const insets = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img, high) => {
          await img.decode();
          const doc = new DOMParser().parseFromString(
              decodeURIComponent(img.src.split(",").slice(1).join(",")),
              "image/svg+xml",
            ),
            boxes = (color) =>
              [...doc.querySelectorAll(`rect[fill="${color}"]`)].map((e) =>
                Object.fromEntries(
                  ["x", "y", "width", "height"].map((k) => [
                    k,
                    +e.getAttribute(k),
                  ]),
                ),
              ),
            charts = boxes("#F4F0E8");
          return boxes("#ECF5E9").map((p, i) =>
            high
              ? p.y - charts[i].y
              : charts[i].y + charts[i].height - p.y - p.height,
          );
        }, high);
      expect(insets).toHaveLength(expected.length);
      for (const [i, inset] of insets.entries())
        expect(Math.abs(inset * 0.75 - expected[i])).toBeLessThan(0.04);
    };
    await ui.load(source, 1);
    await check([27.1534]);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check([27.1534]);
    const q = await P.loadPresentation(await ui.download()),
      chart = P.getSlideCharts(P.getSlides(q)[0])[0];
    P.setChartSpec(chart, {
      ...chart.spec,
      categoryAxisLabelStyle: { font: "Times New Roman", sizePt: 24 },
      valueAxisLabelStyle: { font: "Times New Roman", sizePt: 24 },
      series: chart.spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 1),
      })),
    });
    await ui.load(Buffer.from(await P.savePresentation(q)), 1);
    await check([47.3317]);
    await ui.load(await ui.download(), 1);
    await check([47.3317]);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    await check([27.1534, 47.3317]);
    const returned = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(returned)[0]);
    expect(charts[1].spec.categoryAxisLabelStyle).toMatchObject({
      font: "Times New Roman",
      sizePt: 24,
    });
    expect(charts[1].spec.series[0].values).toEqual(
      P.getShapeChartSpec(f.shape).series[0].values.map((v) => v + 1),
    );
    expect(
      P._internalPackageOf(returned).getPart(chartRoot(charts[0].shape)).data,
    ).toEqual(originalPart);
    expect(workbook(returned, charts[0].shape).data).toEqual(originalBook);
    expect(P.validatePresentation(returned)).toEqual([]);
    expect(ui.errors).toEqual([]);
  });

for (const kind of ["bar", "column", "line", "area"])
  test(`native ${kind} vertical font rows survive clipboard, axis-font and data edits`, async ({
    page,
  }) => {
    const high = kind === "column" || kind === "area",
      bar = kind === "bar";
    const f = chartLegendLayoutDeck({
        kind,
        categories: ["A", "B", "C", "D"],
        valueAxis: { min: 0, max: 6, majorUnit: 2 },
        textStyle: { font: "Arial", sizePt: 32 },
        legend: undefined,
        title: undefined,
        chartAreaFill: "#F4F0E8",
        chartAreaStrokeColor: null,
        plotAreaFill: "#ECF5E9",
        categoryAxisHidden: !bar,
        valueAxisHidden: bar,
        categoryAxisCrosses: high ? "max" : "min",
        valueAxisCrosses: high ? "max" : "min",
        categoryAxisTickLabelPos: high ? "high" : "low",
        valueAxisTickLabelPos: high ? "high" : "low",
        categoryAxisLabelRotationDeg: 0,
        valueAxisLabelRotationDeg: 0,
        categoryAxisLabelStyle: { font: "Georgia", sizePt: 9 },
        valueAxisLabelStyle: { font: "Georgia", sizePt: 9 },
        categoryAxisMajorTickMark: "none",
        valueAxisMajorTickMark: "none",
        categoryAxisMinorTickMark: "none",
        valueAxisMinorTickMark: "none",
      }),
      source = Buffer.from(await P.savePresentation(f.p)),
      originalPart = P._internalPackageOf(f.p)
        .getPart(chartRoot(f.shape))
        .data.slice(),
      originalBook = workbook(f.p, f.shape).data.slice(),
      ui = await setup(page);
    const check = async (expected) => {
      const insets = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img, high) => {
          await img.decode();
          const doc = new DOMParser().parseFromString(
              decodeURIComponent(img.src.split(",").slice(1).join(",")),
              "image/svg+xml",
            ),
            boxes = (color) =>
              [...doc.querySelectorAll(`rect[fill="${color}"]`)].map((e) =>
                Object.fromEntries(
                  ["x", "y", "width", "height"].map((k) => [
                    k,
                    +e.getAttribute(k),
                  ]),
                ),
              ),
            charts = boxes("#F4F0E8");
          return boxes("#ECF5E9").map((p, i) =>
            high
              ? charts[i].x + charts[i].width - p.x - p.width
              : p.x - charts[i].x,
          );
        }, high);
      expect(insets).toHaveLength(expected.length);
      for (const [i, inset] of insets.entries())
        expect(Math.abs(inset * 0.75 - expected[i])).toBeLessThan(0.04);
    };
    await ui.load(source, 1);
    await check([bar ? 21.10669 : 19.89173]);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check([bar ? 21.10669 : 19.89173]);
    const q = await P.loadPresentation(await ui.download()),
      chart = P.getSlideCharts(P.getSlides(q)[0])[0];
    P.setChartSpec(chart, {
      ...chart.spec,
      categoryAxisLabelStyle: { font: "Trebuchet MS", sizePt: 24 },
      valueAxisLabelStyle: { font: "Trebuchet MS", sizePt: 24 },
      series: chart.spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 1),
      })),
    });
    await ui.load(Buffer.from(await P.savePresentation(q)), 1);
    await check([bar ? 42.66417 : 40.52921]);
    await ui.load(await ui.download(), 1);
    await check([bar ? 42.66417 : 40.52921]);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    await check(bar ? [21.10669, 42.66417] : [19.89173, 40.52921]);
    const returned = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(returned)[0]);
    expect(charts[1].spec.categoryAxisLabelStyle).toMatchObject({
      font: "Trebuchet MS",
      sizePt: 24,
    });
    expect(charts[1].spec.series[0].values).toEqual(
      P.getShapeChartSpec(f.shape).series[0].values.map((v) => v + 1),
    );
    expect(
      P._internalPackageOf(returned).getPart(chartRoot(charts[0].shape)).data,
    ).toEqual(originalPart);
    expect(workbook(returned, charts[0].shape).data).toEqual(originalBook);
    expect(P.validatePresentation(returned)).toEqual([]);
    expect(ui.errors).toEqual([]);
  });

for (const position of ["r", "b"])
  test(`native ${position} legend line allocation survives clipboard, font and data edits`, async ({
    page,
  }) => {
    const f = chartLegendLayoutDeck({
      kind: "column",
      sizePt: 9,
      legend: {
        position,
        textStyle: { font: "Arial", sizePt: 14.5 },
        fill: "#FFF0D1",
        strokeColor: "#845B20",
      },
      series: ["Line1\nLine2\nLine3", "Beta"].map((name, i) => ({
        name,
        values: [1 + i, 2, 4, 3],
        color: ["#E85239", "#2F8541"][i],
      })),
    });
    P.setShapeSize(f.shape, P.inches(9), P.inches(6));
    const source = Buffer.from(await P.savePresentation(f.p)),
      raw = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data.slice(),
      book = workbook(f.p, f.shape).data.slice(),
      ui = await setup(page);
    const initial = position === "r" ? 144.3036 : 72.151707,
      editedHeight = position === "r" ? 245.4815 : 122.7407;
    const check = async (expected) => {
      const heights = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img) => {
          await img.decode();
          const doc = new DOMParser().parseFromString(
            decodeURIComponent(img.src.split(",").slice(1).join(",")),
            "image/svg+xml",
          );
          return [...doc.querySelectorAll('rect[fill="#FFF0D1"]')].map(
            (e) => +e.getAttribute("height") - 0.6,
          );
        });
      expect(heights).toHaveLength(expected.length);
      for (const [i, h] of heights.entries())
        expect(Math.abs(h - expected[i])).toBeLessThan(0.09);
    };
    await ui.load(source, 1);
    await check([initial]);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check([initial]);
    const q = await P.loadPresentation(await ui.download()),
      c = P.getSlideCharts(P.getSlides(q)[0])[0];
    P.setChartSpec(c, {
      ...c.spec,
      legend: {
        ...c.spec.legend,
        textStyle: { font: "Georgia", sizePt: 25.5 },
      },
      series: c.spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 1),
      })),
    });
    await ui.load(Buffer.from(await P.savePresentation(q)), 1);
    await check([editedHeight]);
    await ui.load(await ui.download(), 1);
    await check([editedHeight]);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    await check([initial, editedHeight]);
    const returned = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(returned)[0]);
    expect(charts[1].spec.legend.textStyle).toMatchObject({
      font: "Georgia",
      sizePt: 25.5,
    });
    expect(charts[1].spec.series[0].values).toEqual([2, 3, 5, 4]);
    expect(
      P._internalPackageOf(returned).getPart(chartRoot(charts[0].shape)).data,
    ).toEqual(raw);
    expect(workbook(returned, charts[0].shape).data).toEqual(book);
    expect(P.validatePresentation(returned)).toEqual([]);
    expect(ui.errors).toEqual([]);
  });

for (const kind of ["bar", "column"])
  test(`${kind} combined rows fit before inclination through clipboard and edits`, async ({
    page,
  }) => {
    const bar = kind === "bar",
      f = chartLegendLayoutDeck({
        kind,
        categories: ["ABCDEFGH", "IJKLMNOP", "QRSTUVWX"],
        series: [{ name: "Units", values: [250000, 500000, 1000000] }],
        legend: undefined,
        title: undefined,
        categoryAxisLabelStyle: {
          font: "Arial",
          sizePt: 12,
          color: bar ? "#604020" : "#1869A4",
        },
        valueAxisLabelStyle: {
          font: "Arial",
          sizePt: 12,
          color: bar ? "#1869A4" : "#604020",
        },
        categoryAxisLabelRotationDeg: null,
        valueAxisLabelRotationDeg: null,
        valueAxis: { min: 0, max: 1000000, majorUnit: 250000 },
        categoryAxisMajorTickMark: "none",
        valueAxisMajorTickMark: "none",
        categoryAxisMinorTickMark: "none",
        valueAxisMinorTickMark: "none",
      });
    P.setShapeSize(f.shape, P.pt(165), P.pt(300));
    const source = Buffer.from(await P.savePresentation(f.p)),
      originalPart = P._internalPackageOf(f.p)
        .getPart(chartRoot(f.shape))
        .data.slice(),
      originalBook = workbook(f.p, f.shape).data.slice(),
      ui = await setup(page);
    const check = async (count) => {
      const rows = await page.locator("#slide-canvas .slide-image").evaluate(
        async (img, { count, bar }) => {
          await img.decode();
          const { createTextMeasurer } = await import("/src/text-measure.js"),
            measure = createTextMeasurer(),
            doc = new DOMParser().parseFromString(
              decodeURIComponent(img.src.split(",").slice(1).join(",")),
              "image/svg+xml",
            ),
            labels = [...doc.querySelectorAll('text[fill="#1869A4"]')],
            n = bar ? 5 : 3,
            rows = [];
          if (labels.length !== count * n)
            throw Error("Missing horizontal labels");
          for (let i = 0; i < count; i++) {
            const row = labels.slice(i * n, (i + 1) * n),
              xs = row.map((e) => +e.getAttribute("x")).sort((a, b) => a - b),
              step = Math.min(...xs.slice(1).map((x, j) => x - xs[j]));
            for (const e of row) {
              const sizePx = +e.getAttribute("font-size"),
                metrics = measure(e.textContent, {
                  family: e.getAttribute("font-family"),
                  sizePx,
                  bold: +e.getAttribute("font-weight") >= 600,
                  italic: e.getAttribute("font-style") === "italic",
                  letterSpacingPx: 0,
                }),
                angle =
                  (+(
                    e
                      .getAttribute("transform")
                      ?.match(/rotate\(([-.\d]+)/)?.[1] ?? 0
                  ) *
                    Math.PI) /
                  180;
              rows.push({
                step,
                projection:
                  Math.abs(metrics.widthPx * Math.cos(angle)) +
                  Math.abs(
                    Math.max(sizePx, metrics.ascentPx + metrics.descentPx) *
                      Math.sin(angle),
                  ),
              });
            }
          }
          return rows;
        },
        { count, bar },
      );
      for (const row of rows)
        expect(row.projection).toBeLessThanOrEqual(row.step + 0.06);
    };
    await ui.load(source, 1);
    await check(1);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check(1);
    const q = await P.loadPresentation(await ui.download()),
      chart = P.getSlideCharts(P.getSlides(q)[0])[0];
    P.setChartSpec(chart, {
      ...chart.spec,
      categoryAxisLabelStyle: {
        ...chart.spec.categoryAxisLabelStyle,
        font: "Times New Roman",
      },
      valueAxisLabelStyle: {
        ...chart.spec.valueAxisLabelStyle,
        font: "Times New Roman",
      },
      series: chart.spec.series.map((s) => ({
        ...s,
        values: s.values.map((v) => v + 1),
      })),
    });
    await ui.load(Buffer.from(await P.savePresentation(q)), 1);
    await check(1);
    await ui.load(await ui.download(), 1);
    await check(1);
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    await check(2);
    const returned = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(returned)[0]);
    expect(charts[1].spec.categoryAxisLabelStyle.font).toBe("Times New Roman");
    expect(charts[1].spec.valueAxisLabelStyle.font).toBe("Times New Roman");
    expect(charts[1].spec.series[0].values).toEqual([250001, 500001, 1000001]);
    expect(
      P._internalPackageOf(returned).getPart(chartRoot(charts[0].shape)).data,
    ).toEqual(originalPart);
    expect(workbook(returned, charts[0].shape).data).toEqual(originalBook);
    expect(P.validatePresentation(returned)).toEqual([]);
    expect(ui.errors).toEqual([]);
  });

for (const kind of ["bar", "column"])
  for (const grouping of ["clustered", "stacked", "percentStacked"])
    test(`${kind} ${grouping} inverted paint survives clipboard and edits`, async ({
      page,
    }) => {
      const f = chartInversionDeck({
        kind,
        grouping,
        crossing: grouping === "percentStacked" ? "max" : { at: 5 },
        ...(grouping === "percentStacked"
          ? {
              valueAxis: { min: 0, max: 1, majorUnit: 0.25 },
              series: [
                [2, 4, 3, 5],
                [1, 2, 1, 3],
              ].map((values, i) => ({
                name: `Series ${i}`,
                values,
                color: ["#E85239", "#316BB0"][i],
                pointInvertIfNegative: [false, null, true],
              })),
            }
          : {}),
        pointInvertIfNegative: [false, null, true],
      });
      nativeInvertedColor(f);
      const source = Buffer.from(await P.savePresentation(f.p)),
        raw = P._internalPackageOf(f.p)
          .getPart(chartRoot(f.shape))
          .data.slice(),
        book = workbook(f.p, f.shape).data.slice(),
        ui = await setup(page);
      const initial =
        grouping === "percentStacked"
          ? [
              "#E85239",
              "#316BB0",
              "#61A8B4",
              "#61A8B4",
              "#61A8B4",
              "#61A8B4",
              "#61A8B4",
              "#61A8B4",
            ]
          : [
              "#E85239",
              "#316BB0",
              "#61A8B4",
              "#61A8B4",
              "#61A8B4",
              "#61A8B4",
              ...(grouping === "stacked" ? ["#E85239"] : []),
              "#61A8B4",
            ];
      const edited =
        grouping === "percentStacked"
          ? [
              "#AA4499",
              "#AA4499",
              "#AA4499",
              "#AA4499",
              "#E85239",
              "#316BB0",
              "#AA4499",
              "#AA4499",
            ]
          : grouping === "stacked"
            ? ["#AA4499", "#AA4499", "#AA4499", "#E85239", "#316BB0", "#E85239"]
            : [
                "#AA4499",
                "#AA4499",
                "#AA4499",
                "#AA4499",
                "#E85239",
                "#E85239",
                "#AA4499",
              ];
      const check = async (expected) => {
        const fills = await page
          .locator("#slide-canvas .slide-image")
          .evaluate(async (img) => {
            await img.decode();
            const doc = new DOMParser().parseFromString(
              decodeURIComponent(img.src.split(",").slice(1).join(",")),
              "image/svg+xml",
            );
            return [...doc.querySelectorAll("rect")]
              .map((e) => e.getAttribute("fill"))
              .filter((c) =>
                ["#E85239", "#316BB0", "#61A8B4", "#AA4499"].includes(c),
              );
          });
        expect(fills).toEqual(expected.flat());
      };
      await ui.load(source, 1);
      await check([initial]);
      await ui.copyAll();
      await ui.blank();
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(1);
      await check([initial]);
      const q = await P.loadPresentation(await ui.download()),
        chart = P.getSlideCharts(P.getSlides(q)[0])[0];
      P.setChartSpec(chart, {
        ...chart.spec,
        series: chart.spec.series.map((s) => ({
          ...s,
          negativeColor: "#AA4499",
          pointInvertIfNegative: [true, null, false],
          values: s.values.map((v) => v + 1),
        })),
      });
      await ui.load(Buffer.from(await P.savePresentation(q)), 1);
      await check([edited]);
      await ui.load(await ui.download(), 1);
      await check([edited]);
      await ui.copyAll();
      await ui.load(source, 1);
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(2);
      await check([initial, edited]);
      const returned = await P.loadPresentation(await ui.download()),
        charts = P.getSlideCharts(P.getSlides(returned)[0]);
      expect(charts[1].spec.series[0].negativeColor).toBe("#AA4499");
      expect(charts[1].spec.series[0].pointInvertIfNegative).toEqual([
        true,
        ,
        false,
      ]);
      expect(charts[1].spec.series[0].values).toEqual(
        grouping === "percentStacked" ? [3, 5, 4, 6] : [-3, 0, 3, 6],
      );
      expect(
        P._internalPackageOf(returned).getPart(chartRoot(charts[0].shape)).data,
      ).toEqual(raw);
      expect(workbook(returned, charts[0].shape).data).toEqual(book);
      expect(P.validatePresentation(returned)).toEqual([]);
      expect(ui.errors).toEqual([]);
    });

for (const kind of ["bar", "column", "line", "area", "scatter", "bubble"])
  for (const direction of ["minMax", "maxMin"])
    test(`${kind} ${direction} series clipping survives clipboard with native boundary paint`, async ({
      page,
    }) => {
      const xy = kind === "scatter" || kind === "bubble",
        f = xy
          ? chartXYClippingDeck({ kind, direction })
          : chartSeriesClippingDeck({
              kind,
              direction,
              crossBetween: "midCat",
              markerSizePt: 72,
              smooth: kind === "line",
            }),
        source = Buffer.from(await P.savePresentation(f.p)),
        originalSpec = P.getShapeChartSpec(f.shape),
        originalRaw = P._internalPackageOf(f.p)
          .getPart(chartRoot(f.shape))
          .data.slice(),
        originalBook = workbook(f.p, f.shape).data.slice(),
        ui = await setup(page);
      const check = async () => {
        const result = await page
          .locator("#slide-canvas .slide-image")
          .evaluate(
            async (img, { kind, xy }) => {
              await img.decode();
              const doc = new DOMParser().parseFromString(
                  decodeURIComponent(img.src.split(",").slice(1).join(",")),
                  "image/svg+xml",
                ),
                root = doc.documentElement,
                colors = xy
                  ? ["#E85239", "#2F8541", "#376CA8"]
                  : ["#E85239", "#1155AA"],
                geometries = [
                  ...doc.querySelectorAll(
                    "rect,path,circle,polygon,line,text,image",
                  ),
                ].filter((e) => !e.closest("defs")),
                bodies = geometries.filter(
                  (e) =>
                    (kind === "bubble"
                      ? e.localName === "circle" && +e.getAttribute("r") > 10
                      : ["path", "rect"].includes(e.localName) &&
                        (e.localName !== "rect" ||
                          +e.getAttribute("width") > 20 ||
                          +e.getAttribute("height") > 20)) &&
                    colors.some(
                      (c) =>
                        e.getAttribute("fill") === c ||
                        e.getAttribute("stroke") === c,
                    ),
                ),
                clip = bodies[0]?.getAttribute("clip-path"),
                plot = clip
                  ? doc.getElementById(clip.slice(5, -1))?.querySelector("rect")
                  : null;
              if (!plot)
                throw new Error("Series body has no resolved plot clip");
              const bounds = Object.fromEntries(
                  ["x", "y", "width", "height"].map((n) => [
                    n,
                    +plot.getAttribute(n),
                  ]),
                ),
                bodyClips = bodies.every((e) => {
                  const ref = e.getAttribute("clip-path"),
                    rectangle =
                      ref &&
                      doc
                        .getElementById(ref.slice(5, -1))
                        ?.querySelector("rect");
                  return (
                    rectangle &&
                    ["x", "y", "width", "height"].every(
                      (n) => +rectangle.getAttribute(n) === bounds[n],
                    )
                  );
                }),
                markerColors = xy
                  ? ["#116699", "#D9B231", "#CC3344"]
                  : ["#00AA66"],
                markers = geometries.filter(
                  (e) =>
                    markerColors.some(
                      (c) =>
                        e.getAttribute("fill") === c ||
                        e.getAttribute("stroke") === c,
                    ) && e.closest("[clip-path]"),
                ),
                markerClips = markers.map((e) =>
                  e.closest("[clip-path]").getAttribute("clip-path"),
                ),
                canvas = document.createElement("canvas");
              canvas.width = +root.getAttribute("width");
              canvas.height = +root.getAttribute("height");
              const ctx = canvas.getContext("2d"),
                raster = async (selected, boundsOverride = bounds) => {
                  const bounds = boundsOverride;
                  for (const e of geometries)
                    e.setAttribute(
                      "visibility",
                      selected.includes(e) ? "visible" : "hidden",
                    );
                  const image = new Image();
                  image.src =
                    "data:image/svg+xml;charset=utf-8," +
                    encodeURIComponent(
                      new XMLSerializer().serializeToString(root),
                    );
                  await image.decode();
                  ctx.clearRect(0, 0, canvas.width, canvas.height);
                  ctx.drawImage(image, 0, 0);
                  const pixels = ctx.getImageData(
                    0,
                    0,
                    canvas.width,
                    canvas.height,
                  ).data;
                  let inside = 0,
                    outside = 0;
                  for (let y = 0; y < canvas.height; y++)
                    for (let x = 0; x < canvas.width; x++) {
                      if (pixels[(y * canvas.width + x) * 4 + 3] < 128)
                        continue;
                      if (
                        x >= bounds.x + 1 &&
                        x < bounds.x + bounds.width - 1 &&
                        y >= bounds.y + 1 &&
                        y < bounds.y + bounds.height - 1
                      )
                        inside++;
                      else if (
                        x < bounds.x - 1 ||
                        x >= bounds.x + bounds.width + 1 ||
                        y < bounds.y - 1 ||
                        y >= bounds.y + bounds.height + 1
                      )
                        outside++;
                    }
                  return { inside, outside };
                };
              return {
                bodyCount: bodies.length,
                bodyClips,
                bodies: await raster(bodies),
                markerCount: markers.length,
                markerClipsIndependent: markerClips.every((m) => m !== clip),
                markers: await raster(markers),
                markerFrame: markers.length
                  ? await raster(
                      markers,
                      Object.fromEntries(
                        ["x", "y", "width", "height"].map((n) => [
                          n,
                          +doc
                            .getElementById(markerClips[0].slice(5, -1))
                            .querySelector("rect")
                            .getAttribute(n),
                        ]),
                      ),
                    )
                  : null,
              };
            },
            { kind, xy },
          );
        expect(result.bodyCount).toBeGreaterThan(0);
        expect(result.bodyClips).toBe(true);
        expect(result.bodies.inside).toBeGreaterThan(100);
        expect(result.bodies.outside).toBe(0);
        if (kind === "line" || kind === "scatter") {
          expect(result.markerCount).toBeGreaterThanOrEqual(3);
          expect(result.markerClipsIndependent).toBe(true);
          expect(result.markers.outside).toBeGreaterThan(10);
          expect(result.markerFrame.outside).toBe(0);
        } else expect(result.markerCount).toBe(0);
      };
      await ui.load(source, 1);
      await check();
      await ui.copyAll();
      await ui.blank();
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(1);
      await check();
      await ui.load(await ui.download(), 1);
      await check();
      if (!xy) {
        const copied = await P.loadPresentation(await ui.download()),
          chart = P.getSlideCharts(P.getSlides(copied)[0])[0];
        P.setChartSpec(chart, {
          ...chart.spec,
          series: chart.spec.series.map((s) => ({
            ...s,
            values: s.values.slice().reverse(),
          })),
        });
        await ui.load(Buffer.from(await P.savePresentation(copied)), 1);
        await check();
      }
      await ui.copyAll();
      await ui.load(source, 1);
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(2);
      await check();
      const returned = await P.loadPresentation(await ui.download()),
        charts = P.getSlideCharts(P.getSlides(returned)[0]);
      expect(charts[0].spec).toEqual(originalSpec);
      expect(
        P._internalPackageOf(returned).getPart(chartRoot(charts[0].shape)).data,
      ).toEqual(originalRaw);
      expect(workbook(returned, charts[0].shape).data).toEqual(originalBook);
      expect(P.validatePresentation(returned)).toEqual([]);
      expect(ui.errors).toEqual([]);
    });

for (const kind of ["bar", "column", "line", "area"])
  for (const direction of ["minMax", "maxMin"])
    test(`${kind} ${direction} signed percentage stacks survive clipboard and authored bound edits`, async ({
      page,
    }) => {
      const f = chartPercentageStacksDeck({
          kind,
          direction,
          axis: { min: -0.4, max: 0.4, majorUnit: 0.2 },
        }),
        source = Buffer.from(await P.savePresentation(f.p)),
        originalSpec = P.getShapeChartSpec(f.shape),
        raw = P._internalPackageOf(f.p)
          .getPart(chartRoot(f.shape))
          .data.slice(),
        book = workbook(f.p, f.shape).data.slice(),
        ui = await setup(page);
      const check = async (positive = false) => {
        const actual = await page
          .locator("#slide-canvas .slide-image")
          .evaluate(
            async (img, { kind, direction, positive }) => {
              await img.decode();
              const doc = new DOMParser().parseFromString(
                  decodeURIComponent(img.src.split(",").slice(1).join(",")),
                  "image/svg+xml",
                ),
                plot = doc.querySelector('rect[fill="#ECF5E9"]'),
                horizontal = kind === "bar",
                start = +plot.getAttribute(horizontal ? "x" : "y"),
                span = +plot.getAttribute(horizontal ? "width" : "height"),
                min = positive ? 0.2 : -0.4,
                max = positive ? 0.8 : 0.4,
                coordinate = (v) => {
                  let t = (v - min) / (max - min);
                  if (!horizontal) t = 1 - t;
                  if (direction === "maxMin") t = 1 - t;
                  return start + t * span;
                },
                bars = [
                  ...doc.querySelectorAll(
                    'rect[fill="#E85239"],rect[fill="#316BB0"]',
                  ),
                ],
                paths = [
                  ...doc.querySelectorAll(
                    'path[stroke="#E85239"],path[stroke="#316BB0"]',
                  ),
                ],
                errors = [];
              if (kind === "bar" || kind === "column") {
                const shares = positive
                  ? [
                      [0.25, 0.75],
                      [0.5, 0.5],
                      [0.75, 0.25],
                    ]
                  : [
                      [0.25, -0.75],
                      [-0.5, 0.5],
                      [0.75, -0.25],
                    ];
                bars.forEach((bar, i) => {
                  const c = Math.floor(i / 2),
                    s = i % 2,
                    base = positive && s === 1 ? shares[c][0] : 0,
                    tip = base + shares[c][s];
                  errors.push(
                    Math.abs(
                      +bar.getAttribute(horizontal ? "x" : "y") -
                        Math.min(coordinate(base), coordinate(tip)),
                    ),
                  );
                  errors.push(
                    Math.abs(
                      +bar.getAttribute(horizontal ? "width" : "height") -
                        Math.abs(coordinate(tip) - coordinate(base)),
                    ),
                  );
                });
              } else {
                const tops = positive
                  ? [
                      [0.25, 0.5, 0.75],
                      [1, 1, 1],
                    ]
                  : [
                      [0.25, -0.5, 0.75],
                      [-0.5, 0, 0.5],
                    ];
                paths.forEach((path, s) =>
                  [
                    ...path
                      .getAttribute("d")
                      .matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g),
                  ]
                    .slice(0, 3)
                    .forEach((m, c) =>
                      errors.push(Math.abs(+m[2] - coordinate(tops[s][c]))),
                    ),
                );
              }
              const bodies = [...bars, ...paths],
                labels = [...doc.querySelectorAll('text[fill="#17589B"]')].map(
                  (e) => e.textContent,
                ),
                clips = bodies.every((e) => e.hasAttribute("clip-path")),
                canvas = document.createElement("canvas");
              canvas.width = +doc.documentElement.getAttribute("width");
              canvas.height = +doc.documentElement.getAttribute("height");
              for (const e of doc.querySelectorAll(
                "rect,path,circle,polygon,line,text,image",
              ))
                if (!e.closest("defs") && !bodies.includes(e))
                  e.setAttribute("visibility", "hidden");
              const raster = new Image();
              raster.src =
                "data:image/svg+xml;charset=utf-8," +
                encodeURIComponent(
                  new XMLSerializer().serializeToString(doc.documentElement),
                );
              await raster.decode();
              const ctx = canvas.getContext("2d");
              ctx.drawImage(raster, 0, 0);
              const data = ctx.getImageData(
                0,
                0,
                canvas.width,
                canvas.height,
              ).data;
              let painted = 0;
              for (let i = 3; i < data.length; i += 4)
                if (data[i] > 128) painted++;
              return { labels, errors, clips, count: bodies.length, painted };
            },
            { kind, direction, positive },
          );
        expect(actual.labels).toEqual(
          positive
            ? ["20%", "50%", "80%"]
            : ["-40%", "-20%", "0%", "20%", "40%"],
        );
        expect(actual.count).toBe(kind === "bar" || kind === "column" ? 6 : 2);
        expect(actual.clips).toBe(true);
        expect(Math.max(...actual.errors)).toBeLessThan(0.03);
        expect(actual.painted).toBeGreaterThan(100);
      };
      await ui.load(source, 1);
      await check();
      await ui.copyAll();
      await ui.blank();
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(1);
      await check();
      await ui.load(await ui.download(), 1);
      await check();
      const edited = await P.loadPresentation(await ui.download()),
        chart = P.getSlideCharts(P.getSlides(edited)[0])[0];
      P.setChartSpec(chart, {
        ...chart.spec,
        valueAxis: { min: 0.2, max: 0.8, majorUnit: 0.3 },
        series: chart.spec.series.map((s, i) => ({
          ...s,
          values: i === 0 ? [1, 2, 3] : [3, 2, 1],
        })),
      });
      await ui.load(Buffer.from(await P.savePresentation(edited)), 1);
      await check(true);
      await ui.copyAll();
      await ui.load(source, 1);
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(2);
      const returned = await P.loadPresentation(await ui.download()),
        charts = P.getSlideCharts(P.getSlides(returned)[0]);
      expect(charts[0].spec).toEqual(originalSpec);
      expect(charts[1].spec.valueAxis).toEqual({
        min: 0.2,
        max: 0.8,
        majorUnit: 0.3,
      });
      expect(charts[1].spec.series.map((s) => s.values)).toEqual([
        [1, 2, 3],
        [3, 2, 1],
      ]);
      expect(
        P._internalPackageOf(returned).getPart(chartRoot(charts[0].shape)).data,
      ).toEqual(raw);
      expect(workbook(returned, charts[0].shape).data).toEqual(book);
      expect(P.validatePresentation(returned)).toEqual([]);
      expect(ui.errors).toEqual([]);
    });

for (const kind of [
  "bar",
  "column",
  "line",
  "area",
  "pie",
  "doughnut",
  "scatter",
  "radar",
  "bubble",
])
  test(`${kind} solid alpha survives raster paint, clipboard both ways and download`, async ({
    page,
  }) => {
    const f = chartSeriesOpacityDeck({ kind }),
      original = P.getShapeChartSpec(f.shape),
      raw = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data.slice(),
      book = workbook(f.p, f.shape).data.slice(),
      source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page);
    const check = async () => {
      const actual = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img, kind) => {
          const doc = new DOMParser().parseFromString(
              decodeURIComponent(img.src.split(",").slice(1).join(",")),
              "image/svg+xml",
            ),
            line = kind === "line" || kind === "scatter",
            candidates = [
              ...doc.querySelectorAll(
                line
                  ? 'path[fill="none"][stroke]'
                  : "rect[fill],path[fill],polygon[fill],circle[fill]",
              ),
            ].filter(
              (e) =>
                !e.closest("defs") &&
                (line
                  ? e.getAttribute("stroke-opacity") === "0.7"
                  : e.getAttribute("fill-opacity") === "0.35"),
            ),
            target =
              candidates.find((e) => e.hasAttribute("clip-path")) ??
              candidates.find((e) =>
                ["path", "polygon", "circle"].includes(e.localName),
              ) ??
              candidates[0];
          if (!target)
            throw Error("Missing independently painted native alpha");
          for (const e of doc.querySelectorAll(
            "rect,path,circle,polygon,line,text,image",
          ))
            if (!e.closest("defs") && e !== target)
              e.setAttribute("visibility", "hidden");
          if (!line) target.setAttribute("stroke", "none");
          const canvas = document.createElement("canvas");
          canvas.width = +doc.documentElement.getAttribute("width");
          canvas.height = +doc.documentElement.getAttribute("height");
          const raster = new Image();
          raster.src =
            "data:image/svg+xml;charset=utf-8," +
            encodeURIComponent(
              new XMLSerializer().serializeToString(doc.documentElement),
            );
          await raster.decode();
          const ctx = canvas.getContext("2d");
          ctx.drawImage(raster, 0, 0);
          const pixels = ctx.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            ).data,
            histogram = Array(256).fill(0);
          for (let i = 3; i < pixels.length; i += 4)
            if (pixels[i]) histogram[pixels[i]]++;
          const mode = histogram.indexOf(Math.max(...histogram));
          return {
            mode,
            painted: histogram[mode],
            expected: Math.round((line ? 0.7 : 0.35) * 255),
            candidates: candidates.length,
          };
        }, kind);
      expect(actual.candidates).toBeGreaterThan(0);
      expect(Math.abs(actual.mode - actual.expected)).toBeLessThanOrEqual(1);
      expect(actual.painted).toBeGreaterThan(100);
    };
    await ui.load(source, 1);
    await check();
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check();
    await ui.load(await ui.download(), 1);
    await check();
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const returned = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(returned)[0]);
    expect(charts).toHaveLength(2);
    for (const chart of charts) {
      expect(chart.spec).toEqual(original);
      // Clipboard source formatting may add a chart-local color map. All
      // other native XML, including the independent alpha channels, stays exact.
      const withoutColorMap = (bytes) => {
        const doc = parseXml(new TextDecoder().decode(bytes));
        doc.root.children = doc.root.children.filter(
          (e) =>
            e.kind !== "element" ||
            e.name.namespaceURI !== NS.chart ||
            e.name.localName !== "clrMapOvr",
        );
        return serializeXml(doc);
      };
      expect(
        withoutColorMap(
          P._internalPackageOf(returned).getPart(chartRoot(chart.shape)).data,
        ),
      ).toBe(withoutColorMap(raw));
      expect(workbook(returned, chart.shape).data).toEqual(book);
    }
    expect(P.validatePresentation(returned)).toEqual([]);
    expect(ui.errors).toEqual([]);
  });

for (const kind of [
  "bar",
  "column",
  "line",
  "area",
  "pie",
  "doughnut",
  "scatter",
  "radar",
  "bubble",
])
  test(`${kind} noFill retains transparent bodies and visible outlines through clipboard both ways and download`, async ({
    page,
  }) => {
    const markers = kind === "line" || kind === "scatter",
      f = chartNoFillDeck({ kind, ...(markers ? { markerFill: "none" } : {}) }),
      original = P.getShapeChartSpec(f.shape),
      raw = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data.slice(),
      book = workbook(f.p, f.shape).data.slice(),
      source = Buffer.from(await P.savePresentation(f.p)),
      ui = await setup(page);
    const check = async () => {
      const actual = await page.locator("#slide-canvas .slide-image").evaluate(
        async (img, { stroke, markers }) => {
          const doc = new DOMParser().parseFromString(
              decodeURIComponent(img.src.split(",").slice(1).join(",")),
              "image/svg+xml",
            ),
            candidates = [
              ...doc.querySelectorAll("rect,path,circle,polygon"),
            ].filter(
              (e) => !e.closest("defs") && e.getAttribute("stroke") === stroke,
            ),
            target =
              candidates.find((e) => e.hasAttribute("clip-path")) ??
              candidates.find((e) =>
                ["path", "polygon", "circle"].includes(e.localName),
              ) ??
              candidates[0];
          if (!target)
            throw Error(
              "Missing native noFill geometry and independent outline",
            );
          const fills = candidates.map((e) => e.getAttribute("fill"));
          for (const e of doc.querySelectorAll(
            "rect,path,circle,polygon,line,text,image",
          ))
            if (!e.closest("defs") && e !== target)
              e.setAttribute("visibility", "hidden");
          const canvas = document.createElement("canvas");
          canvas.width = +doc.documentElement.getAttribute("width");
          canvas.height = +doc.documentElement.getAttribute("height");
          const ctx = canvas.getContext("2d");
          const raster = async () => {
            const im = new Image();
            im.src =
              "data:image/svg+xml;charset=utf-8," +
              encodeURIComponent(
                new XMLSerializer().serializeToString(doc.documentElement),
              );
            await im.decode();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(im, 0, 0);
            const bytes = ctx.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            ).data;
            let painted = 0;
            for (let i = 3; i < bytes.length; i += 4) if (bytes[i]) painted++;
            return painted;
          };
          const outlined = await raster();
          target.setAttribute("stroke", "none");
          const interior = await raster();
          return { fills, outlined, interior };
        },
        {
          stroke: markers
            ? original.series[0].markerStrokeColor
            : original.series[0].lineColor,
          markers,
        },
      );
      expect(actual.fills.length).toBeGreaterThan(1);
      expect(actual.fills.every((fill) => fill === "none")).toBe(true);
      expect(actual.outlined).toBeGreaterThan(10);
      expect(actual.interior).toBe(0);
    };
    await ui.load(source, 1);
    await check();
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(1);
    await check();
    await ui.load(await ui.download(), 1);
    await check();
    await ui.copyAll();
    await ui.load(source, 1);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(2);
    const returned = await P.loadPresentation(await ui.download()),
      charts = P.getSlideCharts(P.getSlides(returned)[0]);
    expect(charts).toHaveLength(2);
    const withoutColorMap = (bytes) => {
      const doc = parseXml(new TextDecoder().decode(bytes));
      doc.root.children = doc.root.children.filter(
        (e) =>
          e.kind !== "element" ||
          e.name.namespaceURI !== NS.chart ||
          e.name.localName !== "clrMapOvr",
      );
      return serializeXml(doc);
    };
    for (const chart of charts) {
      expect(chart.spec).toEqual(original);
      expect(
        withoutColorMap(
          P._internalPackageOf(returned).getPart(chartRoot(chart.shape)).data,
        ),
      ).toBe(withoutColorMap(raw));
      expect(workbook(returned, chart.shape).data).toEqual(book);
    }
    expect(P.validatePresentation(returned)).toEqual([]);
    expect(ui.errors).toEqual([]);
  });

for (const kind of ["bar", "column"])
  for (const pointIndex of [undefined, 0, 1])
    test(`${kind} zero-alpha inversion outline with point ${pointIndex ?? "absent"} survives raster, clipboard both ways and download`, async ({
      page,
    }) => {
      const f = chartZeroFillInversionDeck({
          kind,
          negativeColor: "#FFFFFF",
          ...(pointIndex === undefined ? {} : { pointOpacity: 0, pointIndex }),
        }),
        original = P.getShapeChartSpec(f.shape),
        raw = P._internalPackageOf(f.p)
          .getPart(chartRoot(f.shape))
          .data.slice(),
        book = workbook(f.p, f.shape).data.slice(),
        source = Buffer.from(await P.savePresentation(f.p)),
        ui = await setup(page);
      const check = async () => {
        const actual = await page
          .locator("#slide-canvas .slide-image")
          .evaluate(async (img) => {
            const doc = new DOMParser().parseFromString(
                decodeURIComponent(img.src.split(",").slice(1).join(",")),
                "image/svg+xml",
              ),
              bars = [...doc.querySelectorAll("rect[clip-path]")].filter(
                (e) => !e.closest("defs"),
              ),
              black = bars.filter(
                (e) => e.getAttribute("stroke") === "#000000",
              ).length;
            for (const e of doc.querySelectorAll(
              "rect,path,circle,polygon,line,text,image",
            ))
              if (!e.closest("defs") && !bars.includes(e))
                e.setAttribute("visibility", "hidden");
            const canvas = document.createElement("canvas");
            canvas.width = +doc.documentElement.getAttribute("width");
            canvas.height = +doc.documentElement.getAttribute("height");
            const raster = new Image();
            raster.src =
              "data:image/svg+xml;charset=utf-8," +
              encodeURIComponent(
                new XMLSerializer().serializeToString(doc.documentElement),
              );
            await raster.decode();
            const ctx = canvas.getContext("2d");
            ctx.drawImage(raster, 0, 0);
            const pixels = ctx.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            ).data;
            let painted = 0;
            for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) painted++;
            return {
              bars: bars.length,
              black,
              painted,
              complete: bars.every(
                (e) =>
                  +e.getAttribute("width") > 0 && +e.getAttribute("height") > 0,
              ),
            };
          });
        expect(actual.bars).toBe(3);
        expect(actual.complete).toBe(true);
        expect(actual.black).toBe(pointIndex === 0 ? 1 : 0);
        if (pointIndex === 0) expect(actual.painted).toBeGreaterThan(100);
        else expect(actual.painted).toBe(0);
      };
      await ui.load(source, 1);
      await check();
      await ui.copyAll();
      await ui.blank();
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(1);
      await check();
      await ui.load(await ui.download(), 1);
      await check();
      await ui.copyAll();
      await ui.load(source, 1);
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(2);
      const returned = await P.loadPresentation(await ui.download()),
        charts = P.getSlideCharts(P.getSlides(returned)[0]);
      expect(charts).toHaveLength(2);
      const withoutColorMap = (bytes) => {
        const doc = parseXml(new TextDecoder().decode(bytes));
        doc.root.children = doc.root.children.filter(
          (e) =>
            e.kind !== "element" ||
            e.name.namespaceURI !== NS.chart ||
            e.name.localName !== "clrMapOvr",
        );
        return serializeXml(doc);
      };
      for (const chart of charts) {
        expect(chart.spec).toEqual(original);
        expect(
          withoutColorMap(
            P._internalPackageOf(returned).getPart(chartRoot(chart.shape)).data,
          ),
        ).toBe(withoutColorMap(raw));
        expect(workbook(returned, chart.shape).data).toEqual(book);
      }
      expect(P.validatePresentation(returned)).toEqual([]);
      expect(ui.errors).toEqual([]);
    });

for (const kind of ["bar", "column"])
  for (const format of ["solid", "idx"])
    for (const pointSwitch of [undefined, false, true])
      test(`${kind} native point inversion default ${format} ${pointSwitch ?? "omitted"} survives raster, clipboard both ways and download`, async ({
        page,
      }) => {
        const f = chartPointInversionDefaultDeck({ kind, format, pointSwitch }),
          original = P.getShapeChartSpec(f.shape),
          raw = P._internalPackageOf(f.p)
            .getPart(chartRoot(f.shape))
            .data.slice(),
          book = workbook(f.p, f.shape).data.slice(),
          source = Buffer.from(await P.savePresentation(f.p)),
          ui = await setup(page);
        const check = async () => {
          const actual = await page
            .locator("#slide-canvas .slide-image")
            .evaluate(async (img) => {
              const doc = new DOMParser().parseFromString(
                  decodeURIComponent(img.src.split(",").slice(1).join(",")),
                  "image/svg+xml",
                ),
                bars = [...doc.querySelectorAll("rect[clip-path]")].filter(
                  (e) => !e.closest("defs"),
                ),
                black = bars.filter(
                  (e) => e.getAttribute("stroke") === "#000000",
                ).length;
              for (const e of doc.querySelectorAll(
                "rect,path,circle,polygon,line,text,image",
              ))
                if (!e.closest("defs") && e !== bars[0])
                  e.setAttribute("visibility", "hidden");
              const canvas = document.createElement("canvas");
              canvas.width = +doc.documentElement.getAttribute("width");
              canvas.height = +doc.documentElement.getAttribute("height");
              const raster = new Image();
              raster.src =
                "data:image/svg+xml;charset=utf-8," +
                encodeURIComponent(
                  new XMLSerializer().serializeToString(doc.documentElement),
                );
              await raster.decode();
              const ctx = canvas.getContext("2d");
              ctx.drawImage(raster, 0, 0);
              const pixels = ctx.getImageData(
                0,
                0,
                canvas.width,
                canvas.height,
              ).data;
              const fillPixels = [0, 0, 0];
              for (let i = 0; i < pixels.length; i += 4) {
                if (pixels[i + 3] !== 255) continue;
                for (const [index, color] of [
                  [255, 255, 255],
                  [204, 85, 170],
                  [232, 82, 57],
                ].entries())
                  if (color.every((channel, j) => pixels[i + j] === channel))
                    fillPixels[index]++;
              }
              return {
                bars: bars.length,
                black,
                fillPixels,
                complete: bars.every(
                  (e) =>
                    +e.getAttribute("width") > 0 &&
                    +e.getAttribute("height") > 0,
                ),
              };
            });
          expect(actual.bars).toBe(3);
          expect(actual.complete).toBe(true);
          expect(actual.black).toBe(pointSwitch === false ? 0 : 1);
          const expected =
            pointSwitch === false ? (format === "solid" ? 1 : 2) : 0;
          expect(actual.fillPixels[expected]).toBeGreaterThan(100);
          for (const [index, pixels] of actual.fillPixels.entries())
            if (index !== expected) expect(pixels).toBe(0);
        };
        await ui.load(source, 1);
        await check();
        await ui.copyAll();
        await ui.blank();
        await page.keyboard.press("Control+v");
        await expect(ui.objects).toHaveCount(1);
        await check();
        await ui.load(await ui.download(), 1);
        await check();
        await ui.copyAll();
        await ui.load(source, 1);
        await page.keyboard.press("Control+v");
        await expect(ui.objects).toHaveCount(2);
        const returned = await P.loadPresentation(await ui.download()),
          charts = P.getSlideCharts(P.getSlides(returned)[0]);
        expect(charts).toHaveLength(2);
        const withoutColorMap = (bytes) => {
          const doc = parseXml(new TextDecoder().decode(bytes));
          doc.root.children = doc.root.children.filter(
            (e) =>
              e.kind !== "element" ||
              e.name.namespaceURI !== NS.chart ||
              e.name.localName !== "clrMapOvr",
          );
          return serializeXml(doc);
        };
        for (const chart of charts) {
          expect(chart.spec).toEqual(original);
          expect(
            withoutColorMap(
              P._internalPackageOf(returned).getPart(chartRoot(chart.shape))
                .data,
            ),
          ).toBe(withoutColorMap(raw));
          expect(workbook(returned, chart.shape).data).toEqual(book);
        }
        expect(P.validatePresentation(returned)).toEqual([]);
        expect(ui.errors).toEqual([]);
      });

for (const kind of [
  "bar",
  "column",
  "area",
  "pie",
  "doughnut",
  "bubble",
  "radar",
])
  for (const paint of ["gradient", "pattern"])
    for (const pointIndex of [
      undefined,
      ...(["bar", "column"].includes(kind) ? [0, 1] : []),
    ])
      test(`${kind} native ${paint} body ${pointIndex === undefined ? "series" : `point style ${pointIndex}`} survives raster, clipboard both ways and download`, async ({
        page,
      }) => {
        const f = chartSeriesFillDeck({
            kind,
            paint,
            angle: 37,
            ...(pointIndex === undefined
              ? {}
              : {
                  pointPaint: "empty",
                  pointIndex,
                  valueAxis: { min: -6, max: 6, majorUnit: 2 },
                  pointLine:
                    pointIndex === 1
                      ? '<a:ln w="50800"><a:solidFill><a:srgbClr val="CC55AA"/></a:solidFill></a:ln>'
                      : "",
                  series: [
                    {
                      name: "Signed",
                      values: [-2, 4, -3],
                      color: "#E85239",
                      negativeColor: "#00AA77",
                      invertIfNegative: false,
                      lineColor: "#316BB0",
                      lineWidthEmu: 25400,
                    },
                  ],
                }),
          }),
          original = P.getShapeChartSpec(f.shape),
          raw = P._internalPackageOf(f.p)
            .getPart(chartRoot(f.shape))
            .data.slice(),
          book = workbook(f.p, f.shape).data.slice(),
          source = Buffer.from(await P.savePresentation(f.p)),
          ui = await setup(page);
        const check = async () => {
          const result = await page
            .locator("#slide-canvas .slide-image")
            .evaluate(
              async (img, { kind, paint, pointIndex }) => {
                const doc = new DOMParser().parseFromString(
                    decodeURIComponent(img.src.split(",").slice(1).join(",")),
                    "image/svg+xml",
                  ),
                  selector = ["bar", "column"].includes(kind)
                    ? "rect[clip-path]"
                    : kind === "area"
                      ? "path[clip-path]"
                      : kind === "bubble"
                        ? "circle"
                        : kind === "radar"
                          ? "polygon"
                          : "path",
                  bodies = [...doc.querySelectorAll(selector)].filter(
                    (e) =>
                      !e.closest("defs") &&
                      e.getAttribute("fill")?.startsWith("url(#"),
                  );
                if (!bodies.length) return { bodies: 0 };
                const point =
                    pointIndex === undefined
                      ? undefined
                      : [...doc.querySelectorAll("rect[clip-path]")].filter(
                          (e) => !e.closest("defs"),
                        )[pointIndex],
                  pointStyle =
                    point &&
                    Object.fromEntries(
                      ["fill", "stroke", "stroke-width"].map((k) => [
                        k,
                        point.getAttribute(k),
                      ]),
                    );
                const chosen = bodies[0],
                  definition = doc.getElementById(
                    chosen.getAttribute("fill").slice(5, -1),
                  );
                for (const e of doc.querySelectorAll(
                  "rect,path,circle,polygon,line,text,image",
                ))
                  if (!e.closest("defs") && e !== chosen)
                    e.setAttribute("visibility", "hidden");
                chosen.setAttribute("stroke", "none");
                const canvas = document.createElement("canvas");
                canvas.width = +doc.documentElement.getAttribute("width");
                canvas.height = +doc.documentElement.getAttribute("height");
                const raster = new Image();
                raster.src =
                  "data:image/svg+xml;charset=utf-8," +
                  encodeURIComponent(
                    new XMLSerializer().serializeToString(doc.documentElement),
                  );
                await raster.decode();
                const ctx = canvas.getContext("2d");
                ctx.drawImage(raster, 0, 0);
                const pixels = ctx.getImageData(
                    0,
                    0,
                    canvas.width,
                    canvas.height,
                  ).data,
                  colors = new Set(),
                  channels = [0, 0];
                for (let i = 0; i < pixels.length; i += 4)
                  if (pixels[i + 3] === 255) {
                    colors.add(
                      `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`,
                    );
                    for (const [j, color] of [
                      [35, 170, 136],
                      [102, 17, 51],
                    ].entries())
                      if (color.every((v, k) => v === pixels[i + k]))
                        channels[j]++;
                  }
                return {
                  pointStyle,
                  bodies: bodies.length,
                  definition: definition?.localName,
                  colors: colors.size,
                  channels,
                };
              },
              { kind, paint, pointIndex },
            );
          expect(result.bodies).toBeGreaterThan(0);
          if (pointIndex !== undefined)
            expect(result.pointStyle).toEqual({
              fill: pointIndex === 0 ? "#FFFFFF" : "#4F81BD",
              stroke: pointIndex === 0 ? "#000000" : "#CC55AA",
              "stroke-width": String(pointIndex === 0 ? 1 : 50800 / 9525),
            });
          expect(result.definition).toBe(
            paint === "gradient" ? "linearGradient" : "pattern",
          );
          if (paint === "gradient") expect(result.colors).toBeGreaterThan(30);
          else
            for (const pixels of result.channels)
              expect(pixels).toBeGreaterThan(10);
        };
        await ui.load(source, 1);
        await check();
        await ui.copyAll();
        await ui.blank();
        await page.keyboard.press("Control+v");
        await expect(ui.objects).toHaveCount(1);
        await check();
        await ui.load(await ui.download(), 1);
        await check();
        await ui.copyAll();
        await ui.load(source, 1);
        await page.keyboard.press("Control+v");
        await expect(ui.objects).toHaveCount(2);
        const returned = await P.loadPresentation(await ui.download()),
          charts = P.getSlideCharts(P.getSlides(returned)[0]);
        expect(charts).toHaveLength(2);
        const withoutColorMap = (bytes) => {
          const doc = parseXml(new TextDecoder().decode(bytes));
          doc.root.children = doc.root.children.filter(
            (e) =>
              e.kind !== "element" ||
              e.name.namespaceURI !== NS.chart ||
              e.name.localName !== "clrMapOvr",
          );
          return serializeXml(doc);
        };
        for (const chart of charts) {
          expect(chart.spec).toEqual(original);
          expect(
            withoutColorMap(
              P._internalPackageOf(returned).getPart(chartRoot(chart.shape))
                .data,
            ),
          ).toBe(withoutColorMap(raw));
          expect(workbook(returned, chart.shape).data).toEqual(book);
        }
        expect(P.validatePresentation(returned)).toEqual([]);
        expect(ui.errors).toEqual([]);
      });

for (const kind of ["bar", "column"])
  test(`${kind} unresolved chart color scheme keeps automatic points visible through download`, async ({
    page,
  }) => {
    const f = withoutChartColorScheme(
        chartSeriesFillDeck({
          kind,
          paint: "gradient",
          pointPaint: "empty",
          varyColors: false,
          legend: { position: null },
          series: [
            { name: "Values", values: [2, 5, 3], invertIfNegative: false },
          ],
        }),
      ),
      original = P.getShapeChartSpec(f.shape),
      raw = P._internalPackageOf(f.p).getPart(chartRoot(f.shape)).data.slice(),
      book = workbook(f.p, f.shape).data.slice(),
      themes = P._internalPackageOf(f.p)
        .parts.filter(
          (p) =>
            p.contentType ===
            "application/vnd.openxmlformats-officedocument.theme+xml",
        )
        .map((p) => ({ name: p.name, data: p.data.slice() })),
      ui = await setup(page);
    const check = async () => {
      const result = await page
        .locator("#slide-canvas .slide-image")
        .evaluate(async (img) => {
          const doc = new DOMParser().parseFromString(
              decodeURIComponent(img.src.split(",").slice(1).join(",")),
              "image/svg+xml",
            ),
            point = [...doc.querySelectorAll("rect[clip-path]")].filter(
              (e) => !e.closest("defs"),
            )[1];
          if (!point) return { fill: null, bluePixels: 0 };
          for (const e of doc.querySelectorAll(
            "rect,path,circle,polygon,line,text,image",
          ))
            if (!e.closest("defs") && e !== point)
              e.setAttribute("visibility", "hidden");
          point.setAttribute("stroke", "none");
          const canvas = document.createElement("canvas");
          canvas.width = +doc.documentElement.getAttribute("width");
          canvas.height = +doc.documentElement.getAttribute("height");
          const raster = new Image();
          raster.src =
            "data:image/svg+xml;charset=utf-8," +
            encodeURIComponent(
              new XMLSerializer().serializeToString(doc.documentElement),
            );
          await raster.decode();
          const ctx = canvas.getContext("2d");
          ctx.drawImage(raster, 0, 0);
          const pixels = ctx.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          ).data;
          let bluePixels = 0;
          for (let i = 0; i < pixels.length; i += 4)
            if (
              pixels[i] === 91 &&
              pixels[i + 1] === 155 &&
              pixels[i + 2] === 213 &&
              pixels[i + 3] === 255
            )
              bluePixels++;
          return { fill: point.getAttribute("fill"), bluePixels };
        });
      expect(result.fill).toBe("#5B9BD5");
      expect(result.bluePixels).toBeGreaterThan(10);
    };
    await ui.load(Buffer.from(await P.savePresentation(f.p)), 1);
    await check();
    const downloaded = await ui.download(),
      returned = await P.loadPresentation(downloaded),
      chart = P.getSlideCharts(P.getSlides(returned)[0])[0];
    expect(chart.spec).toEqual(original);
    expect(
      P._internalPackageOf(returned).getPart(chartRoot(chart.shape)).data,
    ).toEqual(raw);
    expect(workbook(returned, chart.shape).data).toEqual(book);
    for (const theme of themes)
      expect(P._internalPackageOf(returned).getPart(theme.name).data).toEqual(
        theme.data,
      );
    expect(P.validatePresentation(returned)).toEqual([]);
    await ui.load(downloaded, 1);
    await check();
    expect(ui.errors).toEqual([]);
  });

for (const kind of ["radar", "column", "pie"])
  for (const mode of ["fixed", "linked", "implicit"])
    test(`fixed-number grouping survives native source links and clipboard both ways (${kind}, ${mode})`, async ({
      page,
    }, testInfo) => {
      const linked = mode === "linked";
      const f = chartFixedNumberPair(kind, linked, mode === "implicit"),
        source = Buffer.from(await P.savePresentation(f.p)),
        originals = P.getSlideCharts(f.slide).map((c) => ({
          spec: c.spec,
          book: workbook(f.p, c.shape).data.slice(),
        })),
        ui = await setup(page);
      const check = async (sets = 1) => {
        const image = page.locator("#slide-canvas .slide-image");
        await image.evaluate((img) => img.decode());
        const svg = decodeURIComponent(
            (await image.getAttribute("src")).split(",").slice(1).join(","),
          ),
          axis = [],
          data = [],
          all = [];
        walkElements(parseXml(svg).root, (e) => {
          if (e.name.localName !== "text") return;
          const value = e.children
            .filter((c) => c.kind === "text")
            .map((c) => c.data)
            .join("");
          const fill = getAttrValue(e, qname("", "fill", ""));
          all.push(value);
          if (fill === "#2468AC") axis.push(value);
          if (fill === "#AF2568") data.push(value);
        });
        if (kind !== "pie") {
          expect(axis.filter((v) => v === "20000.00")).toHaveLength(sets);
          expect(axis.filter((v) => v === "20,000.00")).toHaveLength(sets);
          expect(axis.filter((v) => v === "-20000.00")).toHaveLength(sets);
          expect(axis.filter((v) => v === "-20,000.00")).toHaveLength(sets);
        }
        {
          expect(data.filter((v) => v === "12345.60")).toHaveLength(sets);
          expect(data.filter((v) => v === "12,345.60")).toHaveLength(sets);
          expect(data.filter((v) => v === "-12345.60")).toHaveLength(sets);
          expect(data.filter((v) => v === "-12,345.60")).toHaveLength(sets);
        }
        if (kind === "pie") {
          expect(all.filter((v) => v === "12345.60")).toHaveLength(2 * sets);
          expect(all.filter((v) => v === "12,345.60")).toHaveLength(2 * sets);
        }
        const bytes = await ui.download(),
          result = await P.loadPresentation(bytes),
          charts = P.getSlideCharts(P.getSlides(result)[0]);
        expect(charts).toHaveLength(2 * sets);
        expect(new Set(charts.map((c) => chartRoot(c.shape))).size).toBe(
          2 * sets,
        );
        expect(
          new Set(charts.map((c) => workbook(result, c.shape).name)).size,
        ).toBe(2 * sets);
        for (const [i, chart] of charts.entries()) {
          expect(chart.spec).toEqual(originals[i % 2].spec);
          expect(workbook(result, chart.shape).data).toEqual(
            originals[i % 2].book,
          );
        }
        expect(P.validatePresentation(result)).toEqual([]);
        return Buffer.from(bytes);
      };
      await ui.load(source, 2);
      await check();
      await ui.copyAll();
      await ui.blank();
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(2);
      await check();
      await ui.copyAll();
      await ui.load(source, 2);
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(4);
      const returned = await check(2);
      await ui.load(returned, 4);
      const final = await check(2);
      await testInfo.attach(`fixed-number-${kind}-${mode}.pptx`, {
        body: final,
        contentType: MIME,
      });
      expect(ui.errors).toEqual([]);
    });

for (const radarStyle of ["standard", "marker", "filled"])
  for (const mode of ["value", "combined", "range"])
    test(`${radarStyle} radar data labels retain ${mode} through clipboard both ways and download`, async ({
      page,
    }, testInfo) => {
      const f = chartRadarDataLabelPair(radarStyle, mode),
        source = Buffer.from(await P.savePresentation(f.p)),
        originals = P.getSlideCharts(f.slide).map((c) => ({
          spec: c.spec,
          book: workbook(f.p, c.shape).data.slice(),
        })),
        categories = originals[0].spec.categories,
        values = originals[0].spec.series[0].values,
        pink =
          mode === "range"
            ? ["0.0", "10.0"]
            : values.map((v, i) =>
                mode === "combined"
                  ? ["Signal", categories[i], v.toFixed(1)].join(" | ")
                  : v.toFixed(1),
              ),
        purple =
          mode === "range"
            ? ["-5.0", "0.0", "10.0", "15.0"]
            : mode === "combined"
              ? values.flatMap((v, i) => [
                  "Signal",
                  categories[i],
                  v.toFixed(1),
                ])
              : categories,
        ui = await setup(page);
      const check = async (sets = 1) => {
        const image = page.locator("#slide-canvas .slide-image");
        await image.evaluate((img) => img.decode());
        const svg = decodeURIComponent(
            (await image.getAttribute("src")).split(",").slice(1).join(","),
          ),
          elements = [],
          labelNodes = (color) =>
            elements.filter(
              (e) =>
                e.name.localName === "text" &&
                getAttrValue(e, qname("", "fill", "")) === color,
            ),
          text = (e) =>
            e.children
              .filter((c) => c.kind === "text")
              .map((c) => c.data)
              .join("");
        walkElements(parseXml(svg).root, (e) => elements.push(e));
        expect(labelNodes(radarDataLabelColor).map(text)).toEqual(
          Array.from({ length: sets }, () => pink).flat(),
        );
        expect(labelNodes(radarAlternateLabelColor).map(text)).toEqual(
          Array.from({ length: sets }, () => purple).flat(),
        );
        for (const e of labelNodes(radarAlternateLabelColor)) {
          expect(getAttrValue(e, qname("", "font-style", ""))).toBe("italic");
          expect(
            getAttrValue(e, qname("", "xml:space", "")) ??
              getAttrValue(
                e,
                qname("xml", "space", "http://www.w3.org/XML/1998/namespace"),
              ),
          ).toBe("preserve");
        }
        if (radarStyle === "filled") {
          const polygon = elements.find(
            (e) =>
              e.name.localName === "polygon" &&
              getAttrValue(e, qname("", "fill", "")) === "#E85239",
          );
          expect(polygon).toBeTruthy();
          expect(
            elements.indexOf(labelNodes(radarDataLabelColor)[0]),
          ).toBeGreaterThan(elements.indexOf(polygon));
        }
        const bytes = await ui.download(),
          result = await P.loadPresentation(bytes),
          charts = P.getSlideCharts(P.getSlides(result)[0]);
        expect(charts).toHaveLength(2 * sets);
        expect(new Set(charts.map((c) => chartRoot(c.shape))).size).toBe(
          2 * sets,
        );
        expect(
          new Set(charts.map((c) => workbook(result, c.shape).name)).size,
        ).toBe(2 * sets);
        for (const [i, chart] of charts.entries()) {
          expect(chart.spec).toEqual(originals[i % 2].spec);
          expect(workbook(result, chart.shape).data).toEqual(
            originals[i % 2].book,
          );
        }
        expect(P.validatePresentation(result)).toEqual([]);
        return Buffer.from(bytes);
      };
      await ui.load(source, 2);
      await check();
      await ui.copyAll();
      await ui.blank();
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(2);
      await check();
      await ui.copyAll();
      await ui.load(source, 2);
      await page.keyboard.press("Control+v");
      await expect(ui.objects).toHaveCount(4);
      const returned = await check(2);
      await ui.load(returned, 4);
      const final = await check(2);
      await testInfo.attach(`radar-data-label-${radarStyle}-${mode}.pptx`, {
        body: final,
        contentType: MIME,
      });
      expect(ui.errors).toEqual([]);
    });
