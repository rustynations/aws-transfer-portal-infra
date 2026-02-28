# Changelog

All notable changes to the AWS Transfer Portal Kit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-02-19

### Added
- API key authentication system for programmatic access to file operations
- API key authorizer Lambda function for validating API keys in requests
- API key management endpoints: create, list, and revoke API keys
- API key metadata storage in DynamoDB with GSI for efficient lookups
- API key utilities for hashing, validation, and expiration checks
- Support for optional API key labels and expiration dates
- Last used timestamp tracking for API keys
- Admin capability to manage API keys for any user
- Comprehensive property-based tests for API key operations
- Documentation for API key testing and usage

### Changed
- File operations API now supports both Cognito JWT and API key authentication
- Enhanced file operations with dual authorization paths (Cognito or API key)

### Security
- API keys are hashed using SHA-256 before storage
- API keys support optional expiration dates
- Revoked API keys are immediately invalidated
- API key access is scoped to the owning user's resources
- Raw API keys are only displayed once at creation time

## [1.1.0] - 2026-02-15

### Added
- TOTP MFA support via Cognito (optional, user self-enrollment)
- Bootstrap admin user creation during CDK deployment via custom resource Lambda
- `BootstrapAdminEmail` CDK output for deployment verification
- MFA reset endpoint (`POST /users/{username}/reset-mfa`) for admin-initiated resets
- Folder create and delete API endpoints (`POST /files/folder`, `DELETE /files/folder`)
- Hierarchical folder navigation with `path` query parameter on file listing
- Path-aware upload, download, and delete operations (files within subfolders)
- S3 delimiter-based listing returning both files and folders (CommonPrefixes)
- Folder validation and sanitization on the backend
- Non-empty folder deletion protection

### Changed
- File listing now uses S3 `Delimiter: '/'` for proper folder/file separation
- Upload, download, and delete operations now respect `data.path` for subfolder context
- Bootstrap admin user display name defaults to 'Root'

### Security
- Root user protection: cannot be modified or deleted via API
- Bootstrap admin user created with permanent password (no forced change on first login)
- Idempotent bootstrap: `UsernameExistsException` handled gracefully on re-deploy

## [1.0.0] - 2026-02-13

### Added
- Initial project structure
- Configuration parser with YAML validation
- Core infrastructure components (S3, DynamoDB, Transfer Family, Cognito, API Gateway)
- Custom Lambda identity provider for SFTP/FTPS authentication
- User management API with Cognito sync and welcome emails
- SSH key management API with format validation
- File operations API with pre-signed URLs
- Admin dashboard API with statistics and activity logs
- S3 event handler for real-time storage statistics
- SNS deployment notifications
- SES email templates for user onboarding
- Shared folder support with configurable permissions
- Session policy-based user isolation (chroot-like)
- Structured activity logging with 30-day TTL
- CloudWatch custom metrics for file operations

### Security
- Session policies enforce user isolation with chroot-like behavior
- Users confined to their home directory via S3 prefix conditions
- Shared folder access explicitly granted through session policies
- Read-only shared folder permissions enforced at API layer

[1.2.0]: https://github.com/rusty428/aws-transfer-portal-kit/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/rusty428/aws-transfer-portal-kit/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/rusty428/aws-transfer-portal-kit/releases/tag/v1.0.0
