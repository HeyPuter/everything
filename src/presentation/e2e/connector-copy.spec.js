import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, MIME } from "../src/model.js";
import {
  connectorCopyDeck,
  connections,
} from "../tests/connector-copy-fixture.js";

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

async function inspect(bytes, { grouped = false, sets = 1 } = {}) {
  const p = await P.loadPresentation(bytes),
    shapes = P.getSlideShapes(P.getSlides(p)[0]);
  expect(shapes).toHaveLength(sets * (grouped ? 4 : 3));
  const ids = shapes.map(P.getShapeId);
  expect(new Set(ids).size).toBe(ids.length);
  for (let i = 0; i < sets; i++) {
    const selected = grouped
        ? P.getGroupChildren(shapes[i * 4])
        : shapes.slice(i * 3, i * 3 + 3),
      line = selected.find((s) => P.getShapeKind(s) === "connector"),
      boxes = selected.filter((s) => P.getShapeName(s).startsWith("Endpoint"));
    expect(connections(line)).toEqual([
      { end: "stCxn", id: String(P.getShapeId(boxes[0])), site: "2" },
      { end: "endCxn", id: String(P.getShapeId(boxes[1])), site: "0" },
    ]);
  }
  expect(P.validatePresentation(p)).toEqual([]);
  return ids;
}

for (const grouped of [false, true])
  test(`native connector ${grouped ? "groups" : "selections"} stay attached through clipboard both ways and undo`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    const { p } = await connectorCopyDeck({ grouped }),
      source = Buffer.from(await P.savePresentation(p)),
      count = grouped ? 4 : 3,
      ui = await setup(page);
    const sourceIds = await inspect(source, { grouped });
    await ui.load(source, count);
    await ui.copyAll();
    await ui.blank();
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(count);
    const forward = await ui.download();
    await inspect(forward, { grouped });
    await ui.copyAll();
    await ui.load(source, count);
    await page.keyboard.press("Control+v");
    await expect(ui.objects).toHaveCount(count * 2);
    await page.keyboard.press("Control+z");
    await expect(ui.objects).toHaveCount(count);
    await page.keyboard.press("Control+Shift+z");
    await expect(ui.objects).toHaveCount(count * 2);
    const returned = await ui.download(),
      ids = await inspect(returned, { grouped, sets: 2 });
    expect(ids.slice(0, count)).toEqual(sourceIds);
    await ui.load(returned, count * 2);
    await inspect(await ui.download(), { grouped, sets: 2 });
    expect(ui.errors).toEqual([]);
  });

test("duplicate preserves selected attachments and copying a connector alone detaches missing endpoints", async ({
  page,
}) => {
  const { p } = await connectorCopyDeck(),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  await ui.load(source, 3);
  await ui.objects.last().click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+d");
  await expect(ui.objects).toHaveCount(6);
  await inspect(await ui.download(), { sets: 2 });
  await ui.load(source, 3);
  await ui.objects.first().click();
  await page.keyboard.press("Control+c");
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(1);
  const detached = await P.loadPresentation(await ui.download()),
    line = P.getSlideShapes(P.getSlides(detached)[0])[0];
  expect(connections(line)).toEqual([]);
  expect(P.getShapeBounds(line)).toEqual(
    P.getShapeBounds(P.getSlideShapes(P.getSlides(p)[0])[0]),
  );
  expect(ui.errors).toEqual([]);
});

test("selected group children retain their connections when extracted for clipboard and duplicate", async ({
  page,
}) => {
  const { p } = await connectorCopyDeck({ grouped: true }),
    source = Buffer.from(await P.savePresentation(p)),
    ui = await setup(page);
  const selectChildren = async () => {
    await page.locator('.object-hit[data-shape-id="11"]').click();
    await page
      .locator('.object-hit[data-shape-id="47"]')
      .click({ modifiers: ["Shift"] });
    await page
      .locator('.object-hit[data-shape-id="103"]')
      .click({ modifiers: ["Shift"] });
    await expect(page.locator('.object-hit[aria-pressed="true"]')).toHaveCount(
      3,
    );
  };
  await ui.load(source, 4);
  await selectChildren();
  await page.keyboard.press("Control+c");
  await ui.blank();
  await page.keyboard.press("Control+v");
  await expect(ui.objects).toHaveCount(3);
  await inspect(await ui.download());
  await ui.load(source, 4);
  await selectChildren();
  await page.keyboard.press("Control+d");
  await expect(ui.objects).toHaveCount(7);
  const copied = await P.loadPresentation(await ui.download()),
    shapes = P.getSlideShapes(P.getSlides(copied)[0]),
    added = shapes.slice(4),
    line = added.find((s) => P.getShapeKind(s) === "connector"),
    boxes = added.filter((s) => P.getShapeName(s).startsWith("Endpoint"));
  expect(connections(line)).toEqual([
    { end: "stCxn", id: String(P.getShapeId(boxes[0])), site: "2" },
    { end: "endCxn", id: String(P.getShapeId(boxes[1])), site: "0" },
  ]);
  await page.keyboard.press("Control+z");
  await expect(ui.objects).toHaveCount(4);
  expect(ui.errors).toEqual([]);
});
