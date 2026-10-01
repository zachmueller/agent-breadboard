// CDK app entry: `npx cdk deploy -c name=myteam -c vpcId=vpc-… -c dbSubnetIds=subnet-a,subnet-b …`.
// Inputs arrive as CDK context (strings from `-c`, or typed values from cdk.json); see README for the full list.
import { App, Tags } from 'aws-cdk-lib';
import { BreadboardStack, type BreadboardStackProps } from '../lib/breadboard-stack.js';

const app = new App();

function raw(key: string): unknown {
  const value: unknown = app.node.tryGetContext(key);
  return value === undefined || value === '' ? undefined : value;
}
function str(key: string): string | undefined {
  const value = raw(key);
  return value === undefined ? undefined : String(value);
}
function list(key: string): string[] | undefined {
  const value = raw(key);
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value.map(String) : String(value).split(',')).map((s) => s.trim()).filter(Boolean);
}
function bool(key: string): boolean | undefined {
  const value = raw(key);
  if (value === undefined || typeof value === 'boolean') return value;
  if (value === 'true' || value === 'false') return value === 'true';
  throw new Error(`context ${key} must be true or false, got ${String(value)}`);
}
function num(key: string): number | undefined {
  const value = raw(key);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`context ${key} must be a number, got ${String(value)}`);
  return n;
}

const required = { name: str('name'), vpcId: str('vpcId'), dbSubnetIds: list('dbSubnetIds'), serverSubnetId: str('serverSubnetId'), serverImage: str('serverImage') };
const missing = Object.entries(required).filter(([, v]) => v === undefined).map(([k]) => k);
if (missing.length) {
  throw new Error(
    `missing required context: ${missing.join(', ')}\n` +
      '  e.g. npx cdk deploy -c name=myteam -c vpcId=vpc-… -c dbSubnetIds=subnet-a,subnet-b -c serverSubnetId=subnet-c -c serverImage=<ecr image>',
  );
}
const sandboxRunner = str('sandboxRunner');
if (sandboxRunner !== undefined && sandboxRunner !== 'docker' && sandboxRunner !== 'process') {
  throw new Error(`context sandboxRunner must be docker or process, got ${sandboxRunner}`);
}

const props: BreadboardStackProps = {
  ...(required as Pick<BreadboardStackProps, keyof typeof required>),
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: str('region') ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  description: 'Agent Breadboard reference deployment: RDS Postgres + one server host',
  serverPublicIp: bool('serverPublicIp'),
  // `none`: no inbound rule at all (reach the server through SSM port forwarding).
  allowedCidrs: str('allowedCidrs') === 'none' ? [] : list('allowedCidrs'),
  serverPort: num('serverPort'),
  serverInstanceType: str('serverInstanceType'),
  serverRootVolumeGb: num('serverRootVolumeGb'),
  publicUrl: str('publicUrl'),
  sandboxRunner,
  sandboxImageTs: str('sandboxImageTs'),
  sandboxImagePy: str('sandboxImagePy'),
  dbEngineVersion: str('dbEngineVersion'),
  dbInstanceClass: str('dbInstanceClass'),
  dbAllocatedStorageGb: num('dbAllocatedStorageGb'),
  dbMaxAllocatedStorageGb: num('dbMaxAllocatedStorageGb'),
  dbMultiAz: bool('dbMultiAz'),
  dbBackupRetentionDays: num('dbBackupRetentionDays'),
  dbDeletionProtection: bool('dbDeletionProtection'),
  enableS3Objects: bool('enableS3Objects'),
};
// Unset inputs fall through to the stack's DEFAULTS.
for (const key of Object.keys(props) as (keyof BreadboardStackProps)[]) if (props[key] === undefined) delete props[key];

Tags.of(app).add('Project', 'agent-breadboard');
Tags.of(app).add('Breadboard', props.name);
// Extra tags: -c tags=Team=research,CostCenter=1234
for (const pair of list('tags') ?? []) {
  const [key, ...rest] = pair.split('=');
  if (!key || rest.length === 0) throw new Error(`context tags must be Key=Value pairs, got ${pair}`);
  Tags.of(app).add(key, rest.join('='));
}

new BreadboardStack(app, `Breadboard-${props.name}`, props);
