import { test, expect } from "@playwright/test";
import { addText } from "./editor-commands.js";

// Nobody has to sign in to work: the app opens into a new presentation, and
// Puter's sign-in is asked for when a presentation is saved to the cloud.
async function mockPuter(page, { signedIn = false } = {}) {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `(()=>{let signedIn=${signedIn};const files={};window.__writes=[];window.__signIns=0;window.puter={env:'web',auth:{isSignedIn:async()=>signedIn,getUser:async()=>({username:'test-user',uuid:'test-user-id'}),signIn:async()=>{window.__signIns++;signedIn=true},signOut:async()=>{signedIn=false}},kv:new Proxy({},{get(){throw Error('KV is forbidden')}}),fs:{readdir:async()=>Object.values(files),write:async(path,blob,options)=>{const actual=path.startsWith('/')?path:'/test/'+path;window.__writes.push({path:actual,options,size:blob.size});files[actual]={path:actual,name:actual.split('/').pop(),modified:Date.now()/1000,bytes:blob};return files[actual];},read:async path=>files[path].bytes,rename:async(path,name)=>({path:path.slice(0,path.lastIndexOf('/')+1)+name}),delete:async path=>delete files[path]},ui:{onLaunchedWithItems:()=>{}}};})();`,
    }),
  );
}
const draftRows = (page) =>
  page.getByRole("button", { name: /Recovery draft/ });
// The editor header hides the account button on phones, so its text is read
// through the locator rather than its role.

test("opens into a new presentation without a sign-in", async ({ page }) => {
  await mockPuter(page);
  await page.goto("/");
  await expect(page.locator(".editor")).toBeVisible();
  await expect(page.locator(".document-title")).toHaveText(
    "Untitled presentation",
  );
  await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 1");
  await expect(page.locator("#save-status")).toHaveText("Not saved yet");
  await expect(
    page.getByRole("button", { name: "Sign in to save", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".editor-header .account-button")).toHaveText(
    "Account",
  );
  expect(await page.evaluate(() => window.__signIns)).toBe(0);
  expect(await page.evaluate(() => window.__writes.length)).toBe(0);
  expect(await page.evaluate(() => location.hash)).toBe("");

  // Leaving the untouched deck asks nothing and leaves no draft behind.
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe("#/home");
  await expect(page.locator("#file-list")).toContainText(
    "Your next story starts here",
  );
  await expect(draftRows(page)).toHaveCount(0);

  // The library keeps its URL through a reload; the root opens the editor again.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Good ideas deserve a stage." }),
  ).toBeVisible();
  await page.goto("/");
  await page.reload();
  await expect(page.locator(".editor")).toBeVisible();
});

test("edits stay on this device until the save button signs the guest in", async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto("/");
  await expect(page.locator(".editor")).toBeVisible();
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(1);
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  expect(await page.evaluate(() => window.__writes.length)).toBe(0);
  expect(await page.evaluate(() => window.__signIns)).toBe(0);

  await page
    .getByRole("button", { name: "Sign in to save", exact: true })
    .click();
  await expect(page.locator("#save-status")).toHaveText("Saved to Puter");
  expect(await page.evaluate(() => window.__signIns)).toBe(1);
  expect(await page.evaluate(() => window.__writes.length)).toBe(1);
  await expect(page.locator(".editor-header .account-button")).toHaveText(
    "test-user",
  );
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in to save", exact: true }),
  ).toHaveCount(0);

  // The library lists the cloud file, not a recovery draft.
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await expect(
    page.getByRole("button", {
      name: "Untitled presentation PowerPoint presentation",
      exact: true,
    }),
  ).toBeVisible();
  await expect(draftRows(page)).toHaveCount(0);
});

test("a signed-in visitor lands in the editor too, with the account in the header", async ({
  page,
}) => {
  await mockPuter(page, { signedIn: true });
  await page.goto("/");
  await expect(page.locator(".editor")).toBeVisible();
  await expect(page.locator(".editor-header .account-button")).toHaveText(
    "test-user",
  );
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#save-status")).toHaveText("Not saved yet");
  expect(await page.evaluate(() => window.__writes.length)).toBe(0);
});

test("a sign-in the SDK performs on its own is picked up by the header", async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Sign in to save", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    puter.onAuth({ username: "test-user", uuid: "test-user-id" }),
  );
  await expect(page.locator(".editor-header .account-button")).toHaveText(
    "test-user",
  );
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeVisible();
});
