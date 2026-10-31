// Native emoji only; nothing is fetched.
import { el } from '../../../ui/dom.js';
import { openModal } from '../../../ui/modal.js';
import { t } from '../../../lib/i18n/index.js';

export const QUICK_REACTIONS = Object.freeze(['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '👀']);

const GROUPS = Object.freeze([
  ['smileys', '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 😝 🤗 🤭 🤫 🤔 😐 😑 😶 🙄 😏 😬 😌 😔 😪 😴 🤤 😷 🤒 🤕 🤢 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬'],
  ['people', '👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 👏 🙌 👐 🤲 🤝 🙏 💪 🦾 🫶 👀 🧠 🫡 🙋 🙆 🙅 🤷 🤦 🧑‍🤝‍🧑 👪 🚶 🏃 🧗 🏊 🚴 🧘'],
  ['travel', '✈️ 🛫 🛬 🚆 🚄 🚇 🚌 🚕 🚗 🚙 🚲 🛵 🛳️ ⛴️ 🚢 ⛵ 🚀 🗺️ 🧭 🏔️ ⛰️ 🌋 🏕️ 🏖️ 🏝️ 🏜️ 🏞️ 🏛️ 🏰 🏯 🗼 🗽 ⛩️ 🕌 ⛪ 🏨 🏠 🎡 🎢 🎠 ⛲ 🌉 🌃 🌅 🌄 🧳 🎒 🛂 🛃 🎫 🎟️ 📍 📸 🗿'],
  ['food', '☕ 🍵 🧃 🥤 🍺 🍻 🥂 🍷 🍸 🍹 🍾 🍕 🍔 🍟 🌭 🥪 🌮 🌯 🥙 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🥗 🥘 🍳 🥞 🧇 🥐 🥖 🧀 🍦 🍰 🎂 🍩 🍪 🍫 🍎 🍊 🍋 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥑'],
  ['nature', '☀️ 🌤️ ⛅ 🌥️ ☁️ 🌦️ 🌧️ ⛈️ 🌩️ 🌨️ ❄️ ☃️ 🌬️ 💨 🌪️ 🌫️ 🌈 ☔ ⚡ 🔥 💧 🌊 🌍 🌎 🌏 🌙 ⭐ 🌟 ✨ 🌸 🌺 🌻 🌷 🌹 🌴 🌵 🌲 🍁 🍂 🐶 🐱 🐻 🐼 🐨 🦁 🐮 🐷 🐸 🐵 🐧 🐦 🦋 🐢 🐬 🐳 🦀'],
  ['activities', '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏓 🏸 ⛳ 🎣 🤿 🎿 🏂 🛶 🏄 🎯 🎳 🎮 🎲 🧩 🎨 🎭 🎤 🎧 🎸 🎹 🎺 🎻 🎬 📚 🎉 🎊 🎈 🎁 🏆 🥇 🥈 🥉 🏅'],
  ['symbols', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💯 ✅ ☑️ ✔️ ❌ ❎ ⭕ ❗ ❓ ‼️ ⁉️ ⚠️ 🚫 💤 💬 💭 🕐 ⏰ ⏳ 📅 📌 📎 🔑 🔒 💡 💰 💳 🧾 🔔 ➕ ➖ ➡️ ⬅️ ⬆️ ⬇️ 🔁 🆗 🆕 🆒'],
  ['flags', '🏳️ 🏴 🏁 🚩 🏳️‍🌈 🇦🇷 🇦🇺 🇦🇹 🇧🇪 🇧🇷 🇨🇦 🇨🇱 🇨🇳 🇨🇴 🇭🇷 🇨🇿 🇩🇰 🇪🇬 🇫🇮 🇫🇷 🇩🇪 🇬🇷 🇮🇸 🇮🇳 🇮🇩 🇮🇪 🇮🇱 🇮🇹 🇯🇵 🇰🇪 🇲🇽 🇲🇦 🇳🇱 🇳🇿 🇳🇴 🇵🇪 🇵🇭 🇵🇱 🇵🇹 🇰🇷 🇿🇦 🇪🇸 🇸🇪 🇨🇭 🇹🇭 🇹🇷 🇺🇦 🇦🇪 🇬🇧 🇺🇸 🇻🇳'],
].map(([id, list]) => Object.freeze({ id, emoji: Object.freeze(list.split(' ')) })));

const COLUMNS = 8;

/** A grid dialog of native emoji with arrow-key movement; resolves through `onPick(emoji)`. */
export function openEmojiPicker({ title = t('collab.emoji.title'), onPick }) {
  const buttons = [];
  let dialog;
  const sections = GROUPS.map((group) => {
    const headingId = `collab-emoji-${group.id}`;
    const grid = el('div.emoji-grid', { role: 'group', 'aria-labelledby': headingId }, group.emoji.map((emoji) => {
      const node = el('button.emoji-cell', { type: 'button', tabIndex: buttons.length ? -1 : 0, onclick: () => { dialog.close('pick'); onPick(emoji); } }, emoji);
      buttons.push(node);
      return node;
    }));
    return el('section.emoji-section', {}, el('h3.emoji-heading', { id: headingId }, t(`collab.emoji.${group.id}`)), grid);
  });
  const body = el('div.emoji-picker', {}, sections);
  body.addEventListener('keydown', (event) => {
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    const rtl = getComputedStyle(body).direction === 'rtl';
    const moves = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS };
    let next;
    if (Object.hasOwn(moves, event.key)) next = Math.max(0, Math.min(buttons.length - 1, index + moves[event.key]));
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    buttons[index].tabIndex = -1;
    buttons[next].tabIndex = 0;
    buttons[next].focus();
  });
  dialog = openModal({ title, content: body, initialFocus: buttons[0] });
  return dialog;
}
