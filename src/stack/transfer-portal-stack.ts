import * as cdk from 'aws-cdk-lib';
import { Tags, RemovalPolicy, Duration } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as transfer from 'aws-cdk-lib/aws-transfer';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { TransferPortalConfig } from '../config/types';
import * as fs from 'fs';
import * as path from 'path';

/**
 * TransferPortalStack creates AWS infrastructure for file transfer portal
 */
export class TransferPortalStack extends cdk.Stack {
  private readonly config: TransferPortalConfig;
  private filesBucket!: s3.Bucket;
  private usersTable!: dynamodb.Table;
  private activityTable!: dynamodb.Table;
  private transferUserRole?: iam.Role;
  private identityProviderLambda?: lambda.Function;
  private transferServer?: transfer.CfnServer;
  private userPool!: cognito.UserPool;
  private userPoolClient!: cognito.UserPoolClient;
  private api!: apigateway.RestApi;
  private usersLambda!: lambda.Function;
  private keysLambda!: lambda.Function;
  private filesLambda!: lambda.Function;
  private adminLambda!: lambda.Function;
  private s3EventHandlerLambda!: lambda.Function;
  private settingsTable!: dynamodb.Table;
  private settingsLambda!: lambda.Function;
  private apiKeysTable!: dynamodb.Table;
  private apiKeysLambda!: lambda.Function;
  private apiKeyAuthorizerLambda!: lambda.Function;
  private notificationTopic?: sns.Topic;
  private sesEmailIdentity?: ses.CfnEmailIdentity;

  // Public accessors for cross-stack references
  public get apiEndpoint(): string { return this.api.url; }
  public get userPoolId(): string { return this.userPool.userPoolId; }
  public get userPoolClientId(): string { return this.userPoolClient.userPoolClientId; }

  constructor(scope: Construct, id: string, config: TransferPortalConfig, props?: cdk.StackProps) {
    super(scope, id, props);

    this.config = config;

    // Apply tags to all resources in this stack
    this.applyTags();

    // Create S3 bucket for file storage
    this.filesBucket = this.createFilesBucket();

    // Create DynamoDB table for user store
    this.usersTable = this.createUsersTable();

    // Create DynamoDB table for activity log
    this.activityTable = this.createActivityTable();

    // Create DynamoDB table for application settings
    this.settingsTable = this.createSettingsTable();

    // Create DynamoDB table for API keys
    this.apiKeysTable = this.createApiKeysTable();

    // Create Transfer Family resources only when SFTP is enabled
    if (this.config.sftp.enabled) {
      // Create IAM role for Transfer Family
      this.transferUserRole = this.createTransferUserRole();

      // Create Lambda function for identity provider
      this.identityProviderLambda = this.createIdentityProviderLambda();

      // Create Transfer Family server
      this.transferServer = this.createTransferServer();
    }

    // Create Cognito user pool for web authentication
    this.userPool = this.createUserPool();
    this.userPoolClient = this.createUserPoolClient();

    // Create API Gateway and Lambda functions
    this.usersLambda = this.createUsersLambda();
    this.keysLambda = this.createKeysLambda();
    this.filesLambda = this.createFilesLambda();
    this.adminLambda = this.createAdminLambda();
    this.s3EventHandlerLambda = this.createS3EventHandlerLambda();
    this.settingsLambda = this.createSettingsLambda();

    // Create API key management Lambda and authorizer Lambda
    this.apiKeysLambda = this.createApiKeysLambda();
    this.apiKeyAuthorizerLambda = this.createApiKeyAuthorizerLambda();

    this.api = this.createApiGateway();

    // Configure S3 event notifications
    this.configureS3Events();

    // Seed read-only settings from infrastructure outputs
    this.seedSettings();

    // Create SES email identity and templates if fromEmail is configured
    if (this.config.notifications?.fromEmail) {
      // Note: Email identity must be verified manually in SES console before deployment
      // We don't create it here to avoid conflicts with existing verified identities
      this.createSESTemplates();
    }

    // Create notification topic if email is configured
    this.notificationTopic = this.createNotificationTopic();

    // Send stack deployment notification
    if (this.notificationTopic) {
      this.sendStackDeploymentNotification(this.notificationTopic);
    }

    // Bootstrap admin user if configured
    if (this.config.bootstrap) {
      this.bootstrapAdminUser();
    }

    // Output important values
    this.createOutputs();
  }

  /**
   * Apply tags to all resources in the stack
   * Includes default tags (projectName, ManagedBy) and user-defined tags
   */
  private applyTags(): void {
    // Apply default tags
    Tags.of(this).add('ProjectName', this.config.projectName);
    Tags.of(this).add('ManagedBy', 'aws-transfer-portal-kit');

    // Apply user-defined tags
    if (this.config.tags) {
      Object.entries(this.config.tags).forEach(([key, value]) => {
        Tags.of(this).add(key, value);
      });
    }
  }

  /**
   * Create S3 bucket for file storage
   * Task 2.1: Configure server-side encryption, versioning disabled, public access blocked
   * Requirements: 8.4, 8.5, 10.1
   */
  private createFilesBucket(): s3.Bucket {
    const bucket = new s3.Bucket(this, 'FilesBucket', {
      bucketName: `${this.config.projectName}-files-${cdk.Aws.ACCOUNT_ID}`,
      
      // Security: Server-side encryption enabled
      encryption: s3.BucketEncryption.S3_MANAGED,
      
      // Versioning disabled to minimize costs
      versioned: false,
      
      // Block all public access
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      
      // HTTPS only
      enforceSSL: true,
      
      // Removal policy for development (change to RETAIN for production)
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      
      // CORS configuration for pre-signed URL uploads from web portal
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
            s3.HttpMethods.DELETE,
            s3.HttpMethods.HEAD
          ],
          allowedOrigins: ['*'], // Will be restricted to CloudFront domain in production
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000
        }
      ]
    });

    // Add lifecycle policy if retention days is configured
    if (this.config.storage?.retentionDays) {
      bucket.addLifecycleRule({
        id: 'DeleteOldFiles',
        enabled: true,
        expiration: cdk.Duration.days(this.config.storage.retentionDays),
        prefix: 'users/'
      });
    }

    // Create shared folder if enabled
    if (this.config.sharedFolder?.enabled) {
      this.createSharedFolder(bucket);
    }

    return bucket;
  }

  /**
   * Create shared folder in S3 bucket
   * Uses a custom resource to create a placeholder object that establishes the shared/ prefix
   */
  private createSharedFolder(bucket: s3.Bucket): void {
    const sharedFolderInit = new lambda.Function(this, 'SharedFolderInit', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
        const s3 = new S3Client({});
        
        exports.handler = async (event) => {
          console.log('Event:', JSON.stringify(event, null, 2));
          
          const requestType = event.RequestType;
          const bucketName = event.ResourceProperties.BucketName;
          
          if (requestType === 'Create' || requestType === 'Update') {
            try {
              // Create a .keep file to establish the shared/ prefix
              await s3.send(new PutObjectCommand({
                Bucket: bucketName,
                Key: 'shared/.keep',
                Body: 'This file maintains the shared folder structure',
                ContentType: 'text/plain'
              }));
              
              console.log('Shared folder created successfully');
              return {
                PhysicalResourceId: 'shared-folder-init',
                Data: { Message: 'Shared folder initialized' }
              };
            } catch (error) {
              console.error('Error creating shared folder:', error);
              throw error;
            }
          }
          
          // For Delete, we don't need to do anything (bucket will be deleted)
          return {
            PhysicalResourceId: 'shared-folder-init',
            Data: { Message: 'Shared folder cleanup not needed' }
          };
        };
      `),
      timeout: Duration.seconds(30)
    });

    // Grant the Lambda permission to write to the bucket
    bucket.grantPut(sharedFolderInit);

    // Create custom resource
    new cr.AwsCustomResource(this, 'SharedFolderInitResource', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: sharedFolderInit.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({
            RequestType: 'Create',
            ResourceProperties: {
              BucketName: bucket.bucketName
            }
          })
        },
        physicalResourceId: cr.PhysicalResourceId.of('shared-folder-init')
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [sharedFolderInit.functionArn]
        })
      ])
    });
  }

  /**
   * Create DynamoDB table for user store
   * Task 2.3: Define table schema with username as partition key, encryption at rest
   * Requirements: 10.6
   */
  private createUsersTable(): dynamodb.Table {
    const table = new dynamodb.Table(this, 'UsersTable', {
      tableName: `${this.config.projectName}-users`,
      
      // Partition key: username
      partitionKey: {
        name: 'username',
        type: dynamodb.AttributeType.STRING
      },
      
      // Encryption at rest enabled
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      
      // Billing mode: Pay per request (good for variable workloads)
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      
      // Point-in-time recovery for data protection
      pointInTimeRecovery: true,
      
      // Removal policy for development (change to RETAIN for production)
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Add GSI on email attribute for email lookups
    table.addGlobalSecondaryIndex({
      indexName: 'email-index',
      partitionKey: {
        name: 'email',
        type: dynamodb.AttributeType.STRING
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    return table;
  }

  /**
   * Create DynamoDB table for activity log
   * Stores file operation activity for dashboard display
   */
  private createActivityTable(): dynamodb.Table {
    const table = new dynamodb.Table(this, 'ActivityTable', {
      tableName: `${this.config.projectName}-activity`,
      
      // Partition key: activityId (timestamp-based UUID)
      partitionKey: {
        name: 'activityId',
        type: dynamodb.AttributeType.STRING
      },
      
      // Sort key: timestamp for chronological ordering
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER
      },
      
      // Encryption at rest enabled
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      
      // Billing mode: Pay per request
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      
      // TTL to automatically delete old activity records (30 days)
      timeToLiveAttribute: 'ttl',
      
      // Removal policy for development
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Add GSI on username for per-user activity queries
    table.addGlobalSecondaryIndex({
      indexName: 'username-timestamp-index',
      partitionKey: {
        name: 'username',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Add GSI on timestamp for global activity queries
    table.addGlobalSecondaryIndex({
      indexName: 'timestamp-index',
      partitionKey: {
        name: 'activityType',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    return table;
  }

  /**
   * Create DynamoDB table for application settings
   * Single-row key-value store for runtime-configurable app settings
   * and read-only infrastructure outputs
   */
  private createSettingsTable(): dynamodb.Table {
    const table = new dynamodb.Table(this, 'SettingsTable', {
      tableName: `${this.config.projectName}-settings`,
      partitionKey: {
        name: 'settingKey',
        type: dynamodb.AttributeType.STRING
      },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    return table;
  }

  /**
   * Create IAM role for Transfer Family users
   * Task 2.5: Define least privilege policies for S3 access with user-specific paths
   * Requirements: 10.2
   * 
   * Note: This role grants broad permissions on the bucket. The actual user-specific
   * scoping is done via session policies returned by the identity provider Lambda.
   * This approach is more reliable than using ${transfer:UserName} variables.
   */
  private createTransferUserRole(): iam.Role {
    const role = new iam.Role(this, 'TransferUserRole', {
      roleName: `${this.config.projectName}-transfer-user-role`,
      assumedBy: new iam.ServicePrincipal('transfer.amazonaws.com'),
      description: 'IAM role for Transfer Family users to access S3'
    });

    // Policy for listing bucket
    // Session policy will scope this to user-specific prefix
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket', 's3:GetBucketLocation'],
      resources: [this.filesBucket.bucketArn]
    }));

    // Policy for object operations
    // Session policy will scope this to user-specific paths
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:GetObjectVersion',
        's3:PutObject',
        's3:DeleteObject',
        's3:DeleteObjectVersion'
      ],
      resources: [`${this.filesBucket.bucketArn}/*`]
    }));

    return role;
  }

  /**
   * Create Lambda function for Transfer Family custom identity provider
   * Task 3.1: Implement authentication logic for SSH keys
   * Task 3.4: Add CloudWatch logging for authentication events
   * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
   */
  private createIdentityProviderLambda(): lambda.Function {
    const fn = new lambda.Function(this, 'IdentityProviderLambda', {
      functionName: `${this.config.projectName}-identity-provider`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lib/lambda/identity-provider'),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        USERS_TABLE: this.usersTable.tableName,
        TRANSFER_ROLE_ARN: this.transferUserRole!.roleArn,
        FILES_BUCKET: this.filesBucket.bucketName,
        SHARED_FOLDER_ENABLED: this.config.sharedFolder?.enabled ? 'true' : 'false',
        SHARED_FOLDER_NAME: this.config.sharedFolder?.name || 'shared',
        SHARED_FOLDER_PERMISSIONS: this.config.sharedFolder?.permissions || 'read-write'
      },
      description: 'Custom identity provider for AWS Transfer Family'
    });

    // Grant Lambda permission to read from DynamoDB
    this.usersTable.grantReadData(fn);

    // Grant Lambda permission to update last_login timestamp
    this.usersTable.grantWriteData(fn);

    // Grant Transfer Family permission to invoke Lambda
    fn.addPermission('TransferInvoke', {
      principal: new iam.ServicePrincipal('transfer.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceAccount: cdk.Aws.ACCOUNT_ID
    });

    return fn;
  }

  /**
   * Create AWS Transfer Family server
   * Task 4.1: Configure protocols based on config file
   * Requirements: 1.2, 1.3, 14.1
   */
  private createTransferServer(): transfer.CfnServer {
    // Create IAM role for Transfer Family to invoke Lambda
    const transferLoggingRole = new iam.Role(this, 'TransferLoggingRole', {
      assumedBy: new iam.ServicePrincipal('transfer.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSTransferLoggingAccess')
      ]
    });

    const server = new transfer.CfnServer(this, 'TransferServer', {
      endpointType: 'PUBLIC',
      protocols: this.config.sftp.protocols,
      identityProviderType: 'AWS_LAMBDA',
      identityProviderDetails: {
        function: this.identityProviderLambda!.functionArn
        // Note: invocationRole is NOT needed for AWS_LAMBDA type
      },
      loggingRole: transferLoggingRole.roleArn,
      tags: [
        { key: 'Name', value: `${this.config.projectName}-transfer-server` },
        { key: 'ProjectName', value: this.config.projectName },
        { key: 'ManagedBy', value: 'aws-transfer-portal-kit' }
      ]
    });

    return server;
  }

  /**
   * Create Cognito user pool for web authentication
   * Task 6.1: Configure password policy and account recovery
   * Requirements: 10.5
   */
  private createUserPool(): cognito.UserPool {
    // Read password reset email template
    const passwordResetHtml = fs.readFileSync(
      path.join(__dirname, '../../email-templates/password-reset.html'),
      'utf-8'
    ).replace(/\{\{projectName\}\}/g, this.config.projectName);

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${this.config.projectName}-users`,
      
      // Sign-in with email
      signInAliases: {
        email: true,
        username: false
      },
      
      // Auto-verify email
      autoVerify: {
        email: true
      },
      
      // Password policy - enforce complexity requirements
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(7)
      },
      
      // Account recovery via email
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      
      // Self-service sign-up disabled (admin creates users)
      selfSignUpEnabled: false,
      
      // Standard attributes
      standardAttributes: {
        email: {
          required: true,
          mutable: true
        }
      },
      
      // Custom attributes for access type
      customAttributes: {
        'access_type': new cognito.StringAttribute({ 
          minLen: 1, 
          maxLen: 20,
          mutable: true 
        })
      },
      
      // Custom email messages for password reset
      userVerification: {
        emailSubject: `${this.config.projectName} - Password Reset Code`,
        emailBody: passwordResetHtml,
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      
      // Email configuration (use Cognito default for now)
      email: cognito.UserPoolEmail.withCognito(),
      
      // MFA configuration - OPTIONAL allows user self-enrollment
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: false,
        otp: true,  // Enable TOTP
      },
      
      // Removal policy
      removalPolicy: RemovalPolicy.DESTROY
    });

    return userPool;
  }

  /**
   * Create Cognito user pool client for web portal
   * Task 6.3: Configure OAuth flows and callback URLs
   * Requirements: 5.1
   */
  private createUserPoolClient(): cognito.UserPoolClient {
    const client = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: `${this.config.projectName}-web-client`,
      
      // OAuth flows
      authFlows: {
        userPassword: true,
        userSrp: true
      },
      
      // Token validity
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      
      // Prevent user existence errors (security)
      preventUserExistenceErrors: true,
      
      // Enable token revocation
      enableTokenRevocation: true
    });

    return client;
  }

  /**
   * Create Lambda function for user management
   * Task 7.1: Create Lambda function for user CRUD operations
   * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
   */
  private createUsersLambda(): lambda.Function {
    const fn = new lambda.Function(this, 'UsersLambda', {
      functionName: `${this.config.projectName}-users-api`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'users.handler',
      code: lambda.Code.fromAsset('lib/lambda/api'),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        USERS_TABLE: this.usersTable.tableName,
        ACTIVITY_TABLE: this.activityTable.tableName,
        USER_POOL_ID: this.userPool.userPoolId,
        SES_FROM_EMAIL: this.config.notifications?.fromEmail || '',
        SES_TEMPLATE_PREFIX: this.config.projectName,
        SFTP_ENABLED: String(this.config.sftp.enabled),
        ...(this.config.sftp.enabled && this.transferServer
          ? { SFTP_ENDPOINT: `${this.transferServer.attrServerId}.server.transfer.${cdk.Aws.REGION}.amazonaws.com` }
          : {}),
        WEB_PORTAL_URL: 'http://localhost:5174',  // TODO: Make configurable when portal stack is built
        PROJECT_NAME: this.config.projectName
      },
      description: 'User management API'
    });

    // Grant permissions
    this.usersTable.grantReadWriteData(fn);
    this.activityTable.grantWriteData(fn);
    
    fn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminDeleteUser',
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:AdminSetUserMFAPreference'
      ],
      resources: [this.userPool.userPoolArn]
    }));

    // Grant SES permissions if fromEmail is configured
    if (this.config.notifications?.fromEmail) {
      fn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ses:SendTemplatedEmail',
          'ses:SendEmail'
        ],
        resources: ['*']  // SES doesn't support resource-level permissions for SendEmail
      }));
    }

    return fn;
  }

  /**
   * Create Lambda function for SSH key management
   * Task 8.1: Create Lambda function for SSH key operations
   * Requirements: 3.1, 3.2, 3.4
   */
  private createKeysLambda(): lambda.Function {
    const fn = new lambda.Function(this, 'KeysLambda', {
      functionName: `${this.config.projectName}-keys-api`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'keys.handler',
      code: lambda.Code.fromAsset('lib/lambda/api'),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        USERS_TABLE: this.usersTable.tableName,
        ACTIVITY_TABLE: this.activityTable.tableName
      },
      description: 'SSH key management API'
    });

    // Grant permissions
    this.usersTable.grantReadWriteData(fn);
    this.activityTable.grantWriteData(fn);

    return fn;
  }

  /**
   * Create Lambda function for file operations
   * Task 11.1, 11.3, 11.5: Create Lambda function for file operations
   * Requirements: 6.1, 7.1, 7.5, 8.1
   */
  private createFilesLambda(): lambda.Function {
    const fn = new lambda.Function(this, 'FilesLambda', {
      functionName: `${this.config.projectName}-files-api`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'files.handler',
      code: lambda.Code.fromAsset('lib/lambda/api'),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        FILES_BUCKET: this.filesBucket.bucketName,
        USERS_TABLE: this.usersTable.tableName,
        ACTIVITY_TABLE: this.activityTable.tableName,
        SETTINGS_TABLE: this.settingsTable.tableName,
        SHARED_FOLDER_ENABLED: this.config.sharedFolder?.enabled ? 'true' : 'false',
        SHARED_FOLDER_NAME: this.config.sharedFolder?.name || 'shared',
        SHARED_FOLDER_PERMISSIONS: this.config.sharedFolder?.permissions || 'read-write'
      },
      description: 'File operations API'
    });

    // Grant permissions
    this.filesBucket.grantReadWrite(fn);
    this.usersTable.grantReadWriteData(fn);
    this.activityTable.grantWriteData(fn);
    this.settingsTable.grantReadData(fn);
    
    // Grant CloudWatch metrics permissions
    fn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*']
    }));

    return fn;
  }

  /**
   * Create Lambda function for admin dashboard
   * Task 13.1, 13.3, 13.5: Create Lambda function for admin operations
   * Requirements: 12.1, 12.2, 12.3, 12.4
   */
  private createAdminLambda(): lambda.Function {
    const fn = new lambda.Function(this, 'AdminLambda', {
      functionName: `${this.config.projectName}-admin-api`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'admin.handler',
      code: lambda.Code.fromAsset('lib/lambda/api'),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        FILES_BUCKET: this.filesBucket.bucketName,
        USERS_TABLE: this.usersTable.tableName,
        ACTIVITY_TABLE: this.activityTable.tableName,
        PROJECT_NAME: this.config.projectName
      },
      description: 'Admin dashboard API'
    });

    // Grant permissions
    this.filesBucket.grantRead(fn);
    this.usersTable.grantReadWriteData(fn);
    this.activityTable.grantReadData(fn);
    
    // Grant CloudWatch Logs read permissions
    fn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:FilterLogEvents',
        'logs:DescribeLogGroups',
        'logs:DescribeLogStreams'
      ],
      resources: [
        `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/${this.config.projectName}-*:*`
      ]
    }));

    return fn;
  }

  /**
   * Create Lambda function for S3 event handling
   * Triggered on file upload/delete to update stats in real-time
   */
  private createS3EventHandlerLambda(): lambda.Function {
    const fn = new lambda.Function(this, 'S3EventHandlerLambda', {
      functionName: `${this.config.projectName}-s3-event-handler`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lib/lambda/s3-event-handler'),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        USERS_TABLE: this.usersTable.tableName,
        ACTIVITY_TABLE: this.activityTable.tableName
      },
      description: 'S3 event handler for file upload/delete stats updates'
    });

    // Grant permissions
    this.usersTable.grantReadWriteData(fn);
    this.activityTable.grantWriteData(fn);
    this.filesBucket.grantRead(fn);

    return fn;
  }

  /**
   * Create Lambda function for settings management
   * Handles GET /settings (public), GET /admin/settings (authenticated), PUT /admin/settings (admin)
   */
  private createSettingsLambda(): lambda.Function {
    const fn = new lambda.Function(this, 'SettingsLambda', {
      functionName: `${this.config.projectName}-settings-api`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'settings.handler',
      code: lambda.Code.fromAsset('lib/lambda/api'),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        SETTINGS_TABLE: this.settingsTable.tableName,
        USERS_TABLE: this.usersTable.tableName,
        FILES_BUCKET: this.filesBucket.bucketName,
      },
      description: 'Settings management API'
    });

    this.settingsTable.grantReadWriteData(fn);
    this.usersTable.grantReadData(fn);
    this.filesBucket.grantReadWrite(fn);

    return fn;
  }

  /**
   * Create DynamoDB table for API keys
   * Stores API key metadata and hashes with GSIs for key lookup and user listing
   */
  private createApiKeysTable(): dynamodb.Table {
    const table = new dynamodb.Table(this, 'ApiKeysTable', {
      tableName: `${this.config.projectName}-api-keys`,
      partitionKey: {
        name: 'keyId',
        type: dynamodb.AttributeType.STRING
      },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    // GSI for O(1) key lookup during authorization
    table.addGlobalSecondaryIndex({
      indexName: 'keyHash-index',
      partitionKey: {
        name: 'keyHash',
        type: dynamodb.AttributeType.STRING
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // GSI for listing a user's keys ordered by creation date
    table.addGlobalSecondaryIndex({
      indexName: 'username-index',
      partitionKey: {
        name: 'username',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.NUMBER
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    return table;
  }

  /**
   * Create Lambda function for API key management (CRUD operations)
   */
  private createApiKeysLambda(): lambda.Function {
    const fn = new lambda.Function(this, 'ApiKeysLambda', {
      functionName: `${this.config.projectName}-api-keys-api`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'api-keys.handler',
      code: lambda.Code.fromAsset('lib/lambda/api'),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        API_KEYS_TABLE: this.apiKeysTable.tableName,
        USERS_TABLE: this.usersTable.tableName,
        ACTIVITY_TABLE: this.activityTable.tableName
      },
      description: 'API key management API'
    });

    // Grant permissions
    this.apiKeysTable.grantReadWriteData(fn);
    this.usersTable.grantReadData(fn);
    this.activityTable.grantWriteData(fn);

    return fn;
  }

  /**
   * Create Lambda authorizer for API key authentication
   */
  private createApiKeyAuthorizerLambda(): lambda.Function {
    const fn = new lambda.Function(this, 'ApiKeyAuthorizerLambda', {
      functionName: `${this.config.projectName}-api-key-authorizer`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'api-key-authorizer.handler',
      code: lambda.Code.fromAsset('lib/lambda/api'),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        API_KEYS_TABLE: this.apiKeysTable.tableName,
        USERS_TABLE: this.usersTable.tableName
      },
      description: 'API key authorizer for programmatic access'
    });

    // Grant permissions - read for key lookup and user resolution, write for lastUsedAt update
    this.apiKeysTable.grantReadWriteData(fn);
    this.usersTable.grantReadData(fn);

    return fn;
  }


  /**
   * Seed read-only settings from infrastructure outputs during deployment
   */
  private seedSettings(): void {
    const seedFn = new lambda.Function(this, 'SeedSettingsFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { DynamoDBClient, PutItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
        const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
        const dynamodb = new DynamoDBClient({});

        exports.handler = async (event) => {
          console.log('Seed settings event:', JSON.stringify(event, null, 2));
          const requestType = event.RequestType || event.requestType;

          if (requestType === 'Delete') {
            return { PhysicalResourceId: 'seed-settings', Data: { Message: 'Skipping delete' } };
          }

          const tableName = process.env.SETTINGS_TABLE;
          const settings = JSON.parse(process.env.SETTINGS_JSON);

          try {
            // Get existing settings to preserve editable values
            let existing = {};
            try {
              const result = await dynamodb.send(new GetItemCommand({
                TableName: tableName,
                Key: marshall({ settingKey: 'app' })
              }));
              if (result.Item) {
                existing = unmarshall(result.Item);
              }
            } catch (e) {
              console.log('No existing settings found, creating fresh');
            }

            // Merge: keep editable values if they exist, always overwrite read-only
            const merged = {
              settingKey: 'app',
              // Editable settings — preserve existing, set defaults if new
              appName: existing.appName || settings.projectName,
              loginDescription: existing.loginDescription || 'Sign in to manage your file transfers',
              logoKey: existing.logoKey || '',
              faviconKey: existing.faviconKey || '',
              acceptedFileTypes: existing.acceptedFileTypes || [],
              maxFileSize: existing.maxFileSize || 104857600,
              maxStoragePerUser: existing.maxStoragePerUser || 1073741824,
              maxFilesPerUser: existing.maxFilesPerUser || 1000,
              motd: existing.motd || '',
              defaultAccessType: existing.defaultAccessType || 'WEB_ONLY',
              // Read-only settings — always overwrite from infrastructure
              projectName: settings.projectName,
              apiEndpoint: settings.apiEndpoint,
              userPoolId: settings.userPoolId,
              userPoolClientId: settings.userPoolClientId,
              sftpEnabled: settings.sftpEnabled,
              ...(settings.transferServerEndpoint ? { transferServerEndpoint: settings.transferServerEndpoint } : {}),
              ...(settings.transferServerId ? { transferServerId: settings.transferServerId } : {}),
              filesBucket: settings.filesBucket,
              region: settings.region,
            };

            await dynamodb.send(new PutItemCommand({
              TableName: tableName,
              Item: marshall(merged, { removeUndefinedValues: true })
            }));

            console.log('Settings seeded successfully');
            return {
              PhysicalResourceId: 'seed-settings',
              Data: { Message: 'Settings seeded' }
            };
          } catch (error) {
            console.error('Error seeding settings:', error);
            throw error;
          }
        };
      `),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        SETTINGS_TABLE: this.settingsTable.tableName,
        SETTINGS_JSON: JSON.stringify({
          projectName: this.config.projectName,
          apiEndpoint: this.api.url,
          userPoolId: this.userPool.userPoolId,
          userPoolClientId: this.userPoolClient.userPoolClientId,
          sftpEnabled: this.config.sftp.enabled,
          ...(this.config.sftp.enabled ? {
            transferServerEndpoint: `${this.transferServer!.attrServerId}.server.transfer.${cdk.Aws.REGION}.amazonaws.com`,
            transferServerId: this.transferServer!.attrServerId,
          } : {}),
          filesBucket: this.filesBucket.bucketName,
          region: cdk.Aws.REGION,
        }),
      },
      description: 'Seed settings table with infrastructure outputs'
    });

    this.settingsTable.grantReadWriteData(seedFn);

    new cr.AwsCustomResource(this, 'SeedSettingsResource', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: seedFn.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({ RequestType: 'Create', ResourceProperties: {} }),
        },
        physicalResourceId: cr.PhysicalResourceId.of('seed-settings'),
      },
      onUpdate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: seedFn.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({ RequestType: 'Update', ResourceProperties: {} }),
        },
        physicalResourceId: cr.PhysicalResourceId.of('seed-settings'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [seedFn.functionArn],
        }),
      ]),
    });
  }

  /**
   * Configure S3 event notifications to trigger Lambda
   */
  private configureS3Events(): void {
    // Add S3 event notification for file uploads
    this.filesBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.s3EventHandlerLambda),
      { prefix: 'users/' }
    );

    // Add S3 event notification for file deletions
    this.filesBucket.addEventNotification(
      s3.EventType.OBJECT_REMOVED,
      new s3n.LambdaDestination(this.s3EventHandlerLambda),
      { prefix: 'users/' }
    );
  }

  /**
   * Create API Gateway with Cognito authorizer
   * Task 9.1: Create API Gateway REST API
   * Requirements: 10.3, 10.4
   */
  private createApiGateway(): apigateway.RestApi {
    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${this.config.projectName}-api`,
      description: 'Transfer Portal API',
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.OFF, // Disabled to avoid CloudWatch role requirement
        dataTraceEnabled: false
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
        allowCredentials: true
      }
    });

    // Create Cognito authorizer
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'ApiAuthorizer', {
      cognitoUserPools: [this.userPool],
      authorizerName: `${this.config.projectName}-authorizer`
    });

    // Users endpoints
    const users = api.root.addResource('users');
    users.addMethod('POST', new apigateway.LambdaIntegration(this.usersLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });
    users.addMethod('GET', new apigateway.LambdaIntegration(this.usersLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const user = users.addResource('{username}');

    // Profile endpoint (self-service, any authenticated user)
    const profile = users.addResource('profile');
    profile.addMethod('GET', new apigateway.LambdaIntegration(this.usersLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });
    profile.addMethod('PUT', new apigateway.LambdaIntegration(this.usersLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    user.addMethod('GET', new apigateway.LambdaIntegration(this.usersLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });
    user.addMethod('PUT', new apigateway.LambdaIntegration(this.usersLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });
    user.addMethod('DELETE', new apigateway.LambdaIntegration(this.usersLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    // MFA reset endpoint
    const resetMfa = user.addResource('reset-mfa');
    resetMfa.addMethod('POST', new apigateway.LambdaIntegration(this.usersLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    // SSH keys endpoints
    const keys = api.root.addResource('keys');
    keys.addMethod('POST', new apigateway.LambdaIntegration(this.keysLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });
    keys.addMethod('GET', new apigateway.LambdaIntegration(this.keysLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const key = keys.addResource('{key_id}');
    key.addMethod('DELETE', new apigateway.LambdaIntegration(this.keysLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    // File operations endpoints
    const files = api.root.addResource('files');
    files.addMethod('GET', new apigateway.LambdaIntegration(this.filesLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });
    files.addMethod('DELETE', new apigateway.LambdaIntegration(this.filesLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const uploadUrl = files.addResource('upload-url');
    uploadUrl.addMethod('POST', new apigateway.LambdaIntegration(this.filesLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const downloadUrl = files.addResource('download-url');
    downloadUrl.addMethod('POST', new apigateway.LambdaIntegration(this.filesLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const folder = files.addResource('folder');
    folder.addMethod('POST', new apigateway.LambdaIntegration(this.filesLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });
    folder.addMethod('DELETE', new apigateway.LambdaIntegration(this.filesLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    // Admin dashboard endpoints
    const admin = api.root.addResource('admin');
    
    const stats = admin.addResource('stats');
    stats.addMethod('GET', new apigateway.LambdaIntegration(this.adminLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const userStats = stats.addResource('{username}');
    userStats.addMethod('GET', new apigateway.LambdaIntegration(this.adminLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const activity = admin.addResource('activity');
    activity.addMethod('GET', new apigateway.LambdaIntegration(this.adminLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    // Admin settings endpoints (authenticated)
    const adminSettings = admin.addResource('settings');
    adminSettings.addMethod('GET', new apigateway.LambdaIntegration(this.settingsLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });
    adminSettings.addMethod('PUT', new apigateway.LambdaIntegration(this.settingsLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    // Admin settings upload URL endpoint (for logo/favicon uploads)
    const adminSettingsUpload = adminSettings.addResource('upload-url');
    adminSettingsUpload.addMethod('POST', new apigateway.LambdaIntegration(this.settingsLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    // Public settings endpoint (no auth — returns app name, logo, cognito IDs for login)
    const settings = api.root.addResource('settings');
    settings.addMethod('GET', new apigateway.LambdaIntegration(this.settingsLambda));

    // Create Lambda authorizer for API key authentication
    const apiKeyAuthorizer = new apigateway.TokenAuthorizer(this, 'ApiKeyAuthorizer', {
      handler: this.apiKeyAuthorizerLambda,
      authorizerName: `${this.config.projectName}-api-key-authorizer`,
      identitySource: 'method.request.header.x-api-key',
      resultsCacheTtl: Duration.seconds(300)
    });

    // API key-authenticated file operation routes under /api/v1/files
    const apiV1 = api.root.addResource('api').addResource('v1');
    const apiFiles = apiV1.addResource('files');
    const filesIntegration = new apigateway.LambdaIntegration(this.filesLambda);
    const apiKeyMethodOptions = {
      authorizer: apiKeyAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM
    };

    apiFiles.addMethod('GET', filesIntegration, apiKeyMethodOptions);
    apiFiles.addMethod('DELETE', filesIntegration, apiKeyMethodOptions);

    const apiUploadUrl = apiFiles.addResource('upload-url');
    apiUploadUrl.addMethod('POST', filesIntegration, apiKeyMethodOptions);

    const apiDownloadUrl = apiFiles.addResource('download-url');
    apiDownloadUrl.addMethod('POST', filesIntegration, apiKeyMethodOptions);

    const apiFolder = apiFiles.addResource('folder');
    apiFolder.addMethod('POST', filesIntegration, apiKeyMethodOptions);
    apiFolder.addMethod('DELETE', filesIntegration, apiKeyMethodOptions);

    // API key management routes (Cognito-authenticated)
    const apiKeys = api.root.addResource('api-keys');
    const apiKeysIntegration = new apigateway.LambdaIntegration(this.apiKeysLambda);

    apiKeys.addMethod('POST', apiKeysIntegration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });
    apiKeys.addMethod('GET', apiKeysIntegration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    const apiKeyId = apiKeys.addResource('{keyId}');
    apiKeyId.addMethod('DELETE', apiKeysIntegration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO
    });

    // Usage plan for rate limiting API key-authenticated requests
    const usagePlan = api.addUsagePlan('ApiKeyUsagePlan', {
      name: `${this.config.projectName}-api-key-usage-plan`,
      throttle: {
        rateLimit: 100,
        burstLimit: 200
      }
    });

    usagePlan.addApiStage({
      stage: api.deploymentStage
    });

    return api;
  }

  /**
   * Create SES email identity for sending welcome emails
   */
  private createSESEmailIdentity(): ses.CfnEmailIdentity {
    const emailIdentity = new ses.CfnEmailIdentity(this, 'SESEmailIdentity', {
      emailIdentity: this.config.notifications!.fromEmail!,
    });

    return emailIdentity;
  }

  /**
   * Create SES email templates for each access type
   * Note: Templates are read at synth time, not deploy time
   */
  private createSESTemplates(): void {
    const templateDir = path.join(__dirname, '../../email-templates');
    
    // Template configurations — always include non-SFTP templates
    const templates: Array<{ name: string; subject: string }> = [
      {
        name: 'admin-welcome',
        subject: `Welcome to ${this.config.projectName} - Admin Account`,
      },
      {
        name: 'web-only-welcome',
        subject: `Welcome to ${this.config.projectName} - Web Portal Access`,
      },
    ];

    // Only include SFTP-related welcome templates when SFTP is enabled
    if (this.config.sftp.enabled) {
      templates.push(
        {
          name: 'sftp-only-welcome',
          subject: `Welcome to ${this.config.projectName} - SFTP Access`,
        },
        {
          name: 'hybrid-welcome',
          subject: `Welcome to ${this.config.projectName} - Hybrid Access`,
        },
      );
    }

    templates.forEach((template) => {
      const htmlPath = path.join(templateDir, `${template.name}.html`);
      const textPath = path.join(templateDir, `${template.name}.txt`);

      // Read templates at synth time (not deploy time)
      const htmlTemplate = fs.readFileSync(htmlPath, 'utf-8');
      const textTemplate = fs.readFileSync(textPath, 'utf-8');

      new ses.CfnTemplate(this, `SESTemplate-${template.name}`, {
        template: {
          templateName: `${this.config.projectName}-${template.name}`,
          subjectPart: template.subject,
          htmlPart: htmlTemplate,
          textPart: textTemplate,
        },
      });
    });
  }

  /**
   * Create SNS topic for notifications
   */
  private createNotificationTopic(): sns.Topic | undefined {
    if (!this.config.notifications?.email) {
      return undefined;
    }

    const topic = new sns.Topic(this, 'NotificationTopic', {
      displayName: `${this.config.projectName} Transfer Portal Notifications`,
      topicName: `${this.config.projectName}-transfer-portal-notifications`,
    });

    // Create email subscription
    topic.addSubscription(new subscriptions.EmailSubscription(this.config.notifications.email));

    return topic;
  }

  /**
   * Send notification when stack is deployed
   */
  private sendStackDeploymentNotification(topic: sns.Topic): void {
    const sftpEnabled = this.config.sftp.enabled;

    const notificationFunction = new lambda.Function(this, 'DeploymentNotificationFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
        
        exports.handler = async (event) => {
          const topicArn = process.env.TOPIC_ARN;
          const transferEndpoint = process.env.TRANSFER_ENDPOINT;
          const apiEndpoint = process.env.API_ENDPOINT;
          const sftpEnabled = process.env.SFTP_ENABLED === 'true';
          
          const sns = new SNSClient({});
          
          const transferLine = sftpEnabled && transferEndpoint
            ? \`Transfer Server Endpoint: \${transferEndpoint}\n\`
            : '';
          
          const sftpSteps = sftpEnabled
            ? \`2. Configure SSH keys for SFTP access
3. Connect using SFTP/FTPS clients\`
            : '';
          
          try {
            await sns.send(new PublishCommand({
              TopicArn: topicArn,
              Subject: '🚀 Transfer Portal Stack Deployed',
              Message: \`Stack deployment complete!

\${transferLine}API Gateway Endpoint: \${apiEndpoint}

Next steps:
1. Create users via the API
\${sftpSteps}

Your transfer portal infrastructure is ready!\`
            }));
            
            return { Status: 'SUCCESS' };
          } catch (error) {
            console.error('Error sending notification:', error);
            return { Status: 'FAILED' };
          }
        };
      `),
      environment: {
        TOPIC_ARN: topic.topicArn,
        ...(sftpEnabled && this.transferServer
          ? { TRANSFER_ENDPOINT: `${this.transferServer.attrServerId}.server.transfer.${cdk.Aws.REGION}.amazonaws.com` }
          : {}),
        API_ENDPOINT: this.api.url,
        SFTP_ENABLED: String(sftpEnabled),
      },
    });

    topic.grantPublish(notificationFunction);

    // Create custom resource to trigger notification on stack deployment
    new cr.AwsCustomResource(this, 'DeploymentNotification', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: notificationFunction.functionName,
          InvocationType: 'Event',
        },
        physicalResourceId: cr.PhysicalResourceId.of('DeploymentNotification'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [notificationFunction.functionArn],
        }),
      ]),
    });
  }

  /**
   * Bootstrap admin user in Cognito and DynamoDB
   * Creates the initial root admin user from config.bootstrap settings
   */
  private bootstrapAdminUser(): void {
    const bootstrap = this.config.bootstrap!;

    const bootstrapFn = new lambda.Function(this, 'BootstrapAdminFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand, AdminUpdateUserAttributesCommand } = require('@aws-sdk/client-cognito-identity-provider');
        const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
        const { marshall } = require('@aws-sdk/util-dynamodb');
        const crypto = require('crypto');

        exports.handler = async (event) => {
          console.log('Bootstrap event:', JSON.stringify(event, null, 2));
          const requestType = event.RequestType || event.requestType;
          
          if (requestType === 'Delete') {
            return { PhysicalResourceId: 'bootstrap-admin-user', Data: { Message: 'Skipping delete' } };
          }

          const userPoolId = process.env.USER_POOL_ID;
          const usersTable = process.env.USERS_TABLE;
          const adminEmail = process.env.ADMIN_EMAIL;
          const adminPassword = process.env.ADMIN_PASSWORD;

          const cognito = new CognitoIdentityProviderClient({});
          const dynamodb = new DynamoDBClient({});

          try {
            // Create user in Cognito with a temp password, then set permanent password
            const createResult = await cognito.send(new AdminCreateUserCommand({
              UserPoolId: userPoolId,
              Username: adminEmail,
              UserAttributes: [
                { Name: 'email', Value: adminEmail },
                { Name: 'email_verified', Value: 'true' },
                { Name: 'custom:access_type', Value: 'ADMIN' }
              ],
              MessageAction: 'SUPPRESS'
            }));

            const cognitoSub = createResult.User?.Username;
            console.log('Cognito user created:', cognitoSub);

            // Set permanent password so user doesn't need to change on first login
            await cognito.send(new AdminSetUserPasswordCommand({
              UserPoolId: userPoolId,
              Username: adminEmail,
              Password: adminPassword,
              Permanent: true
            }));
            console.log('Permanent password set');

            // Generate username for DynamoDB
            const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
            const randomBytes = crypto.randomBytes(16);
            let username = '';
            for (let i = 0; i < 16; i++) {
              username += alphabet[randomBytes[i] % alphabet.length];
            }

            // Create user in DynamoDB
            const now = Date.now();
            const user = {
              username,
              email: adminEmail,
              display_name: 'Root',
              access_type: 'ADMIN',
              ssh_keys: [],
              disabled: false,
              is_root: true,
              created_at: now,
              storage_used: 0,
              file_count: 0,
              cognito_sub: cognitoSub
            };

            await dynamodb.send(new PutItemCommand({
              TableName: usersTable,
              Item: marshall(user)
            }));
            console.log('DynamoDB user created:', username);

            return {
              PhysicalResourceId: 'bootstrap-admin-user',
              Data: { AdminEmail: adminEmail, Username: username, Message: 'Admin user created successfully' }
            };
          } catch (error) {
            // If user already exists, that's fine (idempotent on re-deploy)
            if (error.name === 'UsernameExistsException') {
              console.log('Admin user already exists, skipping');
              return {
                PhysicalResourceId: 'bootstrap-admin-user',
                Data: { AdminEmail: adminEmail, Message: 'Admin user already exists' }
              };
            }
            console.error('Bootstrap error:', error);
            throw error;
          }
        };
      `),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        USER_POOL_ID: this.userPool.userPoolId,
        USERS_TABLE: this.usersTable.tableName,
        ADMIN_EMAIL: bootstrap.adminEmail,
        ADMIN_PASSWORD: bootstrap.adminPassword,
      },
      description: 'Bootstrap admin user creation'
    });

    // Grant permissions
    this.usersTable.grantWriteData(bootstrapFn);
    bootstrapFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminSetUserPassword',
        'cognito-idp:AdminUpdateUserAttributes',
      ],
      resources: [this.userPool.userPoolArn],
    }));

    // Trigger on stack create/update
    new cr.AwsCustomResource(this, 'BootstrapAdminResource', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: bootstrapFn.functionName,
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({
            RequestType: 'Create',
            ResourceProperties: {}
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of('bootstrap-admin-user'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [bootstrapFn.functionArn],
        }),
      ]),
    });
  }

  /**
   * Create CloudFormation outputs
   */
  private createOutputs(): void {
    new cdk.CfnOutput(this, 'FilesBucketName', {
      value: this.filesBucket.bucketName,
      description: 'S3 bucket for file storage',
      exportName: `${this.config.projectName}-files-bucket`
    });

    new cdk.CfnOutput(this, 'UsersTableName', {
      value: this.usersTable.tableName,
      description: 'DynamoDB table for user data',
      exportName: `${this.config.projectName}-users-table`
    });

    new cdk.CfnOutput(this, 'SettingsTableName', {
      value: this.settingsTable.tableName,
      description: 'DynamoDB table for application settings',
      exportName: `${this.config.projectName}-settings-table`
    });

    if (this.config.sftp.enabled) {
      new cdk.CfnOutput(this, 'TransferUserRoleArn', {
        value: this.transferUserRole!.roleArn,
        description: 'IAM role ARN for Transfer Family users',
        exportName: `${this.config.projectName}-transfer-user-role-arn`
      });

      new cdk.CfnOutput(this, 'TransferServerEndpoint', {
        value: `${this.transferServer!.attrServerId}.server.transfer.${cdk.Aws.REGION}.amazonaws.com`,
        description: 'Transfer Family server endpoint for SFTP/FTPS connections',
        exportName: `${this.config.projectName}-transfer-server-endpoint`
      });

      new cdk.CfnOutput(this, 'TransferServerId', {
        value: this.transferServer!.attrServerId,
        description: 'Transfer Family server ID',
        exportName: `${this.config.projectName}-transfer-server-id`
      });
    }

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID for web authentication',
      exportName: `${this.config.projectName}-user-pool-id`
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
      exportName: `${this.config.projectName}-user-pool-client-id`
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: this.api.url,
      description: 'API Gateway endpoint URL',
      exportName: `${this.config.projectName}-api-endpoint`
    });

    if (this.notificationTopic) {
      new cdk.CfnOutput(this, 'NotificationTopicArn', {
        value: this.notificationTopic.topicArn,
        description: 'SNS topic ARN for notifications',
        exportName: `${this.config.projectName}-notification-topic-arn`
      });
    }

    if (this.config.bootstrap) {
      new cdk.CfnOutput(this, 'BootstrapAdminEmail', {
        value: this.config.bootstrap.adminEmail,
        description: 'Bootstrap admin user email',
      });
    }
  }

  // Getters for resources (used by other constructs)
  public getFilesBucket(): s3.Bucket {
    return this.filesBucket;
  }

  public getUsersTable(): dynamodb.Table {
    return this.usersTable;
  }

  public getTransferUserRole(): iam.Role | undefined {
    return this.transferUserRole;
  }
}
