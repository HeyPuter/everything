// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { createRestrictEditing } from '../src/views/restrict-editing.js';

globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// writeProtection (ECMA-376 Part 1 §17.15.1.93) holds both the read-only recommendation and the
// password to modify the document. File > Always Open Read-Only changes only the recommendation.
it('keeps the password to modify when Always Open Read-Only is turned on or off', () => {
  const password = { algorithmName: 'SHA-512', hashValue: 'aGFzaA==', saltValue: 'c2FsdA==', spinCount: 100000 };
  const pkg = { reviewSettings: { writeProtection: { recommended: false, ...password } } };
  const restrict = createRestrictEditing({ editor: () => null, pkg: () => pkg, error: e => { throw e; }, author: () => 'Me' });
  restrict.toggleAlwaysReadOnly();
  expect(restrict.alwaysReadOnly).toBe(true);
  // Turning it on replaced the record, and with it the password.
  expect(pkg.reviewSettings.writeProtection).toEqual({ recommended: true, ...password });
  restrict.toggleAlwaysReadOnly();
  expect(restrict.alwaysReadOnly).toBe(false);
  expect(pkg.reviewSettings.writeProtection).toEqual({ recommended: false, ...password });
  // Without a password, turning it off removes the setting.
  const plain = { reviewSettings: { writeProtection: { recommended: true } } };
  const other = createRestrictEditing({ editor: () => null, pkg: () => plain, error: e => { throw e; }, author: () => 'Me' });
  other.toggleAlwaysReadOnly();
  expect(plain.reviewSettings.writeProtection).toBeNull();
  restrict.destroy(); other.destroy();
});
