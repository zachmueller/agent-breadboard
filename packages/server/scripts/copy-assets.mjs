import { cpSync, existsSync, mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
if (existsSync('migrations')) cpSync('migrations', 'dist/migrations', { recursive: true });
