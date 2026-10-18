import { loadConfig } from '../config/configuration';
import { loadEnvFiles } from '../config/env-files';
import { createDatabase, createPool } from './database.module';
import { MIGRATIONS_FOLDER, runMigrations } from './migrations';

/**
 * Applies pending migrations from ./drizzle, then exits. Run it as a release
 * step before starting the new version (`npm run db:migrate`), not from the
 * app itself, so several instances never race to migrate.
 */
async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig();
  if (!config.database.url) throw new Error('Set DATABASE_URL to the database to migrate.');
  // Migrations may build indexes on large tables: no per-statement ceiling here.
  const pool = createPool({ ...config.database, statementTimeoutMs: 0 });
  try {
    await runMigrations(createDatabase(pool));
    console.log(`[migrate] Database is up to date (${MIGRATIONS_FOLDER}).`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[migrate] ${(error as Error).message}`);
  process.exit(1);
});
