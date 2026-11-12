// File → Automate → Create Batch Link, and the window a batch link opens.
// A browser cannot make an executable a file can be dropped on; a link (or
// bookmark) that opens Photo Studio with the action ready plays that role.
import './scripting.css';
import type { Editor } from '../../editor';
import { commands, findCommand } from '../../app/registry';
import { escapeXML } from '../../model/assets';
import { allActions, lastStopReason, playAction, type Action } from '../actions';
import { runProcessor, type Input } from '../files/automate';
import { formatInfo } from '../files/encode';
import { bytesBlob, formatBytes } from '../files/pipeline';
import { zipStore } from '../files/zip';
import { download } from '../../persistence/puter';
import { decodeBatchLink, encodeBatchLink, linkableCommand, type BatchLink } from './batch-link-core';

const label = (id: string) => commands.get(id)?.label.replace(/…$/, '') ?? id;
const appUrl = () => `${location.origin}${location.pathname}`;

export function createBatchLink(e: Editor): Promise<void> {
  const actions = allActions();
  const dialog = document.createElement('dialog');
  dialog.className = 'files-dialog batch-link';
  dialog.setAttribute('aria-label', 'Create Batch Link');
  dialog.innerHTML = `<form method="dialog">
    <h2>Create Batch Link</h2>
    <p class="muted">A link that opens Photo Studio ready to run an action on the photos you drop into it, and saves the results as a ZIP. Bookmark it, or share it: it holds the action's steps, not your files.</p>
    <label class="dialog-field">Action<select name="action" title="The recorded action the link runs">${actions.map(({ set, action }) => `<option value="${escapeXML(action.id)}">${escapeXML(`${set.name} › ${action.name}`)}</option>`).join('')}</select></label>
    <p class="batch-link-steps muted" aria-live="polite"></p>
    <div class="processor-row"><label class="dialog-field">Format<select name="format" title="File type of the results">${(['jpeg', 'png', 'webp', 'tiff'] as const).map((f) => `<option value="${f}">${formatInfo[f].label}</option>`).join('')}</select></label>
    <label class="dialog-field">Quality<input type="number" name="quality" min="1" max="100" value="85" title="JPEG and WebP quality"></label></div>
    <label class="dialog-field checkbox-field" title="Make results no larger than the size below (smaller photos stay as they are)">Resize to fit<input type="checkbox" name="resize"></label>
    <div class="processor-row"><label class="dialog-field">W (px)<input type="number" name="w" min="1" max="8192" value="1920" title="Largest width of the results"></label><label class="dialog-field">H (px)<input type="number" name="h" min="1" max="8192" value="1920" title="Largest height of the results"></label></div>
    <label class="dialog-field">Link<textarea name="link" rows="3" readonly aria-label="Batch link" title="The link to bookmark or share"></textarea></label>
    <div class="dialog-actions"><a class="button batch-link-open" target="_blank" rel="noopener" title="Open the link in a new tab, or drag it to the bookmarks bar">Open Link</a><button type="button" data-act="cancel">Close</button><button type="submit" class="primary" title="Copy the link to the clipboard">Copy Link</button></div>
  </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form')!;
  const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const steps = dialog.querySelector<HTMLElement>('.batch-link-steps')!;
  const open = dialog.querySelector<HTMLAnchorElement>('.batch-link-open')!;
  const copy = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  let url = '';
  const build = () => {
    const action = actions.find((a) => a.action.id === field('action').value)?.action;
    url = '';
    if (!action) {
      steps.textContent = 'Record an action in the Actions panel first.';
    } else {
      const used = action.steps.filter((s) => s.enabled);
      const blocked = used.filter((s) => !linkableCommand(s.command));
      if (!used.length) steps.textContent = 'This action has no steps.';
      else if (blocked.length) steps.textContent = `Links cannot run ${blocked.map((s) => `“${label(s.command)}”`).join(', ')}. Choose another action or remove those steps.`;
      else {
        steps.textContent = `Steps: ${used.map((s) => label(s.command)).join(' → ')}`;
        try {
          const link: BatchLink = {
            v: 1,
            name: action.name,
            steps: used.map((s) => (s.arg === undefined ? { command: s.command } : { command: s.command, arg: s.arg })),
            format: field('format').value as BatchLink['format'],
            quality: Math.max(1, Math.min(100, Math.round(Number(field('quality').value) || 85))),
            fit: field('resize').checked ? { width: Math.max(1, Math.min(8192, Math.round(Number(field('w').value) || 1920))), height: Math.max(1, Math.min(8192, Math.round(Number(field('h').value) || 1920))) } : undefined,
          };
          url = appUrl() + encodeBatchLink(link);
        } catch (error) {
          steps.textContent = error instanceof Error ? error.message : String(error);
        }
      }
    }
    field('link').value = url;
    open.toggleAttribute('hidden', !url);
    if (url) open.href = url;
    copy.disabled = !url;
  };
  build();
  form.addEventListener('input', build);
  form.addEventListener('change', build);
  return new Promise((resolve) => {
    const close = () => {
      dialog.close();
      dialog.remove();
      resolve();
    };
    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      close();
    });
    dialog.querySelector('[data-act="cancel"]')!.addEventListener('click', close);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!url) return;
      void navigator.clipboard
        .writeText(url)
        .then(() => e.message('Batch link copied.'))
        .catch(() => {
          field('link').select();
          e.message('Select the link and copy it.');
        });
    });
    dialog.showModal();
  });
}

/** The window a batch link opens: drop photos, run, download the results. */
export function openBatchLink(e: Editor, hash: string): Promise<void> {
  let link: BatchLink;
  try {
    link = decodeBatchLink(hash, (id) => !!findCommand(id));
  } catch (error) {
    e.message(error instanceof Error ? error.message : String(error));
    return Promise.resolve();
  }
  const inputs: Input[] = [];
  const dialog = document.createElement('dialog');
  dialog.className = 'files-dialog files-processor batch-link-run';
  dialog.setAttribute('aria-label', `Batch: ${link.name}`);
  dialog.innerHTML = `<form method="dialog">
    <h2>Batch: ${escapeXML(link.name)}</h2>
    <p class="muted">This link runs these steps on the photos you add, then saves the results as ${formatInfo[link.format].label} files in a ZIP${link.fit ? `, fitted within ${link.fit.width} × ${link.fit.height} px` : ''}:</p>
    <ol class="batch-link-list">${link.steps.map((s) => `<li>${escapeXML(label(s.command))}</li>`).join('')}</ol>
    <div class="batch-drop" tabindex="0" role="button" title="Drop photos here, or click to choose them">Drop photos here, or click to choose them</div>
    <ul class="processor-list" aria-label="Photos to process"></ul>
    <p class="processor-status" aria-live="polite"></p>
    <div class="dialog-actions"><button type="button" data-act="cancel">Close</button><button type="submit" class="primary" disabled>Run</button></div>
  </form>`;
  document.body.append(dialog);
  const list = dialog.querySelector<HTMLElement>('.processor-list')!;
  const status = dialog.querySelector<HTMLElement>('.processor-status')!;
  const run = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const drop = dialog.querySelector<HTMLElement>('.batch-drop')!;
  const render = () => {
    list.innerHTML = inputs.map((x) => `<li>${escapeXML(x.name)}</li>`).join('');
    run.disabled = !inputs.length;
    status.textContent = inputs.length ? `${inputs.length} photo${inputs.length > 1 ? 's' : ''}` : '';
  };
  const add = (files: File[]) => {
    inputs.push(...files.filter((f) => f.size).map((f) => ({ name: f.name, blob: f })));
    render();
  };
  const choose = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = e.el<HTMLInputElement>('#file-input').accept;
    input.onchange = () => add(Array.from(input.files ?? []));
    input.click();
  };
  drop.addEventListener('click', choose);
  drop.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      choose();
    }
  });
  dialog.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    drop.classList.add('dragover');
  });
  dialog.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  dialog.addEventListener('drop', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    drop.classList.remove('dragover');
    add(Array.from(ev.dataTransfer?.files ?? []));
  });
  return new Promise((resolve) => {
    let cancelled = false;
    let running = false;
    const close = () => {
      cancelled = true;
      dialog.close();
      dialog.remove();
      resolve();
    };
    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      close();
    });
    dialog.querySelector('[data-act="cancel"]')!.addEventListener('click', close);
    dialog.querySelector('form')!.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (running || !inputs.length) return;
      running = true;
      run.disabled = true;
      const action: Action = { id: 'batch-link', name: link.name, steps: link.steps.map((s) => ({ command: s.command, arg: s.arg, enabled: true, dialog: false })) };
      const step = {
        id: 'batch-link',
        label: link.name,
        document: async (ed: Editor) => {
          if (!(await playAction(ed, action))) throw new Error(`The action “${link.name}” stopped${lastStopReason() ? `: ${lastStopReason()}` : '.'}`);
        },
      };
      const opts = { resize: !!link.fit, w: link.fit?.width ?? 0, h: link.fit?.height ?? 0, enlarge: false, format: link.format, quality: link.quality, srgb: true, steps: [step] };
      void e
        .run(async () => {
          const files = await runProcessor(e, inputs, opts, (text) => (status.textContent = text), () => cancelled);
          if (cancelled || !files.length) return;
          const zip = zipStore(files.map((f) => ({ name: f.name, data: f.bytes })));
          download(bytesBlob(zip, 'application/zip'), `${link.name.replace(/[\\/:*?"<>|]+/g, '_')}.zip`);
          status.textContent = `Saved ${files.length} file${files.length > 1 ? 's' : ''} (${formatBytes(zip.length)}). Drop more photos to run again.`;
        })
        .finally(() => {
          running = false;
          inputs.length = 0;
          list.innerHTML = '';
          run.disabled = true;
        });
    });
    dialog.showModal();
  });
}
