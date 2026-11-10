import { describe, it, expect } from 'vitest';
import { isAuthError, isExistsError, errorText } from '../src/io/storage.js';

describe('storage: Puter error classification', () => {
  it('recognises an expired or missing session', () => {
    expect(
      isAuthError({ error: { code: 'token_auth_failed', message: 'Authentication failed.' } }),
    ).toBe(true);
    expect(isAuthError({ code: 'unauthorized', message: 'Not signed in' })).toBe(true);
    expect(isAuthError({ message: 'Authentication failed' })).toBe(true);
    expect(isAuthError({ status: 401 })).toBe(true);
  });

  it('does not treat other failures as a session problem', () => {
    const exists = {
      code: 'item_with_same_name_exists',
      message: 'An item with that name already exists.',
    };
    expect(isAuthError(exists)).toBe(false);
    expect(isExistsError(exists)).toBe(true);
    expect(isAuthError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isAuthError({ error: { code: 'storage_limit_reached' } })).toBe(false);
    expect(errorText({ error: { message: 'Quota' } })).toBe('Quota');
  });

  it('does not take a missing folder or file for a name that is already used', () => {
    // Puter's codes for a missing destination or source contain the word "exist"
    expect(isExistsError({ code: 'dest_does_not_exist', message: 'Destination does not exist.' })).toBe(false);
    expect(isExistsError({ error: { code: 'subject_does_not_exist', message: 'The file does not exist.' } })).toBe(false);
    expect(isExistsError({ code: 'item_with_same_name_exists', message: 'An item with name `a.cad` already exists.' })).toBe(true);
    expect(isExistsError({ message: 'File already exists' })).toBe(true);
  });
});
