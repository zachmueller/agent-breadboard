import { main } from './runner.js';
main().catch((e) => {
  process.stdout.write(JSON.stringify({ kind: 'error', message: (e as Error).message, stack: (e as Error).stack }) + '\n');
  process.exit(1);
});
