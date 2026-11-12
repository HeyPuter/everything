// Edit → Preferences: a settings window with a page list, search across every
// setting and live changes (Cancel restores the values from when it opened).
import type { Editor } from '../../editor';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { download } from '../../persistence/puter';
import {
  coerceSetting,
  defaultPreferences,
  exportPreferences,
  importPreferences,
  PAGES,
  searchSettings,
  SETTINGS,
  settingFor,
  type PageId,
  type Preferences,
  type SettingDef,
} from '../../model/preferences';
import { colorSettings, saveColorSettings, type ColorSettings } from '../color/profiles';
import { memorySection } from '../workspace/system-info';
import { keepFocus } from '../../ui/keep-focus';

let lastPage: PageId = 'general';
const RESTART_NOTE = 'Reload Photo Studio for this change to take effect.';

// Rows disabled until another setting allows them.
const dependsOn: Partial<Record<string, (p: Preferences) => boolean>> = {
  richTooltips: (p) => p.showTooltips,
  checkerCustomA: (p) => p.checkerColors === 'custom' && p.checkerSize !== 'none',
  checkerCustomB: (p) => p.checkerColors === 'custom' && p.checkerSize !== 'none',
  checkerColors: (p) => p.checkerSize !== 'none',
  paintCrosshair: (p) => p.paintCursor === 'normal' || p.paintCursor === 'full',
  versionsPerDocument: (p) => p.versionsOnSave,
};

export function openPreferences(e: Editor, page?: PageId) {
  e.root.querySelector('dialog.prefs-window')?.remove();
  const before = structuredClone(e.preferences);
  const colorBefore: ColorSettings = { ...colorSettings() };
  let current: PageId = page ?? lastPage;
  let query = '';
  let restartNeeded = false;
  const d = document.createElement('dialog');
  d.className = 'prefs-window';
  d.setAttribute('aria-labelledby', 'prefs-title');
  d.innerHTML = `<div class="prefs-head"><h2 id="prefs-title">Preferences</h2><label class="prefs-search">${svg('search', 14)}<input type="search" placeholder="Search settings" aria-label="Search settings" autocomplete="off" spellcheck="false"></label></div>
<div class="prefs-body"><nav class="prefs-nav" aria-label="Preference pages">${PAGES.map((p) => `<button type="button" data-page="${p.id}">${svg(p.icon, 16)}<span>${escapeXML(p.label)}</span></button>`).join('')}</nav><div class="prefs-content" role="region" aria-live="polite"></div></div>
<div class="prefs-foot"><button type="button" data-act="import">${svg('upload', 14)}Import…</button><button type="button" data-act="export">${svg('download', 14)}Export…</button><button type="button" data-act="defaults">Restore Page Defaults</button><span class="spacer"></span><button type="button" data-act="cancel">Cancel</button><button type="button" class="primary" data-act="done">Done</button></div>`;
  e.root.append(d);
  const content = d.querySelector<HTMLElement>('.prefs-content')!;
  const search = d.querySelector<HTMLInputElement>('.prefs-search input')!;

  const changed = () => e.preferencesChanged();
  const set = (key: string, raw: unknown) => {
    const def = settingFor(key);
    if (!def) return;
    const v = coerceSetting(def, raw);
    if (v === undefined) return;
    (e.preferences as Record<string, unknown>)[key] = v;
    if (def.restart && v !== (before as Record<string, unknown>)[key]) restartNeeded = true;
    changed();
    // The page redraws; the control just changed from the keyboard keeps the focus.
    keepFocus(content, render);
  };

  function control(s: SettingDef): string {
    const p = e.preferences as Record<string, unknown>;
    const id = `pref-${s.page}-${s.key ?? s.id}`;
    const disabled = s.key && dependsOn[s.key] && !dependsOn[s.key]!(e.preferences) ? 'disabled' : '';
    switch (s.type) {
      case 'boolean':
        return `<label class="prefs-switch"><input type="checkbox" id="${id}" data-key="${s.key}" ${p[s.key] ? 'checked' : ''} ${disabled}><span></span></label>`;
      case 'number':
        return `<input type="number" id="${id}" data-key="${s.key}" value="${p[s.key]}" min="${s.min}" max="${s.max}" step="${s.step ?? (s.integer ? 1 : 'any')}" ${disabled}>${s.unit ? `<span class="unit">${escapeXML(s.unit)}</span>` : ''}`;
      case 'choice':
        return `<select id="${id}" data-key="${s.key}" ${disabled}>${s.options.map(([v, l]) => `<option value="${escapeXML(String(v))}" ${String(p[s.key]) === String(v) ? 'selected' : ''}>${escapeXML(l)}</option>`).join('')}</select>`;
      case 'color':
        return `<input type="color" id="${id}" data-key="${s.key}" value="${p[s.key]}" ${disabled}>`;
      case 'color-choice': {
        const v = String(p[s.key]);
        const custom = v.startsWith('#');
        return `<select id="${id}" data-key="${s.key}" data-color-choice ${disabled}>${s.options.map(([o, l]) => `<option value="${o}" ${v === o ? 'selected' : ''}>${escapeXML(l)}</option>`).join('')}<option value="custom" ${custom ? 'selected' : ''}>Custom…</option></select><input type="color" data-key="${s.key}" data-custom-color value="${custom ? v : '#3a3a3a'}" aria-label="${escapeXML(s.label)} custom color" ${custom ? '' : 'hidden'}>`;
      }
      case 'action':
        return `<button type="button" class="secondary" data-action="${s.id}">${escapeXML(s.button)}</button>`;
      case 'info':
        return '';
    }
  }
  function info(s: Extract<SettingDef, { type: 'info' }>): string {
    if (s.id === 'memory') {
      const rows = memorySection(e).rows;
      return `<dl class="prefs-info">${rows.map(([k, v]) => `<dt>${escapeXML(k)}</dt><dd>${escapeXML(v)}</dd>`).join('')}<dt>Browser storage</dt><dd data-storage>Measuring…</dd></dl>`;
    }
    if (s.id === 'gamut') {
      const c = colorSettings();
      return `<div class="prefs-control" style="justify-content:flex-start"><label>Color <input type="color" data-gamut="color" value="${c.gamutColor}"></label><label>Opacity <input type="number" data-gamut="opacity" min="0" max="100" step="1" value="${c.gamutOpacity}"><span class="unit">%</span></label></div>`;
    }
    return '';
  }
  function row(s: SettingDef, showPage: boolean): string {
    const page = PAGES.find((p) => p.id === s.page)!;
    const label = `<div class="prefs-label">${showPage ? `<span class="prefs-page-tag">${escapeXML(page.label)}</span>` : ''}<span>${s.key || s.type === 'action' ? `<label for="pref-${s.page}-${s.key ?? s.id}">${escapeXML(s.label)}</label>` : escapeXML(s.label)}${s.restart ? '<span class="prefs-restart">Reload</span>' : ''}</span>${s.help ? `<small>${escapeXML(s.help)}</small>` : ''}</div>`;
    if (s.type === 'info') return `<div class="prefs-row wide">${label}${info(s)}</div>`;
    return `<div class="prefs-row">${label}<div class="prefs-control">${control(s)}</div></div>`;
  }
  function render() {
    const scroll = content.scrollTop;
    d.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((b) => b.setAttribute('aria-current', !query && b.dataset.page === current ? 'page' : 'false'));
    d.querySelector<HTMLButtonElement>('[data-act="defaults"]')!.textContent = query ? 'Restore Defaults for Results' : 'Restore Page Defaults';
    let html = '';
    if (query) {
      const hits = searchSettings(query);
      html = `<h3>Results for “${escapeXML(query)}”</h3>${hits.length ? `<div class="prefs-section">${hits.map((s) => row(s, true)).join('')}</div>` : '<p class="prefs-empty">No settings match.</p>'}`;
    } else {
      const page = PAGES.find((p) => p.id === current)!;
      const list = SETTINGS.filter((s) => s.page === current);
      const sections = [...new Set(list.map((s) => s.section))];
      html = `<h3>${escapeXML(page.label)}</h3>${sections.map((sec) => `<section class="prefs-section"><h4>${escapeXML(sec)}</h4>${list.filter((s) => s.section === sec).map((s) => row(s, false)).join('')}</section>`).join('')}`;
    }
    if (restartNeeded) html += `<p class="prefs-notice">${RESTART_NOTE} <button type="button" class="secondary" data-action="reload">Reload now</button></p>`;
    content.innerHTML = html;
    content.scrollTop = scroll;
    const storage = content.querySelector<HTMLElement>('[data-storage]');
    if (storage)
      void navigator.storage
        ?.estimate?.()
        .then((est) => (storage.textContent = est.usage !== undefined ? `${(est.usage / 1048576).toFixed(1)} MB used${est.quota ? ` of ${(est.quota / 1073741824).toFixed(1)} GB available` : ''}` : 'Unknown'))
        .catch(() => (storage.textContent = 'Unknown'));
  }

  d.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const pageBtn = t.closest<HTMLElement>('[data-page]');
    if (pageBtn) {
      current = pageBtn.dataset.page as PageId;
      lastPage = current;
      query = '';
      search.value = '';
      content.scrollTop = 0;
      render();
      return;
    }
    const action = t.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'reset-warnings') {
      const n = e.preferences.dismissedWarnings.length;
      e.preferences.dismissedWarnings = [];
      changed();
      e.message(n ? `${n} warning${n === 1 ? '' : 's'} will be shown again.` : 'No warnings were turned off.');
      return;
    }
    if (action === 'reload') {
      close(true);
      location.reload();
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'done') close(true);
    else if (act === 'cancel') close(false);
    else if (act === 'defaults') {
      // Restores the shown page, or the settings matching the search.
      const defaults = defaultPreferences() as Record<string, unknown>;
      const shown = query ? searchSettings(query) : SETTINGS.filter((s) => s.page === current);
      for (const s of shown) if (s.key) (e.preferences as Record<string, unknown>)[s.key] = defaults[s.key];
      if (shown.some((s) => s.type === 'info' && s.id === 'gamut')) saveColorSettings({ ...colorSettings(), gamutColor: '#808080', gamutOpacity: 100 });
      changed();
      render();
    } else if (act === 'export') {
      download(new Blob([exportPreferences(e.preferences)], { type: 'application/json' }), 'Photo Studio Preferences.json');
    } else if (act === 'import') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const { preferences, ignored } = importPreferences(await file.text(), e.preferences);
          Object.assign(e.preferences, preferences);
          if (preferences.gpuBackend !== before.gpuBackend) restartNeeded = true;
          changed();
          render();
          e.message(ignored.length ? `Preferences imported; ${ignored.length} unknown or invalid ${ignored.length === 1 ? 'entry was' : 'entries were'} skipped.` : 'Preferences imported.');
        } catch (error) {
          e.message(error instanceof Error ? error.message : String(error));
        }
      };
      input.click();
    }
  });
  d.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement | HTMLSelectElement;
    const gamut = t.dataset.gamut;
    if (gamut) {
      const c = colorSettings();
      if (gamut === 'color' && /^#[0-9a-f]{6}$/i.test(t.value)) saveColorSettings({ ...c, gamutColor: t.value });
      if (gamut === 'opacity') saveColorSettings({ ...c, gamutOpacity: Math.max(0, Math.min(100, Math.round(Number(t.value) || 0))) });
      e.update();
      return;
    }
    const key = t.dataset.key;
    if (!key) return;
    if ('colorChoice' in t.dataset) {
      if (t.value === 'custom') {
        const picker = t.parentElement!.querySelector<HTMLInputElement>('[data-custom-color]')!;
        set(key, picker.value);
      } else set(key, t.value);
      return;
    }
    if (t instanceof HTMLInputElement && t.type === 'checkbox') set(key, t.checked);
    else set(key, t.value);
  });
  // Colors apply while the picker is dragged.
  d.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.type !== 'color' || !t.dataset.key) return;
    (e.preferences as Record<string, unknown>)[t.dataset.key] = t.value.toLowerCase();
    e.preferencesChanged();
  });
  search.addEventListener('input', () => {
    query = search.value.trim();
    render();
  });
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && search.value) {
      ev.preventDefault();
      ev.stopPropagation();
      search.value = '';
      query = '';
      render();
    }
  });
  d.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    close(false);
  });
  function close(keep: boolean) {
    if (!keep) {
      for (const k of Object.keys(e.preferences)) if (!(k in before)) delete (e.preferences as Record<string, unknown>)[k];
      Object.assign(e.preferences, before);
      saveColorSettings(colorBefore);
      changed();
    }
    d.close();
    d.remove();
  }
  render();
  d.showModal();
  search.focus();
  return d;
}
