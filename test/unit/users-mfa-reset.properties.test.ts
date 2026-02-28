/**
 * Property-Based Test: Admin-only MFA reset authorization
 * Feature: totp-mfa, Property 3: Admin-only MFA reset authorization
 *
 * Validates: Requirements 6.5
 *
 * For any authenticated user without ADMIN access type, calling the reset-MFA
 * API endpoint should return a 403 Forbidden response and the target user's
 * MFA configuration should remain unchanged.
 */

import * as fc from 'fast-check';

// Mock send functions — declared before jest.mock (hoisting)
const mockDynamoSend = jest.fn();
const mockCognitoSend = jest.fn();
const mockSesSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDynamoSend })),
  PutItemCommand: jest.fn((p: any) => ({ _type: 'PutItem', ...p })),
  GetItemCommand: jest.fn((p: any) => ({ _type: 'GetItem', ...p })),
  ScanCommand: jest.fn((p: any) => ({ _type: 'Scan', ...p })),
  UpdateItemCommand: jest.fn((p: any) => ({ _type: 'UpdateItem', ...p })),
  DeleteItemCommand: jest.fn((p: any) => ({ _type: 'DeleteItem', ...p })),
}));

jest.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: jest.fn((item: any) => item),
  unmarshall: jest.fn((item: any) => item),
}));

jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
  AdminCreateUserCommand: jest.fn((p: any) => ({ _type: 'AdminCreateUser', ...p })),
  AdminDeleteUserCommand: jest.fn((p: any) => ({ _type: 'AdminDeleteUser', ...p })),
  AdminUpdateUserAttributesCommand: jest.fn((p: any) => ({ _type: 'AdminUpdateUserAttributes', ...p })),
  AdminSetUserMFAPreferenceCommand: jest.fn((p: any) => ({ _type: 'AdminSetUserMFAPreference', ...p })),
}));

jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn(() => ({ send: mockSesSend })),
  SendTemplatedEmailCommand: jest.fn((p: any) => ({ _type: 'SendTemplatedEmail', ...p })),
}));

// Set env vars before importing handler
process.env.USERS_TABLE = 'test-users-table';
process.env.ACTIVITY_TABLE = 'test-activity-table';
process.env.USER_POOL_ID = 'us-east-1_TestPool';

const { handler } = require('../../src/lambda/api/users') as {
  handler: (event: any) => Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;
};

/**
 * Arbitrary that generates non-ADMIN access type strings.
 * Includes known types (WEB_ONLY, SFTP_ONLY, HYBRID) and random strings,
 * but never 'ADMIN'.
 */
const nonAdminAccessTypeArb = fc.oneof(
  fc.constantFrom('WEB_ONLY', 'SFTP_ONLY', 'HYBRID'),
  fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s !== 'ADMIN'),
);

function makeResetMfaEvent(accessType: string, targetUsername: string) {
  return {
    httpMethod: 'POST',
    path: `/users/${targetUsername}/reset-mfa`,
    pathParameters: { username: targetUsername },
    body: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: 'caller-sub-123',
          email: 'caller@example.com',
          'custom:access_type': accessType,
        },
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Feature: totp-mfa, Property 3: Admin-only MFA reset authorization', () => {
  /**
   * **Validates: Requirements 6.5**
   *
   * For any non-ADMIN access type, the handler must return 403 and must NOT
   * call AdminSetUserMFAPreference (i.e., MFA config stays unchanged).
   */
  it('should return 403 for any non-ADMIN access type and never call Cognito MFA reset', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonAdminAccessTypeArb,
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !s.includes('/')),
        async (accessType, targetUsername) => {
          jest.clearAllMocks();

          const event = makeResetMfaEvent(accessType, targetUsername);
          const response = await handler(event);
          const body = JSON.parse(response.body);

          // Must be 403 Forbidden
          expect(response.statusCode).toBe(403);
          expect(body.error).toContain('Forbidden');

          // Cognito AdminSetUserMFAPreference must NOT have been called
          const cognitoCalls = mockCognitoSend.mock.calls;
          const mfaResetCalls = cognitoCalls.filter(
            (call: any[]) => call[0]?._type === 'AdminSetUserMFAPreference',
          );
          expect(mfaResetCalls).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
