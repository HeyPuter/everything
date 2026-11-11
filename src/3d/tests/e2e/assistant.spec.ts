import { test, expect, type Page } from '@playwright/test';
import { openApp, objectNames, expectNoErrors } from './helpers';

/** Stands in for Puter AI: replays one reply per request (window.__assistantChat is honoured in dev builds). */
async function scriptModel(page: Page, replies: unknown[][]) {
  await page.evaluate((r) => {
    const w = window as unknown as { __assistantChat: unknown; __requests: unknown[] };
    w.__requests = [];
    let i = 0;
    w.__assistantChat = async function* (messages: unknown) {
      w.__requests.push(messages);
      for (const part of r[i++] ?? [{ type: 'text', text: 'Done.' }]) yield part;
    };
  }, replies);
}

test('the assistant is open by default and builds from a description, as one undo step', async ({ page }) => {
  const errors = await openApp(page);
  const panel = page.locator('.assistant');
  await expect(panel).toBeVisible();
  await expect(page.locator('.tb-assistant')).toHaveClass(/\bon\b/);
  // the viewport sits beside the sidebar, not under it
  const view = await page.locator('.view3d').first().boundingBox();
  const side = await panel.boundingBox();
  expect(view!.x + view!.width).toBeLessThanOrEqual(side!.x + 1);

  await scriptModel(page, [
    [
      {
        type: 'tool',
        id: 'call_1',
        name: 'run_script',
        input: {
          description: 'Build a snowman',
          code: "D.objects.remove(D.objects.Cube);\nbpy.ops.mesh.primitive_uv_sphere_add({radius: 0.5, location: [0, 0, 0.5]}); C.object.name = 'Snow Base';\nbpy.ops.mesh.primitive_uv_sphere_add({radius: 0.35, location: [0, 0, 1.25]}); C.object.name = 'Snow Head';",
        },
      },
    ],
    [{ type: 'tool', id: 'call_2', name: 'capture_view', input: { view: 'ISOMETRIC', shading: 'SOLID' } }],
    [{ type: 'text', text: 'Built a **snowman** from two spheres.' }],
  ]);
  await page.locator('.as-input').fill('make a snowman');
  await page.locator('.as-input').press('Enter');
  await expect(page.locator('.as-bot .as-text')).toContainText('Built a snowman from two spheres.');
  await expect(page.locator('.as-step.done')).toHaveCount(2);
  await expect(page.locator('.as-step').first()).toContainText('Build a snowman');
  expect(await objectNames(page)).toEqual(['Camera', 'Light', 'Snow Base', 'Snow Head']);

  // the screenshot was a real picture of the viewport, and went to the model
  const shot = page.locator('.as-shot');
  await expect(shot).toHaveCount(1);
  const size = await shot.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
  expect(size[0]).toBeGreaterThan(200);
  const sent = await page.evaluate(() => JSON.stringify((window as unknown as { __requests: unknown[] }).__requests[2]));
  expect(sent).toContain('"type":"image"');
  // the first request described the scene
  const first = await page.evaluate(() => JSON.stringify((window as unknown as { __requests: unknown[] }).__requests[0]));
  expect(first).toContain('<scene_state>');

  // one undo step for the whole message
  await page.getByRole('button', { name: 'Undo changes' }).click();
  await expect(page.locator('.as-meta')).toContainText('Changes undone.');
  expect(await objectNames(page)).toEqual(['Camera', 'Cube', 'Light']);
  await expectNoErrors(errors);
});

test('a script error is rolled back and reported in the steps', async ({ page }) => {
  await openApp(page);
  await scriptModel(page, [
    [{ type: 'tool', id: 'call_1', name: 'run_script', input: { description: 'Try something', code: "bpy.ops.mesh.primitive_cube_add({location: [3, 0, 0]});\nD.objects['Nope'].location.x = 1;" } }],
    [{ type: 'text', text: 'That failed.' }],
  ]);
  await page.locator('.as-input').fill('break it');
  await page.locator('.as-input').press('Enter');
  await expect(page.locator('.as-step.error')).toHaveCount(1);
  await expect(page.locator('.as-step-detail')).toContainText('line 2');
  expect(await objectNames(page)).toEqual(['Camera', 'Cube', 'Light']);
  await expect(page.getByRole('button', { name: 'Undo changes' })).toHaveCount(0);
});

test('closing the assistant is remembered across visits', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.assistant')).toBeVisible();
  await page.getByRole('button', { name: 'Close the assistant' }).click();
  await expect(page.locator('.assistant')).toBeHidden();
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app);
  await page.waitForTimeout(300);
  await expect(page.locator('.assistant')).toBeHidden();
  await expect(page.locator('.tb-assistant')).not.toHaveClass(/\bon\b/);
  // the topbar button brings it back, and that is remembered too
  await page.locator('.tb-assistant').click();
  await expect(page.locator('.assistant')).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app);
  await expect(page.locator('.assistant')).toBeVisible();
});

test('an attached image can be loaded by a script and projected onto a model through the camera', async ({ page }) => {
  const errors = await openApp(page);
  // A 64 × 32 picture: red on the left, blue on the right.
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 32;
    const g = c.getContext('2d')!;
    g.fillStyle = '#f00';
    g.fillRect(0, 0, 32, 32);
    g.fillStyle = '#00f';
    g.fillRect(32, 0, 32, 32);
    return c.toDataURL('image/png').split(',')[1];
  });
  await scriptModel(page, [
    [
      {
        type: 'tool',
        id: 'call_1',
        name: 'run_script',
        input: {
          description: 'Project the photo from the camera',
          code: `const img = D.images.load('halves.png');
const cam = C.scene.camera, ob = D.objects['Cube'], me = ob.data;
C.scene.render.resolution_x = img.size[0]; C.scene.render.resolution_y = img.size[1];
const vi = me.loops.foreach_get('vertex_index'), co = me.vertices.foreach_get('co'), uv = [];
for (const v of vi) { const p = bpy_extras.object_utils.world_to_camera_view(C.scene, cam, ob.matrix_world.matmul([co[3 * v], co[3 * v + 1], co[3 * v + 2]])); uv.push(p.x, p.y); }
me.uv_layers.active.foreach_set('uv', uv);
const mat = D.materials.new('Photo'); mat.use_nodes = true;
const tex = mat.node_tree.nodes.new('ShaderNodeTexImage'); tex.image = img;
mat.node_tree.links.new(tex.outputs['Color'], mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color']);
me.materials.clear(); me.materials.append(mat);
print(img.size[0], img.size[1], Math.min(...uv).toFixed(2), Math.max(...uv).toFixed(2));`,
        },
      },
    ],
    [{ type: 'tool', id: 'call_2', name: 'set_view', input: { view: 'CAMERA', shading: 'MATERIAL' } }],
    [{ type: 'text', text: 'Projected the photo onto the cube.' }],
  ]);
  await page.locator('.as-composer input[type=file]').setInputFiles({ name: 'halves.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('.as-tray')).toContainText('halves.png');
  await page.locator('.as-input').fill('put this photo on the cube');
  await page.locator('.as-input').press('Enter');
  await expect(page.locator('.as-bot .as-text')).toContainText('Projected the photo onto the cube.');
  await expect(page.locator('.as-step.done')).toHaveCount(2);

  // the model was told how to load it, and the script loaded the full picture
  const first = await page.evaluate(() => JSON.stringify((window as unknown as { __requests: unknown[] }).__requests[0]));
  expect(first).toContain('D.images.load(\\"halves.png\\")');
  const result = await page.evaluate(() => JSON.stringify((window as unknown as { __requests: unknown[][] }).__requests[1]));
  expect(result).toMatch(/64 32 0\.\d\d 0\.\d\d/);
  const image = await page.evaluate(() => {
    const d = (window as unknown as { bpy: { data: { images: { name: string; size: number[] }[] } } }).bpy.data.images;
    return [...d].map((im) => `${im.name} ${im.size.join('x')}`);
  });
  expect(image).toContain('halves.png 64x32');
  await page.screenshot({ path: test.info().outputPath('projected.png') });
  await expectNoErrors(errors);
});

test('the assistant stays inside a window narrowed to phone width', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.assistant')).toBeVisible();
  for (const w of [320, 600]) {
    await page.setViewportSize({ width: w, height: 700 });
    await page.waitForTimeout(200);
    const box = await page.locator('.assistant').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(w);
    // its buttons stay reachable
    for (const name of ['Send', 'Close the assistant']) {
      const b = await page.getByRole('button', { name, exact: true }).boundingBox();
      expect(b!.x + b!.width).toBeLessThanOrEqual(w);
    }
    // the workspace keeps some room
    const view = await page.locator('.screen-wrap').boundingBox();
    expect(view!.width).toBeGreaterThan(0);
  }
  // widened again, it goes back to the width the user gave it
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(200);
  expect(Math.round((await page.locator('.assistant-dock').boundingBox())!.width)).toBe(380);
});

test('asking again while signed out shows one sign-in prompt, gone once a message goes', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    (window as unknown as { puter: unknown }).puter = { auth: { isSignedIn: () => false, signIn: async () => true }, ai: { chat: async () => ({ message: { content: 'Hello.' } }) } };
  });
  const input = page.locator('.as-input');
  await input.fill('hello');
  for (let i = 0; i < 3; i++) await input.press('Enter');
  await expect(page.locator('.as-notice')).toHaveCount(1);
  await expect(input).toHaveValue('hello');
  await page.evaluate(() => {
    (window as unknown as { puter: { auth: { isSignedIn: () => boolean } } }).puter.auth.isSignedIn = () => true;
  });
  await input.press('Enter');
  await expect(page.locator('.as-bot .as-text')).toContainText('Hello.');
  await expect(page.locator('.as-notice')).toHaveCount(0);
});

test('buttons that go away when used hand the keyboard to the message box', async ({ page }) => {
  await openApp(page);
  await scriptModel(page, [
    [{ type: 'tool', id: 'call_1', name: 'run_script', input: { description: 'Add a cube', code: 'bpy.ops.mesh.primitive_cube_add({location: [3, 0, 0]});' } }],
    [{ type: 'text', text: 'Added.' }],
  ]);
  const input = page.locator('.as-input');
  await input.fill('add a cube');
  await input.press('Enter');
  const undo = page.getByRole('button', { name: 'Undo changes' });
  await expect(undo).toBeVisible();
  await undo.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.as-meta')).toContainText('Changes undone.');
  await expect(input).toBeFocused();
  // a failed reply's Try again
  await page.evaluate(() => {
    let n = 0;
    (window as unknown as { __assistantChat: unknown }).__assistantChat = async function* () {
      if (n++ === 0) throw new Error('busy');
      yield { type: 'text', text: 'Hello.' };
    };
  });
  await input.fill('hi');
  await input.press('Enter');
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.as-bot .as-text').last()).toContainText('Hello.');
  await expect(input).toBeFocused();
});

test('the status line is rewritten only when what it says changes', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    (window as unknown as { __assistantChat: unknown }).__assistantChat = async function* () {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 5));
        yield { type: 'text', text: `word${i} ` };
      }
    };
    const w = window as unknown as { __said: string[] };
    w.__said = [];
    const status = document.querySelector('.as-status')!;
    new MutationObserver(() => w.__said.push(status.textContent ?? '')).observe(status, { childList: true, characterData: true, subtree: true });
  });
  await page.locator('.as-input').fill('hi');
  await page.locator('.as-input').press('Enter');
  // the reply is marked busy while it streams, so the conversation log is read once it is complete
  await expect(page.locator('.as-bot')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.as-bot .as-text')).toContainText('word29');
  await expect(page.locator('.as-bot')).not.toHaveAttribute('aria-busy', /.*/);
  // a live region: every write is read out again, so a streamed reply must not say "Writing…" once per piece
  const said = await page.evaluate(() => (window as unknown as { __said: string[] }).__said);
  expect(said.filter((s) => s === 'Writing…').length).toBe(1);
});

test('with online access turned off the assistant says so and reaches nothing', async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    (await import('/src/app/prefs.ts' as string)).prefs.use_online_access = false;
  });
  const asked: string[] = [];
  page.on('request', (r) => {
    if (/puter\.com/.test(r.url())) asked.push(r.url());
  });
  await page.locator('.as-input').fill('hello');
  await page.locator('.as-input').press('Enter');
  await expect(page.locator('.as-notice')).toContainText('online access is turned off');
  expect(asked).toEqual([]);
  await expect(page.locator('.as-input')).toHaveValue('hello');
});
