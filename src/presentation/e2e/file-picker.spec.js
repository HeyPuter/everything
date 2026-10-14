import { test, expect } from "@playwright/test";
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
