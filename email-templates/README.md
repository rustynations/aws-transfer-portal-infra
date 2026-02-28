# Email Templates

This directory contains HTML and text email templates for user welcome emails. These templates are deployed to AWS SES and used when creating new users.

## Templates

Each access type has its own template:

- **admin-welcome** - For ADMIN users (web portal only, no SFTP)
- **web-only-welcome** - For WEB_ONLY users (web portal only, no SFTP)
- **sftp-only-welcome** - For SFTP_ONLY users (SFTP only, no web portal)
- **hybrid-welcome** - For HYBRID users (both web portal and SFTP)

Each template has two versions:
- `.html` - HTML version with styling
- `.txt` - Plain text fallback

## Template Variables

Templates use Mustache-style variables that are replaced when emails are sent:

| Variable | Description | Used In |
|----------|-------------|---------|
| `{{projectName}}` | Your project name from config | All templates |
| `{{email}}` | User's email address | All templates |
| `{{username}}` | Auto-generated SFTP username | SFTP_ONLY, HYBRID |
| `{{temporaryPassword}}` | Temporary web portal password | ADMIN, WEB_ONLY, HYBRID |
| `{{sftpEndpoint}}` | SFTP server endpoint | SFTP_ONLY, HYBRID |
| `{{webPortalUrl}}` | Web portal URL | ADMIN, WEB_ONLY, HYBRID |

## Customizing Templates

You can customize these templates to match your organization's branding:

1. **Edit the HTML files** for styled emails
2. **Edit the TXT files** for plain text versions (important for email clients that don't support HTML)
3. **Keep variable names unchanged** - they must match exactly (including `{{` and `}}`)
4. **Test your changes** by creating a test user after deployment

### Example Customizations

**Add your logo:**
```html
<div style="text-align: center; margin-bottom: 20px;">
  <img src="https://your-domain.com/logo.png" alt="Company Logo" style="max-width: 200px;">
</div>
```

**Change colors:**
- Primary blue: `#0066cc` → your brand color
- Success green: `#28a745` → your brand color
- Warning yellow: `#ffc107` → your brand color

**Add footer links:**
```html
<div style="text-align: center; margin-top: 20px;">
  <a href="https://your-domain.com/support">Support</a> |
  <a href="https://your-domain.com/docs">Documentation</a>
</div>
```

## Deployment

Templates are automatically deployed when you run:

```bash
npm run deploy
```

The CDK stack reads these files and creates SES templates with names like:
- `{projectName}-admin-welcome`
- `{projectName}-web-only-welcome`
- `{projectName}-sftp-only-welcome`
- `{projectName}-hybrid-welcome`

## SES Configuration

Before emails will work, you need to:

1. **Verify your sender email** in AWS SES Console
   - Go to SES → Email Addresses → Verify a New Email Address
   - Enter the email from `config.yml` → `notifications.fromEmail`
   - Check your inbox for verification email and click the link

2. **Request production access** (for production use)
   - By default, SES is in sandbox mode
   - In sandbox, you can only send TO verified addresses
   - Request production access in SES Console to send to any address

3. **Configure fromEmail** in `config.yml`:
   ```yaml
   notifications:
     fromEmail: "noreply@example.com"
   ```

## Testing

To test your templates:

1. Deploy the stack with your customized templates
2. Create a test user via the web portal
3. Check the email received
4. Verify both HTML and text versions render correctly

## Troubleshooting

**Emails not sending:**
- Check that `fromEmail` is configured in `config.yml`
- Verify the sender email in SES Console
- Check CloudWatch Logs for the users Lambda function
- Ensure SES is not in sandbox mode (or recipient is verified)

**Variables not replaced:**
- Ensure variable names match exactly: `{{variableName}}`
- Check for typos in variable names
- Variables are case-sensitive

**Styling issues:**
- Test in multiple email clients (Gmail, Outlook, Apple Mail)
- Use inline styles (external CSS is not supported)
- Keep layouts simple (email clients have limited CSS support)



