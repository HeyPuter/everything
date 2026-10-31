// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readZip } from '../../src/lib/ai/import/zip.js';
import { parseIsoPoint, parsePkpass, passToItem } from '../../src/lib/ai/import/pkpass.js';
import { decodeWords, htmlToText, parseEml, parseParams } from '../../src/lib/ai/import/mime.js';
import { makeZip } from './helpers/zip-writer.js';

const boarding = {
  formatVersion: 1, organizationName: 'TAP Air Portugal', description: 'Boarding pass', relevantDate: '2026-05-03T21:30+01:00',
  boardingPass: {
    transitType: 'PKTransitTypeAir',
    headerFields: [{ key: 'gate', label: 'GATE', value: '14' }],
    primaryFields: [{ key: 'origin', label: 'LISBON', value: 'LIS' }, { key: 'destination', label: 'NEW YORK', value: 'JFK' }],
    auxiliaryFields: [{ key: 'flight', label: 'FLIGHT', value: 'TP209' }, { key: 'seat', label: 'SEAT', value: '23A' }, { key: 'departs', label: 'DEPARTS', value: '2026-05-03T22:00+01:00', timeStyle: 'PKDateStyleShort' }],
    backFields: [{ key: 'pnr', label: 'Booking reference', value: 'X7K2LM' }, { key: 'passenger', label: 'Passenger', value: 'Ana Silva' }],
  },
};

describe('zip reader', () => {
  it('reads stored and deflated entries', async () => {
    const entries = await readZip(makeZip([['a.txt', 'hello', 0], ['dir/b.txt', 'world '.repeat(50)]]));
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'dir/b.txt']);
    expect(new TextDecoder().decode(await entries[0].read())).toBe('hello');
    expect(new TextDecoder().decode(await entries[1].read())).toBe('world '.repeat(50));
  });
  it('rejects non-archives and caps inflated size', async () => {
    await expect(readZip(new Uint8Array(100))).rejects.toMatchObject({ code: 'zip_invalid' });
    const [entry] = await readZip(makeZip([['big', 'x'.repeat(5000)]]), { maxEntryBytes: 1000 });
    await expect(entry.read()).rejects.toMatchObject({ code: 'zip_too_large' });
  });
});

describe('pkpass', () => {
  it('parses ISO points with and without offsets', () => {
    expect(parseIsoPoint('2026-05-03T22:00+01:00')).toEqual({ date: '2026-05-03', time: '22:00', at: Date.UTC(2026, 4, 3, 21, 0) });
    expect(parseIsoPoint('2026-05-03T22:00:30Z')).toMatchObject({ date: '2026-05-03', time: '22:00', at: Date.UTC(2026, 4, 3, 22, 0, 30) });
    expect(parseIsoPoint('2026-05-03T22:00')).toEqual({ date: '2026-05-03', time: '22:00' });
    expect(parseIsoPoint('2026-05-03')).toEqual({ date: '2026-05-03' });
    expect(parseIsoPoint('May 3')).toBeNull();
  });

  it('maps a boarding pass to a one-leg flight', async () => {
    const item = await parsePkpass(makeZip([['pass.json', JSON.stringify(boarding)], ['icon.png', new Uint8Array([1, 2, 3]), 0]]));
    expect(item).toMatchObject({
      type: 'flight', status: 'confirmed', provider: 'TAP Air Portugal', code: 'X7K2LM', travelers: ['Ana Silva'],
      extras: [{ key: 'gate', value: '14' }],
    });
    expect(item.legs[0]).toMatchObject({
      from: { code: 'LIS', name: 'LISBON' }, to: { code: 'JFK', name: 'NEW YORK' },
      dep: { date: '2026-05-03', time: '22:00', at: Date.UTC(2026, 4, 3, 21, 0) },
      number: 'TP209', seat: '23A', carrier: 'TAP Air Portugal', code: 'X7K2LM',
    });
  });

  it('prefers semantic tags and localized labels', async () => {
    const pass = {
      ...boarding,
      semantics: { departureAirportCode: 'OPO', destinationAirportCode: 'MAD', airlineCode: 'IB', flightNumber: 3101, currentDepartureDate: '2026-06-01T07:15+01:00', currentArrivalDate: '2026-06-01T09:30+02:00', confirmationNumber: 'QW12ER', seats: [{ seatNumber: '4C' }] },
      boardingPass: { ...boarding.boardingPass, primaryFields: [{ key: 'origin', label: 'orig_label', value: 'OPO' }, { key: 'destination', label: 'dest_label', value: 'MAD' }] },
    };
    const strings = '﻿"orig_label" = "Porto";\n"dest_label" = "Madrid";\n';
    const bytes = new Uint8Array(Buffer.from(strings, 'utf16le'));
    const item = await parsePkpass(makeZip([['pass.json', JSON.stringify(pass)], ['en.lproj/pass.strings', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(bytes.slice(2))])]]));
    expect(item.code).toBe('QW12ER');
    expect(item.legs[0]).toMatchObject({ from: { code: 'OPO', name: 'Porto' }, to: { code: 'MAD', name: 'Madrid' }, number: 'IB3101', seat: '4C', dep: { time: '07:15' }, arr: { date: '2026-06-01', time: '09:30' } });
  });

  it('maps trains, events and refuses store cards', () => {
    const train = passToItem({ organizationName: 'CP', boardingPass: { transitType: 'PKTransitTypeTrain', primaryFields: [{ key: 'from', label: 'From', value: 'Lisboa Oriente' }, { key: 'to', label: 'To', value: 'Porto Campanhã' }], secondaryFields: [{ key: 'coach', label: 'Coach', value: '5' }, { key: 'seat', label: 'Seat', value: '61' }] }, relevantDate: '2026-05-10T09:00+01:00' });
    expect(train).toMatchObject({ type: 'train', legs: [{ from: { name: 'From' }, coach: '5', seat: '61', dep: { date: '2026-05-10', time: '09:00' } }] });
    expect(train.legs[0].from.code).toBe('LISBOA ORIENTE');
    const event = passToItem({ organizationName: 'Arena', description: 'Concert', eventTicket: { primaryFields: [{ key: 'event', label: 'Event', value: 'Night Show' }], secondaryFields: [{ key: 'section', label: 'Section', value: 'B' }, { key: 'seat', label: 'Seat', value: '12' }] }, relevantDate: '2026-05-04T20:00+01:00', locations: [{ latitude: 38.7, longitude: -9.1 }] });
    expect(event).toMatchObject({ type: 'event', title: 'Night Show', start: { date: '2026-05-04', time: '20:00' }, location: { lat: 38.7, lng: -9.1 }, extras: [{ key: 'section', value: 'B' }, { key: 'seat', value: '12' }] });
    expect(() => passToItem({ storeCard: {} })).toThrow(expect.objectContaining({ code: 'pkpass_not_booking' }));
    expect(() => passToItem({})).toThrow(expect.objectContaining({ code: 'pkpass_invalid' }));
  });

  it('rejects archives without pass.json', async () => {
    await expect(parsePkpass(makeZip([['other.json', '{}']]))).rejects.toMatchObject({ code: 'pkpass_invalid' });
    await expect(parsePkpass(makeZip([['pass.json', '{not json']]))).rejects.toMatchObject({ code: 'pkpass_invalid' });
  });
});

describe('eml', () => {
  it('decodes encoded words and parameters', () => {
    expect(decodeWords('=?UTF-8?B?Q29uZmlybWHDp8Ojbw==?= =?UTF-8?Q?_da_reserva?=')).toBe('Confirmação da reserva');
    expect(decodeWords('=?ISO-8859-1?Q?R=E9servation?=')).toBe('Réservation');
    expect(parseParams('attachment; filename="ticket 1.pdf"')).toEqual({ value: 'attachment', params: { filename: 'ticket 1.pdf' } });
    expect(parseParams("attachment; filename*=UTF-8''r%C3%A9servation.pdf").params.filename).toBe('réservation.pdf');
    expect(parseParams('text/plain; charset=iso-8859-1; format=flowed').params).toEqual({ charset: 'iso-8859-1', format: 'flowed' });
  });

  it('decodes multipart bodies, transfer encodings and attachments', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake').toString('base64');
    const eml = [
      'From: "Hotel Sol" <res@hotelsol.example>',
      'To: ana@puter.email',
      'Subject: =?UTF-8?Q?Reserva_confirmada_=E2=80=93_Hotel_Sol?=',
      'Date: Mon, 2 Mar 2026 10:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="outer"',
      '',
      '--outer',
      'Content-Type: multipart/alternative; boundary=inner',
      '',
      '--inner',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Check-in: 12 May 2026 =E2=80=93 confirma=',
      'tion HS-4471',
      '--inner',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('<p>Check-in <b>12 May</b></p><script>alert(1)</script>').toString('base64'),
      '--inner--',
      '--outer',
      'Content-Type: application/pdf; name="voucher.pdf"',
      'Content-Disposition: attachment; filename="voucher.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      pdf,
      '--outer--',
      '',
    ].join('\r\n');
    const mail = await parseEml(eml);
    expect(mail.subject).toBe('Reserva confirmada – Hotel Sol');
    expect(mail.from).toContain('res@hotelsol.example');
    expect(mail.text).toBe('Check-in: 12 May 2026 – confirmation HS-4471');
    expect(htmlToText(mail.html)).toBe('Check-in 12 May');
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]).toMatchObject({ filename: 'voucher.pdf', mimeType: 'application/pdf', disposition: 'attachment' });
    expect(new TextDecoder().decode(mail.attachments[0].content)).toBe('%PDF-1.4 fake');
  });

  it('reads forwarded messages and legacy charsets', async () => {
    const latin = Buffer.concat([
      Buffer.from('Subject: Fwd: booking\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nSee below\r\n--b\r\nContent-Type: message/rfc822\r\n\r\n'),
      Buffer.from('Subject: Billet\r\nFrom: train@example.com\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nD'),
      Buffer.from([0xe9]),
      Buffer.from('part 08:15\r\n--b--\r\n'),
    ]);
    const mail = await parseEml(new Uint8Array(latin));
    expect(mail.text).toBe('See below\n\nDépart 08:15');
    expect(mail.forwarded).toEqual([{ subject: 'Billet', from: 'train@example.com', date: '' }]);
  });

  it('turns HTML into text without markup', () => {
    const text = htmlToText('<html><head><title>x</title><style>p{}</style></head><body><!-- c --><table><tr><td>Booking</td><td>AB&amp;12</td></tr><tr><td>Date</td><td>3&nbsp;May</td></tr></table><p>Line<br>two &#8211; &#x2192;</p><img src="x" onerror="alert(1)"></body></html>');
    expect(text).toBe('Booking AB&12\nDate 3 May\n\nLine\ntwo – →');
  });
});
