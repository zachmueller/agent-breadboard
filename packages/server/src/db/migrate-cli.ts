import { connectDb } from './index.js';
import { migrate } from './migrate.js';
import { loadEnv } from '../core/env.js';

const env = loadEnv();
const db = await connectDb({ url: env.DATABASE_URL, ssl: env.DATABASE_SSL, sslCaFile: env.DATABASE_SSL_CA_FILE, iamAuth: env.DATABASE_IAM_AUTH, awsRegion: env.AWS_REGION });
const r = await migrate(db, console);
console.log(`applied ${r.applied.length}, skipped ${r.skipped.length}`);
await db.close();
