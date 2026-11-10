/**
 * Page Layout ▸ Themes ▸ Effects: the gallery of effect schemes. Each tile shows the scheme's subtle,
 * moderate and intense effects on three accent swatches; a pick applies it as one undoable step, and every
 * text box, WordArt and equation that uses a theme effect is drawn again with it.
 */
import { el } from './dom.js';
import { openMenu } from './menu.js';
import { applyWorkbookTheme, workbookTheme } from '../core/workbook-theme.js';
import { EFFECT_SCHEMES, EFFECT_LEVELS, themeEffectCss } from '../core/theme-effects.js';
import { schemeLabel } from './themes.js';
import { t } from '../i18n/index.js';

export function openThemeEffectsMenu(ctx, anchor) {
  if (ctx.grid?.editing && !ctx.grid.commitEdit?.()) return null;
  const theme = workbookTheme(ctx.wb);
  const tile = scheme => {
    const checked = theme.effectsName === scheme.name;
    return el('button.effects-tile', {
      type: 'button', role: 'menuitemradio', 'aria-checked': String(checked), tabindex: -1,
      'aria-label': t('themeEffects.tile', { name: schemeLabel(scheme.name) }), title: schemeLabel(scheme.name),
      onclick: () => { menu.close(); if (applyWorkbookTheme(ctx.wb, { effects: scheme.name }, t('themeEffects.undo', { name: schemeLabel(scheme.name) }))) ctx.grid?.focus?.(); },
    },
    el('span.effects-sample', { 'aria-hidden': 'true' }, ...[0, 1, 2].map(i => el('span', {
      title: EFFECT_LEVELS[i],
      style: { background: theme.colors[4 + i], ...themeEffectCss(scheme, i + 1, theme.colors[4 + i], { filled: true }) },
    }))),
    el('span.effects-name', {}, schemeLabel(scheme.name)));
  };
  const grid = el('div.effects-gallery', { role: 'group', 'aria-label': t('themeEffects.effects'), 'data-cols': 3 }, ...EFFECT_SCHEMES.map(tile));
  const menu = openMenu({ anchor, label: t('themeEffects.effects'), minWidth: 300, items: [{ header: t('themes.builtIn') }, { custom: grid }],
    onClose: reason => { if (reason === 'select') ctx.grid?.focus?.(); } });
  (grid.querySelector('[aria-checked="true"]') || grid.querySelector('button'))?.focus();
  return menu;
}
