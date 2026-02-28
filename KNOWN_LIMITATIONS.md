# Known Limitations

Documented limitations and areas for future improvement.

## L-001: No pagination for file listings (>1,000 files)

| | |
|---|---|
| Severity | Medium |
| Status | Open |

The `GET /files` endpoint makes a single `ListObjectsV2` call to S3, which returns a maximum of 1,000 objects. Folders with more than 1,000 items will return truncated results without any indication to the caller.

To fix this properly:
- Implement `ContinuationToken` handling or server-side pagination with `limit`/`nextToken` params
- Frontend consumers would need to adopt paginated fetching accordingly
