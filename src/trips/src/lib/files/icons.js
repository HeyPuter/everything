import {
  createElement, Upload, Download, HardDrive, Star, RotateCcw, Image, FileSpreadsheet, FileText, Ticket, Paperclip, Link2,
  Eye, Info, ExternalLink, StickyNote, MessageCircle, ImageOff, CircleAlert, Receipt, FolderOpen, RefreshCw,
} from 'lucide';
import { icon as kitIcon } from '../../ui/icons.js';
import { el } from '../../ui/dom.js';

// Icons the kit does not carry.
const extra = {
  upload: Upload, download: Download, drive: HardDrive, star: Star, restore: RotateCcw, image: Image, sheet: FileSpreadsheet,
  document: FileText, pass: Ticket, attach: Paperclip, link: Link2, eye: Eye, info: Info, external: ExternalLink, note: StickyNote,
  message: MessageCircle, noPreview: ImageOff, alert: CircleAlert, receipt: Receipt, folder: FolderOpen, retry: RefreshCw,
};
export function icon(name, size = 18, { filled = false } = {}) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: `icon${filled ? ' icon-filled' : ''}` });
}

/** Icon for a stored file by its mime type. */
export function fileIcon(mime, size = 20) {
  const value = String(mime ?? '');
  if (value.startsWith('image/')) return icon('image', size);
  if (value.includes('spreadsheet') || value.includes('ms-excel') || value === 'text/csv') return icon('sheet', size);
  if (value.includes('pkpass')) return icon('pass', size);
  return icon('document', size);
}

const LINK_ICONS = { place: 'pin', res: 'plane', visit: 'calendar', exp: 'receipt', note: 'note', msg: 'message', meta: 'image' };
export const linkIcon = (type, size = 14) => icon(LINK_ICONS[type] ?? 'link', size);

/** An icon-only button with any icon from this set; `label` names it for screen readers. */
export function iconAction(name, label, { small = false, ...attrs } = {}) {
  return el(`button.icon-btn${small ? '.icon-btn-sm' : ''}`, { type: 'button', title: label, 'aria-label': label, ...attrs }, icon(name, small ? 16 : 18));
}
