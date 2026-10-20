import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { signatureBlock, withSignature, isSignatureOnly } from '../src/lib/compose.js';
import { openCompose } from '../src/ui/compose.js';
import { openSignatureDialog } from '../src/ui/signature.js';

/**
 * The signature: where it goes into a message, and the dialog it is set in.
 */

describe('signatureBlock', () => {
  it('is nothing for no signature', () => {
    expect(signatureBlock('')).toBe('');
    expect(signatureBlock('   \n ')).toBe('');
    expect(signatureBlock(undefined)).toBe('');
  });

  it('puts the signature under the standard separator', () => {
    expect(signatureBlock('Ana\nPuter')).toBe('\n\n-- \nAna\nPuter');
  });

  it('normalises line endings and trims the edges', () => {
    expect(signatureBlock('\r\nAna\r\nPuter\r\n')).toBe('\n\n-- \nAna\nPuter');
  });
});

describe('withSignature', () => {
  it('leaves a body alone when there is no signature', () => {
    expect(withSignature('hello', '')).toBe('hello');
    expect(withSignature('', '')).toBe('');
  });

  it('is the whole body of a new message', () => {
    expect(withSignature('', 'Ana')).toBe('\n\n-- \nAna');
  });

  it('goes above the quoted text of a reply, with the caret room kept in front', () => {
    const quoted = '\n\nOn Monday, Leo wrote:\n> hi';
    expect(withSignature(quoted, 'Ana')).toBe('\n\n-- \nAna\n\nOn Monday, Leo wrote:\n> hi');
  });

  it('separates itself from a body that does not start on a new line', () => {
    expect(withSignature('---------- Forwarded message ----------', 'Ana'))
      .toBe('\n\n-- \nAna\n---------- Forwarded message ----------');
  });
});

describe('isSignatureOnly', () => {
  it('stays linear on a long run of spaces', () => {
    const start = performance.now();
    expect(isSignatureOnly(`a${' '.repeat(16000)}x`, 'sig')).toBe(false);
    expect(isSignatureOnly('-- \nAna   \n', 'Ana')).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('recognises a body that is nothing but the signature', () => {
    expect(isSignatureOnly('\n\n-- \nAna', 'Ana')).toBe(true);
    // A draft saved before the editor kept the separator's space holds `--`.
    expect(isSignatureOnly('--\nAna', 'Ana')).toBe(true);
  });

  it('is false once anything has been written', () => {
    expect(isSignatureOnly('hi\n\n-- \nAna', 'Ana')).toBe(false);
    expect(isSignatureOnly('', 'Ana')).toBe(false);
    expect(isSignatureOnly('-- \nAna', '')).toBe(false);
  });
});

// -- in the dialog -------------------------------------------------------------------

const draftStore = () => {
  const held = new Map();
  return {
    list: () => [...held.values()],
    get: (id) => held.get(id) ?? null,
    get count() { return held.size; },
    save(draft) {
      held.set(draft.id, draft);
      return true;
    },
    remove(id) {
      return held.delete(id);
    },
  };
};

const bodyText = (modal) => modal.panel.querySelector('.rte-body').textContent;
const lines = (modal) => [...modal.panel.querySelectorAll('.rte-body > div')]
  .map((node) => node.textContent);

beforeEach(() => {
  globalThis.puter = { ui: {}, fs: {}, APIOrigin: 'https://api.example', authToken: 't' };
});

afterEach(() => {
  document.querySelectorAll('.modal-root').forEach((node) => node.remove());
  delete globalThis.puter;
});

describe('the compose dialog with a signature', () => {
  it('starts a new message with the signature at the foot', () => {
    const modal = openCompose({
      username: 'me', mailPath: '/me/.mail', prefill: null, drafts: draftStore(),
      signature: 'Ana\nPuter',
    });
    expect(lines(modal)).toEqual(['', '', '-- ', 'Ana', 'Puter']);
    modal.close(true);
  });

  it('puts the signature between the answer and the quoted text of a reply', () => {
    const modal = openCompose({
      username: 'me', mailPath: '/me/.mail',
      prefill: { kind: 'reply', to: 'leo@example.com', subject: 'Re: hi', body: '\n\nOn Monday, Leo wrote:\n> hi' },
      drafts: draftStore(),
      signature: 'Ana',
    });
    expect(lines(modal)).toEqual(['', '', '-- ', 'Ana', '', 'On Monday, Leo wrote:']);
    // The quoted line itself is a blockquote, under the signature.
    expect(modal.panel.querySelector('.rte-body blockquote').textContent).toBe('hi');
    modal.close(true);
  });

  it('does not sign a resumed draft a second time', () => {
    const drafts = draftStore();
    const draft = {
      id: 'd1', updated: 1, attachments: 0, domain: 'puter.email', to: 'a@b.co', cc: '',
      subject: 's', body: 'so far\n\n-- \nAna', html: '', inReplyTo: '', references: '',
    };
    drafts.save(draft);
    const modal = openCompose({
      username: 'me', mailPath: '/me/.mail', prefill: null, drafts, draft, signature: 'Ana',
    });
    expect(bodyText(modal)).toBe('so far-- Ana');
    modal.close(true);
  });

  it('sends nothing but the message when there is no signature', () => {
    const modal = openCompose({
      username: 'me', mailPath: '/me/.mail', prefill: null, drafts: draftStore(),
    });
    expect(bodyText(modal)).toBe('');
    modal.close(true);
  });

  it('leaves no draft behind when a signed message is closed untouched', () => {
    const drafts = draftStore();
    const modal = openCompose({
      username: 'me', mailPath: '/me/.mail', prefill: null, drafts, signature: 'Ana',
    });
    modal.close();
    expect(drafts.count).toBe(0);
    expect(document.querySelector('.modal-root')).toBe(null);
  });

  it('does not sign an unsubscribe request, whose body belongs to the list', () => {
    const modal = openCompose({
      username: 'me', mailPath: '/me/.mail', signature: 'Ana',
      prefill: { kind: 'unsubscribe', to: 'leave@list.example', subject: 'unsubscribe', body: 'TOKEN-123' },
    });
    expect(bodyText(modal)).toBe('TOKEN-123');
    modal.close(true);
  });

  it('keeps a draft once something has been written above the signature', () => {
    const drafts = draftStore();
    const modal = openCompose({
      username: 'me', mailPath: '/me/.mail', prefill: null, drafts, signature: 'Ana',
    });
    const body = modal.panel.querySelector('.rte-body');
    body.firstChild.textContent = 'hello';
    body.dispatchEvent(new Event('input', { bubbles: true }));
    modal.close();
    expect(drafts.count).toBe(1);
    expect(drafts.list()[0].body).toBe('hello\n\n-- \nAna');
  });
});

describe('the signature dialog', () => {
  it('shows the stored signature, and saves the edited one', () => {
    let saved = null;
    const modal = openSignatureDialog({ value: 'Ana', onSave: (text) => { saved = text; } });
    const input = modal.panel.querySelector('#signature-text');
    expect(input.value).toBe('Ana');
    expect(modal.panel.querySelector('.signature-preview').textContent).toBe('-- \nAna');

    input.value = 'Ana\nPuter  \n';
    input.dispatchEvent(new Event('input'));
    expect(modal.panel.querySelector('.signature-preview').textContent).toBe('-- \nAna\nPuter');
    modal.panel.querySelector('.signature-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(saved).toBe('Ana\nPuter');
    expect(document.querySelector('.modal-root')).toBe(null);
  });

  it('saves nothing when cancelled, or when nothing changed', () => {
    let saves = 0;
    const cancelled = openSignatureDialog({ value: 'Ana', onSave: () => { saves++; } });
    cancelled.panel.querySelector('.btn:not(.btn-primary)').click();
    expect(document.querySelector('.modal-root')).toBe(null);

    const unchanged = openSignatureDialog({ value: 'Ana', onSave: () => { saves++; } });
    unchanged.panel.querySelector('.signature-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(saves).toBe(0);
  });

  it('saves an emptied signature as removal', () => {
    let saved = 'unset';
    const modal = openSignatureDialog({ value: 'Ana', onSave: (text) => { saved = text; } });
    const input = modal.panel.querySelector('#signature-text');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(modal.panel.querySelector('.signature-preview').hidden).toBe(true);
    modal.panel.querySelector('.btn-primary').click();
    expect(saved).toBe('');
  });
});
