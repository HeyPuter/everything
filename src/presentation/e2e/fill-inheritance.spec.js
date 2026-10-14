import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, createDeck, parseDeck, MIME } from "../src/model.js";
import {
  patternInheritanceDeck,
  patternInheritanceCases,
  patternInheritanceExpected,
  pattern,
} from "../tests/pattern-inheritance-fixture.js";
import {
  gradientTileInheritanceDeck,
  gradientTileInheritanceCases,
} from "../tests/gradient-tile-inheritance-fixture.js";
const start = async (page) => {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
};
const controls = [
  ...[0, 10, 18].map((i) => ({
    name: patternInheritanceCases[i].name,
    kind: "pattern",
    make: () => patternInheritanceDeck([patternInheritanceCases[i]]),
    expectedFill: patternInheritanceExpected[i],
  })),
  {
    name: "master pattern style",
    kind: "pattern",
    make: () =>
      patternInheritanceDeck([{ own: pattern() }], {
        masterFill: pattern("wave"),
        masterStyle: 1,
      }),
    expectedFill: {
      preset: "wave",
      foreground: "#D7A82B",
      background: "#2763C4",
      foregroundOpacity: 0.8,
      backgroundOpacity: 0.6,
    },
  },
  ...[1, 4].map((i) => ({
    name: gradientTileInheritanceCases[i].name,
    kind: "gradient",
    make: () => gradientTileInheritanceDeck([gradientTileInheritanceCases[i]]),
    expectedFill: {
      angleDeg: 0,
      stops: [
        { offset: 0, color: "#000000" },
        { offset: 1, color: "#FFFFFF" },
      ],
      tileRect: gradientTileInheritanceCases[i].expected,
    },
  })),
];
for (const { name, kind, make, expectedFill } of controls)
  test(`partial fill inheritance survives actual clipboard and download both ways: ${name}`, async ({
    page,
  }) => {
    await start(page);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const original = await make(),
      objects = page.locator(".object-hit");
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
        name: "Fill inheritance control.pptx",
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
      const hit = objects.last();
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
      return bytes;
    }
    const svg = () =>
      page.locator(".slide-image").evaluate(async (img) => {
        await img.decode();
        return (await fetch(img.src)).text();
      });
    const normalize = (markup) => {
      const ids = new Map();
      return markup.replace(/(?:pkdef|grad|gradient|gdef)-[\da-z]+/g, (id) => {
        if (!ids.has(id)) ids.set(id, `def-${ids.size}`);
        return ids.get(id);
      });
    };
    await load(original, 1);
    const expected = normalize(await svg());
    await copy();
    const blank = createDeck("blank");
    P.setPresentationTheme(blank, { accent1: "#1111FF", accent2: "#FFFF11" });
    P.setSlideBackground(P.getSlides(blank)[0], "#DDE3EB");
    await load(await P.savePresentation(blank), 0);
    await page.keyboard.press("Control+v");
    await expect(objects).toHaveCount(1);
    expect(normalize(await svg())).toBe(expected);
    const forward = await download();
    await load(forward, 1);
    expect(normalize(await svg())).toBe(expected);
    await copy();
    await load(original, 1);
    await page.keyboard.press("Control+v");
    await expect(objects).toHaveCount(2);
    const returned = await download();
    for (const [bytes, n] of [
      [forward, 1],
      [returned, 2],
    ]) {
      const p = await parseDeck(bytes),
        slide = P.getSlides(p)[0],
        shapes = P.getSlideShapes(slide);
      expect(shapes).toHaveLength(n);
      expect(P.validatePresentation(p)).toEqual([]);
      for (const sh of shapes) {
        const fill =
          kind === "pattern"
            ? P.getShapePatternFillEffective(p, sh)
            : P.getShapeGradientFillEffective(p, sh);
        expect(fill).toEqual(expectedFill);
      }
    }
    expect(errors).toEqual([]);
  });
