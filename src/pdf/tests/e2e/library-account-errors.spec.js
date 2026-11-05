import { test, expect } from '@playwright/test';

for (const action of ['Download', 'Rename', 'Delete', 'Duplicate'])
  for (const newer of ['none', 'sign-out', 'other account'])
    test(`${action}'s late cloud failure respects ${newer}`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('https://js.puter.com/**', (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: `window.account={username:'Alice'};
        const fail=()=>new Promise((resolve,reject)=>{window.failAction=()=>{
          reject(new Error(${JSON.stringify(`${action} failed for Alice`)}));setTimeout(()=>{window.failureDone=true;},0);
        };});
        window.puter={env:'web',auth:{isSignedIn:()=>!!window.account,getUser:async()=>window.account,
          signOut:async()=>{window.account=null;},signIn:async()=>{window.account={username:'Bob'};}},
          fs:{readdir:async()=>[{name:'private.pdf',path:'PDF Editor/private.pdf'}],
            read:async()=>${JSON.stringify(action)}==='Download'?fail():new Blob(['private content']),
            write:fail,rename:fail,delete:fail},ui:{}};`,
        }),
      );
      await page.goto('/#library');
      await expect(page.locator('.account-label')).toHaveText('Alice');
      await page.getByRole('button', { name: 'Options for private.pdf', exact: true }).click();
      await page.getByRole('button', { name: action, exact: true }).click();
      if (action === 'Rename') {
        // An unchanged name asks nothing of Puter, so the rename needs a new one.
        const dialog = page.getByRole('dialog', { name: 'Rename PDF', exact: true });
        await dialog.getByLabel('File name').fill('renamed');
        await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
      }
      if (action === 'Delete')
        await page
          .getByRole('dialog', { name: 'Delete PDF?', exact: true })
          .getByRole('button', { name: 'Delete PDF', exact: true })
          .click();
      await expect.poll(() => page.evaluate(() => typeof window.failAction)).toBe('function');
      if (action === 'Download' || action === 'Duplicate') await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      if (newer !== 'none') {
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await settings.getByRole('button', { name: 'Sign out', exact: true }).click();
        await expect(page.locator('.account-label')).toHaveText('Local workspace');
        if (newer === 'other account') {
          await page.getByRole('button', { name: 'Settings', exact: true }).click();
          await settings.getByRole('button', { name: 'Sign in with Puter', exact: true }).click();
          await expect(page.locator('.account-label')).toHaveText('Bob');
        }
      }
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const appearance = settings.getByLabel('Appearance', { exact: true });
      await appearance.focus();
      await page.evaluate(() => window.failAction());
      await expect.poll(() => page.evaluate(() => window.failureDone)).toBe(true);
      if (newer === 'none')
        await expect(settings.getByRole('alert')).toHaveText(`${action} failed for Alice`);
      else {
        await expect(settings.getByRole('alert')).toBeHidden();
        await expect(page.locator('#toast')).toBeHidden();
      }
      await expect(appearance).toBeFocused();
      await expect(page.locator('.account-label')).toHaveText(
        newer === 'none' ? 'Alice' : newer === 'other account' ? 'Bob' : 'Local workspace',
      );
      expect(errors).toEqual([]);
    });
