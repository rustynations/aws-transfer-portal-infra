import { randomBytes, randomUUID, createHash } from 'crypto';

/**
 * API Key Generation and Hashing Utilities
 *
 * Generates API keys with the format: tpk_<base64url-encoded 32 bytes>
 * Keys are hashed with SHA-256 before storage — the raw key is never persisted.
 *
 * Requirements: 1.3, 5.1, 5.4
 */

export interface GeneratedApiKey {
  rawKey: string;
  keyHash: string;
  keyId: string;
}

/**
 * Generate a new API key with a unique ID.
 *
 * Returns the raw key (shown once to the user), its SHA-256 hash (stored in DynamoDB),
 * and a UUID key ID (used as the DynamoDB partition key).
 */
export function generateApiKey(): GeneratedApiKey {
  const secret = randomBytes(32);
  const rawKey = `tpk_${secret.toString('base64url')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const keyId = randomUUID();
  return { rawKey, keyHash, keyId };
}

/**
 * Hash a raw API key using SHA-256.
 *
 * Used by the authorizer to look up keys by hash in the API Keys Table.
 */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}
