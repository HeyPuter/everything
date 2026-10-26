import { test, expect } from '@playwright/test';

const tab = (page, name) => page.getByRole('tab', { name, exact: true });
async function openEditor(page, width = 1440) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/mock.html#/new');
  await page.locator('.ribbon-card').waitFor();
  await expect(page.locator('#ribbon-panel-home button[aria-label="Bold"]')).toBeEnabled();
}

test('a large drop-down keeps its arrow beside the last word of its label', async ({ page }) => {
  for (const width of [1440, 600]) {
    await openEditor(page, width);
    for (const name of ['Insert', 'Design', 'Layout', 'References']) {
      await tab(page, name).click();
      const alone = await page.evaluate(() => [...document.querySelectorAll('.ribbon-panel:not([hidden]) .ribbon-large .ribbon-caret')].filter(caret => caret.offsetParent).filter(caret => {
        // The arrow shares a line with text: some glyph of the label ends on the arrow's line.
        const label = caret.closest('.ribbon-large-label'), range = document.createRange();
        range.selectNodeContents(label);
        const box = caret.getBoundingClientRect();
        return ![...range.getClientRects()].some(r => r.width > 8 && r.right <= box.left + 1 && r.top < box.bottom && r.bottom > box.top);
      }).map(caret => caret.closest('.ribbon-large-label').textContent));
      expect(alone, `${name} at ${width}px`).toEqual([]);
    }
  }
});

test('a large split button keeps its two-line label clear of its arrow', async ({ page }) => {
  for (const width of [1440, 600]) {
    await openEditor(page, width);
    await tab(page, 'Review').click();
    // Every glyph of a large split button sits inside one of its two halves, and none crosses the line between them.
    const crossing = await page.evaluate(() => [...document.querySelectorAll('.ribbon-panel:not([hidden]) .ribbon-split.is-large')].filter(wrap => wrap.offsetParent).flatMap(wrap => {
      const [main, arrow] = wrap.children, range = document.createRange();
      return [main, arrow].flatMap(half => {
        const box = half.getBoundingClientRect(), bad = [];
        for (const node of half.querySelectorAll('span')) {
          if (!node.textContent.trim() || node.children.length) continue;
          range.selectNodeContents(node);
          for (const r of range.getClientRects()) if (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) bad.push(`${main.getAttribute('aria-label')}: ${node.textContent}`);
        }
        return bad;
      });
    }));
    expect(crossing, `Review at ${width}px`).toEqual([]);
    await expect(page.getByRole('button', { name: 'Track Changes', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Track Changes options', exact: true })).toBeVisible();
  }
});

test('the ribbon reopens a folded group once there is room for it again', async ({ page }) => {
  for (const width of [800, 900, 1000, 1100, 1200]) {
    await openEditor(page, width);
    for (const name of ['Home', 'Insert', 'Layout', 'Review']) {
      await tab(page, name).click();
      const result = await page.evaluate(() => {
        const panel = document.querySelector('.ribbon-panel:not([hidden])');
        const overflow = panel.scrollWidth > panel.clientWidth + 1, fits = [];
        // Try each folded group open: none may fit without the strip overflowing.
        for (const group of panel.querySelectorAll('.ribbon-group.is-collapsed')) {
          const body = group.querySelector('.ribbon-group-body'), button = group.querySelector('.ribbon-collapsed');
          body.hidden = false; button.hidden = true; group.classList.remove('is-collapsed');
          if (panel.scrollWidth <= panel.clientWidth + 1) fits.push(group.dataset.group);
          body.hidden = true; button.hidden = false; group.classList.add('is-collapsed');
        }
        return { overflow, fits };
      });
      expect(result, `${name} at ${width}px`).toEqual({ overflow: false, fits: [] });
    }
  }
});

test('Page Setup\'s settings button sits in the bottom row, as the Font settings button does', async ({ page }) => {
  await openEditor(page);
  const font = await page.locator('#ribbon-panel-home').getByRole('button', { name: 'Font Settings', exact: true }).boundingBox();
  await tab(page, 'Layout').click();
  const setup = await page.locator('#ribbon-panel-layout').getByRole('button', { name: 'Page setup', exact: true }).boundingBox();
  expect(Math.abs(setup.y - font.y)).toBeLessThanOrEqual(1);
});

test('arrow keys move between the commands of a collapsed group\'s drop-down', async ({ page }) => {
  await openEditor(page, 900);
  const paragraph = page.locator('#ribbon-panel-home .ribbon-collapsed[aria-label="Paragraph"]');
  await paragraph.focus();
  await page.keyboard.press('Enter');
  const flyout = page.locator('.ribbon-flyout');
  const first = flyout.getByRole('button', { name: 'Bulleted list', exact: true });
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(first).not.toBeFocused();
  await expect(flyout.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Home');
  await expect(first).toBeFocused();
  await page.keyboard.press('End');
  await expect(flyout.locator(':focus')).toHaveCount(1);
  await expect(first).not.toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(flyout).toHaveCount(0);
  await expect(paragraph).toBeFocused();
});

test('a collapsed group\'s drop-down closes when the keyboard leaves it', async ({ page }) => {
  await openEditor(page, 900);
  const paragraph = page.locator('#ribbon-panel-home .ribbon-collapsed[aria-label="Paragraph"]');
  const flyout = page.locator('.ribbon-flyout');
  await paragraph.focus();
  await page.keyboard.press('Enter');
  await expect(flyout).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(flyout).toHaveCount(0);
  await expect(paragraph).toHaveAttribute('aria-expanded', 'false');
  // Tab goes on from the ribbon, as from the group's button; the drop-down sits at the end of the page, and Tab
  // from it used to wrap to the top of the page.
  const after = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  await paragraph.focus();
  await page.keyboard.press('Tab');
  expect(after).toBe(await page.evaluate(() => document.activeElement.getAttribute('aria-label')));
  await paragraph.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await expect(flyout).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Home', exact: true })).toBeFocused();

  // A command that hands the keyboard back to the document closes it too.
  await openEditor(page, 720);
  await page.locator('#ribbon-panel-home .ribbon-collapsed[aria-label="Font"]').click();
  await expect(flyout).toHaveCount(1);
  await flyout.getByRole('button', { name: 'Change Case', exact: true }).click();
  await page.getByRole('menuitem', { name: 'UPPERCASE', exact: true }).click();
  await expect(flyout).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();
});

test('closing a drop-down for a tab switch or a wider window keeps the keyboard out of the page body', async ({ page }) => {
  const text = page.getByRole('textbox', { name: 'Document text' });
  await openEditor(page, 900);
  await page.locator('#ribbon-panel-home .ribbon-collapsed[aria-label="Styles"]').click();
  await expect(page.locator('.ribbon-flyout :focus')).toHaveCount(1);
  await tab(page, 'Insert').click();
  await expect(page.locator('.ribbon-flyout')).toHaveCount(0);
  await expect(text).toBeFocused();

  await tab(page, 'Home').click();
  const paragraph = page.locator('#ribbon-panel-home .ribbon-collapsed[aria-label="Paragraph"]');
  await paragraph.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ribbon-flyout :focus')).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(page.locator('.ribbon-flyout')).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement !== document.body && !!document.activeElement.offsetParent)).toBe(true);
});

test('the ribbon keeps a tab stop on a shown command after its groups fold or unfold', async ({ page }) => {
  for (const [from, to] of [[1440, 900], [900, 1440]]) {
    await openEditor(page, from);
    await page.setViewportSize({ width: to, height: 800 });
    await expect.poll(() => page.evaluate(() => {
      const stops = [...document.querySelectorAll('.ribbon-card [tabindex="0"]')];
      return stops.length === 1 && !!stops[0].offsetParent;
    }), `${from} → ${to}px`).toBe(true);
    await tab(page, 'Home').focus();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('#ribbon-panel-home')), `${from} → ${to}px`).toBe(true);
  }
});

test('Tab from a ribbon tab reaches the tab\'s first command until another is chosen', async ({ page }) => {
  await openEditor(page);
  const paste = page.getByRole('button', { name: 'Paste', exact: true });
  await expect(paste).toBeEnabled();
  await tab(page, 'Home').focus();
  await page.keyboard.press('Tab');
  await expect(paste).toBeFocused();
  // A command reached with the arrows stays the stop.
  await page.keyboard.press('ArrowRight');
  const chosen = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  await tab(page, 'Home').focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.getAttribute('aria-label'))).toBe(chosen);
});

test('arrow keys pass over style gallery items clipped from view', async ({ page }) => {
  await openEditor(page, 1280);
  const gallery = page.locator('#ribbon-panel-home .ribbon-gallery');
  await gallery.getByRole('option').first().focus();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('ArrowRight');
    const visible = await page.evaluate(() => {
      const box = document.activeElement.getBoundingClientRect(), frame = document.activeElement.closest('.ribbon-card').getBoundingClientRect();
      const g = document.querySelector('#ribbon-panel-home .ribbon-gallery'), gr = g.getBoundingClientRect();
      return g.scrollLeft === 0 && box.right <= frame.right && (!document.activeElement.closest('.ribbon-gallery') || box.right <= gr.right + 1);
    });
    expect(visible, `after ${i + 1} presses`).toBe(true);
  }
});

test('the ribbon\'s tab list holds only tabs, with File beside it', async ({ page }) => {
  await openEditor(page);
  const tablist = page.getByRole('tablist', { name: 'Ribbon tabs' });
  expect(await tablist.evaluate(el => [...el.children].every(child => child.getAttribute('role') === 'tab'))).toBe(true);
  await expect(tablist.getByRole('button', { name: 'File' })).toHaveCount(0);
  const file = await page.getByRole('button', { name: 'File', exact: true }).boundingBox();
  const home = await tab(page, 'Home').boundingBox();
  expect(Math.abs(file.y - home.y)).toBeLessThanOrEqual(1);
  expect(home.x).toBeGreaterThan(file.x + file.width);
});

test('Page Color shows each color beside its name', async ({ page }) => {
  await openEditor(page);
  await tab(page, 'Design').click();
  await page.locator('#ribbon-panel-design').getByRole('button', { name: 'Page Color', exact: true }).click();
  const swatch = name => page.getByRole('menuitemradio', { name, exact: true }).locator('.menu-swatch');
  await expect(swatch('Light blue')).toHaveCSS('background-color', 'rgb(222, 234, 246)');
  await expect(swatch('No Color')).toHaveClass(/is-none/);
  // Swatches carry no text, so each item's name is still just the color's name.
  await expect(page.getByRole('menuitemradio', { name: 'Light teal', exact: true })).toBeVisible();
});

test('the Shapes gallery draws Line Arrow with its arrowhead', async ({ page }) => {
  await openEditor(page);
  await tab(page, 'Insert').click();
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Shapes', exact: true }).click();
  const pixels = name => page.getByRole('menuitem', { name, exact: true }).locator('canvas').evaluate(canvas => {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let inked = 0; for (let i = 3; i < data.length; i += 4) if (data[i] > 40) inked++;
    return inked;
  });
  expect(await pixels('Line Arrow')).toBeGreaterThan(await pixels('Line') + 10);
});

test('the Shapes gallery\'s lines stand out from a dark menu', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openEditor(page);
  await tab(page, 'Insert').click();
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Shapes', exact: true }).click();
  const brightest = await page.getByRole('menuitem', { name: 'Line', exact: true }).locator('canvas').evaluate(canvas => {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let best = 0; for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 100) best = Math.max(best, (data[i] + data[i + 1] + data[i + 2]) / 3);
    return best;
  });
  expect(brightest).toBeGreaterThan(140);
});

test('a ribbon menu the mouse opens starts with no item chosen; one the keyboard opens starts on its first item', async ({ page }) => {
  await openEditor(page);
  const focusedItem = () => page.evaluate(() => document.activeElement.closest('.menu') && document.activeElement !== document.activeElement.closest('.menu') ? document.activeElement.textContent.trim() : null);
  await page.getByRole('menubar', { name: 'Menu bar' }).getByRole('menuitem', { name: 'File', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'File' })).toBeVisible();
  expect(await focusedItem()).toBeNull();
  await page.keyboard.press('ArrowDown');
  expect(await focusedItem()).toBe('New Document');
  await page.keyboard.press('Escape');
  for (const [name, menu] of [['Paste options', 'Paste options'], ['Change Case', 'Change Case'], ['Bullet Library', 'Bullet Library']]) {
    await page.locator('#ribbon-panel-home').getByRole('button', { name, exact: true }).click();
    await expect(page.locator(`.menu[aria-label="${menu}"]`)).toBeVisible();
    expect(await focusedItem(), name).toBeNull();
    await page.keyboard.press('Escape');
  }
  await page.locator('#ribbon-panel-home').getByRole('button', { name: 'Change Case', exact: true }).focus();
  await page.keyboard.press('Enter');
  expect(await focusedItem()).toBe('Sentence case.');
});

test('a gallery\'s More menu opened from the keyboard closes back to its button, and a choice goes to the document', async ({ page }) => {
  await openEditor(page);
  const focused = () => page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  await tab(page, 'Insert').click();
  await page.getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '3 columns, 3 rows' }).click();
  for (const [tabName, more, menu] of [['Home', 'More Styles', 'Styles'], ['Design', 'More Style Sets', 'Style Sets'], ['Table Design', 'More Table Styles', 'Table Styles']]) {
    await tab(page, tabName).click();
    const button = page.locator('.ribbon-panel:not([hidden])').getByRole('button', { name: more, exact: true });
    // It says it opens a menu, as the ribbon's other menu buttons do.
    await expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(`.menu[aria-label="${menu}"]`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(`.menu[aria-label="${menu}"]`)).toHaveCount(0);
    await expect.poll(focused, more).toBe(more);
    // Choosing from the menu still acts on the document and leaves the keyboard there.
    await page.keyboard.press('Enter');
    await expect(page.locator(`.menu[aria-label="${menu}"]`)).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator(`.menu[aria-label="${menu}"]`)).toHaveCount(0);
    await expect.poll(focused, more).toBe('Document text');
  }
  // A shape's style gallery, whose choices are previews in a grid.
  await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.press('Enter');
  await tab(page, 'Insert').click();
  await page.getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.locator('.shape-gallery-item').nth(2).click();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 200, y: 400 } });
  await tab(page, 'Shape Format').click();
  const more = page.locator('.ribbon-panel:not([hidden])').getByRole('button', { name: 'More Shape Styles', exact: true });
  await expect(more).toHaveAttribute('aria-haspopup', 'menu');
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.menu[aria-label="Shape Styles"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(focused).toBe('More Shape Styles');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('.menu[aria-label="Shape Styles"]')).toHaveCount(0);
  await expect.poll(focused).toBe('Document text');
});

test('the arrow keys step the Layout tab\'s indent and spacing fields, keeping the keyboard in the field', async ({ page }) => {
  await openEditor(page, 1600);
  await page.getByRole('textbox', { name: 'Document text' }).fill('A paragraph to indent.');
  await tab(page, 'Layout').click();
  const panel = page.locator('#ribbon-panel-layout');
  const paragraph = () => page.evaluate(() => { const m = window.__docs.current.view.engine.model; return { left: m.paragraphFormatting?.indentLeft, before: m.paragraphFormatting?.spaceBefore ?? m.paragraphs[0].format?.spaceBefore }; });
  for (const [name, from, to] of [['Indent left (in)', '0', '0.3'], ['Space before paragraph (pt)', '0', '3']]) {
    const field = panel.getByRole('spinbutton', { name, exact: true });
    await expect(field).toHaveValue(from);
    await field.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(to);
    await page.keyboard.press('ArrowDown');
    await expect(field).toBeFocused();
  }
  // Enter in the indent field still applies and goes back to the document.
  await panel.getByRole('spinbutton', { name: 'Indent left (in)', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();
  const after = await paragraph();
  expect(after.left).toBe(288); // 0.2 in, in twips
  expect(await panel.getByRole('spinbutton', { name: 'Space before paragraph (pt)', exact: true }).inputValue()).toBe('2');
  // A table row's height: stepping kept the caret in the table, so the table's tab stays.
  await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.press('Enter');
  await tab(page, 'Insert').click();
  await page.getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '3 columns, 3 rows' }).click();
  await tab(page, 'Table Layout').click();
  const height = page.locator('#ribbon-panel-tableLayout').getByRole('spinbutton', { name: 'Height (in)', exact: true });
  const start = Number(await height.inputValue());
  await height.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
  await expect(height).toBeFocused();
  await expect.poll(async () => Number(await height.inputValue())).toBeCloseTo(start + 0.03, 5);
  // A shape's size applies a moment after each step; the keyboard stays in the field meanwhile.
  await page.keyboard.press('Escape');
  await tab(page, 'Insert').click();
  await page.getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.locator('.shape-gallery-item').nth(2).click();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 200, y: 600 } });
  await tab(page, 'Shape Format').click();
  const shapeHeight = page.locator('#ribbon-panel-shapeFormat').getByRole('spinbutton', { name: 'Shape height (in)', exact: true });
  const shapeStart = Number(await shapeHeight.inputValue());
  await shapeHeight.focus();
  for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowUp'); await page.waitForTimeout(150); }
  await expect(shapeHeight).toBeFocused();
  await expect.poll(async () => Number(await shapeHeight.inputValue())).toBeCloseTo(shapeStart + 0.03, 5);
  // A typed size and Enter still apply and return to the document.
  await shapeHeight.fill('1.5');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();
  await expect(shapeHeight).toHaveValue('1.5');
});

test('the subscript and superscript icons draw their digit large enough to read at 16px', async ({ page }) => {
  await openEditor(page);
  for (const name of ['Subscript', 'Superscript']) {
    const height = await page.locator('#ribbon-panel-home').getByRole('button', { name, exact: true }).locator('svg.ico g.txb').evaluate(g => g.getBoundingClientRect().height);
    expect(height, name).toBeGreaterThanOrEqual(5);
  }
});

test('commands that sit together on a tab draw different icons', async ({ page }) => {
  await openEditor(page);
  const icon = (panel, name) => page.locator(`#ribbon-panel-${panel}`).getByRole('button', { name, exact: true }).locator('svg.ico').first().innerHTML();
  await tab(page, 'Review').click();
  expect(await icon('review', 'Resolve Comment')).not.toBe(await icon('review', 'Accept'));
  await tab(page, 'References').click();
  expect(await icon('references', 'Update Fields')).not.toBe(await icon('references', 'Update Table'));
  await tab(page, 'Insert').click();
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Header' }).click();
  await expect(tab(page, 'Header & Footer')).toHaveAttribute('aria-selected', 'true');
  expect(await icon('headerFooter', 'Go to Header')).not.toBe(await icon('headerFooter', 'Header'));
  expect(await icon('headerFooter', 'Go to Footer')).not.toBe(await icon('headerFooter', 'Footer'));
});

test('ribbon tooltips name the Mac\'s Option key and lead with the command\'s own name', async ({ page }) => {
  await openEditor(page);
  const mac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || ''));
  await tab(page, 'View').click();
  const nav = await page.locator('#ribbon-panel-view').getByRole('button', { name: 'Navigation Pane', exact: true }).getAttribute('title');
  expect(nav).toBe(mac ? 'Navigation Pane (Cmd+Option+O)' : 'Navigation Pane (Ctrl+Alt+O)');
  await tab(page, 'Home').click();
  const clear = page.locator('#ribbon-panel-home').getByRole('button', { name: 'Clear All Formatting', exact: true });
  expect(await clear.getAttribute('title')).toMatch(/^Clear All Formatting \((Cmd|Ctrl)\+Space\)/);
});

test('contrast themes keep the current tab, pressed commands and chosen style marked', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await openEditor(page);
  const marked = locator => locator.evaluate(el => getComputedStyle(el).outlineStyle !== 'none' && parseFloat(getComputedStyle(el).outlineWidth) >= 2);
  expect(await marked(page.locator('#ribbon-panel-home .ribbon-style[aria-selected="true"]'))).toBe(true);
  expect(await marked(page.locator('#ribbon-panel-home .ribbon-style[aria-selected="false"]').first())).toBe(false);
  await tab(page, 'View').click();
  expect(await marked(page.locator('#ribbon-panel-view').getByRole('button', { name: 'Print Layout', exact: true }))).toBe(true);
  expect(await marked(page.locator('#ribbon-panel-view').getByRole('button', { name: 'Focus', exact: true }))).toBe(false);
  expect(await tab(page, 'View').evaluate(el => getComputedStyle(el, '::after').forcedColorAdjust)).toBe('none');
});

test('a tab row too narrow for its tabs fades at the edge with more tabs beyond it', async ({ page }) => {
  await openEditor(page, 1440);
  const row = page.locator('.ribbon-tabs');
  await expect(row).not.toHaveClass(/more-after/);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(row).toHaveClass(/more-after/);
  await expect(row).not.toHaveClass(/more-before/);
  expect(await row.evaluate(el => getComputedStyle(el).maskImage)).toContain('gradient');
  await row.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expect(row).toHaveClass(/more-before/);
  await expect(row).not.toHaveClass(/more-after/);
});

test('Page Borders checks the border the page has', async ({ page }) => {
  await openEditor(page);
  await tab(page, 'Design').click();
  const borders = page.locator('#ribbon-panel-design').getByRole('button', { name: 'Page Borders', exact: true });
  await borders.click();
  await page.getByRole('menuitemradio', { name: 'Box, 1½ pt line' }).click();
  await borders.click();
  await expect(page.getByRole('menuitemradio', { name: 'Box, 1½ pt line' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemradio', { name: 'Box, ½ pt line' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('menuitemradio', { name: 'No Border' })).toHaveAttribute('aria-checked', 'false');
});

test('Insert → Page Number is a drop-down that returns the keyboard where it came from', async ({ page }) => {
  await openEditor(page);
  await tab(page, 'Insert').click();
  const button = page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Page Number', exact: true });
  await expect(button).toHaveAttribute('aria-haspopup', 'menu');
  await expect(button.locator('.ribbon-caret')).toHaveCount(1);
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: 'Page Number' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  // Choosing a number still leaves the keyboard in the document.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => !!document.activeElement.closest('.ribbon-card'))).toBe(false);
});

test('Replace starts in Find when there is nothing to find yet, and in Replace with once there is', async ({ page }) => {
  await openEditor(page);
  const text = page.getByRole('textbox', { name: 'Document text' });
  await text.fill('alpha beta');
  await page.locator('#ribbon-panel-home').getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Find text', exact: true })).toBeFocused();
  await page.keyboard.type('beta');
  await page.keyboard.press('Escape');
  await text.focus();
  await page.locator('#ribbon-panel-home').getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Replace with' })).toBeFocused();
});

test('the Navigation Pane is a full-width sheet on phones and a side pane on wider screens', async ({ page }) => {
  await openEditor(page, 600);
  await page.locator('#ribbon-panel-home').getByRole('button', { name: 'Find', exact: true }).click();
  const pane = page.locator('.nav-pane');
  await expect(pane).toBeVisible();
  expect(Math.round((await pane.boundingBox()).width)).toBeGreaterThanOrEqual(598);
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect.poll(async () => Math.round((await pane.boundingBox()).width)).toBe(260);
});

test('side panes give up width before the page does', async ({ page }) => {
  await openEditor(page);
  await tab(page, 'View').click();
  await page.locator('#ribbon-panel-view').getByRole('button', { name: 'Show Formatting Pane' }).click();
  await page.locator('#ribbon-panel-view').getByRole('button', { name: 'Navigation Pane', exact: true }).click();
  await tab(page, 'Review').click();
  await page.locator('#ribbon-panel-review').getByRole('button', { name: 'Reviewing Pane', exact: true }).click();
  for (const width of [1440, 1024, 820, 720]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.evaluate(() => {
      const content = document.querySelector('.canvas-editor-content'), surface = document.querySelector('.canvas-document-surface');
      return content.scrollWidth <= content.clientWidth && surface.getBoundingClientRect().width >= Math.min(360, innerWidth * 0.4) - 1;
    }), `${width}px`).toBe(true);
  }
});

test('on phones the Reviewing Pane is a sheet above the status bar, not over it', async ({ page }) => {
  await openEditor(page, 600);
  await tab(page, 'Review').click();
  await page.locator('#ribbon-panel-review').getByRole('button', { name: 'Reviewing Pane', exact: true }).click();
  const pane = await page.locator('.review-pane').boundingBox(), status = await page.locator('.ed-statusbar').boundingBox();
  const surface = await page.locator('.canvas-document-surface').boundingBox();
  expect(pane.y + pane.height).toBeLessThanOrEqual(status.y + 1);
  expect(surface.y + surface.height).toBeLessThanOrEqual(pane.y + 1);
});

test('on a wide touch screen the ribbon grows to its fingertip-high rows instead of clipping them', async ({ browser }) => {
  for (const viewport of [{ width: 820, height: 1180 }, { width: 1180, height: 820 }]) {
    const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
      await page.goto('/mock.html#/new');
      await expect(page.locator('#ribbon-panel-home button[aria-label="Bold"]')).toBeEnabled();
      for (const name of ['Home', 'Insert', 'References']) {
        await tab(page, name).click();
        // Rows of 44px commands in the 72px card cut off the Paste icon and hid Cut and Format Painter.
        const clipped = await page.evaluate(() => {
          const panel = [...document.querySelectorAll('.ribbon-panel')].find(p => !p.hidden), box = panel.getBoundingClientRect();
          return [...panel.querySelectorAll('button, input')].filter(b => { const r = b.getBoundingClientRect(); return r.width && (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5); }).map(b => b.getAttribute('aria-label') || b.textContent.trim());
        });
        expect(clipped, `${name} at ${viewport.width}px`).toEqual([]);
      }
      await tab(page, 'Home').click();
      for (const name of ['Cut', 'Copy', 'Format Painter']) await expect(page.locator('#ribbon-panel-home').getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
    } finally { await context.close(); }
  }
});

test('on a Mac the Thesaurus tooltip names a chord that opens the Thesaurus, not one that collapses the ribbon', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await openEditor(page);
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Happy people');
  await input.evaluate(el => { el.focus(); el.setSelectionRange(0, 5); el.dispatchEvent(new Event('select')); });
  await tab(page, 'Review').click();
  const title = await page.locator('#ribbon-panel-review').getByRole('button', { name: 'Thesaurus', exact: true }).getAttribute('title');
  const chord = title.match(/\(([^)]+)\)/)[1];
  // Cmd+Option+R belongs to Collapse the Ribbon, which takes it first.
  await input.focus();
  await page.keyboard.press(chord.replace('Cmd', 'Meta').replace('Option', 'Alt'));
  await expect(page.getByRole('complementary', { name: 'Thesaurus pane' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse the ribbon' })).toBeAttached();
});

test('Escape closes a collapsed group\'s drop-down whose commands are all unavailable', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto('/mock.html#/new');
    await expect(page.locator('#ribbon-panel-home button[aria-label="Bold"]')).toBeEnabled();
    await tab(page, 'Review').click();
    // With nothing tracked, every command under Changes is disabled, so the keyboard stays on the group's button.
    const changes = page.locator('#ribbon-panel-review .ribbon-collapsed[aria-label="Changes"]');
    await expect(changes).toBeVisible();
    await changes.focus();
    await page.keyboard.press('Enter');
    const flyout = page.locator('.ribbon-flyout');
    await expect(flyout).toBeVisible();
    await expect(changes).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(flyout).toHaveCount(0);
    await expect(changes).toHaveAttribute('aria-expanded', 'false');
    await expect(changes).toBeFocused();
  } finally { await context.close(); }
});
