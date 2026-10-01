import { connectDb } from './index.js';
import { migrate } from './migrate.js';
import { findRepoRoot, loadEnv } from '../core/env.js';

const root = findRepoRoot();
const env = loadEnv({}, root);
const db = await connectDb({ url: env.DATABASE_URL.startsWith('pglite://') && !env.DATABASE_URL.includes('memory') ? `pglite://${new URL('file://' + root + '/').pathname}${env.DATABASE_URL.slice('pglite://'.length).replace(/^\.\//, '')}` : env.DATABASE_URL, ssl: env.DATABASE_SSL, sslCaFile: env.DATABASE_SSL_CA_FILE, iamAuth: env.DATABASE_IAM_AUTH, awsRegion: env.AWS_REGION });
const r = await migrate(db, console);
console.log(`applied ${r.applied.length}, skipped ${r.skipped.length}`);
await db.close();
