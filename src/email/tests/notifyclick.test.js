import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';
import { createDraftStore } from '../src/lib/drafts.js';
import { memoryStorage } from '../src/lib/readstate.js';
import { createSettings } from '../src/lib/settings.js';
import { stopListening } from '../src/ui/push.js';

/**
 * A desktop notification for new mail, and what its click opens. The
 * Notification itself is a stub that records what was shown.
 */

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

const LATE = [
  'From: Ana Petrova <ana@example.com>',
  'To: sample@puter.com',
  'Subject: Late arrival',
  'Date: Mon, 17 Aug 2026 10:30:00 GMT',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'One more thing before the quarter closes.',
].join('\r\n');

let root;
let mailbox;
let shown;
let hadFocus;

class FakeNotification {
  static permission = 'granted';

  constructor(title, options) {
    this.title = title;
    this.options = options;
    shown.push(this);
  }

  close() { this.closed = true; }
}

const mount = async (extra = {}) => {
  mailbox = createSampleMailbox();
  const app = renderApp(root, {
    ...mailbox,
    sample: false,
    account: { username: 'tester' },
    drafts: createDraftStore('tester', memoryStorage()),
    onCompose: () => {},
    ...extra,
  });
  await settle();
  return app;
};

const deliver = async (subject = 'Late arrival', raw = LATE, suffix = 'f') => {
  const { fs, objectsPath } = mailbox;
  const days = (await fs.readdir(objectsPath))
    .filter((item) => item.is_dir)
    .map((item) => item.name)
    .sort();
  const name = `ffffffff-ffff-7fff-8fff-fffffffffff${suffix}--${btoa(subject).replace(/=+$/, '')}`;
  await fs.write(`${objectsPath}/${days[days.length - 1]}/${name}`, new Blob([raw]));
  document.dispatchEvent(new Event('visibilitychange'));
  await settle(700);
};

const openSubject = () => root.querySelector('.msg-subject')?.firstChild?.textContent;
const reading = () => root.querySelector('.app-frame').classList.contains('reading');

beforeEach(() => {
  window.localStorage.clear();
  shown = [];
  window.Notification = FakeNotification;
  hadFocus = document.hasFocus;
  document.hasFocus = () => false;
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
});

afterEach(async () => {
  await stopListening();
  vi.unstubAllGlobals();
  root.remove();
  delete window.Notification;
  document.hasFocus = hadFocus;
  document.querySelectorAll('.toast').forEach((node) => node.remove());
  window.localStorage.clear();
});

describe('a new-mail notification', () => {
  it('names the sender and the subject', async () => {
    await mount();
    await deliver();
    expect(shown).toHaveLength(1);
    expect(shown[0].options.body).toBe('Ana Petrova — Late arrival');
  });

  it('opens the message when clicked', async () => {
    await mount();
    await deliver();
    expect(reading()).toBe(false);
    shown[0].onclick();
    await settle();
    expect(reading()).toBe(true);
    expect(openSubject()).toBe('Late arrival');
    expect(shown[0].closed).toBe(true);
  });

  it('opens it out of another folder and a search', async () => {
    await mount();
    [...root.querySelectorAll('.nav-item')].find((n) => n.textContent.includes('Archive')).click();
    await settle();
    const input = root.querySelector('.search-input');
    input.value = 'nothing-matches-this';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(500);

    await deliver();
    shown[0].onclick();
    await settle(500);

    expect(root.querySelector('.nav-item[aria-current="true"]').textContent).toContain('Inbox');
    expect(root.querySelector('.search-input').value).toBe('');
    expect(openSubject()).toBe('Late arrival');
  });

  it('goes to the top of the inbox for several at once', async () => {
    await mount();
    const { fs, objectsPath } = mailbox;
    const days = (await fs.readdir(objectsPath)).filter((i) => i.is_dir).map((i) => i.name).sort();
    const day = days[days.length - 1];
    await fs.write(`${objectsPath}/${day}/ffffffff-ffff-7fff-8fff-fffffffffffa--${btoa('First')}`, new Blob([LATE]));
    await fs.write(`${objectsPath}/${day}/ffffffff-ffff-7fff-8fff-fffffffffffb--${btoa('Second')}`, new Blob([LATE]));
    document.dispatchEvent(new Event('visibilitychange'));
    await settle(700);

    expect(shown[0].options.body).toBe('2 new messages');
    shown[0].onclick();
    await settle();
    expect(reading()).toBe(false);
    expect(document.activeElement.classList.contains('row')).toBe(true);
  });
});

describe('with pushes on', () => {
  const ID = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
  let sdk;

  const mountWithPush = () => {
    sdk = {
      env: 'web',
      notifications: { status: vi.fn(async () => 'on'), onPush: vi.fn(async () => ({ off: async () => {} })) },
      events: {
        list: vi.fn(async () => []),
        onPersistent: vi.fn(async (options) => ({ subId: 'sub-1', ...options })),
        unsubscribe: vi.fn(async () => {}),
      },
    };
    vi.stubGlobal('puter', sdk);
    const settings = createSettings('tester', memoryStorage());
    settings.set('push', true);
    return mount({ canPush: true, settings });
  };

  it('handles pushes and keeps the subscription, without asking for anything', async () => {
    await mountWithPush();
    expect(sdk.notifications.onPush).toHaveBeenCalledWith('mail', expect.any(Function));
    expect(sdk.events.onPersistent).toHaveBeenCalledWith(expect.objectContaining({
      queue: true, context: { previews: true, self: ['tester@puter.email'] },
    }));
  });

  it('uses SDK status for the switch even when the saved preference disagrees', async () => {
    await mountWithPush();
    sdk.notifications.status.mockResolvedValue('off');
    root.querySelector('[aria-label="Settings"]').click();
    await settle();
    const toggle = [...root.querySelectorAll('[role="menuitemcheckbox"]')]
      .find((node) => node.textContent.includes('Notify me on this device'));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(sdk.notifications.status).toHaveBeenCalled();
  });

  it('leaves the banner to Puter rather than showing a second one', async () => {
    await mountWithPush();
    await deliver();
    expect(shown).toHaveLength(0);
  });

  it('opens the message a push was about, delivered after the inbox was listed', async () => {
    const app = await mountWithPush();
    const { fs, objectsPath } = mailbox;
    const days = (await fs.readdir(objectsPath)).filter((i) => i.is_dir).map((i) => i.name).sort();
    await fs.write(`${objectsPath}/${days[days.length - 1]}/${ID}--${btoa('Late arrival')}`, new Blob([LATE]));
    await app.openMessage(ID);
    await settle();
    expect(reading()).toBe(true);
    expect(openSubject()).toBe('Late arrival');
  });

  it('goes to the top of the inbox for a push that names no message', async () => {
    const app = await mountWithPush();
    await app.openMessage(null);
    await settle();
    expect(reading()).toBe(false);
    expect(document.activeElement.classList.contains('row')).toBe(true);
  });
});
