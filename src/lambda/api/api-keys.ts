import { DynamoDBClient, QueryCommand, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { generateApiKey } from './api-key-utils';

const dynamodb = new DynamoDBClient({});
const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;
const USERS_TABLE = process.env.USERS_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string } | null;
  body?: string;
  requestContext: {
    authorizer?: {
      claims?: {
        sub: string;
        email: string;
        'custom:access_type'?: string;
      };
    };
  };
}

interface APIResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

interface CreateApiKeyRequest {
  username?: string;
  label?: string;
  expiresInDays?: number;
}

/**
 * API Key Management API Handler
 *
 * Handles API key operations:
 * - POST /api-keys — Create a new API key
 * - GET /api-keys — List current user's keys
 * - GET /api-keys?username={username} — List keys for a specific user (admin only)
 * - DELETE /api-keys/{keyId} — Revoke a key
 *
 * Requirements: 1.1, 1.2, 1.4, 1.5, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3
 */
export const handler = async (event: APIGatewayEvent): Promise<APIResponse> => {
  console.log('API key management request:', {
    method: event.httpMethod,
    path: event.path
  });

  try {
    // Get email from Cognito claims
    const email = event.requestContext.authorizer?.claims?.email;
    if (!email) {
      return errorResponse(401, 'Unauthorized');
    }

    // Get user from DynamoDB
    const user = await getUserByEmail(email);
    if (!user) {
      return errorResponse(404, 'User not found');
    }

    const isAdmin = user.access_type === 'ADMIN';

    // Route to appropriate handler
    switch (event.httpMethod) {
      case 'POST':
        return await createApiKey(user, isAdmin, event);
      case 'GET':
        return await listApiKeys(user, isAdmin, event);
      case 'DELETE':
        if (event.pathParameters?.keyId) {
          return await revokeApiKey(user, isAdmin, event.pathParameters.keyId);
        }
        return errorResponse(400, 'Key ID required');
      default:
        return errorResponse(405, 'Method not allowed');
    }
  } catch (error) {
    console.error('Error handling request:', error);
    return errorResponse(500, 'Internal server error');
  }
};

/**
 * Create a new API key
 * Requirements: 1.1, 1.2, 1.4, 1.5
 */
async function createApiKey(requestingUser: any, isAdmin: boolean, event: APIGatewayEvent): Promise<APIResponse> {
  const data: CreateApiKeyRequest = event.body ? JSON.parse(event.body) : {};

  // Determine target username
  let targetUsername = requestingUser.username;
  if (data.username) {
    if (!isAdmin) {
      return errorResponse(403, 'Forbidden: Admin access required');
    }
    // Verify target user exists
    const targetUser = await getUserByUsername(data.username);
    if (!targetUser) {
      return errorResponse(404, 'User not found');
    }
    targetUsername = data.username;
  }

  // Generate key
  const { rawKey, keyHash, keyId } = generateApiKey();
  const createdAt = Date.now();
  const label = data.label || '';

  // Build item for DynamoDB
  const item: Record<string, any> = {
    keyId,
    keyHash,
    username: targetUsername,
    label,
    status: 'active',
    createdAt,
  };

  // Compute optional expiresAt
  if (data.expiresInDays && data.expiresInDays > 0) {
    item.expiresAt = createdAt + data.expiresInDays * 24 * 60 * 60 * 1000;
  }

  // Store in API Keys Table
  await dynamodb.send(new PutItemCommand({
    TableName: API_KEYS_TABLE,
    Item: marshall(item),
  }));

  // Log activity (never log the raw key)
  await logActivity(targetUsername, 'CREATE_API_KEY', 'web', keyId);

  // Build response
  const response: Record<string, any> = {
    keyId,
    rawKey,
    label,
    createdAt,
  };
  if (item.expiresAt) {
    response.expiresAt = item.expiresAt;
  }

  return successResponse(201, response);
}

/**
 * List active API keys for a user
 * Requirements: 4.1, 4.2, 4.3
 */
async function listApiKeys(requestingUser: any, isAdmin: boolean, event: APIGatewayEvent): Promise<APIResponse> {
  // Determine target username
  let targetUsername = requestingUser.username;
  const queryUsername = event.queryStringParameters?.username;
  if (queryUsername) {
    if (!isAdmin) {
      return errorResponse(403, 'Forbidden: Admin access required');
    }
    targetUsername = queryUsername;
  }

  // Query username-index GSI for the target user's keys
  const response = await dynamodb.send(new QueryCommand({
    TableName: API_KEYS_TABLE,
    IndexName: 'username-index',
    KeyConditionExpression: 'username = :username',
    ExpressionAttributeValues: {
      ':username': { S: targetUsername },
    },
  }));

  const items = (response.Items || []).map(item => unmarshall(item));

  // Filter to active keys only and exclude keyHash from response
  const keys = items
    .filter(item => item.status === 'active')
    .map(item => {
      const metadata: Record<string, any> = {
        keyId: item.keyId,
        label: item.label,
        createdAt: item.createdAt,
        status: item.status,
      };
      if (item.expiresAt !== undefined) {
        metadata.expiresAt = item.expiresAt;
      }
      if (item.lastUsedAt !== undefined) {
        metadata.lastUsedAt = item.lastUsedAt;
      }
      return metadata;
    });

  return successResponse(200, { keys, count: keys.length });
}

/**
 * Revoke an API key
 * Requirements: 3.1, 3.2, 3.3
 */
async function revokeApiKey(requestingUser: any, isAdmin: boolean, keyId: string): Promise<APIResponse> {
  // Get the key record
  const response = await dynamodb.send(new GetItemCommand({
    TableName: API_KEYS_TABLE,
    Key: { keyId: { S: keyId } },
  }));

  if (!response.Item) {
    return errorResponse(404, 'API key not found');
  }

  const keyRecord = unmarshall(response.Item);

  // Verify ownership or admin
  if (keyRecord.username !== requestingUser.username && !isAdmin) {
    return errorResponse(403, 'Forbidden: Admin access required');
  }

  // Mark as revoked
  await dynamodb.send(new UpdateItemCommand({
    TableName: API_KEYS_TABLE,
    Key: { keyId: { S: keyId } },
    UpdateExpression: 'SET #status = :revoked, revokedAt = :revokedAt',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':revoked': { S: 'revoked' },
      ':revokedAt': { N: Date.now().toString() },
    },
  }));

  // Log activity
  await logActivity(keyRecord.username, 'REVOKE_API_KEY', 'web', keyId);

  return successResponse(200, { message: 'API key revoked successfully' });
}

/**
 * Get user by email (for looking up from Cognito claims)
 */
async function getUserByEmail(email: string): Promise<any> {
  const response = await dynamodb.send(new QueryCommand({
    TableName: USERS_TABLE,
    IndexName: 'email-index',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: {
      ':email': { S: email },
    },
    Limit: 1,
  }));

  if (!response.Items || response.Items.length === 0) {
    return null;
  }

  return unmarshall(response.Items[0]);
}

/**
 * Get user by username
 */
async function getUserByUsername(username: string): Promise<any> {
  const response = await dynamodb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: { username: { S: username } },
  }));

  if (!response.Item) {
    return null;
  }

  return unmarshall(response.Item);
}

/**
 * Helper: Success response
 */
function successResponse(statusCode: number, data: any): APIResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
    },
    body: JSON.stringify(data),
  };
}

/**
 * Helper: Error response
 */
function errorResponse(statusCode: number, message: string): APIResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
    },
    body: JSON.stringify({ error: message }),
  };
}

/**
 * Log activity to DynamoDB activity table
 */
async function logActivity(
  username: string,
  action: string,
  protocol: string,
  keyId?: string
): Promise<void> {
  const timestamp = Date.now();
  const activityId = `${timestamp}-${Math.random().toString(36).substring(7)}`;

  try {
    await dynamodb.send(new PutItemCommand({
      TableName: ACTIVITY_TABLE,
      Item: marshall({
        activityId,
        timestamp,
        username,
        action,
        protocol,
        activityType: 'FILE_OPERATION',
        ttl: Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000),
        filename: keyId || '',
      }),
    }));
  } catch (error) {
    console.error('Error logging activity:', error);
    // Don't fail the operation if activity logging fails
  }
}
