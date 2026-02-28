import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const dynamodb = new DynamoDBClient({});
const s3 = new S3Client({});

const SETTINGS_TABLE = process.env.SETTINGS_TABLE!;
const USERS_TABLE = process.env.USERS_TABLE!;
const FILES_BUCKET = process.env.FILES_BUCKET!;

const SETTING_KEY = 'app';

/** Fields that can never be modified via the API */
const READ_ONLY_FIELDS = new Set([
  'settingKey', 'projectName', 'apiEndpoint', 'userPoolId',
  'userPoolClientId', 'transferServerEndpoint', 'transferServerId',
  'filesBucket', 'region', 'sftpEnabled',
]);

/** Fields that admins can update */
const EDITABLE_FIELDS = new Set([
  'appName', 'loginDescription', 'logoKey', 'faviconKey', 'acceptedFileTypes',
  'maxFileSize', 'maxStoragePerUser', 'maxFilesPerUser',
  'motd', 'defaultAccessType', 'footerText', 'footerLink', 'helpUrl',
]);

/** Fields exposed on the public (unauthenticated) endpoint */
const PUBLIC_FIELDS = new Set([
  'appName', 'loginDescription', 'logoUrl', 'faviconUrl', 'motd',
  'footerText', 'footerLink', 'helpUrl',
  'userPoolId', 'userPoolClientId', 'region', 'apiEndpoint', 'sftpEnabled',
]);

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  body?: string;
  requestContext: {
    authorizer?: {
      claims?: { sub: string; email: string; 'custom:access_type'?: string };
    };
  };
}

interface APIResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export const handler = async (event: APIGatewayEvent): Promise<APIResponse> => {
  console.log('Settings request:', { method: event.httpMethod, path: event.path });

  try {
    const pathParts = event.path.split('/').filter(p => p);
    const isAdminRoute = pathParts.includes('admin');
    const isPublicRoute = !isAdminRoute;

    // Public GET /settings — no auth required
    if (isPublicRoute && event.httpMethod === 'GET') {
      return await getPublicSettings();
    }

    // All admin routes require authentication
    const email = event.requestContext.authorizer?.claims?.email;
    if (!email) {
      return errorResponse(401, 'Unauthorized');
    }

    // Check admin access for PUT
    if (event.httpMethod === 'PUT') {
      const user = await getUserByEmail(email);
      if (!user || user.access_type !== 'ADMIN') {
        return errorResponse(403, 'Admin access required');
      }
      return await updateSettings(event);
    }

    // GET /admin/settings — any authenticated user
    if (event.httpMethod === 'GET') {
      return await getAllSettings();
    }

    // POST /admin/settings/upload-url — admin only, get pre-signed upload URL for settings assets
    if (event.httpMethod === 'POST' && event.path.includes('upload-url')) {
      const user = await getUserByEmail(email);
      if (!user || user.access_type !== 'ADMIN') {
        return errorResponse(403, 'Admin access required');
      }
      return await generateSettingsUploadUrl(event);
    }

    return errorResponse(404, 'Not found');
  } catch (error) {
    console.error('Error handling settings request:', error);
    return errorResponse(500, 'Internal server error');
  }
};

async function getPublicSettings(): Promise<APIResponse> {
  const settings = await loadSettings();
  if (!settings) {
    return errorResponse(404, 'Settings not configured');
  }

  // Generate pre-signed URLs for logo/favicon if they exist
  const publicSettings: Record<string, any> = {};
  for (const field of PUBLIC_FIELDS) {
    if (field === 'logoUrl') {
      publicSettings.logoUrl = settings.logoKey
        ? await generateSettingsAssetUrl(settings.logoKey)
        : '';
    } else if (field === 'faviconUrl') {
      publicSettings.faviconUrl = settings.faviconKey
        ? await generateSettingsAssetUrl(settings.faviconKey)
        : '';
    } else {
      publicSettings[field] = settings[field] ?? '';
    }
  }

  // Omit transfer server fields when SFTP is disabled
  if (!settings.sftpEnabled) {
    delete publicSettings.transferServerEndpoint;
    delete publicSettings.transferServerId;
  }

  return successResponse(200, publicSettings);
}

async function getAllSettings(): Promise<APIResponse> {
  const settings = await loadSettings();
  if (!settings) {
    return errorResponse(404, 'Settings not configured');
  }

  // Add pre-signed URLs for logo/favicon
  if (settings.logoKey) {
    settings.logoUrl = await generateSettingsAssetUrl(settings.logoKey);
  }
  if (settings.faviconKey) {
    settings.faviconUrl = await generateSettingsAssetUrl(settings.faviconKey);
  }

  // Mark which fields are read-only
  settings._readOnlyFields = Array.from(READ_ONLY_FIELDS);

  // Omit transfer server fields when SFTP is disabled
  if (!settings.sftpEnabled) {
    delete settings.transferServerEndpoint;
    delete settings.transferServerId;
  }

  return successResponse(200, settings);
}

async function updateSettings(event: APIGatewayEvent): Promise<APIResponse> {
  if (!event.body) {
    return errorResponse(400, 'Request body required');
  }

  const updates = JSON.parse(event.body);

  // Filter to only editable fields
  const validUpdates: Record<string, any> = {};
  const rejectedFields: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (READ_ONLY_FIELDS.has(key)) {
      rejectedFields.push(key);
    } else if (EDITABLE_FIELDS.has(key)) {
      validUpdates[key] = value;
    }
  }

  if (Object.keys(validUpdates).length === 0) {
    return errorResponse(400, 'No valid editable fields provided');
  }

  // Build update expression
  const expressionParts: string[] = [];
  const expressionNames: Record<string, string> = {};
  const expressionValues: Record<string, any> = {};

  Object.entries(validUpdates).forEach(([key, value], i) => {
    const nameKey = `#f${i}`;
    const valueKey = `:v${i}`;
    expressionParts.push(`${nameKey} = ${valueKey}`);
    expressionNames[nameKey] = key;
    expressionValues[valueKey] = value;
  });

  await dynamodb.send(new UpdateItemCommand({
    TableName: SETTINGS_TABLE,
    Key: marshall({ settingKey: SETTING_KEY }),
    UpdateExpression: `SET ${expressionParts.join(', ')}`,
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: marshall(expressionValues),
  }));

  const result: Record<string, any> = {
    message: 'Settings updated',
    updated: Object.keys(validUpdates),
  };
  if (rejectedFields.length > 0) {
    result.rejectedReadOnly = rejectedFields;
  }

  return successResponse(200, result);
}

async function generateSettingsUploadUrl(event: APIGatewayEvent): Promise<APIResponse> {
  if (!event.body) {
    return errorResponse(400, 'Request body required');
  }

  const { filename, contentType } = JSON.parse(event.body);
  if (!filename) {
    return errorResponse(400, 'Missing required field: filename');
  }

  // Ensure the key is under the settings/ prefix
  const key = filename.startsWith('settings/') ? filename : `settings/${filename}`;

  const command = new PutObjectCommand({
    Bucket: FILES_BUCKET,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

  return successResponse(200, { uploadUrl, key });
}

async function loadSettings(): Promise<Record<string, any> | null> {
  const result = await dynamodb.send(new GetItemCommand({
    TableName: SETTINGS_TABLE,
    Key: marshall({ settingKey: SETTING_KEY }),
  }));

  if (!result.Item) return null;
  return unmarshall(result.Item);
}

async function generateSettingsAssetUrl(key: string): Promise<string> {
  try {
    const command = new GetObjectCommand({ Bucket: FILES_BUCKET, Key: key });
    return await getSignedUrl(s3, command, { expiresIn: 3600 });
  } catch {
    return '';
  }
}

async function getUserByEmail(email: string): Promise<any> {
  const { QueryCommand } = await import('@aws-sdk/client-dynamodb');
  const response = await dynamodb.send(new QueryCommand({
    TableName: USERS_TABLE,
    IndexName: 'email-index',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: { ':email': { S: email } },
    Limit: 1,
  }));

  if (!response.Items || response.Items.length === 0) return null;
  return unmarshall(response.Items[0]);
}

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
