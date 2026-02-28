# API Key Integration Testing

Manual integration test procedure for verifying API key-based programmatic access to the Transfer Portal.

## Prerequisites

- A deployed Transfer Portal stack with API key infrastructure
- An API key created via the web portal (Profile page or admin User Management)
- The API Gateway endpoint URL (e.g., `https://<api-id>.execute-api.<region>.amazonaws.com/prod`)

## Setup

```bash
# Set these for your environment
export API_URL="https://<api-id>.execute-api.<region>.amazonaws.com/prod"
export API_KEY="tpk_<REDACTED>"
```

## Golden Path Tests

### 1. List Files

```bash
curl -s -H "x-api-key: $API_KEY" "$API_URL/api/v1/files?folder=private"
```

Expected: 200 with `{ files: [...], folders: [...], count, totalSize, folder }` scoped to the key owner's directory.

### 2. Create Folder

```bash
curl -s -H "x-api-key: $API_KEY" \
  -X POST -H "Content-Type: application/json" \
  -d '{"folderName":"api-test-folder","folder":"private"}' \
  "$API_URL/api/v1/files/folder"
```

Expected: 200 with `{ message: "Folder created successfully", folderName, folder }`.

### 3. Get Upload URL

```bash
curl -s -H "x-api-key: $API_KEY" \
  -X POST -H "Content-Type: application/json" \
  -d '{"filename":"test-upload.txt","folder":"private","path":"api-test-folder"}' \
  "$API_URL/api/v1/files/upload-url"
```

Expected: 200 with `{ uploadUrl, key, filename, folder, expiresIn }`. The `uploadUrl` is a pre-signed S3 PUT URL.

### 4. Get Download URL

```bash
curl -s -H "x-api-key: $API_KEY" \
  -X POST -H "Content-Type: application/json" \
  -d '{"filename":"<existing-file>","folder":"private"}' \
  "$API_URL/api/v1/files/download-url"
```

Expected: 200 with `{ downloadUrl, filename, folder, expiresIn }`. The `downloadUrl` is a pre-signed S3 GET URL.

### 5. Delete Folder

```bash
curl -s -H "x-api-key: $API_KEY" \
  -X DELETE -H "Content-Type: application/json" \
  -d '{"folderName":"api-test-folder","folder":"private"}' \
  "$API_URL/api/v1/files/folder"
```

Expected: 200 with `{ message: "Folder deleted successfully", folderName, folder }`.

### 6. Verify Cleanup

```bash
curl -s -H "x-api-key: $API_KEY" "$API_URL/api/v1/files?folder=private"
```

Expected: `api-test-folder` no longer appears in the `folders` array.

## Negative Path Tests

### 7. Invalid API Key

```bash
curl -s -H "x-api-key: tpk_invalid_key_value" "$API_URL/api/v1/files"
```

Expected: 403 Forbidden.

### 8. Missing API Key Header

```bash
curl -s "$API_URL/api/v1/files"
```

Expected: 401 Unauthorized.

### 9. Empty API Key

```bash
curl -s -H "x-api-key: " "$API_URL/api/v1/files"
```

Expected: 401 Unauthorized.

### 10. Wrong Key Prefix

```bash
curl -s -H "x-api-key: sk_someRandomKeyValue" "$API_URL/api/v1/files"
```

Expected: 403 Forbidden.

### 11. Valid API Key on Cognito-Only Route

```bash
curl -s -H "x-api-key: $API_KEY" "$API_URL/users"
```

Expected: 401 Unauthorized. API keys should not grant access to Cognito-protected routes.

### 12. SQL Injection in Key

```bash
curl -s -H "x-api-key: tpk_'; DROP TABLE users; --" "$API_URL/api/v1/files"
```

Expected: 403 Forbidden. Malicious input safely denied.

### 13. Oversized Key Header

```bash
curl -s -H "x-api-key: tpk_$(python3 -c 'print(\"A\"*10000)')" "$API_URL/api/v1/files"
```

Expected: 413 (header too large). Rejected at the gateway level.

### 14. Path Traversal via Download URL

```bash
curl -s -H "x-api-key: $API_KEY" \
  -X POST -H "Content-Type: application/json" \
  -d '{"filename":"../../etc/passwd","folder":"private"}' \
  "$API_URL/api/v1/files/download-url"
```

Expected: 404. No file leak outside the user's directory.

### 15. Access Another User's Folder

```bash
curl -s -H "x-api-key: $API_KEY" "$API_URL/api/v1/files?folder=private&path=../otheruser"
```

Expected: 200 with empty files/folders. Results scoped to the key owner's directory only.

### 16. Revoked Key

After revoking the key via the web portal:

```bash
curl -s -H "x-api-key: $API_KEY" "$API_URL/api/v1/files"
```

Expected: 403 Forbidden.

## Settings Enforcement Tests

These tests verify that admin-configured limits (Limits & Defaults) are enforced on the API key path.

### 17. Upload Disallowed File Type

With `acceptedFileTypes` set to `.txt` and `.jpg` in admin settings:

```bash
curl -s -H "x-api-key: $API_KEY" \
  -X POST -H "Content-Type: application/json" \
  -d '{"filename":"test.csv","folder":"private"}' \
  "$API_URL/api/v1/files/upload-url"
```

Expected: 400 with `{ error: "File type not allowed. Accepted types: .txt, .jpg" }`.

### 18. Upload Allowed File Type

```bash
curl -s -H "x-api-key: $API_KEY" \
  -X POST -H "Content-Type: application/json" \
  -d '{"filename":"test.txt","folder":"private"}' \
  "$API_URL/api/v1/files/upload-url"
```

Expected: 200 with a pre-signed upload URL.

### 19. File Count Limit

When the user has reached `maxFilesPerUser`:

```bash
curl -s -H "x-api-key: $API_KEY" \
  -X POST -H "Content-Type: application/json" \
  -d '{"filename":"one-more.txt","folder":"private"}' \
  "$API_URL/api/v1/files/upload-url"
```

Expected: 400 with `{ error: "File count limit reached (1000)" }`.

### 20. Storage Quota Exceeded

When the user has reached `maxStoragePerUser`:

```bash
curl -s -H "x-api-key: $API_KEY" \
  -X POST -H "Content-Type: application/json" \
  -d '{"filename":"large-file.txt","folder":"private"}' \
  "$API_URL/api/v1/files/upload-url"
```

Expected: 400 with `{ error: "Storage quota exceeded" }`.

## Post-Test Cleanup

1. Revoke the test API key via the web portal (Profile → API Keys → Revoke)
2. Delete any test folders/files created during testing
