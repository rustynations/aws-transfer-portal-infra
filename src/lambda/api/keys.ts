import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { randomUUID } from 'crypto';

const dynamodb = new DynamoDBClient({});
const USERS_TABLE = process.env.USERS_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
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

interface SSHKey {
  key_id: string;
  public_key: string;
  added_date: number;
}

/**
 * SSH Key Management API Handler
 * 
 * Handles SSH key operations:
 * - POST /keys - Add SSH key
 * - GET /keys - List SSH keys
 * - DELETE /keys/{key_id} - Delete SSH key
 * 
 * Requirements: 3.1, 3.2, 3.4
 */
export const handler = async (event: APIGatewayEvent): Promise<APIResponse> => {
  console.log('SSH key management request:', {
    method: event.httpMethod,
    path: event.path
  });

  try {
    // Get username from Cognito claims
    const email = event.requestContext.authorizer?.claims?.email;
    if (!email) {
      return errorResponse(401, 'Unauthorized');
    }

    // Get user from DynamoDB
    const user = await getUserByEmail(email);
    if (!user) {
      return errorResponse(404, 'User not found');
    }

    // Route to appropriate handler
    switch (event.httpMethod) {
      case 'POST':
        return await addSSHKey(user.username, event);
      case 'GET':
        return await listSSHKeys(user.username);
      case 'DELETE':
        if (event.pathParameters?.key_id) {
          return await deleteSSHKey(user.username, event.pathParameters.key_id);
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
 * Add SSH key for user
 * Task 8.1: Implement add SSH key endpoint
 * Requirements: 3.1, 3.2
 */
async function addSSHKey(username: string, event: APIGatewayEvent): Promise<APIResponse> {
  if (!event.body) {
    return errorResponse(400, 'Request body required');
  }

  const data = JSON.parse(event.body);
  
  if (!data.public_key) {
    return errorResponse(400, 'Missing required field: public_key');
  }

  // Validate SSH key format
  const validationError = validateSSHKey(data.public_key);
  if (validationError) {
    return errorResponse(400, validationError);
  }

  // Create new SSH key record
  const newKey: SSHKey = {
    key_id: randomUUID(),
    public_key: data.public_key.trim(),
    added_date: Date.now()
  };

  // Add key to user's ssh_keys array in DynamoDB
  try {
    await dynamodb.send(new UpdateItemCommand({
      TableName: USERS_TABLE,
      Key: { username: { S: username } },
      UpdateExpression: 'SET ssh_keys = list_append(if_not_exists(ssh_keys, :empty_list), :new_key)',
      ExpressionAttributeValues: {
        ':new_key': { L: [{ M: {
          key_id: { S: newKey.key_id },
          public_key: { S: newKey.public_key },
          added_date: { N: newKey.added_date.toString() }
        }}]},
        ':empty_list': { L: [] }
      }
    }));
  } catch (error) {
    console.error('Error adding SSH key:', error);
    return errorResponse(500, 'Failed to add SSH key');
  }

  // Log activity
  await logActivity(username, 'ADD_SSH_KEY', 'web', newKey.key_id);

  return successResponse(201, { 
    message: 'SSH key added successfully',
    key_id: newKey.key_id
  });
}

/**
 * List SSH keys for user
 * Task 8.1: Implement list SSH keys endpoint
 * Requirements: 3.1
 */
async function listSSHKeys(username: string): Promise<APIResponse> {
  const response = await dynamodb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: { username: { S: username } },
    ProjectionExpression: 'ssh_keys'
  }));

  if (!response.Item) {
    return errorResponse(404, 'User not found');
  }

  const user = unmarshall(response.Item);
  const keys = user.ssh_keys || [];

  // Return keys without the full public key content (just metadata)
  const sanitizedKeys = keys.map((key: SSHKey) => ({
    key_id: key.key_id,
    fingerprint: generateFingerprint(key.public_key),
    added_date: key.added_date
  }));

  // Log activity
  await logActivity(username, 'LIST_SSH_KEYS', 'web');

  return successResponse(200, { keys: sanitizedKeys, count: sanitizedKeys.length });
}

/**
 * Delete SSH key for user
 * Task 8.1: Implement delete SSH key endpoint
 * Requirements: 3.4
 */
async function deleteSSHKey(username: string, keyId: string): Promise<APIResponse> {
  // Get current user
  const response = await dynamodb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: { username: { S: username } }
  }));

  if (!response.Item) {
    return errorResponse(404, 'User not found');
  }

  const user = unmarshall(response.Item);
  const keys = user.ssh_keys || [];

  // Find key index
  const keyIndex = keys.findIndex((key: SSHKey) => key.key_id === keyId);
  if (keyIndex === -1) {
    return errorResponse(404, 'SSH key not found');
  }

  // Remove key from array
  await dynamodb.send(new UpdateItemCommand({
    TableName: USERS_TABLE,
    Key: { username: { S: username } },
    UpdateExpression: `REMOVE ssh_keys[${keyIndex}]`
  }));

  // Log activity
  await logActivity(username, 'DELETE_SSH_KEY', 'web', keyId);

  return successResponse(200, { message: 'SSH key deleted successfully' });
}

/**
 * Validate SSH public key format
 * Requirements: 3.2
 */
function validateSSHKey(publicKey: string): string | null {
  const trimmedKey = publicKey.trim();

  // Check if empty
  if (!trimmedKey) {
    return 'SSH key cannot be empty';
  }

  // SSH public keys should start with ssh-rsa, ssh-ed25519, ecdsa-sha2-nistp256, etc.
  const validPrefixes = ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-dss'];
  const hasValidPrefix = validPrefixes.some(prefix => trimmedKey.startsWith(prefix));
  
  if (!hasValidPrefix) {
    return `SSH key must start with one of: ${validPrefixes.join(', ')}`;
  }

  // Check basic format: type base64-data [comment]
  const parts = trimmedKey.split(/\s+/);
  if (parts.length < 2) {
    return 'Invalid SSH key format. Expected: <type> <base64-data> [comment]';
  }

  // Validate base64 data (basic check)
  const base64Data = parts[1];
  if (!/^[A-Za-z0-9+/]+=*$/.test(base64Data)) {
    return 'Invalid base64 encoding in SSH key';
  }

  // Check minimum length
  if (base64Data.length < 100) {
    return 'SSH key appears to be too short';
  }

  return null; // Valid
}

/**
 * Generate SSH key fingerprint (simplified)
 */
function generateFingerprint(publicKey: string): string {
  // In production, this should use proper SSH key fingerprinting
  // For now, return a truncated hash of the key
  const parts = publicKey.split(/\s+/);
  const keyData = parts[1] || publicKey;
  return `SHA256:${keyData.substring(0, 43)}...`;
}

/**
 * Get user by email (for looking up from Cognito claims)
 */
async function getUserByEmail(email: string): Promise<any> {
  // Use GSI to query by email
  const { QueryCommand } = await import('@aws-sdk/client-dynamodb');
  
  const response = await dynamodb.send(new QueryCommand({
    TableName: USERS_TABLE,
    IndexName: 'email-index',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: {
      ':email': { S: email }
    },
    Limit: 1
  }));

  if (!response.Items || response.Items.length === 0) {
    return null;
  }

  return unmarshall(response.Items[0]);
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
      'Access-Control-Allow-Credentials': 'true'
    },
    body: JSON.stringify(data)
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
      'Access-Control-Allow-Credentials': 'true'
    },
    body: JSON.stringify({ error: message })
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
    const { marshall } = await import('@aws-sdk/util-dynamodb');
    const { PutItemCommand } = await import('@aws-sdk/client-dynamodb');
    
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
        filename: keyId || ''
      })
    }));
  } catch (error) {
    console.error('Error logging activity:', error);
    // Don't fail the operation if activity logging fails
  }
}
