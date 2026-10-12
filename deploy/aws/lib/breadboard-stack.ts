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
  /**
   * Externally reachable base URL, `scheme://host[:port]` (leave empty to use the instance IP). Lives in the deployment
   * metadata, not the user data, so changing it recreates the container in place instead of replacing the host.
   */
  publicUrl?: string;
  /** docker (recommended) or process. */
  sandboxRunner?: 'docker' | 'process';
  /**
   * Accept the generated break-glass token (`breadboard-<name>/admin-token`) as the `bootstrap-admin` sign-in. Set false
   * once another admin can sign in (real local tokens or OIDC); the server logs an error at startup if none can. The
   * secret is kept either way, so turning it back on is one deploy. Applied in place, like `publicUrl`.
   */
  bootstrapAdmin?: boolean;
  /**
   * Trusted proxy ([12] §3): the handle that every request arriving through an authenticating proxy signs in as (created
   * as an admin on first use). Generates the shared secret the proxy must send in `TRUSTED_PROXY_HEADER` (outputs
   * `TrustedProxySecretArn`, `TrustedProxyHeader`). Only for a proxy whose audience is that one person: the server
   * cannot tell the proxy's users apart. Applied in place, like `publicUrl`.
   */
  trustedProxyUser?: string;
  /**
   * IAM roles the server may assume for `aws-role` broker credentials ([12] §5): a tool's AWS calls are then signed
   * as that role, never with keys stored in Breadboard. Each role's trust policy must also name `ServerRoleArn`.
   */
  brokerRoleArns?: string[];
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
  bootstrapAdmin: true,
  trustedProxyUser: '',
  brokerRoleArns: [] as string[],
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

/**
 * State that outlives the stack: kept on update and delete, but removed when the initial create rolls back, so a
 * failed first deploy leaves nothing behind that would block a retry under the same `name`.
 */
const KEEP = RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE;

const USER_DATA = readFileSync(new URL('./user-data.sh', import.meta.url), 'utf8');
const APPLY_SCRIPT = readFileSync(new URL('./breadboard-apply.sh', import.meta.url), 'utf8');

/** cfn-hup as a systemd service (the AL2023 package may not ship a unit; this one takes precedence if it does). */
const CFN_HUP_UNIT = `[Unit]
Description=cfn-hup: apply CloudFormation::Init metadata changes
After=network-online.target

[Service]
Type=simple
ExecStart=/opt/aws/bin/cfn-hup
Restart=always

[Install]
WantedBy=multi-user.target
`;

/** A container image reference (`[registry[:port]/]path[:tag][@sha256:digest]`, lowercase path components). */
const IMAGE_REF = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::\d+)?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

/** `scheme://host[:port]`, nothing else: the value is written into a file that the host's bash sources. */
const PUBLIC_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

export function assertPublicUrl(url: string): void {
  if (url && !PUBLIC_URL.test(url)) throw new Error(`publicUrl must be scheme://host[:port] with no path, got ${url}`);
}

/** The server's default trusted-proxy header (packages/server/src/core/env.ts, BREADBOARD_TRUSTED_PROXY_HEADER). */
export const TRUSTED_PROXY_HEADER = 'x-breadboard-proxy-auth';
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertTrustedProxyUser(handle: string): void {
  if (handle && !HANDLE.test(handle)) throw new Error(`trustedProxyUser must be a user handle (letters, digits, . _ -), got ${handle}`);
}

const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;

export function assertBrokerRoleArns(arns: string[]): void {
  for (const arn of arns) if (!ROLE_ARN.test(arn)) throw new Error(`brokerRoleArns must be IAM role ARNs, got ${arn}`);
}

/** Fail at synth on a malformed image: the host would otherwise boot, fail its one-time bootstrap, and serve nothing. */
export function assertImageRef(key: string, image: string): void {
  if (!IMAGE_REF.test(image)) throw new Error(`${key} is not a valid image reference: ${image}`);
}

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
    assertImageRef('serverImage', p.serverImage);
    if (p.sandboxImageTs) assertImageRef('sandboxImageTs', p.sandboxImageTs);
    if (p.sandboxImagePy) assertImageRef('sandboxImagePy', p.sandboxImagePy);
    assertPublicUrl(p.publicUrl);
    assertTrustedProxyUser(p.trustedProxyUser);
    assertBrokerRoleArns(p.brokerRoleArns);

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
    // No punctuation: the password ends up in a URL and an env file. (Excluding every punctuation character through
    // rds.DatabaseSecret's excludeCharacters fails at deploy: Secrets Manager still requires one of each type.)
    const dbCredentials = new secretsmanager.Secret(this, 'DbSecret', {
      secretName: `${prefix}/db`,
      description: 'RDS master credentials (username, password)',
      generateSecretString: { secretStringTemplate: JSON.stringify({ username: 'breadboard' }), generateStringKey: 'password', passwordLength: 30, excludePunctuation: true, includeSpace: false },
      removalPolicy: KEEP,
    });
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
        removalPolicy: KEEP,
      });
    const tokenKey = generated('TokenSigningKey', 'token-signing-key', 'TOKEN_SIGNING_KEY: HMAC key for user/actor tokens', 48);
    // 43 alphanumeric chars are valid base64 for exactly 32 bytes (~256 bits), which the broker uses directly
    // (packages/server/src/toolbox/broker.ts, deriveBrokerKey).
    const brokerKey = generated('BrokerMasterKey', 'broker-master-key', 'BROKER_MASTER_KEY: encrypts broker credentials at rest', 43);
    // Production refuses the seed's well-known local tokens; this is how the operator signs in to configure OIDC.
    const adminToken = generated('BootstrapAdminToken', 'admin-token', 'BREADBOARD_BOOTSTRAP_ADMIN_TOKEN: break-glass admin sign-in', 48);
    const dbSecret = db.secret!;
    // The trusted proxy's shared secret. No fixed name and not retained: it holds no state, and a fixed name would stay
    // reserved for the deletion window if the proxy were turned off and on again. The proxy reads it by ARN.
    const proxySecret = p.trustedProxyUser
      ? new secretsmanager.Secret(this, 'TrustedProxySecret', {
          description: `Shared secret an authenticating proxy sends in ${TRUSTED_PROXY_HEADER}; requests carrying it sign in as ${p.trustedProxyUser}`,
          generateSecretString: { passwordLength: 48, excludePunctuation: true, includeSpace: false },
          removalPolicy: RemovalPolicy.DESTROY,
        })
      : undefined;

    // --- Object storage (optional S3-compatible) --------------------------------
    const bucket = p.enableS3Objects
      ? new s3.Bucket(this, 'Objects', {
          bucketName: `${prefix}-objects-${this.account}`,
          versioned: true,
          enforceSSL: true,
          encryption: s3.BucketEncryption.S3_MANAGED,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          removalPolicy: KEEP,
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
    for (const secret of [dbSecret, tokenKey, brokerKey, adminToken]) secret.grantRead(role);
    proxySecret?.grantRead(role); // read by breadboard-apply, not the one-time user data
    // Pull access to the ECR repositories the images live in (the bootstrap logs in to their registries).
    const repos = [...new Set([p.serverImage, p.sandboxImageTs, p.sandboxImagePy].map(ecrRepositoryArn).filter((a): a is string => a !== null))];
    if (repos.length) {
      role.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
      role.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'], resources: repos }));
    }
    if (p.brokerRoleArns.length) role.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: p.brokerRoleArns }));
    db.grantConnect(role, 'breadboard');
    bucket?.grantRead(role);
    bucket?.grantPut(role);

    // One-time host setup; CloudFormation::Init (below) appends cfn-init and the creation signal.
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      renderUserData({
        region: this.region,
        db_secret_arn: dbSecret.secretArn,
        db_host: db.dbInstanceEndpointAddress,
        db_port: db.dbInstanceEndpointPort,
        db_name: 'breadboard',
        token_secret_arn: tokenKey.secretArn,
        broker_secret_arn: brokerKey.secretArn,
        admin_secret_arn: adminToken.secretArn,
        // Always the IMDS placeholder, resolved at boot to the instance's IP. A configured `publicUrl` is applied
        // through the deployment metadata instead (deploy.env, below), so changing it never touches the user data:
        // user data is immutable, and a change would replace the host and its config repo.
        public_url: `http://__IMDS__:${p.serverPort}`,
        server_port: String(p.serverPort),
        object_store: bucket ? 's3' : 'fs',
        s3_bucket: bucket?.bucketName ?? '',
        sandbox_runner: p.sandboxRunner,
        model_provider: 'bedrock',
      }),
    );

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
      userData,
    });

    // --- Deployed images: CloudFormation::Init + cfn-hup ---------------------------
    // The images live in instance metadata, not in user data (which runs once per instance): cfn-init applies them on
    // first boot, and cfn-hup re-applies them in place when a deploy changes the metadata. No fingerprint in the user
    // data, so an image change neither restarts nor replaces the host (the config repo lives on its root volume).
    const serverId = this.getLogicalId(server.instance);
    // PUBLIC_URL (when set), BOOTSTRAP_ADMIN=false and the trusted proxy override the boot-time /etc/breadboard.env:
    // breadboard-apply writes them to a root-only overrides env file (fetching the proxy secret by ARN), so they
    // change in place like the images and no secret value enters the template.
    const deployEnv = [
      `SERVER_IMAGE=${p.serverImage}`,
      `SANDBOX_IMAGE_TS=${p.sandboxImageTs}`,
      `SANDBOX_IMAGE_PY=${p.sandboxImagePy}`,
      `SERVER_PORT=${p.serverPort}`,
      `PUBLIC_URL=${p.publicUrl}`,
      `BOOTSTRAP_ADMIN=${p.bootstrapAdmin}`,
      `TRUSTED_PROXY_USER=${p.trustedProxyUser}`,
      `TRUSTED_PROXY_SECRET_ARN=${proxySecret?.secretArn ?? ''}`,
      '',
    ].join('\n');
    server.applyCloudFormationInit(
      ec2.CloudFormationInit.fromElements(
        ec2.InitFile.fromString('/etc/breadboard/deploy.env', deployEnv, { mode: '000644' }),
        ec2.InitFile.fromString('/usr/local/bin/breadboard-apply', APPLY_SCRIPT, { mode: '000755' }),
        ec2.InitFile.fromString('/etc/cfn/cfn-hup.conf', `[main]\nstack=${this.stackId}\nregion=${this.region}\ninterval=1\n`, { mode: '000400' }),
        // Re-running cfn-init rewrites the files above and runs the commands below again; breadboard-apply is a no-op
        // when the deployment is unchanged.
        ec2.InitFile.fromString(
          '/etc/cfn/hooks.d/breadboard.conf',
          `[breadboard]\ntriggers=post.update\npath=Resources.${serverId}.Metadata.AWS::CloudFormation::Init\naction=/opt/aws/bin/cfn-init -v --stack ${this.stackName} --resource ${serverId} --region ${this.region}\nrunas=root\n`,
          { mode: '000400' },
        ),
        ec2.InitFile.fromString('/etc/systemd/system/cfn-hup.service', CFN_HUP_UNIT, { mode: '000644' }),
        ec2.InitCommand.shellCommand('/usr/local/bin/breadboard-apply', { key: '10-apply' }),
        ec2.InitCommand.shellCommand('systemctl daemon-reload && systemctl enable --now cfn-hup', { key: '20-cfn-hup' }),
      ),
      // A failed bootstrap fails the deploy instead of leaving a host that serves nothing.
      { timeout: Duration.minutes(20), embedFingerprint: false },
    );

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
    new CfnOutput(this, 'AdminTokenSecretArn', { description: 'BREADBOARD_BOOTSTRAP_ADMIN_TOKEN: sign in as bootstrap-admin to configure OIDC.', value: adminToken.secretArn });
    if (bucket) new CfnOutput(this, 'ObjectsBucket', { value: bucket.bucketName });
    // For add-ons that front the server (e.g. a CloudFront VPC origin to the instance). Plain outputs, not exports, so
    // the base stack never becomes undeletable because something imports them.
    new CfnOutput(this, 'ServerInstanceId', { value: server.instanceId });
    new CfnOutput(this, 'ServerSecurityGroupId', { value: serverSg.securityGroupId });
    new CfnOutput(this, 'ServerPrivateDnsName', { value: server.instancePrivateDnsName });
    new CfnOutput(this, 'ServerPort', { value: String(p.serverPort) });
    new CfnOutput(this, 'VpcId', { value: p.vpcId });
    new CfnOutput(this, 'ServerSubnetId', { value: p.serverSubnetId });
    new CfnOutput(this, 'ServerRoleArn', { value: role.roleArn, description: 'The instance role: trust it from roles listed in brokerRoleArns' });
    if (proxySecret) {
      new CfnOutput(this, 'TrustedProxySecretArn', { value: proxySecret.secretArn, description: `The proxy sends this secret's value in ${TRUSTED_PROXY_HEADER}` });
      new CfnOutput(this, 'TrustedProxyHeader', { value: TRUSTED_PROXY_HEADER });
      new CfnOutput(this, 'TrustedProxyUser', { value: p.trustedProxyUser });
    }
  }
}
