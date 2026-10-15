import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // node:sqlite is still flagged experimental; keep test output readable.
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
