import { describe, expect, it, vi } from 'vitest';
import { cleanText, extractJson, readReceipt, receiptErrorCode, toAmount, validateReceipt } from '../../src/lib/ai/receipt.js';
import { receiptDraft } from '../../src/views/trip/costs/receipt/index.js';

const today = '2027-05-10';
const check = (raw, tripCurrency = 'EUR') => validateReceipt(raw, { tripCurrency, today });

describe('extractJson', () => {
  it('finds the object inside fences and prose, skipping broken candidates', () => {
    expect(extractJson('```json\n{"total": 12.5}\n```')).toEqual({ total: 12.5 });
    expect(extractJson('Sure! {not json} then {"merchant": "Caf\\"e {x}", "total": 3}')).toEqual({ merchant: 'Caf"e {x}', total: 3 });
    expect(extractJson('[1, 2]')).toBeNull();
    expect(extractJson(null)).toBeNull();
    expect(extractJson({ total: 1 })).toEqual({ total: 1 });
  });
});

describe('toAmount', () => {
  it.each([
    [12.5, 'EUR', 1250], ['12,50', 'EUR', 1250], ['1.234,56', 'EUR', 123456], ['1,234.56', 'USD', 123456], ['$ 7.99', 'USD', 799],
    [1999, 'JPY', 1999], [12.6, 'JPY', 13], [0.1 + 0.2, 'EUR', 30], ['12.345', 'KWD', 12345],
  ])('%j %s → %s', (value, currency, expected) => { expect(toAmount(value, currency)).toBe(expected); });

  it('rejects negatives unless allowed, junk and absurd values', () => {
    expect(toAmount(-3, 'EUR')).toBeNull();
    expect(toAmount(-3, 'EUR', { negative: true })).toBe(-300);
    expect(toAmount('abc', 'EUR')).toBeNull();
    expect(toAmount(Number.NaN, 'EUR')).toBeNull();
    expect(toAmount(1e20, 'EUR')).toBeNull();
    expect(toAmount({}, 'EUR')).toBeNull();
  });
});

describe('validateReceipt', () => {
  it('turns a clean answer into expense fields in minor units', () => {
    const result = check({ merchant: '  Blue  Fern Café ', date: '2027-05-09', total: 14.6, currency: 'eur', category: 'food', tax: 1.2, tip: null,
      items: [{ label: 'Coffee', amount: 3.6 }, { label: 'Cake', amount: 11 }], confidence: 0.9 });
    expect(result).toMatchObject({ name: 'Blue Fern Café', amount: 1460, currency: 'EUR', date: '2027-05-09', cat: 'food', tax: 120, tip: null,
      items: [{ label: 'Coffee', amount: 360 }, { label: 'Cake', amount: 1100 }], itemsTotal: 1460, itemsMatch: true, confidence: 0.9, warnings: [] });
  });

  it('falls back to the trip currency and flags it', () => {
    expect(check({ total: 10, currency: 'XYZ' }, 'CAD')).toMatchObject({ currency: 'CAD', amount: 1000, warnings: ['currency'] });
    expect(check({ total: 10, currency: '€' }, 'CAD')).toMatchObject({ currency: 'EUR', warnings: [] });
    expect(check({ total: 10, currency: '$' }, 'AUD').currency).toBe('AUD');
    expect(check({ total: 10, currency: '$' }, 'EUR')).toMatchObject({ currency: 'EUR', warnings: ['currency'] });
  });

  it('drops future, malformed and implausible dates', () => {
    expect(check({ total: 1, currency: 'EUR', date: '2027-05-11' }).date).toBe('2027-05-11');
    expect(check({ total: 1, currency: 'EUR', date: '2027-05-12' })).toMatchObject({ date: null, warnings: ['date'] });
    expect(check({ total: 1, currency: 'EUR', date: '2027-02-30' })).toMatchObject({ date: null, warnings: ['date'] });
    expect(check({ total: 1, currency: 'EUR', date: '1970-01-01' }).date).toBeNull();
    expect(check({ total: 1, currency: 'EUR', date: null }).warnings).toEqual([]);
  });

  it('keeps zero and negative totals out and flags them', () => {
    expect(check({ total: 0, currency: 'EUR' })).toMatchObject({ amount: null, warnings: ['amount'] });
    expect(check({ total: -5, currency: 'EUR' })).toMatchObject({ amount: null, warnings: ['amount'] });
    expect(check('no json at all')).toMatchObject({ amount: null, name: '', items: [], warnings: ['currency', 'amount'] });
  });

  it('cleans line items, keeps discounts, caps them and reports a mismatch', () => {
    const items = [{ label: 'Pasta', amount: 12 }, { name: 'Coupon', price: -2 }, { label: '', amount: 3 }, { label: 'Zero', amount: 0 }, 'junk', { label: 'Bad', amount: 'x' }];
    const result = check({ total: 10, currency: 'EUR', items });
    expect(result.items).toEqual([{ label: 'Pasta', amount: 1200 }, { label: 'Coupon', amount: -200 }]);
    expect(result.itemsMatch).toBe(true);
    const many = check({ total: 1, currency: 'EUR', items: Array.from({ length: 80 }, (_, index) => ({ label: `Item ${index}`, amount: 1 })) });
    expect(many.items).toHaveLength(50);
    expect(many.itemsMatch).toBe(false);
    expect(many.warnings).toContain('items');
  });

  it('never passes markup or control characters through as structure', () => {
    const result = check({ merchant: '<img src=x onerror=alert(1)>‮evil\u0000', total: 1, currency: 'EUR', category: 'hacking', confidence: 7 });
    expect(result.name).toBe('<img src=x onerror=alert(1)> evil');
    expect(result.cat).toBeNull();
    expect(result.confidence).toBe(1);
    expect(cleanText('a'.repeat(500), 200)).toHaveLength(200);
  });
});

describe('readReceipt', () => {
  const image = 'data:image/jpeg;base64,AAAA';

  it('uses the vision answer with the chosen model and a JSON schema', async () => {
    const chat = vi.fn().mockResolvedValue({ message: { content: '{"merchant":"Deli","total":11.9,"currency":"USD","date":"2027-05-03","items":[],"confidence":0.8}' } });
    const puter = { ai: { chat, img2txt: vi.fn() } };
    const { receipt, source } = await readReceipt(image, { puter, model: 'claude-haiku-5-5', tripCurrency: 'EUR', today });
    expect(source).toBe('vision');
    expect(receipt).toMatchObject({ name: 'Deli', amount: 1190, currency: 'USD' });
    expect(chat).toHaveBeenCalledWith(expect.stringContaining('Today is 2027-05-10'), image, expect.objectContaining({ model: 'claude-haiku-5-5', outputFormat: expect.objectContaining({ type: 'json_schema' }) }));
    expect(puter.ai.img2txt).not.toHaveBeenCalled();
  });

  it('falls back to OCR text plus a text extraction', async () => {
    const chat = vi.fn().mockRejectedValueOnce(new Error('vision unsupported')).mockResolvedValueOnce('{"merchant":"Deli","total":"11,90","currency":"EUR"}');
    const puter = { ai: { chat, img2txt: vi.fn().mockResolvedValue('DELI\nTOTAL 11,90') } };
    const { receipt, source } = await readReceipt(image, { puter, tripCurrency: 'EUR', today });
    expect(source).toBe('ocr');
    expect(receipt.amount).toBe(1190);
    expect(chat.mock.calls[1][0]).toContain('TOTAL 11,90');
  });

  it('reports credit errors at once and unreadable receipts after both attempts', async () => {
    const credit = Object.assign(new Error('Insufficient funds'), { status: 402 });
    const puter = { ai: { chat: vi.fn().mockRejectedValue(credit), img2txt: vi.fn() } };
    await expect(readReceipt(image, { puter, tripCurrency: 'EUR', today })).rejects.toBe(credit);
    expect(puter.ai.img2txt).not.toHaveBeenCalled();
    expect(receiptErrorCode(credit)).toBe('credit');

    const blank = { ai: { chat: vi.fn().mockResolvedValue('I cannot read this.'), img2txt: vi.fn().mockResolvedValue('') } };
    const error = await readReceipt(image, { puter: blank, tripCurrency: 'EUR', today }).catch((failure) => failure);
    expect(receiptErrorCode(error)).toBe('unreadable');
    expect(receiptErrorCode(await readReceipt(image, { puter: {}, tripCurrency: 'EUR', today }).catch((failure) => failure))).toBe('unavailable');
  });

  it('refuses files that are not images', async () => {
    const puter = { ai: { chat: vi.fn() } };
    const error = await readReceipt(new File(['%PDF'], 'bill.pdf', { type: 'application/pdf' }), { puter, tripCurrency: 'EUR', today }).catch((failure) => failure);
    expect(receiptErrorCode(error)).toBe('type');
    expect(puter.ai.chat).not.toHaveBeenCalled();
  });
});

describe('receiptDraft', () => {
  const receipt = validateReceipt({ merchant: 'Deli', total: 10, currency: 'EUR', date: '2027-05-09', category: 'food', items: [{ label: 'A', amount: 6 }, { label: 'B', amount: 4 }] }, { tripCurrency: 'EUR', today });
  const line = (item) => `${item.label} ${item.amount}`;

  it('prefills an equal split paid by the scanner, with items in the note', () => {
    const draft = receiptDraft(receipt, { me: 'me', people: ['me', 'you'], tripCurrency: 'EUR', today, line });
    expect(draft).toMatchObject({ name: 'Deli', amount: 1000, currency: 'EUR', date: '2027-05-09', cat: 'food', payers: [{ who: 'me', amount: 1000 }],
      split: { mode: 'equal', parts: [{ who: 'me' }, { who: 'you' }] }, note: 'A 600\nB 400' });
  });

  it('splits by items only when they add up to the total', () => {
    const draft = receiptDraft(receipt, { me: 'me', people: ['me', 'you'], tripCurrency: 'EUR', today, line, byItems: true });
    expect(draft.split).toEqual({ mode: 'items', parts: [{ who: 'me' }, { who: 'you' }], items: [{ label: 'A', amount: 600, who: ['me', 'you'] }, { label: 'B', amount: 400, who: ['me', 'you'] }] });
    expect(draft.note).toBeUndefined();
    const off = receiptDraft({ ...receipt, itemsMatch: false }, { me: 'me', people: ['me'], tripCurrency: 'EUR', today, line, byItems: true });
    expect(off.split.mode).toBe('equal');
  });

  it('gives a manual draft when nothing was read', () => {
    expect(receiptDraft(null, { me: 'me', people: [], tripCurrency: 'JPY', today })).toEqual({
      name: '', amount: null, currency: 'JPY', date: today, payers: [{ who: 'me', amount: 0 }], split: { mode: 'equal', parts: [{ who: 'me' }] } });
  });
});
