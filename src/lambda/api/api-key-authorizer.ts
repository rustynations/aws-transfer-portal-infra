import { DynamoDBClient, QueryCommand, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { hashApiKey } from './api-key-utils';

const dynamodb = new DynamoDBClient({});
const API_KEYS_TABLE = process.env.API_KEYS_TABLE!;
const USERS_TABLE = process.env.USERS_TABLE!;

/**
 * API Key Authorizer Lambda
 *
 * Validates API keys from the x-api-key header, resolves the associated user,
 * and returns an IAM policy with username, email, and keyId in the context.
 *
 * Follows a fail-closed pattern: any error returns Deny.
 * Never logs the raw API key — only keyId and username.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 5.3
 */

export interface AuthorizerEvent {
  type: 'TOKEN';
  authorizationToken: string;
  methodArn: string;
}

export interface AuthorizerResponse {
  principalId: string;
  policyDocument: {
    Version: '2012-10-17';
    Statement: [{
      Action: 'execute-api:Invoke';
      Effect: 'Allow' | 'Deny';
      Resource: string;
    }];
  };
  context: {
    username: string;
    email: string;
    keyId: string;
  };
}

/**
 * Build a wildcard resource ARN from the incoming methodArn.
 * Replaces the specific method/resource path with a wildcard so the
 * policy applies to all routes on this API stage.
 */
export function buildResourceArn(methodArn: string): string {
  // methodArn format: arn:aws:execute-api:{region}:{accountId}:{apiId}/{stage}/{method}/{resource}
  const arnParts = methodArn.split(':');
  const apiGatewayParts = arnParts[5].split('/');
  // Keep apiId/stage, wildcard the rest
  return `${arnParts.slice(0, 5).join(':')}:${apiGatewayParts[0]}/${apiGatewayParts[1]}/*`;
}

function generatePolicy(
  principalId: string,
  effect: 'Allow' | 'Deny',
  resource: string,
  context: { username: string; email: string; keyId: string }
): AuthorizerResponse {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Action: 'execute-api:Invoke',
        Effect: effect,
        Resource: resource,
      }],
    },
    context,
  };
}

function denyPolicy(resource: string): AuthorizerResponse {
  return generatePolicy('unknown', 'Deny', resource, { username: '', email: '', keyId: '' });
}

/**
 * Look up an API key record by its hash using the keyHash-index GSI.
 */
async function getKeyByHash(keyHash: string): Promise<Record<string, any> | null> {
  const result = await dynamodb.send(new QueryCommand({
    TableName: API_KEYS_TABLE,
    IndexName: 'keyHash-index',
    KeyConditionExpression: 'keyHash = :keyHash',
    ExpressionAttributeValues: {
      ':keyHash': { S: keyHash },
    },
    Limit: 1,
  }));

  if (!result.Items || result.Items.length === 0) {
    return null;
  }

  return unmarshall(result.Items[0]);
}

/**
 * Look up a user by username from the Users Table.
 */
async function getUserByUsername(username: string): Promise<Record<string, any> | null> {
  const result = await dynamodb.send(new GetItemCommand({
    TableName: USERS_TABLE,
    Key: { username: { S: username } },
  }));

  if (!result.Item) {
    return null;
  }

  return unmarshall(result.Item);
}

/**
 * Update the lastUsedAt timestamp on a key record.
 */
async function updateLastUsedAt(keyId: string): Promise<void> {
  await dynamodb.send(new UpdateItemCommand({
    TableName: API_KEYS_TABLE,
    Key: { keyId: { S: keyId } },
    UpdateExpression: 'SET lastUsedAt = :now',
    ExpressionAttributeValues: {
      ':now': { N: Date.now().toString() },
    },
  }));
}

/**
 * Lambda handler for the API Key Authorizer.
 *
 * Fail-closed: any error during processing returns a Deny policy.
 */
export const handler = async (event: AuthorizerEvent): Promise<AuthorizerResponse> => {
  const resource = buildResourceArn(event.methodArn);

  try {
    const apiKey = event.authorizationToken;
    if (!apiKey) {
      console.log('Authorization denied: missing API key');
      return denyPolicy(resource);
    }

    // Hash the key and look it up
    const keyHash = hashApiKey(apiKey);
    const keyRecord = await getKeyByHash(keyHash);

    if (!keyRecord) {
      console.log('Authorization denied: unknown API key');
      return denyPolicy(resource);
    }

    // Log keyId only — never the raw key (Requirement 5.3)
    console.log('Authorizing API key:', { keyId: keyRecord.keyId, username: keyRecord.username });

    // Check key status
    if (keyRecord.status === 'revoked') {
      console.log('Authorization denied: key revoked', { keyId: keyRecord.keyId });
      return denyPolicy(resource);
    }

    // Check expiry
    if (keyRecord.expiresAt && keyRecord.expiresAt < Date.now()) {
      console.log('Authorization denied: key expired', { keyId: keyRecord.keyId });
      return denyPolicy(resource);
    }

    // Resolve user
    const user = await getUserByUsername(keyRecord.username);
    if (!user) {
      console.log('Authorization denied: user not found', { keyId: keyRecord.keyId, username: keyRecord.username });
      return denyPolicy(resource);
    }

    if (user.disabled) {
      console.log('Authorization denied: user disabled', { keyId: keyRecord.keyId, username: keyRecord.username });
      return denyPolicy(resource);
    }

    // Update lastUsedAt (best-effort — don't fail auth if this errors)
    try {
      await updateLastUsedAt(keyRecord.keyId);
    } catch (updateError) {
      console.error('Failed to update lastUsedAt:', { keyId: keyRecord.keyId, error: updateError });
    }

    console.log('Authorization granted:', { keyId: keyRecord.keyId, username: keyRecord.username });

    return generatePolicy(keyRecord.username, 'Allow', resource, {
      username: keyRecord.username,
      email: user.email || '',
      keyId: keyRecord.keyId,
    });
  } catch (error) {
    // Fail-closed: any unexpected error returns Deny
    console.error('Authorization error (fail-closed deny):', error);
    return denyPolicy(resource);
  }
};
