import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Only the Workers runtime has it; tests use a stand-in.
    alias: { 'cloudflare:email': fileURLToPath(new URL('./test/cloudflare-email.ts', import.meta.url)) },
  },
  test: { include: ['test/**/*.test.ts'] },
});
