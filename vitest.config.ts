import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['{shared,daemon,hook,ui,helper}/**/*.test.ts'] } });
