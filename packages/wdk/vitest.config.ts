import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: { environment: 'node' },
  resolve: {
    alias: {
      '@flashyos/wallet-wdk': path.resolve(__dirname, '../wallet-wdk/src/index.ts'),
    },
  },
});
