import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const dynamodb = new DynamoDBClient({});
const USERS_TABLE = process.env.USERS_TABLE!;
const TRANSFER_ROLE_ARN = process.env.TRANSFER_ROLE_ARN!;
const FILES_BUCKET = process.env.FILES_BUCKET!;
const SHARED_FOLDER_ENABLED = process.env.SHARED_FOLDER_ENABLED === 'true';
const SHARED_FOLDER_NAME = process.env.SHARED_FOLDER_NAME || 'shared';
const SHARED_FOLDER_PERMISSIONS = process.env.SHARED_FOLDER_PERMISSIONS || 'read-write';

interface TransferEvent {
  username: string;
  serverId: string;
  sourceIp: string;
  protocol: string;
  password?: string;
}

interface SSHKey {
  key_id: string;
  public_key: string;
  added_date: number;
}

interface UserRecord {
  username: string;
  email: string;
  access_type: 'ADMIN' | 'WEB_ONLY' | 'SFTP_ONLY' | 'HYBRID';
  cognito_sub?: string;
  ssh_keys?: SSHKey[];
  disabled: boolean;
  created_at: number;
  last_login?: number;
  storage_used: number;
  file_count: number;
}

interface HomeDirectoryMapping {
  Entry: string;
  Target: string;
}

interface TransferResponse {
  Role: string;
  HomeDirectoryType: 'LOGICAL' | 'PATH';
  HomeDirectoryDetails?: string;  // JSON string of HomeDirectoryMapping array
  HomeDirectory?: string;
  Policy?: string;
  PublicKeys?: string[];
}

/**
 * AWS Transfer Family Custom Identity Provider
 * 
 * This Lambda function authenticates SFTP/FTPS users by:
 * 1. Querying DynamoDB for user record
 * 2. Validating user is not disabled
 * 3. Validating user has SFTP access (SFTP_ONLY or HYBRID)
 * 4. Validating SSH key matches stored keys
 * 5. Returning IAM role and home directory path
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.5
 */
export const handler = async (event: TransferEvent): Promise<TransferResponse | {}> => {
  console.log('Transfer Family authentication request:', {
    username: event.username,
    serverId: event.serverId,
    sourceIp: event.sourceIp,
    protocol: event.protocol
  });

  try {
    // Query DynamoDB for user record
    const user = await getUserFromDynamoDB(event.username);

    // Validate user exists
    if (!user) {
      console.log('Authentication failed: User not found', { username: event.username });
      return {}; // Return empty object to deny authentication
    }

    // Validate user is not disabled
    if (user.disabled) {
      console.log('Authentication failed: User is disabled', { username: event.username });
      return {};
    }

    // Validate user has SFTP access (not WEB_ONLY)
    if (user.access_type === 'WEB_ONLY') {
      console.log('Authentication failed: User does not have SFTP access', { 
        username: event.username,
        access_type: user.access_type
      });
      return {};
    }

    // Validate user has at least one SSH key
    if (!user.ssh_keys || user.ssh_keys.length === 0) {
      console.log('Authentication failed: User has no SSH keys', { username: event.username });
      return {};
    }

    // For SSH key authentication, Transfer Family will validate the key
    // We need to return the list of valid public keys in the response
    const publicKeys = user.ssh_keys.map(key => key.public_key);
    
    // Build directory mappings based on shared folder configuration
    const useLogicalMode = SHARED_FOLDER_ENABLED;
    
    let response: TransferResponse;
    
    if (useLogicalMode) {
      // LOGICAL mode: Map multiple directories
      // Note: Entry paths must not overlap. We map specific subdirectories instead of root.
      const homeDirectoryDetails: HomeDirectoryMapping[] = [
        {
          Entry: '/my-files',
          Target: `/${FILES_BUCKET}/users/${event.username}`
        }
      ];

      // Add shared folder mapping if enabled
      if (SHARED_FOLDER_ENABLED) {
        homeDirectoryDetails.push({
          Entry: `/${SHARED_FOLDER_NAME}`,
          Target: `/${FILES_BUCKET}/shared`
        });
      }

      // Build session policy statements
      const policyStatements: any[] = [
        {
          Sid: 'AllowListingOfUserFolder',
          Effect: 'Allow',
          Action: ['s3:ListBucket'],
          Resource: [`arn:aws:s3:::${FILES_BUCKET}`],
          Condition: {
            StringLike: {
              's3:prefix': [
                `users/${event.username}/*`,
                `users/${event.username}`
              ]
            }
          }
        },
        {
          Sid: 'AllowUserFileOperations',
          Effect: 'Allow',
          Action: [
            's3:GetObject',
            's3:GetObjectVersion',
            's3:PutObject',
            's3:DeleteObject',
            's3:DeleteObjectVersion'
          ],
          Resource: [`arn:aws:s3:::${FILES_BUCKET}/users/${event.username}/*`]
        }
      ];

      // Add shared folder permissions if enabled
      if (SHARED_FOLDER_ENABLED) {
        policyStatements.push({
          Sid: 'AllowListingOfSharedFolder',
          Effect: 'Allow',
          Action: ['s3:ListBucket'],
          Resource: [`arn:aws:s3:::${FILES_BUCKET}`],
          Condition: {
            StringLike: {
              's3:prefix': ['shared/*', 'shared']
            }
          }
        });

        // Add read or read-write permissions based on configuration
        const sharedActions = SHARED_FOLDER_PERMISSIONS === 'read-only'
          ? ['s3:GetObject', 's3:GetObjectVersion']
          : ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'];

        policyStatements.push({
          Sid: 'AllowSharedFileOperations',
          Effect: 'Allow',
          Action: sharedActions,
          Resource: [`arn:aws:s3:::${FILES_BUCKET}/shared/*`]
        });
      }

      const sessionPolicy = {
        Version: '2012-10-17',
        Statement: policyStatements
      };

      // CRITICAL: HomeDirectoryDetails must be a JSON STRING, not an object!
      // This is different from the TypeScript interface but required by Transfer Family
      response = {
        Role: TRANSFER_ROLE_ARN,
        HomeDirectoryType: 'LOGICAL',
        HomeDirectoryDetails: JSON.stringify(homeDirectoryDetails) as any,
        Policy: JSON.stringify(sessionPolicy),
        PublicKeys: publicKeys
      };

      console.log('Authentication successful (LOGICAL mode)', {
        username: event.username,
        homeDirectoryMappings: homeDirectoryDetails.length,
        sharedFolderEnabled: SHARED_FOLDER_ENABLED,
        access_type: user.access_type
      });
    } else {
      // PATH mode: Single directory (backwards compatible)
      const homeDirectory = `/${FILES_BUCKET}/users/${event.username}`;

      const sessionPolicy = {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowListingOfUserFolder',
            Effect: 'Allow',
            Action: ['s3:ListBucket'],
            Resource: [`arn:aws:s3:::${FILES_BUCKET}`],
            Condition: {
              StringLike: {
                's3:prefix': [
                  `users/${event.username}/*`,
                  `users/${event.username}`
                ]
              }
            }
          },
          {
            Sid: 'AllowUserFileOperations',
            Effect: 'Allow',
            Action: [
              's3:GetObject',
              's3:GetObjectVersion',
              's3:PutObject',
              's3:DeleteObject',
              's3:DeleteObjectVersion'
            ],
            Resource: [`arn:aws:s3:::${FILES_BUCKET}/users/${event.username}/*`]
          }
        ]
      };

      response = {
        Role: TRANSFER_ROLE_ARN,
        HomeDirectory: homeDirectory,
        HomeDirectoryType: 'PATH',
        Policy: JSON.stringify(sessionPolicy),
        PublicKeys: publicKeys
      };

      console.log('Authentication successful (PATH mode)', {
        username: event.username,
        homeDirectory,
        access_type: user.access_type
      });
    }

    console.log('Full response:', JSON.stringify(response, null, 2));

    // Update last login timestamp asynchronously (fire and forget)
    updateLastLogin(event.username).catch(err => 
      console.error('Failed to update last login:', err)
    );

    return response;

  } catch (error) {
    console.error('Authentication error:', error);
    return {}; // Return empty object to deny authentication on error
  }
};

/**
 * Query DynamoDB for user record
 */
async function getUserFromDynamoDB(username: string): Promise<UserRecord | null> {
  try {
    const command = new GetItemCommand({
      TableName: USERS_TABLE,
      Key: {
        username: { S: username }
      }
    });

    const response = await dynamodb.send(command);

    if (!response.Item) {
      return null;
    }

    return unmarshall(response.Item) as UserRecord;

  } catch (error) {
    console.error('DynamoDB query error:', error);
    throw error;
  }
}

/**
 * Update last login timestamp for user
 */
async function updateLastLogin(username: string): Promise<void> {
  const { UpdateItemCommand } = await import('@aws-sdk/client-dynamodb');
  
  const command = new UpdateItemCommand({
    TableName: USERS_TABLE,
    Key: {
      username: { S: username }
    },
    UpdateExpression: 'SET last_login = :timestamp',
    ExpressionAttributeValues: {
      ':timestamp': { N: Date.now().toString() }
    }
  });

  await dynamodb.send(command);
}
