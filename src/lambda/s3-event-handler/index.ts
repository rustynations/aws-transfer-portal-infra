import { S3Event } from 'aws-lambda';
import { DynamoDBClient, UpdateItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const dynamodb = new DynamoDBClient({});
const s3 = new S3Client({});

const USERS_TABLE = process.env.USERS_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;

/**
 * S3 Event Handler
 * 
 * Triggered when files are uploaded or deleted from S3
 * Updates user statistics in DynamoDB
 * 
 * This enables:
 * - Real-time stats updates
 * - Future notifications
 * - File processing workflows
 * - Audit logging
 */
export const handler = async (event: S3Event): Promise<void> => {
  console.log('S3 event received:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    const eventName = record.eventName;
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    const size = record.s3.object.size || 0; // Size is not available for delete events

    console.log(`Processing ${eventName} for ${key} (${size} bytes)`);

    // Extract username from key (format: users/{username}/{filename})
    const keyParts = key.split('/');
    if (keyParts.length < 3 || keyParts[0] !== 'users') {
      console.log('Skipping non-user file:', key);
      continue;
    }

    const username = keyParts[1];
    const filename = keyParts.slice(2).join('/');

    try {
      if (eventName.startsWith('ObjectCreated:')) {
        await handleFileUpload(username, filename, size, bucket, key);
      } else if (eventName.startsWith('ObjectRemoved:')) {
        // For delete events, we need to get the size from the files Lambda's delete log
        // or from DynamoDB if we cached it, but for now we'll handle it without size
        await handleFileDelete(username, filename, bucket, key);
      }
    } catch (error) {
      console.error(`Error processing event for ${key}:`, error);
      // Don't throw - we don't want to retry S3 events
    }
  }
};

/**
 * Handle file upload event
 */
async function handleFileUpload(
  username: string,
  filename: string,
  size: number,
  bucket: string,
  key: string
): Promise<void> {
  console.log(`File uploaded: ${filename} by ${username} (${size} bytes)`);

  // Get current user stats
  const userResponse = await dynamodb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: { username: { S: username } }
  }));

  if (!userResponse.Item) {
    console.error(`User not found: ${username}`);
    return;
  }

  const user = unmarshall(userResponse.Item);
  const currentFileCount = user.file_count || 0;
  const currentStorageUsed = user.storage_used || 0;

  // Update user stats
  await dynamodb.send(new UpdateItemCommand({
    TableName: USERS_TABLE,
    Key: { username: { S: username } },
    UpdateExpression: 'SET file_count = :count, storage_used = :size, last_upload = :timestamp',
    ExpressionAttributeValues: {
      ':count': { N: (currentFileCount + 1).toString() },
      ':size': { N: (currentStorageUsed + size).toString() },
      ':timestamp': { N: Date.now().toString() }
    }
  }));

  console.log(`Updated stats for ${username}: ${currentFileCount + 1} files, ${currentStorageUsed + size} bytes`);

  // Log to activity table
  await logActivity(username, 'FILE_UPLOADED', 'web', filename);

  // Future: Send notifications, trigger processing, etc.
}

/**
 * Handle file delete event
 */
async function handleFileDelete(
  username: string,
  filename: string,
  bucket: string,
  key: string
): Promise<void> {
  console.log(`File deleted: ${filename} by ${username}`);

  // Get current user stats
  const userResponse = await dynamodb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: { username: { S: username } }
  }));

  if (!userResponse.Item) {
    console.error(`User not found: ${username}`);
    return;
  }

  const user = unmarshall(userResponse.Item);
  
  // For delete events, S3 doesn't provide the file size
  // We need to recalculate from S3 to get accurate stats
  const prefix = `users/${username}/`;
  try {
    const listResponse = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix
    }));

    const files = (listResponse.Contents || []).filter(obj => obj.Key !== prefix);
    const actualFileCount = files.length;
    const actualStorageUsed = files.reduce((sum, obj) => sum + (obj.Size || 0), 0);

    // Update user stats with actual values from S3
    await dynamodb.send(new UpdateItemCommand({
      TableName: USERS_TABLE,
      Key: { username: { S: username } },
      UpdateExpression: 'SET file_count = :count, storage_used = :size',
      ExpressionAttributeValues: {
        ':count': { N: actualFileCount.toString() },
        ':size': { N: actualStorageUsed.toString() }
      }
    }));

    console.log(`Updated stats for ${username}: ${actualFileCount} files, ${actualStorageUsed} bytes`);

    // Log to activity table
    await logActivity(username, 'FILE_DELETED', 'web', filename);
  } catch (error) {
    console.error(`Error recalculating stats for ${username}:`, error);
    // Fall back to decrementing by 1 file
    const currentFileCount = Math.max(0, (user.file_count || 0) - 1);
    
    await dynamodb.send(new UpdateItemCommand({
      TableName: USERS_TABLE,
      Key: { username: { S: username } },
      UpdateExpression: 'SET file_count = :count',
      ExpressionAttributeValues: {
        ':count': { N: currentFileCount.toString() }
      }
    }));

    console.log(`Updated file count for ${username}: ${currentFileCount} files (storage unchanged)`);
    
    // Still log the activity even if stats update failed
    await logActivity(username, 'FILE_DELETED', 'web', filename);
  }
}

/**
 * Log activity to DynamoDB activity table
 */
async function logActivity(
  username: string,
  action: string,
  protocol: string,
  filename?: string
): Promise<void> {
  const timestamp = Date.now();
  const activityId = `${timestamp}-${Math.random().toString(36).substring(7)}`;
  
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
        filename: filename || ''
      })
    }));
    
    console.log(`Activity logged: ${action} by ${username}`);
  } catch (error) {
    console.error('Error logging activity:', error);
    // Don't fail the operation if activity logging fails
  }
}
