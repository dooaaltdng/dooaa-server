import type { MongoMemoryServer } from 'mongodb-memory-server';

export default async function globalTeardown(): Promise<void> {
  const server = (globalThis as { __MONGO__?: MongoMemoryServer }).__MONGO__;
  await server?.stop();
}
