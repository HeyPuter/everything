import { test, expect } from "@playwright/test";
import { inspector } from "./editor-commands.js";
import { readFile } from "node:fs/promises";
import { P, parseDeck, MIME } from "../src/model.js";
import {
  NS,
  parseXml,
  walkElements,
  getAttrValue,
  qname,
} from "../lib/pptx/src/internal/xml/index.ts";
import {
  solidPaintCases,
  solidPaintInheritanceFixture,
} from "../tests/solid-paint-inheritance-fixture.js";
async function load(page, bytes) {
  const back = page.getByRole("button", { name: "Back to presentations" });
  if (await back.isVisible()) await back.click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Inherited paint.pptx",
    mimeType: MIME,
    buffer: Buffer.from(bytes),
  });
  // The editor, not the library it was opened from, before counting.
  await expect(page.locator("#slide-position")).toBeVisible();
  await expect(page.locator(".object-hit")).toHaveCount(
    solidPaintCases.length * 2,
  );
}
function retainedLuminance(shape) {
  const values = [];
  walkElements(parseXml(P.getShapeXmlString(shape)).root, (el) => {
    if (el.name.namespaceURI === NS.dml && el.name.localName === "lumMod")
      values.push(getAttrValue(el, qname("", "val", "")));
  });
  expect(values).toEqual(["50000", "50000"]);
}
async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
}
async function paint(page, selector = ".slide-image") {
  return page.locator(selector).evaluate(async (img) => {
    await img.decode();
    const svg = await (await fetch(img.src)).text(),
      doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    return [...doc.querySelectorAll("g[data-pptx-shape-name]")].map((group) => {
      const rect = group.querySelector("rect");
      if (!rect) return null;
      const alpha = group.querySelector("[fill-opacity]");
      return {
        fill: rect.getAttribute("fill"),
        stroke: rect.getAttribute("stroke"),
        opacity: Number(alpha?.getAttribute("fill-opacity") ?? 1),
      };
    });
  });
}
const assertRgb = (actual, expected) => {
  if (expected === null) {
    expect(actual).toBe("none");
    return;
  }
  expect(actual).toMatch(/^#[0-9a-f]{6}$/i);
  for (let i = 0; i < 3; i++)
    expect(
      Math.abs(parseInt(actual.slice(1 + i * 2, 3 + i * 2), 16) - expected[i]),
    ).toBeLessThanOrEqual(1);
};
async function download(page) {
  await page
    .getByRole("menuitem", { name: "File", exact: true })
    .or(page.getByRole("button", { name: "File options" }))
    .filter({ visible: true })
    .click();
  const event = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  return parseDeck(await readFile(await (await event).path()));
}
test("native inherited solid colors, alpha and local overrides survive slideshow and PPTX download", async ({
  page,
}) => {
  await start(page);
  const bytes = await solidPaintInheritanceFixture();
  await load(page, bytes);
  const source = await paint(page);
  for (const [i, c] of solidPaintCases.entries()) {
    const p = source[i * 2];
    assertRgb(p.fill, c.rgb);
    assertRgb(p.stroke, c.strokeRgb);
    expect(p.opacity).toBe(c.opacity);
  }
  await page.getByRole("button", { name: "Present", exact: true }).click();
  expect(await paint(page, ".presenter-slide")).toEqual(source);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".presenter-end")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".presenter-controls")).toContainText("1 / 1");
  await page.keyboard.press("Escape");
  const saved = await download(page);
  await load(page, await P.savePresentation(saved));
  expect(await paint(page)).toEqual(source);
});
test("inherited fill and outline transforms keep their appearance through object clipboard forward and return", async ({
  page,
}) => {
  await start(page);
  const bytes = await solidPaintInheritanceFixture();
  await load(page, bytes);
  const source = await paint(page),
    objects = page.locator(".object-hit");
  await objects.nth(2).click();
  await objects.nth(4).click({ modifiers: ["Shift"] });
  await page.keyboard.press("Control+c");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(2);
  expect(await paint(page)).toEqual([source[2], source[4]]);
  const copied = await download(page);
  for (const sh of P.getSlideShapes(P.getSlides(copied)[0])) {
    retainedLuminance(sh);
    expect(P.getShapeFillColorResolved(copied, sh)).toBe("#182F44");
    expect(P.getShapeStrokeColorResolved(copied, sh)).toBe("#182F44");
  }
  await objects.nth(0).click();
  await objects.nth(1).click({ modifiers: ["Shift"] });
  await page.keyboard.press("Control+c");
  await load(page, bytes);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(solidPaintCases.length * 2 + 2);
  expect((await paint(page)).slice(-2)).toEqual([source[2], source[4]]);
  const returned = await download(page);
  for (const sh of P.getSlideShapes(P.getSlides(returned)[0]).slice(-2)) {
    retainedLuminance(sh);
    expect(P.getShapeFillColorResolved(returned, sh)).toBe("#182F44");
  }
});

test("inherited transformed paint informs color controls and readable new shape text", async ({
  page,
}) => {
  await start(page);
  await load(page, await solidPaintInheritanceFixture());
  const shape = page.locator(".object-hit").nth(2);
  await shape.click();
  await inspector(page);
  await expect(page.locator('input[aria-label="Fill color"]')).toHaveValue(
    "#182f44",
  );
  await expect(page.locator('input[aria-label="Border color"]')).toHaveValue(
    "#182f44",
  );
  if (page.viewportSize().width <= 1150)
    await page
      .getByRole("button", { name: "Close format panel", exact: true })
      .click();
  await shape.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeVisible();
  await editor.fill("Readable inherited panel");
  await editor.press("Control+Enter");
  const saved = await download(page),
    s = P.getSlides(saved)[0],
    sh = P.getSlideShapes(s)[2];
  expect(P.getShapeRunFormatEffective(saved, sh, 0, 0).color).toBe("#FFFFFF");
  expect(P.getShapeFill(sh).kind).toBe("inherit");
  expect(P.getShapeFillColorResolvedEffective(saved, sh)).toBe("#182F44");
});
