import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, MIME } from "../src/model.js";
import { diagramRangeDeck, fieldId } from "../tests/diagram-range-fixture.js";
import { readShapeDiagram } from "../lib/pptx/src/api/fn/diagram-read.ts";
import {
  paragraphsOf,
  textBodyText,
} from "../lib/pptx/src/internal/drawingml/text-body.ts";
import {
  NS,
  qname,
  allChildElements,
  serializeFragment,
  getAttrValue,
} from "../lib/pptx/src/internal/xml/index.ts";

test("typing in semantic diagram entries retains rich runs, soft breaks, live fields, undo, export and clipboard both ways", async ({
  page,
}) => {
  test.setTimeout(60000);
  const { p } = await diagramRangeDeck(),
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
    objects = page.locator(".object-hit"),
    modal = page.getByRole("dialog", { name: "Edit diagram text" });
  const load = async (buffer, count = 1) => {
    if (await back.isVisible()) await back.click();
    const event = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await event
    ).setFiles({ name: "Rich native diagram.pptx", mimeType: MIME, buffer });
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
  const assertRich = async (buffer, count = 1, originalId = false) => {
    const pres = await P.loadPresentation(buffer),
      frames = P.getSlideShapes(P.getSlides(pres)[0]).filter(P.isDiagramShape);
    expect(frames).toHaveLength(count);
    const fieldIds = [];
    for (const frame of frames) {
      const body = readShapeDiagram(frame).model.point("node0").text,
        ps = paragraphsOf(body);
      expect(textBodyText(body)).toBe(
        "Title revised\nBody 1 line\nTail end\nSoft",
      );
      expect(ps).toHaveLength(2);
      expect(allChildElements(ps[0], qname("a", "br", NS.dml))).toHaveLength(1);
      const fields = allChildElements(ps[0], qname("a", "fld", NS.dml));
      expect(fields).toHaveLength(1);
      const id = getAttrValue(fields[0], qname("", "id", ""));
      expect(id).toMatch(
        /^\{[\dA-F]{8}-[\dA-F]{4}-[\dA-F]{4}-[\dA-F]{4}-[\dA-F]{12}\}$/,
      );
      expect(getAttrValue(fields[0], qname("", "type", ""))).toBe("slidenum");
      expect(serializeFragment(fields[0])).toContain("<a:t>1</a:t>");
      if (originalId) expect(id).toBe(fieldId);
      fieldIds.push(id);
      expect(allChildElements(ps[1], qname("a", "br", NS.dml))).toHaveLength(1);
      const runs = allChildElements(ps[0], qname("a", "r", NS.dml));
      expect(serializeFragment(runs[1])).toContain('b="1"');
      expect(serializeFragment(runs[2])).toContain('b="0"');
    }
    expect(new Set(fieldIds).size).toBe(count);
    expect(P.validatePresentation(pres)).toEqual([]);
  };
  await load(source);
  await objects.dblclick();
  const input = modal.getByRole("textbox", {
    name: "Item 1 text",
    exact: true,
  });
  await expect(input).toHaveValue("Title\nBody 1 line\nTail");
  // Native textarea undo must restore the live field's original edit history,
  // rather than replaying a literal replacement of its cached characters.
  await input.evaluate((t) => {
    t.focus();
    t.setSelectionRange(11, 12);
  });
  await input.pressSequentially("X");
  await input.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(input).toHaveValue("Title\nBody 1 line\nTail");
  await input.evaluate((t) => {
    t.focus();
    t.setSelectionRange(5, 5);
  });
  await input.pressSequentially(" revised");
  await input.evaluate((t) =>
    t.setSelectionRange(t.value.length, t.value.length),
  );
  await input.pressSequentially(" end");
  await input.press("Shift+Enter");
  await input.pressSequentially("Soft");
  await modal.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(modal).toHaveCount(0);
  await assertRich(await download(), 1, true);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  const undo = await P.loadPresentation(await download()),
    restored = readShapeDiagram(
      P.getSlideShapes(P.getSlides(undo)[0])[0],
    ).model.point("node0").text;
  expect(textBodyText(restored)).toBe("Title\nBody 1 line\nTail");
  expect(serializeFragment(restored)).toContain(fieldId);
  expect(paragraphsOf(restored)).toHaveLength(2);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  const edited = await download();
  await assertRich(edited, 1, true);
  await load(edited);
  await objects.click();
  await page.keyboard.press("Control+c");
  await back.click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await expect(back).toBeVisible();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  await expect(objects).toHaveCount(0);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(1);
  const forward = await download();
  await assertRich(forward);
  await load(forward);
  await objects.click();
  await page.keyboard.press("Control+c");
  await load(edited);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(2);
  const returned = await download();
  await assertRich(returned, 2);
  await load(returned, 2);
  await assertRich(await download(), 2);
  expect(errors).toEqual([]);
});
