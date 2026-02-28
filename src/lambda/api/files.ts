import { S3Client, ListObjectsV2Command, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});
const cloudwatch = new CloudWatchClient({});

const FILES_BUCKET = process.env.FILES_BUCKET!;
const USERS_TABLE = process.env.USERS_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const SETTINGS_TABLE = process.env.SETTINGS_TABLE!;
const SHARED_FOLDER_ENABLED = process.env.SHARED_FOLDER_ENABLED === 'true';
const SHARED_FOLDER_NAME = process.env.SHARED_FOLDER_NAME || 'shared';
const SHARED_FOLDER_PERMISSIONS = process.env.SHARED_FOLDER_PERMISSIONS || 'read-write';

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  requestContext: {
    authorizer?: {
      claims?: {
        sub: string;
        email: string;
        'custom:access_type'?: string;
      };
      // API key authorizer context
      username?: string;
      email?: string;
      keyId?: string;
    };
  };
}

interface APIResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

interface FileMetadata {
  key: string;
  name: string;
  size: number;
  lastModified: number;
  folder?: string;
}

type FolderType = 'private' | 'shared';

/**
 * File Operations API Handler
 * 
 * Handles file operations:
 * - GET /files?folder=private|shared - List user's files
 * - POST /files/upload-url - Generate pre-signed upload URL
 * - POST /files/download-url - Generate pre-signed download URL
 * - DELETE /files - Delete file
 * 
 * Requirements: 6.1, 7.1, 7.5, 8.1
 */
export const handler = async (event: APIGatewayEvent): Promise<APIResponse> => {
  console.log('File operations request:', {
    method: event.httpMethod,
    path: event.path,
    queryParams: event.queryStringParameters
  });

  try {
    // Check for API key auth (keyId in authorizer context)
    const authContext = event.requestContext.authorizer;
    const isApiKeyAuth = !!authContext?.keyId;

    let user;
    let protocol = 'web';

    if (isApiKeyAuth) {
      // API key auth: username comes directly from authorizer context
      const username = authContext!.username;
      if (!username) {
        return errorResponse(401, 'Unauthorized');
      }
      user = await getUserByUsername(username);
      protocol = 'api-key';
    } else {
      // Cognito auth: look up user by email from claims
      const email = authContext?.claims?.email;
      if (!email) {
        return errorResponse(401, 'Unauthorized');
      }
      user = await getUserByEmail(email);
    }

    if (!user) {
      return errorResponse(404, 'User not found');
    }

    // Check if user is disabled
    if (user.disabled) {
      return errorResponse(403, 'User account is disabled');
    }

    // Route to appropriate handler
    const pathParts = event.path.split('/').filter(p => p);

    if (event.httpMethod === 'GET' && pathParts[pathParts.length - 1] === 'files') {
      return await listFiles(user.username, event, protocol);
    } else if (event.httpMethod === 'POST' && pathParts.includes('upload-url')) {
      return await generateUploadUrl(user.username, event, protocol);
    } else if (event.httpMethod === 'POST' && pathParts.includes('download-url')) {
      return await generateDownloadUrl(user.username, event, protocol);
    } else if (event.httpMethod === 'DELETE' && pathParts[pathParts.length - 1] === 'files') {
      return await deleteFile(user.username, event, protocol);
    } else if (event.httpMethod === 'POST' && pathParts.includes('folder')) {
      return await createFolder(user.username, event, protocol);
    } else if (event.httpMethod === 'DELETE' && pathParts.includes('folder')) {
      return await deleteFolder(user.username, event, protocol);
    } else {
      return errorResponse(404, 'Not found');
    }
  } catch (error) {
    console.error('Error handling request:', error);
    return errorResponse(500, 'Internal server error');
  }
};

/**
 * List files for user
 * Task 11.1: Query S3 for user's files
 * Requirements: 7.5, 8.1
 */
async function listFiles(username: string, event: APIGatewayEvent, protocol: string): Promise<APIResponse> {
  // Get folder parameter (defaults to 'private')
  const folder = (event.queryStringParameters?.folder || 'private') as FolderType;
  const subPath = event.queryStringParameters?.path || '';

  // Validate folder parameter
  const validationError = validateFolder(folder);
  if (validationError) {
    return validationError;
  }

  // Determine S3 prefix based on folder + sub-path
  const basePrefix = folder === 'shared' ? `${SHARED_FOLDER_NAME}/` : `users/${username}/`;
  const prefix = subPath ? `${basePrefix}${subPath}/` : basePrefix;

  try {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: FILES_BUCKET,
      Prefix: prefix,
      Delimiter: '/',
    }));

    // Files are in Contents (excluding the directory marker itself)
    const files: FileMetadata[] = (response.Contents || [])
      .filter(obj => obj.Key !== prefix && !obj.Key!.endsWith('/'))
      .map(obj => ({
        key: obj.Key!,
        name: obj.Key!.replace(prefix, ''),
        size: obj.Size || 0,
        lastModified: obj.LastModified?.getTime() || 0,
        folder
      }));

    // Folders are in CommonPrefixes
    const folders = (response.CommonPrefixes || []).map(cp => {
      const fullPrefix = cp.Prefix!;
      const name = fullPrefix.replace(prefix, '').replace(/\/$/, '');
      return {
        name,
        type: 'folder' as const,
        key: fullPrefix,
      };
    });

    // Log file list operation
    await logFileOperation(username, 'LIST_FILES', protocol, files.length, undefined, folder);

    return successResponse(200, {
      files,
      folders,
      count: files.length + folders.length,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      folder
    });
  } catch (error) {
    console.error('Error listing files:', error);
    return errorResponse(500, 'Failed to list files');
  }
}

/**
 * Generate pre-signed upload URL
 * Task 11.3: Generate upload URLs with 15 minute expiry
 * Requirements: 6.1
 */
async function generateUploadUrl(username: string, event: APIGatewayEvent, protocol: string): Promise<APIResponse> {
  if (!event.body) {
    return errorResponse(400, 'Request body required');
  }

  const data = JSON.parse(event.body);

  if (!data.filename) {
    return errorResponse(400, 'Missing required field: filename');
  }

  // Get folder parameter (defaults to 'private')
  const folder = (data.folder || 'private') as FolderType;

  // Validate folder parameter
  const validationError = validateFolder(folder);
  if (validationError) {
    return validationError;
  }

  // Check write permissions for shared folder
  if (folder === 'shared') {
    const permissionError = checkSharedFolderWritePermission();
    if (permissionError) {
      return permissionError;
    }
  }

  // Sanitize filename
  const sanitizedFilename = sanitizeFilename(data.filename);

  // Validate against settings
  const settings = await getSettings();

  // Check accepted file types
  if (settings.acceptedFileTypes.length > 0) {
    const ext = sanitizedFilename.includes('.')
      ? '.' + sanitizedFilename.split('.').pop()!.toLowerCase()
      : '';
    const allowed = settings.acceptedFileTypes.map((t: string) =>
      t.startsWith('.') ? t.toLowerCase() : `.${t.toLowerCase()}`
    );
    if (!ext || !allowed.includes(ext)) {
      return errorResponse(400, `File type not allowed. Accepted types: ${settings.acceptedFileTypes.join(', ')}`);
    }
  }

  // Check user storage quota and file count (private folder only)
  if (folder === 'private') {
    const user = await getUserByUsername(username);
    if (user) {
      const currentFiles = user.file_count || 0;
      const currentStorage = user.storage_bytes || 0;
      if (currentFiles >= settings.maxFilesPerUser) {
        return errorResponse(400, `File count limit reached (${settings.maxFilesPerUser})`);
      }
      if (currentStorage >= settings.maxStoragePerUser) {
        return errorResponse(400, 'Storage quota exceeded');
      }
    }
  }

  // Determine S3 key based on folder + path
  const basePath = folder === 'shared'
    ? `${SHARED_FOLDER_NAME}/`
    : `users/${username}/`;
  const subPath = data.path ? `${data.path}/` : '';
  const key = `${basePath}${subPath}${sanitizedFilename}`;

  try {
    // Generate pre-signed URL for upload (15 minutes)
    const command = new PutObjectCommand({
      Bucket: FILES_BUCKET,
      Key: key,
      ContentType: data.contentType || 'application/octet-stream'
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 }); // 15 minutes

    // Log upload URL generation
    await logFileOperation(username, 'UPLOAD_URL_GENERATED', protocol, 1, sanitizedFilename, folder);

    return successResponse(200, {
      uploadUrl,
      key,
      filename: sanitizedFilename,
      folder,
      expiresIn: 900
    });
  } catch (error) {
    console.error('Error generating upload URL:', error);
    return errorResponse(500, 'Failed to generate upload URL');
  }
}

/**
 * Generate pre-signed download URL
 * Task 11.3: Generate download URLs with 5 minute expiry
 * Requirements: 7.1
 */
async function generateDownloadUrl(username: string, event: APIGatewayEvent, protocol: string): Promise<APIResponse> {
  if (!event.body) {
    return errorResponse(400, 'Request body required');
  }

  const data = JSON.parse(event.body);

  if (!data.filename) {
    return errorResponse(400, 'Missing required field: filename');
  }

  // Get folder parameter (defaults to 'private')
  const folder = (data.folder || 'private') as FolderType;

  // Validate folder parameter
  const validationError = validateFolder(folder);
  if (validationError) {
    return validationError;
  }

  // Determine S3 key based on folder + path
  const basePath = folder === 'shared'
    ? `${SHARED_FOLDER_NAME}/`
    : `users/${username}/`;
  const subPath = data.path ? `${data.path}/` : '';
  const key = `${basePath}${subPath}${data.filename}`;

  try {
    // Check if file exists
    await s3.send(new HeadObjectCommand({
      Bucket: FILES_BUCKET,
      Key: key
    }));

    // Generate pre-signed URL for download (5 minutes)
    const command = new GetObjectCommand({
      Bucket: FILES_BUCKET,
      Key: key
    });

    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 minutes

    // Log download URL generation
    await logFileOperation(username, 'DOWNLOAD_URL_GENERATED', protocol, 1, data.filename, folder);

    return successResponse(200, {
      downloadUrl,
      filename: data.filename,
      folder,
      expiresIn: 300
    });
  } catch (error: any) {
    if (error.name === 'NotFound') {
      return errorResponse(404, 'File not found');
    }
    console.error('Error generating download URL:', error);
    return errorResponse(500, 'Failed to generate download URL');
  }
}

/**
 * Delete file
 * Task 11.5: Delete file from S3
 * Requirements: 8.1
 */
async function deleteFile(username: string, event: APIGatewayEvent, protocol: string): Promise<APIResponse> {
  if (!event.body) {
    return errorResponse(400, 'Request body required');
  }

  const data = JSON.parse(event.body);
  const filename = data.filename;

  if (!filename) {
    return errorResponse(400, 'Missing required parameter: filename');
  }

  // Get folder parameter (defaults to 'private')
  const folder = (data.folder || 'private') as FolderType;

  // Validate folder parameter
  const validationError = validateFolder(folder);
  if (validationError) {
    return validationError;
  }

  // Check write permissions for shared folder
  if (folder === 'shared') {
    const permissionError = checkSharedFolderWritePermission();
    if (permissionError) {
      return permissionError;
    }
  }

  // Determine S3 key based on folder + path
  const basePath = folder === 'shared'
    ? `${SHARED_FOLDER_NAME}/`
    : `users/${username}/`;
  const subPath = data.path ? `${data.path}/` : '';
  const key = `${basePath}${subPath}${filename}`;

  try {
    // Check if file exists and get size
    const headResponse = await s3.send(new HeadObjectCommand({
      Bucket: FILES_BUCKET,
      Key: key
    }));

    const fileSize = headResponse.ContentLength || 0;

    // Delete file from S3
    await s3.send(new DeleteObjectCommand({
      Bucket: FILES_BUCKET,
      Key: key
    }));

    // Note: Stats are updated automatically by S3 event handler
    // No need to update here to avoid double-counting

    // Log file deletion
    await logFileOperation(username, 'DELETE_FILE', protocol, 1, filename, folder);

    return successResponse(200, {
      message: 'File deleted successfully',
      filename,
      folder
    });
  } catch (error: any) {
    if (error.name === 'NotFound') {
      return errorResponse(404, 'File not found');
    }
    console.error('Error deleting file:', error);
    return errorResponse(500, 'Failed to delete file');
  }
}

/**
 * Create folder in S3
 */
async function createFolder(username: string, event: APIGatewayEvent, protocol: string): Promise<APIResponse> {
  if (!event.body) {
    return errorResponse(400, 'Request body required');
  }

  const data = JSON.parse(event.body);
  if (!data.folderName) {
    return errorResponse(400, 'Missing required field: folderName');
  }

  const folder = (data.folder || 'private') as FolderType;
  const validationError = validateFolder(folder);
  if (validationError) return validationError;

  if (folder === 'shared') {
    const permissionError = checkSharedFolderWritePermission();
    if (permissionError) return permissionError;
  }

  // Sanitize folder name
  const sanitizedName = data.folderName.replace(/[^a-zA-Z0-9\s_-]/g, '_').trim();
  if (!sanitizedName) {
    return errorResponse(400, 'Invalid folder name');
  }

  // Build the S3 key with optional path prefix
  const basePath = folder === 'shared'
    ? `${SHARED_FOLDER_NAME}/`
    : `users/${username}/`;
  const subPath = data.path ? `${data.path}/` : '';
  const key = `${basePath}${subPath}${sanitizedName}/`;

  try {
    // Create a zero-byte object to represent the folder
    await s3.send(new PutObjectCommand({
      Bucket: FILES_BUCKET,
      Key: key,
      Body: '',
      ContentType: 'application/x-directory',
    }));

    await logFileOperation(username, 'CREATE_FOLDER', protocol, 1, sanitizedName, folder);

    return successResponse(201, {
      message: 'Folder created successfully',
      folderName: sanitizedName,
      folder,
    });
  } catch (error) {
    console.error('Error creating folder:', error);
    return errorResponse(500, 'Failed to create folder');
  }
}

/**
 * Delete folder in S3 (must be empty)
 */
async function deleteFolder(username: string, event: APIGatewayEvent, protocol: string): Promise<APIResponse> {
  if (!event.body) {
    return errorResponse(400, 'Request body required');
  }

  const data = JSON.parse(event.body);
  if (!data.folderName) {
    return errorResponse(400, 'Missing required field: folderName');
  }

  const folder = (data.folder || 'private') as FolderType;
  const validationError = validateFolder(folder);
  if (validationError) return validationError;

  if (folder === 'shared') {
    const permissionError = checkSharedFolderWritePermission();
    if (permissionError) return permissionError;
  }

  const basePath = folder === 'shared'
    ? `${SHARED_FOLDER_NAME}/`
    : `users/${username}/`;
  const subPath = data.path ? `${data.path}/` : '';
  const prefix = `${basePath}${subPath}${data.folderName}/`;

  try {
    // Check if folder has contents beyond the marker
    const contents = await s3.send(new ListObjectsV2Command({
      Bucket: FILES_BUCKET,
      Prefix: prefix,
      MaxKeys: 2,
    }));

    const objects = contents.Contents || [];
    const nonMarkerObjects = objects.filter(o => o.Key !== prefix);
    if (nonMarkerObjects.length > 0) {
      return errorResponse(400, 'Folder is not empty');
    }

    // Delete the folder marker
    await s3.send(new DeleteObjectCommand({
      Bucket: FILES_BUCKET,
      Key: prefix,
    }));

    await logFileOperation(username, 'DELETE_FOLDER', protocol, 1, data.folderName, folder);

    return successResponse(200, {
      message: 'Folder deleted successfully',
      folderName: data.folderName,
      folder,
    });
  } catch (error) {
    console.error('Error deleting folder:', error);
    return errorResponse(500, 'Failed to delete folder');
  }
}

/**
 * Sanitize filename to prevent path traversal
 */
function sanitizeFilename(filename: string): string {
  // Remove any path components
  const basename = filename.split('/').pop() || filename;
  
  // Remove any dangerous characters
  return basename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Validate folder parameter
 */
function validateFolder(folder: string): APIResponse | null {
  if (folder !== 'private' && folder !== 'shared') {
    return errorResponse(400, 'Invalid folder parameter. Must be "private" or "shared"');
  }
  
  if (folder === 'shared' && !SHARED_FOLDER_ENABLED) {
    return errorResponse(403, 'Shared folder is not enabled');
  }
  
  return null;
}

/**
 * Check if user has write permission to shared folder
 */
function checkSharedFolderWritePermission(): APIResponse | null {
  if (!SHARED_FOLDER_ENABLED) {
    return errorResponse(403, 'Shared folder is not enabled');
  }
  
  if (SHARED_FOLDER_PERMISSIONS === 'read-only') {
    return errorResponse(403, 'Shared folder is read-only');
  }
  
  return null;
}

/**
 * Update user storage statistics
 */
async function updateUserStorage(username: string, sizeDelta: number, countDelta: number): Promise<void> {
  try {
    await dynamodb.send(new UpdateItemCommand({
      TableName: USERS_TABLE,
      Key: { username: { S: username } },
      UpdateExpression: 'ADD storage_used :size, file_count :count',
      ExpressionAttributeValues: {
        ':size': { N: sizeDelta.toString() },
        ':count': { N: countDelta.toString() }
      }
    }));
  } catch (error) {
    console.error('Error updating user storage:', error);
    // Don't fail the operation if storage update fails
  }
}

/**
 * Log file operation to DynamoDB activity table and CloudWatch
 * Task 11.6: Add CloudWatch logging for file operations
 * Requirements: 11.3, 11.4
 */
async function logFileOperation(
  username: string,
  action: string,
  protocol: string,
  fileCount: number,
  filename?: string,
  folder?: string
): Promise<void> {
  const timestamp = Date.now();
  const activityId = `${timestamp}-${Math.random().toString(36).substring(7)}`;
  
  // Write to DynamoDB activity table
  try {
    const { PutItemCommand } = await import('@aws-sdk/client-dynamodb');
    const { marshall } = await import('@aws-sdk/util-dynamodb');
    
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
        filename: filename || '',
        folder: folder || 'private'
      })
    }));
  } catch (error) {
    console.error('Error writing to activity table:', error);
    // Don't fail the operation if activity logging fails
  }
  
  // Also log to CloudWatch for debugging
  console.log(JSON.stringify({
    timestamp: new Date(timestamp).toISOString(),
    username,
    action,
    protocol,
    filename: filename || undefined,
    fileCount,
    folder: folder || 'private'
  }));

  // Publish metrics to CloudWatch
  // Task 11.8: Implement CloudWatch metrics publishing
  // Requirements: 11.5
  try {
    const metricName = action.includes('UPLOAD') ? 'FileUploads' : 
                       action.includes('DOWNLOAD') ? 'FileDownloads' :
                       action === 'DELETE' ? 'FileDeletions' : 'FileOperations';

    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: 'TransferPortal',
      MetricData: [{
        MetricName: metricName,
        Value: fileCount,
        Unit: 'Count',
        Timestamp: new Date(),
        Dimensions: [
          { Name: 'Username', Value: username },
          { Name: 'Protocol', Value: protocol },
          { Name: 'Folder', Value: folder || 'private' }
        ]
      }]
    }));
  } catch (error) {
    console.error('Error publishing metrics:', error);
    // Don't fail the operation if metrics fail
  }
}

/**
 * Get user by email (for looking up from Cognito claims)
 */
async function getUserByEmail(email: string): Promise<any> {
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
 * Get user by username (for API key auth where username comes from authorizer context)
 */
async function getUserByUsername(username: string): Promise<any> {
  const response = await dynamodb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: { username: { S: username } }
  }));
  if (!response.Item) return null;
  return unmarshall(response.Item);
}



// Cached settings to avoid repeated DynamoDB reads within the same Lambda invocation
let cachedSettings: any = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 60000; // 1 minute

/**
 * Load application settings from DynamoDB
 */
async function getSettings(): Promise<{
  acceptedFileTypes: string[];
  maxFileSize: number;
  maxStoragePerUser: number;
  maxFilesPerUser: number;
}> {
  const now = Date.now();
  if (cachedSettings && (now - settingsCacheTime) < SETTINGS_CACHE_TTL) {
    return cachedSettings;
  }

  try {
    const result = await dynamodb.send(new GetItemCommand({
      TableName: SETTINGS_TABLE,
      Key: { settingKey: { S: 'app' } },
    }));

    if (result.Item) {
      const item = unmarshall(result.Item);
      cachedSettings = {
        acceptedFileTypes: item.acceptedFileTypes || [],
        maxFileSize: item.maxFileSize || 104857600, // 100MB default
        maxStoragePerUser: item.maxStoragePerUser || 1073741824, // 1GB default
        maxFilesPerUser: item.maxFilesPerUser || 1000,
      };
    } else {
      cachedSettings = {
        acceptedFileTypes: [],
        maxFileSize: 104857600,
        maxStoragePerUser: 1073741824,
        maxFilesPerUser: 1000,
      };
    }
    settingsCacheTime = now;
    return cachedSettings;
  } catch (error) {
    console.error('Error loading settings:', error);
    // Return defaults on error
    return {
      acceptedFileTypes: [],
      maxFileSize: 104857600,
      maxStoragePerUser: 1073741824,
      maxFilesPerUser: 1000,
    };
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
