import type { MongoMemoryReplSet } from 'mongodb-memory-server';

export default async function globalTeardown(): Promise<void> {
  await (globalThis as { __MONGO__?: MongoMemoryReplSet }).__MONGO__?.stop();
}
