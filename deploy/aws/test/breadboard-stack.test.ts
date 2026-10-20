import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { BreadboardStack, assertImageRef, ecrRepositoryArn, renderUserData, type BreadboardStackProps } from '../lib/breadboard-stack.js';

const VPC_ID = 'vpc-0a1b2c3d4e5f60718';
const PUBLIC_A = 'subnet-0aaaaaaaaaaaaaaa1';
const PUBLIC_B = 'subnet-0aaaaaaaaaaaaaaa2';
const PRIVATE_A = 'subnet-0bbbbbbbbbbbbbbb1';
const PRIVATE_B = 'subnet-0bbbbbbbbbbbbbbb2';
const AMI = 'ami-0123456789abcdef0';
const IMAGE = '123456789012.dkr.ecr.us-east-1.amazonaws.com/agent-breadboard:v0.1';

const base: BreadboardStackProps = {
  env: { account: '123456789012', region: 'us-east-1' },
  name: 'test',
  vpcId: VPC_ID,
  dbSubnetIds: [PRIVATE_A, PRIVATE_B],
  serverSubnetId: PUBLIC_A,
  serverImage: IMAGE,
};

const subnet = (subnetId: string, availabilityZone: string, cidr: string) => ({ subnetId, availabilityZone, cidr, routeTableId: 'rtb-0cccccccccccccccc' });
/** What the CLI's VPC lookup returns for a VPC with two public and two private subnets. */
const LOOKED_UP_VPC = {
  vpcId: VPC_ID,
  vpcCidrBlock: '10.0.0.0/16',
  availabilityZones: [],
  subnetGroups: [
    { name: 'Public', type: 'Public', subnets: [subnet(PUBLIC_A, 'us-east-1a', '10.0.0.0/24'), subnet(PUBLIC_B, 'us-east-1b', '10.0.1.0/24')] },
    { name: 'Private', type: 'Private', subnets: [subnet(PRIVATE_A, 'us-east-1a', '10.0.2.0/24'), subnet(PRIVATE_B, 'us-east-1b', '10.0.3.0/24')] },
  ],
};

/** Answers for the stack's context lookups, keyed by provider. */
function lookupAnswer(provider: string, ami: string): unknown {
  if (provider === 'vpc-provider') return LOOKED_UP_VPC;
  if (provider === 'ssm') return ami; // latestAmazonLinux2023({ cachedInContext: true })
  throw new Error(`unexpected context lookup: ${provider}`);
}

/**
 * Synth the way the CLI does: a first pass on placeholder lookups records what is missing, then a second pass with
 * those lookups answered. The second pass treats CloudFormation schema findings as errors.
 */
function synth(overrides: Partial<BreadboardStackProps> = {}, ami = AMI): Template {
  const props = { ...base, ...overrides };
  const probe = new App();
  new BreadboardStack(probe, 'Probe', props);
  const missing = probe.synth().manifest.missing ?? [];
  const context = Object.fromEntries(missing.map((m) => [m.key, lookupAnswer(m.provider, ami)]));
  const app = new App({ context: { ...context, '@aws-cdk/core:validateAgainstDefaultRules': true } });
  return Template.fromStack(new BreadboardStack(app, 'Test', props));
}

function statements(t: Template): { Action: string | string[]; Resource: unknown }[] {
  return Object.values(t.findResources('AWS::IAM::Policy')).flatMap((r) => r.Properties.PolicyDocument.Statement);
}
const actions = (t: Template) => statements(t).flatMap((s) => [s.Action].flat());

/** The literal pieces and token references that make up the instance's user data. */
function userData(t: Template): { text: string; refs: string[] } {
  const instance = Object.values(t.findResources('AWS::EC2::Instance'))[0];
  const ud = instance.Properties.UserData['Fn::Base64'];
  const parts: unknown[] = typeof ud === 'string' ? [ud] : ud['Fn::Join'][1];
  return {
    text: parts.filter((x) => typeof x === 'string').join('\u0000'),
    refs: parts.filter((x) => typeof x !== 'string').map((x) => JSON.stringify(x)),
  };
}

/** CloudFormation::Init files on the server instance: path → content (token parts dropped). */
function initFiles(t: Template): Record<string, string> {
  return Object.fromEntries(Object.entries(rawInitFiles(t)).map(([path, c]) => [path, typeof c === 'string' ? c : ((c as any)['Fn::Join'][1] as unknown[]).filter((x) => typeof x === 'string').join('')]));
}

/** The token references (Ref, Fn::GetAtt) in one CloudFormation::Init file. */
function initRefs(t: Template, path: string): string[] {
  const c = rawInitFiles(t)[path];
  return typeof c === 'string' ? [] : ((c as any)['Fn::Join'][1] as unknown[]).filter((x) => typeof x !== 'string').map((x) => JSON.stringify(x));
}

function rawInitFiles(t: Template): Record<string, unknown> {
  const instance = Object.values(t.findResources('AWS::EC2::Instance'))[0];
  const files = instance.Metadata['AWS::CloudFormation::Init'].config.files as Record<string, { content: unknown }>;
  return Object.fromEntries(Object.entries(files).map(([path, f]) => [path, f.content]));
}

const instanceUserData = (x: Template) => JSON.stringify(Object.values(x.findResources('AWS::EC2::Instance'))[0].Properties.UserData);

function logicalId(t: Template, type: string, props: Record<string, unknown>): string {
  const ids = Object.keys(t.findResources(type, { Properties: props }));
  expect(ids).toHaveLength(1);
  return ids[0];
}

describe('BreadboardStack', () => {
  const t = synth();

  it('provisions private, encrypted RDS Postgres 16 with IAM auth and forced SSL', () => {
    t.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceIdentifier: 'breadboard-test-db',
      Engine: 'postgres',
      EngineVersion: '16',
      DBInstanceClass: 'db.t4g.medium',
      DBName: 'breadboard',
      StorageEncrypted: true,
      StorageType: 'gp3',
      AllocatedStorage: '50',
      MaxAllocatedStorage: 500,
      EnableIAMDatabaseAuthentication: true,
      PubliclyAccessible: false,
      DeletionProtection: true,
      MultiAZ: false,
      BackupRetentionPeriod: 14,
      EnablePerformanceInsights: true,
    });
    t.hasResource('AWS::RDS::DBInstance', { DeletionPolicy: 'Snapshot', UpdateReplacePolicy: 'Snapshot' });
    t.hasResourceProperties('AWS::RDS::DBParameterGroup', { Family: 'postgres16', Parameters: { 'rds.force_ssl': '1' } });
    t.hasResourceProperties('AWS::RDS::DBSubnetGroup', { SubnetIds: [PRIVATE_A, PRIVATE_B] });
  });

  it('opens the server port to allowed CIDRs and Postgres to the server only', () => {
    t.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Breadboard server host',
      VpcId: VPC_ID,
      SecurityGroupIngress: [Match.objectLike({ CidrIp: '0.0.0.0/0', IpProtocol: 'tcp', FromPort: 4000, ToPort: 4000 })],
    });
    const serverSg = logicalId(t, 'AWS::EC2::SecurityGroup', { GroupDescription: 'Breadboard server host' });
    const dbSg = logicalId(t, 'AWS::EC2::SecurityGroup', { GroupDescription: 'Breadboard Postgres' });
    // No inbound rules on the DB group except the one below, and no outbound (CDK's "disallow all" placeholder).
    t.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Breadboard Postgres',
      SecurityGroupIngress: Match.absent(),
      SecurityGroupEgress: [Match.objectLike({ CidrIp: '255.255.255.255/32', Description: 'Disallow all traffic' })],
    });
    t.resourceCountIs('AWS::EC2::SecurityGroupIngress', 1);
    t.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      GroupId: { 'Fn::GetAtt': [dbSg, 'GroupId'] },
      SourceSecurityGroupId: { 'Fn::GetAtt': [serverSg, 'GroupId'] },
    });
  });

  it('honours custom CIDRs and port', () => {
    const custom = synth({ allowedCidrs: ['10.0.0.0/8', '192.168.0.0/16'], serverPort: 8443 });
    custom.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Breadboard server host',
      SecurityGroupIngress: [
        Match.objectLike({ CidrIp: '10.0.0.0/8', FromPort: 8443, ToPort: 8443 }),
        Match.objectLike({ CidrIp: '192.168.0.0/16', FromPort: 8443, ToPort: 8443 }),
      ],
    });
    expect(userData(custom).text).toContain('PORT=8443');
  });

  it('grants ECR pull on the image repositories and pulls and tags the sandbox images', () => {
    const ts = '123456789012.dkr.ecr.us-east-1.amazonaws.com/agent-breadboard:sandbox-ts-1';
    const py = '123456789012.dkr.ecr.us-east-1.amazonaws.com/sandboxes:py-1';
    const withSandboxes = synth({ sandboxImageTs: ts, sandboxImagePy: py });
    const pulls = statements(withSandboxes).filter((s) => [s.Action].flat().includes('ecr:BatchGetImage'));
    expect(pulls).toHaveLength(1);
    expect([pulls[0]!.Resource].flat().sort()).toEqual(['arn:aws:ecr:us-east-1:123456789012:repository/agent-breadboard', 'arn:aws:ecr:us-east-1:123456789012:repository/sandboxes']);
    expect(statements(withSandboxes)).toContainEqual(expect.objectContaining({ Action: 'ecr:GetAuthorizationToken', Resource: '*' }));
    const files = initFiles(withSandboxes);
    expect(files['/usr/local/bin/breadboard-apply']).toContain('aws ecr get-login-password');
    expect(files['/usr/local/bin/breadboard-apply']).toContain('docker tag "$SANDBOX_IMAGE_TS" breadboard-sandbox-ts:local');
    expect(files['/usr/local/bin/breadboard-apply']).toContain('docker tag "$SANDBOX_IMAGE_PY" breadboard-sandbox-py:local');
    expect(files['/etc/breadboard/deploy.env']).toContain(`SANDBOX_IMAGE_TS=${ts}\nSANDBOX_IMAGE_PY=${py}\n`);
    // A non-ECR image needs no ECR grant.
    const hub = synth({ serverImage: 'ghcr.io/example/agent-breadboard:v1' });
    expect(statements(hub).filter((s) => [s.Action].flat().some((a: string) => a.startsWith('ecr:')))).toEqual([]);
    expect(ecrRepositoryArn('123456789012.dkr.ecr.eu-west-1.amazonaws.com/team/bb@sha256:abc')).toBe('arn:aws:ecr:eu-west-1:123456789012:repository/team/bb');
  });

  it('rejects malformed image references at synth', () => {
    for (const ok of [IMAGE, 'ghcr.io/example/agent-breadboard:v1', 'localhost:5000/bb@sha256:' + 'a'.repeat(64), 'agent-breadboard']) expect(() => assertImageRef('x', ok)).not.toThrow();
    // What an unquoted `$R:server-…` in zsh produced (the `:s` history modifier ate the tag): caught before a deploy.
    const mangled = '123456789012.dkr.ecr.us-east-1.amazonaws.com/agent-breadboardTs=123456789012.dkr.ecr.us-east-1.amazonaws.com/agent-breadboard';
    expect(() => synth({ serverImage: mangled })).toThrow(/serverImage is not a valid image reference/);
    expect(() => synth({ sandboxImagePy: 'Bad Image' })).toThrow(/sandboxImagePy/);
  });

  it('adds no inbound rule to the server when no CIDRs are allowed (SSM-only access)', () => {
    const closed = synth({ allowedCidrs: [] });
    closed.hasResourceProperties('AWS::EC2::SecurityGroup', { GroupDescription: 'Breadboard server host', SecurityGroupIngress: Match.absent() });
    closed.resourceCountIs('AWS::EC2::SecurityGroupIngress', 1); // only Postgres from the server
  });

  it('generates all four secrets in Secrets Manager and retains them', () => {
    const secrets = t.findResources('AWS::SecretsManager::Secret');
    expect(Object.keys(secrets)).toHaveLength(4);
    for (const secret of Object.values(secrets)) {
      expect(secret.DeletionPolicy).toBe('RetainExceptOnCreate');
      expect(secret.Properties.SecretString).toBeUndefined();
      expect(secret.Properties.GenerateSecretString).toBeDefined();
    }
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'breadboard-test/db',
      // ExcludePunctuation, not ExcludeCharacters listing every punctuation mark: Secrets Manager rejects the latter
      // ("All characters of the desired type have been excluded"), found by the first real deploy.
      GenerateSecretString: Match.objectLike({ SecretStringTemplate: '{"username":"breadboard"}', GenerateStringKey: 'password', ExcludePunctuation: true, ExcludeCharacters: Match.absent() }),
    });
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'breadboard-test/token-signing-key',
      GenerateSecretString: { PasswordLength: 48, ExcludePunctuation: true, IncludeSpace: false },
    });
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'breadboard-test/broker-master-key',
      GenerateSecretString: { PasswordLength: 43, ExcludePunctuation: true, IncludeSpace: false },
    });
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'breadboard-test/admin-token',
      GenerateSecretString: { PasswordLength: 48, ExcludePunctuation: true, IncludeSpace: false },
    });
  });

  it('a generated 43-char alphanumeric broker key decodes to exactly 32 bytes', () => {
    // deriveBrokerKey (packages/server/src/toolbox/broker.ts) uses a 32-byte key directly and warns otherwise.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 200; i++) {
      const key = Array.from({ length: 43 }, () => alphabet[randomInt(alphabet.length)]).join('');
      expect(Buffer.from(key, 'base64')).toHaveLength(32);
    }
  });

  it('grants the server role exactly what the server uses', () => {
    const all = statements(t);
    expect(all).toContainEqual(
      expect.objectContaining({
        Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:Converse', 'bedrock:ConverseStream'],
        Resource: '*',
      }),
    );
    const secretReads = all.filter((s) => [s.Action].flat().includes('secretsmanager:GetSecretValue')).map((s) => JSON.stringify(s.Resource));
    const attachment = logicalId(t, 'AWS::SecretsManager::SecretTargetAttachment', {});
    const tokenKey = logicalId(t, 'AWS::SecretsManager::Secret', { Name: 'breadboard-test/token-signing-key' });
    const brokerKey = logicalId(t, 'AWS::SecretsManager::Secret', { Name: 'breadboard-test/broker-master-key' });
    const adminToken = logicalId(t, 'AWS::SecretsManager::Secret', { Name: 'breadboard-test/admin-token' });
    expect(secretReads.sort()).toEqual([attachment, brokerKey, tokenKey, adminToken].map((id) => JSON.stringify({ Ref: id })).sort());
    // cfn-init and cfn-hup read the instance metadata and signal creation.
    expect(actions(t)).toEqual(expect.arrayContaining(['cloudformation:DescribeStackResource', 'cloudformation:SignalResource']));

    const connect = all.find((s) => s.Action === 'rds-db:connect');
    expect(JSON.stringify(connect?.Resource)).toMatch(/:dbuser:.*DbiResourceId.*\/breadboard/);

    expect(actions(t)).toEqual(expect.arrayContaining(['s3:GetObject*', 's3:PutObject']));
    expect(actions(t).some((a) => /^s3:Delete/.test(a))).toBe(false);
    t.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/AmazonSSMManagedInstanceCore']] }],
    });
  });

  it('creates a versioned, private, TLS-only objects bucket and retains it', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'breadboard-test-objects-123456789012',
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'RetainExceptOnCreate' });
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: [Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })] },
    });
  });

  it('skips the bucket and S3 grants when enableS3Objects is false', () => {
    const fs = synth({ enableS3Objects: false });
    fs.resourceCountIs('AWS::S3::Bucket', 0);
    expect(actions(fs).some((a) => a.startsWith('s3:'))).toBe(false);
    expect(userData(fs).text).toContain('OBJECT_STORE=fs');
    expect(Object.keys(fs.findOutputs('*'))).not.toContain('ObjectsBucket');
  });

  it('runs the server on an IMDSv2-only host with an encrypted gp3 root volume in the given subnet', () => {
    t.hasResourceProperties('AWS::EC2::Instance', {
      ImageId: AMI,
      InstanceType: 't3.large',
      AvailabilityZone: 'us-east-1a',
      MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 2 },
      BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { VolumeSize: 100, VolumeType: 'gp3', Encrypted: true } }],
      NetworkInterfaces: [Match.objectLike({ AssociatePublicIpAddress: true, SubnetId: PUBLIC_A })],
      Tags: Match.arrayWith([{ Key: 'Name', Value: 'breadboard-test-server' }]),
    });
    // No launch template: its fixed name would collide across Breadboards in one account.
    t.resourceCountIs('AWS::EC2::LaunchTemplate', 0);
    // The instance waits for its policy, so first-boot Secrets Manager reads are authorized.
    const policy = logicalId(t, 'AWS::IAM::Policy', {});
    t.hasResource('AWS::EC2::Instance', { DependsOn: Match.arrayWith([policy]) });
  });

  it('bootstraps from secret ARNs with every placeholder filled', () => {
    const { text, refs } = userData(t);
    expect(text).not.toMatch(/\$\{/);
    for (const line of [
      'DATABASE_SSL=require',
      'PORT=4000',
      'MODEL_PROVIDER=bedrock',
      'OBJECT_STORE=s3',
      'SANDBOX_RUNNER=docker',
      // The server joins the sandbox network so tool containers reach its proxy and API by container name.
      'SANDBOX_EGRESS_PROXY_HOST=breadboard',
      'SANDBOX_API_URL=http://breadboard:4000',
      'BREADBOARD_BOOTSTRAP_ADMIN_TOKEN=$BOOTSTRAP_ADMIN_TOKEN',
      'aws-cfn-bootstrap',
      'docker network create --internal breadboard-sandbox',
    ]) {
      expect(text).toContain(line);
    }
    expect(text).toContain('http://__IMDS__:4000');
    // The images and the container are not in the one-time user data; cfn-init runs breadboard-apply.
    expect(text).not.toContain(IMAGE);
    expect(text).toContain('/opt/aws/bin/cfn-init');
    const apply = initFiles(t)['/usr/local/bin/breadboard-apply']!;
    for (const line of ['pull "$SERVER_IMAGE"', 'docker network connect breadboard-sandbox breadboard', '--user root', '--env-file /etc/breadboard.env']) expect(apply).toContain(line);
    // A graceful stop before the container is replaced, so the server's shutdown closes open MCP conversations.
    expect(apply.indexOf('docker stop -t 30 breadboard')).toBeGreaterThan(-1);
    expect(apply.indexOf('docker stop -t 30 breadboard')).toBeLessThan(apply.indexOf('docker rm -f breadboard'));
    // The token parts (endpoint, port, secret ARN) are dropped here and checked as references below.
    expect(initFiles(t)['/etc/breadboard/deploy.env']).toBe(
      `SERVER_IMAGE=${IMAGE}\nSANDBOX_IMAGE_TS=\nSANDBOX_IMAGE_PY=\nSERVER_PORT=4000\nPUBLIC_URL=\nBOOTSTRAP_ADMIN=true\nTRUSTED_PROXY_USER=\nTRUSTED_PROXY_SECRET_ARN=\nALB_AUTH_ARN=\nALB_AUTH_ISSUER=\nALB_AUTH_CLIENT_ID=\nOIDC_ADOPT_HANDLES=\nDATABASE_URL=postgres://breadboard@:/breadboard\nDATABASE_IAM_AUTH=true\nDB_SECRET_ARN=\n`,
    );
    const attachment = logicalId(t, 'AWS::SecretsManager::SecretTargetAttachment', {});
    const tokenKey = logicalId(t, 'AWS::SecretsManager::Secret', { Name: 'breadboard-test/token-signing-key' });
    const brokerKey = logicalId(t, 'AWS::SecretsManager::Secret', { Name: 'breadboard-test/broker-master-key' });
    const adminToken = logicalId(t, 'AWS::SecretsManager::Secret', { Name: 'breadboard-test/admin-token' });
    const db = logicalId(t, 'AWS::RDS::DBInstance', {});
    expect(refs).toEqual(expect.arrayContaining([tokenKey, brokerKey, adminToken].map((id) => JSON.stringify({ Ref: id }))));
    // No database settings in the one-time user data: the password-less URL is deployment metadata.
    expect(text).not.toContain('DATABASE_URL');
    expect(refs.some((r) => r.includes(attachment) || r.includes(db))).toBe(false);
    expect(initRefs(t, '/etc/breadboard/deploy.env')).toEqual([
      JSON.stringify({ 'Fn::GetAtt': [db, 'Endpoint.Address'] }),
      JSON.stringify({ 'Fn::GetAtt': [db, 'Endpoint.Port'] }),
      JSON.stringify({ Ref: attachment }),
    ]);
    expect(initFiles(t)['/usr/local/bin/breadboard-db-grant-iam']).toContain('GRANT rds_iam TO');
  });

  it('retires the master password without touching the host when dbMasterSecret is false', () => {
    const retired = synth({ dbMasterSecret: false });
    retired.resourceCountIs('AWS::SecretsManager::SecretTargetAttachment', 0);
    expect(Object.keys(retired.findResources('AWS::SecretsManager::Secret', { Properties: { Name: 'breadboard-test/db' } }))).toHaveLength(0);
    retired.hasResourceProperties('AWS::RDS::DBInstance', { MasterUsername: 'breadboard', MasterUserPassword: Match.absent(), EnableIAMDatabaseAuthentication: true });
    // The same DB resource: a new logical id would replace the database.
    expect(logicalId(retired, 'AWS::RDS::DBInstance', {})).toBe(logicalId(t, 'AWS::RDS::DBInstance', {}));
    const reads = statements(retired).filter((s) => [s.Action].flat().includes('secretsmanager:GetSecretValue')).map((s) => JSON.stringify(s.Resource));
    expect(reads.sort()).toEqual(
      ['token-signing-key', 'broker-master-key', 'admin-token'].map((n) => JSON.stringify({ Ref: logicalId(retired, 'AWS::SecretsManager::Secret', { Name: `breadboard-test/${n}` }) })).sort(),
    );
    expect(statements(retired).some((s) => s.Action === 'rds-db:connect')).toBe(true);
    expect(Object.keys(retired.findOutputs('*'))).not.toContain('DbSecretArn');
    // Neither restart nor replacement: identical user data, and deploy.env loses only the secret reference.
    expect(instanceUserData(retired)).toBe(instanceUserData(t));
    expect(initFiles(retired)['/etc/breadboard/deploy.env']).toBe(initFiles(t)['/etc/breadboard/deploy.env']);
    expect(initRefs(retired, '/etc/breadboard/deploy.env')).toEqual(initRefs(t, '/etc/breadboard/deploy.env').slice(0, 2));
  });

  it('applies publicUrl through the deployment metadata, leaving the user data (and so the host) alone', () => {
    const custom = synth({ publicUrl: 'https://breadboard.example.com' });
    // The boot-time value stays the IMDS placeholder; the container gets the configured URL with -e.
    expect(userData(custom).text).toContain('PUBLIC_URL="http://__IMDS__:4000"');
    expect(userData(custom).text).not.toContain('breadboard.example.com');
    expect(initFiles(custom)['/etc/breadboard/deploy.env']).toContain('PUBLIC_URL=https://breadboard.example.com\n');
    expect(initFiles(custom)['/usr/local/bin/breadboard-apply']).toContain('echo "PUBLIC_URL=$PUBLIC_URL"');
    custom.hasOutput('ServerUrl', { Value: 'https://breadboard.example.com' });
    const ud = (x: Template) => JSON.stringify(Object.values(x.findResources('AWS::EC2::Instance'))[0].Properties.UserData);
    expect(ud(custom)).toBe(ud(t)); // no replacement when publicUrl is set or changed later
  });

  it('turns the bootstrap admin off in place: the container gets an empty token, the host and the secret stay', () => {
    const off = synth({ bootstrapAdmin: false });
    expect(initFiles(off)['/etc/breadboard/deploy.env']).toContain('BOOTSTRAP_ADMIN=false\n');
    expect(initFiles(off)['/usr/local/bin/breadboard-apply']).toContain('echo "BREADBOARD_BOOTSTRAP_ADMIN_TOKEN="');
    const ud = (x: Template) => JSON.stringify(Object.values(x.findResources('AWS::EC2::Instance'))[0].Properties.UserData);
    expect(ud(off)).toBe(ud(t)); // no replacement; the boot-time env file still holds the token, overridden at run time
    off.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'breadboard-test/admin-token' });
    expect(Object.keys(off.findOutputs('*'))).toContain('AdminTokenSecretArn');
  });

  it('generates the trusted-proxy secret, lets the host read it, and applies it in place', () => {
    const proxied = synth({ trustedProxyUser: 'zach' });
    const secrets = Object.entries(proxied.findResources('AWS::SecretsManager::Secret')).filter(([, r]) => !r.Properties.Name);
    expect(secrets).toHaveLength(1); // unnamed: no name stays reserved if the proxy is turned off and on again
    const [secretId, secret] = secrets[0];
    expect(secret.DeletionPolicy).toBe('Delete');
    expect(secret.Properties.GenerateSecretString).toMatchObject({ PasswordLength: 48, ExcludePunctuation: true });
    const reads = statements(proxied).filter((st) => [st.Action].flat().includes('secretsmanager:GetSecretValue'));
    expect(reads.some((st) => JSON.stringify(st.Resource) === JSON.stringify({ Ref: secretId }))).toBe(true);
    const env = Object.values(proxied.findResources('AWS::EC2::Instance'))[0].Metadata['AWS::CloudFormation::Init'].config.files['/etc/breadboard/deploy.env'].content;
    expect(JSON.stringify(env)).toContain('TRUSTED_PROXY_USER=zach\\nTRUSTED_PROXY_SECRET_ARN=');
    expect(JSON.stringify(env)).toContain(JSON.stringify({ Ref: secretId }));
    proxied.hasOutput('TrustedProxySecretArn', { Value: { Ref: secretId } });
    proxied.hasOutput('TrustedProxyHeader', { Value: 'x-breadboard-proxy-auth' });
    proxied.hasOutput('TrustedProxyUser', { Value: 'zach' });
    const ud = (x: Template) => JSON.stringify(Object.values(x.findResources('AWS::EC2::Instance'))[0].Properties.UserData);
    expect(ud(proxied)).toBe(ud(t));
    expect(() => synth({ trustedProxyUser: 'zach; rm -rf /' })).toThrow(/trustedProxyUser must be a user handle/);
  });

  it('applies the load-balancer identity in place, and refuses values bash would misread', () => {
    const arn = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/breadboard-test-alb/0123456789abcdef';
    const lb = synth({ allowedCidrs: [], albAuthArn: arn, albAuthIssuer: 'https://idp.example.com', albAuthClientId: 'bb-client', oidcAdoptHandles: ['zach', 'ops.bot'] });
    expect(initFiles(lb)['/etc/breadboard/deploy.env']).toContain(`ALB_AUTH_ARN=${arn}\nALB_AUTH_ISSUER=https://idp.example.com\nALB_AUTH_CLIENT_ID=bb-client\nOIDC_ADOPT_HANDLES=zach,ops.bot\n`);
    lb.hasOutput('AlbAuthArn', { Value: arn });
    expect(Object.keys(t.findOutputs('*'))).not.toContain('AlbAuthArn');
    const ud = (x: Template) => JSON.stringify(Object.values(x.findResources('AWS::EC2::Instance'))[0].Properties.UserData);
    expect(ud(lb)).toBe(ud(t)); // no host replacement
    for (const [over, err] of [
      [{ albAuthArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/nlb/0123456789abcdef' }, /Application Load Balancer ARN/],
      [{ albAuthArn: arn.replace('us-east-1', 'eu-west-1') }, /load balancer in us-east-1/],
      [{ albAuthArn: `${arn};reboot` }, /Application Load Balancer ARN/],
      [{ albAuthIssuer: 'https://idp.example.com' }, /need albAuthArn/],
      [{ albAuthArn: arn, albAuthIssuer: 'https://idp.example.com/$(id)' }, /https URL/],
      [{ albAuthArn: arn, albAuthClientId: '~root' }, /OIDC client id/],
      [{ albAuthArn: arn, oidcAdoptHandles: ['zach', 'x y'] }, /oidcAdoptHandles must be user handles/],
    ] as const) {
      expect(() => synth(over as Partial<BreadboardStackProps>)).toThrow(err);
    }
  });

  it('warns when the server port is open to CIDRs next to a load balancer', () => {
    const props = { ...base, albAuthArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/breadboard-test-alb/0123456789abcdef' };
    const probe = new App();
    new BreadboardStack(probe, 'Probe', props);
    const missing = probe.synth().manifest.missing ?? [];
    const app = new App({ context: Object.fromEntries(missing.map((m) => [m.key, lookupAnswer(m.provider, AMI)])) });
    const stack = new BreadboardStack(app, 'Warn', props);
    expect(Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('albAuthArn is set but allowedCidrs opens the server port to 0.0.0.0/0'))).toHaveLength(1);
    const closed = new BreadboardStack(new App({ context: Object.fromEntries(missing.map((m) => [m.key, lookupAnswer(m.provider, AMI)])) }), 'Closed', { ...props, allowedCidrs: [] });
    expect(Annotations.fromStack(closed).findWarning('*', Match.stringLikeRegexp('albAuthArn'))).toHaveLength(0);
  });

  it('lets the server assume broker roles only when listed, without touching the host', () => {
    const assume = (x: Template) => statements(x).filter((st) => [st.Action].flat().includes('sts:AssumeRole'));
    expect(assume(t)).toHaveLength(0);
    t.hasOutput('ServerRoleArn', {});
    const arns = ['arn:aws:iam::123456789012:role/breadboard-test-data', 'arn:aws:iam::123456789012:role/other'];
    const withRoles = synth({ brokerRoleArns: arns });
    expect(assume(withRoles).map((st) => st.Resource)).toEqual([arns]);
    const ud = (x: Template) => JSON.stringify(Object.values(x.findResources('AWS::EC2::Instance'))[0].Properties.UserData);
    expect(ud(withRoles)).toBe(ud(t));
    expect(() => synth({ brokerRoleArns: ['arn:aws:iam::123456789012:user/alice'] })).toThrow(/brokerRoleArns must be IAM role ARNs/);
  });

  it('rejects a publicUrl that is not scheme://host[:port]', () => {
    for (const bad of ['https://bb.example.com/app', 'bb.example.com', 'https://bb.example.com;rm -rf /', 'ftp://bb.example.com']) {
      expect(() => synth({ publicUrl: bad })).toThrow(/publicUrl must be scheme:\/\/host\[:port\]/);
    }
    expect(() => synth({ publicUrl: 'http://10.0.0.5:4000' })).not.toThrow();
  });

  it('supports a private server without a public IP', () => {
    const priv = synth({ serverPublicIp: false, serverSubnetId: PRIVATE_A });
    priv.hasResourceProperties('AWS::EC2::Instance', {
      NetworkInterfaces: [Match.objectLike({ AssociatePublicIpAddress: false, SubnetId: PRIVATE_A })],
    });
    const instance = logicalId(priv, 'AWS::EC2::Instance', {});
    priv.hasOutput('ServerIp', { Value: { 'Fn::GetAtt': [instance, 'PrivateIp'] } });
  });

  it('upgrades images in place: cfn-hup watches the metadata, and an image change leaves the user data alone', () => {
    const server = logicalId(t, 'AWS::EC2::Instance', {});
    const hook = initFiles(t)['/etc/cfn/hooks.d/breadboard.conf']!;
    expect(hook).toContain('triggers=post.update');
    expect(hook).toContain(`path=Resources.${server}.Metadata.AWS::CloudFormation::Init`);
    expect(hook).toContain(`--resource ${server}`);
    expect(initFiles(t)['/etc/systemd/system/cfn-hup.service']).toContain('ExecStart=/opt/aws/bin/cfn-hup');
    t.hasResource('AWS::EC2::Instance', { CreationPolicy: { ResourceSignal: { Count: 1, Timeout: 'PT20M' } } });
    const next = synth({ serverImage: '123456789012.dkr.ecr.us-east-1.amazonaws.com/agent-breadboard:v0.2' });
    const ud = (x: Template) => JSON.stringify(Object.values(x.findResources('AWS::EC2::Instance'))[0].Properties.UserData);
    expect(ud(next)).toBe(ud(t)); // no restart, no replacement
    expect(initFiles(next)['/etc/breadboard/deploy.env']).toContain('SERVER_IMAGE=123456789012.dkr.ecr.us-east-1.amazonaws.com/agent-breadboard:v0.2');
  });

  it('emits the operator outputs', () => {
    expect(Object.keys(t.findOutputs('*')).sort()).toEqual(
      [
        'AdminTokenSecretArn', 'BrokerMasterKeySecretArn', 'DbSecretArn', 'ObjectsBucket', 'RdsEndpoint', 'ServerIp', 'ServerUrl', 'TokenSigningKeySecretArn',
        'ServerInstanceId', 'ServerSecurityGroupId', 'ServerPrivateDnsName', 'ServerPort', 'VpcId', 'ServerSubnetId', 'ServerRoleArn',
      ].sort(),
    );
  });

  it('publishes the server instance, security group and network for add-ons, without exports', () => {
    const instance = logicalId(t, 'AWS::EC2::Instance', {});
    const sg = logicalId(t, 'AWS::EC2::SecurityGroup', { GroupDescription: 'Breadboard server host' });
    t.hasOutput('ServerInstanceId', { Value: { Ref: instance } });
    t.hasOutput('ServerSecurityGroupId', { Value: { 'Fn::GetAtt': [sg, 'GroupId'] } });
    t.hasOutput('ServerPrivateDnsName', { Value: { 'Fn::GetAtt': [instance, 'PrivateDnsName'] } });
    t.hasOutput('ServerPort', { Value: '4000' });
    t.hasOutput('VpcId', { Value: VPC_ID });
    t.hasOutput('ServerSubnetId', { Value: PUBLIC_A });
    for (const output of Object.values(t.findOutputs('*'))) expect(output.Export).toBeUndefined();
  });

  it('fails synth on CloudFormation schema findings', () => {
    expect(() => synth({}, 'not-an-ami')).toThrow(/ImageId: 'not-an-ami' does not match format/);
  });

  it('rejects subnets outside the VPC and a public IP in a private subnet', () => {
    expect(() => synth({ serverSubnetId: 'subnet-0ddddddddddddddd1' })).toThrow(/subnet-0ddddddddddddddd1 is not in vpc-0a1b2c3d4e5f60718/);
    expect(() => synth({ serverSubnetId: PRIVATE_A })).toThrow(/Public subnets/);
  });
});

describe('breadboard-apply.sh', () => {
  // Run the real script against stub docker and aws commands to see the container it would create.
  function apply(deployEnv: string): { create: string; overrides: string; mode: number; awsCalls: string } {
    const dir = mkdtempSync(join(tmpdir(), 'bb-apply-'));
    writeFileSync(join(dir, 'deploy.env'), deployEnv);
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\necho "$*" >> "$DOCKER_LOG"\n[ "$1" = inspect ] && exit 1\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(dir, 'aws'), '#!/bin/sh\necho "$*" >> "$AWS_LOG"\necho proxy-secret-value-0123456789abcdef0123456789\n', { mode: 0o755 });
    const overridesFile = join(dir, 'overrides.env');
    execFileSync('bash', [join(import.meta.dirname, '..', 'lib', 'breadboard-apply.sh')], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, BREADBOARD_DEPLOY_ENV: join(dir, 'deploy.env'), BREADBOARD_OVERRIDES_ENV: overridesFile, DOCKER_LOG: join(dir, 'docker.log'), AWS_LOG: join(dir, 'aws.log') },
      stdio: 'pipe',
    });
    const create = readFileSync(join(dir, 'docker.log'), 'utf8').split('\n').find((l) => l.startsWith('create '))!;
    const awsCalls = (() => { try { return readFileSync(join(dir, 'aws.log'), 'utf8'); } catch { return ''; } })();
    return { create: create.replace(overridesFile, '<overrides>'), overrides: readFileSync(overridesFile, 'utf8'), mode: statSync(overridesFile).mode & 0o777, awsCalls };
  }
  const base = 'SERVER_IMAGE=registry.example.com/bb:v1\nSANDBOX_IMAGE_TS=\nSANDBOX_IMAGE_PY=\nSERVER_PORT=4000\n';

  it('passes an empty overrides file by default', () => {
    for (const env of [`${base}PUBLIC_URL=\nBOOTSTRAP_ADMIN=true\nTRUSTED_PROXY_USER=\nTRUSTED_PROXY_SECRET_ARN=\n`, base /* a deploy.env from before these settings */]) {
      const r = apply(env);
      expect(r.create).toContain('--env-file /etc/breadboard.env --env-file <overrides> -p 4000:4000');
      expect(r.overrides).toBe('');
    }
  });

  it('passes the load-balancer identity through, and nothing for a deploy.env that predates it', () => {
    const arn = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/bb/0123456789abcdef';
    const r = apply(`${base}PUBLIC_URL=\nBOOTSTRAP_ADMIN=true\nTRUSTED_PROXY_USER=\nTRUSTED_PROXY_SECRET_ARN=\nALB_AUTH_ARN=${arn}\nALB_AUTH_ISSUER=https://idp.example.com\nALB_AUTH_CLIENT_ID=bb-client\nOIDC_ADOPT_HANDLES=zach\n`);
    expect(r.overrides).toBe(`BREADBOARD_ALB_AUTH_ARN=${arn}\nBREADBOARD_ALB_AUTH_ISSUER=https://idp.example.com\nBREADBOARD_ALB_AUTH_CLIENT_ID=bb-client\nBREADBOARD_OIDC_ADOPT_HANDLES=zach\n`);
    expect(r.awsCalls).toBe('');
    expect(apply(`${base}PUBLIC_URL=\nBOOTSTRAP_ADMIN=true\nTRUSTED_PROXY_USER=\nTRUSTED_PROXY_SECRET_ARN=\nALB_AUTH_ARN=\nALB_AUTH_ISSUER=\nALB_AUTH_CLIENT_ID=\nOIDC_ADOPT_HANDLES=\n`).overrides).toBe('');
  });

  it('passes the password-less database URL and IAM auth through, overriding the boot-time env file', () => {
    const url = 'postgres://breadboard@db.example.us-east-1.rds.amazonaws.com:5432/breadboard';
    const r = apply(`${base}PUBLIC_URL=\nBOOTSTRAP_ADMIN=true\nTRUSTED_PROXY_USER=\nTRUSTED_PROXY_SECRET_ARN=\nALB_AUTH_ARN=\nALB_AUTH_ISSUER=\nALB_AUTH_CLIENT_ID=\nOIDC_ADOPT_HANDLES=\nDATABASE_URL=${url}\nDATABASE_IAM_AUTH=true\nDB_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789012:secret:breadboard-test/db-AbCdEf\n`);
    expect(r.overrides).toBe(`DATABASE_URL=${url}\nDATABASE_IAM_AUTH=true\n`);
    expect(r.awsCalls).toBe(''); // the master secret is the grant helper's, never the container's
    expect(r.create).toContain('--env-file /etc/breadboard.env --env-file <overrides>');
  });

  it('writes PUBLIC_URL, the disabled bootstrap token and the trusted proxy to a root-only overrides file', () => {
    const arn = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:TrustedProxySecret-AbCdEf';
    const r = apply(`${base}PUBLIC_URL=https://bb.example.com\nBOOTSTRAP_ADMIN=false\nTRUSTED_PROXY_USER=zach\nTRUSTED_PROXY_SECRET_ARN=${arn}\n`);
    expect(r.overrides).toBe(
      'PUBLIC_URL=https://bb.example.com\nBREADBOARD_BOOTSTRAP_ADMIN_TOKEN=\nBREADBOARD_TRUSTED_PROXY_USER=zach\nBREADBOARD_TRUSTED_PROXY_SECRET=proxy-secret-value-0123456789abcdef0123456789\n',
    );
    expect(r.mode).toBe(0o600);
    expect(r.awsCalls).toContain(`secretsmanager get-secret-value --region eu-west-1 --secret-id ${arn}`); // region from the ARN
    // The secret value is in the file only, never on a command line.
    expect(r.create).not.toContain('proxy-secret-value');
    expect(r.create).toContain('--env-file /etc/breadboard.env --env-file <overrides>');
  });
});

describe('breadboard-db-grant-iam.sh', () => {
  // Run the real script against stub aws (the master secret) and docker (records the run and its env file).
  function grant(deployEnv: string): { status: number; stderr: string; dockerArgs: string; envFile: string; awsCalls: string } {
    const dir = mkdtempSync(join(tmpdir(), 'bb-grant-'));
    writeFileSync(join(dir, 'deploy.env'), deployEnv);
    const secret = JSON.stringify({ username: 'breadboard', password: 'p@ss/w0rd', host: 'db.example.us-east-1.rds.amazonaws.com', port: 5432, dbname: 'breadboard', engine: 'postgres' });
    writeFileSync(join(dir, 'aws'), `#!/bin/sh\necho "$*" >> "$AWS_LOG"\necho '${secret}'\n`, { mode: 0o755 });
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\necho "$*" >> "$DOCKER_LOG"\nwhile [ $# -gt 0 ]; do [ "$1" = --env-file ] && cat "$2" >> "$ENV_LOG"; shift; done\nexit 0\n', { mode: 0o755 });
    const read = (f: string) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } };
    let status = 0;
    let stderr = '';
    try {
      execFileSync('bash', [join(import.meta.dirname, '..', 'lib', 'breadboard-db-grant-iam.sh')], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, BREADBOARD_DEPLOY_ENV: join(dir, 'deploy.env'), AWS_LOG: join(dir, 'aws.log'), DOCKER_LOG: join(dir, 'docker.log'), ENV_LOG: join(dir, 'env.log') },
        stdio: 'pipe',
      });
    } catch (e) {
      status = (e as { status: number }).status;
      stderr = String((e as { stderr: Buffer }).stderr);
    }
    return { status, stderr, dockerArgs: read('docker.log'), envFile: read('env.log'), awsCalls: read('aws.log') };
  }
  const arn = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:breadboard-test/db-AbCdEf';

  it('grants rds_iam inside the server image, signing in with the master secret kept off the command line', () => {
    const r = grant(`SERVER_IMAGE=registry.example.com/bb:v1\nDB_SECRET_ARN=${arn}\n`);
    expect(r.status).toBe(0);
    expect(r.awsCalls).toContain(`secretsmanager get-secret-value --region eu-west-1 --secret-id ${arn}`);
    expect(r.envFile).toBe('MASTER_URL=postgres://breadboard:p%40ss%2Fw0rd@db.example.us-east-1.rds.amazonaws.com:5432/breadboard\n');
    expect(r.dockerArgs).toMatch(/^run --rm --env-file \S+ registry\.example\.com\/bb:v1 node -e /);
    expect(r.dockerArgs).toContain("GRANT rds_iam TO ' + client.escapeIdentifier(user)");
    expect(r.dockerArgs).not.toContain('p@ss');
    expect(r.dockerArgs).not.toContain('p%40ss');
  });

  it('refuses to run once the master secret is retired', () => {
    const r = grant('SERVER_IMAGE=registry.example.com/bb:v1\nDB_SECRET_ARN=\n');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('dbMasterSecret=false');
    expect(r.dockerArgs).toBe('');
  });
});

describe('renderUserData', () => {
  it('refuses a placeholder without a value', () => {
    expect(() => renderUserData({ image: 'x' })).toThrow(/placeholder \$\{region\} has no value/);
  });
});

describe('bin/breadboard.ts', () => {
  // Run the app the way the CLI does (context via CDK_CONTEXT_JSON, output via CDK_OUTDIR); lookups stay pending.
  function run(context: Record<string, unknown>): { manifest: { missing?: { provider: string }[] }; template: string } {
    const outdir = mkdtempSync(join(tmpdir(), 'bb-cdk-'));
    execFileSync(process.execPath, ['--import', 'tsx', 'bin/breadboard.ts'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, CDK_OUTDIR: outdir, CDK_CONTEXT_JSON: JSON.stringify(context), CDK_DEFAULT_ACCOUNT: '123456789012', CDK_DEFAULT_REGION: 'us-west-2' },
      stdio: 'pipe',
    });
    const manifest = JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8'));
    return { manifest, template: readFileSync(join(outdir, `Breadboard-${String(context.name)}.template.json`), 'utf8') };
  }
  const required = { name: 'smoke', vpcId: VPC_ID, dbSubnetIds: `${PRIVATE_A},${PRIVATE_B}`, serverSubnetId: PUBLIC_A, serverImage: IMAGE };

  it('parses string context and requests the VPC and AMI lookups', () => {
    const { manifest, template } = run({ ...required, enableS3Objects: 'false', serverPort: '8443', tags: 'Team=research' });
    expect(manifest.missing?.map((m) => m.provider).sort()).toEqual(['ssm', 'vpc-provider']);
    expect(template).not.toContain('AWS::S3::Bucket');
    expect(template).toContain('PORT=8443');
    expect(template).toContain('BOOTSTRAP_ADMIN=true');
    expect(run({ ...required, bootstrapAdmin: 'false' }).template).toContain('BOOTSTRAP_ADMIN=false');
    expect(run({ ...required, trustedProxyUser: 'zach' }).template).toContain('TRUSTED_PROXY_USER=zach');
    expect(template).toContain('AWS::SecretsManager::SecretTargetAttachment');
    expect(run({ ...required, dbMasterSecret: 'false' }).template).not.toContain('AWS::SecretsManager::SecretTargetAttachment');
    const role = Object.values<{ Type: string; Properties: { Tags?: unknown[] } }>(JSON.parse(template).Resources).find((r) => r.Type === 'AWS::IAM::Role');
    expect(role?.Properties.Tags).toEqual(
      expect.arrayContaining([{ Key: 'Team', Value: 'research' }, { Key: 'Project', Value: 'agent-breadboard' }, { Key: 'Breadboard', Value: 'smoke' }]),
    );
  });

  it('names every missing required input', () => {
    expect(() => run({ name: 'smoke' })).toThrow(/missing required context: vpcId, dbSubnetIds, serverSubnetId, serverImage/);
  });

  it('rejects malformed booleans', () => {
    expect(() => run({ ...required, dbMultiAz: 'yes' })).toThrow(/dbMultiAz must be true or false/);
  });
});
