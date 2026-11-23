import { test, expect } from '@playwright/test';

async function mount(page) {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  await page.evaluate(async () => {
    const { createImageLayer } = await import('/src/image-layer.js');
    const paper = document.createElement('div');
    paper.className = 'paper';
    Object.assign(paper.style, {
      width: '400px',
      height: '400px',
      position: 'relative',
      margin: '0',
    });
    document.body.replaceChildren(paper);
    const entries = [80, 240].map((x, ordinal) => ({
      id: `shape-${ordinal}`,
      ordinal,
      editable: true,
      kind: 'shape',
      transform: [80, 0, 0, 60, x, 140],
      clips: [],
      filled: false,
      stroked: false,
    }));
    const viewport = {
      width: 400,
      height: 400,
      scale: 1,
      userUnit: 1,
      transform: [1, 0, 0, -1, 0, 400],
      convertToPdfPoint: (x, y) => [x, 400 - y],
    };
    const pending = [],
      commits = [];
    const layer = createImageLayer({
      beforeSelect: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
      onCommit: async (entry, change) => {
        commits.push({ ordinal: entry.ordinal, transform: change.transform });
        entry.transform = change.transform;
        if (window.holdObjectCommit)
          await new Promise((resolve) => {
            window.finishObjectCommit = resolve;
          });
      },
      onChange: () => {},
      preparePreview: async () => ({
        image: document.createElement('canvas'),
        background: document.createElement('canvas'),
      }),
    });
    paper.append(layer.targets, layer.controls, layer.preview);
    layer.render(entries, viewport, 'first', 'page-1');
    layer.setBusy(false);
    window.selectionTest = { layer, pending, commits, entries, viewport };
  });
}

for (const action of ['cancel', 'close', 'disable', 'destroy', 'render', 'resize'])
  test(`pending object selection cannot return after ${action}`, async ({ page }) => {
    await mount(page);
    await page.getByRole('button', { name: 'Select shape 1', exact: true }).press('Enter');
    await expect.poll(() => page.evaluate(() => window.selectionTest.pending.length)).toBe(1);
    await page.evaluate(async (action) => {
      const { layer, pending, entries, viewport } = window.selectionTest;
      if (action === 'disable') layer.setEnabled(false);
      else if (action === 'render') layer.render(entries, viewport, 'another-page');
      else if (action === 'resize')
        layer.render(entries, { ...viewport, transform: [2, 0, 0, -2, 0, 800] }, 'zoom', 'page-1');
      else layer[action]();
      pending[0].resolve();
      await new Promise(requestAnimationFrame);
    }, action);
    await expect(page.locator('.image-controls')).toBeHidden();
    await expect(page.locator('[aria-pressed="true"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.selectionTest.commits)).toEqual([]);
  });

test('a cancelled selection resolving late cannot replace the newer object selection', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: 'Select shape 1', exact: true }).press('Enter');
  await page.evaluate(() => window.selectionTest.layer.cancel());
  await page.getByRole('button', { name: 'Select shape 2', exact: true }).press('Enter');
  await expect.poll(() => page.evaluate(() => window.selectionTest.pending.length)).toBe(2);
  await page.evaluate(() => window.selectionTest.pending[1].resolve());
  await expect(page.getByRole('button', { name: 'Select shape 2', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.evaluate(async () => {
    window.selectionTest.pending[0].resolve();
    await new Promise(requestAnimationFrame);
  });
  await expect(page.getByRole('button', { name: 'Select shape 2', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('an older selection failure cannot discard a newer released object drag', async ({ page }) => {
  await mount(page);
  await page.getByRole('button', { name: 'Select shape 1', exact: true }).click();
  await page.evaluate(() => window.selectionTest.layer.cancel());
  const box = await page.getByRole('button', { name: 'Select shape 2', exact: true }).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.selectionTest.pending.length)).toBe(2);
  await page.evaluate(async () => {
    window.selectionTest.pending[0].reject(new Error('Earlier selection failed'));
    await new Promise(requestAnimationFrame);
  });
  await page.evaluate(() => window.selectionTest.pending[1].resolve());
  await expect
    .poll(() => page.evaluate(() => window.selectionTest.commits))
    .toEqual([{ ordinal: 1, transform: [80, 0, 0, 60, 260, 130] }]);
});

for (const mode of ['keyboard', 'drag'])
  test(`pending ${mode} selection survives a draft-triggered reload of the same page`, async ({
    page,
  }) => {
    await mount(page);
    const target = page.getByRole('button', { name: 'Select shape 1', exact: true });
    const box = await target.boundingBox();
    if (mode === 'keyboard') await target.press('Enter');
    else {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
    }
    await expect.poll(() => page.evaluate(() => window.selectionTest.pending.length)).toBe(1);
    await page.evaluate(() => {
      const { layer, entries, viewport } = window.selectionTest;
      layer.setBusy(true);
      layer.close(true);
      layer.render(
        entries.map((entry) => ({ ...entry, id: entry.id + '-reloaded' })),
        viewport,
        'second',
        'page-1',
      );
      layer.setBusy(false);
    });
    if (mode === 'drag') {
      await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10);
      await page.mouse.up();
    }
    await page.evaluate(() => window.selectionTest.pending[0].resolve());
    await expect(
      page.getByRole('button', { name: 'Move selected shape', exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.selectionTest.commits))
      .toEqual(mode === 'drag' ? [{ ordinal: 0, transform: [80, 0, 0, 60, 100, 130] }] : []);
  });

test('selecting another object first commits a pending keyboard nudge without losing selection', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: 'Select shape 2', exact: true }).press('Enter');
  await page.evaluate(() => window.selectionTest.pending[0].resolve());
  await expect(
    page.getByRole('button', { name: 'Move selected shape', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const { layer } = window.selectionTest;
    window.holdObjectCommit = true;
    // Dispatch in one task, before the keyboard debounce timer can fire.
    layer.controls
      .querySelector('.image-move')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    layer.targets.querySelector('button').click();
  });
  await expect.poll(() => page.evaluate(() => typeof window.finishObjectCommit)).toBe('function');
  await page.evaluate(() => {
    const { layer, entries, viewport } = window.selectionTest;
    layer.close(true);
    layer.render(entries, viewport, 'after-nudge', 'page-1');
    window.finishObjectCommit();
  });
  await expect.poll(() => page.evaluate(() => window.selectionTest.pending.length)).toBe(2);
  await page.evaluate(() => window.selectionTest.pending[1].resolve());
  await expect(page.getByRole('button', { name: 'Select shape 1', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await page.evaluate(() => window.selectionTest.commits)).toEqual([
    { ordinal: 1, transform: [80, 0, 0, 60, 241, 140] },
  ]);
});

test('finishing a pending object edit does not steal focus from another control', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    window.holdObjectCommit = true;
    const button = document.createElement('button');
    button.textContent = 'Outside action';
    document.body.append(button);
  });
  await page.getByRole('button', { name: 'Select shape 1', exact: true }).press('Enter');
  await page.evaluate(() => window.selectionTest.pending[0].resolve());
  const move = page.getByRole('button', { name: 'Move selected shape', exact: true });
  await move.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => !!window.finishObjectCommit)).toBe(true);
  const outside = page.getByRole('button', { name: 'Outside action', exact: true });
  // The test needs a focus change; Safari does not focus plain buttons on click.
  await outside.focus();
  await expect(outside).toBeFocused();
  await page.evaluate(() => window.finishObjectCommit());
  await expect(move).toBeEnabled();
  await expect(outside).toBeFocused();
});

test('an object commit locks actions in the initiating event while native focus settles', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: 'Select shape 1', exact: true }).press('Enter');
  await page.evaluate(() => window.selectionTest.pending[0].resolve());
  const move = page.getByRole('button', { name: 'Move selected shape', exact: true });
  const state = await page.evaluate(() => {
    window.holdObjectCommit = true;
    const { layer, commits } = window.selectionTest;
    const control = document.querySelector('.image-move');
    // Keep the nudge and finish in one event task, before the keyboard debounce
    // or any deferred transaction could run, even on a heavily loaded browser.
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    window.pendingFocusCommit = layer.finish();
    return {
      commits: commits.length,
      blocked: control.disabled || control.getAttribute('aria-disabled') === 'true',
    };
  });
  expect(state).toEqual({ commits: 1, blocked: true });
  await page.evaluate(async () => {
    window.finishObjectCommit();
    await window.pendingFocusCommit;
  });
  await expect(move).toBeEnabled();
});

test('a redraw keeps the targets of unchanged objects, which then select the redrawn objects', async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(() => {
    const { layer, entries, viewport } = window.selectionTest;
    const before = [...layer.targets.children];
    // A page of thousands of shapes is redrawn after each nudge: only the moved one changes.
    const next = entries.map((entry) => ({ ...entry, id: `${entry.id}-again` }));
    next[0].transform = [80, 0, 0, 60, 90, 140];
    layer.render(next, viewport, 'second', 'page-1');
    const after = [...layer.targets.children];
    layer.render(next, { ...viewport, transform: [2, 0, 0, -2, 0, 800] }, 'zoom', 'page-1');
    const zoomed = [...layer.targets.children];
    layer.render(next, viewport, 'third', 'page-1');
    layer.setBusy(false);
    window.selectionTest.entries = next;
    return {
      moved: after[0] === before[0],
      kept: after[1] === before[1],
      left: after[0].style.left,
      keptOnZoom: zoomed.some((target) => after.includes(target)),
    };
  });
  expect(result).toEqual({ moved: false, kept: true, left: '90px', keptOnZoom: false });
  await page.getByRole('button', { name: 'Select shape 2', exact: true }).press('Enter');
  await page.evaluate(() => window.selectionTest.pending[0].resolve());
  const move = page.getByRole('button', { name: 'Move selected shape', exact: true });
  await expect(move).toBeVisible();
  await move.press('ArrowRight');
  await expect
    .poll(() => page.evaluate(() => window.selectionTest.commits))
    .toEqual([{ ordinal: 1, transform: [80, 0, 0, 60, 241, 140] }]);
});

test('object targets are not dimmed one by one while a save runs, and a hovered one still dims', async ({
  page,
}) => {
  await mount(page);
  // Each dimmed target is a layer of its own for the browser to repaint; a page of shapes has
  // thousands, and the targets are see-through anyway.
  await page.evaluate(() => window.selectionTest.layer.setBusy(true));
  const target = page.getByRole('button', { name: 'Select shape 2', exact: true });
  await expect(target).toBeDisabled();
  await target.hover();
  const style = await target.evaluate((node) => {
    const css = getComputedStyle(node);
    return { opacity: css.opacity, outline: css.outlineColor, hovered: node.matches(':hover') };
  });
  expect(style).toMatchObject({ opacity: '1', hovered: true });
  expect(style.outline).toMatch(/^(rgba|color)\(.*0\.4\)$/);
});

test('the object targets are gone through only when their busy state changes', async ({ page }) => {
  await mount(page);
  const result = await page.evaluate(() => {
    const { layer, entries, viewport } = window.selectionTest;
    const targets = layer.targets;
    const property = Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, 'disabled');
    let writes = 0;
    Object.defineProperty(HTMLButtonElement.prototype, 'disabled', {
      ...property,
      set(value) {
        if (targets.contains(this)) writes++;
        property.set.call(this, value);
      },
    });
    const count = (action) => {
      writes = 0;
      action();
      return writes;
    };
    try {
      // The editor sets the busy state many times a second while a page of thousands of shapes
      // is saved; it changes only twice.
      const unchanged = count(() => {
        for (let i = 0; i < 5; i++) layer.setBusy(false);
      });
      const busy = count(() => layer.setBusy(true));
      const disabled = [...targets.children].map((target) => target.disabled);
      const again = count(() => layer.setBusy(true));
      // A redraw while busy gives its new target the same state.
      const next = entries.map((entry) => ({ ...entry }));
      next[0].transform = [80, 0, 0, 60, 90, 140];
      layer.render(next, viewport, 'second', 'page-1');
      const redrawn = [...targets.children].map((target) => target.disabled);
      const idle = count(() => layer.setBusy(false));
      return {
        unchanged,
        busy,
        disabled,
        again,
        redrawn,
        idle,
        enabled: [...targets.children].map((t) => t.disabled),
      };
    } finally {
      Object.defineProperty(HTMLButtonElement.prototype, 'disabled', property);
    }
  });
  expect(result).toEqual({
    unchanged: 0,
    busy: 2,
    disabled: [true, true],
    again: 0,
    redrawn: [true, true],
    idle: 2,
    enabled: [false, false],
  });
});
