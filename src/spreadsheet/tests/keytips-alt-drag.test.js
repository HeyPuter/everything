// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { attachKeyTips } from '../src/ui/keytips.js';

// Alt held while dragging an object lines it up with the cells (or lets it go free with snapping on), but Alt
// pressed and let go with no other key in between was taken as a tap: the key tips came up over the ribbon at the
// end of every Alt-drag and took the next key typed. Alt pressed while a pointer button is held is the drag's.
let tips;
afterEach(() => { tips?.destroy(); tips = null; document.body.replaceChildren(); });

function mount() {
  const ribbon = document.createElement('div');
  ribbon.innerHTML = '<button class="ribbon-tab">Home</button><button class="ribbon-tab">Insert</button>';
  document.body.append(ribbon);
  tips = attachKeyTips({ ribbon });
}
const key = (type, k, extra = {}) => document.body.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...extra }));
const pointer = (type) => document.body.dispatchEvent(new Event(type, { bubbles: true }));

it('brings the tips up for Alt tapped alone', () => {
  mount();
  key('keydown', 'Alt', { altKey: true }); key('keyup', 'Alt');
  expect(tips.active).toBe(true);
});

it.each([
  ['the button released first', ['pointerdown', 'Alt down', 'pointerup', 'Alt up']],
  ['Alt released first', ['pointerdown', 'Alt down', 'Alt up', 'pointerup']],
  ['Alt held from before the press', ['Alt down', 'pointerdown', 'pointerup', 'Alt up']],
])('leaves the tips down after an Alt-drag, with %s', (_, steps) => {
  mount();
  for (const step of steps) {
    if (step === 'Alt down') key('keydown', 'Alt', { altKey: true });
    else if (step === 'Alt up') key('keyup', 'Alt');
    else pointer(step);
  }
  expect(tips.active).toBe(false);
  // A tap after the drag still brings them up.
  key('keydown', 'Alt', { altKey: true }); key('keyup', 'Alt');
  expect(tips.active).toBe(true);
});
