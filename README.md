# AWS Transfer Portal Kit - Managed File Transfer Infrastructure

Infrastructure-as-code solution for deploying a complete managed file transfer system using AWS Transfer Family with dual access methods: SFTP/FTPS for automated transfers and a web-based management portal for administrators.

## Overview

The AWS Transfer Portal Kit provides enterprise-grade file transfer infrastructure with:

- **Dual Access Methods**: SFTP/FTPS for automated systems and web portal for human users
- **Web-Only Mode**: Optional SFTP toggle to deploy a lightweight web-only portal without Transfer Family (~96% cost reduction)
- **Unified User Management**: Single user database with role-based access control
- **Secure File Storage**: Encrypted S3 storage with user isolation and lifecycle policies
- **Shared Folders**: Optional collaborative folders accessible to all users
- **Folder Navigation**: Hierarchical folder creation, navigation, and deletion
- **TOTP MFA**: Optional time-based one-time password multi-factor authentication
- **Bootstrap Admin**: Automatic root admin user creation during deployment
- **Admin Dashboard**: Real-time statistics, user management, and activity monitoring
- **Production-Ready**: Comprehensive logging, metrics, and deployment notifications

## How It Works

### Step 1: User Authentication

Users can access the system through two methods:

- **SFTP/FTPS Clients**: Authenticate using SSH keys via AWS Transfer Family with custom identity provider
- **Web Portal**: Authenticate using email/password via Amazon Cognito

Both methods query the same DynamoDB user store, ensuring consistent access control across protocols.

### Step 2: User Management

Administrators use the web portal to:

- Create users with specific access types (ADMIN, WEB_ONLY, SFTP_ONLY, HYBRID)
- Manage SSH keys for SFTP access
- Configure user permissions and storage quotas
- Monitor user activity and storage usage

### Step 3: File Operations

Users can perform file operations based on their access type:

- **Upload**: Generate pre-signed S3 URLs (15-minute expiry) for secure uploads
- **Download**: Generate pre-signed S3 URLs (5-minute expiry) for secure downloads
- **List**: View files and folders with metadata (name, size, last modified)
- **Delete**: Remove files with automatic storage quota updates
- **Create Folder**: Create subfolders within private or shared directories
- **Delete Folder**: Remove empty folders

Files can be stored in two locations:
- **Private Folder** (`/my-files`): User's personal directory, isolated from other users
- **Shared Folder** (`/shared`): Optional collaborative space accessible to all users (configurable as read-only or read-write)

All file operations are logged to CloudWatch with structured JSON for audit trails.

### Step 4: Monitoring & Administration

The admin dashboard provides:

- **System Statistics**: Total users by access type, total files, storage usage
- **Per-User Statistics**: Individual file counts and storage consumption
- **Activity Logs**: Recent file operations with timestamps, usernames, and actions
- **CloudWatch Metrics**: Custom metrics for uploads, downloads, and deletions

## Lambda Functions

| Function | Purpose | Location |
|----------|---------|----------|
| Identity Provider | Authenticates SFTP/FTPS connections using SSH keys from DynamoDB and provides session policies for user isolation | [src/lambda/identity-provider](src/lambda/identity-provider) |
| Users API | CRUD operations for user management with Cognito sync, root user protection, MFA reset, and welcome email notifications | [src/lambda/api/users.ts](src/lambda/api/users.ts) |
| SSH Keys API | Manage SSH keys with format validation and fingerprint generation | [src/lambda/api/keys.ts](src/lambda/api/keys.ts) |
| Files API | File operations with pre-signed URLs, folder create/delete, hierarchical navigation, shared folder support, and activity logging | [src/lambda/api/files.ts](src/lambda/api/files.ts) |
| Admin API | System statistics, user stats, and activity logs from DynamoDB with real-time metrics | [src/lambda/api/admin.ts](src/lambda/api/admin.ts) |
| S3 Event Handler | Real-time storage statistics updates on file uploads/deletes with activity logging | [src/lambda/s3-event-handler](src/lambda/s3-event-handler) |

## AWS Services Integration

- **AWS Transfer Family**: SFTP/FTPS server with custom Lambda identity provider for SSH key authentication and LOGICAL mode for directory mappings
- **Amazon S3**: Encrypted file storage with user-specific paths (`users/{username}/`), optional shared folder (`shared/`), CORS configuration, lifecycle policies, and event notifications
- **Amazon DynamoDB**: Two tables - user store with email GSI and activity table with TTL for 30-day retention
- **AWS Lambda**: Six functions handling authentication, user management, file operations, admin dashboard, and real-time stats
- **Amazon Cognito**: Web authentication with password policies, TOTP MFA support, and OAuth flows
- **Amazon API Gateway**: REST API with Cognito authorizer and CORS support
- **Amazon CloudWatch**: Structured JSON logging and custom metrics for monitoring
- **Amazon SNS**: Deployment notifications and operational alerts
- **Amazon SES**: Welcome email notifications for new users with access-type-specific templates
- **AWS IAM**: Least-privilege policies with session policies for user isolation

## Technical Implementation

### Custom Identity Provider Pattern

The Transfer Family server uses a Lambda-based custom identity provider that:
- Queries DynamoDB for user credentials and SSH keys
- Validates SSH key format and user status
- Returns IAM role, home directory mappings (LOGICAL mode), and session policy with S3 prefix conditions
- Provides chroot-like isolation preventing users from accessing other directories
- Supports shared folder access with configurable permissions
- Logs all authentication attempts to CloudWatch

**LOGICAL Mode Directory Mappings:**
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

The session policy includes:
- S3 prefix conditions on ListBucket to restrict directory visibility
- Resource-level restrictions on GetObject/PutObject operations
- User-specific scoping without relying on IAM policy variables
- Shared folder permissions (read-only or read-write based on configuration)

### User Isolation and Shared Folders

Files are stored in S3 with user-specific prefixes (`users/{username}/`) and an optional shared folder (`shared/`) enforced by:
- Session policies returned by the Lambda identity provider with S3 prefix conditions
- Lambda validation for API Gateway requests
- Pre-signed URLs scoped to user directories or shared folder

The session policy approach provides chroot-like isolation where users:
- Cannot navigate outside their home directory or shared folder
- Cannot see other users' private directories or files
- Are restricted to their specific S3 prefix for all operations
- Can access shared folder if enabled (with configurable read-only or read-write permissions)

**SFTP Directory Structure:**
- `/my-files` - User's private directory (isolated per user)
- `/shared` - Optional shared folder (accessible to all users)

**Web Portal Structure:**
- **My Files** tab - User's private files
- **Shared Files** tab - Shared folder files (if enabled)

This is more reliable than IAM policy variables (`${transfer:UserName}`) which have known limitations in Transfer Family.

### Structured Logging

All file operations and user management actions are logged to a DynamoDB activity table with 30-day TTL:

```json
{
  "activityId": "1707843301424-abc123",
  "timestamp": 1707843301424,
  "username": "testuser1",
  "action": "UPLOAD_URL_GENERATED",
  "protocol": "web",
  "activityType": "FILE_OPERATION",
  "filename": "document.pdf",
  "ttl": 1710435301
}
```

The activity table provides:
- Fast queries via GSI on username and timestamp
- Automatic cleanup after 30 days via TTL
- Consistent activity logging across all operations
- Better performance than CloudWatch Logs queries

### Real-Time Statistics

An S3 event handler Lambda automatically updates user statistics on every file operation:
- Triggered by S3 ObjectCreated and ObjectRemoved events
- Updates `file_count` and `storage_used` in DynamoDB user records
- Ensures dashboard statistics are always accurate
- Prevents expensive S3 ListObjects operations

### Root User Protection

The system supports root users (created during bootstrap) with special protections:
- Root users cannot be modified or deleted via the web portal
- Root user management requires CDK redeployment
- UI clearly indicates root users and disables modification controls
- Prevents accidental lockout of administrative access

### Configuration-Driven Deployment

Single YAML configuration file controls:
- Project naming and resource tagging
- Protocol selection (SFTP, FTPS, or both)
- SFTP toggle (`sftp.enabled`) to deploy with or without Transfer Family
- Storage lifecycle policies
- Custom domains for Transfer Family and web portal
- Bootstrap admin user creation
- Notification email addresses

### Web-Only Mode (SFTP Toggle)

The `sftp.enabled` configuration flag controls whether AWS Transfer Family resources are provisioned. When set to `false`, the stack deploys as a web-only file portal — no Transfer server, no identity provider Lambda, no Transfer user IAM role.

```yaml
# Full deployment with SFTP
sftp:
  enabled: true
  protocols:
    - "SFTP"

# Web-only deployment (no Transfer Family)
sftp:
  enabled: false
```

When SFTP is disabled:
- Transfer Family server, identity provider Lambda, and Transfer user IAM role are not created
- SFTP-related CloudFormation outputs are omitted
- SFTP-only and hybrid welcome email templates are skipped
- Users API rejects SFTP_ONLY and HYBRID access types with a 400 error
- Frontend hides SSH Keys page, SFTP access type options, and Transfer Server fields
- Existing SFTP users are preserved in DynamoDB but flagged as non-functional in the UI

The field defaults to `true` when omitted, so existing deployments are unaffected.

## Cost Comparison

The biggest cost driver in this stack is the AWS Transfer Family server, which charges $0.30/hour (~$216/month) just for having the endpoint running. Disabling SFTP removes this fixed cost entirely.

Estimates below assume a small deployment with 10GB stored and light usage (us-east-1 pricing):

| Component | Web-Only | SFTP Enabled |
|---|---|---|
| AWS Transfer Family endpoint | $0 | ~$216/mo |
| Transfer data (10GB) | $0 | ~$0.40/mo |
| Identity provider Lambda | $0 | ~$0.01/mo |
| S3 (10GB stored) | ~$0.23/mo | ~$0.23/mo |
| DynamoDB (on-demand) | ~$1–2/mo | ~$1–2/mo |
| API Gateway + Lambda | ~$1–5/mo | ~$1–5/mo |
| Cognito | $0 (free tier) | $0 (free tier) |
| **Estimated total** | **~$3–8/mo** | **~$220–224/mo** |

For teams that only need browser-based file management, web-only mode keeps the monthly bill under $10. You can always flip `sftp.enabled` back to `true` and redeploy to add SFTP later.

## Infrastructure

All infrastructure is defined using AWS CDK (TypeScript). For deployment instructions, architecture details, and development guidelines, see:

- **[DEVELOPER.md](DEVELOPER.md)** - Development setup, testing, and deployment
- **[Configuration Guide](config/config.example.yml)** - Detailed configuration options

## Prerequisites

- AWS Account with appropriate permissions
- Node.js 18+ and npm
- AWS CDK CLI (`npm install -g aws-cdk`)
- AWS CLI configured with credentials

## Quick Start

1. **Clone and Install**
   ```bash
   git clone https://github.com/rusty428/aws-transfer-portal-infra.git
   cd aws-transfer-portal-infra
   npm install
   ```

2. **Configure**
   ```bash
   cp config/config.example.yml config/config.yml
   # Edit config/config.yml with your settings
   # Set sftp.enabled: false for web-only mode (~$3-8/mo vs ~$220/mo)
   ```

3. **Deploy**
   ```bash
   npm run build
   npx cdk bootstrap  # First time only
   npx cdk deploy --profile YOUR_AWS_PROFILE
   ```

4. **Access**
   - Transfer Server: Use endpoint from stack outputs
   - API Gateway: Use URL from stack outputs
   - Create users via API to start transferring files

## Security Features

- **Encryption**: S3 server-side encryption, DynamoDB encryption at rest
- **Network Security**: HTTPS-only API, enforced SSL for S3
- **Access Control**: Cognito authorizer, IAM least-privilege policies, session policies with S3 prefix conditions
- **User Isolation**: Chroot-like SFTP isolation preventing cross-user access, users confined to home directories
- **Audit Trail**: CloudWatch Logs for all operations, DynamoDB activity table with 30-day retention
- **Password Policy**: Enforced complexity requirements (8+ chars, mixed case, numbers, symbols)
- **MFA**: Optional TOTP multi-factor authentication with user self-enrollment
- **SSH Key Authentication**: Public key authentication for SFTP (no password authentication)

## Related Projects

This kit follows the same patterns as:
- [AWS SPA Hosting Kit](https://github.com/rusty428/aws-spa-hosting-kit) - Static website hosting with CloudFront

## Contact

**Rusty Nations** - [@rusty428](https://github.com/rusty428)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

Last updated: 2026-02-15
