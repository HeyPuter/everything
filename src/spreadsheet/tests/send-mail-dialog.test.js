// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { openSendCopyDialog, openSendLinkDialog } from '../src/ui/send-mail.js';
import { menubarMenus } from '../src/ui/menubar.js';
import * as P from '../src/lib/puter.js';
import * as T from '../src/ui/toast.js';

beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { closeAllModals(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const until = (check) => vi.waitFor(check, { timeout: 15000, interval: 20 });

function doc() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Item');
  wb.setInput(id, 1, 0, 'Paper');
  const d = new Doc({ wb, name: 'Supplies' });
  d.path = 'Spreadsheets/Supplies.xlsx';
  d.uid = 'uid-9';
  return d;
}

const results = (emails, failed = []) => ({
  ok: true, sent: emails.length - failed.length, failed: failed.length,
  results: emails.map((email) => ({ email, status: failed.includes(email) ? 'failed' : 'sent' })),
});

function fill(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const submit = () => document.querySelector('.send-dialog').dispatchEvent(new Event('submit', { cancelable: true }));

describe('Send a copy', () => {
  it('refuses an address that is not one, and sends the chosen attachment to the rest', async () => {
    vi.spyOn(T, 'toast').mockImplementation(() => {});
    const d = doc();
    const mailer = { sendCopy: vi.fn(async ({ recipients }) => results(recipients.map((r) => r.email))) };
    openSendCopyDialog({ doc: d, sheetId: d.wb.activeSheetId, mailer, user: { username: 'demo', email: 'demo@example.com' } });
    expect(document.querySelector('.send-from').textContent).toBe('From demo. Replies go to demo@example.com');
    await until(() => expect(document.querySelector('.send-size').textContent).toMatch(/^Attachment: Supplies\.xlsx \(\d+ KB\)$/));
    fill(document.querySelector('.send-to'), 'ana@example.com, nope');
    expect(document.querySelector('.send-count').textContent).toBe('1 entry is not an email address');
    submit();
    await settle();
    expect(document.querySelector('.send-dialog .field-error').textContent).toBe('"nope" is not an email address');
    expect(mailer.sendCopy).not.toHaveBeenCalled();

    fill(document.querySelector('.send-to'), 'ana@example.com; Ben <ben@example.org>');
    document.querySelector('.send-format input[value="pdf"]').click();
    document.querySelector('.send-format input[value="pdf"]').dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => expect(document.querySelector('.send-size').textContent).toMatch(/Supplies\.pdf/));
    fill(document.querySelector('.send-message'), 'For Monday');
    submit();
    await until(() => expect(document.querySelector('.send-dialog')).toBeNull());
    expect(mailer.sendCopy).toHaveBeenCalledTimes(1);
    const req = mailer.sendCopy.mock.calls[0][0];
    expect(req.recipients).toEqual([{ email: 'ana@example.com', name: '' }, { email: 'ben@example.org', name: 'Ben' }]);
    expect(req).toMatchObject({ workbookName: 'Supplies', subject: 'Supplies', message: 'For Monday' });
    expect(req.attachment.filename).toBe('Supplies.pdf');
    expect(document.querySelector('.send-dialog')).toBeNull();
    expect(T.toast).toHaveBeenCalledWith('Copy sent to 2 people', expect.anything());
  });

  it('keeps only the people it could not reach, to try again', async () => {
    vi.spyOn(T, 'toast').mockImplementation(() => {});
    const d = doc();
    const mailer = { sendCopy: vi.fn(async ({ recipients }) => results(recipients.map((r) => r.email), ['bad@example.com'])) };
    openSendCopyDialog({ doc: d, sheetId: d.wb.activeSheetId, mailer });
    fill(document.querySelector('.send-to'), 'ana@example.com, bad@example.com');
    submit();
    await until(() => expect(document.querySelector('.send-to').value).toBe('bad@example.com'));
    expect(document.querySelector('.send-dialog .field-error').textContent).toMatch(/Not sent to bad@example\.com/);
    expect(document.querySelector('.send-dialog button[type="submit"]').disabled).toBe(false);
  });

  it('offers the selection when there is one, and never the whole workbook as one .csv', async () => {
    const d = doc();
    openSendCopyDialog({ doc: d, sheetId: d.wb.activeSheetId, range: { r1: 0, c1: 0, r2: 1, c2: 0 }, mailer: {} });
    await settle();
    const scope = document.querySelector('.send-dialog select');
    expect([...scope.options].map((o) => o.value)).toEqual(['workbook', 'sheet', 'selection']);
    const csv = document.querySelector('.send-format input[value="csv"]');
    csv.click();
    csv.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(scope.value).toBe('sheet');
    expect(scope.querySelector('option[value="workbook"]').disabled).toBe(true);
    scope.value = 'selection';
    scope.dispatchEvent(new Event('change'));
    await settle();
    expect(document.querySelector('.send-size').textContent).toMatch(/Supplies \(selection\)\.csv/);
  });
});

describe('Send a link', () => {
  it('shares the file with each address, then emails the link with the access given', async () => {
    vi.spyOn(T, 'toast').mockImplementation(() => {});
    vi.spyOn(P, 'canShare').mockReturnValue(true);
    vi.spyOn(P, 'shareFile').mockResolvedValue({});
    vi.spyOn(P, 'puterShareLink').mockResolvedValue(null);
    const d = doc();
    const mailer = { sendLink: vi.fn(async ({ recipients }) => results(recipients.map((r) => r.email))) };
    openSendLinkDialog({ doc: d, mailer, location: { origin: 'https://spreadsheet.puter.com', pathname: '/' } });
    fill(document.querySelector('.send-to'), 'ana@example.com, kim@example.org');
    const mode = document.querySelector('.send-dialog select');
    mode.value = 'write';
    fill(document.querySelector('.send-message'), 'Your turn');
    submit();
    await until(() => expect(document.querySelector('.send-dialog')).toBeNull());
    expect(P.shareFile.mock.calls).toEqual([['Spreadsheets/Supplies.xlsx', 'ana@example.com', 'write'], ['Spreadsheets/Supplies.xlsx', 'kim@example.org', 'write']]);
    expect(mailer.sendLink).toHaveBeenCalledWith({
      workbookName: 'Supplies', recipients: [{ email: 'ana@example.com', name: '' }, { email: 'kim@example.org', name: '' }],
      link: 'https://spreadsheet.puter.com/#/file/uid-9', access: 'edit', message: 'Your turn',
    });
  });
});

describe('the File menu', () => {
  const share = (flags) => menubarMenus(flags).find((m) => m.id === 'file').items.find((i) => i?.label === 'Share');
  it('gathers sharing and sending under Share', () => {
    expect(share({ share: true, mail: true }).submenu.map((i) => [i.label, i.cmd])).toEqual([
      ['Share with people…', 'share'], ['Send a copy…', 'sendCopy'], ['Send a link…', 'sendLink'],
    ]);
    expect(share({ share: false, mail: true }).submenu.map((i) => i.cmd)).toEqual(['sendCopy']);
    expect(share({ share: false, mail: false })).toBeUndefined();
  });
});
