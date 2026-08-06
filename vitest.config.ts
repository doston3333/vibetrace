import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/dist/**', '**/node_modules/**'],
    // SQLCipher migrations and Windows ACL setup can exceed Vitest's generic
    // five-second ceiling on shared CI runners. Performance tests retain their
    // own explicit budgets.
    testTimeout: 15_000,
  },
});
