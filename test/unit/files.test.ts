// Mock send functions must be declared before jest.mock (hoisting)
const mockS3Send = jest.fn();
const mockDynamoSend = jest.fn();
const mockCloudwatchSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  ListObjectsV2Command: jest.fn((params: any) => ({ _type: 'ListObjectsV2', ...params })),
  DeleteObjectCommand: jest.fn((params: any) => ({ _type: 'DeleteObject', ...params })),
  HeadObjectCommand: jest.fn((params: any) => ({ _type: 'HeadObject', ...params })),
  PutObjectCommand: jest.fn((params: any) => ({ _type: 'PutObject', ...params })),
  GetObjectCommand: jest.fn((params: any) => ({ _type: 'GetObject', ...params })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.example.com/presigned-url'),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDynamoSend })),
  GetItemCommand: jest.fn((params: any) => ({ _type: 'GetItem', ...params })),
  UpdateItemCommand: jest.fn((params: any) => ({ _type: 'UpdateItem', ...params })),
  PutItemCommand: jest.fn((params: any) => ({ _type: 'PutItem', ...params })),
  QueryCommand: jest.fn((params: any) => ({ _type: 'Query', ...params })),
}));

jest.mock('@aws-sdk/util-dynamodb', () => ({
  unmarshall: jest.fn((item: any) => ({
    username: item.username?.S || 'testuser1',
    email: item.email?.S || 'test@example.com',
    disabled: false,
  })),
  marshall: jest.fn((item: any) => item),
}));

jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn(() => ({ send: mockCloudwatchSend })),
  PutMetricDataCommand: jest.fn((params: any) => ({ _type: 'PutMetricData', ...params })),
}));

// Set environment variables BEFORE importing handler (files.ts reads them at module scope)
process.env.FILES_BUCKET = 'test-bucket';
process.env.USERS_TABLE = 'test-users-table';
process.env.ACTIVITY_TABLE = 'test-activity-table';
process.env.SHARED_FOLDER_ENABLED = 'true';
process.env.SHARED_FOLDER_NAME = 'shared';
process.env.SHARED_FOLDER_PERMISSIONS = 'read-write';

// Use require instead of import to control evaluation order (import gets hoisted)
const { handler } = require('../../src/lambda/api/files') as { handler: Function };

// Helper to build API Gateway events
function makeEvent(overrides: Partial<any> = {}): any {
  return {
    httpMethod: 'GET',
    path: '/files',
    queryStringParameters: null,
    body: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: 'user-sub-123',
          email: 'test@example.com',
          'custom:access_type': 'WEB_ONLY',
        },
      },
    },
    ...overrides,
  };
}

function parseBody(response: any) {
  return JSON.parse(response.body);
}

// Mock DynamoDB to return a valid user by default
function mockValidUser(username = 'testuser1') {
  mockDynamoSend.mockImplementation((cmd: any) => {
    if (cmd._type === 'Query') {
      return Promise.resolve({
        Items: [{ username: { S: username }, email: { S: 'test@example.com' } }],
        Count: 1,
      });
    }
    // Activity logging - just succeed
    return Promise.resolve({});
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockValidUser();
  mockCloudwatchSend.mockResolvedValue({});
  // Restore env vars (in case a test used jest.resetModules and changed them)
  process.env.SHARED_FOLDER_ENABLED = 'true';
  process.env.SHARED_FOLDER_NAME = 'shared';
  process.env.SHARED_FOLDER_PERMISSIONS = 'read-write';
});

// ============================================================
// Basic Functionality
// ============================================================

describe('List Files - folder parameter', () => {
  it('lists private files by default (no folder param)', async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: [
        { Key: 'users/testuser1/photo.jpg', Size: 1024, LastModified: new Date('2025-01-01') },
      ],
    });

    const res = await handler(makeEvent({ queryStringParameters: null }));
    const body = parseBody(res);

    expect(res.statusCode).toBe(200);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].name).toBe('photo.jpg');
    expect(body.files[0].folder).toBe('private');

    // Verify S3 was called with private prefix
    const s3Call = mockS3Send.mock.calls[0][0];
    expect(s3Call.Prefix).toBe('users/testuser1/');
  });

  it('lists private files with folder=private', async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: [
        { Key: 'users/testuser1/doc.pdf', Size: 2048, LastModified: new Date('2025-01-15') },
      ],
    });

    const res = await handler(makeEvent({
      queryStringParameters: { folder: 'private' },
    }));
    const body = parseBody(res);

    expect(res.statusCode).toBe(200);
    expect(body.folder).toBe('private');
    expect(body.files[0].name).toBe('doc.pdf');

    const s3Call = mockS3Send.mock.calls[0][0];
    expect(s3Call.Prefix).toBe('users/testuser1/');
  });

  it('lists shared files with folder=shared', async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: [
        { Key: 'shared/company-doc.txt', Size: 512, LastModified: new Date('2025-02-01') },
        { Key: 'shared/.keep', Size: 0, LastModified: new Date('2025-01-01') },
      ],
    });

    const res = await handler(makeEvent({
      queryStringParameters: { folder: 'shared' },
    }));
    const body = parseBody(res);

    expect(res.statusCode).toBe(200);
    expect(body.folder).toBe('shared');
    expect(body.files).toHaveLength(2);
    expect(body.files[0].name).toBe('company-doc.txt');
    expect(body.files[1].name).toBe('.keep');

    // Key check: S3 must be called with shared prefix, NOT user prefix
    const s3Call = mockS3Send.mock.calls[0][0];
    expect(s3Call.Prefix).toBe('shared/');
    expect(s3Call.Prefix).not.toContain('users/');
  });

  it('returns different results for private vs shared', async () => {
    // Private call
    mockS3Send.mockResolvedValueOnce({
      Contents: [
        { Key: 'users/testuser1/fett-reflection.jpg', Size: 1330632, LastModified: new Date() },
      ],
    });

    const privateRes = await handler(makeEvent({
      queryStringParameters: { folder: 'private' },
    }));
    const privateBody = parseBody(privateRes);

    // Shared call
    mockS3Send.mockResolvedValueOnce({
      Contents: [
        { Key: 'shared/company-doc.txt', Size: 512, LastModified: new Date() },
        { Key: 'shared/.keep', Size: 0, LastModified: new Date() },
      ],
    });

    const sharedRes = await handler(makeEvent({
      queryStringParameters: { folder: 'shared' },
    }));
    const sharedBody = parseBody(sharedRes);

    expect(privateBody.files[0].name).toBe('fett-reflection.jpg');
    expect(sharedBody.files[0].name).toBe('company-doc.txt');
    expect(privateBody.folder).toBe('private');
    expect(sharedBody.folder).toBe('shared');
  });
});

// ============================================================
// Upload - folder parameter
// ============================================================

describe('Upload URL - folder parameter', () => {
  it('generates upload URL for private folder (default)', async () => {
    const res = await handler(makeEvent({
      httpMethod: 'POST',
      path: '/files/upload-url',
      body: JSON.stringify({ filename: 'report.pdf' }),
    }));
    const body = parseBody(res);

    expect(res.statusCode).toBe(200);
    expect(body.uploadUrl).toBeDefined();
    expect(body.key).toBe('users/testuser1/report.pdf');
    expect(body.folder).toBe('private');
  });

  it('generates upload URL for shared folder', async () => {
    const res = await handler(makeEvent({
      httpMethod: 'POST',
      path: '/files/upload-url',
      body: JSON.stringify({ filename: 'shared-doc.pdf', folder: 'shared' }),
    }));
    const body = parseBody(res);

    expect(res.statusCode).toBe(200);
    expect(body.key).toBe('shared/shared-doc.pdf');
    expect(body.folder).toBe('shared');
  });

  it('rejects upload to read-only shared folder', async () => {
    // Must re-require module since SHARED_FOLDER_PERMISSIONS is captured at module scope
    jest.resetModules();
    process.env.SHARED_FOLDER_PERMISSIONS = 'read-only';
    const { handler: h } = require('../../src/lambda/api/files');
    mockValidUser();
    mockCloudwatchSend.mockResolvedValue({});

    const res = await h(makeEvent({
      httpMethod: 'POST',
      path: '/files/upload-url',
      body: JSON.stringify({ filename: 'doc.pdf', folder: 'shared' }),
    }));

    expect(res.statusCode).toBe(403);
    expect(parseBody(res).error).toContain('read-only');
  });

  it('allows upload to read-write shared folder', async () => {
    process.env.SHARED_FOLDER_PERMISSIONS = 'read-write';

    const res = await handler(makeEvent({
      httpMethod: 'POST',
      path: '/files/upload-url',
      body: JSON.stringify({ filename: 'doc.pdf', folder: 'shared' }),
    }));

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).folder).toBe('shared');
  });
});

// ============================================================
// Download - folder parameter
// ============================================================

describe('Download URL - folder parameter', () => {
  beforeEach(() => {
    mockS3Send.mockResolvedValue({}); // HeadObject succeeds
  });

  it('generates download URL for private file', async () => {
    const res = await handler(makeEvent({
      httpMethod: 'POST',
      path: '/files/download-url',
      body: JSON.stringify({ filename: 'photo.jpg' }),
    }));
    const body = parseBody(res);

    expect(res.statusCode).toBe(200);
    expect(body.downloadUrl).toBeDefined();
    expect(body.folder).toBe('private');
  });

  it('generates download URL for shared file', async () => {
    const res = await handler(makeEvent({
      httpMethod: 'POST',
      path: '/files/download-url',
      body: JSON.stringify({ filename: 'company-doc.txt', folder: 'shared' }),
    }));
    const body = parseBody(res);

    expect(res.statusCode).toBe(200);
    expect(body.folder).toBe('shared');
  });

  it('allows download from read-only shared folder', async () => {
    jest.resetModules();
    process.env.SHARED_FOLDER_PERMISSIONS = 'read-only';
    const { handler: h } = require('../../src/lambda/api/files');
    mockValidUser();
    mockCloudwatchSend.mockResolvedValue({});
    mockS3Send.mockResolvedValue({});

    const res = await h(makeEvent({
      httpMethod: 'POST',
      path: '/files/download-url',
      body: JSON.stringify({ filename: 'doc.pdf', folder: 'shared' }),
    }));

    expect(res.statusCode).toBe(200);
  });
});

// ============================================================
// Delete - folder parameter
// ============================================================

describe('Delete File - folder parameter', () => {
  beforeEach(() => {
    mockS3Send.mockResolvedValue({ ContentLength: 1024 }); // HeadObject + DeleteObject
  });

  it('deletes from private folder (default)', async () => {
    const res = await handler(makeEvent({
      httpMethod: 'DELETE',
      path: '/files',
      body: JSON.stringify({ filename: 'old-file.txt' }),
    }));

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).folder).toBe('private');
  });

  it('deletes from shared folder', async () => {
    const res = await handler(makeEvent({
      httpMethod: 'DELETE',
      path: '/files',
      body: JSON.stringify({ filename: 'shared-doc.txt', folder: 'shared' }),
    }));

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).folder).toBe('shared');
  });

  it('rejects delete from read-only shared folder', async () => {
    jest.resetModules();
    process.env.SHARED_FOLDER_PERMISSIONS = 'read-only';
    const { handler: h } = require('../../src/lambda/api/files');
    mockValidUser();
    mockCloudwatchSend.mockResolvedValue({});

    const res = await h(makeEvent({
      httpMethod: 'DELETE',
      path: '/files',
      body: JSON.stringify({ filename: 'doc.pdf', folder: 'shared' }),
    }));

    expect(res.statusCode).toBe(403);
    expect(parseBody(res).error).toContain('read-only');
  });
});

// ============================================================
// Error Handling
// ============================================================

describe('Error Handling', () => {
  it('returns 400 for invalid folder parameter', async () => {
    mockS3Send.mockResolvedValueOnce({ Contents: [] });

    const res = await handler(makeEvent({
      queryStringParameters: { folder: 'invalid' },
    }));

    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toContain('Invalid folder parameter');
  });

  it('returns 404 when file not found in private folder', async () => {
    const notFoundError: any = new Error('NotFound');
    notFoundError.name = 'NotFound';
    mockS3Send.mockReset();
    mockS3Send.mockRejectedValue(notFoundError);

    const res = await handler(makeEvent({
      httpMethod: 'POST',
      path: '/files/download-url',
      body: JSON.stringify({ filename: 'nonexistent.txt', folder: 'private' }),
    }));

    expect(res.statusCode).toBe(404);
    expect(parseBody(res).error).toContain('File not found');
  });

  it('returns 404 when file not found in shared folder', async () => {
    const notFoundError: any = new Error('NotFound');
    notFoundError.name = 'NotFound';
    mockS3Send.mockReset();
    mockS3Send.mockRejectedValue(notFoundError);

    const res = await handler(makeEvent({
      httpMethod: 'POST',
      path: '/files/download-url',
      body: JSON.stringify({ filename: 'nonexistent.txt', folder: 'shared' }),
    }));

    expect(res.statusCode).toBe(404);
    expect(parseBody(res).error).toContain('File not found');
  });

  it('returns 401 when no auth claims', async () => {
    const res = await handler(makeEvent({
      requestContext: { authorizer: { claims: {} } },
    }));

    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when user not found in DynamoDB', async () => {
    mockDynamoSend.mockImplementation((cmd: any) => {
      if (cmd._type === 'Query') {
        return Promise.resolve({ Items: [], Count: 0 });
      }
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(404);
    expect(parseBody(res).error).toContain('User not found');
  });
});

// ============================================================
// Backwards Compatibility
// ============================================================

describe('Backwards Compatibility', () => {
  it('upload without folder param defaults to private key', async () => {
    const res = await handler(makeEvent({
      httpMethod: 'POST',
      path: '/files/upload-url',
      body: JSON.stringify({ filename: 'test.txt' }),
    }));

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).key).toContain('users/testuser1/');
  });
});

// Tests that require jest.resetModules (changing module-level env vars)
// Each test gets a fresh module with its own env var snapshot
describe('Module-level config tests', () => {
  beforeEach(() => {
    mockS3Send.mockReset();
    mockDynamoSend.mockReset();
    mockCloudwatchSend.mockReset();
    mockCloudwatchSend.mockResolvedValue({});
    mockValidUser();
  });

  it('returns 403 when shared folder is disabled', async () => {
    jest.resetModules();
    process.env.SHARED_FOLDER_ENABLED = 'false';
    const { handler: h } = require('../../src/lambda/api/files');

    const res = await h(makeEvent({
      queryStringParameters: { folder: 'shared' },
    }));

    expect(res.statusCode).toBe(403);
    expect(parseBody(res).error).toContain('not enabled');
  });

  it('works without folder parameter (defaults to private)', async () => {
    jest.resetModules();
    process.env.SHARED_FOLDER_ENABLED = 'true';
    process.env.SHARED_FOLDER_PERMISSIONS = 'read-write';

    mockS3Send.mockResolvedValue({
      Contents: [
        { Key: 'users/testuser1/file.txt', Size: 100, LastModified: new Date() },
      ],
    });

    const { handler: h } = require('../../src/lambda/api/files');

    const res = await h(makeEvent({
      queryStringParameters: null,
    }));

    const body = parseBody(res);
    expect(res.statusCode).toBe(200);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].name).toBe('file.txt');
    expect(body.folder).toBe('private');
  });

  it('private operations work when shared folder is disabled', async () => {
    jest.resetModules();
    process.env.SHARED_FOLDER_ENABLED = 'false';

    mockS3Send.mockResolvedValue({
      Contents: [
        { Key: 'users/testuser1/file.txt', Size: 100, LastModified: new Date() },
      ],
    });

    const { handler: h } = require('../../src/lambda/api/files');

    const res = await h(makeEvent({
      queryStringParameters: { folder: 'private' },
    }));

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).files).toHaveLength(1);
  });
});
