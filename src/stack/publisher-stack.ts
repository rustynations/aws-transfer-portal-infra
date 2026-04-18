import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface PublisherStackProps extends cdk.StackProps {
  bucket: s3.IBucket;
  distribution: cloudfront.IDistribution;
  connectionArn: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch?: string;
  /** Environment variables to inject into the build (e.g. VITE_API_ENDPOINT) */
  buildEnvVars?: Record<string, string>;
}

export class PublisherStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PublisherStackProps) {
    super(scope, id, props);

    const branch = props.githubBranch || 'master';

    // Build environment variables — merge defaults with provided vars
    const envVars: Record<string, codebuild.BuildEnvironmentVariable> = {};
    if (props.buildEnvVars) {
      for (const [key, value] of Object.entries(props.buildEnvVars)) {
        envVars[key] = { value };
      }
    }

    // CodeBuild project — builds, syncs to S3, and invalidates CloudFront
    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: 'transfer-portal-frontend-build',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      environmentVariables: envVars,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: ['npm ci'],
          },
          build: {
            commands: ['npm run build'],
          },
          post_build: {
            commands: [
              `aws s3 sync dist/ s3://${props.bucket.bucketName}/ --delete`,
              `aws cloudfront create-invalidation --distribution-id ${props.distribution.distributionId} --paths "/*"`,
            ],
          },
        },
        artifacts: {
          files: ['**/*'],
          'base-directory': 'dist',
        },
      }),
    });

    // Grant permissions
    props.bucket.grantReadWrite(buildProject);
    buildProject.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation'],
      resources: [`arn:aws:cloudfront::${this.account}:distribution/${props.distribution.distributionId}`],
    }));

    // Pipeline artifacts
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const buildOutput = new codepipeline.Artifact('BuildOutput');

    // Two-stage pipeline: Source → Build (which also deploys)
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'transfer-portal-frontend-pipeline',
      restartExecutionOnUpdate: true,
      crossAccountKeys: false,
    });

    pipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.CodeStarConnectionsSourceAction({
          actionName: 'GitHub_Source',
          owner: props.githubOwner,
          repo: props.githubRepo,
          branch,
          output: sourceOutput,
          connectionArn: props.connectionArn,
        }),
      ],
    });

    pipeline.addStage({
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Build_and_Deploy',
          project: buildProject,
          input: sourceOutput,
          outputs: [buildOutput],
        }),
      ],
    });

    new cdk.CfnOutput(this, 'PipelineName', {
      value: pipeline.pipelineName,
      description: 'CI/CD pipeline name',
    });
  }
}
