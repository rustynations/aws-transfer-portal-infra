/**
 * Unit tests for MFA reset Lambda handler
 * Requirements: 6.2, 6.4, 6.5
 *
 * Tests:
 * - Successful reset returns 200
 * - Non-admin caller returns 403
 * - Non-existent user returns 404
 */

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

function makeResetMfaEvent(overrides: Partial<any> = {}): any {
  return {
    httpMethod: 'POST',
    path: '/users/target-user/reset-mfa',
    pathParameters: { username: 'target-user' },
    body: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: 'admin-sub-123',
          email: 'admin@example.com',
          'custom:access_type': 'ADMIN',
        },
      },
    },
    ...overrides,
  };
}

function parseBody(response: any) {
  return JSON.parse(response.body);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('MFA Reset Lambda Handler', () => {
  /**
   * Requirement 6.2: Backend calls AdminSetUserMFAPreference to disable TOTP
   * Successful reset returns 200 with confirmation message
   */
  it('returns 200 when admin successfully resets MFA for an existing user', async () => {
    // Mock getUserByEmail (ScanCommand) — returns admin user
    mockDynamoSend.mockImplementation((cmd: any) => {
      if (cmd._type === 'Scan') {
        return Promise.resolve({
          Items: [
            {
              username: 'admin-user',
              email: 'admin@example.com',
              access_type: 'ADMIN',
              disabled: false,
            },
          ],
          Count: 1,
        });
      }
      // GetItemCommand — returns target user
      if (cmd._type === 'GetItem') {
        return Promise.resolve({
          Item: {
            username: 'target-user',
            email: 'target@example.com',
            access_type: 'WEB_ONLY',
            disabled: false,
          },
        });
      }
      // PutItemCommand — activity log, just succeed
      return Promise.resolve({});
    });

    // Cognito AdminSetUserMFAPreference succeeds
    mockCognitoSend.mockResolvedValue({});

    const event = makeResetMfaEvent();
    const response = await handler(event);
    const body = parseBody(response);

    expect(response.statusCode).toBe(200);
    expect(body.message).toContain('MFA reset successfully');

    // Verify Cognito was called with correct params
    expect(mockCognitoSend).toHaveBeenCalledTimes(1);
    const cognitoCall = mockCognitoSend.mock.calls[0][0];
    expect(cognitoCall._type).toBe('AdminSetUserMFAPreference');
    expect(cognitoCall.SoftwareTokenMfaSettings).toEqual({
      Enabled: false,
      PreferredMfa: false,
    });
  });

  /**
   * Requirement 6.5: Only ADMIN users can reset MFA
   * Non-admin caller returns 403
   */
  it('returns 403 when a non-admin user attempts to reset MFA', async () => {
    const event = makeResetMfaEvent({
      requestContext: {
        authorizer: {
          claims: {
            sub: 'user-sub-456',
            email: 'regular@example.com',
            'custom:access_type': 'WEB_ONLY',
          },
        },
      },
    });

    const response = await handler(event);
    const body = parseBody(response);

    expect(response.statusCode).toBe(403);
    expect(body.error).toContain('Forbidden');

    // Cognito should never be called
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  /**
   * Requirement 6.4: If MFA reset fails, display error with failure reason
   * Non-existent target user returns 404
   */
  it('returns 404 when the target user does not exist in DynamoDB', async () => {
    mockDynamoSend.mockImplementation((cmd: any) => {
      if (cmd._type === 'Scan') {
        // Admin user lookup succeeds
        return Promise.resolve({
          Items: [
            {
              username: 'admin-user',
              email: 'admin@example.com',
              access_type: 'ADMIN',
              disabled: false,
            },
          ],
          Count: 1,
        });
      }
      if (cmd._type === 'GetItem') {
        // Target user NOT found
        return Promise.resolve({ Item: undefined });
      }
      return Promise.resolve({});
    });

    const event = makeResetMfaEvent();
    const response = await handler(event);
    const body = parseBody(response);

    expect(response.statusCode).toBe(404);
    expect(body.error).toContain('User not found');

    // Cognito should never be called since user wasn't found
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });
});
