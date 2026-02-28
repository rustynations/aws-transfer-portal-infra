#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TransferPortalStack } from '../stack/transfer-portal-stack';
import { CertificateStack } from '../stack/certificate-stack';
import { GitConnectorStack } from '../stack/git-connector-stack';
import { CloudFrontStack } from '../stack/cloudfront-stack';
import { PublisherStack } from '../stack/publisher-stack';
import { ConfigLoader } from '../config';

const app = new cdk.App();

// Load configuration
const configPath = app.node.tryGetContext('config') || 'config/config.yml';

let config;
try {
  config = ConfigLoader.load(configPath);
  const errors = ConfigLoader.validate(config);
  if (errors.length > 0) {
    console.error('❌ Configuration validation failed:');
    errors.forEach(error => console.error(`  - ${error.field}: ${error.message}`));
    process.exit(1);
  }
  console.log('✅ Configuration validated successfully');
} catch (error) {
  console.error('❌ Error loading configuration:', (error as Error).message);
  process.exit(1);
}

const { deployment } = config;
const accountId = deployment.accountId;
const region = deployment.region;
const domainName = deployment.domainName;
const githubOwner = deployment.github.owner;
const githubRepo = deployment.github.repo;
const githubBranch = deployment.github.branch || 'main';

// ─── Backend ──────────────────────────────────────────────────

const backendStack = new TransferPortalStack(app, 'TransferPortalBackendStack', config, {
  env: { account: accountId, region },
  description: 'Transfer Portal - Backend (Cognito, API Gateway, Lambdas, DynamoDB, S3)',
});

// ─── Frontend Hosting ─────────────────────────────────────────

// ACM Certificate (us-east-1) — manual DNS validation in rustynations account
const certStack = new CertificateStack(app, 'TransferPortalCertStack', {
  env: { account: accountId, region },
  description: `Transfer Portal - ACM Certificate for ${domainName}`,
  domainName: domainName!,
});

// Git connector (CodeStar connection for GitHub)
const gitConnectorStack = new GitConnectorStack(app, 'TransferPortalGitConnectorStack', {
  env: { account: accountId, region },
  description: 'Transfer Portal - GitHub CodeStar Connection',
});

// CloudFront + S3
const cloudFrontStack = new CloudFrontStack(app, 'TransferPortalCloudFrontStack', {
  env: { account: accountId, region },
  description: `Transfer Portal - S3 + CloudFront for ${domainName}`,
  certificate: certStack.certificate,
  domainName: domainName!,
});
cloudFrontStack.addDependency(certStack);

// CI/CD pipeline (Source → Build+Deploy)
const publisherStack = new PublisherStack(app, 'TransferPortalPublisherStack', {
  env: { account: accountId, region },
  description: 'Transfer Portal - CI/CD Pipeline',
  bucket: cloudFrontStack.bucket,
  distribution: cloudFrontStack.distribution,
  connectionArn: gitConnectorStack.connectionArn,
  githubOwner,
  githubRepo,
  githubBranch,
  buildEnvVars: {
    VITE_API_ENDPOINT: backendStack.apiEndpoint,
    VITE_USER_POOL_ID: backendStack.userPoolId,
    VITE_USER_POOL_CLIENT_ID: backendStack.userPoolClientId,
    VITE_AWS_REGION: region,
  },
});
publisherStack.addDependency(cloudFrontStack);
publisherStack.addDependency(gitConnectorStack);
publisherStack.addDependency(backendStack);

app.synth();
