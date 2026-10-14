// The Draw tab: pen and highlighter strokes become freeform shapes, and the
// eraser removes them.
import { test, expect as baseExpect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { P, parseDeck } from "../src/model.js";

test.setTimeout(90_000);
// Phones render each stroke at three times the pixels; give them time.
const expect = baseExpect.configure({ timeout: 15_000 });

async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/");
  await page.getByRole("tab", { name: "Draw" }).click();
}
// Points are on an 800 × 450 grid laid over the canvas, whatever its size on
// the screen.
async function stroke(page, points) {
  const b = await page.locator("#slide-canvas").boundingBox();
  const at = ([x, y]) => [
    b.x + (x / 800) * b.width,
    b.y + (y / 450) * b.height,
  ];
  await page.mouse.move(...at(points[0]));
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...at(p));
  await page.mouse.up();
}
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
  const bytes = await readFile(await (await event).path());
  const p = await parseDeck(bytes);
  return {
    p,
    xml: strFromU8(
      unzipSync(bytes)[P.getSlidePartName(P.getSlides(p)[0]).slice(1)],
    ),
  };
}

test("pen and highlighter strokes are saved as smooth freeforms", async ({
  page,
}) => {
  await start(page);
  await page.locator('[data-command="draw-pen2"]').click();
  await expect(page.locator('[data-command="draw-pen2"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await stroke(
    page,
    Array.from({ length: 30 }, (_, i) => [
      100 + i * 10,
      200 + Math.sin(i / 3) * 40,
    ]),
  );
  await page.locator('[data-command="draw-highlighter"]').click();
  await stroke(
    page,
    Array.from({ length: 15 }, (_, i) => [100 + i * 20, 350]),
  );
  await expect(page.locator(".object-hit")).toHaveCount(2);
  const { p, xml } = await download(page);
  const shapes = P.getSlideShapes(P.getSlides(p)[0]);
  expect(shapes).toHaveLength(2);
  expect(xml.match(/<a:custGeom>/g)).toHaveLength(2);
  expect(xml).toContain("<a:cubicBezTo>");
  expect(xml).toContain('<a:path w="');
  expect(xml).toContain('fill="none"');
  expect(xml).toMatch(/<a:srgbClr val="E81224"\/>/);
  expect(xml).toMatch(
    /<a:srgbClr val="FFFF00"><a:alpha val="50000"\/><\/a:srgbClr>/,
  );
  expect(xml).toMatch(/cap="rnd"/);
});

test("the eraser removes the stroke it crosses, and Escape puts the pen down", async ({
  page,
}) => {
  await start(page);
  await page.locator('[data-command="draw-pen1"]').click();
  await stroke(page, [
    [100, 100],
    [200, 100],
    [300, 100],
  ]);
  await stroke(page, [
    [100, 300],
    [200, 300],
    [300, 300],
  ]);
  await expect(page.locator(".object-hit")).toHaveCount(2);
  await page.locator('[data-command="draw-eraser"]').click();
  await stroke(page, [
    [200, 80],
    [200, 120],
  ]);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".ink-layer")).toHaveCount(0);
  await expect(page.locator('[data-command="draw-select"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const { p } = await download(page);
  expect(P.getSlideShapes(P.getSlides(p)[0])).toHaveLength(1);
});
