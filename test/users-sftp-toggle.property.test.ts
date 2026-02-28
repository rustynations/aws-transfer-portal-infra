/**
 * Property-Based Tests: Users API SFTP toggle enforcement
 * Feature: sftp-toggle
 *
 * Tests Properties 5–6 for the Users API SFTP access type guards.
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
process.env.SFTP_ENABLED = 'false';

const { handler } = require('../src/lambda/api/users') as {
  handler: (event: any) => Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;
};


/**
 * Arbitrary: generates an SFTP access type (SFTP_ONLY or HYBRID).
 */
const sftpAccessTypeArb = fc.constantFrom('SFTP_ONLY', 'HYBRID');

/**
 * Arbitrary: generates a non-SFTP access type (ADMIN or WEB_ONLY).
 */
const nonSftpAccessTypeArb = fc.constantFrom('ADMIN', 'WEB_ONLY');

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
 * Arbitrary: generates a valid SSH public key string.
 */
const sshKeyArb = fc.constant('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7 test@example');

/**
 * Arbitrary: generates either 'create' or 'update' operation type.
 */
const operationTypeArb = fc.constantFrom('create', 'update');

/**
 * Helper: build an admin user record returned by DynamoDB scan (getUserByEmail).
 */
function makeAdminUserRecord(email: string) {
  return {
    username: 'admin-user-001',
    email,
    display_name: 'Admin',
    access_type: 'ADMIN',
    disabled: false,
    is_root: false,
    created_at: Date.now(),
    storage_used: 0,
    file_count: 0,
  };
}

/**
 * Helper: build a target user record for update operations.
 */
function makeTargetUserRecord(username: string) {
  return {
    username,
    email: 'target@example.com',
    display_name: 'Target User',
    access_type: 'WEB_ONLY',
    disabled: false,
    is_root: false,
    created_at: Date.now(),
    storage_used: 0,
    file_count: 0,
  };
}

/**
 * Helper: build a create-user API Gateway event.
 */
function makeCreateUserEvent(email: string, accessType: string, sshKeys?: string[]) {
  return {
    httpMethod: 'POST',
    path: '/users',
    pathParameters: undefined,
    body: JSON.stringify({
      email,
      access_type: accessType,
      ...(sshKeys ? { ssh_keys: sshKeys } : {}),
    }),
    requestContext: {
      authorizer: {
        claims: {
          sub: 'admin-sub-123',
          email: 'admin@example.com',
          'custom:access_type': 'ADMIN',
        },
      },
    },
  };
}

/**
 * Helper: build an update-user API Gateway event.
 */
function makeUpdateUserEvent(username: string, accessType: string) {
  return {
    httpMethod: 'PUT',
    path: `/users/${username}`,
    pathParameters: { username },
    body: JSON.stringify({ access_type: accessType }),
    requestContext: {
      authorizer: {
        claims: {
          sub: 'admin-sub-123',
          email: 'admin@example.com',
          'custom:access_type': 'ADMIN',
        },
      },
    },
  };
}

/**
 * Helper: set up DynamoDB mock for admin lookup (first scan returns admin user).
 */
function setupAdminMock() {
  mockDynamoSend.mockImplementation((cmd: any) => {
    if (cmd._type === 'Scan') {
      return Promise.resolve({
        Items: [makeAdminUserRecord('admin@example.com')],
      });
    }
    if (cmd._type === 'PutItem') {
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
}

/**
 * Helper: set up DynamoDB mock for update operations.
 * First scan returns admin user, GetItem returns target user.
 */
function setupUpdateMocks(targetUsername: string) {
  let scanCallCount = 0;
  mockDynamoSend.mockImplementation((cmd: any) => {
    if (cmd._type === 'Scan') {
      scanCallCount++;
      // First scan is for admin lookup
      return Promise.resolve({
        Items: [makeAdminUserRecord('admin@example.com')],
      });
    }
    if (cmd._type === 'GetItem') {
      return Promise.resolve({
        Item: makeTargetUserRecord(targetUsername),
      });
    }
    if (cmd._type === 'UpdateItem') {
      return Promise.resolve({});
    }
    if (cmd._type === 'PutItem') {
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});


// ---------------------------------------------------------------------------
// Property 5: SFTP access types rejected when disabled
// ---------------------------------------------------------------------------
describe('Feature: sftp-toggle, Property 5: SFTP access types rejected when disabled', () => {
  /**
   * **Validates: Requirements 4.1, 4.2**
   *
   * For any user create or update request that specifies an access type of
   * SFTP_ONLY or HYBRID, when SFTP is disabled (SFTP_ENABLED is 'false'),
   * the Users API SHALL return a 400 status code with an error message.
   */
  it('should return 400 for any SFTP access type on create or update when SFTP is disabled', async () => {
    await fc.assert(
      fc.asyncProperty(
        sftpAccessTypeArb,
        operationTypeArb,
        emailArb,
        async (accessType, operation, email) => {
          jest.clearAllMocks();

          let event: any;
          if (operation === 'create') {
            setupAdminMock();
            event = makeCreateUserEvent(email, accessType, ['ssh-rsa AAAA test@key']);
          } else {
            const targetUsername = 'target-user-001';
            setupUpdateMocks(targetUsername);
            event = makeUpdateUserEvent(targetUsername, accessType);
          }

          const response = await handler(event);
          const body = JSON.parse(response.body);

          expect(response.statusCode).toBe(400);
          expect(body.error).toContain('SFTP is not enabled');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Non-SFTP access types accepted when disabled
// ---------------------------------------------------------------------------
describe('Feature: sftp-toggle, Property 6: Non-SFTP access types accepted when disabled', () => {
  /**
   * **Validates: Requirements 4.3**
   *
   * For any user create or update request that specifies an access type of
   * ADMIN or WEB_ONLY, when SFTP is disabled, the Users API SHALL not reject
   * the request due to the SFTP toggle (other validation may still apply).
   */
  it('should not return the SFTP-specific error for non-SFTP access types when SFTP is disabled', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonSftpAccessTypeArb,
        operationTypeArb,
        emailArb,
        async (accessType, operation, email) => {
          jest.clearAllMocks();

          let event: any;
          if (operation === 'create') {
            setupAdminMock();
            event = makeCreateUserEvent(email, accessType);
          } else {
            const targetUsername = 'target-user-001';
            setupUpdateMocks(targetUsername);
            event = makeUpdateUserEvent(targetUsername, accessType);
          }

          const response = await handler(event);
          const body = JSON.parse(response.body);

          // The request should NOT be rejected with the SFTP-specific error.
          // It may fail for other reasons (e.g., Cognito mock not fully set up),
          // but it must not contain the SFTP toggle error message.
          if (response.statusCode === 400) {
            expect(body.error).not.toContain('SFTP is not enabled');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
