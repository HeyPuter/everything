import { test, expect } from '@playwright/test';

test('arrows pressed while a nudge is saved keep the focus and move the object afterwards', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  await page.evaluate(async () => {
    const { createImageLayer } = await import('/src/image-layer.js');
    // A page view that scrolls with the arrow keys, as the editor's does.
    const scroller = document.createElement('div');
    scroller.tabIndex = 0;
    Object.assign(scroller.style, { height: '300px', overflow: 'auto' });
    const paper = document.createElement('div');
    paper.className = 'paper';
    Object.assign(paper.style, { width: '400px', height: '1200px', position: 'relative' });
    scroller.append(paper);
    document.body.replaceChildren(scroller);
    const entry = {
      id: 'object',
      ordinal: 0,
      editable: true,
      kind: 'image',
      transform: [80, 0, 0, 60, 80, 1000],
      clips: [],
    };
    const commits = [];
    const layer = createImageLayer({
      beforeSelect: async () => {},
      // Each save is held until the test lets it finish.
      onCommit: (object, change) =>
        new Promise((resolve) => {
          window.finishCommit = () => {
            window.finishCommit = null;
            commits.push(change.transform);
            object.transform = change.transform;
            resolve();
          };
        }),
      onChange: () => {},
      preparePreview: () => new Promise(() => {}),
    });
    paper.append(layer.targets, layer.controls, layer.preview);
    layer.render(
      [entry],
      {
        width: 400,
        height: 1200,
        scale: 1,
        userUnit: 1,
        transform: [1, 0, 0, -1, 0, 1200],
        convertToPdfPoint: (x, y) => [x, 1200 - y],
      },
      'test',
    );
    layer.setBusy(false);
    window.nudge = { scroller, commits };
  });
  await page.getByRole('button', { name: 'Select image 1', exact: true }).press('Enter');
  const move = page.getByRole('button', { name: 'Move selected image', exact: true });
  await expect(move).toBeFocused();
  const scrolled = () => page.evaluate(() => window.nudge.scroller.scrollTop);
  const before = await scrolled();
  await move.press('ArrowDown');
  // Once the keys rest, the nudge is saved.
  await expect.poll(() => page.evaluate(() => typeof window.finishCommit)).toBe('function');
  await expect(move).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  expect(await scrolled()).toBe(before);
  await page.evaluate(() => window.finishCommit());
  await expect(move).toBeFocused();
  // The arrows pressed meanwhile are saved as the next move.
  await expect.poll(() => page.evaluate(() => typeof window.finishCommit)).toBe('function');
  await page.evaluate(() => window.finishCommit());
  await expect
    .poll(() => page.evaluate(() => window.nudge.commits))
    .toEqual([
      [80, 0, 0, 60, 80, 999],
      [80, 0, 0, 60, 80, 988],
    ]);
  await expect(move).toBeFocused();
});

// Delete pressed while the last nudge was being saved went unheard: the object stayed.
test('Delete pressed while a nudge is saved removes the object afterwards', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  await page.evaluate(async () => {
    const { createImageLayer } = await import('/src/image-layer.js');
    const paper = document.createElement('div');
    paper.className = 'paper';
    Object.assign(paper.style, { width: '400px', height: '400px', position: 'relative' });
    document.body.replaceChildren(paper);
    const entry = {
      id: 'object',
      ordinal: 0,
      editable: true,
      kind: 'image',
      transform: [80, 0, 0, 60, 80, 200],
      clips: [],
    };
    const commits = [];
    const layer = createImageLayer({
      beforeSelect: async () => {},
      // Each save is held until the test lets it finish.
      onCommit: (object, change) =>
        new Promise((resolve) => {
          window.finishCommit = () => {
            window.finishCommit = null;
            commits.push(change.remove ? 'removed' : change.transform);
            object.transform = change.transform;
            resolve();
          };
        }),
      onChange: () => {},
      preparePreview: () => new Promise(() => {}),
    });
    paper.append(layer.targets, layer.controls, layer.preview);
    layer.render(
      [entry],
      {
        width: 400,
        height: 400,
        scale: 1,
        userUnit: 1,
        transform: [1, 0, 0, -1, 0, 400],
        convertToPdfPoint: (x, y) => [x, 400 - y],
      },
      'test',
    );
    layer.setBusy(false);
    window.commits = commits;
  });
  await page.getByRole('button', { name: 'Select image 1', exact: true }).press('Enter');
  const move = page.getByRole('button', { name: 'Move selected image', exact: true });
  await expect(move).toBeFocused();
  await move.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => typeof window.finishCommit)).toBe('function');
  await page.keyboard.press('Delete');
  await page.evaluate(() => window.finishCommit());
  // The removal follows as its own save.
  await expect.poll(() => page.evaluate(() => typeof window.finishCommit)).toBe('function');
  await page.evaluate(() => window.finishCommit());
  await expect
    .poll(() => page.evaluate(() => window.commits))
    .toEqual([[80, 0, 0, 60, 81, 200], 'removed']);
});

// Escape pressed while the last nudge was being saved went unheard: the object stayed selected.
test('Escape pressed while a nudge is saved lets go of the object afterwards', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  await page.evaluate(async () => {
    const { createImageLayer } = await import('/src/image-layer.js');
    const paper = document.createElement('div');
    paper.className = 'paper';
    Object.assign(paper.style, { width: '400px', height: '400px', position: 'relative' });
    document.body.replaceChildren(paper);
    const entry = {
      id: 'object',
      ordinal: 0,
      editable: true,
      kind: 'image',
      transform: [80, 0, 0, 60, 80, 200],
      clips: [],
    };
    const commits = [];
    const layer = createImageLayer({
      beforeSelect: async () => {},
      // Each save is held until the test lets it finish.
      onCommit: (object, change) =>
        new Promise((resolve) => {
          window.finishCommit = () => {
            window.finishCommit = null;
            commits.push(change.remove ? 'removed' : change.transform);
            object.transform = change.transform;
            resolve();
          };
        }),
      onChange: () => {},
      preparePreview: () => new Promise(() => {}),
    });
    paper.append(layer.targets, layer.controls, layer.preview);
    layer.render(
      [entry],
      {
        width: 400,
        height: 400,
        scale: 1,
        userUnit: 1,
        transform: [1, 0, 0, -1, 0, 400],
        convertToPdfPoint: (x, y) => [x, 400 - y],
      },
      'test',
    );
    layer.setBusy(false);
    window.commits = commits;
  });
  await page.getByRole('button', { name: 'Select image 1', exact: true }).press('Enter');
  const move = page.getByRole('button', { name: 'Move selected image', exact: true });
  await expect(move).toBeFocused();
  await move.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => typeof window.finishCommit)).toBe('function');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.finishCommit());
  // The move is saved, and the object let go, its own target taking the focus.
  await expect(move).toBeHidden();
  await expect(page.getByRole('button', { name: 'Select image 1', exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.commits)).toEqual([[80, 0, 0, 60, 81, 200]]);
});
