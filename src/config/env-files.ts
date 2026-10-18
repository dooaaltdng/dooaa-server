import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads `.env.production` when NODE_ENV is production and `.env.local`
 * otherwise, if the file exists. Variables already set in the environment
 * always win, so a host's own settings override the file. The test suite
 * configures itself and loads neither.
 */
export function loadEnvFiles(cwd: string = process.cwd()): string | null {
  const env = process.env.NODE_ENV ?? 'development';
  if (env === 'test') return null;
  const file = join(cwd, env === 'production' ? '.env.production' : '.env.local');
  if (!existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}
