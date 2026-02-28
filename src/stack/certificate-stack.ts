import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

interface CertificateStackProps extends cdk.StackProps {
  /** Primary domain name for the certificate */
  domainName: string;
}

/**
 * ACM Certificate for CloudFront.
 * DNS validation CNAME must be added manually to the hosted zone
 * in the rustynations account since it's cross-account.
 */
export class CertificateStack extends cdk.Stack {
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    super(scope, id, props);

    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(),
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
      description: 'ACM certificate ARN',
    });

    // Output instructions for manual DNS validation
    new cdk.CfnOutput(this, 'ValidationInstructions', {
      value: `Check ACM console for DNS validation CNAME record. Add it to the rustynations.com hosted zone in account 742873382975.`,
      description: 'Manual DNS validation steps',
    });
  }
}
