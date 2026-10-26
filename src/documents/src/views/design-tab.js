/**
 * The Design tab: document themes, style sets, theme colors, fonts and effects, paragraph spacing,
 * watermarks, page color and page borders.
 * Theme, style-set, watermark and fill-effect changes rewrite parts of the saved package and reopen it
 * in place (see editor.js changePackage), so Undo steps back to the package before the change; spacing,
 * colors and borders of the page go through the editor's transactions.
 */
import { el } from '../ui/dom.js';
import { openMenu, closeMenu } from '../ui/menu.js';
import { promptDialog, confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { THEMES, COLOR_SCHEMES, FONT_SCHEMES, EFFECT_SCHEMES, STYLE_SETS, resolvedTheme } from '../engine/document-themes.js';
import { openCustomizeColors, openCustomizeFonts, openParagraphSpacing, openCustomWatermark, openFillEffects, openPageColor, WATERMARK_PRESETS } from './design-dialogs.js';
import '../styles/design-tab.css';

const design = () => import('../engine/package-design.js');

/* Saved themes, palettes, font pairs, style sets and new-document defaults live in this browser. */
const KEYS = { themes: 'documents.design.themes', colors: 'documents.design.colors', fonts: 'documents.design.fonts', styleSets: 'documents.design.styleSets', defaults: 'documents.design.defaults' };
export function loadSaved(key, fallback = []) {
  try { const value = JSON.parse(localStorage.getItem(KEYS[key]) || 'null'); return value ?? fallback; } catch { return fallback; }
}
export function storeSaved(key, value) {
  try { if (value === null) localStorage.removeItem(KEYS[key]); else localStorage.setItem(KEYS[key], JSON.stringify(value)); return true; } catch { return false; }
}
const remember = (key, entry) => {
  const list = loadSaved(key).filter(item => item.name !== entry.name);
  if (!storeSaved(key, [...list, entry].slice(-24))) toast('This browser did not keep the saved item.', { icon: 'alert' });
};

/** Small previews drawn in HTML: they follow the theme's colors and name its fonts. */
const fontStack = name => `"${name}", "Canvas Noto Sans", "Noto Sans", sans-serif`;
function themeCard(theme, { selected, onSelect, label = theme.name }) {
  const c = theme.colors;
  return el('button.swatch.design-card.design-theme-card', { type: 'button', role: 'menuitemradio', tabindex: -1, 'aria-checked': String(!!selected), 'aria-label': `${label} theme`, title: label, onclick: onSelect },
    el('span.design-theme-page', { 'aria-hidden': 'true', style: { background: `#${c.lt1}` } },
      el('span.design-theme-title', { style: { fontFamily: fontStack(theme.fonts.major), color: `#${c.dk2}` } }, 'Aa'),
      el('span.design-theme-bars', {}, ...['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map(slot => el('span', { style: { background: `#${c[slot]}` } })))),
    el('span.design-card-name', {}, label));
}
function colorStrip(colors) {
  return el('span.design-color-strip', { 'aria-hidden': 'true' }, ...['dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map(slot => el('span', { style: { background: `#${colors[slot]}` } })));
}

export function createDesignTab({ editor, pkg, error, onChange = () => {}, commands: base = {} }) {
  /** A gallery choice in a menu closes the menus and returns to the document before acting. */
  const choose = action => () => { closeMenu(); editor()?.focus(); action(); };
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly ? engine : null; };
  const editable = () => !!ready() && !!base.changePackage;
  let api = null;
  const loading = design().then(module => { api = module; onChange(); }).catch(() => {});
  // What the open package declares, read once per package; the theme the document opened with is kept for Reset.
  let infoFor = null, info = null, openedTheme;
  function current() {
    const p = pkg();
    if (!p || !api) return { theme: null, styleSet: null, watermark: null, fill: false };
    if (infoFor !== p) {
      infoFor = p;
      const parts = p.parts;
      try {
        info = { theme: api.readThemeInfo(parts), styleSet: api.currentStyleSetName(parts, [...STYLE_SETS, ...loadSaved('styleSets')]), watermark: api.readWatermark(parts), fill: api.hasPageFill(parts) };
      } catch { info = { theme: null, styleSet: null, watermark: null, fill: false }; }
      if (openedTheme === undefined) openedTheme = api.themePartXml(parts);
    }
    return info;
  }
  /** Change the package: edit(parts, api) mutates the parts map, or returns false to leave it alone. */
  async function edit(change) {
    if (!editable()) return false;
    await loading;
    const ok = await base.changePackage(async blob => {
      const parts = await api.blobParts(blob);
      if (await change(parts, api) === false) return null;
      return api.partsBlob(parts);
    });
    if (ok) onChange();
    return ok;
  }
  const themeChange = change => edit((parts, a) => { a.applyDesignTheme(parts, change); a.refreshStyleThemeColors(parts); });

  /* ---- Themes ---- */
  const themeSelected = theme => {
    const now = current().theme;
    return !!now && now.name === theme.name && now.colorName === theme.colors.name && now.fonts.major === theme.fonts.major && now.fonts.minor === theme.fonts.minor && now.effects === theme.effects.name;
  };
  async function browseTheme() {
    const input = el('input', { type: 'file', accept: '.thmx,.xml,application/xml', hidden: true });
    input.addEventListener('change', async () => {
      const file = input.files?.[0]; input.remove();
      if (!file) return;
      try {
        await loading;
        const xml = api.themeFileXml(new Uint8Array(await file.arrayBuffer()));
        if (await themeChange({ xml })) remember('themes', { name: file.name.replace(/\.(thmx|xml)$/i, ''), xml });
      } catch (e) { error(e); }
    }, { once: true });
    document.body.append(input); input.click();
  }
  async function saveTheme() {
    await loading;
    const name = await promptDialog({ title: 'Save Current Theme', label: 'Theme name', value: current().theme?.name || 'My theme', confirmLabel: 'Save',
      hint: 'Saved themes appear under Custom in the Themes gallery in this browser.' });
    if (!name) return;
    const xml = api.themePartXml(pkg().parts) || api.themeXml({ ...resolvedTheme('Paper'), name });
    remember('themes', { name, xml: xml.replace(/(<a:theme\b[^>]*?\sname=")[^"]*"/, `$1${name.replace(/[&<"]/g, '')}"`) });
    toast(`Saved theme "${name}"`, { icon: 'check' });
  }
  function themeItems() {
    const enabled = editable();
    const gallery = (themes, selected) => el('div.menu-custom-grid.design-grid', { role: 'group', dataset: { columns: '4' } },
      ...themes.map(theme => themeCard(theme, { selected: selected(theme), onSelect: choose(() => { if (enabled) themeChange(theme.xml ? { xml: theme.xml } : { theme }); }) })));
    const saved = loadSaved('themes').map(entry => {
      // A saved theme previews from its own XML.
      const colors = Object.fromEntries([...entry.xml.matchAll(/<a:(\w+)><a:(?:srgbClr val|sysClr[^>]*lastClr)="([0-9A-Fa-f]{6})"/g)].map(m => [m[1], m[2].toUpperCase()]));
      const typeface = tag => new RegExp(`<a:${tag}>\\s*<a:latin typeface="([^"]*)"`).exec(entry.xml)?.[1] || 'Noto Sans';
      return { name: entry.name, xml: entry.xml, colors: { dk1: '000000', lt1: 'FFFFFF', dk2: '1F2A44', lt2: 'EEF0F3', ...colors }, fonts: { major: typeface('majorFont'), minor: typeface('minorFont') } };
    });
    return [{ header: 'Built-In' }, { custom: gallery(THEMES.map(resolvedTheme), themeSelected) },
      ...(saved.length ? [{ header: 'Custom' }, { custom: gallery(saved, entry => current().theme?.name === entry.name) }] : []),
      { separator: true },
      { label: 'Reset to Theme from Template', disabled: !enabled, onSelect: () => (openedTheme ? themeChange({ xml: openedTheme }) : themeChange({ theme: resolvedTheme('Paper') })) },
      { label: 'Browse for Themes…', disabled: !enabled, onSelect: browseTheme },
      { label: 'Save Current Theme…', onSelect: saveTheme }];
  }

  /* ---- Colors, fonts, effects ---- */
  function colorItems() {
    const enabled = editable(), now = current().theme;
    const saved = loadSaved('colors');
    const item = scheme => ({ custom: el('button.menu-item.design-row', { type: 'button', role: 'menuitemradio', tabindex: -1, disabled: !enabled,
      'aria-checked': String(!!now && now.colorName === scheme.name), onclick: choose(() => themeChange({ colors: { name: scheme.name, ...scheme.colors } })) },
    colorStrip(scheme.colors), el('span.menu-label', {}, scheme.name)) });
    return [{ header: 'Built-In' }, ...COLOR_SCHEMES.map(item),
      ...(saved.length ? [{ header: 'Custom' }, ...saved.map(item)] : []),
      { separator: true }, { label: 'Customize Colors…', disabled: !enabled, onSelect: customizeColors }];
  }
  async function customizeColors() {
    await loading;
    const now = current().theme, start = now?.colors && Object.values(now.colors).every(Boolean) ? now.colors : resolvedTheme('Paper').colors;
    openCustomizeColors({ colors: start, name: 'Custom 1', apply: scheme => { remember('colors', scheme); return themeChange({ colors: { name: scheme.name, ...scheme.colors } }); } });
  }
  function fontItems() {
    const enabled = editable(), now = current().theme;
    const saved = loadSaved('fonts');
    const item = scheme => ({ custom: el('button.menu-item.design-font-row', { type: 'button', role: 'menuitemradio', tabindex: -1, disabled: !enabled,
      'aria-checked': String(!!now && now.fonts.major === scheme.major && now.fonts.minor === scheme.minor), onclick: choose(() => themeChange({ fonts: scheme })) },
    el('span.design-font-sample', { 'aria-hidden': 'true' }, 'Aa'),
    el('span.design-font-names', {}, el('span.design-font-name', {}, scheme.name),
      el('span.design-font-major', { style: { fontFamily: fontStack(scheme.major) } }, scheme.major),
      el('span.design-font-minor', { style: { fontFamily: fontStack(scheme.minor) } }, scheme.minor))) });
    return [{ header: 'Built-In' }, ...FONT_SCHEMES.map(item), ...(saved.length ? [{ header: 'Custom' }, ...saved.map(item)] : []),
      { separator: true }, { label: 'Customize Fonts…', disabled: !enabled, onSelect: customizeFonts }];
  }
  async function customizeFonts() {
    await loading;
    const now = current().theme?.fonts;
    openCustomizeFonts({ fonts: now?.major ? now : FONT_SCHEMES[0], name: 'Custom 1', apply: scheme => { remember('fonts', scheme); return themeChange({ fonts: scheme }); } });
  }
  function effectItems() {
    const enabled = editable(), now = current().theme;
    return [{ note: 'Effects change the fills, outlines and shadows of shapes that use the theme’s styles.' },
      ...EFFECT_SCHEMES.map(scheme => ({ label: scheme.name, icon: `effects${scheme.name.replace(/\s/g, '')}`, radio: true, checked: now?.effects === scheme.name, disabled: !enabled,
        hint: scheme.effects.some(Boolean) ? 'Shadows' : scheme.fills.includes('gradient') ? 'Gradients' : 'Flat', onSelect: () => themeChange({ effects: scheme }) }))];
  }

  /* ---- Style sets ---- */
  // Style sets name theme fonts and colors: a document without a theme takes the default one first.
  const applyStyleSet = set => edit((parts, a) => {
    if (!a.themePartPath(parts)) a.applyDesignTheme(parts, { theme: resolvedTheme('Paper') });
    a.applyStyleSetParts(parts, set); a.refreshStyleThemeColors(parts);
  });
  const styleSetCard = (set, theme, { selected, onSelect, tag = 'button.ribbon-style.design-set' }) => {
    const c = theme.colors, color = spec => spec?.color ? `#${c[{ text1: 'dk1', text2: 'dk2', background1: 'lt1', background2: 'lt2' }[spec.color.theme] || spec.color.theme] || c.dk1}` : `#${c.dk1}`;
    const s = set.styles || {};
    const title = s.Title || {}, heading = s.Heading1 || {};
    return el(tag, { type: 'button', role: tag.startsWith('button.swatch') ? 'menuitemradio' : 'option', [tag.startsWith('button.swatch') ? 'aria-checked' : 'aria-selected']: String(!!selected), title: set.description ? `${set.name}: ${set.description}` : set.name, 'aria-label': `${set.name} style set`, tabindex: tag.startsWith('button.swatch') ? -1 : null, onclick: onSelect },
      el('span.design-set-page', { 'aria-hidden': 'true' },
        el('span.design-set-title', { style: { color: color(title), fontFamily: fontStack(theme.fonts.major), fontWeight: title.bold ? '700' : '400', textTransform: title.caps ? 'uppercase' : '', textAlign: title.align === 'center' ? 'center' : 'left', borderBottom: title.border ? `1.5px solid #${c.accent1}` : '' } }, 'Title'),
        el('span.design-set-heading', { style: { color: color(heading), fontFamily: fontStack(theme.fonts.major), fontWeight: heading.bold ? '700' : '400', textTransform: heading.caps ? 'uppercase' : '', textAlign: heading.align === 'center' ? 'center' : 'left', borderBottom: heading.border ? `1.5px solid #${c.accent1}` : '' } }, 'Heading 1'),
        el('span.design-set-lines', {}, el('span'), el('span'), el('span'))),
      el('span.design-card-name', {}, set.name));
  };
  const currentTheme = () => {
    const now = current().theme;
    return now?.colors?.accent1 ? { colors: now.colors, fonts: now.fonts } : resolvedTheme('Paper');
  };
  const gallery = el('div.ribbon-gallery.design-sets', { role: 'listbox', 'aria-label': 'Style Sets', 'aria-orientation': 'horizontal', dataset: { shrinkMin: '1', shrinkMax: '420' } });
  let gallerySignature = '';
  function refreshGallery() {
    const theme = currentTheme(), selected = current().styleSet, enabled = editable();
    const signature = JSON.stringify([theme.colors, theme.fonts, selected, enabled]);
    if (signature === gallerySignature) return;
    gallerySignature = signature;
    gallery.replaceChildren(...STYLE_SETS.map(set => {
      const card = styleSetCard(set, theme, { selected: selected === set.name, onSelect: () => applyStyleSet(set) });
      card.disabled = !enabled;
      card.addEventListener('mousedown', e => e.preventDefault());
      return card;
    }));
  }
  function styleSetItems() {
    const enabled = editable(), theme = currentTheme(), selected = current().styleSet;
    const saved = loadSaved('styleSets');
    const grid = sets => el('div.menu-custom-grid.design-grid.design-set-grid', { role: 'group', dataset: { columns: '4' } },
      ...sets.map(set => styleSetCard(set, theme, { selected: selected === set.name, tag: 'button.swatch.design-card.design-set', onSelect: choose(() => { if (enabled) applyStyleSet(set); }) })));
    return [{ header: 'Built-In' }, { custom: grid(STYLE_SETS) }, ...(saved.length ? [{ header: 'Custom' }, { custom: grid(saved) }] : []),
      { separator: true },
      { label: 'Reset to the Default Style Set', disabled: !enabled, onSelect: () => applyStyleSet(STYLE_SETS[0]) },
      { label: 'Save as a New Style Set…', onSelect: saveStyleSet }];
  }
  async function saveStyleSet() {
    await loading;
    const engine = editor(); if (!engine) return;
    const name = await promptDialog({ title: 'Save as a New Style Set', label: 'Style set name', value: 'My style set', confirmLabel: 'Save',
      hint: 'Saves the look of Normal, Title, Subtitle, Heading 1–3 and Quote. Saved style sets appear under Custom in this browser.' });
    if (!name) return;
    const blob = base.exportPackage?.(); if (!blob) return;
    try {
      const parts = await api.blobParts(blob), snippets = api.captureStyleSet(parts);
      // A saved set previews with its heading's look; keep the declarations the preview reads.
      remember('styleSets', { name, snippets, styles: {} });
      toast(`Saved style set "${name}"`, { icon: 'check' });
      infoFor = null; onChange();
    } catch (e) { error(e); }
  }

  /* ---- Paragraph spacing ---- */
  function spacingItems() {
    const engine = editor(), id = engine?.model.styles.defaultParagraph;
    return [...(base.paragraphSpacingItems?.() || []), { separator: true },
      { label: 'Custom Paragraph Spacing…', disabled: !ready() || !id, onSelect: customSpacing }];
  }
  function customSpacing() {
    const engine = ready(), id = engine?.model.styles.defaultParagraph;
    if (!engine || !id) return;
    engine.finishComposition();
    const spacing = engine.model.styles.definitions[id]?.properties?.spacing || {}, defaults = engine.model.styles.defaults.properties?.spacing || {};
    const value = key => Number(spacing[key] ?? defaults[key] ?? 0);
    openParagraphSpacing({ before: value('before') / 20, after: value('after') / 20, line: (spacing.lineRule ?? defaults.lineRule ?? 'auto') === 'auto' ? value('line') / 240 || 1 : 1,
      apply: ({ before, after, line }) => {
        const target = ready(); if (!target) return false;
        const ok = target.editParagraphStyle(id, { paragraph: { spaceBefore: before, spaceAfter: after, lineSpacing: line, lineRule: 'auto' } });
        queueMicrotask(() => target.focus());
        return ok !== false;
      } });
  }

  /* ---- Set as Default ---- */
  async function setAsDefault() {
    await loading;
    const blob = base.exportPackage?.(); if (!blob) return;
    const has = !!loadSaved('defaults', null);
    const ok = await confirmDialog({ title: 'Set as Default', danger: false, confirmLabel: 'Set as Default',
      message: `New documents will start with this document’s theme and style set${has ? ', replacing the defaults set earlier' : ''}. Existing documents are not changed.` });
    if (!ok) return;
    try {
      const parts = await api.blobParts(blob);
      if (!storeSaved('defaults', { themeXml: api.themePartXml(parts), styleSet: api.captureStyleSet(parts) })) throw new Error('This browser did not keep the defaults.');
      toast('New documents will use this theme and style set', { icon: 'check' });
    } catch (e) { error(e); }
  }
  /** A new blank package with the saved defaults applied and opened, or null without defaults. */
  async function newDocumentDefaults(blank, openCanvasDocument) {
    const defaults = loadSaved('defaults', null);
    if (!defaults?.styleSet && !defaults?.themeXml) return null;
    try {
      await loading;
      const parts = await api.blobParts(blank.export());
      if (defaults.themeXml) api.applyDesignTheme(parts, { xml: defaults.themeXml });
      if (api.appAuthoredStyles(parts) || defaults.themeXml) api.linkStylesToTheme(parts);
      if (defaults.styleSet) api.applyStyleSetParts(parts, { snippets: defaults.styleSet });
      api.refreshStyleThemeColors(parts);
      const opened = await openCanvasDocument(api.partsBlob(parts));
      if (opened.pkg.readOnly) { for (const image of opened.images.values()) image.close(); return null; }
      return opened;
    } catch { return null; }
  }

  /* ---- Watermark ---- */
  const setWatermark = watermark => edit((parts, a) => { a.setWatermarkParts(parts, watermark); });
  function watermarkItems() {
    const enabled = editable(), now = current().watermark;
    const grid = el('div.menu-custom-grid.design-grid.design-watermark-grid', { role: 'group', dataset: { columns: '3' } },
      ...WATERMARK_PRESETS.map(preset => el('button.swatch.design-card.design-watermark-card', { type: 'button', role: 'menuitemradio', tabindex: -1, disabled: !enabled,
        'aria-checked': String(now?.kind === 'text' && now.text === preset.text && now.layout === preset.layout), 'aria-label': `${preset.text}, ${preset.layout}`, title: `${preset.text} (${preset.layout})`,
        onclick: choose(() => setWatermark({ kind: 'text', text: preset.text, font: null, size: 'auto', color: 'C0C0C0', semitransparent: true, layout: preset.layout, language: 'en-US' })) },
      el('span.design-watermark-page', { 'aria-hidden': 'true' }, el(`span.design-watermark-text.is-${preset.layout}`, {}, preset.text)),
      el('span.design-card-name', {}, preset.text.toLowerCase().replace(/^\w/, ch => ch.toUpperCase()) + (preset.layout === 'diagonal' ? ' 1' : ' 2')))));
    return [{ header: 'Disclaimers and Status' }, { custom: grid }, { separator: true },
      { label: 'Custom Watermark…', disabled: !enabled, onSelect: customWatermark },
      { label: 'Remove Watermark', disabled: !enabled || !now, onSelect: () => setWatermark(null) }];
  }
  async function customWatermark() {
    await loading;
    if (!editable()) return;
    openCustomWatermark({ current: current().watermark, apply: watermark => setWatermark(watermark) });
  }

  /* ---- Page color and borders ---- */
  const pageSize = () => { const page = editor()?.layout?.pages?.[0]; return { width: page?.width || 816, height: page?.height || 1056 }; };
  function pageColorItems() {
    const enabled = editable(), fill = current().fill;
    return [...(base.pageColorItems?.() || []).map(item => item.onSelect && fill ? { ...item, checked: false } : item), { separator: true },
      { label: 'More Colors…', disabled: !ready(), onSelect: moreColors },
      { label: 'Fill Effects…', icon: 'fillEffects', disabled: !enabled, onSelect: fillEffects },
      ...(fill ? [{ label: 'Remove Fill Effect', disabled: !enabled, onSelect: () => edit((parts, a) => a.setPageFillParts(parts, null)) }] : [])];
  }
  function moreColors() {
    const engine = ready(); if (!engine) return;
    const now = engine.model.pageSettings.background;
    openPageColor({ value: now === 'auto' ? 'FFFFFF' : now, apply: color => {
      const target = ready(); if (!target) return false;
      try { target.setPageSettings({ background: color }); } catch (e) { error(e); return false; }
      target.focus(); return true;
    } });
  }
  async function fillEffects() {
    await loading;
    openFillEffects({ page: pageSize(), apply: async effect => {
      const { renderFill } = await import('./page-fill-effects.js');
      const fill = await renderFill(effect, pageSize());
      const color = editor()?.model.pageSettings.background;
      return edit((parts, a) => a.setPageFillParts(parts, { ...fill, color: color && color !== 'auto' ? color : 'FFFFFF' }));
    } });
  }
  function pageBorderItems() {
    return [...(base.pageBorderItems?.() || []), { separator: true },
      { label: 'Borders and Shading Options…', disabled: !ready() || !base.bordersAndShading, onSelect: () => base.bordersAndShading?.('page') }];
  }

  const commands = {
    themeItems, colorItems: colorItems, themeFontItems: fontItems, effectItems, styleSetItems, watermarkItems, designPageColorItems: pageColorItems,
    applyTheme: name => themeChange({ theme: resolvedTheme(name) }), applyStyleSet: name => { const set = STYLE_SETS.find(s => s.name === name); return set && applyStyleSet(set); },
    setWatermark, customWatermark, fillEffects, setAsDefault, newDocumentDefaults, designState: () => current(),
  };

  /** Ribbon groups for a tab (see canvas-chrome.js: after / replaces). */
  function extendTab(tabId, kit) {
    if (tabId !== 'design') return [];
    const { menuButton, command, rows, when, engineReady } = kit;
    const themes = menuButton('Themes', 'themes', themeItems, { text: 'Themes' });
    const colors = menuButton('Theme Colors', 'themeColors', colorItems, { text: 'Colors' });
    const fonts = menuButton('Theme Fonts', 'themeFonts', fontItems, { text: 'Fonts' });
    const spacing = menuButton('Paragraph Spacing', 'paragraphSpacing', spacingItems, { size: 'small', text: 'Paragraph Spacing' });
    const effects = menuButton('Theme Effects', 'effects', effectItems, { size: 'small', text: 'Effects' });
    const setDefault = command('Set as Default', 'setDefault', setAsDefault, { text: 'Set as Default' });
    const more = command('More Style Sets', 'more', e => openMenu({ anchor: more, label: 'Style Sets', minWidth: 300, pointer: !!e?.detail, onClose: e?.detail ? () => editor()?.focus() : null, items: kit.inDocument(styleSetItems()) }));
    more.classList.add('ribbon-gallery-more');
    more.addEventListener('mousedown', e => e.preventDefault());
    for (const control of [themes, colors, fonts, effects]) when(control, () => engineReady() && editable());
    when(spacing, () => engineReady() && !!base.paragraphSpacingItems);
    when(setDefault, () => !!editor() && !!pkg() && !pkg().readOnly);
    when(more, () => { refreshGallery(); return engineReady() && editable(); });
    const watermark = menuButton('Watermark', 'watermark', watermarkItems, { text: 'Watermark' });
    const pageColor = menuButton('Page Color', 'pageColor', pageColorItems, { text: 'Page Color' });
    const pageBorders = menuButton('Page Borders', 'pageBorders', pageBorderItems, { text: 'Page Borders' });
    when(watermark, () => engineReady() && editable());
    when(pageColor, () => !!base.pageColorItems && engineReady());
    when(pageBorders, () => !!base.pageBorderItems && engineReady());
    refreshGallery();
    return [
      { id: 'formatting', replaces: 'formatting', label: 'Document Formatting', icon: 'themes', priority: 6,
        items: [themes, el('div.ribbon-gallery-frame', {}, gallery, more), colors, fonts, rows([spacing], [effects], [setDefault])] },
      { id: 'background', replaces: 'background', label: 'Page Background', icon: 'pageColor', priority: 5, items: [watermark, pageColor, pageBorders] },
    ];
  }
  /** Items for the menu bar's menus. */
  function extendMenu(menuId) {
    if (menuId === 'insert') return [{ label: 'Watermark…', icon: 'watermark', disabled: !editable(), onSelect: customWatermark }];
    if (menuId === 'format') return [
      { label: 'Theme', icon: 'themes', disabled: !editable(), items: themeItems() },
      { label: 'Background', icon: 'pageColor', disabled: !editable(), items: [...pageColorItems(), { separator: true }, { label: 'Watermark…', icon: 'watermark', onSelect: customWatermark }] },
    ];
    return [];
  }
  function contextMenuItems() { return []; }
  return { commands, extendTab, extendMenu, contextMenuItems, destroy() {} };
}
