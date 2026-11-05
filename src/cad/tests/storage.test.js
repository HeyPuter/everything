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
});
