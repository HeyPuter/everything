// A connector glued to a shape follows it while the shape is dragged, not
// only once it is let go, and ends on the shape's connection point.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, MIME, parseDeck } from "../src/model.js";

const I = 914400;

async function deck() {
  const pres = P.createPresentation();
  const slide = P.addBlankSlide(pres);
  const box = (name, x, y) =>
    P.addSlideShape(slide, {
      preset: "rect",
      name,
      x: x * I,
      y: y * I,
      w: 2 * I,
      h: 1 * I,
      text: name,
    });
  const a = box("Start", 1, 1);
  const b = box("Finish", 8, 4);
  const line = P.addSlideLine(slide, {
    name: "Link",
    from: { x: 3 * I, y: 1.5 * I },
    to: { x: 8 * I, y: 4.5 * I },
  });
  P.setConnectorConnections(line, {
    start: { id: P.getShapeId(a), site: 3 },
    end: { id: P.getShapeId(b), site: 1 },
  });
  return Buffer.from(await P.savePresentation(pres));
}

test("a glued connector follows its shape during the drag and after", async ({
  page,
}) => {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: "Glued.pptx", mimeType: MIME, buffer: await deck() });
  await expect(page.locator(".object-hit")).toHaveCount(3);
  const finish = page
    .locator("#slide-canvas")
    .getByRole("button", { name: /^Finish/ });
  const b = await finish.boundingBox();
  const x = b.x + b.width / 2,
    y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x - i * 6, y - i * 5);
  // While the pointer is down, the connector's own layer is reshaped.
  await expect
    .poll(() =>
      page
        .locator(".drag-layer")
        .evaluateAll((layers) =>
          layers.some((layer) => layer.style.transform.startsWith("matrix(")),
        ),
    )
    .toBe(true);
  await page.mouse.up();
  await page
    .getByRole("menuitem", { name: "File", exact: true })
    .or(page.getByRole("button", { name: "File options" }))
    .filter({ visible: true })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const saved = await parseDeck(
    new Uint8Array(await readFile(await (await download).path())),
  );
  const shapes = P.getSlideShapes(P.getSlides(saved)[0]);
  const moved = P.getShapeBounds(
    shapes.find((s) => P.getShapeName(s) === "Finish"),
  );
  const link = shapes.find((s) => P.getShapeName(s) === "Link");
  const lb = P.getShapeBounds(link),
    flip = P.getShapeFlip(link) || {};
  const end = {
    x: flip.horizontal ? lb.x : lb.x + lb.w,
    y: flip.vertical ? lb.y : lb.y + lb.h,
  };
  expect(moved.x).toBeLessThan(8 * I);
  expect(Math.abs(end.x - moved.x)).toBeLessThan(2);
  expect(Math.abs(end.y - (moved.y + moved.h / 2))).toBeLessThan(2);
});
