import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://fr:fr@localhost:5432/fastresponse_test',
      BCRYPT_COST: '4',
      JOBS_ENABLED: 'false',
      UPLOAD_DIR: './data/test-uploads',
    },
  },
});
