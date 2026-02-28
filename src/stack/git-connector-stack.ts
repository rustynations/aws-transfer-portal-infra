import * as cdk from 'aws-cdk-lib';
import * as codestarconnections from 'aws-cdk-lib/aws-codestarconnections';
import { Construct } from 'constructs';

export class GitConnectorStack extends cdk.Stack {
  public readonly connectionArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const connection = new codestarconnections.CfnConnection(this, 'GitHubConnection', {
      connectionName: 'transfer-portal-github',
      providerType: 'GitHub',
    });

    this.connectionArn = connection.attrConnectionArn;

    new cdk.CfnOutput(this, 'ConnectionArn', {
      value: connection.attrConnectionArn,
      description: 'CodeStar Connection ARN for GitHub',
    });

    new cdk.CfnOutput(this, 'AuthorizeUrl', {
      value: `https://console.aws.amazon.com/codesuite/settings/connections?region=${this.region}`,
      description: 'Authorize the connection at this URL',
    });
  }
}
