import { type Page, expect, test } from '@playwright/test';
import { openApp } from './helpers';

// A scripted stand-in for Puter AI (window.__assistantChat, dev builds only):
// it builds a plate with holes and rounded corners, looks at it and answers.
async function scriptModel(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __chatCalls: unknown[]; __assistantChat: unknown };
    w.__chatCalls = [];
    w.__assistantChat = async function* (messages: { role: string; content: unknown }[], opts: { tools: { function: { name: string } }[]; model: string }) {
      w.__chatCalls.push({ messages: JSON.parse(JSON.stringify(messages)), tools: opts.tools.map((t) => t.function.name), model: opts.model });
      const round = messages.filter((m) => m.role === 'assistant').length;
      if (round === 0) {
        yield { type: 'text', text: 'I will sketch the plate on the Top plane.' };
        yield { type: 'tool', id: 'c1', name: 'create_sketch', input: { plane: 'top', shapes: [{ type: 'rectangle', id: 'base', center: [0, 0], width: 100, height: 60 }] } };
        yield { type: 'tool', id: 'c2', name: 'add_extrude', input: { sketch: 's1', depth: 8, name: 'Plate' } };
      } else if (round === 1) {
        yield { type: 'tool', id: 'c3', name: 'add_hole', input: { on: 'f2:cap1', points: [[-40, 8, -20], [40, 8, -20], [40, 8, 20], [-40, 8, 20]], diameter: 5.5, name: 'Holes' } };
        yield { type: 'tool', id: 'c4', name: 'find_geometry', input: { kind: 'edges', direction: [0, 1, 0], feature: 'f2' } };
      } else if (round === 2) {
        const last = messages.at(-1)!.content as string;
        const edges = [...last.matchAll(/^- (\S+) \| line/gm)].map((m) => m[1]);
        yield { type: 'tool', id: 'c5', name: 'add_fillet', input: { edges, radius: 6, name: 'Corners' } };
        yield { type: 'tool', id: 'c6', name: 'add_fillet', input: { edges: ['no-such-edge'], radius: 1 } };
        yield { type: 'tool', id: 'c7', name: 'capture_view', input: { orientation: 'isometric' } };
      } else {
        yield { type: 'text', text: 'Done: a **100 × 60 × 8 mm** plate with four holes.' };
      }
    };
  });
}

test('the assistant builds a part with tools, shows its steps and undoes it in one step', async ({ page }) => {
  await scriptModel(page);
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  // The assistant is open from the start on desktop.
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('Make a mounting plate');
  await box.press('Enter');

  // The reply is held from screen readers while it streams and released when complete.
  await expect(page.locator('.as-bot')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.as-bot').getByText('plate with four holes')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.as-bot[aria-busy]')).toHaveCount(0);
  for (const name of ['Plate', 'Holes', 'Corners']) await expect(page.getByRole('treeitem', { name })).toBeVisible();
  const steps = page.locator('.as-step');
  await expect(steps).toHaveCount(7);
  await expect(page.locator('.as-step.error')).toHaveCount(1);
  await expect(page.locator('.as-step.error')).toContainText('no edge named "no-such-edge"');
  await expect(page.locator('.as-shot')).toHaveCount(1);

  const calls = await page.evaluate(() => (window as unknown as { __chatCalls: { messages: { role: string; content: unknown }[]; tools: string[]; model: string }[] }).__chatCalls);
  expect(calls).toHaveLength(4);
  expect(calls[0].tools).toContain('create_sketch');
  expect(calls[0].model).toBe('claude-opus-5-5');
  // The first message carries a snapshot of the part; the screenshot goes with the last round only.
  expect(String(calls[0].messages[1].content)).toContain('<part_state>');
  const last = calls[3].messages;
  expect(last.filter((m) => Array.isArray(m.content))).toHaveLength(1);
  expect(JSON.stringify(last.at(-1))).toContain('"type":"image","source":{"type":"base64","media_type":"image/jpeg"');

  // One undo step for the whole message.
  await page.getByRole('button', { name: 'Undo changes' }).click();
  await expect(page.getByRole('treeitem', { name: 'Plate' })).toHaveCount(0);
  await expect(page.getByText('Changes undone.')).toBeVisible();
  expect(errors).toEqual([]);
});

// File bytes for Playwright, which wants a Node Buffer (the project has no Node types).
const NodeBuffer = (globalThis as unknown as { Buffer: { from(s: string, enc: string): never } }).Buffer;
const bytes = (s: string, base64 = false) => NodeBuffer.from(s, base64 ? 'base64' : 'utf8');
// A 2x2 PNG, a one-page PDF and a DXF snippet.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAp86uXIAAAAASUVORK5CYII=';
const PDF = '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF';
const DXF = '0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n100\n21\n0\n0\nENDSEC\n0\nEOF\n';

test('files go with a message: picked, pasted or dropped, and refused when the assistant cannot read them', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __chatCalls: unknown[]; __assistantChat: unknown };
    w.__chatCalls = [];
    w.__assistantChat = async function* (messages: unknown[]) {
      w.__chatCalls.push(JSON.parse(JSON.stringify(messages)));
      yield { type: 'text', text: 'I read the drawing.' };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();

  // Picked with the paperclip.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files' }).click();
  await (await chooser).setFiles([
    { name: 'photo.png', mimeType: 'image/png', buffer: bytes(PNG_B64, true) },
    { name: 'drawing.pdf', mimeType: 'application/pdf', buffer: bytes(PDF) },
    { name: 'outline.dxf', mimeType: 'image/vnd.dxf', buffer: bytes(DXF) },
    { name: 'part.step', mimeType: 'application/step', buffer: bytes('ISO-10303-21;') },
  ]);
  const tray = page.locator('.as-tray');
  await expect(tray.getByRole('listitem')).toHaveCount(3);
  await expect(page.getByText(/To bring in part\.step, use File › Import/)).toBeVisible();
  await expect(tray.locator('img.as-tray-thumb')).toHaveCount(1);
  await tray.getByRole('button', { name: 'Remove outline.dxf' }).click();
  await expect(tray.getByRole('listitem')).toHaveCount(2);

  // Pasted into the box.
  await page.getByRole('textbox', { name: 'Message the assistant' }).evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'notes.csv', { type: 'text/csv' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, btoa('hole,x,y\nA,10,10\n'));
  // Dropped on the panel.
  await page.locator('.assistant').evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'outline.dxf', { type: '' }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, btoa(DXF));
  await expect(tray.getByRole('listitem')).toHaveCount(4);

  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('Model this bracket');
  await box.press('Enter');
  await expect(page.getByText('I read the drawing.')).toBeVisible();
  await expect(tray).toBeHidden();
  await expect(page.locator('.as-user img.as-user-thumb')).toHaveCount(1);
  await expect(page.locator('.as-user .as-user-chip')).toHaveCount(3);

  const calls = await page.evaluate(() => (window as unknown as { __chatCalls: { role: string; content: unknown }[][] }).__chatCalls);
  const sent = calls[0][1].content as { type: string; text?: string; source?: { media_type: string } }[];
  expect(sent.map((p) => p.type)).toEqual(['text', 'text', 'image', 'document', 'text', 'text']);
  expect(sent[0].text).toContain('Model this bracket');
  expect(sent[1].text).toContain('photo.png (image), drawing.pdf (PDF), notes.csv (text), outline.dxf (text)');
  expect(sent[2].source!.media_type).toBe('image/png');
  expect(sent[5].text).toMatch(/^<attached_file name="outline.dxf">\n0\nSECTION/);
});

test('a large photo is fitted to what the model takes', async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(async () => {
    // The dev server serves the module; the path is a variable so TypeScript leaves it alone.
    const path = '/src/assistant/attachments.ts';
    const { readAttachment } = (await import(/* @vite-ignore */ path)) as typeof import('../../src/assistant/attachments');
    const c = document.createElement('canvas');
    c.width = 4032;
    c.height = 3024;
    const g = c.getContext('2d')!;
    // Noise, so the photo is large as a file too.
    const img = g.createImageData(c.width, c.height);
    for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 2654435761) >>> 24;
    g.putImageData(img, 0, 0);
    const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.95));
    const a = await readAttachment(new File([blob], 'IMG_0001.JPG', { type: 'image/jpeg' }));
    const block = a.blocks[0] as { source: { media_type: string; data: string } };
    const bmp = await createImageBitmap(await (await fetch(`data:${block.source.media_type};base64,${block.source.data}`)).blob());
    return { original: blob.size, sent: block.source.data.length, type: block.source.media_type, w: bmp.width, h: bmp.height, thumb: !!a.thumb };
  });
  expect(r.original).toBeGreaterThan(5 * 1024 * 1024);
  expect(r.sent).toBeLessThanOrEqual(5 * 1024 * 1024);
  expect(Math.max(r.w, r.h)).toBeLessThanOrEqual(1568);
  expect(r.type).toBe('image/jpeg');
  expect(r.thumb).toBe(true);
});

test('the assistant starts open without taking focus, and the tab closes it', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await expect(box).toBeVisible();
  await expect(box).not.toBeFocused();
  await expect(page.locator('.tp-strip [data-pane="assistant"]')).toHaveAttribute('aria-selected', 'true');
  await page.locator('.tp-strip [data-pane="assistant"]').click();
  await expect(box).toBeHidden();
});

test('a message too long for the assistant is held back with a reason, not sent', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __sent: number[]; __assistantChat: unknown };
    w.__sent = [];
    w.__assistantChat = async function* (messages: { content: unknown }[]) {
      w.__sent.push(JSON.stringify(messages.at(-1)!.content).length);
      yield { type: 'text', text: 'Got it.' };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('x'.repeat(100001));
  await expect(box).toHaveAttribute('aria-invalid', 'true');
  await box.press('Enter');
  await expect(page.locator('.as-limit')).toContainText('100,001 characters');
  await expect(box).toHaveAccessibleDescription(/at most 100,000/);
  await expect(page.locator('.as-user')).toHaveCount(0);
  // Shortened, it goes.
  await box.fill('x'.repeat(100000));
  await expect(page.locator('.as-limit')).toBeHidden();
  await box.press('Enter');
  await expect(page.getByText('Got it.')).toBeVisible();
  const sent = await page.evaluate(() => (window as unknown as { __sent: number[] }).__sent);
  expect(sent).toHaveLength(1);
});

test('a failed reply can be tried again until a later message moves the conversation on', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __roles: string[][]; __assistantChat: unknown };
    w.__roles = [];
    let n = 0;
    w.__assistantChat = async function* (messages: { role: string }[]) {
      w.__roles.push(messages.map((m) => m.role));
      if (n++ === 0) throw new Error('The request was refused');
      yield { type: 'text', text: `Answer ${n}` };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('first');
  await box.press('Enter');
  await expect(page.getByRole('alert')).toContainText('The request was refused');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await box.fill('second');
  await box.press('Enter');
  await expect(page.getByText('Answer 2')).toBeVisible();
  // Asking the first message again would send a conversation that ends with the assistant's reply.
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  const roles = await page.evaluate(() => (window as unknown as { __roles: string[][] }).__roles);
  expect(roles.map((r) => r.at(-1))).toEqual(['user', 'user']);
});

test('trying again after a reply broke off mid-sentence leaves only the new reply on screen', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __assistantChat: unknown };
    let n = 0;
    w.__assistantChat = async function* () {
      if (n++ === 0) {
        yield { type: 'text', text: 'I will make the bracket 60 mm wi' };
        throw new Error('The connection was reset');
      }
      yield { type: 'text', text: 'Made the bracket 60 mm wide.' };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('a bracket');
  await box.press('Enter');
  // What arrived before the failure is shown with it.
  await expect(page.getByRole('alert')).toContainText('The connection was reset');
  await expect(page.getByText('I will make the bracket 60 mm wi')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Made the bracket 60 mm wide.')).toBeVisible();
  // The broken-off text was never part of the conversation: it goes with the error.
  await expect(page.getByText('I will make the bracket 60 mm wi')).toHaveCount(0);
  await expect(page.locator('.as-bot')).toHaveCount(1);
});

test('the status says which step the model is writing before the step is complete', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __release: () => void; __assistantChat: unknown };
    let n = 0;
    w.__assistantChat = async function* () {
      if (n++ > 0) { yield { type: 'text', text: 'Sketched.' }; return; }
      yield { type: 'toolStart', name: 'create_sketch' };
      await new Promise<void>((r) => { w.__release = r; });
      yield { type: 'tool', id: 'c1', name: 'create_sketch', input: { plane: 'top', shapes: [{ type: 'circle', center: [0, 0], radius: 5 }] } };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('a circle');
  await box.press('Enter');
  await expect(page.locator('.as-status')).toHaveText('Create a sketch…');
  await page.waitForFunction(() => typeof (window as unknown as { __release?: () => void }).__release === 'function');
  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await expect(page.getByText('Sketched.')).toBeVisible();
  await expect(page.locator('.as-step.done')).toHaveText(/Sketch on top/);
});

test('a reply the service was too busy for is sent again by itself', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __calls: number; __assistantChat: unknown };
    w.__calls = 0;
    w.__assistantChat = async function* () {
      if (w.__calls++ === 0) throw new Error('529 Overloaded');
      yield { type: 'text', text: 'Answered after a retry.' };
    };
  });
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('hello');
  await box.press('Enter');
  await expect(page.locator('.as-status')).toHaveText('The AI service did not answer. Trying again (1 of 3)…');
  await expect(page.getByText('Answered after a retry.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __calls: number }).__calls)).toBe(2);
  expect(errors).toEqual([]);
});

test('sending signed out signs in first, once, and sends what the box holds then', async ({ page }) => {
  // A stand-in Puter SDK: signed out, sign-in finished by the test, AI answers at once.
  await page.route('https://js.puter.com/**', (r) => r.fulfill({
    contentType: 'application/javascript',
    body: `(() => {
      let signed = false;
      const w = window;
      w.__signIns = 0; w.__sent = [];
      const none = () => Promise.reject({ error: { code: 'subject_does_not_exist' } });
      w.puter = {
        env: 'web',
        auth: {
          isSignedIn: () => signed,
          signIn: () => { w.__signIns++; return new Promise((res) => { w.__finishSignIn = () => { signed = true; res({}); }; }); },
          signOut: () => { signed = false; },
          getUser: async () => ({ username: 'tester', uuid: 'u' }),
          getProfilePicture: async () => null,
        },
        fs: { write: none, read: none, readdir: async () => [], delete: none, rename: none, stat: none, mkdir: async () => ({}) },
        kv: { get: async () => null, set: async () => true, del: async () => true },
        ai: { chat: async (messages) => { const c = messages.at(-1).content; w.__sent.push(typeof c === 'string' ? c : c.map((b) => b.text).join('')); return { async *[Symbol.asyncIterator]() { yield { type: 'text', text: 'Signed-in answer.' }; } }; } },
      };
    })();`,
  }));
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('hello');
  await box.press('Enter');
  await expect(page.locator('.as-status')).toHaveText('Signing in to Puter…');
  await box.press('Enter');
  await box.fill('hello, edited while signing in');
  await page.evaluate(() => (window as unknown as { __finishSignIn(): void }).__finishSignIn());
  await expect(page.getByText('Signed-in answer.')).toBeVisible();
  await expect(page.locator('.as-user')).toHaveText(['hello, edited while signing in']);
  await expect(box).toHaveValue('');
  const r = await page.evaluate(() => { const w = window as unknown as { __signIns: number; __sent: string[] }; return { signIns: w.__signIns, sent: w.__sent }; });
  expect(r.signIns).toBe(1);
  expect(r.sent).toHaveLength(1);
  expect(r.sent[0]).toMatch(/\n\nhello, edited while signing in$/);
});

test('the conversation follows a long reply that arrives in one piece', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 700 });
  await page.addInitScript(() => {
    (window as unknown as { __assistantChat: unknown }).__assistantChat = async function* () {
      yield { type: 'text', text: Array.from({ length: 40 }, (_, i) => `Line ${i} of the reply.`).join('\n\n') };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('hi');
  await box.press('Enter');
  await expect(page.getByText('Line 39 of the reply.')).toBeInViewport();
});

test('Enter that commits an IME composition does not send', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __sends: number; __assistantChat: unknown };
    w.__sends = 0;
    w.__assistantChat = async function* () { w.__sends++; yield { type: 'text', text: 'ok' }; };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('にほんご');
  // Safari's keydown for that Enter: isComposing false, keyCode 229.
  await box.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })));
  await box.press('Enter');
  await expect(page.locator('.as-user')).toHaveText(['にほんご']);
  // The request goes once the part is rebuilt, a moment after the message shows.
  await expect(page.getByText('ok', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __sends: number }).__sends)).toBe(1);
});

test('the assistant\'s buttons work from the keyboard', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __assistantChat: unknown }).__assistantChat = async function* () { yield { type: 'text', text: 'Keyboard answer.' }; };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  // Enter on an idea sends it (not Repeat Last Command), and focus goes to the message box.
  await page.locator('.as-idea').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Keyboard answer.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message the assistant' })).toBeFocused();
  // Space on New chat starts over (not the View Orientation menu).
  await page.getByRole('button', { name: 'New chat' }).focus();
  await page.keyboard.press(' ');
  await expect(page.locator('.as-empty')).toBeVisible();
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('opening another part stops the assistant before it changes that part', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __thinking: boolean; __assistantChat: unknown };
    w.__assistantChat = async function* (messages: { role: string }[]) {
      const round = messages.filter((m) => m.role === 'assistant').length;
      if (round === 0) yield { type: 'tool', id: 'c1', name: 'create_sketch', input: { plane: 'top', shapes: [{ type: 'circle', center: [0, 0], radius: 5 }] } };
      else if (round === 1) {
        w.__thinking = true;
        await new Promise((r) => setTimeout(r, 1000));
        yield { type: 'tool', id: 'c2', name: 'create_sketch', input: { plane: 'front', name: 'Stray', shapes: [{ type: 'circle', center: [0, 0], radius: 9 }] } };
      } else yield { type: 'text', text: 'Done.' };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('Two sketches');
  await box.press('Enter');
  await page.waitForFunction(() => (window as unknown as { __thinking?: boolean }).__thinking);
  await page.evaluate(() => (window as unknown as { __parametric: { newDocument(n: string): void } }).__parametric.newDocument('Other part'));
  await expect(page.getByText('Stopped: another part was opened.')).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByRole('treeitem', { name: 'Stray' })).toHaveCount(0);
});

test('trying a failed reply again keeps the Undo changes of what it already did', async ({ page }) => {
  await page.addInitScript(() => {
    let n = 0;
    (window as unknown as { __assistantChat: unknown }).__assistantChat = async function* () {
      n++;
      if (n === 1) yield { type: 'tool', id: 'c1', name: 'create_sketch', input: { plane: 'top', shapes: [{ type: 'circle', center: [0, 0], radius: 5 }] } };
      else if (n === 2) throw new Error('Something went wrong');
      else yield { type: 'text', text: 'Recovered.' };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('Sketch a circle');
  await box.press('Enter');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Recovered.')).toBeVisible();
  await expect(page.locator('.as-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo changes' }).click();
  await expect(page.getByText('Changes undone.')).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'Sketch1' })).toHaveCount(0);
});

test('a message with more changes than the undo history holds is still undone in one step, and keeps older history', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __assistantChat: unknown }).__assistantChat = async function* (messages: { role: string }[]) {
      if (messages.some((m) => m.role === 'assistant')) { yield { type: 'text', text: 'Set them all.' }; return; }
      for (let i = 1; i <= 130; i++) yield { type: 'tool', id: `c${i}`, name: 'set_variables', input: { set: [{ name: `V${i}`, value: i }] } };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  type P = { __parametric: { store: { change(l: string, f: (d: { variables: unknown[] }) => void): void; doc: { variables: { name: string }[] }; undoDepth: number } } };
  // Some history of the user's own from before the message.
  await page.evaluate(() => (window as unknown as P).__parametric.store.change('Mine', (d) => { d.variables.push({ id: 'mine', name: 'Mine', expr: '1' }); }));
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('Make 130 variables');
  await box.press('Enter');
  await expect(page.getByText('Set them all.')).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(() => (window as unknown as P).__parametric.store.doc.variables.length)).toBe(131);
  expect(await page.evaluate(() => (window as unknown as P).__parametric.store.undoDepth)).toBe(2);
  await page.getByRole('button', { name: 'Undo changes' }).click();
  expect(await page.evaluate(() => (window as unknown as P).__parametric.store.doc.variables.map((v) => v.name))).toEqual(['Mine']);
});

test('changing the part\'s units finishes an open sketch first, so discarding it cannot undo the change', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __assistantChat: unknown }).__assistantChat = async function* (messages: { role: string }[]) {
      if (messages.some((m) => m.role === 'assistant')) { yield { type: 'text', text: 'Now in inches.' }; return; }
      yield { type: 'tool', id: 'c1', name: 'set_part', input: { units: 'IPS' } };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  type P = { __parametric: { startSketchOn(r: unknown): void; sketchEditor: unknown; store: { doc: { units: string } } } };
  await page.evaluate(() => (window as unknown as P).__parametric.startSketchOn({ kind: 'base', plane: 'top' }));
  expect(await page.evaluate(() => !!(window as unknown as P).__parametric.sketchEditor)).toBe(true);
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('Switch to inches');
  await box.press('Enter');
  await expect(page.getByText('Now in inches.')).toBeVisible();
  expect(await page.evaluate(() => [(window as unknown as P).__parametric.store.doc.units, !!(window as unknown as P).__parametric.sketchEditor])).toEqual(['IPS', false]);
});

test('opening another part while a step is running keeps that step out of the new part', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __assistantChat: unknown; __asked?: boolean };
    w.__assistantChat = async function* (messages: { role: string }[]) {
      if (messages.some((m) => m.role === 'assistant')) { yield { type: 'text', text: 'Done.' }; return; }
      w.__asked = true;
      yield { type: 'tool', id: 'c1', name: 'create_sketch', input: { plane: 'front', name: 'Stray', shapes: [{ type: 'circle', center: [0, 0], radius: 9 }] } };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  type P = { __parametric: { whenBuilt(): Promise<void>; newDocument(n: string): void; store: { doc: { name: string; features: { name: string }[] } } }; __stepWaiting?: boolean; __asked?: boolean };
  // The step waits on a slow rebuild, during which the user opens another part.
  await page.evaluate(() => {
    const w = window as unknown as P;
    const app = w.__parametric;
    const real = app.whenBuilt.bind(app);
    app.whenBuilt = async () => {
      if (!w.__asked) return real();
      w.__stepWaiting = true;
      await new Promise((r) => setTimeout(r, 800));
      return real();
    };
  });
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('A sketch');
  await box.press('Enter');
  await page.waitForFunction(() => (window as unknown as P).__stepWaiting);
  await page.evaluate(() => (window as unknown as P).__parametric.newDocument('Other part'));
  await expect(page.getByText('Stopped: another part was opened.')).toBeVisible();
  await expect(page.locator('.as-step:not(.running)')).toHaveCount(1);
  expect(await page.evaluate(() => { const d = (window as unknown as P).__parametric.store.doc; return [d.name, d.features.map((f) => f.name)]; })).toEqual(['Other part', []]);
  await expect(page.locator('.as-step.error')).toContainText('another part was opened');
});

test('a failed reply about a part that was then closed cannot be tried again on the part opened', async ({ page }) => {
  await page.addInitScript(() => {
    let n = 0;
    (window as unknown as { __assistantChat: unknown }).__assistantChat = async function* () {
      if (n++ === 0) throw new Error('The request was refused');
      yield { type: 'tool', id: `c${n}`, name: 'delete_features', input: { features: ['Sketch1'] } };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('Delete Sketch1');
  await box.press('Enter');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  // The retry would carry on with no description of the part now open.
  await page.evaluate(() => (window as unknown as { __parametric: { newDocument(n: string): void } }).__parametric.newDocument('Other part'));
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(page.locator('.as-error')).toBeVisible();
});

test('what a message changed in a part that was then closed is not offered for undoing in the part opened', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __assistantChat: unknown }).__assistantChat = async function* (messages: { role: string }[]) {
      if (messages.some((m) => m.role === 'assistant')) { yield { type: 'text', text: 'Done.' }; return; }
      yield { type: 'tool', id: 'c1', name: 'set_variables', input: { set: [{ name: 'W', value: 5 }] } };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('Add a variable');
  await box.press('Enter');
  await expect(page.getByRole('button', { name: 'Undo changes' })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __parametric: { newDocument(n: string): void } }).__parametric.newDocument('Other part'));
  await expect(page.getByRole('button', { name: 'Undo changes' })).toHaveCount(0);
  await expect(page.getByText('Done.')).toBeVisible();
});

test('a reply cut off at the length limit says so', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __assistantChat: unknown }).__assistantChat = async function* () {
      yield { type: 'text', text: 'The plate is 100 mm wide and its holes are' };
      yield { type: 'cut' };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('Describe the plate in detail');
  await box.press('Enter');
  await expect(page.getByText('its holes are')).toBeVisible();
  await expect(page.locator('.as-bot .as-foot')).toContainText('Cut off: the reply reached its length limit.');
});

test('the conversation keeps its place when the pane is closed or switched and shown again', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __assistantChat: unknown }).__assistantChat = async function* () {
      yield { type: 'text', text: Array.from({ length: 80 }, (_, i) => `Line ${i}`).join('\n\n') };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('A long answer');
  await box.press('Enter');
  await expect(page.locator('.as-bot[aria-busy]')).toHaveCount(0);
  const log = page.locator('.as-log');
  const fromEnd = () => log.evaluate((l) => l.scrollHeight - l.clientHeight - l.scrollTop);
  await expect.poll(fromEnd).toBeLessThan(2);
  const tab = (pane: string) => page.locator(`.tp-strip [data-pane="${pane}"]`);
  await tab('files').click();
  await tab('assistant').click();
  await expect.poll(fromEnd).toBeLessThan(2);
  await page.getByRole('button', { name: 'Close task pane' }).click();
  await tab('assistant').click();
  await expect.poll(fromEnd).toBeLessThan(2);
  // Scrolled up to read, it comes back where it was.
  await log.evaluate((l) => { l.scrollTop = 300; });
  await tab('files').click();
  await tab('assistant').click();
  await expect.poll(() => log.evaluate((l) => Math.round(l.scrollTop))).toBe(300);
});

test('the ideas offered before the first message follow whether the part has features yet', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await expect(page.locator('.as-empty')).toContainText('Describe a part to design');
  type P = { __parametric: { store: { change(l: string, f: (d: { features: unknown[] }) => void): void; undo(): void } } };
  await page.evaluate(() => (window as unknown as P).__parametric.store.change('Sketch', (d) => {
    d.features.push({ id: 's1', type: 'sketch', name: 'Sketch1', plane: { kind: 'base', plane: 'top' }, entities: [], constraints: [] });
  }));
  await expect(page.locator('.as-empty')).toContainText('Change or ask about this part');
  await expect(page.getByRole('button', { name: 'Explain how this part is built' })).toBeVisible();
  await page.evaluate(() => (window as unknown as P).__parametric.store.undo());
  await expect(page.locator('.as-empty')).toContainText('Describe a part to design');
});

test('the assistant reads the part as rebuilt, not as it was before a rebuild that is still running', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __results: string[]; __assistantChat: unknown };
    w.__results = [];
    w.__assistantChat = async function* (messages: { role: string; content: unknown }[]) {
      const round = messages.filter((m) => m.role === 'assistant').length;
      if (round === 0) {
        w.__results.push(String(messages[1].content));
        yield { type: 'tool', id: 'c1', name: 'find_geometry', input: { kind: 'faces', limit: 1 } };
        return;
      }
      w.__results.push(String(messages.at(-1)!.content));
      yield { type: 'text', text: 'Read it.' };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  // Sent while the part opened is still being built.
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('What is this?');
  await box.press('Enter');
  await expect(page.getByText('Read it.')).toBeVisible({ timeout: 60_000 });
  const [snapshot, found] = await page.evaluate(() => (window as unknown as { __results: string[] }).__results);
  expect(snapshot).not.toContain('Body: none yet');
  expect(snapshot).not.toContain('not built yet');
  expect(found).toMatch(/^\d+ of \d+ faces match \(showing 1\)/);
});

test('each step says whether it was done, failed or not run, and why, without hovering', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __assistantChat: unknown }).__assistantChat = async function* (messages: { role: string }[]) {
      if (messages.some((m) => m.role === 'assistant')) { yield { type: 'text', text: 'Done.' }; return; }
      yield { type: 'tool', id: 'c1', name: 'set_variables', input: { set: [{ name: 'W', value: 5 }] } };
      yield { type: 'tool', id: 'c2', name: 'add_fillet', input: { edges: ['no-such-edge'], radius: 1 } };
      yield { type: 'tool', id: 'c3', name: 'set_variables', input: { set: [{ name: 'H', value: 5 }] } };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('Go');
  await box.press('Enter');
  await expect(page.getByText('Done.')).toBeVisible();
  const steps = page.locator('.as-step');
  await expect(steps.nth(0)).toHaveText(/^Done: Set variables$/);
  await expect(steps.nth(1)).toContainText('Failed: Add fillet');
  await expect(steps.nth(2)).toContainText('Skipped: Set variables');
  await expect(steps.nth(2).locator('.as-step-detail')).toHaveText('Not run: an earlier change in this reply failed.');
});

test('an earlier message is not undone while the assistant works on the next one', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __assistantChat: unknown; __go?: () => void; __waiting?: boolean };
    w.__assistantChat = async function* (messages: { role: string; content: unknown }[]) {
      const users = messages.filter((m) => m.role === 'user').length;
      const last = messages.at(-1)!;
      if (last.role !== 'user') { yield { type: 'text', text: `Done ${users}.` }; return; }
      if (users === 2) { w.__waiting = true; await new Promise<void>((r) => { w.__go = r; }); }
      yield { type: 'tool', id: `a${users}`, name: 'set_variables', input: { set: [{ name: `A${users}`, value: 1 }] } };
      yield { type: 'tool', id: `b${users}`, name: 'set_variables', input: { set: [{ name: `B${users}`, value: 1 }] } };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('First');
  await box.press('Enter');
  await expect(page.getByText('Done 1.')).toBeVisible();
  await box.fill('Second');
  await box.press('Enter');
  await page.waitForFunction(() => (window as unknown as { __waiting?: boolean }).__waiting);
  await page.getByRole('button', { name: 'Undo changes' }).click();
  await expect(page.getByText('The assistant is still working.')).toBeVisible();
  await page.evaluate(() => (window as unknown as { __go: () => void }).__go());
  await expect(page.getByText('Done 2.')).toBeVisible();
  type P = { __parametric: { store: { doc: { variables: { name: string }[] }; undoDepth: number } } };
  expect(await page.evaluate(() => (window as unknown as P).__parametric.store.doc.variables.map((v) => v.name))).toEqual(['A1', 'B1', 'A2', 'B2']);
  // One undo step per message.
  expect(await page.evaluate(() => (window as unknown as P).__parametric.store.undoDepth)).toBe(2);
});

test('Edit > Undo and its keys wait while the assistant changes the part, so the message stays one undo step', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __assistantChat: unknown; __go?: () => void; __waiting?: boolean };
    w.__assistantChat = async function* (messages: { role: string }[]) {
      const rounds = messages.filter((m) => m.role === 'assistant').length;
      if (rounds === 0) { yield { type: 'tool', id: 'a', name: 'set_variables', input: { set: [{ name: 'A', value: 1 }] } }; return; }
      if (rounds === 1) {
        w.__waiting = true;
        await new Promise<void>((r) => { w.__go = r; });
        yield { type: 'tool', id: 'b', name: 'set_variables', input: { set: [{ name: 'B', value: 1 }] } };
        return;
      }
      yield { type: 'text', text: 'Both set.' };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  type P = { __parametric: { store: { doc: { variables: { name: string }[] }; undoDepth: number; undoLabel: string } } };
  const names = () => page.evaluate(() => (window as unknown as P).__parametric.store.doc.variables.map((v) => v.name));
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('Two variables');
  await box.press('Enter');
  await page.waitForFunction(() => (window as unknown as { __waiting?: boolean }).__waiting);
  expect(await names()).toEqual(['A']);
  // The shortcut, away from the message box (whose own Undo is the text's).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+z');
  await expect(page.getByText('The assistant is still working.').first()).toBeVisible();
  expect(await names()).toEqual(['A']);
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Edit' }).click();
  await page.getByRole('menuitem', { name: /^Undo/ }).click();
  expect(await names()).toEqual(['A']);
  await page.evaluate(() => (window as unknown as { __go: () => void }).__go());
  await expect(page.getByText('Both set.')).toBeVisible();
  expect(await names()).toEqual(['A', 'B']);
  expect(await page.evaluate(() => (window as unknown as P).__parametric.store.undoDepth)).toBe(1);
  // Once it is done, Undo works as always, the whole message at once.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+z');
  await expect.poll(names).toEqual([]);
});

test('text of nothing but spaces and line breaks leaves no empty gap in the reply', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __assistantChat: unknown }).__assistantChat = async function* (messages: { role: string }[]) {
      if (messages.some((m) => m.role === 'assistant')) { yield { type: 'text', text: '\n\n' }; yield { type: 'text', text: 'Done.' }; return; }
      yield { type: 'text', text: '\n\n ' };
      yield { type: 'tool', id: 'c1', name: 'calculate', input: { expressions: ['1+1'] } };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('Add');
  await box.press('Enter');
  await expect(page.getByText('Done.')).toBeVisible();
  await expect(page.locator('.as-bot .as-text')).toHaveCount(1);
  await expect(page.locator('.as-bot .as-body > *').first()).toHaveClass(/as-steps/);
});

test('double-clicking Send sends once and does not stop the reply it started', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __sends: number; __assistantChat: unknown };
    w.__sends = 0;
    w.__assistantChat = async function* () {
      w.__sends++;
      await new Promise((r) => setTimeout(r, 300));
      yield { type: 'text', text: 'Answered in full.' };
    };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const box = page.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('Hello');
  await page.getByRole('button', { name: 'Send' }).dblclick();
  await expect(page.getByText('Answered in full.')).toBeVisible();
  await expect(page.locator('.as-bot .as-foot')).not.toContainText('Stopped');
  expect(await page.evaluate(() => (window as unknown as { __sends: number }).__sends)).toBe(1);
});
