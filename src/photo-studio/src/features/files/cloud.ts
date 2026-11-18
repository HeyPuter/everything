// Puter.js calls the file features need beyond src/persistence/puter.ts
// (multiple selection, directory picker, folder writes).
// https://docs.puter.com/UI/showOpenFilePicker/ · /UI/showDirectoryPicker/ · /FS/write/
import { puter } from '../../persistence/puter';

export interface CloudItem {
  path: string;
  name: string;
  isDir?: boolean;
  read(): Promise<Blob>;
}
type ExtendedPuter = {
  fs: {
    write(path: string, data: Blob, options?: { overwrite?: boolean; dedupeName?: boolean; createMissingParents?: boolean }): Promise<CloudItem>;
    read(path: string): Promise<Blob>;
  };
  ui: {
    showOpenFilePicker(options: { accept?: string | string[]; multiple?: boolean }): Promise<CloudItem | CloudItem[]>;
    showSaveFilePicker(content: Blob, name: string): Promise<CloudItem>;
    showDirectoryPicker(options?: { multiple?: boolean }): Promise<CloudItem | CloudItem[]>;
  };
};
const api = () => puter() as unknown as ExtendedPuter;

type PuterFailure = { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } };
/** Puter calls reject with the service's error object ({ code, message }, or
 * the same under `error`) rather than an Error, which showed as
 * "[object Object]". This gives it an Error with the service's message. */
export function puterError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  const x = (thrown && typeof thrown === 'object' ? thrown : {}) as PuterFailure;
  const message = x.message ?? x.error?.message;
  const code = x.code ?? x.error?.code;
  const text = typeof message === 'string' && message ? message : typeof thrown === 'string' && thrown ? thrown : 'Puter could not complete the request.';
  return Object.assign(new Error(text), typeof code === 'string' ? { code } : {});
}
/** True when a Puter call failed because the file is not there (anymore). */
export function puterMissing(thrown: unknown) {
  const x = (thrown && typeof thrown === 'object' ? thrown : {}) as PuterFailure;
  const code = String(x.code ?? x.error?.code ?? '');
  return code === 'subject_does_not_exist' || code === 'not_found' || /does not exist|not found|no such file/i.test(puterError(thrown).message);
}
const rethrow = (thrown: unknown): never => {
  throw puterError(thrown);
};

export const openAccept = '.photo,.psd,.psb,.tif,.tiff,.bmp,.dib,.gif,.ico,.cur,.tga,.pbm,.pgm,.ppm,.pnm,.pam,.svg,image/*';

export async function pickCloudFiles(multiple: boolean, accept = openAccept): Promise<CloudItem[]> {
  const r = await api().ui.showOpenFilePicker({ accept, multiple }).catch(rethrow);
  return Array.isArray(r) ? r : [r];
}
export async function pickCloudFolder(): Promise<CloudItem> {
  const r = await api().ui.showDirectoryPicker({ multiple: false }).catch(rethrow);
  return Array.isArray(r) ? r[0] : r;
}
/** Save picker; the promise never settles when the user cancels (Puter behavior). */
export function cloudSaveAs(blob: Blob, name: string) {
  return api().ui.showSaveFilePicker(blob, name).catch(rethrow);
}
export function cloudWrite(path: string, blob: Blob, opts: { dedupeName?: boolean } = {}) {
  return api().fs.write(path, blob, { overwrite: !opts.dedupeName, dedupeName: !!opts.dedupeName, createMissingParents: true }).catch(rethrow);
}
export function cloudRead(path: string) {
  return api().fs.read(path).catch(rethrow);
}
export function joinPath(dir: string, name: string) {
  return `${dir.replace(/\/+$/, '')}/${name}`;
}
