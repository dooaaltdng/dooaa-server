import type EmbeddedPostgres from 'embedded-postgres';

export default async function globalTeardown(): Promise<void> {
  const server = (globalThis as { __POSTGRES__?: EmbeddedPostgres }).__POSTGRES__;
  await server?.stop();
}
