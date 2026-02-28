import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { DynamoDBClient, ScanCommand, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});
const cloudwatchLogs = new CloudWatchLogsClient({});

const FILES_BUCKET = process.env.FILES_BUCKET!;
const USERS_TABLE = process.env.USERS_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const PROJECT_NAME = process.env.PROJECT_NAME!;

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
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

interface SystemStats {
  totalUsers: number;
  usersByAccessType: {
    ADMIN: number;
    WEB_ONLY: number;
    SFTP_ONLY: number;
    HYBRID: number;
  };
  totalFiles: number;
  totalStorageBytes: number;
  totalStorageGB: number;
}

interface UserStats {
  username: string;
  fileCount: number;
  storageBytes: number;
  storageGB: number;
  lastLogin?: number;
}

interface ActivityLogEntry {
  timestamp: string;
  username: string;
  action: string;
  protocol: string;
  filename?: string;
  details?: string;
}

/**
 * Admin Dashboard API Handler
 * 
 * Handles admin dashboard operations:
 * - GET /admin/stats - Get system statistics
 * - GET /admin/stats/{username} - Get per-user statistics
 * - GET /admin/activity - Get recent activity log
 * 
 * Requirements: 12.1, 12.2, 12.3, 12.4
 */
export const handler = async (event: APIGatewayEvent): Promise<APIResponse> => {
  console.log('Admin dashboard request:', {
    method: event.httpMethod,
    path: event.path
  });

  try {
    // Check if user is admin
    const accessType = event.requestContext.authorizer?.claims?.['custom:access_type'];
    if (accessType !== 'ADMIN') {
      return errorResponse(403, 'Forbidden: Admin access required');
    }

    // Route to appropriate handler
    const pathParts = event.path.split('/').filter(p => p);
    
    if (pathParts.includes('stats')) {
      if (event.pathParameters?.username) {
        return await getUserStats(event.pathParameters.username);
      }
      return await getSystemStats();
    } else if (pathParts.includes('activity')) {
      const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
      return await getActivityLog(limit);
    } else {
      return errorResponse(404, 'Not found');
    }
  } catch (error) {
    console.error('Error handling request:', error);
    return errorResponse(500, 'Internal server error');
  }
};

/**
 * Get system statistics
 * Task 13.1: Calculate total user count by access type and storage usage
 * Requirements: 12.1, 12.2
 */
async function getSystemStats(): Promise<APIResponse> {
  try {
    // Get all users from DynamoDB
    const usersResponse = await dynamodb.send(new ScanCommand({
      TableName: USERS_TABLE
    }));

    const users = (usersResponse.Items || []).map(item => unmarshall(item));

    // Calculate user counts by access type
    const usersByAccessType = {
      ADMIN: 0,
      WEB_ONLY: 0,
      SFTP_ONLY: 0,
      HYBRID: 0
    };

    let totalStorageBytes = 0;
    let totalFiles = 0;

    users.forEach((user: any) => {
      // Count by access type
      if (user.access_type in usersByAccessType) {
        usersByAccessType[user.access_type as keyof typeof usersByAccessType]++;
      }

      // Sum storage and file counts from cached DynamoDB values
      totalStorageBytes += user.storage_used || 0;
      totalFiles += user.file_count || 0;
    });

    const stats: SystemStats = {
      totalUsers: users.length,
      usersByAccessType,
      totalFiles,
      totalStorageBytes,
      totalStorageGB: parseFloat((totalStorageBytes / (1024 * 1024 * 1024)).toFixed(2))
    };

    return successResponse(200, stats);
  } catch (error) {
    console.error('Error getting system stats:', error);
    return errorResponse(500, 'Failed to get system statistics');
  }
}

/**
 * Get per-user statistics
 * Task 13.3: Calculate file count and storage for specific user
 * Requirements: 12.3
 */
async function getUserStats(username: string): Promise<APIResponse> {
  try {
    // Get user from DynamoDB
    const userResponse = await dynamodb.send(new GetItemCommand({
      TableName: USERS_TABLE,
      Key: { username: { S: username } }
    }));

    if (!userResponse.Item) {
      return errorResponse(404, 'User not found');
    }

    const user = unmarshall(userResponse.Item);

    // Get actual file count and size from S3
    const prefix = `users/${username}/`;
    const s3Response = await s3.send(new ListObjectsV2Command({
      Bucket: FILES_BUCKET,
      Prefix: prefix
    }));

    const files = (s3Response.Contents || []).filter(obj => obj.Key !== prefix);
    const actualFileCount = files.length;
    const actualStorageBytes = files.reduce((sum, obj) => sum + (obj.Size || 0), 0);

    // Update user record if stats are out of sync
    if (actualFileCount !== user.file_count || actualStorageBytes !== user.storage_used) {
      await dynamodb.send(new UpdateItemCommand({
        TableName: USERS_TABLE,
        Key: { username: { S: username } },
        UpdateExpression: 'SET file_count = :count, storage_used = :size',
        ExpressionAttributeValues: {
          ':count': { N: actualFileCount.toString() },
          ':size': { N: actualStorageBytes.toString() }
        }
      }));
    }

    const stats: UserStats = {
      username,
      fileCount: actualFileCount,
      storageBytes: actualStorageBytes,
      storageGB: parseFloat((actualStorageBytes / (1024 * 1024 * 1024)).toFixed(2)),
      lastLogin: user.last_login
    };

    return successResponse(200, stats);
  } catch (error) {
    console.error('Error getting user stats:', error);
    return errorResponse(500, 'Failed to get user statistics');
  }
}

/**
 * Get activity log
 * Task 13.5: Query DynamoDB for recent file operations
 * Requirements: 12.4
 */
async function getActivityLog(limit: number = 50): Promise<APIResponse> {
  try {
    // Query DynamoDB activity table using the timestamp index
    const { QueryCommand } = await import('@aws-sdk/client-dynamodb');
    
    const response = await dynamodb.send(new QueryCommand({
      TableName: ACTIVITY_TABLE,
      IndexName: 'timestamp-index',
      KeyConditionExpression: 'activityType = :type',
      ExpressionAttributeValues: {
        ':type': { S: 'FILE_OPERATION' }
      },
      ScanIndexForward: false, // Sort descending (newest first)
      Limit: limit
    }));

    // Get all users to map username to email
    const usersResponse = await dynamodb.send(new ScanCommand({
      TableName: USERS_TABLE
    }));
    
    const usersMap = new Map();
    (usersResponse.Items || []).forEach(item => {
      const user = unmarshall(item);
      usersMap.set(user.username, user.email);
    });

    const activities: ActivityLogEntry[] = (response.Items || []).map(item => {
      const activity = unmarshall(item);
      return {
        timestamp: new Date(activity.timestamp).toISOString(),
        username: activity.username,
        email: usersMap.get(activity.username) || activity.username, // Fallback to username if email not found
        action: activity.action,
        protocol: activity.protocol,
        filename: activity.filename || undefined
      };
    });

    return successResponse(200, {
      activities,
      count: activities.length,
      timeRange: '30 days'
    });
  } catch (error) {
    console.error('Error getting activity log:', error);
    return errorResponse(500, 'Failed to get activity log');
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
