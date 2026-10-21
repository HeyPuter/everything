// File and folder browse operators for path fields: pick a file (or folder) and write its name
// into the text property under the pointer ("//" prefix: relative to the project).
import { app, registerOperators } from '../app/app';
import { targetButton } from './buttons';
import type { PropBinding } from './binding';
import { pickFile } from '../io/native';

const pathTarget = (): PropBinding | null => {
  const b = targetButton();
  return b && b.kind === 'text' && typeof b.owner[b.key] === 'string' ? b : null;
};

/** Accept string for a file input from a glob list such as "*.png;*.jpg". */
export function acceptFromGlob(glob: string): string {
  return glob
    .split(/[;,]/)
    .map((g) => g.trim().replace(/^\*/, ''))
    .filter((g) => /^\.[\w.]+$/.test(g))
    .join(',');
}

/** The path written for a picked name (relative paths start with //). */
export function pickedPath(name: string, relative: boolean, dir = false): string {
  const n = dir ? `${name.replace(/\/+$/, '')}/` : name;
  return relative ? `//${n}` : n;
}

function setPath(b: PropBinding, v: string, label: string) {
  b.owner[b.key] = v;
  b.onChange?.();
  app.pushUndo(label);
  app.changed('doc');
}

registerOperators([
  {
    idname: 'buttons.file_browse',
    label: 'Accept',
    description: 'Pick a file for the path field under the pointer',
    undo: false,
    props: [
      { id: 'filepath', label: 'File Path', type: 'string', default: '' },
      { id: 'filter_glob', label: 'Filter', type: 'string', default: '' },
      { id: 'relative_path', label: 'Relative Path', type: 'bool', default: true },
    ],
    poll: () => !!pathTarget(),
    invoke: (_c, p) => {
      const b = pathTarget()!;
      if (p.filepath) return setPath(b, String(p.filepath), 'File Browse'), 'FINISHED';
      void pickFile(acceptFromGlob(String(p.filter_glob))).then((f) => f && setPath(b, pickedPath(f.name, p.relative_path !== false), 'File Browse'));
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      if (!p.filepath) return 'CANCELLED';
      setPath(pathTarget()!, String(p.filepath), 'File Browse');
    },
  },
  {
    idname: 'buttons.directory_browse',
    label: 'Accept',
    description: 'Pick a folder for the path field under the pointer',
    undo: false,
    props: [
      { id: 'directory', label: 'Directory', type: 'string', default: '' },
      { id: 'relative_path', label: 'Relative Path', type: 'bool', default: true },
    ],
    poll: () => !!pathTarget(),
    invoke: (_c, p) => {
      const b = pathTarget()!;
      if (p.directory) return setPath(b, String(p.directory), 'Directory Browse'), 'FINISHED';
      const picker = (window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<{ name: string }> }).showDirectoryPicker;
      if (!picker) {
        app.report('WARNING', 'This browser cannot pick folders; type the path instead');
        return 'CANCELLED';
      }
      void picker({ mode: 'read' }).then(
        (d) => setPath(b, pickedPath(d.name, p.relative_path !== false, true), 'Directory Browse'),
        () => {},
      );
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      if (!p.directory) return 'CANCELLED';
      setPath(pathTarget()!, String(p.directory), 'Directory Browse');
    },
  },
]);
