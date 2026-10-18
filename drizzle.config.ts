import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit reads the schema to write SQL migrations into ./drizzle
 * (`npm run db:generate`). The app applies them with `npm run db:migrate`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './drizzle',
  casing: 'snake_case',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/dooaa' },
  strict: true,
  verbose: true,
});
