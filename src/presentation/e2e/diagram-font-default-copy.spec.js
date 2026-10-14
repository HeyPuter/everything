import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, createDeck, parseDeck, preview, MIME } from "../src/model.js";
import { implicitFontDeck } from "../tests/diagram-font-default-copy-fixture.js";
import { decode } from "../tests/diagram-font-copy-fixture.js";
import { readShapeDiagram } from "../lib/pptx/src/api/fn/diagram-read.ts";

for (const cached of [false, true])
  test(`implicit diagram fonts survive clipboard, export and return copy: saved=${cached}`, async ({
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
    const { p } = await implicitFontDeck({ cached }),
      original = await P.savePresentation(p);
    const editedSource = await parseDeck(original),
      editedSlide = P.getSlides(editedSource)[0];
    P.replaceShapeDiagramText(P.getSlideShapes(editedSlide)[0], [
      { modelId: "node0", text: "Copied label" },
    ]);
    // A native text edit rebuilds geometry; cached line breaks can differ.
    // Compare the copied edit with an independent edit in the source theme.
    const editedSvg = decodeURIComponent(
      preview(editedSource, editedSlide).split(",").slice(1).join(","),
    );
    const editedFonts = [...editedSvg.matchAll(/font-family="([^"]+)"/g)].map(
      (m) => m[1],
    );
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
        name: "Diagram font control.pptx",
        mimeType: MIME,
        buffer: Buffer.from(bytes),
      });
      // The editor, not the library it was opened from, before counting.
      await expect(page.locator("#slide-position")).toBeVisible();
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
    const fonts = async () =>
      [...(await svg()).matchAll(/font-family="([^"]+)"/g)].map((m) => m[1]);
    await load(original, 1);
    const originalFonts = await fonts();
    expect(originalFonts.length).toBeGreaterThan(0);
    expect(originalFonts.some((f) => f.includes("Georgia"))).toBe(true);
    expect(originalFonts.some((f) => f.includes("Verdana"))).toBe(true);
    await copy();
    const blank = createDeck("blank"),
      targetFonts = P.getPresentationFonts(blank);
    await load(await P.savePresentation(blank), 0);
    await page.keyboard.press("Control+v");
    await expect(objects).toHaveCount(1);
    expect(await fonts()).toEqual(originalFonts);
    // Editing the semantic model must retain the materialized source font.
    {
      await objects.dblclick();
      const modal = page.getByRole("dialog", { name: "Edit diagram text" });
      await modal
        .getByRole("textbox", { name: "Item 1 text", exact: true })
        .fill("Copied label");
      await modal.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(modal).toHaveCount(0);
      await expect.poll(svg).toContain("Copied label");
      expect(await fonts()).toEqual(editedFonts);
    }
    const forward = await download(),
      frame = P.getSlideShapes(P.getSlides(forward.p)[0])[0],
      diagram = readShapeDiagram(frame);
    expect(decode(diagram.data.part)).toContain('typeface="Verdana"');
    expect(decode(diagram.data.part)).not.toContain('typeface="+mn-lt"');
    expect(diagram.drawing).toBeNull(); // Native text edit invalidates the saved layout.
    expect(P.getShapeDiagramTextEntries(frame)[0].text).toBe("Copied label");
    expect(decode(diagram.data.part)).toContain('typeface="Georgia"');
    expect(P.getPresentationFonts(forward.p)).toEqual(targetFonts);
    await load(forward.bytes, 1);
    expect(await fonts()).toEqual(editedFonts);
    await copy();
    await load(original, 1);
    await page.keyboard.press("Control+v");
    await expect(objects).toHaveCount(2);
    const returned = await download(),
      frames = P.getSlideShapes(P.getSlides(returned.p)[0]);
    expect(decode(readShapeDiagram(frames[0]).data.part)).not.toContain(
      "typeface=",
    );
    expect(decode(readShapeDiagram(frames[1]).data.part)).toBe(
      decode(diagram.data.part),
    );
    expect(P.getShapeDiagramTextEntries(frames[1])[0].text).toBe(
      "Copied label",
    );
    expect(await fonts()).toEqual([...originalFonts, ...editedFonts]);
    expect(await svg()).not.toContain("data-pptx-diagram-issues");
    expect(errors).toEqual([]);
  });
