// Objects copied in one tab paste as objects in another tab (another
// presentation), from the Paste command and from a paste event, rather than
// as their text or not at all.
import { test, expect } from "@playwright/test";
import { addShape, menu, start } from "./format-helpers.js";

test.setTimeout(90_000);

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
  await expect
    .poll(() =>
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
      }),
    )
    .toBe(true);

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
