import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { BreadboardStack, ecrRepositoryArn, renderUserData, type BreadboardStackProps } from '../lib/breadboard-stack.js';

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
    const { text } = userData(withSandboxes);
    expect(text).toContain('aws ecr get-login-password');
    expect(text).toContain(`docker tag "${ts}" breadboard-sandbox-ts:local`);
    expect(text).toContain(`docker tag "${py}" breadboard-sandbox-py:local`);
    // A non-ECR image needs no ECR grant.
    const hub = synth({ serverImage: 'ghcr.io/example/agent-breadboard:v1' });
    expect(statements(hub).filter((s) => [s.Action].flat().some((a: string) => a.startsWith('ecr:')))).toEqual([]);
    expect(ecrRepositoryArn('123456789012.dkr.ecr.eu-west-1.amazonaws.com/team/bb@sha256:abc')).toBe('arn:aws:ecr:eu-west-1:123456789012:repository/team/bb');
  });

  it('adds no inbound rule to the server when no CIDRs are allowed (SSM-only access)', () => {
    const closed = synth({ allowedCidrs: [] });
    closed.hasResourceProperties('AWS::EC2::SecurityGroup', { GroupDescription: 'Breadboard server host', SecurityGroupIngress: Match.absent() });
    closed.resourceCountIs('AWS::EC2::SecurityGroupIngress', 1); // only Postgres from the server
  });

  it('generates all three secrets in Secrets Manager and retains them', () => {
    const secrets = t.findResources('AWS::SecretsManager::Secret');
    expect(Object.keys(secrets)).toHaveLength(3);
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
    expect(secretReads.sort()).toEqual([attachment, brokerKey, tokenKey].map((id) => JSON.stringify({ Ref: id })).sort());

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
      `pull "${IMAGE}"`, // the ECR-login-aware pull helper
      // The server joins the sandbox network so tool containers reach its proxy and API by container name.
      'SANDBOX_EGRESS_PROXY_HOST=breadboard',
      'SANDBOX_API_URL=http://breadboard:4000',
      'docker network connect breadboard-sandbox breadboard',
      '--user root',
    ]) {
      expect(text).toContain(line);
    }
    expect(text).toContain('http://__IMDS__:4000');
    const attachment = logicalId(t, 'AWS::SecretsManager::SecretTargetAttachment', {});
    const tokenKey = logicalId(t, 'AWS::SecretsManager::Secret', { Name: 'breadboard-test/token-signing-key' });
    const brokerKey = logicalId(t, 'AWS::SecretsManager::Secret', { Name: 'breadboard-test/broker-master-key' });
    const db = logicalId(t, 'AWS::RDS::DBInstance', {});
    expect(refs).toEqual(
      expect.arrayContaining([
        JSON.stringify({ Ref: attachment }),
        JSON.stringify({ Ref: tokenKey }),
        JSON.stringify({ Ref: brokerKey }),
        JSON.stringify({ 'Fn::GetAtt': [db, 'Endpoint.Address'] }),
      ]),
    );
  });

  it('uses publicUrl as given instead of the IMDS placeholder', () => {
    const custom = synth({ publicUrl: 'https://breadboard.example.com' });
    expect(userData(custom).text).toContain('PUBLIC_URL="https://breadboard.example.com"');
    expect(userData(custom).text).not.toContain('PUBLIC_URL="http://__IMDS__');
    custom.hasOutput('ServerUrl', { Value: 'https://breadboard.example.com' });
  });

  it('supports a private server without a public IP', () => {
    const priv = synth({ serverPublicIp: false, serverSubnetId: PRIVATE_A });
    priv.hasResourceProperties('AWS::EC2::Instance', {
      NetworkInterfaces: [Match.objectLike({ AssociatePublicIpAddress: false, SubnetId: PRIVATE_A })],
    });
    const instance = logicalId(priv, 'AWS::EC2::Instance', {});
    priv.hasOutput('ServerIp', { Value: { 'Fn::GetAtt': [instance, 'PrivateIp'] } });
  });

  it('emits the operator outputs', () => {
    expect(Object.keys(t.findOutputs('*')).sort()).toEqual(
      ['BrokerMasterKeySecretArn', 'DbSecretArn', 'ObjectsBucket', 'RdsEndpoint', 'ServerIp', 'ServerUrl', 'TokenSigningKeySecretArn'].sort(),
    );
  });

  it('fails synth on CloudFormation schema findings', () => {
    expect(() => synth({}, 'not-an-ami')).toThrow(/ImageId: 'not-an-ami' does not match format/);
  });

  it('rejects subnets outside the VPC and a public IP in a private subnet', () => {
    expect(() => synth({ serverSubnetId: 'subnet-0ddddddddddddddd1' })).toThrow(/subnet-0ddddddddddddddd1 is not in vpc-0a1b2c3d4e5f60718/);
    expect(() => synth({ serverSubnetId: PRIVATE_A })).toThrow(/Public subnets/);
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
