import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { TransferPortalConfig, ValidationError } from './types';

/**
 * ConfigLoader handles loading and validating configuration files
 */
export class ConfigLoader {
  /**
   * Load configuration from a YAML file
   * @param filePath Path to the configuration file
   * @returns Parsed configuration object with defaults applied
   * @throws Error if file not found or YAML parsing fails
   */
  static load(filePath: string): TransferPortalConfig {
    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`Configuration file not found: ${filePath}`);
      }

      // Read file contents
      const fileContents = fs.readFileSync(filePath, 'utf8');

      // Parse YAML
      const config = yaml.load(fileContents) as TransferPortalConfig;

      if (!config) {
        throw new Error(`Configuration file is empty: ${filePath}`);
      }

      // Apply defaults
      return this.applyDefaults(config);
    } catch (error) {
      if (error instanceof yaml.YAMLException) {
        throw new Error(`YAML parsing error in ${filePath}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Apply default values to configuration
   * @param config Configuration object
   * @returns Configuration with defaults applied
   */
  private static applyDefaults(config: TransferPortalConfig): TransferPortalConfig {
    return {
      ...config,
      deployment: {
        accountId: config.deployment?.accountId,
        region: config.deployment?.region,
        domainName: config.deployment?.domainName,
        github: {
          owner: config.deployment?.github?.owner,
          repo: config.deployment?.github?.repo,
          branch: config.deployment?.github?.branch || 'main',
        },
      } as any,
      storage: {
        retentionDays: config.storage?.retentionDays
      },
      sftp: {
        enabled: config.sftp?.enabled ?? true,
        protocols: config.sftp?.protocols || ['SFTP'],
        customDomain: config.sftp?.customDomain,
        certificateArn: config.sftp?.certificateArn
      },
      webPortal: config.webPortal,
      bootstrap: config.bootstrap,
      notifications: config.notifications,
      aws: config.aws,
      tags: config.tags,
      sharedFolder: config.sharedFolder ? {
        enabled: config.sharedFolder.enabled,
        name: config.sharedFolder.name || 'shared',
        permissions: config.sharedFolder.permissions || 'read-write'
      } : undefined
    };
  }

  /**
   * Validate configuration object
   * @param config Configuration to validate
   * @returns Array of validation errors (empty if valid)
   */
  static validate(config: TransferPortalConfig): ValidationError[] {
    const errors: ValidationError[] = [];

    // Validate deployment configuration
    if (!config.deployment) {
      errors.push({ field: 'deployment', message: 'Missing required field: deployment' });
    } else {
      if (!config.deployment.accountId) {
        errors.push({ field: 'deployment.accountId', message: 'Missing required field: deployment.accountId' });
      }
      if (!config.deployment.region) {
        errors.push({ field: 'deployment.region', message: 'Missing required field: deployment.region' });
      }
      if (!config.deployment.github?.owner) {
        errors.push({ field: 'deployment.github.owner', message: 'Missing required field: deployment.github.owner' });
      }
      if (!config.deployment.github?.repo) {
        errors.push({ field: 'deployment.github.repo', message: 'Missing required field: deployment.github.repo' });
      }
    }

    // Validate required fields
    if (!config.projectName) {
      errors.push({
        field: 'projectName',
        message: 'Missing required field: projectName'
      });
    } else {
      // Validate project name format (alphanumeric, hyphens, underscores only)
      const projectNamePattern = /^[a-zA-Z0-9-_]+$/;
      if (!projectNamePattern.test(config.projectName)) {
        errors.push({
          field: 'projectName',
          message: 'Invalid projectName format. Use only alphanumeric characters, hyphens, and underscores.'
        });
      }
    }

    // Validate SFTP configuration
    if (!config.sftp) {
      errors.push({
        field: 'sftp',
        message: 'Missing required field: sftp'
      });
    } else {
      // Validate sftp.enabled is a boolean
      if (typeof config.sftp.enabled !== 'boolean') {
        errors.push({
          field: 'sftp.enabled',
          message: 'sftp.enabled must be a boolean value'
        });
      }

      // Only validate protocols, customDomain, and certificateArn when SFTP is enabled
      if (config.sftp.enabled === true) {
        if (!config.sftp.protocols || config.sftp.protocols.length === 0) {
          errors.push({
            field: 'sftp.protocols',
            message: 'At least one protocol (SFTP or FTPS) must be specified'
          });
        } else {
          // Validate protocol values
          const validProtocols = ['SFTP', 'FTPS'];
          const invalidProtocols = config.sftp.protocols.filter(
            p => !validProtocols.includes(p)
          );
          if (invalidProtocols.length > 0) {
            errors.push({
              field: 'sftp.protocols',
              message: `Invalid protocol(s): ${invalidProtocols.join(', ')}. Valid values are: SFTP, FTPS`
            });
          }
        }

        // Validate custom domain configuration
        if (config.sftp.customDomain && !config.sftp.certificateArn) {
          errors.push({
            field: 'sftp.certificateArn',
            message: 'certificateArn is required when customDomain is specified'
          });
        }
      }
    }

    // Validate web portal configuration
    if (config.webPortal) {
      if (config.webPortal.customDomain && !config.webPortal.certificateArn) {
        errors.push({
          field: 'webPortal.certificateArn',
          message: 'certificateArn is required when customDomain is specified'
        });
      }

      // Validate certificate is in us-east-1 for CloudFront
      if (config.webPortal.certificateArn) {
        if (!config.webPortal.certificateArn.includes(':us-east-1:')) {
          errors.push({
            field: 'webPortal.certificateArn',
            message: 'Certificate must be in us-east-1 region for CloudFront'
          });
        }
      }
    }

    // Validate AWS configuration
    if (config.aws) {
      if (config.aws.region) {
        // Validate AWS region
        const validRegions = [
          'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
          'af-south-1', 'ap-east-1', 'ap-south-1', 'ap-south-2',
          'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
          'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4',
          'ca-central-1', 'eu-central-1', 'eu-central-2',
          'eu-west-1', 'eu-west-2', 'eu-west-3',
          'eu-south-1', 'eu-south-2', 'eu-north-1',
          'il-central-1', 'me-south-1', 'me-central-1',
          'sa-east-1'
        ];

        if (!validRegions.includes(config.aws.region)) {
          errors.push({
            field: 'aws.region',
            message: `Invalid AWS region '${config.aws.region}'. Must be a valid AWS region.`
          });
        }
      }
    }

    // Validate bootstrap configuration
    if (config.bootstrap) {
      if (!config.bootstrap.adminEmail) {
        errors.push({
          field: 'bootstrap.adminEmail',
          message: 'adminEmail is required in bootstrap configuration'
        });
      } else {
        // Validate email format
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailPattern.test(config.bootstrap.adminEmail)) {
          errors.push({
            field: 'bootstrap.adminEmail',
            message: `Invalid email format: '${config.bootstrap.adminEmail}'`
          });
        }
      }

      if (!config.bootstrap.adminPassword) {
        errors.push({
          field: 'bootstrap.adminPassword',
          message: 'adminPassword is required in bootstrap configuration'
        });
      } else {
        // Validate password complexity
        const password = config.bootstrap.adminPassword;
        if (password.length < 8) {
          errors.push({
            field: 'bootstrap.adminPassword',
            message: 'Password must be at least 8 characters long'
          });
        }
        if (!/[A-Z]/.test(password)) {
          errors.push({
            field: 'bootstrap.adminPassword',
            message: 'Password must contain at least one uppercase letter'
          });
        }
        if (!/[a-z]/.test(password)) {
          errors.push({
            field: 'bootstrap.adminPassword',
            message: 'Password must contain at least one lowercase letter'
          });
        }
        if (!/[0-9]/.test(password)) {
          errors.push({
            field: 'bootstrap.adminPassword',
            message: 'Password must contain at least one number'
          });
        }
        if (!/[^A-Za-z0-9]/.test(password)) {
          errors.push({
            field: 'bootstrap.adminPassword',
            message: 'Password must contain at least one special character'
          });
        }
      }
    }

    // Validate notifications configuration
    if (config.notifications?.email) {
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(config.notifications.email)) {
        errors.push({
          field: 'notifications.email',
          message: `Invalid email format: '${config.notifications.email}'`
        });
      }
    }

    // Validate storage configuration
    if (config.storage?.retentionDays !== undefined) {
      if (config.storage.retentionDays < 1) {
        errors.push({
          field: 'storage.retentionDays',
          message: 'retentionDays must be at least 1'
        });
      }
    }

    // Validate tags if provided
    if (config.tags) {
      Object.entries(config.tags).forEach(([key, value]) => {
        // AWS tag key constraints
        if (key.length > 128) {
          errors.push({
            field: `tags.${key}`,
            message: `Tag key '${key}' exceeds 128 characters`
          });
        }
        if (!/^[\w\s.:/=+@-]*$/.test(key)) {
          errors.push({
            field: `tags.${key}`,
            message: `Tag key '${key}' contains invalid characters. Use only letters, numbers, spaces, and +-=._:/@`
          });
        }
        // AWS tag value constraints
        if (value.length > 256) {
          errors.push({
            field: `tags.${key}`,
            message: `Tag value for key '${key}' exceeds 256 characters`
          });
        }
        if (!/^[\w\s.:/=+@-]*$/.test(value)) {
          errors.push({
            field: `tags.${key}`,
            message: `Tag value for key '${key}' contains invalid characters. Use only letters, numbers, spaces, and +-=._:/@`
          });
        }
      });
    }

    // Validate shared folder configuration
    if (config.sharedFolder) {
      if (config.sharedFolder.enabled) {
        // Validate folder name if provided
        if (config.sharedFolder.name) {
          const namePattern = /^[a-zA-Z0-9-_]+$/;
          if (!namePattern.test(config.sharedFolder.name)) {
            errors.push({
              field: 'sharedFolder.name',
              message: 'Invalid folder name. Use only alphanumeric characters, hyphens, and underscores.'
            });
          }
        }

        // Validate permissions if provided
        if (config.sharedFolder.permissions) {
          const validPermissions = ['read-only', 'read-write'];
          if (!validPermissions.includes(config.sharedFolder.permissions)) {
            errors.push({
              field: 'sharedFolder.permissions',
              message: `Invalid permissions: '${config.sharedFolder.permissions}'. Valid values are: read-only, read-write`
            });
          }
        }
      }
    }

    return errors;
  }
}
