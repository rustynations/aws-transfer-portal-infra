/**
 * Property-Based Tests: API Key Authorizer
 * Feature: api-keys
 *
 * Tests Property 3 for the API Key Authorizer Lambda.
 */

import * as fc from 'fast-check';
import { generateApiKey, hashApiKey } from '../src/lambda/api/api-key-utils';

// Mock send function — declared before jest.mock (hoisting)
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockSend })),
  QueryCommand: jest.fn((p: any) => ({ _type: 'Query', ...p })),
  GetItemCommand: jest.fn((p: any) => ({ _type: 'GetItem', ...p })),
  UpdateItemCommand: jest.fn((p: any) => ({ _type: 'UpdateItem', ...p })),
}));

jest.mock('@aws-sdk/util-dynamodb', () => ({
  unmarshall: jest.fn((item: any) => item),
}));

// Set env vars before importing handler
process.env.API_KEYS_TABLE = 'test-api-keys';
process.env.USERS_TABLE = 'test-users';

import { handler, AuthorizerEvent, AuthorizerResponse } from '../src/lambda/api/api-key-authorizer';


/**
 * Arbitrary: generates a valid username (alphanumeric, 1–20 chars).
 */
const usernameArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z0-9]+$/.test(s));

/**
 * Arbitrary: generates a valid email address.
 */
const emailArb = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 10 }).filter((s) => /^[a-zA-Z0-9]+$/.test(s)),
    fc.string({ minLength: 1, maxLength: 8 }).filter((s) => /^[a-zA-Z0-9]+$/.test(s)),
  )
  .map(([local, domain]) => `${local}@${domain}.com`);

/**
 * Arbitrary: generates an optional expiresAt in the future (or undefined for no expiry).
 */
const futureExpiryArb = fc.oneof(
  fc.constant(undefined),
  fc.integer({ min: Date.now() + 60_000, max: Date.now() + 365 * 24 * 60 * 60 * 1000 }),
);

/**
 * Helper: build a TOKEN authorizer event.
 */
function makeAuthorizerEvent(apiKey: string): AuthorizerEvent {
  return {
    type: 'TOKEN',
    authorizationToken: apiKey,
    methodArn: 'arn:aws:execute-api:us-east-1:123456789012:abc123/prod/GET/resource',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Property 3: Authorizer allows valid keys
// ---------------------------------------------------------------------------
describe('Feature: api-keys, Property 3: Authorizer allows valid keys', () => {
  /**
   * **Validates: Requirements 2.1**
   *
   * For any API key that is active (not revoked), not expired, and belongs to
   * a non-disabled user, the API Key Authorizer should return an Allow policy
   * with the correct username and email in the context.
   */
  it('should return Allow with correct context for any valid, active, non-expired key of a non-disabled user', async () => {
    await fc.assert(
      fc.asyncProperty(
        usernameArb,
        emailArb,
        futureExpiryArb,
        async (username, email, expiresAt) => {
          jest.clearAllMocks();

          // Generate a real API key
          const { rawKey, keyHash, keyId } = generateApiKey();

          // Set up mock: QueryCommand returns active key, GetItemCommand returns non-disabled user
          mockSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Query') {
              return Promise.resolve({
                Items: [
                  {
                    keyId,
                    keyHash,
                    username,
                    status: 'active',
                    createdAt: Date.now(),
                    ...(expiresAt !== undefined ? { expiresAt } : {}),
                  },
                ],
              });
            }
            if (cmd._type === 'GetItem') {
              return Promise.resolve({
                Item: {
                  username,
                  email,
                  disabled: false,
                },
              });
            }
            if (cmd._type === 'UpdateItem') {
              return Promise.resolve({});
            }
            return Promise.resolve({});
          });

          const event = makeAuthorizerEvent(rawKey);
          const response: AuthorizerResponse = await handler(event);

          // Should return Allow
          expect(response.policyDocument.Statement[0].Effect).toBe('Allow');

          // Context should contain correct username, email, and keyId
          expect(response.context.username).toBe(username);
          expect(response.context.email).toBe(email);
          expect(response.context.keyId).toBe(keyId);

          // principalId should be the username
          expect(response.principalId).toBe(username);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Authorizer denies invalid keys
// ---------------------------------------------------------------------------
describe('Feature: api-keys, Property 4: Authorizer denies invalid keys', () => {
  /**
   * **Validates: Requirements 2.2, 2.3, 2.4, 2.5**
   *
   * For any API key that is revoked, expired, or belongs to a disabled user,
   * or for any string that does not match a stored key hash, the API Key
   * Authorizer should return a Deny policy.
   */

  /**
   * Arbitrary: generates a past expiresAt timestamp (already expired).
   */
  const pastExpiryArb = fc.integer({ min: 0, max: Date.now() - 60_000 });

  /**
   * Arbitrary: generates a random string that is NOT a valid tpk_ key,
   * ensuring it won't match any stored hash.
   */
  const unknownKeyArb = fc
    .string({ minLength: 1, maxLength: 64 })
    .filter((s) => !s.startsWith('tpk_'));

  type DenialScenario = 'unknown_key' | 'revoked_key' | 'expired_key' | 'disabled_user';

  /**
   * Arbitrary: picks one of the four denial scenarios.
   */
  const denialScenarioArb: fc.Arbitrary<DenialScenario> = fc.oneof(
    fc.constant<DenialScenario>('unknown_key'),
    fc.constant<DenialScenario>('revoked_key'),
    fc.constant<DenialScenario>('expired_key'),
    fc.constant<DenialScenario>('disabled_user'),
  );

  it('should return Deny for any revoked, expired, disabled-user, or unknown key', async () => {
    await fc.assert(
      fc.asyncProperty(
        denialScenarioArb,
        usernameArb,
        emailArb,
        unknownKeyArb,
        pastExpiryArb,
        async (scenario, username, email, unknownKey, pastExpiry) => {
          jest.clearAllMocks();

          const { rawKey, keyHash, keyId } = generateApiKey();

          let apiKeyToUse: string;

          switch (scenario) {
            case 'unknown_key': {
              // Use a key whose hash won't be found in the table
              apiKeyToUse = unknownKey;
              mockSend.mockImplementation((cmd: any) => {
                if (cmd._type === 'Query') {
                  return Promise.resolve({ Items: [] });
                }
                return Promise.resolve({});
              });
              break;
            }

            case 'revoked_key': {
              apiKeyToUse = rawKey;
              mockSend.mockImplementation((cmd: any) => {
                if (cmd._type === 'Query') {
                  return Promise.resolve({
                    Items: [
                      {
                        keyId,
                        keyHash,
                        username,
                        status: 'revoked',
                        createdAt: Date.now(),
                        revokedAt: Date.now(),
                      },
                    ],
                  });
                }
                return Promise.resolve({});
              });
              break;
            }

            case 'expired_key': {
              apiKeyToUse = rawKey;
              mockSend.mockImplementation((cmd: any) => {
                if (cmd._type === 'Query') {
                  return Promise.resolve({
                    Items: [
                      {
                        keyId,
                        keyHash,
                        username,
                        status: 'active',
                        createdAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
                        expiresAt: pastExpiry,
                      },
                    ],
                  });
                }
                return Promise.resolve({});
              });
              break;
            }

            case 'disabled_user': {
              apiKeyToUse = rawKey;
              mockSend.mockImplementation((cmd: any) => {
                if (cmd._type === 'Query') {
                  return Promise.resolve({
                    Items: [
                      {
                        keyId,
                        keyHash,
                        username,
                        status: 'active',
                        createdAt: Date.now(),
                      },
                    ],
                  });
                }
                if (cmd._type === 'GetItem') {
                  return Promise.resolve({
                    Item: {
                      username,
                      email,
                      disabled: true,
                    },
                  });
                }
                return Promise.resolve({});
              });
              break;
            }
          }

          const event = makeAuthorizerEvent(apiKeyToUse);
          const response: AuthorizerResponse = await handler(event);

          // All denial scenarios must return Deny
          expect(response.policyDocument.Statement[0].Effect).toBe('Deny');
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 5: Revocation makes keys immediately unusable
// ---------------------------------------------------------------------------
describe('Feature: api-keys, Property 5: Revocation makes keys immediately unusable', () => {
  /**
   * **Validates: Requirements 3.1, 3.2**
   *
   * For any active API key, after the revoke operation is performed,
   * the API Key Authorizer should return a Deny policy for that key.
   */
  it('should return Deny for any key that was active then revoked', async () => {
    await fc.assert(
      fc.asyncProperty(
        usernameArb,
        emailArb,
        async (username, email) => {
          jest.clearAllMocks();

          const { rawKey, keyHash, keyId } = generateApiKey();
          const createdAt = Date.now();

          // Phase 1: key is active — authorizer should Allow
          mockSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Query') {
              return Promise.resolve({
                Items: [
                  {
                    keyId,
                    keyHash,
                    username,
                    status: 'active',
                    createdAt,
                  },
                ],
              });
            }
            if (cmd._type === 'GetItem') {
              return Promise.resolve({
                Item: { username, email, disabled: false },
              });
            }
            if (cmd._type === 'UpdateItem') {
              return Promise.resolve({});
            }
            return Promise.resolve({});
          });

          const event = makeAuthorizerEvent(rawKey);
          const allowResponse: AuthorizerResponse = await handler(event);
          expect(allowResponse.policyDocument.Statement[0].Effect).toBe('Allow');

          // Phase 2: simulate revocation — same key now has status 'revoked'
          jest.clearAllMocks();
          mockSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Query') {
              return Promise.resolve({
                Items: [
                  {
                    keyId,
                    keyHash,
                    username,
                    status: 'revoked',
                    createdAt,
                    revokedAt: Date.now(),
                  },
                ],
              });
            }
            return Promise.resolve({});
          });

          const denyResponse: AuthorizerResponse = await handler(event);
          expect(denyResponse.policyDocument.Statement[0].Effect).toBe('Deny');
        },
      ),
      { numRuns: 100 },
    );
  });
});
