import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseHeaders } from '../src/lib/mime.js';
import { parseSenderAuth, senderNotice } from '../src/lib/senderauth.js';
import { renderApp } from '../src/ui/app.js';

/**
 * Puter checks mail that names one of its own domains as the sender and
 * records the result in the first X-Puter-Sender-Auth header. A message that
 * claims to be from Puter and isn't is the one a reader most needs warning
 * about, before they read a word of it.
 */

const head = (...lines) => parseHeaders(lines.join('\r\n'));

describe('reading the sender check', () => {
  it('reads the result, the claimed domains and the signers', () => {
    expect(parseSenderAuth(head(
      'X-Puter-Sender-Auth: pass; from=puter.com; signed-by=puter.com,amazonses.com',
    ))).toEqual({ result: 'pass', from: ['puter.com'], signedBy: ['puter.com', 'amazonses.com'], local: false });
    expect(parseSenderAuth(head(
      'X-Puter-Sender-Auth: temperror; from=puter.com,puter.email; signed-by=none; via=local',
    ))).toEqual({ result: 'temperror', from: ['puter.com', 'puter.email'], signedBy: [], local: true });
  });

  it('takes only the first header, which is the one Puter writes', () => {
    expect(parseSenderAuth(head(
      'X-Puter-Sender-Auth: fail; from=puter.com; signed-by=none',
      'From: Puter <security@puter.com>',
      'X-Puter-Sender-Auth: pass; from=puter.com; signed-by=puter.com',
    )).result).toBe('fail');
  });

  it('has nothing for a message that was not checked, or a result it does not know', () => {
    expect(parseSenderAuth(head('From: Ana <ana@example.com>'))).toBeNull();
    expect(parseSenderAuth(head('X-Puter-Sender-Auth: probably; from=puter.com'))).toBeNull();
  });

  it('has nothing for a stamp that names no domain, and keeps the first of a repeated field', () => {
    expect(parseSenderAuth(head('X-Puter-Sender-Auth: fail'))).toBeNull();
    expect(parseSenderAuth(head('X-Puter-Sender-Auth: fail; from=none; signed-by=none'))).toBeNull();
    expect(parseSenderAuth(head(
      'X-Puter-Sender-Auth: fail; from=puter.com; from=example.com; signed-by=none',
    )).from).toEqual(['puter.com']);
  });
});

describe('what the reader is told', () => {
  it('says nothing about a sender that passed, or mail that was not checked', () => {
    expect(senderNotice(null)).toBeNull();
    expect(senderNotice({ result: 'pass', from: ['puter.com'], signedBy: ['puter.com'], local: false })).toBeNull();
  });

  it('warns that a failed message may not be from who it says', () => {
    const notice = senderNotice({ result: 'fail', from: ['puter.com'], signedBy: [], local: false });
    expect(notice.level).toBe('fail');
    expect(notice.text).toContain("says it is from puter.com, but it isn't signed by puter.com and may be forged");
  });

  it('treats a check that could not finish as an unverified sender', () => {
    const notice = senderNotice({ result: 'temperror', from: ['puter.com'], signedBy: [], local: false });
    expect(notice.level).toBe('unverified');
    expect(notice.text).toContain("couldn't confirm that this message came from puter.com");
  });
});

// -- in the reading pane --------------------------------------------------------

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

const DAY = '2026-09-14';
const NAME = '019965b0-0000-7000-8000-000000000001--UGhpc2g';
const mailPath = '/sample/.mail';

const message = (stamp) => new TextEncoder().encode([
  ...(stamp ? [`X-Puter-Sender-Auth: ${stamp}`] : []),
  'From: Puter Security <security@puter.com>',
  'To: sample@puter.email',
  'Subject: Verify your account',
  'Date: Mon, 14 Sep 2026 09:00:00 +0000',
  'Message-ID: <verify-1@puter.com>',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Click the link to keep your account.',
  '--b1',
  'Content-Type: application/pdf; name="invoice.pdf"',
  'Content-Disposition: attachment; filename="invoice.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERi0xLjQK',
  '--b1--',
  '',
].join('\r\n'));

const open = async (root, box, raw, folder) => {
  const dir = `${mailPath}/${box}`;
  const path = `${dir}/${DAY}/${NAME}`;
  const fs = {
    async readdir(at) {
      if (at === dir) return [{ name: DAY, path: `${dir}/${DAY}`, is_dir: true }];
      if (at === `${dir}/${DAY}`) {
        return [{ name: NAME, path, is_dir: false, size: raw.length, modified: 1789376400 }];
      }
      throw new Error(`No such directory: ${at}`);
    },
    async read(at, opts = {}) {
      if (at !== path) throw new Error(`No such file: ${at}`);
      return new Blob([opts.byte_count ? raw.slice(0, opts.byte_count) : raw]);
    },
  };
  renderApp(root, {
    fs, mailPath, objectsPath: `${mailPath}/objects`, sample: true, account: { username: 'sample' },
    onCompose: () => {},
  });
  await settle(500);
  if (folder) {
    [...root.querySelectorAll('.nav-item')].find((item) => item.textContent.includes(folder)).click();
    await settle(500);
  }
  root.querySelector('.row').click();
  await settle(500);
};

describe('a message in the reading pane', () => {
  let root;

  beforeEach(() => {
    root = document.createElement('div');
    root.id = 'app';
    document.body.append(root);
  });

  afterEach(() => {
    root.remove();
    document.querySelectorAll('.toast, .menu, .modal-root').forEach((node) => node.remove());
  });

  it('carries the warning above everything else when the check failed', async () => {
    await open(root, 'objects', message('fail; from=puter.com; signed-by=none'));
    const notice = root.querySelector('.msg-sender-check');
    expect(notice.classList.contains('is-fail')).toBe(true);
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain('may be forged');
    // Before the attachments and the text, wherever each sits.
    for (const selector of ['.msg-attachments', '.msg-body']) {
      const later = root.querySelector(selector);
      expect(notice.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('says the sender is unverified when the check could not finish', async () => {
    await open(root, 'objects', message('temperror; from=puter.com; signed-by=none'));
    const notice = root.querySelector('.msg-sender-check');
    expect(notice.classList.contains('is-unverified')).toBe(true);
    expect(notice.textContent).toContain("couldn't confirm");
  });

  it.each([
    ['passed', 'pass; from=puter.com; signed-by=puter.com'],
    ['was never checked', null],
  ])('shows nothing for a message that %s', async (_label, stamp) => {
    await open(root, 'objects', message(stamp));
    expect(root.querySelector('.msg-body').textContent).toContain('Click the link');
    expect(root.querySelector('.msg-sender-check')).toBeNull();
  });

  it('shows nothing on mail the user sent', async () => {
    await open(root, 'sent', message('fail; from=puter.com; signed-by=none'), 'Sent');
    expect(root.querySelector('.msg-body').textContent).toContain('Click the link');
    expect(root.querySelector('.msg-sender-check')).toBeNull();
  });
});
