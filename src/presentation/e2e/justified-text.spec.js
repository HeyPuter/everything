// Justified paragraphs (<a:pPr algn="just">) spread each line that wraps
// across the text box, so both edges line up; the paragraph's last line,
// and a line ended by a line break, stay at the start.
import { test, expect } from "@playwright/test";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { P } from "../src/model.js";

const TEXT =
  "Justified text spreads every line that wraps across the whole box, so that both of its edges line up, while the last line keeps to the start.";

async function justifiedDeck() {
  const pres = P.createPresentation();
  const s = P.addBlankSlide(pres);
  P.addSlideTextBox(s, {
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(5),
    h: P.inches(4),
    text: "JUSTIFIED",
  });
  const files = unzipSync(await P.savePresentation(pres));
  const name = Object.keys(files).find((n) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(n),
  );
  files[name] = strToU8(
    strFromU8(files[name]).replace(
      /<a:p><a:r><a:rPr lang="en-US"\/><a:t>JUSTIFIED<\/a:t><\/a:r><\/a:p>/,
      `<a:p><a:pPr algn="just"/><a:r><a:rPr lang="en-US" sz="2000"/><a:t>${TEXT}</a:t></a:r></a:p>`,
    ),
  );
  return Buffer.from(zipSync(files));
}

test("justified paragraphs fill each wrapped line in the slide image", async ({
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
    name: "Justified.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: await justifiedDeck(),
  });
  await expect(page.locator(".object-hit")).toHaveCount(1);
  // The slide image's own SVG, laid out by the browser as it draws it, in
  // slide pixels (96 per inch).
  const lines = await page.locator(".slide-image").evaluate(async (img) => {
    await img.decode();
    const host = document.createElement("div");
    host.innerHTML = await (await fetch(img.src)).text();
    const svg = host.querySelector("svg");
    svg.setAttribute("width", svg.viewBox.baseVal.width);
    svg.setAttribute("height", svg.viewBox.baseVal.height);
    host.style.cssText = "position:fixed;left:0;top:0";
    document.body.append(host);
    const origin = svg.getBoundingClientRect();
    return [...host.querySelectorAll("text")].map((t) => {
      const box = t.getBoundingClientRect();
      return { left: box.left - origin.left, right: box.right - origin.left };
    });
  });
  expect(lines.length).toBeGreaterThan(2);
  // The text box runs from 1 to 6 inches, inset by 0.1 inch on each side.
  for (const line of lines.slice(0, -1)) {
    expect(line.left).toBeCloseTo(105.6, 0);
    expect(Math.abs(line.right - 566.4)).toBeLessThan(2);
  }
  expect(lines.at(-1).right).toBeLessThan(566.4 - 20);
});
