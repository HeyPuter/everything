// Picture formatting (color, artistic effects, styles, crop) and Edit Shape
// (Change Shape, Edit Points, Merge Shapes), checked in the downloaded file.
import { test, expect } from "@playwright/test";
import { zlibSync } from "fflate";
import {
  P,
  addShape,
  command,
  download,
  formatPane,
  menu,
  section,
  start,
  tab,
} from "./format-helpers.js";

test.setTimeout(120_000);

// A 40×20 PNG, wider than tall, made here so the test needs no fixture file.
function png(w = 40, h = 20) {
  const crc = (bytes) => {
    let c = ~0;
    for (const b of bytes) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      rows.set([x * 6, y * 12, 160], y * (w * 3 + 1) + 1 + x * 3);
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(rows)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return Buffer.from(out);
}

async function insertPicture(page) {
  const chooser = page.waitForEvent("filechooser");
  await menu(page, "Insert", "Image");
  await (
    await chooser
  ).setFiles({ name: "wide.png", mimeType: "image/png", buffer: png() });
  await expect(page.getByRole("tab", { name: "Picture Format" })).toBeVisible();
}

test("picture color, artistic effects, a picture style and cropping to a ratio", async ({
  page,
}) => {
  await start(page);
  await insertPicture(page);
  await tab(page, "Picture Format");
  await (await command(page, "picture-color")).click();
  await page.getByRole("menuitemradio", { name: "Saturation: 200%" }).click();
  await (await command(page, "picture-color")).click();
  await page.getByRole("menuitemradio", { name: "Grayscale" }).click();
  await (await command(page, "artistic-effects")).click();
  await page.getByRole("menuitemradio", { name: "Line drawing" }).click();
  await (await command(page, "crop")).click();
  await page.getByRole("menuitem", { name: "Aspect Ratio" }).click();
  await page.getByRole("menuitem", { name: "1:1", exact: true }).click();
  let { shapes } = await download(page);
  let pic = shapes[0];
  expect(P.getShapePictureAdjustments(pic)).toMatchObject({
    saturation: 2,
    artistic: { effect: "artisticLineDrawing" },
  });
  expect(P.getShapePictureRecolor(pic)).toEqual({ kind: "grayscale" });
  const crop = P.getShapeImageCrop(pic);
  expect(crop.left).toBeCloseTo(0.25, 2);
  expect(crop.right).toBeCloseTo(0.25, 2);
  const b = P.getShapeBounds(pic);
  expect(Math.abs(b.w - b.h)).toBeLessThan(10);

  // The pane's corrections and a picture style.
  const pane = await formatPane(page);
  const corrections = await section(pane, "corrections");
  const sharp = corrections.getByLabel("Sharpness", { exact: true }).last();
  await sharp.fill("40");
  await sharp.press("Tab");
  await expect(sharp).toHaveValue("40");
  await page
    .getByRole("button", { name: "Close format panel" })
    .click()
    .catch(() => {});
  await tab(page, "Picture Format");
  const style = page
    .getByRole("option", { name: "Rounded Corners, Soft Shadow" })
    .filter({ visible: true });
  if (!(await style.count()))
    await page
      .locator(
        '.ribbon-panel:not([hidden]) .ribbon-group[data-group="picture-styles"] .ribbon-fold',
      )
      .click();
  await style.first().click();
  let p;
  ({ shapes, p } = await download(page));
  pic = shapes[0];
  expect(P.getShapePictureAdjustments(pic).sharpness).toBeCloseTo(0.4);
  expect(P.getShapePreset(pic)).toBe("roundRect");
  expect(P.getShapeEffectSpec(p, pic).shadow).toMatchObject({
    type: "outer",
  });
});

test("Change Shape keeps the formatting; Edit Points reshapes a freeform", async ({
  page,
}) => {
  await start(page);
  await addShape(page, "Rectangle");
  await tab(page, "Shape Format");
  await (await command(page, "change-shape")).click();
  await page.getByRole("menuitem", { name: "Change Shape" }).click();
  await page
    .getByRole("menuitemradio", { name: "Star: 5 Points", exact: true })
    .click();
  let { shapes } = await download(page);
  expect(P.getShapePreset(shapes[0])).toBe("star5");
  const fill = P.getShapeFill(shapes[0]);

  await page.keyboard.press("Escape");
  await page.locator(".object-hit").first().click();
  await tab(page, "Shape Format");
  await (await command(page, "change-shape")).click();
  await page.getByRole("menuitem", { name: "Edit Points" }).click();
  const nodes = page.locator(".edit-points-layer .ep-node");
  await expect(nodes).toHaveCount(10);
  const node = await nodes.first().boundingBox();
  await page.mouse.move(node.x + node.width / 2, node.y + node.height / 2);
  await page.mouse.down();
  await page.mouse.move(node.x, node.y - 40, { steps: 4 });
  await page.mouse.up();
  await expect(nodes).toHaveCount(10);
  await page.locator(".edit-points-layer").press("Escape");
  await expect(page.locator(".edit-points-layer")).toHaveCount(0);
  let p;
  ({ shapes, p } = await download(page));
  expect(P.getShapeGeometryEffective(p, shapes[0]).kind).toBe("custom");
  expect(P.getShapeFill(shapes[0])).toEqual(fill);
});

test("Merge Shapes: union, fragment and subtract", async ({ page }) => {
  await start(page);
  await addShape(page, "Rectangle");
  await addShape(page, "Circle");
  await menu(page, "Edit", "Select all");
  await tab(page, "Shape Format");
  await (await command(page, "merge-shapes")).click();
  await page.getByRole("menuitem", { name: "Fragment", exact: true }).click();
  await expect(page.locator(".object-hit")).not.toHaveCount(2);
  let { shapes } = await download(page);
  expect(shapes.length).toBeGreaterThan(2);
  expect(shapes.every((s) => P.getShapeCustomGeometry(s))).toBe(true);

  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  await expect(page.locator(".object-hit")).toHaveCount(2);
  await menu(page, "Edit", "Select all");
  await tab(page, "Shape Format");
  await (await command(page, "merge-shapes")).click();
  await page.getByRole("menuitem", { name: "Union", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(1);
  ({ shapes } = await download(page));
  expect(shapes).toHaveLength(1);

  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  await expect(page.locator(".object-hit")).toHaveCount(2);
  await menu(page, "Edit", "Select all");
  await tab(page, "Shape Format");
  await (await command(page, "merge-shapes")).click();
  await page.getByRole("menuitem", { name: "Subtract", exact: true }).click();
  await expect(page.locator(".object-hit")).toHaveCount(1);
  ({ shapes } = await download(page));
  expect(shapes).toHaveLength(1);
  expect(P.getShapeName(shapes[0])).toMatch(/^Rectangle/);
});

test("Text Outline on Shape Format outlines the letters, and No Outline removes it", async ({
  page,
}) => {
  await start(page);
  await menu(page, "Insert", "Text box");
  await page.locator(".object-hit").first().dblclick();
  await page.keyboard.type("Outlined");
  await page.keyboard.press("Escape");
  await tab(page, "Shape Format");
  await (await command(page, "text-outline")).click();
  let { slideXml } = await download(page);
  expect(slideXml()).toMatch(
    /<a:rPr[^>]*><a:ln w="9525"><a:solidFill><a:schemeClr val="tx1"\/><\/a:solidFill><\/a:ln>/,
  );

  await page.locator(".object-hit").first().click();
  await tab(page, "Shape Format");
  // A narrow ribbon folds the split button's menu half away with it.
  await command(page, "text-outline");
  await page
    .getByRole("button", { name: "Text outline colors" })
    .filter({ visible: true })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "No Outline" }).click();
  ({ slideXml } = await download(page));
  expect(slideXml()).toContain("Outlined");
  expect(slideXml()).not.toContain("<a:ln");
});
