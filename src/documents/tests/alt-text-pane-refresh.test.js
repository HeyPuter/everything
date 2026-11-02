// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createPane } from '../src/views/alt-text-pane.js';

afterEach(() => document.body.replaceChildren());

it('shows the title the picture has after an undo, though it is as long as the one before', async () => {
  // The drawing's XML holds its title; undoing "Dog" back to "Cat" keeps the XML the same length.
  const picture = title => ({ id: 1, alt: 'A pet', shell: `<w:drawing><wp:docPr id="1" descr="A pet" title="${title}"/></w:drawing>` });
  let image = picture('Dog');
  const altText = vi.fn(async () => true);
  const pane = createPane({ selected: () => image, describe: i => ({ description: i.alt, title: /title="([^"]*)"/.exec(i.shell)[1], decorative: false }), commands: { altText }, onClose() {}, kind: () => 'picture' });
  document.body.append(pane.node);
  pane.refresh();
  const title = pane.node.querySelector('[aria-label="Title (optional)"]'), description = pane.node.querySelector('[aria-label="Description"]');
  expect(title.value).toBe('Dog');
  image = picture('Cat'); pane.refresh();
  expect(title.value).toBe('Cat');
  // Saving the description afterwards does not write the undone title back.
  description.value = 'A sleepy pet'; description.dispatchEvent(new Event('blur'));
  await Promise.resolve();
  expect(altText).toHaveBeenCalledWith({ description: 'A sleepy pet', title: 'Cat', decorative: false }, image);
});
