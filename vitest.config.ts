import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests only. The end-to-end board check boots wrangler and Chrome, so it lives in
    // scripts/e2e.ts behind `npm run test:e2e` rather than slowing this down.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
