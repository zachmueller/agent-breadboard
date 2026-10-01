// Agent Breadboard — AWS reference deployment ([12] §1, §9): RDS Postgres (recommended production default)
// + one reference server host running the container image. One deployment = one Breadboard ([00] §4.1).
import { readFileSync } from 'node:fs';
import { CfnOutput, Duration, RemovalPolicy, Stack, Validations, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export interface BreadboardStackProps extends StackProps {
  /** Short name of this Breadboard (one deployment = one Breadboard). */
  name: string;
  vpcId: string;
  /** Private subnets for RDS (>= 2 AZs). */
  dbSubnetIds: string[];
  serverSubnetId: string;
  /** Container image for the Breadboard server (push the Dockerfile build to ECR and reference it here). */
  serverImage: string;
  /**
   * Tool sandbox images (deploy/sandbox builds). The host pulls them and tags them `breadboard-sandbox-ts:local` /
   * `breadboard-sandbox-py:local`, the names `breadboard.yaml` uses by default. Without them, tools cannot run.
   */
  sandboxImageTs?: string;
  sandboxImagePy?: string;
  serverPublicIp?: boolean;
  /** CIDRs allowed to reach the server port. */
  allowedCidrs?: string[];
  serverPort?: number;
  serverInstanceType?: string;
  serverRootVolumeGb?: number;
  /** Externally reachable base URL (leave empty to use the instance IP). */
  publicUrl?: string;
  /** docker (recommended) or process. */
  sandboxRunner?: 'docker' | 'process';
  dbEngineVersion?: string;
  dbInstanceClass?: string;
  dbAllocatedStorageGb?: number;
  dbMaxAllocatedStorageGb?: number;
  dbMultiAz?: boolean;
  dbBackupRetentionDays?: number;
  dbDeletionProtection?: boolean;
  /** Use an S3 bucket for large blobs instead of the host filesystem. */
  enableS3Objects?: boolean;
}

export const DEFAULTS = {
  serverPublicIp: true,
  allowedCidrs: ['0.0.0.0/0'],
  serverPort: 4000,
  serverInstanceType: 't3.large',
  serverRootVolumeGb: 100,
  publicUrl: '',
  sandboxRunner: 'docker',
  sandboxImageTs: '',
  sandboxImagePy: '',
  dbEngineVersion: '16',
  dbInstanceClass: 'db.t4g.medium',
  dbAllocatedStorageGb: 50,
  dbMaxAllocatedStorageGb: 500,
  dbMultiAz: false,
  dbBackupRetentionDays: 14,
  dbDeletionProtection: true,
  enableS3Objects: true,
} satisfies Partial<BreadboardStackProps>;

/** Generated secrets carry no punctuation: they end up in a URL and an env file (parity with `special = false`). */
const PUNCTUATION = ' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

const USER_DATA = readFileSync(new URL('./user-data.sh', import.meta.url), 'utf8');

/** `<account>.dkr.ecr.<region>.amazonaws.com/<repo>[:tag|@digest]` → the repository ARN, or null for other registries. */
export function ecrRepositoryArn(image: string): string | null {
  const m = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([^:@]+)/.exec(image);
  return m ? `arn:aws:ecr:${m[2]}:${m[1]}:repository/${m[3]}` : null;
}

/**
 * Fill the bootstrap script's dollar-brace placeholders. Values may be CDK tokens; CDK turns the resulting string
 * into an Fn::Join. Throws at synth on a placeholder without a value instead of shipping a broken script.
 */
export function renderUserData(vars: Record<string, string>): string {
  return USER_DATA.replace(/\$\{(\w+)\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`user-data.sh placeholder \${${key}} has no value`);
    return vars[key];
  });
}

export class BreadboardStack extends Stack {
  constructor(scope: Construct, id: string, props: BreadboardStackProps) {
    super(scope, id, props);
    const p = { ...DEFAULTS, ...props };
    const prefix = `breadboard-${p.name}`;

    // --- Network --------------------------------------------------------------
    // Subnet IDs are resolved against the looked-up VPC so their AZ and public/private kind come from AWS.
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: p.vpcId });
    const pending = vpc.selectSubnets().isPendingLookup;
    const known = [...vpc.publicSubnets, ...vpc.privateSubnets, ...vpc.isolatedSubnets];
    const subnet = (subnetId: string, placeholder: ec2.ISubnet): ec2.ISubnet => {
      if (pending) return placeholder; // first synth pass; the CLI re-synths once the lookup has resolved
      const found = known.find((s) => s.subnetId === subnetId);
      if (!found) throw new Error(`subnet ${subnetId} is not in ${p.vpcId}`);
      return found;
    };
    const serverSubnet = subnet(p.serverSubnetId, p.serverPublicIp ? vpc.publicSubnets[0] : vpc.privateSubnets[0]);
    const dbSubnets = p.dbSubnetIds.map((id, i) => subnet(id, vpc.privateSubnets[i % vpc.privateSubnets.length]));

    const serverSg = new ec2.SecurityGroup(this, 'ServerSg', { vpc, description: 'Breadboard server host', allowAllOutbound: true });
    for (const cidr of p.allowedCidrs) {
      serverSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(p.serverPort), 'HTTP(S) to the Breadboard server');
    }
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', { vpc, description: 'Breadboard Postgres', allowAllOutbound: false });

    // --- RDS Postgres (the only required stateful dependency) ------------------
    // Explicit so it can be retained with the final snapshot (the generated default is deleted with the stack).
    const dbCredentials = new rds.DatabaseSecret(this, 'DbSecret', {
      username: 'breadboard',
      secretName: `${prefix}/db`,
      excludeCharacters: PUNCTUATION,
    });
    dbCredentials.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.of(p.dbEngineVersion, p.dbEngineVersion.split('.')[0]),
    });
    const db = new rds.DatabaseInstance(this, 'Db', {
      instanceIdentifier: `${prefix}-db`,
      engine,
      instanceType: new ec2.InstanceType(p.dbInstanceClass.replace(/^db\./, '')),
      vpc,
      vpcSubnets: { subnets: dbSubnets },
      securityGroups: [dbSg],
      port: 5432,
      parameterGroup: new rds.ParameterGroup(this, 'DbParams', { engine, parameters: { 'rds.force_ssl': '1' } }),
      databaseName: 'breadboard',
      credentials: rds.Credentials.fromSecret(dbCredentials),
      iamAuthentication: true,
      storageEncrypted: true,
      storageType: rds.StorageType.GP3,
      allocatedStorage: p.dbAllocatedStorageGb,
      maxAllocatedStorage: p.dbMaxAllocatedStorageGb,
      multiAz: p.dbMultiAz,
      backupRetention: Duration.days(p.dbBackupRetentionDays), // automated snapshots + PITR ([12] §1 backup/DR)
      deletionProtection: p.dbDeletionProtection,
      removalPolicy: RemovalPolicy.SNAPSHOT, // final snapshot on delete
      enablePerformanceInsights: true,
      publiclyAccessible: false,
    });
    dbSg.addIngressRule(serverSg, ec2.Port.tcp(5432), 'Postgres from the server host only');

    // --- Secrets ---------------------------------------------------------------
    // Generated inside Secrets Manager, so the values never appear in the template or on the deployer's machine.
    // All retained on delete: losing BROKER_MASTER_KEY makes every stored broker credential undecryptable.
    const generated = (id: string, suffix: string, description: string, passwordLength: number) =>
      new secretsmanager.Secret(this, id, {
        secretName: `${prefix}/${suffix}`,
        description,
        generateSecretString: { passwordLength, excludePunctuation: true, includeSpace: false },
        removalPolicy: RemovalPolicy.RETAIN,
      });
    const tokenKey = generated('TokenSigningKey', 'token-signing-key', 'TOKEN_SIGNING_KEY: HMAC key for user/actor tokens', 48);
    // 43 alphanumeric chars are valid base64 for exactly 32 bytes (~256 bits), which the broker uses directly
    // (packages/server/src/toolbox/broker.ts, deriveBrokerKey).
    const brokerKey = generated('BrokerMasterKey', 'broker-master-key', 'BROKER_MASTER_KEY: encrypts broker credentials at rest', 43);
    const dbSecret = db.secret!;

    // --- Object storage (optional S3-compatible) --------------------------------
    const bucket = p.enableS3Objects
      ? new s3.Bucket(this, 'Objects', {
          bucketName: `${prefix}-objects-${this.account}`,
          versioned: true,
          enforceSSL: true,
          encryption: s3.BucketEncryption.S3_MANAGED,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          removalPolicy: RemovalPolicy.RETAIN,
        })
      : undefined;

    // --- Server host (reference: one EC2 instance running the container) ----------
    const role = new iam.Role(this, 'ServerRole', { assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com') });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:Converse', 'bedrock:ConverseStream'],
        resources: ['*'],
      }),
    );
    role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], resources: ['*'] }));
    for (const secret of [dbSecret, tokenKey, brokerKey]) secret.grantRead(role);
    // Pull access to the ECR repositories the images live in (the bootstrap logs in to their registries).
    const repos = [...new Set([p.serverImage, p.sandboxImageTs, p.sandboxImagePy].map(ecrRepositoryArn).filter((a): a is string => a !== null))];
    if (repos.length) {
      role.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
      role.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'], resources: repos }));
    }
    db.grantConnect(role, 'breadboard');
    bucket?.grantRead(role);
    bucket?.grantPut(role);

    const server = new ec2.Instance(this, 'Server', {
      instanceName: `${prefix}-server`,
      vpc,
      vpcSubnets: { subnets: [serverSubnet] },
      instanceType: new ec2.InstanceType(p.serverInstanceType),
      // Pinned in cdk.context.json on first synth: a new AMI would replace the host, and the config repo lives on
      // its root volume (/var/breadboard).
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cachedInContext: true }),
      securityGroup: serverSg,
      role,
      ssmSessionPermissions: true,
      associatePublicIpAddress: p.serverPublicIp,
      // IMDSv2 only. Hop limit 2 lets the server container (one bridge hop away) reach the instance role for
      // Bedrock, S3, and RDS IAM auth. Set on the instance itself: `requireImdsv2` would add a launch template
      // with a fixed name that collides when two Breadboards share an account and region.
      httpTokens: ec2.HttpTokens.REQUIRED,
      httpPutResponseHopLimit: 2,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(p.serverRootVolumeGb, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }),
        },
      ],
      userData: ec2.UserData.custom(
        renderUserData({
          image: p.serverImage,
          sandbox_image_ts: p.sandboxImageTs,
          sandbox_image_py: p.sandboxImagePy,
          region: this.region,
          db_secret_arn: dbSecret.secretArn,
          db_host: db.dbInstanceEndpointAddress,
          db_port: db.dbInstanceEndpointPort,
          db_name: 'breadboard',
          token_secret_arn: tokenKey.secretArn,
          broker_secret_arn: brokerKey.secretArn,
          // CloudFormation cannot reference the instance's own IP inside its user data either; the bootstrap
          // script resolves this placeholder at runtime via IMDS when `publicUrl` is left empty.
          public_url: p.publicUrl || `http://__IMDS__:${p.serverPort}`,
          server_port: String(p.serverPort),
          object_store: bucket ? 's3' : 'fs',
          s3_bucket: bucket?.bucketName ?? '',
          sandbox_runner: p.sandboxRunner,
          model_provider: 'bedrock',
        }),
      ),
    });

    // The resolved AMI id is pinned on purpose (above), so CloudFormation's portability lint does not apply.
    Validations.of(server).acknowledge({ id: 'CloudFormation-Validate::W9010', reason: 'AMI pinned in cdk.context.json so a new AMI never replaces the host' });

    // --- Outputs ---------------------------------------------------------------
    // PublicIp only exists on instances that have one; fall back to the private IP otherwise.
    const serverIp = p.serverPublicIp ? server.instancePublicIp : server.instancePrivateIp;
    new CfnOutput(this, 'ServerIp', { value: serverIp });
    new CfnOutput(this, 'ServerUrl', { value: p.publicUrl || `http://${serverIp}:${p.serverPort}` });
    new CfnOutput(this, 'RdsEndpoint', { value: db.dbInstanceEndpointAddress });
    new CfnOutput(this, 'DbSecretArn', { description: 'RDS-generated credentials (username, password).', value: dbSecret.secretArn });
    new CfnOutput(this, 'TokenSigningKeySecretArn', { value: tokenKey.secretArn });
    new CfnOutput(this, 'BrokerMasterKeySecretArn', { value: brokerKey.secretArn });
    if (bucket) new CfnOutput(this, 'ObjectsBucket', { value: bucket.bucketName });
  }
}
