import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { createDatabase, createPool } from '../../src/database/database.module';
import { runMigrations } from '../../src/database/migrations';
import { TEMPLATE_DATABASE } from './database';

/**
 * One PostgreSQL server for the whole run (real binaries, from the
 * embedded-postgres package). The schema is migrated once into a template
 * database; each test file then clones it, so files run in parallel safely.
 * Set TEST_DATABASE_URL to use an existing server instead.
 */
export default async function globalSetup(): Promise<void> {
  let adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    const port = 55_000 + Math.floor(Math.random() * 5_000);
    const server = new EmbeddedPostgres({
      databaseDir: mkdtempSync(join(tmpdir(), 'dooaa-pg-')),
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      onLog: () => undefined,
    });
    await server.initialise();
    await server.start();
    (globalThis as { __POSTGRES__?: EmbeddedPostgres }).__POSTGRES__ = server;
    adminUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  }
  process.env.PG_TEST_ADMIN_URL = adminUrl;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${TEMPLATE_DATABASE}`);
  await admin.query(`create database ${TEMPLATE_DATABASE}`);
  await admin.end();

  const templateUrl = new URL(adminUrl);
  templateUrl.pathname = `/${TEMPLATE_DATABASE}`;
  const pool = createPool({ url: templateUrl.toString(), poolMax: 2, statementTimeoutMs: 0 });
  await runMigrations(createDatabase(pool));
  await pool.end();
}
