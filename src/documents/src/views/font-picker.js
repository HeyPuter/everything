import { el } from '../ui/dom.js';
import { openPopover } from '../ui/popover.js';
import { closeMenu } from '../ui/menu.js';
import { checkFontAvailability, prepareCanvasFont, fontAvailable, documentFontAvailable, displayedFont } from '../engine/font-availability.js';
import { isEmbeddedFont } from '../engine/embedded-fonts.js';
import { canvasFontFamily } from '../engine/font-families.js';
import { browseLocalFonts } from '../engine/local-fonts.js';
import { fileFontNames, fileFontFamily } from '../engine/file-fonts.js';
import { fontFileControls } from './font-files.js';

const BUNDLED = ['Noto Sans', 'Open Sans', 'Oswald', 'Bebas Neue'];
const COMMON = ['Arial', 'Calibri', 'Cambria', 'Courier New', 'Georgia', 'Helvetica', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
const recent = [];
let installed = [];

/** Font names to offer in a list: recent, bundled, common and any installed families the user shared. */
export const fontChoices = () => [...new Set([...recent, ...BUNDLED, ...COMMON, ...installed])];

export function openFontPicker({ anchor, value, alternatives, apply, onFontsAvailable, focusFirst = true }) {
  let popup;
  const notice = el('p.field-hint', { role: 'status' }, value === null ? 'The selection uses mixed fonts.' : `Current font: ${value}`);
  const initialNotice = notice.textContent;
  const list = el('div.font-picker-list', { role: 'group', 'aria-label': 'Available fonts' });
  const search = el('input.input', { type: 'search', 'aria-label': 'Search fonts', placeholder: 'Search or enter a font name…', oninput: render });
  search.addEventListener('keydown', e => { if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector('button')?.focus(); } });
  list.addEventListener('keydown', e => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const choices = [...list.querySelectorAll('button')], at = choices.indexOf(document.activeElement);
    if (e.key === 'ArrowUp' && at === 0) { search.focus(); return; }
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? choices.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
    choices[next]?.focus();
  });
  let selectionRequest = 0;
  async function choose(name) {
    const request = ++selectionRequest;
    await prepareCanvasFont(name);
    if (!popup?.menu?.isConnected || request !== selectionRequest) return;
    if (documentFontAvailable(name, alternatives) !== true) { notice.textContent = `${name} could not be loaded on this device. Choose another font.`; return; }
    recent.splice(0, recent.length, name, ...recent.filter(n => n !== name).slice(0, 4));
    closeMenu(); apply(name);
  }
  const useName = el('button.btn', { type: 'button', hidden: true, onclick: () => choose(search.value.trim()) });
  const installedButton = typeof window.queryLocalFonts === 'function' && el('button.btn', {
    type: 'button', onclick: async () => {
      installedButton.disabled = true;
      try {
        // Request permission only from this user action. Font files stay local.
        const faces = await browseLocalFonts();
        installed = [...new Map(faces.filter(f => typeof f.family === 'string' && f.family.trim())
          .map(f => [f.family.trim().toLowerCase(), f.family.trim()])).values()].sort((a, b) => a.localeCompare(b));
        try { await onFontsAvailable?.(); }
        catch {
          if (popup?.menu?.isConnected) {
            notice.textContent = 'Installed fonts are available, but the document could not refresh. Reopen it to try again.';
            render();
          }
          return;
        }
        if (!popup?.menu?.isConnected) return;
        notice.textContent = installed.length ? `${installed.length} installed font families available.` : 'No installed fonts were returned. You can still enter a font name.';
        render();
      } catch {
        if (popup?.menu?.isConnected) notice.textContent = 'Installed fonts could not be listed. You can still enter a font name.';
      } finally { installedButton.disabled = false; }
    },
  }, 'Browse installed fonts');
  const content = el('form', { onsubmit: e => {
    e.preventDefault();
    const first = list.querySelector('button');
    if (first) first.click(); else if (!useName.hidden) useName.click();
  } }, search, notice, installedButton || el('p.field-hint', {}, 'To use an installed font, enter its full name.'), fontFileControls({ onFontsAvailable, onLoaded: render, status: notice }), useName, list);
  function render() {
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.font : null;
    const names = [...new Map([...recent, ...BUNDLED, ...(value && documentFontAvailable(value, alternatives) === true ? [value] : []), ...COMMON.filter(name => fontAvailable(name) === true), ...installed, ...fileFontNames()].map(name => [name.toLowerCase(), name])).values()];
    const typed = search.value.trim();
    useName.hidden = !typed || names.some(name => name.toLowerCase() === typed.toLowerCase());
    useName.textContent = `Use “${typed}”`;
    const matches = names.filter(name => name.toLowerCase().includes(search.value.trim().toLowerCase()));
    list.replaceChildren(...matches.map(name => el('button.font-choice', {
      type: 'button', dataset: { font: name }, 'aria-pressed': String(value === name), style: { fontFamily: canvasFontFamily({ fontFamily: displayedFont({ fontFamily: name }, alternatives) }) },
      onclick: () => choose(name),
    }, el('span', {}, name), el('small', {}, fileFontFamily(name) ? 'Loaded for this session' : isEmbeddedFont(displayedFont({ fontFamily: name }, alternatives)) ? 'In this document' : recent.includes(name) ? 'Recent' : BUNDLED.includes(name) ? 'Included' : 'On this device'))));
    if (focused) [...list.querySelectorAll('button')].find(button => button.dataset.font === focused)?.focus();
    if (!matches.length) list.append(el('p.field-hint', {}, 'No matching fonts. Try another name.'));
  }
  render();
  popup = openPopover({ anchor, label: 'Font', content, focusFirst });
  Promise.all([...BUNDLED, ...COMMON, ...(value ? [value] : [])].map(checkFontAvailability)).then(() => {
    if (!popup.menu?.isConnected) return;
    // Availability work may finish after browsing, loading, or selecting a font.
    // Keep the result of that newer action while still refreshing the choices.
    if (notice.textContent === initialNotice && value && documentFontAvailable(value, alternatives) === false) notice.textContent = `${value} is unavailable. Displaying ${displayedFont({ fontFamily: value }, alternatives)}; its original name stays in the file until you choose a font.`;
    render();
    // The list grew with the fonts found on this device: keep the popover inside the window.
    popup.reposition?.();
  });
  return popup;
}
