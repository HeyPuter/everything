import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, createDeck, parseDeck, MIME } from "../src/model.js";
import { patternOpacityDeck } from "../tests/pattern-opacity-fixture.js";
import { binaryPatternCases } from "../tests/pattern-motif-fixture.js";
import { geometryImage, holeGeometry } from "../tests/geometry-fixture.js";

const start = async (page) => {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
};
const color = (hex, alpha) =>
  `<a:srgbClr val="${hex}"><a:alpha val="${Math.round(alpha * 100000)}"/></a:srgbClr>`;
const rectangleGeometry = (mode) =>
  `<a:custGeom><a:avLst/><a:gdLst/><a:pathLst><a:path fill="${mode}"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="w" y="0"/></a:lnTo><a:lnTo><a:pt x="w" y="h"/></a:lnTo><a:lnTo><a:pt x="0" y="h"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>`;

test("pattern colors retain independent alpha, crossings and shaded path coverage", async ({
  page,
}) => {
  test.setTimeout(60000);
  await start(page);
  const cases = [
    ...[
      "slide",
      "layout",
      "master",
      "layoutDecoration",
      "masterDecoration",
    ].map((level) => ({ kind: "shape", level })),
    ...["slide", "layout", "master"].flatMap((level) => [
      { kind: "reference", level },
      { kind: "background", level },
    ]),
    { kind: "table" },
    ...[
      ...new Set([
        "openDmnd",
        "diagCross",
        "dnDiag",
        "upDiag",
        ...[5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90].map(
          (n) => `pct${n}`,
        ),
        ...binaryPatternCases.map(([preset]) => preset),
      ]),
    ].map((preset) => ({
      kind: "shape",
      preset,
    })),
    ...["darkenLess", "lighten"].map((mode) => ({
      kind: "shape",
      mode,
      geometry: rectangleGeometry(mode),
    })),
    { kind: "shape", geometry: holeGeometry },
  ];
  for (const options of cases) {
    const variants = [];
    for (const [fg, bg, fc, bc] of [
      [1, 1, "FFFFFF", "000000"],
      [0, 0, "ED3719", "29CD53"],
      ...[0, 0.33333, 1].flatMap((fg) =>
        [0, 0.70001, 1].map((bg) => [fg, bg, "ED3719", "29CD53"]),
      ),
    ])
      variants.push(
        Buffer.from(
          await patternOpacityDeck({
            ...options,
            geometry: options.mode
              ? rectangleGeometry("norm")
              : options.geometry,
            foreground: color(fc, fg),
            background: color(bc, bg),
          }),
        ).toString("base64"),
      );
    // The mask control is unshaded: path shading changes channel RGB, not alpha.
    if (options.mode)
      for (let i = 1; i < variants.length; i++) {
        const [fg, bg] =
          i === 1
            ? [0, 0]
            : [0, 0.33333, 1].flatMap((f) =>
                [0, 0.70001, 1].map((b) => [f, b]),
              )[i - 2];
        variants[i] = Buffer.from(
          await patternOpacityDeck({
            ...options,
            foreground: color("ED3719", fg),
            background: color("29CD53", bg),
          }),
        ).toString("base64");
      }
    const halftone = ["dnDiag", "upDiag", "diagCross"].includes(options.preset)
      ? options.preset
      : null;
    if (halftone)
      for (const [af, ab] of [
        [1, 0],
        [0, 1],
      ])
        variants.push(
          Buffer.from(
            await patternOpacityDeck({
              ...options,
              foreground: color(af ? "FFFFFF" : "000000", af),
              background: color(ab ? "FFFFFF" : "000000", ab),
            }),
          ).toString("base64"),
        );
    const result = await page.evaluate(
      async ({ variants, mode, cellPattern, halftone }) => {
        const M = await import("/src/model.js"),
          c = document.createElement("canvas");
        c.width = 1280;
        c.height = 720;
        const ctx = c.getContext("2d", { willReadFrequently: true }),
          pixels = [];
        for (const [variant, bytes] of variants.entries()) {
          const p = await M.parseDeck(
              Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)),
            ),
            img = new Image();
          // Two black-backed basis controls measure 255*full + 64*half
          // and 255*background + 64*half. Their sum isolates the half-tone
          // class, while retaining the opaque control as an independent check.
          if (halftone && variant >= variants.length - 2)
            M.P.setSlideBackground(M.P.getSlides(p)[0], "#000000");
          img.src = M.preview(p, M.P.getSlides(p)[0]);
          await img.decode();
          ctx.fillStyle = "#306090";
          ctx.fillRect(0, 0, 1280, 720);
          ctx.drawImage(img, 0, 0, 1280, 720);
          pixels.push(ctx.getImageData(0, 0, 1280, 720).data);
        }
        const slope =
            mode === "darkenLess" ? 0.8 : mode === "lighten" ? 0.6 : 1,
          intercept = mode === "lighten" ? 102 : 0,
          fg = [237, 55, 25].map((v) => Math.round(v * slope + intercept)),
          bg = [41, 205, 83].map((v) => Math.round(v * slope + intercept));
        let maxError = 0,
          compared = 0,
          foreground = 0,
          background = 0,
          halfCoverage = 0;
        const combos = [0, 0.33333, 1].flatMap((f) =>
          [0, 0.70001, 1].map((b) => [f, b]),
        );
        for (let y = 240; y < 265; y++)
          for (let x = 145; x < 320; x++) {
            const i = (y * 1280 + x) * 4,
              mask = pixels[0];
            // Geometry holes leave the blue backdrop instead of either mask color.
            if (mask[i] !== mask[i + 1] || mask[i] !== mask[i + 2]) continue;
            const m = mask[i] / 255,
              half = halftone
                ? Math.max(
                    0,
                    Math.min(
                      1,
                      (255 - pixels.at(-2)[i] - pixels.at(-1)[i]) / 127,
                    ),
                  )
                : 0,
              full = halftone ? (pixels.at(-2)[i] - 64 * half) / 255 : m,
              back = 1 - full - half;
            // Point-sized cells may have no fully covered pixel at 96
            // DPI. Require both integrated contributions in that case.
            if (cellPattern) {
              foreground += m;
              background += 1 - m;
            } else {
              if (m > 0.3) foreground++;
              if (m < 0.1) background++;
            }
            halfCoverage += half;
            compared++;
            for (let j = 0; j < combos.length; j++) {
              const [af, ab] = combos[j],
                ah = (af + ab) / 2,
                a = full * af + half * ah + back * ab;
              for (let k = 0; k < 3; k++)
                maxError = Math.max(
                  maxError,
                  Math.abs(
                    pixels[j + 2][i + k] -
                      (full * af * fg[k] +
                        half * ah * ((fg[k] + bg[k]) / 2) +
                        back * ab * bg[k] +
                        (1 - a) * pixels[1][i + k]),
                  ),
                );
            }
          }
        // Outlines and text lie outside the paint operation; both endpoints agree.
        let unchangedInk = 0;
        const opaque = pixels[combos.length + 1];
        for (let i = 0; i < pixels[1].length; i += 4)
          if (
            pixels[1][i] === opaque[i] &&
            pixels[1][i + 1] === opaque[i + 1] &&
            pixels[1][i + 2] === opaque[i + 2] &&
            (pixels[1][i] !== pixels[1][0] || pixels[1][i + 1] !== pixels[1][1])
          )
            unchangedInk++;
        return {
          maxError,
          compared,
          foreground,
          background,
          halfCoverage,
          unchangedInk,
        };
      },
      {
        variants,
        mode: options.mode,
        halftone,
        cellPattern:
          ["dnDiag", "upDiag", "diagCross"].includes(options.preset) ||
          /^pct\d+$/.test(options.preset ?? "") ||
          binaryPatternCases.some(
            ([preset]) => preset === (options.preset ?? "cross"),
          ),
      },
    );
    const detail = JSON.stringify({ options, ...result });
    expect(result.maxError, detail).toBeLessThanOrEqual(3);
    expect(result.compared, detail).toBeGreaterThan(1000);
    expect(result.foreground, detail).toBeGreaterThan(100);
    expect(result.background, detail).toBeGreaterThan(100);
    if (halftone) expect(result.halfCoverage, detail).toBeGreaterThan(100);
    if (options.kind !== "background")
      expect(result.unchangedInk, detail).toBeGreaterThan(100);
  }
});

for (const [kind, preset] of [
  ...["shape", "reference", "table"].map((kind) => [kind, "cross"]),
  ...["shape", "reference", "table"].flatMap((kind) =>
    [
      "pct30",
      "horzBrick",
      "wdUpDiag",
      "dnDiag",
      "upDiag",
      "diagCross",
      "smConfetti",
      "sphere",
      "wave",
    ].map((preset) => [kind, preset]),
  ),
])
  test(`pattern alpha survives actual clipboard and download both ways: ${kind}${preset === "cross" ? "" : ` ${preset}`}`, async ({
    page,
  }) => {
    await start(page);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const original = await patternOpacityDeck({
        kind,
        preset,
        foreground: color("ED3719", 0.33333),
      }),
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
        name: "Pattern opacity control.pptx",
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
      return markup.replace(/pkdef-[\da-z]+/g, (id) => {
        if (!ids.has(id)) ids.set(id, `def-${ids.size}`);
        return ids.get(id);
      });
    };
    await load(original, 1);
    const expected = normalize(await svg());
    await copy();
    const blank = createDeck("blank");
    P.setPresentationTheme(blank, { accent1: "#1111FF", accent2: "#FFFF11" });
    if (kind !== "reference")
      P.setSlideBackgroundImage(P.getSlides(blank)[0], geometryImage);
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
          kind === "table"
            ? P.getTableStyleResolver(p, sh).cell(P.getTableCell(sh, 0, 0)).fill
            : P.getShapePatternFillEffective(p, sh);
        expect(fill).toMatchObject({
          foregroundOpacity: 0.33333,
          backgroundOpacity: 0.70001,
        });
      }
    }
    expect(errors).toEqual([]);
  });
