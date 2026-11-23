// An equation made in another app keeps its place in a text box whose words
// are edited on the canvas.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck } from "../src/model.js";

const SLIDE = "ppt/slides/slide1.xml";
async function deckWithEquation() {
  const entries = unzipSync(await P.savePresentation(createDeck("blank")));
  const equation = `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14"><a14:m><m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:oMath><m:r><m:t>πr²</m:t></m:r></m:oMath></m:oMathPara></a14:m></mc:Choice><mc:Fallback><a:r><a:rPr lang="en-US"/><a:t>πr²</a:t></a:r></mc:Fallback></mc:AlternateContent>`;
  const box = `<p:sp><p:nvSpPr><p:cNvPr id="50" name="TextBox 49"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="6000000" cy="1200000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2400"/><a:t>Area: </a:t></a:r>${equation}<a:r><a:rPr lang="en-US" sz="2400"/><a:t> units</a:t></a:r></a:p></p:txBody></p:sp>`;
  entries[SLIDE] = strToU8(
    strFromU8(entries[SLIDE]).replace("</p:spTree>", `${box}</p:spTree>`),
  );
  return Buffer.from(zipSync(entries));
}

test("editing a text box keeps the equation in it", async ({ page }) => {
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
  ).setFiles({
    name: "Equation.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: await deckWithEquation(),
  });
  const box = page.locator("[data-object]").last();
  await box.dblclick();
  const input = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(input).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" squared");
  await input.press("Control+Enter");
  await expect(input).toHaveCount(0);
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  const bar = page.getByRole("menuitem", { name: "File", exact: true });
  if (await bar.isVisible()) await bar.click();
  else await page.getByRole("button", { name: "File options" }).click();
  const event = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const files = unzipSync(await readFile(await (await event).path()));
  const xml = strFromU8(files[SLIDE]);
  const body = xml.slice(xml.indexOf('id="50"'));
  const order = [
    ...body.matchAll(/<a14:m>|<a:t>([^<]*)<\/a:t><\/a:r>(?!<\/mc:Fallback>)/g),
  ].map(([match, words]) => (match === "<a14:m>" ? "[equation]" : words));
  expect(order.join("")).toBe("Area: [equation] units squared");
});
