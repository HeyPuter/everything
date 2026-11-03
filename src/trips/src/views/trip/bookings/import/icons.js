import { createElement, FileUp, Mail, Merge, ClipboardPaste, FolderOpen, CircleCheck, CircleX, CircleDashed, HardDrive, Ban, LoaderCircle, Files } from 'lucide';
import { icon as bookingIcon } from '../icons.js';

const extra = {
  import: FileUp, mail: Mail, merge: Merge, paste: ClipboardPaste, tripFiles: FolderOpen, done: CircleCheck, failed: CircleX,
  pending: CircleDashed, drive: HardDrive, skipped: Ban, reading: LoaderCircle, files: Files,
};
export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return bookingIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
