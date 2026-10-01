import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * One MongoDB for the whole run. Workers inherit the URI through the
 * environment and each test file opens its own database on it.
 */
export default async function globalSetup(): Promise<void> {
  const server = await MongoMemoryServer.create();
  (globalThis as { __MONGO__?: MongoMemoryServer }).__MONGO__ = server;
  process.env.MONGO_TEST_URI = server.getUri();
}
