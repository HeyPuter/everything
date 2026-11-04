import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';

async function openFiles(page, files) {
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (await chooser).setFiles(files);
}
for (const format of ['png', 'jpeg'])
  for (const phase of ['modules', 'read'])
    for (const newer of ['none', 'pdf', 'picture', ...(phase === 'read' ? ['library'] : [])])
      test(`${format} batch waiting for ${phase} respects ${newer === 'none' ? 'the current import' : `a newer ${newer} choice`}`, async ({
        page,
      }) => {
        const canvas = createCanvas(4, 3);
        const context = canvas.getContext('2d');
        context.fillStyle = '#d02020';
        context.fillRect(0, 0, 4, 3);
        const picture = { mimeType: `image/${format}`, buffer: await canvas.encode(format) };
        await page.route('https://js.puter.com/**', (route) => route.abort());
        let releaseModules,
          modulesRequested = false;
        const moduleGate = new Promise((resolve) => {
          releaseModules = resolve;
        });
        if (phase === 'modules')
          await page.route('**/src/core/image-pages.js', async (route) => {
            modulesRequested = true;
            const response = await route.fetch();
            // WebKit can fetch the same module for concurrent import requests.
            await moduleGate;
            await route.fulfill({ response });
          });
        await page.addInitScript((phase) => {
          const read = File.prototype.arrayBuffer;
          const held = [];
          let released = false;
          window.earlierPictureReads = 0;
          window.heldPictureReads = 0;
          window.releasePictureReads = () => {
            released = true;
            held.forEach((resolve) => resolve());
            setTimeout(() => {
              window.pictureReadsSettled = true;
            }, 0);
          };
          File.prototype.arrayBuffer = async function () {
            const earlier = this.name.startsWith('earlier-');
            if (earlier) window.earlierPictureReads++;
            const bytes = await read.call(this);
            if (earlier && phase === 'read' && !released)
              await new Promise((resolve) => {
                held.push(resolve);
                window.heldPictureReads++;
              });
            return bytes;
          };
        }, phase);
        await page.goto(phase === 'modules' ? '/#library' : '/');
        if (phase === 'modules')
          await expect(
            page.getByRole('button', { name: 'New blank PDF', exact: true }),
          ).toBeVisible();
        else await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
        await page.evaluate(async () => {
          const { blankPdf, validatePdf } = await import('/src/core/document.js');
          const prototype = Object.getPrototypeOf(await validatePdf(await blankPdf()));
          window.pictureEmbeds = 0;
          for (const method of ['embedPng', 'embedJpg']) {
            const embed = prototype[method];
            prototype[method] = function (...args) {
              window.pictureEmbeds++;
              return embed.apply(this, args);
            };
          }
        });
        await openFiles(
          page,
          [1, 2].map((index) => ({ ...picture, name: `earlier-${index}.${format}` })),
        );
        if (phase === 'modules') await expect.poll(() => modulesRequested).toBe(true);
        else await expect.poll(() => page.evaluate(() => window.heldPictureReads)).toBe(1);
        if (newer === 'pdf') {
          const doc = await PDFDocument.create();
          doc.addPage([300, 300]);
          doc.addPage([300, 300]);
          await openFiles(page, {
            name: 'latest.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from(await doc.save()),
          });
        } else if (newer === 'picture')
          await openFiles(page, { ...picture, name: `latest.${format}` });
        else if (newer === 'library') {
          await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
          await expect(
            page.getByRole('button', { name: 'New blank PDF', exact: true }),
          ).toBeVisible();
        }
        // A newer editor also needs the held module. For the read phase it can finish
        // opening before the old batch is released, proving cancellation after replacement.
        if (phase === 'read' && ['pdf', 'picture'].includes(newer))
          // A PDF made from pictures is new, so it is marked unsaved.
          await expect(page).toHaveTitle(`${newer === 'pdf' ? '' : '* '}latest.pdf · PDF Editor`);
        if (phase === 'modules') {
          releaseModules();
          await page.evaluate(async () => {
            await import('/src/core/image-pages.js');
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
        } else {
          await page.evaluate(() => window.releasePictureReads());
          await expect.poll(() => page.evaluate(() => window.pictureReadsSettled)).toBe(true);
        }
        if (newer === 'library') {
          await expect(page).toHaveTitle('PDF Editor');
          await expect(
            page.getByRole('button', { name: 'New blank PDF', exact: true }),
          ).toBeVisible();
        } else {
          await expect(page).toHaveTitle(
            `${newer === 'pdf' ? '' : '* '}${newer === 'none' ? 'earlier-1' : 'latest'}.pdf · PDF Editor`,
          );
          await expect(page.locator('.page-caption')).toHaveText(
            `Page 1 of ${newer === 'picture' ? 1 : 2}`,
          );
          await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
        }
        expect(await page.evaluate(() => window.earlierPictureReads)).toBe(
          newer === 'none' ? 2 : phase === 'modules' ? 0 : 1,
        );
        expect(await page.evaluate(() => window.pictureEmbeds)).toBe(
          newer === 'none' ? 2 : newer === 'picture' ? 1 : 0,
        );
        await expect(page.locator('#toast')).toBeHidden();
        if (newer !== 'library') {
          const download = page.waitForEvent('download');
          await page.getByRole('button', { name: 'Download', exact: true }).click();
          const saved = await PDFDocument.load(await readFile(await (await download).path()));
          expect(saved.getPageCount()).toBe(newer === 'picture' ? 1 : 2);
          for (const sheet of saved.getPages()) {
            const images =
              sheet.node
                .Resources()
                ?.lookup(PDFName.of('XObject'))
                ?.entries()
                .filter(
                  ([, ref]) =>
                    saved.context.lookup(ref).dict.get(PDFName.of('Subtype')) ===
                    PDFName.of('Image'),
                ) || [];
            expect(images).toHaveLength(newer === 'pdf' ? 0 : 1);
          }
        }
      });
