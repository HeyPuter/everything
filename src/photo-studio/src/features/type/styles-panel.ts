// Character Styles and Paragraph Styles panels. Styles live in the document
// (doc.textStyles, saved with the project and undoable); clicking a style
// applies it to the text being edited, the selected text layers, or the
// defaults for new text. A "+" marks text that overrides its style.
import type { Editor } from '../../editor';
import { registerCommand, registerPanel, type Panel } from '../../app/registry';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { allLayers, type Layer, type PhotoDocument } from '../../model/document';
import { formDialog } from '../../ui/dialog';
import { textLength, type CharStyle, type ParagraphStyle, type TextContent } from '../../imaging/text/model';
import {
  applyParagraphStyleDef,
  characterStyleState,
  clearOverrides,
  paragraphStyleState,
  restyleContent,
  styleAttributes,
  unlinkStyle,
  usesStyle,
  type CharacterStyleDef,
  type ParagraphStyleDef,
  type TextStyles,
} from '../../imaging/text/styles';
import { applyChar, editLayers, focusInput, onSessionChange, ordered, session, styleContext, typeDefaults, updateData } from './session';
import { editable, ppiOf } from './text-utils';
import './type-panels.css';

type Kind = 'character' | 'paragraph';
export const textStylesOf = (doc: PhotoDocument): TextStyles => doc.textStyles ?? { character: [], paragraph: [] };
const listOf = (doc: PhotoDocument, kind: Kind) => (kind === 'character' ? textStylesOf(doc).character : textStylesOf(doc).paragraph) as (CharacterStyleDef | ParagraphStyleDef)[];
const label = (kind: Kind) => (kind === 'character' ? 'Character Style' : 'Paragraph Style');

/** What the panels act on: the selection while editing, else whole selected text layers. */
function target(e: Editor): { content: TextContent; a: number; b: number } | undefined {
  const s = session;
  if (s) {
    const [a, b] = ordered(s);
    return { content: s.data.content, a, b };
  }
  const l = e.layer;
  if (l?.kind !== 'text') return;
  const d = editable(l, ppiOf(e)).textData;
  return { content: d.content, a: 0, b: textLength(d.content) };
}
function currentState(e: Editor, kind: Kind) {
  const t = target(e);
  const styles = textStylesOf(e.doc);
  if (!t) {
    const d = typeDefaults(e);
    return { id: (kind === 'character' ? d.style.charStyle : d.paragraph.paragraphStyle) || undefined, mixed: false, overridden: false };
  }
  return kind === 'character' ? characterStyleState(t.content, t.a, t.b, styles) : paragraphStyleState(t.content, t.a, t.b, styles);
}

async function applyStyle(e: Editor, kind: Kind, id: string | null) {
  const styles = textStylesOf(e.doc);
  if (kind === 'character') {
    const def = id ? styles.character.find((d) => d.id === id) : null;
    if (id && !def) return;
    await applyChar(e, def ? { ...def.style, charStyle: def.id } : { charStyle: '' });
  } else {
    const def = id ? styles.paragraph.find((d) => d.id === id) ?? null : null;
    if (id && !def) return;
    const s = session;
    if (s) {
      const [a, b] = ordered(s);
      updateData(e, (d) => ({ ...d, content: applyParagraphStyleDef(d.content, a, b, def) }), 'paragraph');
    } else if (e.selectedLayers.some((l) => l.kind === 'text')) await editLayers(e, 'Apply Paragraph Style', (d) => ({ ...d, content: applyParagraphStyleDef(d.content, 0, textLength(d.content), def) }));
    else {
      const d = typeDefaults(e);
      d.paragraph = { ...d.paragraph, ...(def?.paragraph ?? {}), paragraphStyle: def?.id ?? '' };
      if (def) d.style = { ...d.style, ...def.char };
    }
  }
  if (session) focusInput(e);
  e.dock.update();
}

/** Attributes of the current selection, for a new or redefined style. */
export function captureAttributes(e: Editor, kind: Kind) {
  const c = styleContext(e);
  const char = styleAttributes<CharStyle>(c.char);
  return kind === 'character' ? { style: char } : { paragraph: styleAttributes<ParagraphStyle>(c.paragraph), char };
}

/** Add a style from elsewhere (a library) to the document, replacing a
 * same-named one (which keeps its ID so linked text follows), then apply it
 * like a click in the panel. Returns the document's style ID. */
export async function applyExternalTextStyle(e: Editor, kind: Kind, def: CharacterStyleDef | ParagraphStyleDef): Promise<string> {
  const existing = listOf(e.doc, kind).find((d) => d.name === def.name);
  const id = existing?.id ?? crypto.randomUUID();
  const next = { ...structuredClone(def), id };
  if (JSON.stringify(existing) !== JSON.stringify(next))
    e.command(`Add ${label(kind)}`, (d) => {
      const ts = (d.textStyles ??= { character: [], paragraph: [] });
      const list = (kind === 'character' ? ts.character : ts.paragraph) as (CharacterStyleDef | ParagraphStyleDef)[];
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list[i] = next;
      else list.push(next);
    });
  await applyStyle(e, kind, id);
  return id;
}

// Text layers whose content links to a style.
function layersUsing(doc: PhotoDocument, kind: Kind, id: string, ppi: number): Layer[] {
  return allLayers(doc.layers).filter((l) => l.kind === 'text' && l.textData && usesStyle(editable(l, ppi).textData.content, kind, id));
}

export function installTextStyles(e: Editor) {
  const panel = (kind: Kind): Panel => ({
    id: `${kind}-styles`,
    title: kind === 'character' ? 'Character Styles' : 'Paragraph Styles',
    icon: kind === 'character' ? 'text-style-char' : 'text-style-para',
    location: 'strip',
    hidden: true,
    mount: (e, el) => {
      el.classList.add('text-styles-panel');
      el.innerHTML = `<div class="ts-list" role="listbox" aria-label="${label(kind)}s"></div>
<div class="ts-footer"><span class="ts-note"></span><button type="button" class="icon-button" data-ts="clear" title="Clear Override" aria-label="Clear override">${svg('eraser', 15)}</button><button type="button" class="icon-button" data-ts="redefine" title="Redefine style from the selection" aria-label="Redefine style">${svg('refresh-cw', 15)}</button><button type="button" class="icon-button" data-ts="new" title="New ${label(kind)} from the selection" aria-label="New ${label(kind).toLowerCase()}">${svg('plus', 15)}</button><button type="button" class="icon-button" data-ts="delete" title="Delete ${label(kind)}" aria-label="Delete ${label(kind).toLowerCase()}">${svg('trash-2', 15)}</button></div>`;
      el.addEventListener('click', (ev) => {
        const t = ev.target as HTMLElement;
        const row = t.closest<HTMLElement>('[data-style-id]');
        if (row) {
          void applyStyle(e, kind, row.dataset.styleId || null);
          return;
        }
        const act = t.closest<HTMLElement>('[data-ts]')?.dataset.ts;
        if (act === 'new') void e.runCommand(`text-style.new-${kind}`, captureAttributes(e, kind));
        else if (act === 'redefine') void e.runCommand(`text-style.redefine-${kind}`, captureAttributes(e, kind));
        else if (act === 'clear') void clearOverride(e, kind);
        else if (act === 'delete') void e.runCommand(`text-style.delete-${kind}`);
      });
      el.addEventListener('dblclick', (ev) => {
        const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-style-id]');
        if (row?.dataset.styleId) void e.runCommand(`text-style.rename-${kind}`, row.dataset.styleId);
      });
      el.addEventListener('keydown', (ev) => {
        const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-style-id]');
        if (row && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault();
          row.click();
        }
      });
    },
    update: (e, el) => render(e, el, kind),
    menu: () => [`text-style.new-${kind}`, `text-style.redefine-${kind}`, `text-style.clear-${kind}`, `text-style.rename-${kind}`, `text-style.delete-${kind}`, '-', 'type.load-default-styles', 'type.save-default-styles'],
  });
  const panels = [panel('character'), panel('paragraph')];
  registerPanel(...panels);
  onSessionChange(() => {
    for (const p of panels) {
      const el = document.getElementById(`panel-${p.id}`);
      if (el?.isConnected) p.update!(e, el);
    }
  });

  for (const kind of ['character', 'paragraph'] as Kind[]) {
    const L = label(kind);
    registerCommand(
      {
        id: `text-style.new-${kind}`,
        label: `New ${L}…`,
        recordable: false,
        enabled: (e) => e.hasDocument,
        run: async (e, arg) => {
          const attrs = (arg as ReturnType<typeof captureAttributes> | undefined) ?? captureAttributes(e, kind);
          const list = listOf(e.doc, kind);
          let n = list.length + 1;
          while (list.some((d) => d.name === `${L} ${n}`)) n++;
          const v = await formDialog(`New ${L}`, [{ name: 'name', label: 'Style Name', value: `${L} ${n}` }], 'OK', 'The style records the attributes of the selected text.');
          if (!v?.name.trim()) return;
          const def = { id: crypto.randomUUID(), name: v.name.trim(), ...attrs } as unknown as CharacterStyleDef & ParagraphStyleDef;
          e.command(`New ${L}`, (d) => {
            const ts = (d.textStyles ??= { character: [], paragraph: [] });
            (kind === 'character' ? ts.character : ts.paragraph).push(structuredClone(def));
          });
          e.dock.update();
        },
      },
      {
        id: `text-style.redefine-${kind}`,
        label: `Redefine ${L}`,
        recordable: false,
        enabled: (e) => !!currentState(e, kind).id,
        description: 'Update the style from the selected text; linked text everywhere follows.',
        run: async (e, arg) => {
          const id = currentState(e, kind).id;
          const old = listOf(e.doc, kind).find((d) => d.id === id);
          if (!id || !old) return;
          const attrs = (arg as ReturnType<typeof captureAttributes> | undefined) ?? captureAttributes(e, kind);
          const next = { ...old, ...attrs } as unknown as CharacterStyleDef & ParagraphStyleDef;
          const ppi = ppiOf(e);
          const ids = layersUsing(e.doc, kind, id, ppi).map((l) => l.id);
          const before = kind === 'character' ? (old as CharacterStyleDef).style : old;
          const after = kind === 'character' ? next.style : next;
          await editLayers(e, `Redefine ${L}`, (d) => ({ ...d, content: restyleContent(d.content, kind, before as never, after as never, id) }), ids.length ? ids : ['\0none'], (d) => {
            const list = kind === 'character' ? d.textStyles!.character : d.textStyles!.paragraph;
            const i = list.findIndex((x) => x.id === id);
            if (i >= 0) list[i] = structuredClone(next);
          });
          e.dock.update();
        },
      },
      {
        id: `text-style.clear-${kind}`,
        label: 'Clear Override',
        recordable: false,
        enabled: (e) => currentState(e, kind).overridden,
        run: (e) => clearOverride(e, kind),
      },
      {
        id: `text-style.rename-${kind}`,
        label: `Rename ${L}…`,
        recordable: false,
        enabled: (e) => !!currentState(e, kind).id,
        run: async (e, arg) => {
          const id = typeof arg === 'string' ? arg : currentState(e, kind).id;
          const def = listOf(e.doc, kind).find((d) => d.id === id);
          if (!def) return;
          const v = await formDialog(`Rename ${L}`, [{ name: 'name', label: 'Style Name', value: def.name }], 'OK');
          if (!v?.name.trim() || v.name.trim() === def.name) return;
          e.command(`Rename ${L}`, (d) => {
            const x = listOf(d, kind).find((s) => s.id === id);
            if (x) x.name = v.name.trim();
          });
          e.dock.update();
        },
      },
      {
        id: `text-style.delete-${kind}`,
        label: `Delete ${L}`,
        recordable: false,
        enabled: (e) => !!currentState(e, kind).id,
        run: async (e) => {
          const id = currentState(e, kind).id;
          if (!id) return;
          const ppi = ppiOf(e);
          const ids = layersUsing(e.doc, kind, id, ppi).map((l) => l.id);
          // Linked text keeps its attributes and loses the link.
          await editLayers(e, `Delete ${L}`, (d) => ({ ...d, content: unlinkStyle(d.content, kind, id) }), ids.length ? ids : ['\0none'], (d) => {
            const ts = d.textStyles!;
            if (kind === 'character') ts.character = ts.character.filter((x) => x.id !== id);
            else ts.paragraph = ts.paragraph.filter((x) => x.id !== id);
          });
          const t = typeDefaults(e);
          if (t.style.charStyle === id) t.style = { ...t.style, charStyle: '' };
          if (t.paragraph.paragraphStyle === id) t.paragraph = { ...t.paragraph, paragraphStyle: '' };
          e.dock.update();
        },
      },
    );
  }
  installDefaultTypeStyles();
}

async function clearOverride(e: Editor, kind: Kind) {
  const styles = textStylesOf(e.doc);
  const s = session;
  if (s) {
    const [a, b] = ordered(s);
    updateData(e, (d) => ({ ...d, content: clearOverrides(d.content, a, b, styles, kind) }), 'style');
    focusInput(e);
  } else if (e.selectedLayers.some((l) => l.kind === 'text')) await editLayers(e, 'Clear Override', (d) => ({ ...d, content: clearOverrides(d.content, 0, textLength(d.content), styles, kind) }));
  e.dock.update();
}

function render(e: Editor, el: HTMLElement, kind: Kind) {
  const list = listOf(e.doc, kind);
  const st = currentState(e, kind);
  const preview = (d: CharacterStyleDef | ParagraphStyleDef) => {
    const c = 'style' in d ? d.style : d.char;
    const css = [c.family ? `font-family:&quot;${escapeXML(c.family)}&quot;, sans-serif` : '', c.weight ? `font-weight:${c.weight}` : '', c.italic ? 'font-style:italic' : ''].filter(Boolean).join(';');
    return css;
  };
  const row = (id: string, name: string, css = '') => {
    const on = !st.mixed && (st.id ?? '') === id;
    return `<div class="ts-row" role="option" tabindex="0" data-style-id="${escapeXML(id)}" aria-selected="${on}"><span class="ts-name" style="${css}">${escapeXML(name)}</span>${on && st.overridden ? '<span class="ts-override" title="The selection overrides this style">+</span>' : ''}</div>`;
  };
  el.querySelector('.ts-list')!.innerHTML = row('', `[No ${kind === 'character' ? 'Character' : 'Paragraph'} Style]`) + list.map((d) => row(d.id, d.name, preview(d))).join('');
  el.querySelector('.ts-note')!.textContent = st.mixed ? 'Mixed styles' : session ? 'Selection' : e.layer?.kind === 'text' ? 'Selected layer' : 'New text';
  const enable = (k: string, on: boolean) => ((el.querySelector(`[data-ts="${k}"]`) as HTMLButtonElement).disabled = !on);
  enable('clear', st.overridden);
  enable('redefine', !!st.id);
  enable('delete', !!st.id);
  enable('new', e.hasDocument);
}

// ----- Default type styles: kept in this browser, loaded into any document -----
const defaultsKey = 'photo-studio-default-type-styles';
function installDefaultTypeStyles() {
  registerCommand(
    {
      id: 'type.save-default-styles',
      label: 'Save Default Type Styles',
      recordable: false,
      enabled: (e) => e.hasDocument && (textStylesOf(e.doc).character.length + textStylesOf(e.doc).paragraph.length > 0),
      description: 'Keep this document’s character and paragraph styles as the defaults.',
      run: (e) => {
        try {
          localStorage.setItem(defaultsKey, JSON.stringify(textStylesOf(e.doc)));
          e.message('Saved the character and paragraph styles as default type styles.');
        } catch {
          e.message('Could not save the default type styles in this browser.');
        }
      },
    },
    {
      id: 'type.load-default-styles',
      label: 'Load Default Type Styles',
      recordable: false,
      enabled: (e) => e.hasDocument && !!savedDefaults(),
      description: 'Add the saved default styles to this document (styles with the same name are replaced).',
      run: (e) => {
        const saved = savedDefaults();
        if (!saved) return;
        e.command('Load Default Type Styles', (d) => {
          const ts = (d.textStyles ??= { character: [], paragraph: [] });
          const merge = <T extends { id: string; name: string }>(into: T[], add: T[]) => {
            for (const s of add) {
              const i = into.findIndex((x) => x.name === s.name);
              // A same-named style keeps its ID so linked text follows the new definition.
              if (i >= 0) into[i] = { ...structuredClone(s), id: into[i].id };
              else into.push(structuredClone(s));
            }
          };
          merge(ts.character, saved.character);
          merge(ts.paragraph, saved.paragraph);
        });
        e.dock.update();
      },
    },
  );
}
function savedDefaults(): TextStyles | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(defaultsKey) ?? 'null');
    return v && Array.isArray(v.character) && Array.isArray(v.paragraph) ? v : undefined;
  } catch {
    return undefined;
  }
}
