import { test, expect } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } });

// On a touch screen every title bar control reaches a fingertip's height (44px), as its quick access commands
// do: the pills and small buttons were 28 to 32px high, and puter.js's account picture, which stands in for the
// account button, lost the reach that button had. The element is stubbed as the real one is: an open shadow
// root whose Upgrade, Apps and picture are parts in a row, the picture clipping what overflows it.
test('a tap just above or below a title bar control still reaches it on a touch screen', async ({ page }) => {
  await page.addInitScript(() => {
    customElements.define('puter-user-menu', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML =
          '<style>:host { display: inline-flex; align-items: center; gap: 8px; }' +
          '.avatar { position: relative; overflow: hidden; border: none; border-radius: 50%; }</style>' +
          '<button type="button" class="upgrade-button" part="upgrade-button">Upgrade</button>' +
          '<button type="button" class="apps-button" part="apps-button" aria-label="Apps">A</button>' +
          '<button type="button" class="avatar" part="avatar" aria-label="Account: Alice">A</button>';
      }
    });
  });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  const missed = await page.evaluate(() => {
    const bar = document.querySelector('.ed-titlebar').getBoundingClientRect();
    const middle = bar.top + bar.height / 2;
    const menu = document.querySelector('.ed-header puter-user-menu');
    const controls = [
      ...['Editing mode: Editing', 'Assistant', 'Comments', 'Share', 'Settings', 'Menus', 'Customize Quick Access Toolbar']
        .map(name => document.querySelector(`.ed-titlebar [aria-label="${name}"]`)),
      menu.shadowRoot.querySelector('.avatar'),
      menu.shadowRoot.querySelector('.upgrade-button'),
    ];
    const hit = (x, y) => {
      let target = document.elementFromPoint(x, y);
      while (target?.shadowRoot) {
        const inner = target.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === target) break;
        target = inner;
      }
      return target;
    };
    return controls.flatMap(control => {
      if (!control) return ['a control is missing'];
      const box = control.getBoundingClientRect(), x = box.left + box.width / 2;
      return [middle - 20, middle + 20].filter(y => {
        const target = hit(x, y);
        return !(target === control || control.contains(target));
      }).map(y => `${control.getAttribute('aria-label') || control.textContent} at ${Math.round(y - middle)}px`);
    }).concat(
      // Upgrade, an icon 32px wide here, reaches a fingertip's width as well.
      [-20, 20].filter(dx => {
        const control = menu.shadowRoot.querySelector('.upgrade-button'), box = control.getBoundingClientRect();
        return hit(box.left + box.width / 2 + dx, middle) !== control;
      }).map(dx => `Upgrade at ${dx}px across`));
  });
  expect(missed).toEqual([]);
});

test('signed out, a tap just above or below "Sign in to save" still reaches it on a touch screen', async ({ page }) => {
  await page.goto('/mock.html?signedout#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const status = page.locator('.ed-titlebar .canvas-save-status');
  await expect(status).toHaveAttribute('aria-label', 'Sign in to save');
  expect(await status.evaluate(control => {
    const bar = document.querySelector('.ed-titlebar').getBoundingClientRect(), middle = bar.top + bar.height / 2;
    const box = control.getBoundingClientRect(), x = box.left + box.width / 2;
    return [middle - 20, middle + 20].every(y => control.contains(document.elementFromPoint(x, y)));
  })).toBe(true);
});
