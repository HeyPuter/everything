import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, MIME } from "../src/model.js";
import {
  textFieldCopyDeck,
  shapeFields,
  partFields,
  fieldToken,
} from "../tests/text-field-copy-fixture.js";
import { readShapeDiagram } from "../lib/pptx/src/api/fn/diagram-read.ts";
import {
  NS,
  qname,
  firstChildElement,
  getAttrValue,
  textContent,
} from "../lib/pptx/src/internal/xml/index.ts";

test("native text, table and cached diagram fields remain distinct through clipboard transfer and return", async ({
  page,
}) => {
  test.setTimeout(60000);
  const { p } = await textFieldCopyDeck(),
    source = Buffer.from(await P.savePresentation(p));
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
  const load = async (buffer, count) => {
    if (await back.isVisible()) await back.click();
    const event = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await event
    ).setFiles({ name: "Native fields.pptx", mimeType: MIME, buffer });
    // The editor, not the library it was opened from, before counting.
    await expect(page.locator("#slide-position")).toBeVisible();
    await expect(back).toBeVisible();
    await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
    await expect(objects).toHaveCount(count);
  };
  const download = async () => {
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
  };
  const inspect = async (bytes, expected) => {
    const pres = await P.loadPresentation(bytes),
      slide = P.getSlides(pres)[0],
      shapes = P.getSlideShapes(slide),
      fields = shapes.flatMap(shapeFields);
    for (const shape of shapes.filter(P.isDiagramShape)) {
      const diagram = readShapeDiagram(shape),
        data = partFields(diagram.data.part),
        drawing = partFields(diagram.drawing.part);
      expect(data).toHaveLength(1);
      expect(drawing).toHaveLength(1);
      expect(fieldToken(data[0]).toUpperCase()).toBe(
        fieldToken(drawing[0]).toUpperCase(),
      );
      fields.push(...data);
    }
    expect(fields).toHaveLength(expected);
    const ids = fields.map(fieldToken);
    expect(new Set(ids.map((id) => id.toUpperCase())).size).toBe(expected);
    for (const field of fields) {
      expect(fieldToken(field)).toMatch(
        /^\{[\dA-F]{8}-[\dA-F]{4}-[\dA-F]{4}-[\dA-F]{4}-[\dA-F]{12}\}$/,
      );
      expect(getAttrValue(field, qname("", "type", ""))).toBe("owned.custom");
      expect(
        textContent(firstChildElement(field, qname("a", "t", NS.dml))),
      ).toBe("native cache");
      const properties = firstChildElement(field, qname("a", "rPr", NS.dml));
      expect(getAttrValue(properties, qname("", "b", ""))).toBe("1");
      expect(getAttrValue(properties, qname("", "sz", ""))).toBe("1200");
    }
    expect(P.validatePresentation(pres)).toEqual([]);
    return ids;
  };
  const originalIds = await inspect(source, 3);
  await load(source, 3);
  await objects.first().click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+c");
  await back.click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await expect(back).toBeVisible();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  await expect(objects).toHaveCount(0);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(3);
  const forward = await download();
  await inspect(forward, 3);
  await load(forward, 3);
  await objects.first().click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+c");
  await load(source, 3);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(6);
  const returned = await download(),
    returnedIds = await inspect(returned, 6);
  expect(returnedIds.filter((id) => originalIds.includes(id))).toHaveLength(3);
  await load(returned, 6);
  expect(await inspect(await download(), 6)).toEqual(returnedIds);
  expect(errors).toEqual([]);
});
