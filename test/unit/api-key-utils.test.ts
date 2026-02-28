/**
 * Unit tests for API key generation and hashing utilities
 * Requirements: 1.3, 5.1, 5.4
 */

import { generateApiKey, hashApiKey } from '../../src/lambda/api/api-key-utils';
import { createHash } from 'crypto';

describe('generateApiKey', () => {
  it('returns rawKey, keyHash, and keyId', () => {
    const result = generateApiKey();
    expect(result).toHaveProperty('rawKey');
    expect(result).toHaveProperty('keyHash');
    expect(result).toHaveProperty('keyId');
  });

  it('produces a rawKey with tpk_ prefix', () => {
    const { rawKey } = generateApiKey();
    expect(rawKey.startsWith('tpk_')).toBe(true);
  });

  it('produces a rawKey whose base64url portion decodes to 32 bytes', () => {
    const { rawKey } = generateApiKey();
    const encoded = rawKey.slice(4); // strip "tpk_"
    const decoded = Buffer.from(encoded, 'base64url');
    expect(decoded.length).toBe(32);
  });

  it('produces a keyHash that matches SHA-256 of the rawKey', () => {
    const { rawKey, keyHash } = generateApiKey();
    const expected = createHash('sha256').update(rawKey).digest('hex');
    expect(keyHash).toBe(expected);
  });

  it('produces a valid UUID v4 keyId', () => {
    const { keyId } = generateApiKey();
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(keyId).toMatch(uuidV4Regex);
  });

  it('generates unique keys on each call', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.rawKey).not.toBe(b.rawKey);
    expect(a.keyHash).not.toBe(b.keyHash);
    expect(a.keyId).not.toBe(b.keyId);
  });
});

describe('hashApiKey', () => {
  it('returns the SHA-256 hex digest of the input', () => {
    const input = 'tpk_testvalue';
    const expected = createHash('sha256').update(input).digest('hex');
    expect(hashApiKey(input)).toBe(expected);
  });

  it('is consistent with the hash from generateApiKey', () => {
    const { rawKey, keyHash } = generateApiKey();
    expect(hashApiKey(rawKey)).toBe(keyHash);
  });

  it('returns a 64-character hex string', () => {
    const hash = hashApiKey('tpk_anything');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
