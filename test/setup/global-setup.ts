import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * One in-memory MongoDB replica set for the whole run (a replica set, so
 * transactions work). Each test app uses its own database on it, so files
 * run in parallel safely. Set TEST_MONGODB_URI to use an existing server.
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.TEST_MONGODB_URI) return;
  const server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  (globalThis as { __MONGO__?: MongoMemoryReplSet }).__MONGO__ = server;
  process.env.TEST_MONGODB_URI = server.getUri();
}
