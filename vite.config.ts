import { defineConfig } from 'vite';
import { engineVersion } from './scripts/engine-version.mjs';
import { productionHeaders } from './scripts/production-headers.mjs';
export default defineConfig({
  cacheDir: '.cache/vite',
  define: { 'import.meta.env.VITE_NATIVE_ENGINE_VERSION': JSON.stringify(engineVersion('public/engine')) },
  server: { watch: { ignored: ['**/.worktrees/**', '**/.cache/**', '**/dist/**', '**/dist-*/**', '**/engine/target/**', '**/engine/target-*/**'] }, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  preview: { headers: productionHeaders() },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
