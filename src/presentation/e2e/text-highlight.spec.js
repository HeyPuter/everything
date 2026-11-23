// Text highlight color (<a:highlight>) paints a band of its color behind
// the highlighted run, where the slide draws that run's letters.
import { test, expect } from "@playwright/test";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { P } from "../src/model.js";

async function highlightedDeck() {
  const pres = P.createPresentation();
  const s = P.addBlankSlide(pres);
  P.addSlideTextBox(s, {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(8),
    h: P.inches(1),
    text: "HIGHLIGHT",
  });
  const files = unzipSync(await P.savePresentation(pres));
  const name = Object.keys(files).find((n) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(n),
  );
  files[name] = strToU8(
    strFromU8(files[name]).replace(
      /<a:r><a:rPr lang="en-US"\/><a:t>HIGHLIGHT<\/a:t><\/a:r>/,
      '<a:r><a:rPr lang="en-US" sz="2400"/><a:t>Plain, then </a:t></a:r><a:r><a:rPr lang="en-US" sz="2400"><a:highlight><a:srgbClr val="FFFF00"/></a:highlight></a:rPr><a:t>marked words</a:t></a:r><a:r><a:rPr lang="en-US" sz="2400"/><a:t> and plain again.</a:t></a:r>',
    ),
  );
  return Buffer.from(zipSync(files));
}

test("highlighted text is drawn on its highlight color in the slide image", async ({
  page,
}) => {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Highlight.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: await highlightedDeck(),
  });
  await expect(page.locator(".object-hit")).toHaveCount(1);
  const found = await page.locator(".slide-image").evaluate(async (img) => {
    await img.decode();
    const host = document.createElement("div");
    host.innerHTML = await (await fetch(img.src)).text();
    const svg = host.querySelector("svg");
    svg.setAttribute("width", svg.viewBox.baseVal.width);
    svg.setAttribute("height", svg.viewBox.baseVal.height);
    host.style.cssText = "position:fixed;left:0;top:0";
    document.body.append(host);
    const band = svg.querySelector('rect[fill="#FFFF00"]');
    const words = [...svg.querySelectorAll("tspan")].find(
      (t) => t.textContent === "marked words",
    );
    if (!band || !words) return null;
    const range = document.createRange();
    range.selectNodeContents(words);
    const glyphs = range.getBoundingClientRect(),
      box = band.getBoundingClientRect();
    return {
      behind:
        band.compareDocumentPosition(words) & Node.DOCUMENT_POSITION_FOLLOWING,
      band: [box.left, box.right, box.top, box.bottom],
      glyphs: [glyphs.left, glyphs.right, glyphs.top, glyphs.bottom],
    };
  });
  expect(found).not.toBeNull();
  expect(found.behind).toBeTruthy();
  const [left, right, top, bottom] = found.band;
  const [gl, gr, gt, gb] = found.glyphs;
  expect(Math.abs(left - gl)).toBeLessThan(1.5);
  expect(Math.abs(right - gr)).toBeLessThan(1.5);
  // The band covers the letters from their ascent to their descent.
  expect(top).toBeLessThanOrEqual(gt + 4);
  expect(bottom).toBeGreaterThanOrEqual(gb - 4);
});
