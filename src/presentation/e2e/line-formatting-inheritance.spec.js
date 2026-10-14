import { test, expect } from "@playwright/test";
import { inspector } from "./editor-commands.js";
import { readFile } from "node:fs/promises";
import { P, parseDeck, MIME } from "../src/model.js";
import {
  lineFormattingFixture,
  lineProperties,
} from "../tests/line-formatting-fixture.js";

const load = async (page, f, name) => {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({ name, mimeType: MIME, buffer: Buffer.from(f.bytes) });
  await expect(page.locator(".object-hit")).toHaveCount(1);
};
const outline = (page) =>
  page.locator(".slide-image").evaluate(async (img) => {
    await img.decode();
    const doc = new DOMParser().parseFromString(
      await (await fetch(img.src)).text(),
      "image/svg+xml",
    );
    return [...doc.querySelectorAll('[stroke="#315E87"]')].map((el) => ({
      dash: el.getAttribute("stroke-dasharray"),
      cap: el.getAttribute("stroke-linecap"),
      join: el.getAttribute("stroke-linejoin"),
    }));
  });
const download = async (page) => {
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
};

test("inherited line decorations match before and after clipboard transfer, editing and download", async ({
  page,
}) => {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  const source = await lineFormattingFixture({
    layout: lineProperties(
      '<a:custDash><a:ds d="250000" sp="75000"/><a:ds d="50000" sp="125000"/></a:custDash><a:bevel/>',
      'cap="sq"',
    ),
  });
  const destination = await lineFormattingFixture({
    layout: lineProperties('<a:prstDash val="dot"/><a:round/>', 'cap="rnd"'),
    bounds: { x: P.inches(6), y: P.inches(1), w: P.inches(3), h: P.inches(2) },
  });
  await page.goto("/#/home");
  await load(page, source, "Custom line source.pptx");
  const expected = {
    dash: "15.00 4.50 3.00 7.50",
    cap: "square",
    join: "bevel",
  };
  expect(await outline(page)).toEqual([expected]);
  await page.locator(".object-hit").click();
  const showFormat = () => inspector(page);
  await showFormat();
  const style = page.getByRole("combobox", {
    name: "Border style",
    exact: true,
  });
  await expect(style).toHaveValue("custom");
  await page.keyboard.press("Control+c");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await load(page, destination, "Custom line destination.pptx");
  expect(await outline(page)).toEqual([
    { dash: "6.00 18.00", cap: "round", join: "round" },
  ]);
  await page.keyboard.press("Control+v");
  await expect(page.locator(".object-hit")).toHaveCount(2);
  expect(await outline(page)).toEqual([
    { dash: "6.00 18.00", cap: "round", join: "round" },
    expected,
  ]);
  await showFormat();
  await expect(style).toHaveValue("custom");
  let saved = await download(page),
    shapes = P.getSlideShapes(P.getSlides(saved)[0]);
  expect(P.getShapeStrokeFormattingEffective(shapes[1])).toEqual(
    P.getShapeStrokeFormattingEffective(source.shape),
  );
  await style.selectOption("solid");
  expect((await outline(page))[1]).toEqual({ ...expected, dash: null });
  await page.keyboard.press("Control+z");
  await page.locator(".object-hit").last().click();
  await showFormat();
  await expect(style).toHaveValue("custom");
  expect((await outline(page))[1]).toEqual(expected);
  await page.keyboard.press("Control+y");
  await page.locator(".object-hit").last().click();
  await showFormat();
  await expect(style).toHaveValue("solid");
  saved = await download(page);
  shapes = P.getSlideShapes(P.getSlides(saved)[0]);
  expect(P.getShapeXmlString(shapes[1])).not.toContain("custDash");
  expect(P.getShapeStrokeDash(shapes[1])).toBe("solid");
  await page.locator(".object-hit").last().click();
  await page.keyboard.press("Control+c");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await load(page, source, "Custom line return.pptx");
  await page.keyboard.press("Control+v");
  await expect(page.locator(".object-hit")).toHaveCount(2);
  expect(await outline(page)).toEqual([expected, { ...expected, dash: null }]);
});
