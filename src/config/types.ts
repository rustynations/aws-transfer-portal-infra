/**
 * Configuration types for AWS Transfer Portal Kit
 */

export type Protocol = 'SFTP' | 'FTPS';

export interface SftpConfig {
  enabled: boolean;
  protocols: Protocol[];
  customDomain?: string;
  certificateArn?: string;
}

export interface WebPortalConfig {
  customDomain?: string;
  certificateArn?: string;
}

export interface StorageConfig {
  retentionDays?: number;
}

export type SharedFolderPermissions = 'read-only' | 'read-write';

export interface SharedFolderConfig {
  enabled: boolean;
  name?: string;  // Defaults to 'shared'
  permissions?: SharedFolderPermissions;  // Defaults to 'read-write'
}

export interface BootstrapConfig {
  adminEmail: string;
  adminPassword: string;
}

export interface NotificationsConfig {
  email: string;
  fromEmail?: string;  // SES verified sender email for user welcome emails
}

export interface AwsConfig {
  region: string;
  accountId?: string;
}

export interface DeploymentConfig {
  accountId: string;
  region: string;
  domainName?: string;
  github: {
    owner: string;
    repo: string;
    branch?: string;  // Defaults to 'main'
  };
}

export interface TransferPortalConfig {
  projectName: string;
  deployment: DeploymentConfig;
  storage: StorageConfig;
  sftp: SftpConfig;
  webPortal?: WebPortalConfig;
  bootstrap?: BootstrapConfig;
  notifications?: NotificationsConfig;
  aws?: AwsConfig;
  tags?: Record<string, string>;
  sharedFolder?: SharedFolderConfig;
}

export interface ValidationError {
  field: string;
  message: string;
}
