import type { Config } from 'jest';

/**
 * Two projects share one runner:
 *  - unit: pure logic under src (pricing, state machines, query builders…), no I/O.
 *  - e2e:  the real Nest app over HTTP and WebSocket against an in-memory MongoDB.
 *    Each test file gets its own database, so files run in parallel safely.
 */
const shared = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
};

const config: Config = {
  rootDir: '.',
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/seed/**', '!src/**/*.spec.ts'],
  coverageDirectory: './coverage',
  coverageReporters: ['text-summary', 'lcov'],
  testTimeout: 30000,
  projects: [
    {
      ...shared,
      displayName: 'unit',
      rootDir: '.',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
      setupFiles: ['<rootDir>/test/setup/unit.ts'],
    },
    {
      ...shared,
      displayName: 'e2e',
      rootDir: '.',
      testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
      globalSetup: '<rootDir>/test/setup/global-setup.ts',
      globalTeardown: '<rootDir>/test/setup/global-teardown.ts',
      setupFiles: ['<rootDir>/test/setup/env.ts'],
    },
  ],
};

export default config;
