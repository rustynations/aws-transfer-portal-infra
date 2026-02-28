# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the AWS Transfer Portal Kit, please report it by:

1. Opening an issue on GitHub: https://github.com/rusty428/aws-transfer-portal-infra/issues
2. Or emailing the maintainer directly: maintainer@example.com

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Supported Versions

Only the latest release is actively supported with security updates.

## Security Best Practices

This kit implements AWS security best practices:

### Data Protection
- Private S3 buckets with no public access
- Server-side encryption for S3 and DynamoDB
- HTTPS-only API access with enforced SSL

### Access Control
- SSH key authentication for SFTP (no password authentication)
- Cognito user pools for web authentication with password complexity requirements
- Session policies with S3 prefix conditions for user isolation
- Least privilege IAM policies

### User Isolation
- Chroot-like SFTP isolation confining users to home directories
- S3 prefix conditions preventing cross-user file access
- Users cannot navigate outside their designated directory
- Users cannot see other users' directories or files

### Audit and Monitoring
- CloudWatch Logs for all Lambda functions
- DynamoDB activity table with 30-day TTL for file operations
- Structured JSON logging for CloudWatch Logs Insights
- Custom CloudWatch metrics for file operations

### Session Policies
The identity provider Lambda returns session policies that:
- Restrict ListBucket operations to user-specific S3 prefixes
- Scope GetObject/PutObject to user directories only
- Provide more reliable isolation than IAM policy variables
- Prevent users from accessing other users' data

For production deployments, review the IAM permissions and session policies in the code and adjust as needed for your security requirements.
