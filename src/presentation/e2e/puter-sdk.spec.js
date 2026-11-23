import { test, expect } from "@playwright/test";
import { addText } from "./editor-commands.js";
import { P, createDeck } from "../src/model.js";

// Puter's SDK loads beside the app, which waits for it a while before its
// first screen (sdkReady in src/cloud.js). A request for the script that
// never answers must not leave the page blank.

const SDK = (username) =>
  `window.puter={env:"web",auth:{isSignedIn:async()=>true,getUser:async()=>({username:${JSON.stringify(username)},uuid:"late-user-id"}),signIn:async()=>{},signOut:async()=>{}},fs:{readdir:async()=>[],write:async()=>({})},ui:{onLaunchedWithItems:()=>{}}};`;

test("the app starts without the cloud when Puter's script never answers", async ({
  page,
}) => {
  test.setTimeout(45000);
  await page.route("https://js.puter.com/v2/", () => {});
  // The page's load event waits for the script, so goto must not.
  await page.goto("/", { waitUntil: "commit" });
  await expect(page).toHaveTitle(/Untitled presentation/, { timeout: 20000 });
  await expect(page.locator(".save-button")).toHaveText(/Sign in to save/);
});

test("a Puter script that arrives late signs the account in after all", async ({
  page,
}) => {
  test.setTimeout(45000);
  let answer;
  await page.route("https://js.puter.com/v2/", (route) => {
    answer = () =>
      route.fulfill({
        contentType: "application/javascript",
        body: SDK("late-user"),
      });
  });
  await page.goto("/", { waitUntil: "commit" });
  await expect(page).toHaveTitle(/Untitled presentation/, { timeout: 20000 });
  await expect(page.locator(".save-button")).toHaveText(/Sign in to save/);
  await answer();
  await expect(page.locator(".save-button")).toHaveText("Save");
});

// Inside the Puter desktop, the file the app was launched with arrives with
// the SDK. Work begun on the new presentation meanwhile is not put away
// unasked.
test("a file launched with a late Puter script asks before putting away work begun meanwhile", async ({
  page,
}) => {
  test.setTimeout(45000);
  const story = Buffer.from(
    await P.savePresentation(createDeck("story")),
  ).toString("base64");
  let answer;
  await page.route("https://js.puter.com/v2/", (route) => {
    answer = () =>
      route.fulfill({
        contentType: "application/javascript",
        body: `(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(story)}),c=>c.charCodeAt(0));const f={path:"/test/Desktop/Launched.pptx",name:"Launched.pptx",uid:"launched",modified:1700000000,size:bytes.length,is_dir:false};window.puter={env:"app",auth:{isSignedIn:async()=>true,getUser:async()=>({username:"test-user",uuid:"test-user-id"}),signIn:async()=>{},signOut:async()=>{}},fs:{readdir:async()=>[],stat:async()=>f,read:async()=>new Blob([bytes]),write:async(p)=>({...f,path:p})},ui:{onLaunchedWithItems:(cb)=>cb([f]),setWindowTitle:async()=>{}}};})();`,
      });
  });
  await page.goto("/", { waitUntil: "commit" });
  await expect(page).toHaveTitle(/Untitled presentation/, { timeout: 20000 });
  const before = await page.locator(".object-hit").count();
  await addText(page);
  await expect(page.locator(".object-hit")).toHaveCount(before + 1);
  await answer();
  const prompt = page.getByRole("dialog", { name: "Open “Launched”?" });
  await prompt.getByRole("button", { name: "Not now" }).click();
  await expect(page).toHaveTitle(/Untitled presentation/);
  await expect(page.locator(".object-hit")).toHaveCount(before + 1);
});
