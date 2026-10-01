import { loadEnv } from './core/env.js';
import { createLogger } from './core/logger.js';
import { buildServices, startBackground, stopServices } from './core/build.js';
import { buildApp } from './app.js';

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL, env.LOG_PRETTY);

const services = await buildServices({ env, log });
const app = await buildApp(services);

await app.listen({ port: env.PORT, host: env.HOST });
log.info({ url: env.PUBLIC_URL, db: services.db.kind, provider: env.MODEL_PROVIDER, sandbox: services.sandbox.kind }, 'breadboard server listening');
await startBackground(services);

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await stopServices(services);
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
