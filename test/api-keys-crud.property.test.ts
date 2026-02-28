/**
 * Property-Based Tests: API Keys CRUD Handler
 * Feature: api-keys, Property 6: List returns only active keys and excludes secrets
 *
 * Tests that the list endpoint returns only active keys and excludes secrets.
 */

import * as fc from 'fast-check';

// Mock send function — declared before jest.mock (hoisting)
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockSend })),
  QueryCommand: jest.fn((p: any) => ({ _type: 'Query', ...p })),
  GetItemCommand: jest.fn((p: any) => ({ _type: 'GetItem', ...p })),
  PutItemCommand: jest.fn((p: any) => ({ _type: 'PutItem', ...p })),
  UpdateItemCommand: jest.fn((p: any) => ({ _type: 'UpdateItem', ...p })),
}));

jest.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: jest.fn((item: any) => item),
  unmarshall: jest.fn((item: any) => item),
}));

process.env.API_KEYS_TABLE = 'test-api-keys';
process.env.USERS_TABLE = 'test-users';
process.env.ACTIVITY_TABLE = 'test-activity';

import { handler } from '../src/lambda/api/api-keys';

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
 * Arbitrary: generates a single API key record with random status (active or revoked).
 * The username is passed in so all records belong to the same user.
 */
function keyRecordArb(username: string) {
  return fc.record({
    keyId: fc.uuid(),
    keyHash: fc.stringMatching(/^[0-9a-f]{64}$/),
    username: fc.constant(username),
    label: fc.string({ maxLength: 20 }),
    status: fc.oneof(fc.constant('active'), fc.constant('revoked')),
    createdAt: fc.integer({ min: 1000000000000, max: 2000000000000 }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Property 6: List returns only active keys and excludes secrets
// ---------------------------------------------------------------------------
describe('Feature: api-keys, Property 6: List returns only active keys and excludes secrets', () => {
  /**
   * **Validates: Requirements 4.1, 4.2, 4.3**
   *
   * For any user with a mix of active and revoked API keys, the list endpoint
   * should return only keys with status `active`, and no item in the response
   * should contain a `keyHash` or raw key value.
   */
  it('should return only active keys and exclude keyHash from response', async () => {
    await fc.assert(
      fc.asyncProperty(
        usernameArb,
        emailArb,
        usernameArb.chain((u) => fc.array(keyRecordArb(u), { minLength: 0, maxLength: 10 })),
        async (username, email, keyRecords) => {
          jest.clearAllMocks();

          // Collect all keyHash values so we can verify none leak into the response
          const allKeyHashes = keyRecords.map((r) => r.keyHash);
          const expectedActiveCount = keyRecords.filter((r) => r.status === 'active').length;

          // Mock DynamoDB: distinguish between getUserByEmail and listApiKeys queries
          mockSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Query') {
              if (cmd.IndexName === 'email-index') {
                // getUserByEmail — return the user record
                return Promise.resolve({
                  Items: [
                    {
                      username,
                      email,
                      access_type: 'ADMIN',
                      disabled: false,
                    },
                  ],
                });
              }
              if (cmd.IndexName === 'username-index') {
                // listApiKeys — return the mix of key records
                return Promise.resolve({
                  Items: keyRecords,
                });
              }
            }
            return Promise.resolve({});
          });

          const event = {
            httpMethod: 'GET',
            path: '/api-keys',
            requestContext: {
              authorizer: {
                claims: {
                  sub: 'test-sub',
                  email: email,
                  'custom:access_type': 'ADMIN',
                },
              },
            },
          };

          const response = await handler(event as any);
          const body = JSON.parse(response.body);

          // 1. All returned keys must have status 'active'
          for (const key of body.keys) {
            expect(key.status).toBe('active');
          }

          // 2. No returned key should contain a keyHash field
          for (const key of body.keys) {
            expect(key).not.toHaveProperty('keyHash');
          }

          // 3. No returned key field value should match any raw keyHash
          for (const key of body.keys) {
            const values = Object.values(key);
            for (const hash of allKeyHashes) {
              expect(values).not.toContain(hash);
            }
          }

          // 4. Count matches the number of active keys
          expect(body.count).toBe(expectedActiveCount);
          expect(body.keys.length).toBe(expectedActiveCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 7: Raw key never appears in stored records or activity logs
// ---------------------------------------------------------------------------
describe('Feature: api-keys, Property 7: Raw key never appears in stored records or activity logs', () => {
  /**
   * **Validates: Requirements 1.5, 5.3**
   *
   * For any API key creation or authentication event, the raw key value should
   * not appear in any DynamoDB record (API Keys Table or Activity Table) or in
   * any log arguments passed to the logging function.
   */
  it('should never store or log the raw key value', async () => {
    const consoleSpy = jest.spyOn(console, 'log');

    await fc.assert(
      fc.asyncProperty(
        usernameArb,
        emailArb,
        fc.option(fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[a-zA-Z0-9 ]+$/.test(s)), { nil: undefined }),
        fc.option(fc.integer({ min: 1, max: 365 }), { nil: undefined }),
        async (username, email, label, expiresInDays) => {
          jest.clearAllMocks();
          consoleSpy.mockClear();

          const capturedPuts: any[] = [];

          mockSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Query' && cmd.IndexName === 'email-index') {
              return Promise.resolve({
                Items: [{ username, email, access_type: 'ADMIN', disabled: false }],
              });
            }
            if (cmd._type === 'PutItem') {
              capturedPuts.push(cmd.Item);
              return Promise.resolve({});
            }
            return Promise.resolve({});
          });

          const body: Record<string, any> = {};
          if (label !== undefined) body.label = label;
          if (expiresInDays !== undefined) body.expiresInDays = expiresInDays;

          const event = {
            httpMethod: 'POST',
            path: '/api-keys',
            body: JSON.stringify(body),
            requestContext: {
              authorizer: {
                claims: {
                  sub: 'test-sub',
                  email: email,
                  'custom:access_type': 'ADMIN',
                },
              },
            },
          };

          const response = await handler(event as any);
          expect(response.statusCode).toBe(201);

          const responseBody = JSON.parse(response.body);
          const rawKey: string = responseBody.rawKey;
          expect(rawKey).toBeDefined();
          expect(rawKey.startsWith('tpk_')).toBe(true);

          // 1. Raw key must not appear in any captured PutItemCommand items
          expect(capturedPuts.length).toBeGreaterThanOrEqual(1);
          for (const item of capturedPuts) {
            const serialized = JSON.stringify(item);
            expect(serialized).not.toContain(rawKey);
          }

          // 2. Raw key must not appear in any console.log call arguments
          for (const call of consoleSpy.mock.calls) {
            const serialized = JSON.stringify(call);
            expect(serialized).not.toContain(rawKey);
          }
        },
      ),
      { numRuns: 100 },
    );

    consoleSpy.mockRestore();
  });
});
