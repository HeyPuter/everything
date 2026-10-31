import { openModal } from './modal.js';
export function openSheet(options) { return openModal({ ...options, kind: 'sheet' }); }
export function openDrawer(options) { return openModal({ ...options, kind: 'drawer' }); }
