# Files API Testing Guide - Shared Folder Support

## Overview

The Files API now supports a `folder` parameter to distinguish between private user files and shared files accessible to all users.

## API Changes

### 1. List Files
**Endpoint:** `GET /files?folder={private|shared}`

**Query Parameters:**
- `folder` (optional): `"private"` or `"shared"` (defaults to `"private"`)

**Example Request:**
```bash
# List private files
curl -X GET "https://api.example.com/files?folder=private" \
  -H "Authorization: Bearer {token}"

# List shared files
curl -X GET "https://api.example.com/files?folder=shared" \
  -H "Authorization: Bearer {token}"
```

**Example Response:**
```json
{
  "files": [
    {
      "key": "shared/document.pdf",
      "name": "document.pdf",
      "size": 1024,
      "lastModified": 1707840000000,
      "folder": "shared"
    }
  ],
  "count": 1,
  "totalSize": 1024,
  "folder": "shared"
}
```

### 2. Generate Upload URL
**Endpoint:** `POST /files/upload-url`

**Request Body:**
```json
{
  "filename": "document.pdf",
  "folder": "shared",
  "contentType": "application/pdf"
}
```

**Fields:**
- `filename` (required): Name of the file to upload
- `folder` (optional): `"private"` or `"shared"` (defaults to `"private"`)
- `contentType` (optional): MIME type (defaults to `"application/octet-stream"`)

**Example Response:**
```json
{
  "uploadUrl": "https://s3.amazonaws.com/...",
  "key": "shared/document.pdf",
  "filename": "document.pdf",
  "folder": "shared",
  "expiresIn": 900
}
```

**Permission Check:**
- If `folder` is `"shared"` and shared folder is configured as `read-only`, returns `403 Forbidden`

### 3. Generate Download URL
**Endpoint:** `POST /files/download-url`

**Request Body:**
```json
{
  "filename": "document.pdf",
  "folder": "shared"
}
```

**Fields:**
- `filename` (required): Name of the file to download
- `folder` (optional): `"private"` or `"shared"` (defaults to `"private"`)

**Example Response:**
```json
{
  "downloadUrl": "https://s3.amazonaws.com/...",
  "filename": "document.pdf",
  "folder": "shared",
  "expiresIn": 300
}
```

### 4. Delete File
**Endpoint:** `DELETE /files`

**Request Body:**
```json
{
  "filename": "document.pdf",
  "folder": "shared"
}
```

**Fields:**
- `filename` (required): Name of the file to delete
- `folder` (optional): `"private"` or `"shared"` (defaults to `"private"`)

**Example Response:**
```json
{
  "message": "File deleted successfully",
  "filename": "document.pdf",
  "folder": "shared"
}
```

**Permission Check:**
- If `folder` is `"shared"` and shared folder is configured as `read-only`, returns `403 Forbidden`

## Error Responses

### Invalid Folder Parameter
```json
{
  "error": "Invalid folder parameter. Must be \"private\" or \"shared\""
}
```
**Status Code:** 400

### Shared Folder Not Enabled
```json
{
  "error": "Shared folder is not enabled"
}
```
**Status Code:** 403

### Shared Folder Read-Only
```json
{
  "error": "Shared folder is read-only"
}
```
**Status Code:** 403

## Configuration

The shared folder feature is controlled by the `config.yml` file:

```yaml
sharedFolder:
  enabled: true
  name: "shared"              # S3 prefix name
  permissions: "read-write"   # "read-only" or "read-write"
```

**Environment Variables (set automatically by CDK):**
- `SHARED_FOLDER_ENABLED`: `"true"` or `"false"`
- `SHARED_FOLDER_NAME`: Folder name (default: `"shared"`)
- `SHARED_FOLDER_PERMISSIONS`: `"read-only"` or `"read-write"` (default: `"read-write"`)

## Activity Logging

All file operations now include a `folder` field in the activity log:

```json
{
  "activityId": "1707840000000-abc123",
  "timestamp": 1707840000000,
  "username": "user1",
  "action": "UPLOAD_URL_GENERATED",
  "protocol": "web",
  "activityType": "FILE_OPERATION",
  "filename": "document.pdf",
  "folder": "shared"
}
```

## CloudWatch Metrics

Metrics now include a `Folder` dimension:

**Dimensions:**
- `Username`: The user performing the operation
- `Protocol`: `"web"` or `"sftp"`
- `Folder`: `"private"` or `"shared"`

**Metric Names:**
- `FileUploads`
- `FileDownloads`
- `FileDeletions`
- `FileOperations`

## Testing Checklist

All items are covered by unit tests in `test/unit/files.test.ts` (21 tests).

### Basic Functionality
- [x] List private files (default behavior)
- [x] List shared files with `folder=shared`
- [x] Upload to private folder (default)
- [x] Upload to shared folder with `folder=shared`
- [x] Download from private folder
- [x] Download from shared folder
- [x] Delete from private folder
- [x] Delete from shared folder

### Permission Enforcement
- [x] Upload to shared folder with `read-write` permissions (should succeed)
- [x] Upload to shared folder with `read-only` permissions (should fail with 403)
- [x] Delete from shared folder with `read-write` permissions (should succeed)
- [x] Delete from shared folder with `read-only` permissions (should fail with 403)
- [x] Download from shared folder with `read-only` permissions (should succeed)

### Error Handling
- [x] Invalid folder parameter (should return 400)
- [x] Shared folder disabled but `folder=shared` requested (should return 403)
- [x] File not found in shared folder (should return 404)
- [x] File not found in private folder (should return 404)

### Backwards Compatibility
- [x] Omit `folder` parameter - should default to `"private"`
- [x] Shared folder disabled - private operations should work normally
- [x] Existing web portal without folder parameter should continue to work

## S3 Structure

```
bucket-name/
├── users/
│   ├── user1/
│   │   ├── file1.txt
│   │   └── file2.pdf
│   └── user2/
│       └── document.docx
└── shared/
    ├── .keep
    ├── company-policy.pdf
    └── templates/
        └── invoice-template.xlsx
```


