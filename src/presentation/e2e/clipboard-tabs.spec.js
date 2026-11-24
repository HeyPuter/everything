// Objects copied in one tab paste as objects in another tab (another
// presentation), from the Paste command and from a paste event, rather than
// as their text or not at all.
import { test, expect } from "@playwright/test";
import { addShape, menu, start } from "./format-helpers.js";

test.setTimeout(90_000);

// Whether the copy has been offered to the other tabs yet.
const shared = (page) =>
  page.evaluate(async () => {
    const name = "presentation-clipboard-v1";
    if (!(await indexedDB.databases()).some((db) => db.name === name))
      return false;
    return new Promise((resolve) => {
      const open = indexedDB.open(name);
      open.onerror = () => resolve(false);
      open.onsuccess = () => {
        const get = open.result
          .transaction("clipboard")
          .objectStore("clipboard")
          .get("last");
        get.onsuccess = () => {
          open.result.close();
          resolve(!!get.result);
        };
      };
    });
  });

test("objects copied in one tab paste as objects in another", async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL,
  });
  await start(page);
  await addShape(page, "Rectangle");
  await addShape(page, "Circle");
  await menu(page, "Edit", "Select all");
  await expect(page.locator(".object-hit.selected")).toHaveCount(2);
  await menu(page, "Edit", "Copy");
  const names = (p) =>
    p
      .locator(".object-hit")
      .evaluateAll((hits) => hits.map((hit) => hit.getAttribute("aria-label")));
  const copied = await names(page);

  // The copy is offered to the other tabs once it is made.
  await expect.poll(() => shared(page)).toBe(true);

  const other = await context.newPage();
  await start(other);
  // The Paste command, which reads the copy's token from the clipboard.
  await menu(other, "Edit", "Paste");
  await expect.poll(() => names(other)).toEqual(copied);
  await other.close();

  // Paste Special offers them too, keeping their own look.
  const special = await context.newPage();
  await start(special);
  await menu(special, "Edit", "Paste Special…");
  const dialog = special.getByRole("dialog", { name: "Paste Special" });
  await dialog
    .getByRole("radio", { name: "Objects, keeping their formatting" })
    .check();
  await dialog.getByRole("button", { name: "Paste" }).click();
  await expect.poll(() => names(special)).toEqual(copied);
  await special.close();

  // A paste event that brings only the copy's text (here none) still
  // brings the objects.
  const third = await context.newPage();
  await start(third);
  await third.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "");
    document.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect.poll(() => names(third)).toEqual(copied);
});

// A copy made since in another app wins over objects copied here earlier:
// a picture, or text that is only spaces, does not bring the old objects
// back, nor does a Paste command that cannot read the clipboard.
test("objects copied earlier stay put once something else is copied", async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL,
  });
  await start(page);
  await addShape(page, "Rectangle");
  await menu(page, "Edit", "Copy");
  await expect.poll(() => shared(page)).toBe(true);
  const objects = (p) => p.locator(".object-hit");
  const pasteEvent = (p, data) =>
    p.evaluate(async ({ text, png }) => {
      const transfer = new DataTransfer();
      if (png) {
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        await navigator.clipboard.write([
          new ClipboardItem({
            "image/png": new Blob([bytes], { type: "image/png" }),
          }),
        ]);
        transfer.items.add(
          new File([bytes], "image.png", { type: "image/png" }),
        );
      } else {
        await navigator.clipboard.writeText(text);
        transfer.setData("text/plain", text);
      }
      document.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, data);

  const other = await context.newPage();
  await start(other);
  await pasteEvent(other, {
    png: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMwSJjwH4QZYAwARzQIfaOzYgMAAAAASUVORK5CYII=",
  });
  await expect(objects(other)).toHaveCount(1);
  await expect(objects(other)).toHaveAccessibleName("Image. Select to edit");

  const third = await context.newPage();
  await start(third);
  await pasteEvent(third, { text: "   " });
  await expect(third.getByText(/^Nothing to paste/)).toBeVisible();
  await expect(objects(third)).toHaveCount(0);
  // The Paste command, kept from reading the clipboard, says how to paste.
  await third.evaluate(() => {
    navigator.clipboard.read = () =>
      Promise.reject(new DOMException("Denied", "NotAllowedError"));
  });
  await menu(third, "Edit", "Paste");
  await expect(
    third.getByText(/did not let Paste read the clipboard/),
  ).toBeVisible();
  await expect(objects(third)).toHaveCount(0);
});
