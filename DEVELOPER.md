# Developer Guide - AWS Transfer Portal Kit

This guide provides detailed information for developers working on the AWS Transfer Portal Kit infrastructure.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Deployment Process](#deployment-process)
- [Lambda Functions](#lambda-functions)
- [Testing Strategy](#testing-strategy)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

## Development Setup

### Prerequisites

- Node.js 18+ and npm
- AWS CLI configured with credentials
- AWS CDK CLI: `npm install -g aws-cdk`
- AWS account with appropriate permissions
- Git for version control

### Initial Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/rusty428/aws-transfer-portal-kit.git
   cd aws-transfer-portal-kit
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure AWS credentials:
   ```bash
   aws configure --profile YOUR_PROFILE_NAME
   ```

4. Create configuration file:
   ```bash
   cp config/config.example.yml config/config.yml
   # Edit config/config.yml with your settings
   ```

5. Bootstrap CDK (first time only):
   ```bash
   npx cdk bootstrap --profile YOUR_PROFILE_NAME
   ```

### Build and Compile

The project uses TypeScript for both CDK infrastructure and Lambda functions.

```bash
# Compile TypeScript to JavaScript
npm run build

# Watch mode for development
npm run watch
```

Compiled files are output to the `lib/` directory.

## Project Structure

```
transfer-portal-kit/
├── src/                          # TypeScript source files
│   ├── bin/                      # CDK app entry point
│   ├── config/                   # Configuration loader and types
│   │   ├── index.ts             # Main config exports
│   │   ├── loader.ts            # YAML config parser
│   │   └── types.ts             # TypeScript interfaces
│   ├── lambda/                   # Lambda function source
│   │   ├── identity-provider/   # Transfer Family auth
│   │   │   └── index.ts
│   │   └── api/                 # API Gateway handlers
│   │       ├── users.ts         # User management
│   │       ├── keys.ts          # SSH key management
│   │       ├── files.ts         # File operations
│   │       └── admin.ts         # Admin dashboard
│   └── stack/                    # CDK stack definitions
│       ├── index.ts             # Stack exports
│       └── transfer-portal-stack.ts  # Main infrastructure
├── lib/                          # Compiled JavaScript (generated)
├── test/                         # Test files
│   ├── unit/                    # Unit tests
│   └── property/                # Property-based tests
├── config/                       # Configuration files
│   ├── config.yml               # Your config (gitignored)
│   └── config.example.yml       # Example config
├── cdk.json                      # CDK configuration
├── tsconfig.json                 # TypeScript configuration
├── jest.config.js                # Jest test configuration
└── package.json                  # Dependencies and scripts
```

### Key Files

- **src/stack/transfer-portal-stack.ts**: Main CDK stack defining all AWS resources
- **src/config/loader.ts**: YAML configuration parser with validation
- **src/lambda/identity-provider/index.ts**: Custom auth for Transfer Family
- **src/lambda/api/*.ts**: API Gateway Lambda handlers
- **config/config.yml**: Deployment configuration (not in git)

## Configuration

### Configuration File Structure

The `config/config.yml` file controls all deployment settings. See `config/config.example.yml` for detailed documentation.

#### Required Settings

```yaml
projectName: "my-file-transfer"  # Unique identifier for resources

sftp:
  protocols:
    - "SFTP"
    # - "FTPS"
```

#### Optional Settings

```yaml
storage:
  retentionDays: 90  # Auto-delete files after N days

sharedFolder:
  enabled: true
  name: "shared"  # Folder name (defaults to 'shared')
  permissions: "read-write"  # 'read-only' or 'read-write'

notifications:
  email: "ops@example.com"  # Deployment notifications
  fromEmail: "noreply@example.com"  # SES sender for welcome emails

tags:
  Environment: "production"
  Team: "operations"
```

### Configuration Validation

The configuration loader validates:
- Required fields are present
- Protocol values are valid (SFTP, FTPS)
- Email addresses are properly formatted
- Retention days is a positive integer

Validation errors will prevent deployment with clear error messages.

## Deployment Process

### Standard Deployment

```bash
# Build and deploy
npm run deploy -- --profile YOUR_PROFILE_NAME

# Or step by step
npm run build
npx cdk deploy --profile YOUR_PROFILE_NAME
```

### First-Time Deployment

On first deployment, you'll need to:

1. Confirm SNS subscription email (check spam folder)
2. Create initial admin user via API
3. Configure SSH keys for SFTP access

### Stack Updates

When updating the stack:

```bash
# Preview changes
npx cdk diff --profile YOUR_PROFILE_NAME

# Deploy changes
npm run deploy -- --profile YOUR_PROFILE_NAME
```

### Stack Deletion

```bash
# Destroy all resources
npm run destroy -- --profile YOUR_PROFILE_NAME
```

**Warning**: This will delete all data including files in S3 and user records in DynamoDB.

## Lambda Functions

### Identity Provider

**Location**: `src/lambda/identity-provider/index.ts`

**Purpose**: Authenticates SFTP/FTPS connections using SSH keys from DynamoDB and provides user isolation

**Flow**:
1. Transfer Family invokes Lambda with username and SSH key
2. Lambda queries DynamoDB for user record
3. Validates user status and SSH key match
4. Returns IAM role, home directory mappings (LOGICAL mode), and session policy
5. Session policy includes S3 prefix conditions for chroot-like isolation
6. Supports shared folder access with configurable permissions
7. Logs authentication attempt to CloudWatch

**LOGICAL Mode Directory Mappings:**
The Lambda returns directory mappings for SFTP users:
```json
{
  "HomeDirectoryType": "LOGICAL",
  "HomeDirectoryDetails": [
    {
      "Entry": "/my-files",
      "Target": "/bucket-name/users/username"
    },
    {
      "Entry": "/shared",
      "Target": "/bucket-name/shared"
    }
  ]
}
```

**Session Policy**:
The Lambda returns a session policy that restricts users to their home directory and shared folder:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowListingOfUserFolder",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::bucket-name"],
      "Condition": {
        "StringLike": {
          "s3:prefix": ["users/username/*", "users/username"]
        }
      }
    },
    {
      "Sid": "AllowUserFileOperations",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::bucket-name/users/username/*"]
    },
    {
      "Sid": "AllowListingOfSharedFolder",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::bucket-name"],
      "Condition": {
        "StringLike": {
          "s3:prefix": ["shared/*", "shared"]
        }
      }
    },
    {
      "Sid": "AllowSharedFileOperations",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::bucket-name/shared/*"]
    }
  ]
}
```

This provides chroot-like isolation where users cannot navigate outside their home directory or shared folder, and cannot see other users' private files.

**Environment Variables**:
- `USERS_TABLE`: DynamoDB table name
- `TRANSFER_ROLE_ARN`: IAM role for Transfer Family users
- `FILES_BUCKET`: S3 bucket name
- `SHARED_FOLDER_ENABLED`: Whether shared folder is enabled ('true' or 'false')
- `SHARED_FOLDER_NAME`: Name of shared folder (defaults to 'shared')
- `SHARED_FOLDER_PERMISSIONS`: Permissions for shared folder ('read-only' or 'read-write')

### Users API

**Location**: `src/lambda/api/users.ts`

**Endpoints**:
- `POST /users` - Create user (DynamoDB + Cognito)
- `GET /users` - List all users
- `GET /users/profile` - Get own profile (self-service)
- `PUT /users/profile` - Update own profile (self-service)
- `GET /users/{username}` - Get user details
- `PUT /users/{username}` - Update user
- `DELETE /users/{username}` - Delete user (DynamoDB + Cognito)
- `POST /users/{username}/reset-mfa` - Reset user's MFA (admin only)

**Access Control**:
- SFTP_ONLY users: DynamoDB only (no Cognito)
- WEB_ONLY, HYBRID, ADMIN: Both DynamoDB and Cognito

### SSH Keys API

**Location**: `src/lambda/api/keys.ts`

**Endpoints**:
- `POST /keys` - Add SSH key with format validation
- `GET /keys` - List user's SSH keys
- `DELETE /keys/{key_id}` - Remove SSH key

**Validation**: Ensures SSH keys match standard formats (ssh-rsa, ssh-ed25519, ecdsa-sha2-nistp256)

### Files API

**Location**: `src/lambda/api/files.ts`

**Endpoints**:
- `GET /files?folder=private|shared&path=subfolder` - List files and folders
- `POST /files/upload-url` - Generate pre-signed upload URL (15 min)
- `POST /files/download-url` - Generate pre-signed download URL (5 min)
- `DELETE /files` - Delete file and update storage stats
- `POST /files/folder` - Create folder
- `DELETE /files/folder` - Delete empty folder

**Folder Parameter**:
All endpoints support a `folder` parameter to distinguish between private and shared files:
- `private` (default): User's personal directory
- `shared`: Shared folder accessible to all users

**Permission Enforcement**:
- Shared folder write operations (upload, delete) are blocked if `permissions: read-only`
- Shared folder read operations (list, download) are always allowed
- Private folder operations are always allowed for the user's own files

**Logging**: Emits structured JSON logs for CloudWatch Logs Insights with folder indicator

**Metrics**: Publishes custom CloudWatch metrics (FileUploads, FileDownloads, FileDeletions) with folder dimension

### Admin API

**Location**: `src/lambda/api/admin.ts`

**Endpoints**:
- `GET /admin/stats` - System statistics (user counts, total files, storage)
- `GET /admin/stats/{username}` - Per-user statistics
- `GET /admin/activity` - Recent file operations from DynamoDB activity table

**Activity Table**: Queries DynamoDB instead of CloudWatch Logs for better performance and structured data access.

### S3 Event Handler

**Location**: `src/lambda/s3-event-handler/index.ts`

**Purpose**: Maintains real-time user statistics by responding to S3 events

**Flow**:
1. S3 triggers Lambda on ObjectCreated and ObjectRemoved events
2. Lambda extracts username from S3 object key (`users/{username}/...`)
3. Updates user's `file_count` and `storage_used` in DynamoDB
4. Logs activity to DynamoDB activity table

**Benefits**:
- Eliminates need for expensive S3 ListObjects operations
- Ensures dashboard statistics are always current
- Provides audit trail of all file operations

## Testing Strategy

### Unit Tests

Located in `test/unit/`, unit tests verify specific examples and edge cases.

```bash
# Run all unit tests
npm run test:unit

# Run specific test file
npm test -- users.test.ts
```

### Property-Based Tests

Located in `test/property/`, property tests verify universal correctness properties using fast-check.

```bash
# Run all property tests
npm run test:property
```

### Manual Testing

#### Test User Management API

```bash
# Get ID token from Cognito
ID_TOKEN="your-id-token-here"
API_URL="your-api-gateway-url"

# Create user
curl -X POST "$API_URL/users" \
  -H "Authorization: $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "email": "test@example.com",
    "access_type": "HYBRID",
    "ssh_keys": ["ssh-rsa AAAA..."]
  }'

# List users
curl "$API_URL/users" \
  -H "Authorization: $ID_TOKEN"
```

#### Test SFTP Connection

```bash
# Connect via SFTP
sftp -i ~/.ssh/id_rsa testuser@s-1234567890abcdef0.server.transfer.us-east-1.amazonaws.com

# Navigate to private files
cd /my-files

# Upload file to private folder
put local-file.txt

# List private files
ls

# Navigate to shared folder (if enabled)
cd /shared

# List shared files
ls

# Upload to shared folder (if read-write)
put shared-document.pdf

# Download file
get remote-file.txt

# Test isolation - try to navigate outside (should fail)
cd /
ls  # Should only see /my-files and /shared
cd ..  # Should fail or stay in current directory
```

#### Test Files API with Shared Folder

```bash
# Get ID token from Cognito
ID_TOKEN="your-id-token-here"
API_URL="your-api-gateway-url"

# List private files
curl "$API_URL/files?folder=private" \
  -H "Authorization: $ID_TOKEN"

# List shared files
curl "$API_URL/files?folder=shared" \
  -H "Authorization: $ID_TOKEN"

# Generate upload URL for shared folder
curl -X POST "$API_URL/files/upload-url" \
  -H "Authorization: $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "document.pdf",
    "folder": "shared"
  }'

# Generate download URL for shared file
curl -X POST "$API_URL/files/download-url" \
  -H "Authorization: $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "document.pdf",
    "folder": "shared"
  }'
```

## Troubleshooting

### Common Issues

#### 1. CDK Bootstrap Required

**Error**: `This stack uses assets, so the toolkit stack must be deployed`

**Solution**:
```bash
npx cdk bootstrap --profile YOUR_PROFILE_NAME
```

#### 2. SNS Subscription Not Confirmed

**Error**: Notifications not received

**Solution**: Check spam folder for SNS confirmation email and click the confirmation link

#### 3. API Gateway 401 Unauthorized

**Error**: API returns 401 even with valid credentials

**Solution**: Ensure you're using the ID token (not access token) from Cognito

```bash
# Get ID token from Cognito authentication response
# Use idToken.jwtToken, NOT accessToken.jwtToken
```

#### 4. SFTP Authentication Failed

**Error**: `Permission denied (publickey)`

**Solution**:
- Verify SSH key is added to user in DynamoDB
- Check SSH key format matches standard (ssh-rsa, ssh-ed25519, etc.)
- Review CloudWatch Logs for identity provider Lambda
- Ensure user status is "active" and not disabled

#### 5. SFTP User Can Navigate Outside Home Directory

**Error**: User can `cd ..` and see other directories

**Solution**: This should not happen with the current implementation. If it does:
- Verify the session policy includes S3 prefix conditions
- Check CloudWatch Logs for the identity provider Lambda response
- Ensure the Lambda is returning the Policy field with proper conditions
- The session policy should restrict ListBucket with StringLike conditions on s3:prefix

#### 6. File Upload Fails

**Error**: Pre-signed URL returns 403 Forbidden

**Solution**:
- Verify CORS configuration on S3 bucket
- Check pre-signed URL hasn't expired (15 min for uploads)
- Ensure filename doesn't contain invalid characters

### Debugging Lambda Functions

#### View Logs

```bash
# Identity provider logs
aws logs tail /aws/lambda/PROJECT_NAME-identity-provider --follow --profile YOUR_PROFILE_NAME

# Files API logs
aws logs tail /aws/lambda/PROJECT_NAME-files-api --follow --profile YOUR_PROFILE_NAME
```

#### Query Activity Logs

```bash
# Get recent file operations
aws logs filter-log-events \
  --log-group-name /aws/lambda/PROJECT_NAME-files-api \
  --filter-pattern '{ $.timestamp = * && $.action = * }' \
  --start-time $(($(date +%s) - 3600))000 \
  --profile YOUR_PROFILE_NAME
```

### CloudWatch Logs Insights Queries

```sql
-- Recent file operations
fields @timestamp, username, action, protocol, filename
| filter ispresent(action)
| sort @timestamp desc
| limit 50

-- Failed authentication attempts
fields @timestamp, username, message
| filter message like /authentication failed/
| sort @timestamp desc

-- Storage usage by user
fields username, fileCount, storageBytes
| filter ispresent(storageBytes)
| sort storageBytes desc
```

## Contributing

### Code Style

- Use TypeScript for all new code
- Follow existing code formatting
- Add JSDoc comments for public functions
- Use meaningful variable names

### Commit Messages

Follow conventional commits format:

```
feat: add SSH key rotation feature
fix: resolve SFTP authentication timeout
docs: update deployment instructions
test: add property tests for user management
```

### Pull Request Process

1. Create feature branch from `main`
2. Make changes with tests
3. Update documentation if needed
4. Submit PR with clear description
5. Ensure CI passes

### Testing Requirements

- All new features must include unit tests
- Critical paths should have property tests
- Manual testing checklist for API changes

## Shared Resources

### DynamoDB User Schema

```typescript
{
  username: string;           // Partition key
  email: string;             // GSI partition key
  access_type: "ADMIN" | "WEB_ONLY" | "SFTP_ONLY" | "HYBRID";
  ssh_keys?: Array<{
    key_id: string;
    public_key: string;
    added_date: number;
  }>;
  disabled: boolean;
  is_root: boolean;          // Root users cannot be modified via API
  created_at: number;
  last_login?: number;
  file_count: number;        // Updated by S3 event handler
  storage_used: number;      // Updated by S3 event handler (bytes)
}
```

### DynamoDB Activity Table Schema

```typescript
{
  activityId: string;        // Partition key (timestamp-random)
  timestamp: number;         // Sort key
  username: string;          // GSI partition key
  action: string;            // e.g., "UPLOAD_URL_GENERATED", "DELETE_FILE"
  protocol: string;          // "web" or "sftp"
  activityType: string;      // "FILE_OPERATION"
  filename?: string;         // Optional file name
  ttl: number;              // Auto-delete after 30 days
}
```

**Global Secondary Indexes**:
- `username-timestamp-index`: Query activities by user
- `timestamp-index`: Query recent activities across all users

### S3 File Structure

```
bucket-name/
├── users/
│   ├── username1/
│   │   ├── file1.txt
│   │   └── file2.pdf
│   └── username2/
│       └── document.docx
└── shared/
    ├── .keep
    ├── company-policy.pdf
    └── templates/
        └── invoice-template.xlsx
```

**Shared Folder**:
- Created automatically during CDK deployment if `sharedFolder.enabled: true`
- Contains a `.keep` placeholder file to ensure the folder exists
- Accessible to all users via SFTP (`/shared`) and web portal (Shared Files tab)
- Permissions configurable as `read-only` or `read-write`

### IAM Policy Variables and Session Policies

Transfer Family supports two approaches for user isolation:

**IAM Policy Variables** (not recommended):
- `${transfer:UserName}` - Current username
- `${transfer:HomeDirectory}` - User's home directory path
- Known limitations with variable substitution in PATH mode

**Session Policies** (recommended):
Session policies returned by the identity provider Lambda provide more reliable isolation:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowListingOfUserFolder",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::bucket-name"],
      "Condition": {
        "StringLike": {
          "s3:prefix": ["users/${username}/*", "users/${username}"]
        }
      }
    },
    {
      "Sid": "AllowUserFileOperations",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::bucket-name/users/${username}/*"]
    }
  ]
}
```

The S3 prefix conditions on ListBucket provide chroot-like isolation, preventing users from navigating outside their home directory.

## Additional Resources

- [AWS Transfer Family Documentation](https://docs.aws.amazon.com/transfer/)
- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)
- [Amazon Cognito Documentation](https://docs.aws.amazon.com/cognito/)
- [Project Issues](https://github.com/rusty428/aws-transfer-portal-kit/issues)

---

Last updated: 2026-02-15
