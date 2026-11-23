import { test, expect } from "@playwright/test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck } from "../src/model.js";
import { insertImage } from "./editor-commands.js";

test.beforeEach(async ({ page }) => {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
});

for (const kind of ["presentation", "image"]) {
  test(`${kind} picker retains its input until selection and removes it after selection or cancellation`, async ({
    page,
  }) => {
    if (kind === "image")
      await page
        .getByRole("button", { name: "New presentation", exact: true })
        .click();
    // The library's Import PPTX, or the editor's Insert > Image.
    const press = () =>
      kind === "presentation"
        ? page.getByRole("button", { name: "Import PPTX", exact: true }).click()
        : insertImage(page);
    const open = async () => {
      const pending = page.waitForEvent("filechooser");
      await press();
      const chooser = await pending;
      expect(
        await chooser.element().evaluate((input) => input.isConnected),
      ).toBe(true);
      await expect(page.locator('input[type="file"]')).toHaveCount(1);
      await expect(page.locator('input[type="file"]')).toBeHidden();
      return chooser;
    };
    // The browser reports cancellation through the input's cancel event.
    const canceled = await open();
    await canceled.element().dispatchEvent("cancel");
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    const chosen = await open();
    await chosen.setFiles(
      kind === "presentation"
        ? {
            name: "Chosen deck.pptx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            buffer: Buffer.from(await P.savePresentation(createDeck("blank"))),
          }
        : {
            name: "Chosen image.png",
            mimeType: "image/png",
            buffer: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
              "base64",
            ),
          },
    );
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    if (kind === "presentation")
      await expect(page.locator(".document-title")).toHaveText("Chosen deck");
    else
      await expect(
        page.getByRole("button", {
          name: "Image: Chosen image.png. Select to edit",
          exact: true,
        }),
      ).toBeVisible();
  });
}

test("a template or slide show opens as a presentation", async ({ page }) => {
  const imported = async (name, kind) => {
    const pres = createDeck("story");
    if (kind) P.setPresentationKind(pres, kind);
    const pending = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    const chooser = await pending;
    expect(await chooser.element().getAttribute("accept")).toBe(
      ".pptx,.ppsx,.potx,.pptm,.ppsm,.potm",
    );
    await chooser.setFiles({
      name,
      mimeType: "application/octet-stream",
      buffer: Buffer.from(await P.savePresentation(pres)),
    });
    await expect(page.locator("#slide-position")).toBeVisible();
    // What a save would write: the recovery draft holds the open revision.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const drafts = await import("/src/drafts.js");
          const { P } = await import("/src/model.js");
          const [summary] = await drafts.listDrafts("guest");
          const stored = summary && (await drafts.getDraft(summary.id));
          return stored
            ? P.getPresentationKind(await P.loadPresentation(stored.bytes))
            : null;
        }),
      )
      .toBe("presentation");
    const title = await page.locator(".document-title").textContent();
    await page.getByRole("button", { name: "Back to presentations" }).click();
    await page.evaluate(async () => {
      const drafts = await import("/src/drafts.js");
      for (const d of await drafts.listDrafts("guest"))
        await drafts.deleteDraft(d.id);
    });
    return title;
  };
  expect(await imported("Brand.potx", "template")).toBe(
    "Untitled presentation",
  );
  expect(await imported("Keynote.ppsx", "slideshow")).toBe("Keynote");
  // A template renamed .pptx is saved as a presentation under that name.
  expect(await imported("Renamed.pptx", "template")).toBe("Renamed");
});

test("a macro deck renamed .pptx opens without its macros and saves as a plain presentation", async ({
  page,
}) => {
  const entries = unzipSync(await P.savePresentation(createDeck("story")));
  entries["[Content_Types].xml"] = strToU8(
    strFromU8(entries["[Content_Types].xml"])
      .replace(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
        "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
      )
      .replace(
        "</Types>",
        '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
      ),
  );
  const rels = "ppt/_rels/presentation.xml.rels";
  entries[rels] = strToU8(
    strFromU8(entries[rels]).replace(
      "</Relationships>",
      '<Relationship Id="rIdVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>',
    ),
  );
  entries["ppt/vbaProject.bin"] = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);
  const pending = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await pending
  ).setFiles({
    name: "Renamed macros.pptx",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(zipSync(entries)),
  });
  await expect(page.locator(".document-title")).toHaveText("Renamed macros");
  await expect(page.locator("#toast")).toContainText("macros were removed");
  const draftBytes = () =>
    page.evaluate(async () => {
      const drafts = await import("/src/drafts.js");
      const [summary] = await drafts.listDrafts("guest");
      const stored = summary && (await drafts.getDraft(summary.id));
      return stored ? Array.from(stored.bytes) : null;
    });
  // What a save would write: the recovery draft holds the open revision.
  await expect
    .poll(async () => {
      const bytes = await draftBytes();
      if (!bytes) return null;
      const files = unzipSync(new Uint8Array(bytes));
      return {
        types: /macroEnabled|vbaProject/.test(
          strFromU8(files["[Content_Types].xml"]),
        ),
        parts: Object.keys(files).filter((n) => /vba/i.test(n)),
      };
    })
    .toEqual({ types: false, parts: [] });
  // A macro presentation (.pptm) opens the same way, keeping its name.
  await page.getByRole("button", { name: "Back to presentations" }).click();
  const again = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await again
  ).setFiles({
    name: "Quarterly macros.pptm",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(zipSync(entries)),
  });
  await expect(page.locator(".document-title")).toHaveText("Quarterly macros");
  await expect(page.locator("#toast")).toContainText("macros were removed");
});
