import { t } from '../i18n/index.js';

/** Worksheet Form scroll bars (not ActiveX controls). */
export function normalizeScrollControl(raw) {
  const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const integer = (value, fallback) => Math.max(0, Math.min(30000, Math.round(number(value, fallback))));
  const min = integer(raw.min, 0), max = Math.max(min, integer(raw.max, 100));
  const anchor = { r: Math.max(0, Math.min(1048575, Math.trunc(number(raw.anchor.r, 0)))),
    c: Math.max(0, Math.min(16383, Math.trunc(number(raw.anchor.c, 0)))) };
  return { id: raw.id, type: 'scroll', anchor,
    range: { r1: anchor.r, c1: anchor.c, r2: anchor.r, c2: anchor.c },
    dx: number(raw.dx, 0), dy: number(raw.dy, 0), w: Math.max(1, number(raw.w, 160)), h: Math.max(1, number(raw.h, 20)),
    ...(raw.anchorMode === 'absolute' ? { anchorMode: 'absolute' } : {}),
    title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
    description: typeof raw.description === 'string' ? raw.description.slice(0, 8192) : '',
    linkRef: typeof raw.linkRef === 'string' ? raw.linkRef.slice(0, 8192).replace(/^=/, '') : '',
    min, max, value: Math.max(min, Math.min(max, integer(raw.value, min))),
    ...(raw.scrollWidth != null && Number.isFinite(Number(raw.scrollWidth)) ? { scrollWidth: Math.max(0, Math.min(4294967295, Math.round(Number(raw.scrollWidth)))) } : {}),
    step: integer(raw.step, 1), page: integer(raw.page, 10), horizontal: raw.horizontal !== false,
    print: raw.print !== false, border: false, ...(raw.disabled ? { disabled: true } : {}),
  };
}

export function scrollControlTarget(wb, sheetId, control) {
  if (!control.linkRef) return null;
  const target = wb.rangeFromText(sheetId, control.linkRef);
  if (!target || target.range.r1 !== target.range.r2 || target.range.c1 !== target.range.c2) return null;
  return target;
}

export function scrollControlValue(wb, sheetId, control) {
  const target = scrollControlTarget(wb, sheetId, control);
  const value = target ? wb.getValue(target.sheetId, target.range.r1, target.range.c1) : control.value;
  return Math.max(control.min, Math.min(control.max, typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : control.value));
}

/** A control change is one undoable edit, including its linked cell. */
export function setScrollControlValue(wb, sheetId, id, value) {
  const control = wb.chartById(sheetId, id);
  if (control?.type !== 'scroll' || control.disabled || !Number.isFinite(value) || wb._locked(wb.sheet(sheetId))) return false;
  const target = scrollControlTarget(wb, sheetId, control);
  if (control.linkRef && !target) return false;
  if (target && (wb.lockedAt(target.sheetId, target.range.r1, target.range.c1)
    || wb.arrayEditBlocked(target.sheetId, target.range))) return false;
  const next = Math.max(control.min, Math.min(control.max, Math.round(value)));
  const label = t('coreScrollControl.change');
  wb.transaction(label, () => {
    if (target) wb.setInput(target.sheetId, target.range.r1, target.range.c1, String(next));
    wb.updateChart(sheetId, id, { value: next }, label);
  });
  return true;
}
