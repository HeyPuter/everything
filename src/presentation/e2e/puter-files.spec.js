import { test, expect } from "@playwright/test";
import { addText } from "./editor-commands.js";
import { P, createDeck } from "../src/model.js";

// A Puter drive in memory that behaves as the real one does where it matters
// to opening and saving: every file has an id it keeps through renames and
// moves, which the drive stamps as modifications; relative paths resolve
// under the app's own folder and "~/" under the home folder; the pickers never
// settle when cancelled but carry `undefinedOnCancel`; and the window's close
// button waits for puter.exit() once a handler is registered.
function installPuter({ env, seed, launch }) {
  const bytesOf = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  let clock = 1_700_000_000;
  let nextUid = 1;
  const files = new Map();
  const abs = (p) =>
    p.startsWith("/")
      ? p
      : p.startsWith("~/")
        ? `/test/${p.slice(2)}`
        : `/test/AppData/presentation/${p}`;
  const info = (f) => ({
    path: f.path,
    name: f.path.split("/").pop(),
    uid: f.uid,
    modified: f.modified,
    size: f.bytes.size,
    is_dir: false,
  });
  const notFound = () =>
    Object.assign(new Error("Not found"), { code: "subject_does_not_exist" });
  const put = (path, bytes, uid) => {
    const f = {
      path,
      uid: uid ?? `uid-${nextUid++}`,
      modified: ++clock,
      bytes,
    };
    files.set(path, f);
    return f;
  };
  for (const [path, b64] of Object.entries(seed))
    put(abs(path), new Blob([bytesOf(b64)]));
  window.__fs = {
    writes: [],
    paths: () => [...files.keys()],
    // Another tab or device saves the file.
    change(path, b64) {
      const f = files.get(path);
      put(path, new Blob([bytesOf(b64)]), f.uid);
    },
    // The desktop renames or moves the file.
    move(from, to) {
      const f = files.get(from);
      files.delete(from);
      put(to, f.bytes, f.uid);
    },
    remove(path) {
      files.delete(path);
    },
  };
  window.__ui = { titles: [], close: null, exited: false, saveAs: null };
  const cancellable = (result) => {
    const pending = new Promise(() => {});
    pending.undefinedOnCancel = Promise.resolve(result);
    return pending;
  };
  window.puter = {
    env,
    auth: {
      isSignedIn: async () => true,
      getUser: async () => ({ username: "test-user", uuid: "test-user-id" }),
      signIn: async () => {},
      signOut: async () => {},
    },
    kv: new Proxy(
      {},
      {
        get() {
          throw Error("KV is forbidden");
        },
      },
    ),
    fs: {
      readdir: async (dir) =>
        [...files.values()]
          .filter((f) => f.path.startsWith(`${abs(dir)}/`))
          .map(info),
      stat: async (arg) => {
        const f =
          typeof arg === "object"
            ? [...files.values()].find((f) => f.uid === arg.uid)
            : files.get(abs(arg));
        if (!f) throw notFound();
        return info(f);
      },
      read: async (p) => {
        const f = files.get(abs(p));
        if (!f) throw notFound();
        return f.bytes;
      },
      write: async (p, blob, options = {}) => {
        let path = abs(p);
        if (files.has(path) && !options.overwrite) {
          if (!options.dedupeName) throw Error("A file is already there");
          const stem = path.replace(/\.pptx$/, "");
          for (let n = 1; files.has(path); n++) path = `${stem} (${n}).pptx`;
        }
        window.__fs.writes.push({ path, options });
        return info(put(path, blob, files.get(path)?.uid));
      },
      rename: async (p, name) => {
        const from = abs(p);
        const to = from.slice(0, from.lastIndexOf("/") + 1) + name;
        window.__fs.move(from, to);
        return info(files.get(to));
      },
      delete: async (p) => files.delete(abs(p)),
    },
    ui: {
      onLaunchedWithItems(callback) {
        if (launch) callback(launch);
      },
      onWindowClose(callback) {
        window.__ui.close = callback;
      },
      setWindowTitle: async (title) => window.__ui.titles.push(title),
      showOpenFilePicker: () =>
        cancellable(
          window.__ui.pick ? info(files.get(window.__ui.pick)) : undefined,
        ),
      showSaveFilePicker(content, name) {
        if (window.__ui.saveAs === "cancel") return cancellable(undefined);
        const path = `/test/Documents/${window.__ui.saveAs || name}`;
        return cancellable(info(put(path, new Blob([content]))));
      },
    },
    exit() {
      window.__ui.exited = true;
    },
  };
}
const base64 = async (pres) =>
  Buffer.from(await P.savePresentation(pres)).toString("base64");
const APP_FOLDER = "/test/AppData/presentation/Presentations";
async function mockDrive(
  page,
  { env = "app", seed = {}, launch = null, path = "/" } = {},
) {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `(${installPuter})(${JSON.stringify({ env, seed, launch })});`,
    }),
  );
  await page.goto(path);
}
const status = (page) => page.locator("#save-status");
const title = (page) => page.locator(".document-title");
const writes = (page) => page.evaluate(() => window.__fs.writes);
async function addText(page) {
  const before = await page.locator(".object-hit").count();
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(before + 1);
}
const fileMenu = (page) =>
  page
    .getByRole("menuitem", { name: "File", exact: true })
    .or(page.getByRole("button", { name: "File options" }))
    .filter({ visible: true })
    .click();

test("a presentation launched from the desktop opens directly, titled after the file", async ({
  page,
}) => {
  const story = await base64(createDeck("story"));
  await mockDrive(page, {
    seed: { "~/Desktop/Quarterly.pptx": story },
    launch: [{ name: "Quarterly.pptx", path: "~/Desktop/Quarterly.pptx" }],
  });
  await expect(title(page)).toHaveText("Quarterly");
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
  // The file is known by the address the drive reports, and nothing was
  // written to open it: no blank presentation came first.
  await expect(status(page)).toHaveAttribute(
    "title",
    "/test/Desktop/Quarterly.pptx",
  );
  expect(await writes(page)).toEqual([]);
  await expect
    .poll(() => page.evaluate(() => window.__ui.titles.at(-1)))
    .toBe("Quarterly");
  expect(await page.evaluate(() => window.__ui.titles)).not.toContain(
    "Untitled presentation",
  );
  // Edits go back to the file where it lives.
  await addText(page);
  await expect(status(page)).toHaveText("Saved to Puter");
  expect((await writes(page)).at(-1)).toMatchObject({
    path: "/test/Desktop/Quarterly.pptx",
    options: { overwrite: true },
  });
  // The library lists it beside the Presentations folder, with its folder.
  await page.getByRole("button", { name: "Back to presentations" }).click();
  const row = page.locator(".file-row").filter({
    has: page.getByRole("button", {
      name: "Quarterly PowerPoint presentation",
      exact: true,
    }),
  });
  await expect(row.locator(".file-location")).toHaveText("Puter · Desktop");
  await expect
    .poll(() => page.evaluate(() => window.__ui.titles.at(-1)))
    .toBe("Presentation");
});

test("a launch that is not a presentation explains itself and opens a new one", async ({
  page,
}) => {
  await mockDrive(page, {
    launch: [{ name: "notes.txt", path: "~/Desktop/notes.txt" }],
  });
  await expect(page.locator("#toast")).toContainText(
    "“notes.txt” can't be opened here",
  );
  await expect(title(page)).toHaveText("Untitled presentation");
});

test("a launched file that is gone says so and shows the library", async ({
  page,
}) => {
  await mockDrive(page, {
    launch: [{ name: "Gone.pptx", path: "~/Desktop/Gone.pptx" }],
  });
  await expect(page.locator("#toast")).toHaveText(
    "“Gone” is no longer there. It may have been moved or deleted.",
  );
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
});

test("a save that finds the file changed elsewhere asks before replacing it", async ({
  page,
}) => {
  const [story, blank] = await Promise.all([
    base64(createDeck("story")),
    base64(createDeck("blank")),
  ]);
  await mockDrive(page, {
    seed: { "Presentations/Shared.pptx": story },
    path: "/#/home",
  });
  await page
    .getByRole("button", { name: "Shared PowerPoint presentation" })
    .click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 5");
  const path = `${APP_FOLDER}/Shared.pptx`;
  // Another device saves the file; this one's edit must not write over it.
  await page.evaluate(([p, b]) => window.__fs.change(p, b), [path, blank]);
  await addText(page);
  const dialog = page.getByRole("dialog", {
    name: "This presentation changed elsewhere",
  });
  await expect(dialog).toBeVisible();
  await expect(status(page)).toHaveText("Changed elsewhere");
  expect(await writes(page)).toEqual([]);
  // Closing the question keeps the edits and holds autosave.
  await dialog.getByRole("button", { name: "Close" }).click();
  await addText(page);
  await page.waitForTimeout(2000);
  expect(await writes(page)).toEqual([]);
  // Saving asks again; this time the person keeps their own version.
  await page.keyboard.press("Control+s");
  await dialog.getByRole("button", { name: "Replace with mine" }).click();
  await expect(status(page)).toHaveText("Saved to Puter");
  expect(await writes(page)).toHaveLength(1);
  // Changed elsewhere again, and this time their version is opened instead.
  await page.evaluate(([p, b]) => window.__fs.change(p, b), [path, blank]);
  await addText(page);
  await dialog.getByRole("button", { name: "Open their version" }).click();
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  await expect(status(page)).toHaveText("Saved to Puter");
  expect(await writes(page)).toHaveLength(1);
  // The discarded edits leave no recovery draft behind.
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await expect(
    page.getByRole("button", { name: /Recovery draft/ }),
  ).toHaveCount(0);
});

test("a file renamed elsewhere is followed by its id", async ({ page }) => {
  const story = await base64(createDeck("story"));
  await mockDrive(page, {
    seed: { "Presentations/Draft.pptx": story },
    path: "/#/home",
  });
  await page
    .getByRole("button", { name: "Draft PowerPoint presentation" })
    .click();
  await expect(title(page)).toHaveText("Draft");
  await page.evaluate(
    ([from, to]) => window.__fs.move(from, to),
    [`${APP_FOLDER}/Draft.pptx`, `${APP_FOLDER}/Final.pptx`],
  );
  await addText(page);
  await expect(status(page)).toHaveText("Saved to Puter");
  await expect(title(page)).toHaveText("Final");
  expect((await writes(page)).map((w) => w.path)).toEqual([
    `${APP_FOLDER}/Final.pptx`,
  ]);
  expect(await page.evaluate(() => window.__fs.paths())).not.toContain(
    `${APP_FOLDER}/Draft.pptx`,
  );
});

test("a file deleted elsewhere offers to save the edits as a new file", async ({
  page,
}) => {
  const story = await base64(createDeck("story"));
  await mockDrive(page, {
    seed: { "Presentations/Doomed.pptx": story },
    path: "/#/home",
  });
  await page
    .getByRole("button", { name: "Doomed PowerPoint presentation" })
    .click();
  await expect(title(page)).toHaveText("Doomed");
  await page.evaluate(
    (p) => window.__fs.remove(p),
    `${APP_FOLDER}/Doomed.pptx`,
  );
  await addText(page);
  const dialog = page.getByRole("dialog", {
    name: "This presentation was moved or deleted",
  });
  await expect(status(page)).toHaveText("Moved or deleted");
  await dialog.getByRole("button", { name: "Save as a new file" }).click();
  await expect(status(page)).toHaveText("Saved to Puter");
  expect((await writes(page)).at(-1)).toMatchObject({
    path: `${APP_FOLDER}/Doomed.pptx`,
    options: { overwrite: false, dedupeName: true },
  });
});

test("leaving the editor saves edits that autosave has not sent yet", async ({
  page,
}) => {
  const story = await base64(createDeck("story"));
  await mockDrive(page, {
    seed: { "Presentations/Quick.pptx": story },
    path: "/#/home",
  });
  await page
    .getByRole("button", { name: "Quick PowerPoint presentation" })
    .click();
  await expect(title(page)).toHaveText("Quick");
  await addText(page);
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await expect(
    page.getByRole("button", { name: "Quick PowerPoint presentation" }),
  ).toBeVisible();
  expect(await writes(page)).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: /Recovery draft/ }),
  ).toHaveCount(0);
});

test("a failing autosave says so in the status, and leaving asks first", async ({
  page,
}) => {
  const story = await base64(createDeck("story"));
  await mockDrive(page, {
    seed: { "Presentations/Flaky.pptx": story },
    path: "/#/home",
  });
  await page
    .getByRole("button", { name: "Flaky PowerPoint presentation" })
    .click();
  await expect(title(page)).toHaveText("Flaky");
  await page.evaluate(() => {
    puter.fs.write = async () => {
      throw Error("Puter is out of space.");
    };
  });
  await addText(page);
  await expect(status(page)).toHaveText("Not saved to Puter · on this device");
  await expect(status(page)).toHaveAttribute(
    "title",
    /Puter is out of space\./,
  );
  // An autosave failure is shown, not announced with a toast.
  await expect(page.locator("#toast")).not.toBeVisible();
  await page.getByRole("button", { name: "Back to presentations" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Your latest changes aren't saved to Puter",
  });
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(title(page)).toHaveText("Flaky");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await dialog.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Flaky Recovery draft" }),
  ).toBeVisible();
});

test("closing the Puter window asks about a presentation never saved", async ({
  page,
}) => {
  await mockDrive(page);
  await expect(title(page)).toHaveText("Untitled presentation");
  // Untouched, the window simply closes.
  await page.evaluate(() => window.__ui.close());
  await expect.poll(() => page.evaluate(() => window.__ui.exited)).toBe(true);
  await page.evaluate(() => (window.__ui.exited = false));
  await addText(page);
  await page.evaluate(() => window.__ui.close());
  const dialog = page.getByRole("dialog", {
    name: "Save “Untitled presentation” to Puter before closing?",
  });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await page.evaluate(() => window.__ui.exited)).toBe(false);
  await page.evaluate(() => window.__ui.close());
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__ui.exited)).toBe(true);
  expect((await writes(page)).at(-1).path).toBe(
    `${APP_FOLDER}/Untitled presentation.pptx`,
  );
});

test("closing the Puter window saves a Puter file's pending edits first", async ({
  page,
}) => {
  const story = await base64(createDeck("story"));
  await mockDrive(page, {
    seed: { "~/Desktop/Talk.pptx": story },
    launch: [{ name: "Talk.pptx", path: "~/Desktop/Talk.pptx" }],
  });
  await expect(title(page)).toHaveText("Talk");
  await addText(page);
  await page.evaluate(() => window.__ui.close());
  await expect.poll(() => page.evaluate(() => window.__ui.exited)).toBe(true);
  expect((await writes(page)).map((w) => w.path)).toEqual([
    "/test/Desktop/Talk.pptx",
  ]);
});

test("files dropped from the Puter desktop open, and folders explain themselves", async ({
  page,
}) => {
  const story = await base64(createDeck("story"));
  await mockDrive(page, {
    seed: { "~/Documents/Dropped.pptx": story },
    path: "/#/home",
  });
  const drop = (items) =>
    page.evaluate((items) => {
      document.body.dispatchEvent(
        new CustomEvent("drop", {
          bubbles: true,
          cancelable: true,
          detail: { items },
        }),
      );
    }, items);
  await drop([{ name: "Photos", path: "/test/Photos", is_dir: true }]);
  await expect(page.locator("#toast")).toHaveText(
    "A folder can't be opened. Choose a PowerPoint (.pptx) file.",
  );
  await drop([{ name: "Dropped.pptx", path: "/test/Documents/Dropped.pptx" }]);
  await expect(title(page)).toHaveText("Dropped");
});

test("inside Puter, exports and copies go through Puter's Save dialog", async ({
  page,
}) => {
  await mockDrive(page);
  await expect(title(page)).toHaveText("Untitled presentation");
  await page.evaluate(() => (window.__ui.saveAs = "cancel"));
  await fileMenu(page);
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  await page.waitForTimeout(300);
  await expect(page.locator("#toast")).not.toBeVisible();
  await page.evaluate(() => (window.__ui.saveAs = null));
  await fileMenu(page);
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)" })
    .click();
  await expect(page.locator("#toast")).toHaveText(
    "Saved Untitled presentation.pptx to your Puter.",
  );
  // A copy goes where the dialog puts it, and becomes the open presentation.
  await addText(page);
  await page.evaluate(() => (window.__ui.saveAs = "Elsewhere.pptx"));
  await page.keyboard.press("Control+Shift+s");
  await expect(title(page)).toHaveText("Elsewhere");
  await expect(status(page)).toHaveAttribute(
    "title",
    "/test/Documents/Elsewhere.pptx",
  );
  // Its content went with it, so no recovery draft of the original remains.
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await expect(
    page.getByRole("button", { name: /Recovery draft/ }),
  ).toHaveCount(0);
});

test("a cancelled Open dialog leaves things as they were", async ({ page }) => {
  const story = await base64(createDeck("story"));
  await mockDrive(page, { seed: { "~/Desktop/Pick.pptx": story } });
  await expect(title(page)).toHaveText("Untitled presentation");
  await page.keyboard.press("Control+o");
  await page.waitForTimeout(300);
  await expect(title(page)).toHaveText("Untitled presentation");
  await page.evaluate(() => (window.__ui.pick = "/test/Desktop/Pick.pptx"));
  await page.keyboard.press("Control+o");
  await expect(title(page)).toHaveText("Pick");
});
