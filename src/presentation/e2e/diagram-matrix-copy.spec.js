import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, createDeck, parseDeck, MIME } from "../src/model.js";
import {
  diagramMatrixDeck,
  decode,
} from "../tests/diagram-matrix-copy-fixture.js";
import { readShapeDiagram } from "../lib/pptx/src/api/fn/diagram-read.ts";

for (const [cached, image, index] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
  [false, false, " +2 "],
  [true, true, " +2 "],
])
  test(`diagram matrix paint survives clipboard, export and return copy: saved=${cached} image=${image} index=${index ?? 2}`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("https://js.puter.com/v2/", (r) =>
      r.fulfill({
        contentType: "application/javascript",
        body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
      }),
    );
    await page.goto("/#/home");
    const { p, diagram: sourceDiagram } = await diagramMatrixDeck({
      cached,
      image,
    });
    if (index)
      for (const part of [
        sourceDiagram.quickStyle.part,
        sourceDiagram.drawing?.part,
      ].filter(Boolean))
        part.data = new TextEncoder().encode(
          decode(part).replaceAll('idx="2"', `idx="${index}"`),
        );
    const original = await P.savePresentation(p);
    const objects = page.locator(".object-hit");
    async function load(bytes, count) {
      const back = page.getByRole("button", { name: "Back to presentations" });
      if (await back.isVisible()) await back.click();
      const chooser = page.waitForEvent("filechooser");
      await page
        .getByRole("button", { name: "Import PPTX", exact: true })
        .click();
      await (
        await chooser
      ).setFiles({
        name: "Diagram matrix control.pptx",
        mimeType: MIME,
        buffer: Buffer.from(bytes),
      });
      // The editor, not the library it was opened from, before counting.
      await expect(page.locator("#slide-position")).toBeVisible();
      // A blank deck and the import screen both have zero objects. Wait for
      // the loaded editor before sending canvas clipboard shortcuts.
      await expect(back).toBeVisible();
      await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
      await expect(objects).toHaveCount(count);
    }
    async function copy() {
      const hit = objects.first();
      await hit.focus();
      await hit.press("Space");
      await expect(hit).toHaveAttribute("aria-pressed", "true");
      await hit.focus();
      await page.keyboard.press("Control+c");
    }
    async function download() {
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
      const p = await parseDeck(bytes);
      expect(P.validatePresentation(p)).toEqual([]);
      return { bytes, p };
    }
    const svg = () =>
      page.locator(".slide-image").evaluate(async (img) => {
        await img.decode();
        return (await fetch(img.src)).text();
      });
    const normalize = (markup) => {
      const ids = new Map();
      return markup.replace(/pkdef-[\da-z]+/g, (id) => {
        if (!ids.has(id)) ids.set(id, `def-${ids.size}`);
        return ids.get(id);
      });
    };
    await load(original, 1);
    const originalSvg = normalize(await svg());
    expect(originalSvg).toContain('stroke-width="9.45"');
    expect(originalSvg).not.toContain("data-pptx-diagram-issues");
    await copy();
    const blank = createDeck("blank"),
      targetTheme = P.getPresentationTheme(blank);
    await load(await P.savePresentation(blank), 0);
    await page.keyboard.press("Control+v");
    await expect(objects).toHaveCount(1);
    expect(normalize(await svg())).toBe(originalSvg);
    // Semantic text edits must retain the imported source paint matrix.
    if (!cached) {
      await objects.dblclick();
      const modal = page.getByRole("dialog", { name: "Edit diagram text" });
      await modal
        .getByRole("textbox", { name: "Item 1 text", exact: true })
        .fill("Copied label");
      await modal.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(modal).toHaveCount(0);
      await expect.poll(svg).toContain("Copied label");
      expect(await svg()).toContain('stroke-width="9.45"');
    }
    const forward = await download(),
      frame = P.getSlideShapes(P.getSlides(forward.p)[0])[0],
      diagram = readShapeDiagram(frame);
    expect(decode(diagram.quickStyle.part)).not.toContain('lnRef idx="2"');
    if (!cached)
      expect(P.getShapeDiagramTextEntries(frame)[0].text).toBe("Copied label");
    expect(P.getPresentationTheme(forward.p)).toEqual(targetTheme);
    const editedSvg = normalize(await svg());
    await load(forward.bytes, 1);
    expect(normalize(await svg())).toBe(editedSvg);
    await copy();
    await load(original, 1);
    await page.keyboard.press("Control+v");
    await expect(objects).toHaveCount(2);
    const returned = await download(),
      frames = P.getSlideShapes(P.getSlides(returned.p)[0]);
    expect(decode(readShapeDiagram(frames[0]).quickStyle.part)).toBe(
      decode(sourceDiagram.quickStyle.part),
    );
    expect(decode(readShapeDiagram(frames[1]).data.part)).toBe(
      decode(diagram.data.part),
    );
    if (!cached)
      expect(P.getShapeDiagramTextEntries(frames[1])[0].text).toBe(
        "Copied label",
      );
    expect(await svg()).toContain('stroke-width="9.45"');
    expect(await svg()).not.toContain("data-pptx-diagram-issues");
    expect(errors).toEqual([]);
  });
