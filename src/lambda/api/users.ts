import { DynamoDBClient, PutItemCommand, GetItemCommand, ScanCommand, UpdateItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminDeleteUserCommand, AdminUpdateUserAttributesCommand, AdminSetUserMFAPreferenceCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SESClient, SendTemplatedEmailCommand } from '@aws-sdk/client-ses';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const dynamodb = new DynamoDBClient({});
const cognito = new CognitoIdentityProviderClient({});
const ses = new SESClient({});

const USERS_TABLE = process.env.USERS_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || '';
const SES_TEMPLATE_PREFIX = process.env.SES_TEMPLATE_PREFIX || '';
const SFTP_ENDPOINT = process.env.SFTP_ENDPOINT || '';
const WEB_PORTAL_URL = process.env.WEB_PORTAL_URL || 'http://localhost:5174';
const PROJECT_NAME = process.env.PROJECT_NAME || '';

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

interface UserRecord {
  username: string;
  email: string;
  display_name?: string;
  access_type: 'ADMIN' | 'WEB_ONLY' | 'SFTP_ONLY' | 'HYBRID';
  cognito_sub?: string;
  ssh_keys?: SSHKey[];
  disabled: boolean;
  is_root: boolean;
  created_at: number;
  last_login?: number;
  storage_used: number;
  file_count: number;
}

/**
 * User Management API Handler
 * 
 * Handles CRUD operations for users:
 * - POST /users - Create new user
 * - POST /users/{username}/reset-mfa - Reset user MFA (admin only)
 * - GET /users - List all users
 * - GET /users/{username} - Get specific user
 * - PUT /users/{username} - Update user
 * - DELETE /users/{username} - Delete user
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */
export const handler = async (event: APIGatewayEvent): Promise<APIResponse> => {
  console.log('User management request:', {
    method: event.httpMethod,
    path: event.path
  });

  try {
    const email = event.requestContext.authorizer?.claims?.email;
    if (!email) {
      return errorResponse(401, 'Unauthorized');
    }

    // Profile endpoint - accessible by any authenticated user
    const pathParts = event.path.split('/').filter(p => p);
    if (pathParts.includes('profile')) {
      if (event.httpMethod === 'GET') {
        return await getProfile(email);
      } else if (event.httpMethod === 'PUT') {
        return await updateProfile(email, event);
      }
      return errorResponse(405, 'Method not allowed');
    }

    // All other endpoints require admin access
    const isAdmin = event.requestContext.authorizer?.claims?.['custom:access_type'] === 'ADMIN';
    if (!isAdmin) {
      return errorResponse(403, 'Forbidden: Admin access required');
    }

    const adminEmail = email;

    // Get admin user from DynamoDB to get username
    const adminUser = await getUserByEmail(adminEmail);
    if (!adminUser) {
      return errorResponse(404, 'Admin user not found');
    }

    const adminUsername = adminUser.username;

    // Route to appropriate handler
    switch (event.httpMethod) {
      case 'POST':
        if (event.path.endsWith('/reset-mfa')) {
          const username = event.pathParameters?.username;
          if (!username) {
            return errorResponse(400, 'Username required');
          }
          return await resetUserMFA(username);
        }
        return await createUser(event, adminUsername);
      case 'GET':
        if (event.pathParameters?.username) {
          return await getUser(event.pathParameters.username);
        }
        return await listUsers(adminUsername);
      case 'PUT':
        if (event.pathParameters?.username) {
          return await updateUser(event.pathParameters.username, event, adminUsername);
        }
        return errorResponse(400, 'Username required');
      case 'DELETE':
        if (event.pathParameters?.username) {
          return await deleteUser(event.pathParameters.username, adminUsername);
        }
        return errorResponse(400, 'Username required');
      default:
        return errorResponse(405, 'Method not allowed');
    }
  } catch (error) {
    console.error('Error handling request:', error);
    return errorResponse(500, 'Internal server error');
  }
};

/**
 * Generate a unique nanoid-style username (16 characters, URL-safe)
 */
function generateUsername(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const length = 16;
  const randomBytes = require('crypto').randomBytes(length);
  let result = '';
  
  for (let i = 0; i < length; i++) {
    result += alphabet[randomBytes[i] % alphabet.length];
  }
  
  return result;
}

/**
 * Create a new user
 * Task 7.1: Implement create user endpoint
 * Requirements: 2.1, 2.2
 */
async function createUser(event: APIGatewayEvent, adminUsername: string): Promise<APIResponse> {
  if (!event.body) {
    return errorResponse(400, 'Request body required');
  }

  const data = JSON.parse(event.body);
  
  // Validate required fields (username is now auto-generated)
  if (!data.email || !data.access_type) {
    return errorResponse(400, 'Missing required fields: email, access_type');
  }
  
  // Generate unique username
  const username = generateUsername();

  // Validate access type
  const validAccessTypes = ['ADMIN', 'WEB_ONLY', 'SFTP_ONLY', 'HYBRID'];
  if (!validAccessTypes.includes(data.access_type)) {
    return errorResponse(400, `Invalid access_type. Must be one of: ${validAccessTypes.join(', ')}`);
  }

  // Reject SFTP access types when SFTP is disabled
  const sftpEnabled = process.env.SFTP_ENABLED !== 'false';
  if (!sftpEnabled && (data.access_type === 'SFTP_ONLY' || data.access_type === 'HYBRID')) {
    return errorResponse(400, 'SFTP is not enabled. Only ADMIN and WEB_ONLY access types are allowed.');
  }

  // Validate SFTP-only users have SSH keys
  if ((data.access_type === 'SFTP_ONLY' || data.access_type === 'HYBRID') && 
      (!data.ssh_keys || data.ssh_keys.length === 0)) {
    return errorResponse(400, 'SFTP_ONLY and HYBRID users must have at least one SSH key');
  }

  // Check if email already exists
  const existingUser = await getUserByEmail(data.email);
  if (existingUser) {
    return errorResponse(409, 'User with this email already exists');
  }

  const now = Date.now();
  
  // Convert SSH keys from strings to proper format
  const sshKeys: SSHKey[] = (data.ssh_keys || []).map((key: string) => ({
    key_id: generateKeyId(),
    public_key: key,
    added_date: now
  }));
  
  // Generate temporary password for web-enabled users
  const temporaryPassword = (data.access_type === 'ADMIN' || data.access_type === 'WEB_ONLY' || data.access_type === 'HYBRID')
    ? (data.temporary_password || generateTemporaryPassword())
    : undefined;
  
  const user: UserRecord = {
    username: username,  // Auto-generated
    email: data.email,
    display_name: data.display_name || data.email.split('@')[0],
    access_type: data.access_type,
    ssh_keys: sshKeys,
    disabled: false,
    is_root: false, // Regular users created via API are never root
    created_at: now,
    storage_used: 0,
    file_count: 0
  };

  // Create user in Cognito for all access types
  // This provides consistent authentication and email uniqueness enforcement
  try {
    const cognitoResponse = await cognito.send(new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: data.email,
      UserAttributes: [
        { Name: 'email', Value: data.email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'custom:access_type', Value: data.access_type }
      ],
      TemporaryPassword: temporaryPassword,
      MessageAction: 'SUPPRESS' // Suppress default email - we'll send custom emails per access type
    }));

    user.cognito_sub = cognitoResponse.User?.Username;
  } catch (error: any) {
    console.error('Error creating Cognito user:', error);
    return errorResponse(500, `Failed to create Cognito user: ${error.message}`);
  }

  // Create user in DynamoDB
  try {
    await dynamodb.send(new PutItemCommand({
      TableName: USERS_TABLE,
      Item: marshall(user),
      ConditionExpression: 'attribute_not_exists(username)'
    }));
  } catch (error: any) {
    // If DynamoDB fails, clean up Cognito user
    if (user.cognito_sub) {
      await cognito.send(new AdminDeleteUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: data.email
      })).catch(err => console.error('Failed to cleanup Cognito user:', err));
    }
    throw error;
  }

  // Send welcome email via SES
  await sendWelcomeEmail(data.email, username, data.access_type, temporaryPassword);

  // Log activity
  await logActivity(adminUsername, 'CREATE_USER', 'web', user.username);

  return successResponse(201, user);
}

/**
 * List all users
 * Task 7.1: Implement list users endpoint
 * Requirements: 2.5
 */
async function listUsers(adminUsername: string): Promise<APIResponse> {
  const response = await dynamodb.send(new ScanCommand({
    TableName: USERS_TABLE
  }));

  const users = response.Items?.map(item => unmarshall(item)) || [];
  
  // Remove sensitive data
  const sanitizedUsers = users.map(user => ({
    username: user.username,
    email: user.email,
    display_name: user.display_name || '',
    access_type: user.access_type,
    status: user.disabled ? 'disabled' : 'active',
    disabled: user.disabled,
    is_root: user.is_root || false,
    created_at: user.created_at,
    last_login: user.last_login,
    storage_bytes: user.storage_used || 0, // Map storage_used to storage_bytes for frontend
    file_count: user.file_count || 0
  }));

  // Log activity
  await logActivity(adminUsername, 'LIST_USERS', 'web');

  return successResponse(200, { users: sanitizedUsers, count: sanitizedUsers.length });
}

/**
 * Get a specific user
 */
async function getUser(username: string): Promise<APIResponse> {
  const user = await getUserFromDynamoDB(username);
  
  if (!user) {
    return errorResponse(404, 'User not found');
  }

  // Remove sensitive data
  const sanitizedUser = {
    username: user.username,
    email: user.email,
    display_name: user.display_name || '',
    access_type: user.access_type,
    disabled: user.disabled,
    created_at: user.created_at,
    last_login: user.last_login,
    storage_used: user.storage_used,
    file_count: user.file_count,
    ssh_key_count: user.ssh_keys?.length || 0
  };

  return successResponse(200, sanitizedUser);
}

/**
 * Update a user
 * Task 7.1: Implement update user endpoint
 * Requirements: 2.3
 */
async function updateUser(username: string, event: APIGatewayEvent, adminUsername: string): Promise<APIResponse> {
  if (!event.body) {
    return errorResponse(400, 'Request body required');
  }

  const data = JSON.parse(event.body);
  const user = await getUserFromDynamoDB(username);
  
  if (!user) {
    return errorResponse(404, 'User not found');
  }

  // Prevent modification of root users
  if (user.is_root) {
    return errorResponse(403, 'Cannot modify root user. Root users can only be managed via CDK deployment.');
  }

  // Build update expression
  const updates: string[] = [];
  const attributeNames: { [key: string]: string } = {};
  const attributeValues: { [key: string]: any } = {};

  if (data.disabled !== undefined) {
    updates.push('#disabled = :disabled');
    attributeNames['#disabled'] = 'disabled';
    attributeValues[':disabled'] = { BOOL: data.disabled };
  }

  if (data.display_name !== undefined) {
    updates.push('#display_name = :display_name');
    attributeNames['#display_name'] = 'display_name';
    attributeValues[':display_name'] = { S: data.display_name };
  }

  if (data.access_type && data.access_type !== user.access_type) {
    const validAccessTypes = ['ADMIN', 'WEB_ONLY', 'SFTP_ONLY', 'HYBRID'];
    if (!validAccessTypes.includes(data.access_type)) {
      return errorResponse(400, `Invalid access_type. Must be one of: ${validAccessTypes.join(', ')}`);
    }

    // Reject SFTP access types when SFTP is disabled
    const sftpEnabled = process.env.SFTP_ENABLED !== 'false';
    if (!sftpEnabled && (data.access_type === 'SFTP_ONLY' || data.access_type === 'HYBRID')) {
      return errorResponse(400, 'SFTP is not enabled. Only ADMIN and WEB_ONLY access types are allowed.');
    }

    updates.push('#access_type = :access_type');
    attributeNames['#access_type'] = 'access_type';
    attributeValues[':access_type'] = { S: data.access_type };

    // Update Cognito if user has web access
    if (user.cognito_sub) {
      await cognito.send(new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: user.email,
        UserAttributes: [
          { Name: 'custom:access_type', Value: data.access_type }
        ]
      }));
    }
  }

  if (updates.length === 0) {
    return errorResponse(400, 'No valid updates provided');
  }

  // Update DynamoDB
  await dynamodb.send(new UpdateItemCommand({
    TableName: USERS_TABLE,
    Key: { username: { S: username } },
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeNames: attributeNames,
    ExpressionAttributeValues: attributeValues
  }));

  // Log activity
  await logActivity(adminUsername, 'UPDATE_USER', 'web', username);

  return successResponse(200, { message: 'User updated successfully' });
}

/**
 * Delete a user
 * Task 7.1: Implement delete user endpoint
 * Task 12.3: Ensure file retention after user deletion
 * Requirements: 2.4, 8.3
 * 
 * Note: This function deletes the user from Cognito and DynamoDB only.
 * User files in S3 are intentionally NOT deleted to maintain audit trail
 * and comply with data retention requirements.
 */
async function deleteUser(username: string, adminUsername: string): Promise<APIResponse> {
  const user = await getUserFromDynamoDB(username);
  
  if (!user) {
    return errorResponse(404, 'User not found');
  }

  // Prevent deletion of root users
  if (user.is_root) {
    return errorResponse(403, 'Cannot delete root user. Root users can only be managed via CDK deployment.');
  }

  // Delete from Cognito if user has web access
  if (user.cognito_sub) {
    try {
      await cognito.send(new AdminDeleteUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: user.email
      }));
    } catch (error) {
      console.error('Error deleting Cognito user:', error);
      // Continue with DynamoDB deletion even if Cognito fails
    }
  }

  // Delete from DynamoDB
  // Note: User files in S3 are NOT deleted - they remain for audit purposes
  await dynamodb.send(new DeleteItemCommand({
    TableName: USERS_TABLE,
    Key: { username: { S: username } }
  }));

  // Log activity
  await logActivity(adminUsername, 'DELETE_USER', 'web', username);

  return successResponse(200, { message: 'User deleted successfully' });
}

/**
 * Reset a user's MFA configuration
 * Task 8.1: Admin MFA reset endpoint
 * Requirements: 6.1, 6.2, 6.5
 */
async function resetUserMFA(username: string): Promise<APIResponse> {
  const user = await getUserFromDynamoDB(username);

  if (!user) {
    return errorResponse(404, 'User not found');
  }

  try {
    await cognito.send(new AdminSetUserMFAPreferenceCommand({
      UserPoolId: USER_POOL_ID,
      Username: user.email,
      SoftwareTokenMfaSettings: {
        Enabled: false,
        PreferredMfa: false,
      },
    }));
  } catch (error: any) {
    console.error('Error resetting MFA for user:', username, error);
    return errorResponse(500, `Failed to reset MFA: ${error.message}`);
  }

  return successResponse(200, { message: `MFA reset successfully for user ${username}` });
}

/**
 * Get current user's profile
 */
async function getProfile(email: string): Promise<APIResponse> {
  const user = await getUserByEmail(email);
  if (!user) {
    return errorResponse(404, 'User not found');
  }

  return successResponse(200, {
    username: user.username,
    email: user.email,
    display_name: user.display_name || '',
    access_type: user.access_type,
    created_at: user.created_at,
    last_login: user.last_login,
    storage_used: user.storage_used,
    file_count: user.file_count,
  });
}

/**
 * Update current user's profile (display_name only)
 */
async function updateProfile(email: string, event: APIGatewayEvent): Promise<APIResponse> {
  if (!event.body) {
    return errorResponse(400, 'Request body required');
  }

  const user = await getUserByEmail(email);
  if (!user) {
    return errorResponse(404, 'User not found');
  }

  const data = JSON.parse(event.body);

  if (data.display_name === undefined) {
    return errorResponse(400, 'No valid updates provided');
  }

  // Validate display_name length
  const displayName = (data.display_name || '').trim();
  if (displayName.length > 100) {
    return errorResponse(400, 'Display name must be 100 characters or less');
  }

  await dynamodb.send(new UpdateItemCommand({
    TableName: USERS_TABLE,
    Key: { username: { S: user.username } },
    UpdateExpression: 'SET #dn = :dn',
    ExpressionAttributeNames: { '#dn': 'display_name' },
    ExpressionAttributeValues: { ':dn': { S: displayName } },
  }));

  return successResponse(200, {
    message: 'Profile updated successfully',
    display_name: displayName,
  });
}

/**
 * Helper: Get user from DynamoDB by username
 */
async function getUserFromDynamoDB(username: string): Promise<UserRecord | null> {
  const response = await dynamodb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: { username: { S: username } }
  }));

  if (!response.Item) {
    return null;
  }

  return unmarshall(response.Item) as UserRecord;
}

/**
 * Helper: Get user from DynamoDB by email
 */
async function getUserByEmail(email: string): Promise<UserRecord | null> {
  const response = await dynamodb.send(new ScanCommand({
    TableName: USERS_TABLE,
    FilterExpression: 'email = :email',
    ExpressionAttributeValues: {
      ':email': { S: email }
    }
  }));

  if (!response.Items || response.Items.length === 0) {
    return null;
  }

  return unmarshall(response.Items[0]) as UserRecord;
}

/**
 * Helper: Generate key ID
 */
function generateKeyId(): string {
  return `key-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Helper: Generate temporary password
 */
function generateTemporaryPassword(): string {
  const length = 12;
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  
  // Ensure at least one of each required character type
  password += 'A'; // uppercase
  password += 'a'; // lowercase
  password += '1'; // digit
  password += '!'; // special
  
  // Fill the rest randomly
  for (let i = password.length; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  
  // Shuffle the password
  return password.split('').sort(() => Math.random() - 0.5).join('');
}

/**
 * Send welcome email via SES based on access type
 */
async function sendWelcomeEmail(
  email: string,
  username: string,
  accessType: string,
  temporaryPassword?: string
): Promise<void> {
  // Skip if SES is not configured
  if (!SES_FROM_EMAIL) {
    console.log('SES not configured, skipping welcome email');
    return;
  }

  // Determine template name based on access type
  const templateMap: Record<string, string> = {
    'ADMIN': 'admin-welcome',
    'WEB_ONLY': 'web-only-welcome',
    'SFTP_ONLY': 'sftp-only-welcome',
    'HYBRID': 'hybrid-welcome'
  };

  const templateName = `${SES_TEMPLATE_PREFIX}-${templateMap[accessType]}`;

  // Build template data
  const templateData: Record<string, string> = {
    email,
    username,
    projectName: PROJECT_NAME,
    sftpEndpoint: SFTP_ENDPOINT,
    webPortalUrl: WEB_PORTAL_URL
  };

  // Add temporary password for web-enabled users
  if (temporaryPassword && (accessType === 'ADMIN' || accessType === 'WEB_ONLY' || accessType === 'HYBRID')) {
    templateData.temporaryPassword = temporaryPassword;
  }

  try {
    await ses.send(new SendTemplatedEmailCommand({
      Source: SES_FROM_EMAIL,
      Destination: {
        ToAddresses: [email]
      },
      Template: templateName,
      TemplateData: JSON.stringify(templateData)
    }));

    console.log(`Welcome email sent to ${email} using template ${templateName}`);
  } catch (error) {
    console.error('Error sending welcome email:', error);
    // Don't fail user creation if email fails
  }
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
  targetUser?: string
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
        filename: targetUser || ''
      })
    }));
  } catch (error) {
    console.error('Error logging activity:', error);
    // Don't fail the operation if activity logging fails
  }
}
