import { test, expect } from '@playwright/test';

for (const kind of ['image', 'shape'])
  test(`${kind} drags released during selection are committed, while taps and cancellations are not`, async ({
    page,
  }) => {
    await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
    await page.goto('/#library');
    await page.evaluate(async (kind) => {
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
      const entry = {
        id: 'object',
        ordinal: 0,
        editable: true,
        kind,
        transform: [80, 0, 0, 60, 80, 140],
        clips: [],
        filled: false,
        stroked: false,
      };
      const commits = [];
      const layer = createImageLayer({
        // Hold selection explicitly: the result must not depend on browser or machine speed.
        beforeSelect: () =>
          new Promise((resolve) => {
            window.finishSelection = resolve;
          }),
        onCommit: async (object, change) => {
          commits.push(change.transform);
          object.transform = change.transform;
        },
        onChange: () => {},
        preparePreview: async () => ({
          image: document.createElement('canvas'),
          background: document.createElement('canvas'),
        }),
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
      window.objectGesture = { layer, commits };
    }, kind);
    const cdp = await page.context().newCDPSession(page);
    // A tap selects the object; a finger then moves it.
    const unselected = await page
      .getByRole('button', { name: `Select ${kind} 1`, exact: true })
      .boundingBox();
    const tap = { id: 1, x: unselected.x + unselected.width / 2, y: unselected.y + 10 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tap] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.evaluate(() => typeof window.finishSelection)).toBe('function');
    await page.evaluate(() => window.finishSelection());
    await expect.poll(() => page.evaluate(() => window.objectGesture.layer.selected)).toBe(true);
    for (const phase of ['release', 'cancel', 'lost capture', 'active capture', 'tap']) {
      const target = page.getByRole('button', { name: `Move selected ${kind}`, exact: true });
      const box = await target.boundingBox();
      const touch = { id: 1, x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.evaluate(() => {
        window.finishSelection = null;
        document.addEventListener(
          'pointerdown',
          (e) => {
            window.objectPointer = e.pointerId;
          },
          { once: true, capture: true },
        );
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
      await expect.poll(() => page.evaluate(() => typeof window.finishSelection)).toBe('function');
      if (phase === 'active capture') await page.evaluate(() => window.finishSelection());
      if (phase !== 'tap') {
        touch.x += 20;
        touch.y += 10;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch] });
      }
      if (phase === 'lost capture' || phase === 'active capture') {
        await page.evaluate(() =>
          window.objectGesture.layer.controls.releasePointerCapture(window.objectPointer),
        );
        touch.x += 1;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch] });
      }
      await cdp.send('Input.dispatchTouchEvent', {
        type: phase === 'cancel' ? 'touchCancel' : 'touchEnd',
        touchPoints: [],
      });
      await page.evaluate(async () => {
        window.finishSelection();
        await new Promise(requestAnimationFrame);
      });
      await expect.poll(() => page.evaluate(() => window.objectGesture.layer.active)).toBe(false);
      await expect
        .poll(() => page.evaluate(() => window.objectGesture.commits))
        .toEqual([[80, 0, 0, 60, 100, 130]]);
    }
  });
