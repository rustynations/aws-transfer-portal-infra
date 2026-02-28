/**
 * Property-Based Tests: API Key Generation Round-Trip
 * Feature: api-keys
 *
 * Tests Property 1 for API key generation hash consistency.
 */

import * as fc from 'fast-check';
import { generateApiKey, hashApiKey } from '../src/lambda/api/api-key-utils';

// ---------------------------------------------------------------------------
// Property 1: Key generation round-trip (hash consistency)
// ---------------------------------------------------------------------------
describe('Feature: api-keys, Property 1: Key generation round-trip (hash consistency)', () => {
  /**
   * **Validates: Requirements 1.1, 1.2, 1.3, 5.1**
   *
   * For any generated API key, computing SHA-256 of the returned raw key should
   * produce a value identical to the keyHash stored in the API Keys Table.
   * Additionally, no field in the stored record should equal the raw key.
   */
  it('hashApiKey(rawKey) should equal keyHash, and keyId/keyHash should not equal rawKey', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const { rawKey, keyHash, keyId } = generateApiKey();

        // Hash round-trip: hashing the raw key must produce the same keyHash
        expect(hashApiKey(rawKey)).toBe(keyHash);

        // No stored field should equal the raw key
        expect(keyId).not.toBe(rawKey);
        expect(keyHash).not.toBe(rawKey);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Key format invariant
// ---------------------------------------------------------------------------
describe('Feature: api-keys, Property 2: Key format invariant', () => {
  /**
   * **Validates: Requirements 5.4**
   *
   * For any generated API key, the raw key should start with the prefix `tpk_`
   * and the portion after the prefix should decode from base64url to exactly
   * 32 bytes. The keyId should be a valid UUID format.
   */
  it('rawKey starts with tpk_, base64url payload is exactly 32 bytes, and keyId is a valid UUID', () => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    fc.assert(
      fc.property(fc.constant(null), () => {
        const { rawKey, keyId } = generateApiKey();

        // 1. rawKey starts with tpk_
        expect(rawKey.startsWith('tpk_')).toBe(true);

        // 2. The portion after tpk_ decodes from base64url to exactly 32 bytes
        const payload = rawKey.slice(4);
        const decoded = Buffer.from(payload, 'base64url');
        expect(decoded.length).toBe(32);

        // 3. keyId is a valid UUID format
        expect(keyId).toMatch(uuidRegex);
      }),
      { numRuns: 100 },
    );
  });
});
