// Right-to-left paragraphs (<a:pPr rtl="1">) read in the RTL base direction:
// a Latin word inside a Hebrew sentence sits after the Hebrew before it,
// reading from the right, and the full stop ends the sentence on the left.
import { test, expect } from "@playwright/test";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { P } from "../src/model.js";

const SENTENCE = "גרסה 2 של Office.";

async function rtlDeck() {
  const pres = P.createPresentation();
  const s = P.addBlankSlide(pres);
  for (const [i, align] of ["l", "ctr", "r"].entries())
    P.addSlideTextBox(s, {
      x: P.inches(1),
      y: P.inches(1 + i * 1.5),
      w: P.inches(6),
      h: P.inches(1),
      text: `ALIGN-${align}`,
    });
  const files = unzipSync(await P.savePresentation(pres));
  const name = Object.keys(files).find((n) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(n),
  );
  files[name] = strToU8(
    strFromU8(files[name]).replace(
      /<a:p><a:r><a:rPr lang="en-US"\/><a:t>ALIGN-(\w+)<\/a:t><\/a:r><\/a:p>/g,
      (_, align) =>
        `<a:p><a:pPr algn="${align}" rtl="1"/><a:r><a:rPr lang="he-IL"/><a:t>${SENTENCE}</a:t></a:r></a:p>`,
    ),
  );
  return Buffer.from(zipSync(files));
}

test("right-to-left paragraphs keep their reading order in the slide image", async ({
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
    name: "Right to left.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: await rtlDeck(),
  });
  await expect(page.locator(".object-hit")).toHaveCount(3);
  // The slide image's own SVG, laid out by the browser as it draws it.
  const lines = await page.locator(".slide-image").evaluate(async (img) => {
    await img.decode();
    const host = document.createElement("div");
    host.innerHTML = await (await fetch(img.src)).text();
    document.body.append(host);
    const at = (node, i) => {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      return range.getBoundingClientRect();
    };
    const out = [...host.querySelectorAll("text")]
      .filter((t) => t.textContent.includes("Office"))
      .map((t) => {
        const node = (t.querySelector("tspan") ?? t).firstChild;
        const s = node.textContent;
        return {
          first: at(node, 0).left,
          office: at(node, s.indexOf("O")).left,
          stop: at(node, s.indexOf(".")).left,
          left: t.getBoundingClientRect().left,
          right: t.getBoundingClientRect().right,
        };
      });
    host.remove();
    return out;
  });
  expect(lines).toHaveLength(3);
  for (const line of lines) {
    expect(line.stop).toBeLessThan(line.office);
    expect(line.office).toBeLessThan(line.first);
  }
  // Alignment still places the line: left, centred and right in a 6" box.
  const [left, center, right] = lines;
  expect(left.left).toBeLessThan(center.left);
  expect(center.right).toBeLessThan(right.right);
  expect(
    Math.abs(center.left - left.left - (right.right - center.right)),
  ).toBeLessThan(2);
});
